import mongoose from "mongoose";
import paymentRepository from "../repositories/payment.repository.js";
import orderRepository from "../repositories/order.repository.js";
import webhookEventRepository from "../repositories/webhookEvent.repository.js";
import paymentSessionRepository from "../repositories/paymentSession.repository.js";
import ApiError from "../utils/ApiError.js";
import { PAYMENT_STATUS } from "../constants/payment.constants.js";
import { ORDER_STATUS } from "../constants/order.constants.js";
import { WEBHOOK_EVENT_STATUS } from "../constants/webhookEvent.constants.js";
import { canTransition } from "../helpers/paymentStateMachine.js";
import { calculateBackoffDelay, isRetryableError, RETRY_POLICY } from "../config/retryPolicy.js";
import { addWebhookRetryJob } from "../queues/webhookRetry.queue.js";
import failureSimulationService from "./failureSimulation.service.js";
import { FAILURE_MODES } from "../constants/failureSimulation.constants.js";

class PaymentWebhookService {
  async processWebhookEvent({ eventId, event, paymentId }) {
    if (!eventId) {
      throw new ApiError(400, "Missing eventId in webhook payload");
    }

    if (!paymentId) {
      throw new ApiError(400, "Missing paymentId in webhook payload");
    }

    // 1. Idempotency Gate
    let existingEvent = await webhookEventRepository.findByEventId(eventId);

    if (existingEvent) {
      if (existingEvent.status === WEBHOOK_EVENT_STATUS.PROCESSED) {
        return {
          alreadyProcessed: true,
          eventId,
          paymentId,
          status: existingEvent.status,
          processedAt: existingEvent.processedAt
        };
      }

      if (existingEvent.status === WEBHOOK_EVENT_STATUS.DEAD) {
        throw new ApiError(400, `Webhook event ${eventId} is permanently failed (DEAD) and cannot be re-processed`);
      }

      if (existingEvent.status === WEBHOOK_EVENT_STATUS.PROCESSING) {
        for (let i = 0; i < 5; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          existingEvent = await webhookEventRepository.findByEventId(eventId);
          if (existingEvent?.status === WEBHOOK_EVENT_STATUS.PROCESSED) {
            return {
              alreadyProcessed: true,
              eventId,
              paymentId,
              status: existingEvent.status,
              processedAt: existingEvent.processedAt
            };
          }
        }
        throw new ApiError(409, "Webhook event is currently being processed");
      }

      // If previously failed, re-claim the event: FAILED -> PROCESSING
      const reclaimed = await webhookEventRepository.updateStatus(
        eventId,
        WEBHOOK_EVENT_STATUS.FAILED,
        WEBHOOK_EVENT_STATUS.PROCESSING
      );

      if (!reclaimed) {
        const current = await webhookEventRepository.findByEventId(eventId);
        if (current?.status === WEBHOOK_EVENT_STATUS.PROCESSED) {
          return {
            alreadyProcessed: true,
            eventId,
            paymentId,
            status: current.status,
            processedAt: current.processedAt
          };
        }
        throw new ApiError(409, "Webhook event is currently being processed");
      }
    } else {
      // Register new event in PROCESSING state; protected by unique database index
      try {
        await webhookEventRepository.create({
          eventId,
          event,
          paymentId,
          status: WEBHOOK_EVENT_STATUS.PROCESSING
        });
      } catch (err) {
        if (err.code === 11000 || err.name === "MongoServerError") {
          for (let i = 0; i < 5; i++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            const concurrentEvent = await webhookEventRepository.findByEventId(eventId);
            if (concurrentEvent?.status === WEBHOOK_EVENT_STATUS.PROCESSED) {
              return {
                alreadyProcessed: true,
                eventId,
                paymentId,
                status: concurrentEvent.status,
                processedAt: concurrentEvent.processedAt
              };
            }
          }
          throw new ApiError(409, "Webhook event is currently being processed");
        }
        throw err;
      }
    }

    // 2. Multi-Document Transaction Boundary
    const session = await mongoose.startSession();

    try {
      let result;

      await session.withTransaction(async () => {
        // Failure simulation hook: DATABASE_FAILURE
        if (failureSimulationService.checkFailure(FAILURE_MODES.DATABASE_FAILURE)) {
          console.warn(`[FailureSimulation] Injecting DATABASE_FAILURE inside transaction for eventId=${eventId}`);
          throw new ApiError(500, "Simulated database connection failure");
        }

        const payment = await paymentRepository.findByPaymentId(paymentId, session);
        if (!payment) {
          throw new ApiError(404, "Payment not found");
        }

        if (event === "payment.success") {
          result = await this.handlePaymentSuccess(payment, eventId, session);
        } else if (event === "payment.failed") {
          result = await this.handlePaymentFailed(payment, eventId, session);
        } else {
          throw new ApiError(400, `Unsupported webhook event: ${event}`);
        }
      });

      return {
        alreadyProcessed: false,
        eventId,
        ...result
      };
    } catch (error) {
      // When transaction aborts/rolls back, handle failure and queue background retry if eligible
      await this.handleProcessingFailure(eventId, paymentId, error);
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async retryWebhookEvent({ eventId, paymentId }) {
    // Failure simulation hook: WORKER_FAILURE
    if (failureSimulationService.checkFailure(FAILURE_MODES.WORKER_FAILURE)) {
      console.warn(`[FailureSimulation] Injecting WORKER_FAILURE during retry processing for eventId=${eventId}`);
      throw new Error("Simulated worker process crash during retry");
    }

    // 1. Verify that event exists and is in retryable state
    const eventRecord = await webhookEventRepository.findByEventId(eventId);

    if (!eventRecord) {
      console.warn(`[WebhookRetry] eventId=${eventId} not found in database. Skipping retry.`);
      return { skipped: true, reason: "Event not found" };
    }

    if (eventRecord.status === WEBHOOK_EVENT_STATUS.PROCESSED) {
      console.log(`[WebhookRetry] eventId=${eventId} already PROCESSED. Skipping duplicate retry.`);
      return { alreadyProcessed: true, eventId, paymentId };
    }

    if (eventRecord.status === WEBHOOK_EVENT_STATUS.DEAD) {
      console.warn(`[WebhookRetry] eventId=${eventId} is DEAD (max attempts exceeded). Skipping.`);
      return { skipped: true, reason: "Event is DEAD" };
    }

    // 2. Claim the event atomically: FAILED -> PROCESSING
    const claimed = await webhookEventRepository.updateStatus(
      eventId,
      WEBHOOK_EVENT_STATUS.FAILED,
      WEBHOOK_EVENT_STATUS.PROCESSING
    );

    if (!claimed) {
      const current = await webhookEventRepository.findByEventId(eventId);
      if (current?.status === WEBHOOK_EVENT_STATUS.PROCESSED) {
        return { alreadyProcessed: true, eventId, paymentId };
      }
      console.warn(`[WebhookRetry] eventId=${eventId} could not be claimed (current status=${current?.status})`);
      return { skipped: true, reason: "Could not claim event" };
    }

    // 3. Re-run business transaction
    const session = await mongoose.startSession();

    try {
      let result;

      await session.withTransaction(async () => {
        // Failure simulation hook: DATABASE_FAILURE
        if (failureSimulationService.checkFailure(FAILURE_MODES.DATABASE_FAILURE)) {
          console.warn(`[FailureSimulation] Injecting DATABASE_FAILURE during retry transaction for eventId=${eventId}`);
          throw new ApiError(500, "Simulated database connection failure");
        }

        const payment = await paymentRepository.findByPaymentId(paymentId, session);
        if (!payment) {
          throw new ApiError(404, "Payment not found");
        }

        if (eventRecord.event === "payment.success") {
          result = await this.handlePaymentSuccess(payment, eventId, session);
        } else if (eventRecord.event === "payment.failed") {
          result = await this.handlePaymentFailed(payment, eventId, session);
        } else {
          throw new ApiError(400, `Unsupported webhook event: ${eventRecord.event}`);
        }
      });

      console.log(`[WebhookRetry] Successfully processed retry for eventId=${eventId} paymentId=${paymentId}`);
      return {
        alreadyProcessed: false,
        eventId,
        ...result
      };
    } catch (error) {
      await this.handleProcessingFailure(eventId, paymentId, error);
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async handleProcessingFailure(eventId, paymentId, error) {
    const retryable = isRetryableError(error);
    const current = await webhookEventRepository.findByEventId(eventId);
    const currentAttempts = (current?.attempts || 0) + 1;
    const maxAttempts = current?.maxAttempts || RETRY_POLICY.MAX_ATTEMPTS;

    // Permanent failure if not retryable or max attempts exceeded
    if (!retryable || currentAttempts >= maxAttempts) {
      console.error(
        `[WebhookFailure] Permanent failure for eventId=${eventId} paymentId=${paymentId}: ${error.message} (attempts=${currentAttempts}/${maxAttempts}, retryable=${retryable})`
      );
      await webhookEventRepository.markDead(eventId, error.message);
      return;
    }

    // Temporary failure: calculate exponential backoff delay and schedule retry
    const delayMs = calculateBackoffDelay(currentAttempts);
    const nextRetryAt = new Date(Date.now() + delayMs);

    console.warn(
      `[WebhookFailure] Temporary failure for eventId=${eventId} paymentId=${paymentId}: ${error.message}. Scheduling attempt ${currentAttempts + 1}/${maxAttempts} in ${delayMs}ms`
    );

    await webhookEventRepository.markFailed(eventId, error.message, nextRetryAt);

    try {
      await addWebhookRetryJob({ eventId, paymentId }, delayMs);
    } catch (queueErr) {
      console.error(`[WebhookQueue] Error queuing retry job for eventId=${eventId}:`, queueErr.message);
    }
  }

  async handlePaymentSuccess(payment, eventId, session) {
    const canTransit = canTransition(payment.status, PAYMENT_STATUS.SUCCESS);
    if (!canTransit) {
      const err = new ApiError(
        400,
        `Cannot transition payment from ${payment.status} to ${PAYMENT_STATUS.SUCCESS}`
      );
      // Permanent business error if payment is already in terminal SUCCESS state
      if (payment.status === PAYMENT_STATUS.SUCCESS) {
        err.isPermanent = true;
      }
      throw err;
    }

    const updatedPayment = await paymentRepository.updatePaymentStatus(
      payment.paymentId,
      payment.status,
      PAYMENT_STATUS.SUCCESS,
      {
        status: PAYMENT_STATUS.SUCCESS,
        message: "Payment processed successfully via webhook.",
        timestamp: new Date()
      },
      session
    );

    if (!updatedPayment) {
      throw new ApiError(
        409,
        "Payment state changed before webhook update could be completed"
      );
    }

    // Failure simulation hook: ORDER_UPDATE_FAILURE
    if (failureSimulationService.checkFailure(FAILURE_MODES.ORDER_UPDATE_FAILURE)) {
      console.warn(`[FailureSimulation] Injecting ORDER_UPDATE_FAILURE for eventId=${eventId} after payment status update`);
      throw new ApiError(500, "Simulated order update failure inside transaction");
    }

    if (updatedPayment.orderId) {
      const updatedOrder = await orderRepository.updateOrderStatus(
        updatedPayment.orderId,
        ORDER_STATUS.PAID,
        session
      );

      if (!updatedOrder) {
        throw new ApiError(404, `Order ${updatedPayment.orderId} not found`);
      }

      // Step 12: Mark active payment sessions for this order as COMPLETED atomically
      await paymentSessionRepository.completeActiveSessionsForOrder(
        updatedPayment.orderId,
        session
      );
    }

    await webhookEventRepository.markProcessed(eventId, session);

    return {
      payment: updatedPayment,
      orderStatus: ORDER_STATUS.PAID
    };
  }

  async handlePaymentFailed(payment, eventId, session) {
    const canTransit = canTransition(payment.status, PAYMENT_STATUS.FAILED);
    if (!canTransit) {
      const err = new ApiError(
        400,
        `Cannot transition payment from ${payment.status} to ${PAYMENT_STATUS.FAILED}`
      );
      if (payment.status === PAYMENT_STATUS.FAILED || payment.status === PAYMENT_STATUS.SUCCESS) {
        err.isPermanent = true;
      }
      throw err;
    }

    const updatedPayment = await paymentRepository.updatePaymentStatus(
      payment.paymentId,
      payment.status,
      PAYMENT_STATUS.FAILED,
      {
        status: PAYMENT_STATUS.FAILED,
        message: "Payment failed via webhook notification.",
        timestamp: new Date()
      },
      session
    );

    if (!updatedPayment) {
      throw new ApiError(
        409,
        "Payment state changed before webhook update could be completed"
      );
    }

    await webhookEventRepository.markProcessed(eventId, session);

    return {
      payment: updatedPayment,
      orderStatus: null
    };
  }
}

export default new PaymentWebhookService();
