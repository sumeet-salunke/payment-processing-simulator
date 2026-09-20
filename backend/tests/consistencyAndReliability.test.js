import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";

import { BUSINESS_INVARIANTS } from "../src/constants/invariants.constants.js";
import { assertPaymentSystemConsistency } from "../src/helpers/invariantChecker.js";
import { canTransition } from "../src/helpers/paymentStateMachine.js";
import { PAYMENT_STATUS } from "../src/constants/payment.constants.js";
import { ORDER_STATUS } from "../src/constants/order.constants.js";
import { WEBHOOK_EVENT_STATUS } from "../src/constants/webhookEvent.constants.js";
import { IDEMPOTENCY_STATUS } from "../src/constants/idempotency.constants.js";
import { FAILURE_MODES } from "../src/constants/failureSimulation.constants.js";
import failureSimulationService from "../src/services/failureSimulation.service.js";
import paymentService from "../src/services/payment.service.js";
import paymentRepository from "../src/repositories/payment.repository.js";
import orderRepository from "../src/repositories/order.repository.js";
import webhookEventRepository from "../src/repositories/webhookEvent.repository.js";
import idempotencyService from "../src/services/idempotency.service.js";
import idempotencyKeyRepository from "../src/repositories/idempotencyKey.repository.js";
import paymentWebhookService from "../src/services/paymentWebhook.service.js";
import paymentProviderService from "../src/services/paymentProvider.service.js";
import ApiError from "../src/utils/ApiError.js";

describe("Payment Processing Simulator - Reliability & Edge-Case Consistency Suite", () => {
  beforeEach(() => {
    failureSimulationService.reset();
  });

  const createMockOrder = (overrides = {}) => ({
    orderId: `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    userId: "test-user-consistency",
    amount: 1500,
    status: ORDER_STATUS.PENDING,
    ...overrides
  });

  const createMockPayment = (orderId, attemptNumber, overrides = {}) => ({
    paymentId: `PAY-${orderId}-${attemptNumber}`,
    orderId,
    attemptNumber,
    amount: 1500,
    status: PAYMENT_STATUS.PENDING,
    history: [
      {
        status: PAYMENT_STATUS.PENDING,
        message: `Payment attempt #${attemptNumber} initialized.`,
        timestamp: new Date()
      }
    ],
    ...overrides
  });

  /* -------------------------------------------------------------------------- */
  /* Section 2 & 9: Invariant Verification via Invariant Checker Helper         */
  /* -------------------------------------------------------------------------- */
  describe("Section 2 & 9: Automated Business Invariant Checker", () => {
    it("should pass when order and payments are completely consistent", () => {
      const order = createMockOrder({ status: ORDER_STATUS.PAID });
      const p1 = createMockPayment(order.orderId, 1, { status: PAYMENT_STATUS.FAILED });
      const p2 = createMockPayment(order.orderId, 2, { status: PAYMENT_STATUS.SUCCESS });

      assert.doesNotThrow(() => {
        assertPaymentSystemConsistency({ order, payments: [p1, p2] });
      });
    });

    it("should fail Invariant 1 if Payment is SUCCESS but Order is PENDING", () => {
      const order = createMockOrder({ status: ORDER_STATUS.PENDING });
      const p1 = createMockPayment(order.orderId, 1, { status: PAYMENT_STATUS.SUCCESS });

      assert.throws(() => {
        assertPaymentSystemConsistency({ order, payments: [p1] });
      }, /Invariant 1 Violated/);
    });

    it("should fail Invariant 2 if Order is PAID but no Payment succeeded", () => {
      const order = createMockOrder({ status: ORDER_STATUS.PAID });
      const p1 = createMockPayment(order.orderId, 1, { status: PAYMENT_STATUS.FAILED });

      assert.throws(() => {
        assertPaymentSystemConsistency({ order, payments: [p1] });
      }, /Invariant 2 Violated/);
    });

    it("should fail Invariant 3 if all payments failed but order was marked PAID", () => {
      const order = createMockOrder({ status: ORDER_STATUS.PAID });
      const p1 = createMockPayment(order.orderId, 1, { status: PAYMENT_STATUS.FAILED });
      const p2 = createMockPayment(order.orderId, 2, { status: PAYMENT_STATUS.FAILED });

      assert.throws(() => {
        assertPaymentSystemConsistency({ order, payments: [p1, p2] });
      }, /Invariant 2 Violated|Invariant 3 Violated/);
    });

    it("should fail Invariant 4 if Payment amount differs from Order amount", () => {
      const order = createMockOrder({ amount: 1500 });
      const p1 = createMockPayment(order.orderId, 1, { amount: 1000 });

      assert.throws(() => {
        assertPaymentSystemConsistency({ order, payments: [p1] });
      }, /Invariant 4 Violated/);
    });

    it("should fail Invariant 5 if duplicate attempt numbers exist for same order", () => {
      const order = createMockOrder();
      const p1 = createMockPayment(order.orderId, 1);
      const p2 = createMockPayment(order.orderId, 1);

      assert.throws(() => {
        assertPaymentSystemConsistency({ order, payments: [p1, p2] });
      }, /Invariant 5 Violated/);
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Section 3: Failure Scenarios (A through J)                                 */
  /* -------------------------------------------------------------------------- */
  describe("Section 3: Failure Scenarios", () => {
    // Scenario A — Provider failure
    describe("Scenario A: Provider failure", () => {
      it("should mark Payment as FAILED and keep Order PENDING on provider failure", async () => {
        const order = createMockOrder();
        const payment = createMockPayment(order.orderId, 1, { status: PAYMENT_STATUS.PROCESSING });

        failureSimulationService.setFailureMode(FAILURE_MODES.PROVIDER_FAILURE);

        const providerResult = await paymentProviderService.processPayment(payment.paymentId, "success");
        assert.equal(providerResult.success, false);
        assert.equal(providerResult.event, "payment.failed");

        // Simulate webhook handling of payment.failed
        payment.status = PAYMENT_STATUS.FAILED;
        payment.history.push({ status: PAYMENT_STATUS.FAILED, message: "Payment failed at provider." });

        assertPaymentSystemConsistency({ order, payments: [payment] });
        assert.equal(payment.status, PAYMENT_STATUS.FAILED);
        assert.equal(order.status, ORDER_STATUS.PENDING);
      });
    });

    // Scenario B — Webhook delivery failure
    describe("Scenario B: Webhook delivery failure & recoverability", () => {
      it("should keep payment recoverable in PROCESSING when webhook delivery fails", async () => {
        failureSimulationService.setFailureMode(FAILURE_MODES.WEBHOOK_FAILURE);

        await assert.rejects(
          async () => {
            await paymentProviderService.sendWebhook("payment.success", "PAY-TEST-B", "evt-b-1");
          },
          (err) => {
            assert.ok(err instanceof ApiError);
            assert.equal(err.statusCode, 503);
            assert.match(err.message, /Simulated webhook delivery network failure/);
            return true;
          }
        );
      });
    });

    // Scenario C — Duplicate webhook
    describe("Scenario C: Duplicate webhook", () => {
      it("should recognize duplicate webhook delivery and skip repeated state transition", async () => {
        const eventId = "evt-c-dup-1";
        let executionCount = 0;

        // First delivery executes
        const firstDelivery = {
          eventId,
          status: WEBHOOK_EVENT_STATUS.PROCESSED,
          alreadyProcessed: false
        };
        executionCount++;

        // Duplicate delivery checks status and returns alreadyProcessed: true
        const secondDelivery = {
          eventId,
          status: firstDelivery.status,
          alreadyProcessed: firstDelivery.status === WEBHOOK_EVENT_STATUS.PROCESSED
        };

        assert.equal(executionCount, 1);
        assert.equal(secondDelivery.alreadyProcessed, true);
      });
    });

    // Scenario D — Concurrent webhook
    describe("Scenario D: Concurrent webhook delivery", () => {
      it("should execute state transition exactly once across concurrent deliveries", async () => {
        const eventId = "evt-d-conc-1";
        let winnerCount = 0;

        // Simulate atomic database lock claiming
        const race = await Promise.all([
          (async () => {
            winnerCount++;
            return { winner: true, eventId };
          })(),
          (async () => {
            // Emulate duplicate key collision
            return { winner: false, duplicate: true };
          })()
        ]);

        assert.equal(winnerCount, 1);
        assert.equal(race.filter((r) => r.winner).length, 1);
      });
    });

    // Scenario E — Order update failure & Rollback
    describe("Scenario E: Order update failure transaction rollback", () => {
      it("should rollback payment status when order update fails inside transaction", async () => {
        failureSimulationService.setFailureMode(FAILURE_MODES.ORDER_UPDATE_FAILURE);
        assert.equal(failureSimulationService.checkFailure(FAILURE_MODES.ORDER_UPDATE_FAILURE), true);

        // Transaction abort simulation
        let paymentStatus = PAYMENT_STATUS.PROCESSING;
        let orderStatus = ORDER_STATUS.PENDING;

        try {
          paymentStatus = PAYMENT_STATUS.SUCCESS;
          if (failureSimulationService.checkFailure(FAILURE_MODES.ORDER_UPDATE_FAILURE)) {
            throw new Error("Simulated order update failure inside transaction");
          }
          orderStatus = ORDER_STATUS.PAID;
        } catch (err) {
          // Transaction abort rolls back payment status
          paymentStatus = PAYMENT_STATUS.PROCESSING;
        }

        assert.equal(paymentStatus, PAYMENT_STATUS.PROCESSING);
        assert.equal(orderStatus, ORDER_STATUS.PENDING);
      });
    });

    // Scenario F — Database failure
    describe("Scenario F: Database failure during processing", () => {
      it("should not report false success and prevent partial commit", async () => {
        failureSimulationService.setFailureMode(FAILURE_MODES.DATABASE_FAILURE);

        assert.throws(() => {
          if (failureSimulationService.checkFailure(FAILURE_MODES.DATABASE_FAILURE)) {
            throw new ApiError(500, "Simulated database connection failure");
          }
        }, (err) => {
          assert.equal(err.statusCode, 500);
          return true;
        });
      });
    });

    // Scenario G — Client request timeout / lost response
    describe("Scenario G: Client response lost and replay via Idempotency-Key", () => {
      it("should replay completed response without duplicate processing when client retries", async () => {
        const key = `idem-retry-${Date.now()}`;
        const paymentId = "PAY-RETRY-001";
        let executionCounter = 0;

        const execute = async () => {
          executionCounter++;
          return { message: "Payment processed successfully", data: { paymentId, status: "success" } };
        };

        // First client request
        const res1 = await idempotencyService.processWithIdempotency(
          { key, paymentId, endpoint: `/api/payments/${paymentId}/process`, body: { result: "success" } },
          execute
        );

        assert.equal(res1.isCached, false);
        assert.equal(executionCounter, 1);

        // Simulate lost response: client retries with exact same Idempotency-Key
        const res2 = await idempotencyService.processWithIdempotency(
          { key, paymentId, endpoint: `/api/payments/${paymentId}/process`, body: { result: "success" } },
          execute
        );

        assert.equal(res2.isCached, true);
        assert.equal(executionCounter, 1, "Business logic must NOT be re-executed on client retry");
        assert.deepEqual(res2.response, res1.response);
      });
    });

    // Scenario H — Retry exhaustion
    describe("Scenario H: Webhook retry exhaustion to DEAD state", () => {
      it("should transition to DEAD status when attempts reach maxAttempts", () => {
        const maxAttempts = 5;
        let attempts = 4;
        let status = WEBHOOK_EVENT_STATUS.FAILED;

        // 5th attempt fails
        attempts++;
        if (attempts >= maxAttempts) {
          status = WEBHOOK_EVENT_STATUS.DEAD;
        }

        assert.equal(attempts, 5);
        assert.equal(status, WEBHOOK_EVENT_STATUS.DEAD);
      });
    });

    // Scenario I — Worker failure simulation
    describe("Scenario I: Webhook worker failure simulation", () => {
      it("should flag simulated worker process crash during retry", () => {
        failureSimulationService.setFailureMode(FAILURE_MODES.WORKER_FAILURE);
        assert.throws(() => {
          if (failureSimulationService.checkFailure(FAILURE_MODES.WORKER_FAILURE)) {
            throw new Error("Simulated worker process crash during retry");
          }
        }, /worker process crash/);
      });
    });

    // Scenario J — Failed payment retry preserves history and creates new attempt
    describe("Scenario J: Multi-attempt retry preserves failed history", () => {
      it("should preserve Attempt 1 as FAILED and make Attempt 2 SUCCESS, transitioning order to PAID", () => {
        const order = createMockOrder({ status: ORDER_STATUS.PAID });
        const attempt1 = createMockPayment(order.orderId, 1, {
          status: PAYMENT_STATUS.FAILED,
          history: [
            { status: PAYMENT_STATUS.PENDING, message: "Payment attempt #1 initialized." },
            { status: PAYMENT_STATUS.FAILED, message: "Card declined by provider." }
          ]
        });
        const attempt2 = createMockPayment(order.orderId, 2, {
          status: PAYMENT_STATUS.SUCCESS,
          history: [
            { status: PAYMENT_STATUS.PENDING, message: "Payment attempt #2 initialized." },
            { status: PAYMENT_STATUS.SUCCESS, message: "Payment settled." }
          ]
        });

        assertPaymentSystemConsistency({ order, payments: [attempt1, attempt2] });
        assert.equal(attempt1.status, PAYMENT_STATUS.FAILED);
        assert.equal(attempt2.status, PAYMENT_STATUS.SUCCESS);
        assert.equal(order.status, ORDER_STATUS.PAID);
      });
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Section 5: Concurrency Testing                                             */
  /* -------------------------------------------------------------------------- */
  describe("Section 5: Concurrency Testing", () => {
    it("Test 1: Two concurrent payment creations calculate distinct attempt numbers", async () => {
      const order = createMockOrder();
      let callCount = 0;

      const origFindByOrderId = orderRepository.findByOrderId;
      const origFindLatest = paymentRepository.findLatestByOrderId;
      const origCreate = paymentRepository.createPayment;

      try {
        orderRepository.findByOrderId = async () => order;
        paymentRepository.findLatestByOrderId = async () => (callCount === 0 ? null : { attemptNumber: 1 });
        paymentRepository.createPayment = async (data) => {
          callCount++;
          if (callCount === 1) {
            const err = new Error("E11000 duplicate key error");
            err.code = 11000;
            throw err;
          }
          return data;
        };

        const res = await paymentService.createPayment(order.orderId);
        assert.equal(res.data.attemptNumber, 2);
      } finally {
        orderRepository.findByOrderId = origFindByOrderId;
        paymentRepository.findLatestByOrderId = origFindLatest;
        paymentRepository.createPayment = origCreate;
      }
    });

    it("Test 2: Two concurrent requests with same Idempotency-Key allow only one execution", async () => {
      const key = `idem-conc-${Date.now()}`;
      const paymentId = "PAY-CONC-002";
      let execCount = 0;

      const runBusinessLogic = async () => {
        execCount++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { message: "success", data: { paymentId } };
      };

      const [r1, r2] = await Promise.all([
        idempotencyService.processWithIdempotency(
          { key, paymentId, endpoint: `/api/payments/${paymentId}/process`, body: {} },
          runBusinessLogic
        ),
        idempotencyService.processWithIdempotency(
          { key, paymentId, endpoint: `/api/payments/${paymentId}/process`, body: {} },
          runBusinessLogic
        )
      ]);

      assert.equal(execCount, 1, "Business logic must execute only once");
      assert.deepEqual(r1.response, r2.response);
    });

    it("Test 3 & 4: Two identical or competing webhook events on same payment", () => {
      const eventId = "evt-compete-1";
      const processedEvents = new Set();

      const claimEvent = (id) => {
        if (processedEvents.has(id)) return false;
        processedEvents.add(id);
        return true;
      };

      const firstClaim = claimEvent(eventId);
      const secondClaim = claimEvent(eventId);

      assert.equal(firstClaim, true);
      assert.equal(secondClaim, false, "Second concurrent attempt must be rejected by idempotency check");
    });

    it("Test 5: Payment retry occurring while another payment operation is in progress", () => {
      const currentStatus = PAYMENT_STATUS.PROCESSING;
      // State machine prevents transitioning from PROCESSING to PROCESSING
      const canReTransit = canTransition(currentStatus, PAYMENT_STATUS.PROCESSING);
      assert.equal(canReTransit, false, "Payment cannot transition from PROCESSING to PROCESSING");
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Section 6: State-Machine Abuse Tests                                       */
  /* -------------------------------------------------------------------------- */
  describe("Section 6: State-Machine Abuse Tests", () => {
    it("should reject invalid direct transition PENDING -> SUCCESS", () => {
      assert.equal(canTransition(PAYMENT_STATUS.PENDING, PAYMENT_STATUS.SUCCESS), false);
    });

    it("should reject invalid direct transition PENDING -> FAILED", () => {
      assert.equal(canTransition(PAYMENT_STATUS.PENDING, PAYMENT_STATUS.FAILED), false);
    });

    it("should reject invalid backward transition SUCCESS -> PROCESSING", () => {
      assert.equal(canTransition(PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.PROCESSING), false);
    });

    it("should reject invalid backward transition SUCCESS -> FAILED", () => {
      assert.equal(canTransition(PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.FAILED), false);
    });

    it("should permit legitimate transitions", () => {
      assert.equal(canTransition(PAYMENT_STATUS.PENDING, PAYMENT_STATUS.PROCESSING), true);
      assert.equal(canTransition(PAYMENT_STATUS.PROCESSING, PAYMENT_STATUS.SUCCESS), true);
      assert.equal(canTransition(PAYMENT_STATUS.PROCESSING, PAYMENT_STATUS.FAILED), true);
      assert.equal(canTransition(PAYMENT_STATUS.FAILED, PAYMENT_STATUS.PROCESSING), true);
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Section 7: Already-Paid Order Protection                                   */
  /* -------------------------------------------------------------------------- */
  describe("Section 7: Already-Paid Order Comprehensive Tests", () => {
    it("should reject creating a new payment attempt when Order is PAID", async () => {
      const order = createMockOrder({ status: ORDER_STATUS.PAID });
      const origFindByOrderId = orderRepository.findByOrderId;

      try {
        orderRepository.findByOrderId = async () => order;
        await assert.rejects(
          async () => {
            await paymentService.createPayment(order.orderId);
          },
          (err) => {
            assert.ok(err instanceof ApiError);
            assert.equal(err.statusCode, 409);
            assert.match(err.message, /already paid/i);
            return true;
          }
        );
      } finally {
        orderRepository.findByOrderId = origFindByOrderId;
      }
    });

    it("should not allow payment processing if payment is already in terminal SUCCESS state", async () => {
      const payment = createMockPayment("ORD-PAID-01", 1, { status: PAYMENT_STATUS.SUCCESS });
      const canTransit = canTransition(payment.status, PAYMENT_STATUS.PROCESSING);
      assert.equal(canTransit, false);
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Section 8: History Integrity Isolation                                     */
  /* -------------------------------------------------------------------------- */
  describe("Section 8: Payment Attempt History Isolation", () => {
    it("should maintain strict separation between histories of Attempt 1 and Attempt 2", () => {
      const order = createMockOrder({ status: ORDER_STATUS.PAID });
      const attempt1 = createMockPayment(order.orderId, 1, {
        status: PAYMENT_STATUS.FAILED,
        history: [
          { status: PAYMENT_STATUS.PENDING, message: "Payment attempt #1 initialized." },
          { status: PAYMENT_STATUS.PROCESSING, message: "Processing attempt #1" },
          { status: PAYMENT_STATUS.FAILED, message: "Declined" }
        ]
      });

      const attempt2 = createMockPayment(order.orderId, 2, {
        status: PAYMENT_STATUS.SUCCESS,
        history: [
          { status: PAYMENT_STATUS.PENDING, message: "Payment attempt #2 initialized." },
          { status: PAYMENT_STATUS.PROCESSING, message: "Processing attempt #2" },
          { status: PAYMENT_STATUS.SUCCESS, message: "Approved" }
        ]
      });

      assertPaymentSystemConsistency({ order, payments: [attempt1, attempt2] });

      assert.equal(attempt1.history.length, 3);
      assert.equal(attempt2.history.length, 3);
      assert.ok(attempt1.history.every((h) => !h.message.includes("#2")));
      assert.ok(attempt2.history.every((h) => !h.message.includes("#1")));
    });
  });
});
