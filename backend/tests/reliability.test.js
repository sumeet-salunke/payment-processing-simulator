import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import "dotenv/config";

import orderRepository from "../src/repositories/order.repository.js";
import paymentRepository from "../src/repositories/payment.repository.js";
import webhookEventRepository from "../src/repositories/webhookEvent.repository.js";
import paymentWebhookService from "../src/services/paymentWebhook.service.js";
import failureSimulationService from "../src/services/failureSimulation.service.js";
import { FAILURE_MODES } from "../src/constants/failureSimulation.constants.js";
import { PAYMENT_STATUS } from "../src/constants/payment.constants.js";
import { ORDER_STATUS } from "../src/constants/order.constants.js";
import { WEBHOOK_EVENT_STATUS } from "../src/constants/webhookEvent.constants.js";
import { generateEventID } from "../src/helpers/generateEventID.js";
import { generateOrderID } from "../src/helpers/generateOrderID.js";
import { generatePaymentID } from "../src/helpers/generatePaymentID.js";
import { verifyWebhookSignature, generateWebhookSignature } from "../src/helpers/webhookSignature.js";

describe("Payment Processing Simulator - Reliability & Failure Tests", () => {
  beforeEach(() => {
    failureSimulationService.reset();
  });

  // Helper to create test entities in DB
  const setupTestEntities = async () => {
    const orderId = generateOrderID();
    const paymentId = generatePaymentID();

    const order = await orderRepository.createOrder({
      orderId,
      userId: "test-user-123",
      amount: 1000,
      status: ORDER_STATUS.PENDING
    });

    const payment = await paymentRepository.createPayment({
      paymentId,
      orderId,
      amount: 1000,
      status: PAYMENT_STATUS.PROCESSING,
      history: [
        {
          status: PAYMENT_STATUS.PENDING,
          message: "Payment Initialized.",
          timestamp: new Date()
        },
        {
          status: PAYMENT_STATUS.PROCESSING,
          message: "Payment processing initialized.",
          timestamp: new Date()
        }
      ]
    });

    return { orderId, paymentId };
  };

  describe("Invariant 1: Successful Payment State Consistency", () => {
    it("should atomically update Payment to SUCCESS and Order to PAID on payment.success", async () => {
      const { orderId, paymentId } = await setupTestEntities();
      const eventId = generateEventID();

      const result = await paymentWebhookService.processWebhookEvent({
        eventId,
        event: "payment.success",
        paymentId
      });

      assert.equal(result.alreadyProcessed, false);

      const finalPayment = await paymentRepository.findByPaymentId(paymentId);
      const finalOrder = await orderRepository.findByOrderId(orderId);
      const eventDoc = await webhookEventRepository.findByEventId(eventId);

      assert.equal(finalPayment.status, PAYMENT_STATUS.SUCCESS);
      assert.equal(finalOrder.status, ORDER_STATUS.PAID);
      assert.equal(eventDoc.status, WEBHOOK_EVENT_STATUS.PROCESSED);
      assert.equal(finalPayment.history.length, 3);
      assert.equal(finalPayment.history[2].status, PAYMENT_STATUS.SUCCESS);
    });
  });

  describe("Invariant 2: Failed Payment State Consistency", () => {
    it("should update Payment to FAILED and keep Order PENDING on payment.failed", async () => {
      const { orderId, paymentId } = await setupTestEntities();
      const eventId = generateEventID();

      const result = await paymentWebhookService.processWebhookEvent({
        eventId,
        event: "payment.failed",
        paymentId
      });

      assert.equal(result.alreadyProcessed, false);

      const finalPayment = await paymentRepository.findByPaymentId(paymentId);
      const finalOrder = await orderRepository.findByOrderId(orderId);
      const eventDoc = await webhookEventRepository.findByEventId(eventId);

      assert.equal(finalPayment.status, PAYMENT_STATUS.FAILED);
      assert.equal(finalOrder.status, ORDER_STATUS.PENDING, "Order must NOT be marked PAID");
      assert.equal(eventDoc.status, WEBHOOK_EVENT_STATUS.PROCESSED);
      assert.equal(finalPayment.history.length, 3);
      assert.equal(finalPayment.history[2].status, PAYMENT_STATUS.FAILED);
    });
  });

  describe("Invariant 3: State Machine Disallows Backward / Illegal Transitions", () => {
    it("should prevent transitioning from terminal SUCCESS state", async () => {
      const { paymentId } = await setupTestEntities();
      const eventId1 = generateEventID();

      await paymentWebhookService.processWebhookEvent({
        eventId: eventId1,
        event: "payment.success",
        paymentId
      });

      const eventId2 = generateEventID();
      await assert.rejects(
        async () => {
          await paymentWebhookService.processWebhookEvent({
            eventId: eventId2,
            event: "payment.success",
            paymentId
          });
        },
        /Cannot transition payment from success to success/
      );
    });
  });

  describe("Invariant 4: Duplicate Webhook Idempotency", () => {
    it("should acknowledge duplicate webhook without re-running transactions or appending history", async () => {
      const { orderId, paymentId } = await setupTestEntities();
      const eventId = generateEventID();

      // First delivery
      const res1 = await paymentWebhookService.processWebhookEvent({
        eventId,
        event: "payment.success",
        paymentId
      });
      assert.equal(res1.alreadyProcessed, false);

      // Duplicate delivery (same eventId)
      const res2 = await paymentWebhookService.processWebhookEvent({
        eventId,
        event: "payment.success",
        paymentId
      });
      assert.equal(res2.alreadyProcessed, true);

      // Third delivery
      const res3 = await paymentWebhookService.processWebhookEvent({
        eventId,
        event: "payment.success",
        paymentId
      });
      assert.equal(res3.alreadyProcessed, true);

      const finalPayment = await paymentRepository.findByPaymentId(paymentId);
      const finalOrder = await orderRepository.findByOrderId(orderId);

      // Verification: exactly 1 SUCCESS transition in history
      assert.equal(finalPayment.history.length, 3);
      assert.equal(finalPayment.history[2].status, PAYMENT_STATUS.SUCCESS);
      assert.equal(finalOrder.status, ORDER_STATUS.PAID);
    });
  });

  describe("Invariant 5: Transaction Rollback on Failure", () => {
    it("should roll back Payment to PROCESSING if order update fails (ORDER_UPDATE_FAILURE)", async () => {
      const { orderId, paymentId } = await setupTestEntities();
      const eventId = generateEventID();

      // Inject failure simulation
      failureSimulationService.setFailureMode(FAILURE_MODES.ORDER_UPDATE_FAILURE);

      await assert.rejects(
        async () => {
          await paymentWebhookService.processWebhookEvent({
            eventId,
            event: "payment.success",
            paymentId
          });
        },
        /Simulated order update failure inside transaction/
      );

      // Verify that Payment was rolled back to PROCESSING and Order remains PENDING
      const paymentAfterRollback = await paymentRepository.findByPaymentId(paymentId);
      const orderAfterRollback = await orderRepository.findByOrderId(orderId);
      const eventDoc = await webhookEventRepository.findByEventId(eventId);

      assert.equal(paymentAfterRollback.status, PAYMENT_STATUS.PROCESSING, "Payment must roll back to PROCESSING");
      assert.equal(orderAfterRollback.status, ORDER_STATUS.PENDING, "Order must remain PENDING");
      assert.equal(eventDoc.status, WEBHOOK_EVENT_STATUS.FAILED, "Event must be marked retryable FAILED");
      assert.equal(eventDoc.attempts, 1);
    });

    it("should roll back all operations if database fails (DATABASE_FAILURE)", async () => {
      const { orderId, paymentId } = await setupTestEntities();
      const eventId = generateEventID();

      failureSimulationService.setFailureMode(FAILURE_MODES.DATABASE_FAILURE);

      await assert.rejects(
        async () => {
          await paymentWebhookService.processWebhookEvent({
            eventId,
            event: "payment.success",
            paymentId
          });
        },
        /Simulated database connection failure/
      );

      const paymentAfterRollback = await paymentRepository.findByPaymentId(paymentId);
      const orderAfterRollback = await orderRepository.findByOrderId(orderId);

      assert.equal(paymentAfterRollback.status, PAYMENT_STATUS.PROCESSING);
      assert.equal(orderAfterRollback.status, ORDER_STATUS.PENDING);
    });
  });

  describe("Invariant 6: HMAC Signature Verification Integrity", () => {
    it("should reject tampered or invalid webhook signatures", () => {
      const payload = JSON.stringify({
        eventId: "evt-test-1",
        event: "payment.success",
        paymentId: "PAYMENT-1"
      });
      const validSecret = "test-secret-key-12345";
      const validSignature = generateWebhookSignature(payload, validSecret);

      const isValid = verifyWebhookSignature(payload, validSecret, validSignature);
      assert.equal(isValid, true);

      const isInvalid = verifyWebhookSignature(payload, validSecret, "tampered-signature-hex");
      assert.equal(isInvalid, false);

      const isWrongSecret = verifyWebhookSignature(payload, "wrong-secret-key", validSignature);
      assert.equal(isWrongSecret, false);
    });
  });

  describe("Invariant 7: Retry Exhaustion & Permanent Failure", () => {
    it("should transition WebhookEvent to DEAD once maxAttempts is exceeded", async () => {
      const { paymentId } = await setupTestEntities();
      const eventId = generateEventID();

      // Pre-seed event with 4 failed attempts
      await webhookEventRepository.create({
        eventId,
        event: "payment.success",
        paymentId,
        status: WEBHOOK_EVENT_STATUS.FAILED,
        attempts: 4,
        maxAttempts: 5
      });

      // Force 5th failure
      failureSimulationService.setFailureMode(FAILURE_MODES.ORDER_UPDATE_FAILURE);

      await assert.rejects(async () => {
        await paymentWebhookService.processWebhookEvent({
          eventId,
          event: "payment.success",
          paymentId
        });
      });

      const eventDoc = await webhookEventRepository.findByEventId(eventId);
      assert.equal(eventDoc.status, WEBHOOK_EVENT_STATUS.DEAD, "Event must enter DEAD state after 5th failure");
      assert.equal(eventDoc.attempts, 5);
      assert.equal(eventDoc.nextRetryAt, null, "No further retry should be scheduled");
    });
  });

  describe("Concurrent Duplicate Webhook Processing", () => {
    it("should execute business operations only once when multiple requests race on the same eventId", async () => {
      const { orderId, paymentId } = await setupTestEntities();
      const eventId = generateEventID();

      // Launch 3 simultaneous concurrent webhook deliveries
      const [res1, res2, res3] = await Promise.all([
        paymentWebhookService.processWebhookEvent({ eventId, event: "payment.success", paymentId }),
        paymentWebhookService.processWebhookEvent({ eventId, event: "payment.success", paymentId }),
        paymentWebhookService.processWebhookEvent({ eventId, event: "payment.success", paymentId })
      ]);

      // Exactly one request executes the business logic; the other two acknowledge alreadyProcessed
      const results = [res1, res2, res3];
      const newlyProcessed = results.filter((r) => r.alreadyProcessed === false);
      const alreadyProcessed = results.filter((r) => r.alreadyProcessed === true);

      assert.equal(newlyProcessed.length, 1, "Only one request should perform the business operation");
      assert.equal(alreadyProcessed.length, 2, "Concurrent duplicate requests must acknowledge safely");

      const finalPayment = await paymentRepository.findByPaymentId(paymentId);
      const finalOrder = await orderRepository.findByOrderId(orderId);

      assert.equal(finalPayment.status, PAYMENT_STATUS.SUCCESS);
      assert.equal(finalOrder.status, ORDER_STATUS.PAID);
      assert.equal(finalPayment.history.length, 3);
    });
  });
});
