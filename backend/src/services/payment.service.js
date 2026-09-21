import paymentRepository from "../repositories/payment.repository.js";
import ApiError from "../utils/ApiError.js";
import orderRepository from "../repositories/order.repository.js";
import paymentProviderService from "./paymentProvider.service.js";
import { generatePaymentID } from "../helpers/generatePaymentID.js";
import { PAYMENT_STATUS } from "../constants/payment.constants.js";
import { canTransition } from "../helpers/paymentStateMachine.js";
import { PAYMENT_TRANSITIONS } from "../constants/payment.transition.js";

import { ORDER_STATUS } from "../constants/order.constants.js";

class PaymentService {
  async createPayment(orderId, clientAmount = null) {
    if (!orderId) {
      throw new ApiError(400, "Invalid orderId");
    }
    const order = await orderRepository.findByOrderId(orderId);
    if (!order) {
      throw new ApiError(404, "Order does not exists");
    }

    // Step 5: Prevent paying an already-paid order
    if (order.status === ORDER_STATUS.PAID) {
      throw new ApiError(409, "Order is already paid. No further payment attempts allowed.");
    }

    // Step 7 Hardening: Prevent in-flight attempt overlap
    // If an existing attempt is currently PROCESSING, reject new attempt with 409 Conflict
    const activeAttempt = await paymentRepository.findActiveAttemptByOrderId(orderId);
    if (activeAttempt) {
      throw new ApiError(
        409,
        `Payment attempt #${activeAttempt.attemptNumber} (${activeAttempt.paymentId}) is currently processing for this order. Please wait for it to complete.`
      );
    }

    // Step 4 & 10: Payment amount must ALWAYS come from the Order.
    // Client-provided amounts are completely ignored, never trusted.
    const paymentAmount = order.amount;

    // Step 2: Attempt number generation with database-level concurrency protection
    let payment = null;
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const latestAttempt = await paymentRepository.findLatestByOrderId(orderId);
      const attemptNumber = (latestAttempt?.attemptNumber || 0) + 1;
      const paymentId = generatePaymentID();

      try {
        payment = await paymentRepository.createPayment({
          paymentId,
          orderId,
          attemptNumber,
          amount: paymentAmount, // Authoritative order amount
          status: PAYMENT_STATUS.PENDING,
          history: [{
            status: PAYMENT_STATUS.PENDING,
            message: `Payment attempt #${attemptNumber} initialized.`,
            timestamp: new Date()
          }]
        });
        break; // Successfully created
      } catch (err) {
        // If duplicate key error occurs on (orderId, attemptNumber), retry
        if ((err.code === 11000 || err.name === "MongoServerError") && attempt < MAX_RETRIES - 1) {
          console.warn(`[PaymentAttempt] Duplicate attemptNumber race detected for orderId=${orderId}, attemptNumber=${attemptNumber}. Retrying...`);
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
        throw err;
      }
    }

    return {
      message: "Payment created successfully",
      data: payment
    };
  }

  async getPaymentsByOrderId(orderId) {
    if (!orderId) {
      throw new ApiError(400, "Invalid orderId");
    }
    const order = await orderRepository.findByOrderId(orderId);
    if (!order) {
      throw new ApiError(404, "Order does not exists");
    }

    const payments = await paymentRepository.findByOrderId(orderId);
    return {
      message: "Payment attempts retrieved successfully",
      data: {
        orderId,
        payments
      }
    };
  }

  async updatePaymentStatus(paymentId, currentStatus, newStatus, historyEntry) {
    const updatedPayment =
      await paymentRepository.updatePaymentStatus(
        paymentId,
        currentStatus,
        newStatus,
        historyEntry
      );

    if (!updatedPayment) {
      throw new ApiError(
        409,
        "Payment state changed before the update could be completed"
      );
    }

    return {
      message: "Payment status updated successfully.",
      data: updatedPayment
    };
  }

  async processPayment(paymentId, result = "success") {
    if (!paymentId) {
      throw new ApiError(400, "PaymentId required");
    }

    const payment = await paymentRepository.findByPaymentId(paymentId);

    if (!payment) {
      throw new ApiError(404, "Payment not found");
    }

    const canTransit = canTransition(
      payment.status,
      PAYMENT_STATUS.PROCESSING
    );

    if (!canTransit) {
      throw new ApiError(
        400,
        `Cannot process payment from ${payment.status} state`
      );
    }

    // 1. Atomic conditional update: PENDING / FAILED -> PROCESSING
    await this.updatePaymentStatus(
      paymentId,
      payment.status,
      PAYMENT_STATUS.PROCESSING,
      {
        status: PAYMENT_STATUS.PROCESSING,
        message: "Payment processing initialized.",
        timestamp: new Date()
      }
    );

    // 2. Trigger Payment Provider simulation
    const providerResult = await paymentProviderService.processPayment(
      paymentId,
      result
    );

    // 3. Provider sends signed webhook HTTP request to backend endpoint
    await paymentProviderService.sendWebhook(
      providerResult.event,
      paymentId,
      providerResult.eventId
    );

    // 4. Fetch the final payment state updated by the webhook handler
    const finalPayment = await paymentRepository.findByPaymentId(paymentId);

    return {
      message: "Payment processed successfully",
      data: finalPayment
    };
  }
}

export default new PaymentService();