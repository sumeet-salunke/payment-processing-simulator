import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import "dotenv/config";
import "../src/config/dns.js";

import orderRepository from "../src/repositories/order.repository.js";
import paymentRepository from "../src/repositories/payment.repository.js";
import paymentSessionRepository from "../src/repositories/paymentSession.repository.js";
import webhookEventRepository from "../src/repositories/webhookEvent.repository.js";
import idempotencyKeyRepository from "../src/repositories/idempotencyKey.repository.js";
import paymentSessionService from "../src/services/paymentSession.service.js";
import paymentWebhookService from "../src/services/paymentWebhook.service.js";
import failureSimulationService from "../src/services/failureSimulation.service.js";
import { assertPaymentSystemConsistency } from "../src/helpers/invariantChecker.js";
import { ORDER_STATUS } from "../src/constants/order.constants.js";
import { PAYMENT_STATUS } from "../src/constants/payment.constants.js";
import { PAYMENT_SESSION_STATUS } from "../src/constants/paymentSession.constants.js";
import { WEBHOOK_EVENT_STATUS } from "../src/constants/webhookEvent.constants.js";
import { FAILURE_MODES } from "../src/constants/failureSimulation.constants.js";
import ApiError from "../src/utils/ApiError.js";
import app from "../src/app.js";

await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/payment_simulator");

describe("Payment Flow End-to-End Integration Test Suite", () => {
  let server;

  before(async () => {
    const port = Number(process.env.PORT || 5000);
    await new Promise((resolve, reject) => {
      server = app.listen(port, resolve);
      server.on("error", reject);
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      const { webhookRetryQueue } = await import("../src/queues/webhookRetry.queue.js");
      await webhookRetryQueue.close();
    } catch {}
    await mongoose.connection.close();
  });

  beforeEach(() => {
    failureSimulationService.reset();
  });

  const generateOrderId = () => `ORD-E2E-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  /**
   * Helper to set up an unpaid order and an active payment session in MongoDB
   */
  const setupOrderAndSession = async (amount = 500) => {
    const orderId = generateOrderId();
    const order = await orderRepository.createOrder({
      orderId,
      userId: "user-e2e-tester",
      amount,
      status: ORDER_STATUS.PENDING
    });

    const sessionResult = await paymentSessionService.createPaymentSession(orderId);
    return { order, session: sessionResult.data.session, qrPayload: sessionResult.data.qrPayload };
  };

  /* -------------------------------------------------------------------------- */
  /* Test 1: Complete Happy Path Flow                                           */
  /* -------------------------------------------------------------------------- */
  describe("1. Complete Happy Path Flow", () => {
    it("should process Order -> Session -> QR -> Pay -> Webhook -> SUCCESS / PAID / COMPLETED", async () => {
      const { order, session, qrPayload } = await setupOrderAndSession(500);

      assert.ok(session.sessionId.startsWith("SESSION-"));
      assert.equal(session.orderId, order.orderId);
      assert.equal(session.amount, 500);
      assert.equal(session.status, PAYMENT_SESSION_STATUS.ACTIVE);
      assert.match(qrPayload, new RegExp(`/payment/${session.sessionId}$`));

      // 1. Fetch payment session (simulating frontend React mount)
      const fetched = await paymentSessionService.getPaymentSession(session.sessionId);
      assert.equal(fetched.data.session.amount, 500);
      assert.equal(fetched.data.session.orderStatus, ORDER_STATUS.PENDING);
      assert.equal(fetched.data.session.sessionStatus, PAYMENT_SESSION_STATUS.ACTIVE);

      // 2. User clicks "Pay Now" with an Idempotency-Key
      const idempotencyKey = `idem-happy-${Date.now()}`;
      const payResult = await paymentSessionService.payThroughSession(session.sessionId, {
        result: "success",
        idempotencyKey
      });

      assert.ok(payResult.data.payment);
      assert.equal(payResult.data.payment.status, PAYMENT_STATUS.SUCCESS);
      assert.equal(payResult.data.payment.amount, 500);

      // 3. Verify authoritative MongoDB state across all entities
      const finalOrder = await orderRepository.findByOrderId(order.orderId);
      const finalPayment = await paymentRepository.findByPaymentId(payResult.data.payment.paymentId);
      const finalSession = await paymentSessionRepository.findBySessionId(session.sessionId);
      const allPayments = await paymentRepository.findByOrderId(order.orderId);

      assert.equal(finalPayment.status, PAYMENT_STATUS.SUCCESS);
      assert.equal(finalOrder.status, ORDER_STATUS.PAID);
      assert.equal(finalSession.status, PAYMENT_SESSION_STATUS.COMPLETED);

      // Verify business invariants
      assertPaymentSystemConsistency({
        order: finalOrder,
        payments: allPayments,
        paymentSessions: [finalSession]
      });
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Test 2: Failure Path Flow                                                  */
  /* -------------------------------------------------------------------------- */
  describe("2. Failure Path Flow", () => {
    it("should mark Payment FAILED, keep Order PENDING, and leave Session ACTIVE on provider failure", async () => {
      const { order, session } = await setupOrderAndSession(750);

      // Trigger payment with simulated failure
      const idempotencyKey = `idem-fail-${Date.now()}`;
      const payResult = await paymentSessionService.payThroughSession(session.sessionId, {
        result: "failed",
        idempotencyKey
      });

      assert.equal(payResult.data.payment.status, PAYMENT_STATUS.FAILED);

      // Inspect DB
      const finalOrder = await orderRepository.findByOrderId(order.orderId);
      const finalPayment = await paymentRepository.findByPaymentId(payResult.data.payment.paymentId);
      const finalSession = await paymentSessionRepository.findBySessionId(session.sessionId);

      assert.equal(finalPayment.status, PAYMENT_STATUS.FAILED);
      assert.equal(finalOrder.status, ORDER_STATUS.PENDING, "Order must NOT be PAID");
      assert.equal(finalSession.status, PAYMENT_SESSION_STATUS.ACTIVE, "Session remains ACTIVE for retry");
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Test 3: Failed Payment Retry Flow                                          */
  /* -------------------------------------------------------------------------- */
  describe("3. Failed Payment Retry Flow", () => {
    it("should create Attempt 2 upon retry, preserve Attempt 1 as FAILED, and transition Order to PAID", async () => {
      const { order, session } = await setupOrderAndSession(1200);

      // Attempt 1 fails
      const key1 = `idem-retry1-${Date.now()}`;
      const res1 = await paymentSessionService.payThroughSession(session.sessionId, {
        result: "failed",
        idempotencyKey: key1
      });
      assert.equal(res1.data.payment.status, PAYMENT_STATUS.FAILED);

      // Attempt 2 succeeds (fresh idempotency key for new user attempt)
      const key2 = `idem-retry2-${Date.now()}`;
      const res2 = await paymentSessionService.payThroughSession(session.sessionId, {
        result: "success",
        idempotencyKey: key2
      });
      assert.equal(res2.data.payment.status, PAYMENT_STATUS.SUCCESS);

      // Verify DB contains BOTH payment attempts
      const allPayments = await paymentRepository.findByOrderId(order.orderId);
      assert.equal(allPayments.length, 2);
      assert.equal(allPayments[0].attemptNumber, 1);
      assert.equal(allPayments[0].status, PAYMENT_STATUS.FAILED);
      assert.equal(allPayments[1].attemptNumber, 2);
      assert.equal(allPayments[1].status, PAYMENT_STATUS.SUCCESS);

      // Final order and session state
      const finalOrder = await orderRepository.findByOrderId(order.orderId);
      const finalSession = await paymentSessionRepository.findBySessionId(session.sessionId);
      assert.equal(finalOrder.status, ORDER_STATUS.PAID);
      assert.equal(finalSession.status, PAYMENT_SESSION_STATUS.COMPLETED);
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Test 4: Duplicate Pay Request (Client Idempotency)                         */
  /* -------------------------------------------------------------------------- */
  describe("4. Duplicate Client Pay Request", () => {
    it("should replay completed payment response and not create duplicate payment attempts", async () => {
      const { order, session } = await setupOrderAndSession(600);
      const idempotencyKey = `idem-dup-pay-${Date.now()}`;

      // First click
      const res1 = await paymentSessionService.payThroughSession(session.sessionId, {
        result: "success",
        idempotencyKey
      });

      // Quick second click with same idempotency key (simulating network retry or double-click)
      const res2 = await paymentSessionService.payThroughSession(session.sessionId, {
        result: "success",
        idempotencyKey
      });

      assert.deepEqual(res1.data.payment.paymentId, res2.data.payment.paymentId);

      // Check DB: exactly one payment attempt must exist
      const payments = await paymentRepository.findByOrderId(order.orderId);
      assert.equal(payments.length, 1, "Duplicate payment attempt must not be created");
      assert.equal(payments[0].attemptNumber, 1);
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Test 5: Duplicate Webhook Delivery                                         */
  /* -------------------------------------------------------------------------- */
  describe("5. Duplicate Webhook Delivery", () => {
    it("should safely acknowledge duplicate webhook event and not append duplicate history", async () => {
      const { order, session } = await setupOrderAndSession(500);

      // Create a payment attempt directly
      const paymentAttempt = await paymentRepository.createPayment({
        paymentId: `PAY-WH-DUP-${Date.now()}`,
        orderId: order.orderId,
        attemptNumber: 1,
        amount: 500,
        status: PAYMENT_STATUS.PROCESSING,
        history: [{ status: PAYMENT_STATUS.PROCESSING, message: "Processing", timestamp: new Date() }]
      });

      const eventId = `evt-dup-wh-${Date.now()}`;

      // First webhook delivery
      const wh1 = await paymentWebhookService.processWebhookEvent({
        eventId,
        event: "payment.success",
        paymentId: paymentAttempt.paymentId
      });
      assert.equal(wh1.alreadyProcessed, false);

      // Duplicate webhook delivery
      const wh2 = await paymentWebhookService.processWebhookEvent({
        eventId,
        event: "payment.success",
        paymentId: paymentAttempt.paymentId
      });
      assert.equal(wh2.alreadyProcessed, true);

      // Check payment document history length: exactly 1 success entry added
      const finalPayment = await paymentRepository.findByPaymentId(paymentAttempt.paymentId);
      const successHistory = finalPayment.history.filter((h) => h.status === PAYMENT_STATUS.SUCCESS);
      assert.equal(successHistory.length, 1, "Only one success entry in payment history");
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Test 6: Concurrent Webhook Deliveries                                      */
  /* -------------------------------------------------------------------------- */
  describe("6. Concurrent Webhook Deliveries", () => {
    it("should execute state transition exactly once when parallel webhooks arrive", async () => {
      const { order } = await setupOrderAndSession(500);

      const paymentAttempt = await paymentRepository.createPayment({
        paymentId: `PAY-WH-CONC-${Date.now()}`,
        orderId: order.orderId,
        attemptNumber: 1,
        amount: 500,
        status: PAYMENT_STATUS.PROCESSING,
        history: [{ status: PAYMENT_STATUS.PROCESSING, message: "Processing", timestamp: new Date() }]
      });

      const eventId = `evt-conc-wh-${Date.now()}`;

      const [r1, r2] = await Promise.all([
        paymentWebhookService.processWebhookEvent({
          eventId,
          event: "payment.success",
          paymentId: paymentAttempt.paymentId
        }),
        paymentWebhookService.processWebhookEvent({
          eventId,
          event: "payment.success",
          paymentId: paymentAttempt.paymentId
        })
      ]);

      const newlyProcessed = [r1, r2].filter((r) => r.alreadyProcessed === false);
      const alreadyProcessed = [r1, r2].filter((r) => r.alreadyProcessed === true);

      assert.equal(newlyProcessed.length, 1);
      assert.equal(alreadyProcessed.length, 1);
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Test 7: Already-Paid Order Protection                                      */
  /* -------------------------------------------------------------------------- */
  describe("7. Already-Paid Order Protection", () => {
    it("should reject session creation and payment after order is PAID", async () => {
      const { order, session } = await setupOrderAndSession(500);

      // Successfully pay
      await paymentSessionService.payThroughSession(session.sessionId, { result: "success" });

      // 1. Attempting to create a new session for this paid order must fail with 409
      await assert.rejects(
        async () => {
          await paymentSessionService.createPaymentSession(order.orderId);
        },
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 409);
          assert.match(err.message, /already paid/i);
          return true;
        }
      );

      // 2. Attempting to pay through the existing session must fail with 409
      await assert.rejects(
        async () => {
          await paymentSessionService.payThroughSession(session.sessionId);
        },
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 409);
          assert.match(err.message, /already been completed|already paid/i);
          return true;
        }
      );
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Test 8: Amount Tampering Rejection                                         */
  /* -------------------------------------------------------------------------- */
  describe("8. Amount Tampering Rejection", () => {
    it("should never trust client-provided amount; payment must always equal order.amount", async () => {
      const { order, session } = await setupOrderAndSession(888);

      // Attempting to pass tampered amount in pay request
      const payResult = await paymentSessionService.payThroughSession(session.sessionId, {
        result: "success",
        amount: 1 // Attempted tampering
      });

      assert.equal(payResult.data.payment.amount, 888, "Payment amount must match order amount (888)");
      const paymentInDb = await paymentRepository.findByPaymentId(payResult.data.payment.paymentId);
      assert.equal(paymentInDb.amount, 888);
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Test 9: Session Expiration Handling                                        */
  /* -------------------------------------------------------------------------- */
  describe("9. Session Expiration Handling", () => {
    it("should transition past session to EXPIRED and reject payment attempts with 410", async () => {
      const { order } = await setupOrderAndSession(500);

      // Create an expired session directly in DB
      const expiredSession = await paymentSessionRepository.createSession({
        sessionId: `SESSION-EXP-${Date.now()}`,
        orderId: order.orderId,
        status: PAYMENT_SESSION_STATUS.ACTIVE,
        expiresAt: new Date(Date.now() - 1000) // In the past
      });

      // 1. Fetch session: status should be updated to EXPIRED dynamically
      const fetched = await paymentSessionService.getPaymentSession(expiredSession.sessionId);
      assert.equal(fetched.data.session.sessionStatus, PAYMENT_SESSION_STATUS.EXPIRED);

      // 2. Paying through expired session must be rejected with 410
      await assert.rejects(
        async () => {
          await paymentSessionService.payThroughSession(expiredSession.sessionId);
        },
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 410);
          assert.match(err.message, /expired/i);
          return true;
        }
      );
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Test 10: Completed Session Reuse Rejection                                 */
  /* -------------------------------------------------------------------------- */
  describe("10. Completed Session Reuse Rejection", () => {
    it("should reject subsequent payment attempts on a completed session with 409", async () => {
      const { session } = await setupOrderAndSession(500);

      // Succeeded once
      await paymentSessionService.payThroughSession(session.sessionId, { result: "success" });

      // Reuse attempt
      await assert.rejects(
        async () => {
          await paymentSessionService.payThroughSession(session.sessionId, { result: "success" });
        },
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 409);
          assert.match(err.message, /already been completed|already paid/i);
          return true;
        }
      );
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Test 11: Transaction Failure & Rollback                                    */
  /* -------------------------------------------------------------------------- */
  describe("11. Transaction Failure & Rollback", () => {
    it("should rollback payment to PROCESSING and order to PENDING if error occurs inside transaction", async () => {
      const { order, session } = await setupOrderAndSession(500);

      const paymentAttempt = await paymentRepository.createPayment({
        paymentId: `PAY-TX-FAIL-${Date.now()}`,
        orderId: order.orderId,
        attemptNumber: 1,
        amount: 500,
        status: PAYMENT_STATUS.PROCESSING,
        history: [{ status: PAYMENT_STATUS.PROCESSING, message: "Processing", timestamp: new Date() }]
      });

      const eventId = `evt-tx-fail-${Date.now()}`;

      // Simulate failure inside transaction
      failureSimulationService.setFailureMode(FAILURE_MODES.ORDER_UPDATE_FAILURE);

      await assert.rejects(async () => {
        await paymentWebhookService.processWebhookEvent({
          eventId,
          event: "payment.success",
          paymentId: paymentAttempt.paymentId
        });
      });

      // Verify DB rolled back
      const paymentAfter = await paymentRepository.findByPaymentId(paymentAttempt.paymentId);
      const orderAfter = await orderRepository.findByOrderId(order.orderId);
      const eventAfter = await webhookEventRepository.findByEventId(eventId);

      assert.equal(paymentAfter.status, PAYMENT_STATUS.PROCESSING, "Payment must roll back to PROCESSING");
      assert.equal(orderAfter.status, ORDER_STATUS.PENDING, "Order must remain PENDING");
      assert.equal(eventAfter.status, WEBHOOK_EVENT_STATUS.FAILED, "Webhook event must be marked retryable FAILED");
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Test 12: Invalid Session ID 404 Behavior                                   */
  /* -------------------------------------------------------------------------- */
  describe("12. Invalid Session ID 404 Behavior", () => {
    it("should return clean 404 when session ID is not found", async () => {
      await assert.rejects(
        async () => {
          await paymentSessionService.getPaymentSession("SESSION-NON-EXISTENT");
        },
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 404);
          assert.match(err.message, /not found/i);
          return true;
        }
      );
    });
  });
});
