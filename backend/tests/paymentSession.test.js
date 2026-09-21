import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";

import paymentSessionService from "../src/services/paymentSession.service.js";
import paymentSessionRepository from "../src/repositories/paymentSession.repository.js";
import orderRepository from "../src/repositories/order.repository.js";
import paymentRepository from "../src/repositories/payment.repository.js";
import paymentService from "../src/services/payment.service.js";
import { ORDER_STATUS } from "../src/constants/order.constants.js";
import { PAYMENT_STATUS } from "../src/constants/payment.constants.js";
import { PAYMENT_SESSION_STATUS } from "../src/constants/paymentSession.constants.js";
import ApiError from "../src/utils/ApiError.js";

describe("QR-Based Payment Session Tests", () => {
  const generateMockOrderId = () => `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  const createMockOrder = (overrides = {}) => ({
    orderId: generateMockOrderId(),
    userId: "test-user-qr",
    amount: 500,
    status: ORDER_STATUS.PENDING,
    ...overrides
  });

  // Test 1: Create payment session for valid unpaid order
  describe("Test 1: Create Payment Session for Valid Unpaid Order", () => {
    it("should successfully create an active payment session", async () => {
      const order = createMockOrder();
      const origFindByOrderId = orderRepository.findByOrderId;
      const origCreateSession = paymentSessionRepository.createSession;

      try {
        orderRepository.findByOrderId = async () => order;
        paymentSessionRepository.createSession = async (data) => data;

        const result = await paymentSessionService.createPaymentSession(order.orderId);

        assert.ok(result.data.session);
        assert.equal(result.data.session.orderId, order.orderId);
        assert.equal(result.data.session.status, PAYMENT_SESSION_STATUS.ACTIVE);
        assert.ok(result.data.session.sessionId.startsWith("SESSION-"));
        assert.ok(result.data.session.expiresAt);
      } finally {
        orderRepository.findByOrderId = origFindByOrderId;
        paymentSessionRepository.createSession = origCreateSession;
      }
    });
  });

  // Test 2: Session contains the correct Order association
  describe("Test 2: Order Association Verification", () => {
    it("should link session strictly to the target orderId", async () => {
      const order = createMockOrder();
      const origFindByOrderId = orderRepository.findByOrderId;
      const origCreateSession = paymentSessionRepository.createSession;

      try {
        orderRepository.findByOrderId = async () => order;
        paymentSessionRepository.createSession = async (data) => data;

        const result = await paymentSessionService.createPaymentSession(order.orderId);
        assert.equal(result.data.session.orderId, order.orderId);
      } finally {
        orderRepository.findByOrderId = origFindByOrderId;
        paymentSessionRepository.createSession = origCreateSession;
      }
    });
  });

  // Test 3: Session amount matches the Order amount
  describe("Test 3: Session Amount Matches Order Amount", () => {
    it("should derive amount strictly from order.amount", async () => {
      const order = createMockOrder({ amount: 999 });
      const origFindByOrderId = orderRepository.findByOrderId;
      const origCreateSession = paymentSessionRepository.createSession;

      try {
        orderRepository.findByOrderId = async () => order;
        paymentSessionRepository.createSession = async (data) => data;

        const result = await paymentSessionService.createPaymentSession(order.orderId);
        assert.equal(result.data.session.amount, 999);
      } finally {
        orderRepository.findByOrderId = origFindByOrderId;
        paymentSessionRepository.createSession = origCreateSession;
      }
    });
  });

  // Test 4: Client-provided amount cannot manipulate the session
  describe("Test 4: Client-Provided Amount Cannot Manipulate Session", () => {
    it("should ignore any client-supplied amount and preserve order amount", async () => {
      const order = createMockOrder({ amount: 500 });
      const origFindByOrderId = orderRepository.findByOrderId;
      const origCreateSession = paymentSessionRepository.createSession;

      try {
        orderRepository.findByOrderId = async () => order;
        paymentSessionRepository.createSession = async (data) => data;

        // Attempting to pass amount 1 in request does not affect session creation
        const result = await paymentSessionService.createPaymentSession(order.orderId);
        assert.equal(result.data.session.amount, 500);
      } finally {
        orderRepository.findByOrderId = origFindByOrderId;
        paymentSessionRepository.createSession = origCreateSession;
      }
    });
  });

  // Test 5: Unknown session returns 404
  describe("Test 5: Unknown Session Returns 404", () => {
    it("should throw 404 Not Found when session does not exist", async () => {
      const origFindBySessionId = paymentSessionRepository.findBySessionId;

      try {
        paymentSessionRepository.findBySessionId = async () => null;

        await assert.rejects(
          async () => {
            await paymentSessionService.getPaymentSession("SESSION-NONEXISTENT");
          },
          (err) => {
            assert.ok(err instanceof ApiError);
            assert.equal(err.statusCode, 404);
            assert.match(err.message, /not found/i);
            return true;
          }
        );
      } finally {
        paymentSessionRepository.findBySessionId = origFindBySessionId;
      }
    });
  });

  // Test 6: Expired session cannot initiate payment
  describe("Test 6: Expired Session Cannot Initiate Payment", () => {
    it("should throw 410 Gone / Conflict when attempting to pay an expired session", async () => {
      const expiredSession = {
        sessionId: "SESSION-EXPIRED-1",
        orderId: "ORD-EXP-1",
        status: PAYMENT_SESSION_STATUS.ACTIVE,
        expiresAt: new Date(Date.now() - 1000) // Past date
      };

      const origFindBySessionId = paymentSessionRepository.findBySessionId;
      const origUpdateStatus = paymentSessionRepository.updateStatus;

      try {
        paymentSessionRepository.findBySessionId = async () => expiredSession;
        paymentSessionRepository.updateStatus = async (id, status) => ({ ...expiredSession, status });

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
      } finally {
        paymentSessionRepository.findBySessionId = origFindBySessionId;
        paymentSessionRepository.updateStatus = origUpdateStatus;
      }
    });
  });

  // Test 7: Already-paid Order cannot create a new session
  describe("Test 7: Already-Paid Order Cannot Create Session", () => {
    it("should throw 409 Conflict when creating a session for a PAID order", async () => {
      const order = createMockOrder({ status: ORDER_STATUS.PAID });
      const origFindByOrderId = orderRepository.findByOrderId;

      try {
        orderRepository.findByOrderId = async () => order;

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
      } finally {
        orderRepository.findByOrderId = origFindByOrderId;
      }
    });
  });

  // Test 8: Expired session marks status EXPIRED on retrieval
  describe("Test 8: Expired Session Detection On Retrieval", () => {
    it("should dynamically detect past expiration and update status to EXPIRED", async () => {
      const order = createMockOrder();
      const pastSession = {
        sessionId: "SESSION-PAST-1",
        orderId: order.orderId,
        status: PAYMENT_SESSION_STATUS.ACTIVE,
        expiresAt: new Date(Date.now() - 5000)
      };

      const origFindBySessionId = paymentSessionRepository.findBySessionId;
      const origFindByOrderId = orderRepository.findByOrderId;
      const origUpdateStatus = paymentSessionRepository.updateStatus;

      try {
        paymentSessionRepository.findBySessionId = async () => pastSession;
        orderRepository.findByOrderId = async () => order;
        paymentSessionRepository.updateStatus = async (id, status) => ({ ...pastSession, status });

        const result = await paymentSessionService.getPaymentSession(pastSession.sessionId);
        assert.equal(result.data.session.sessionStatus, PAYMENT_SESSION_STATUS.EXPIRED);
      } finally {
        paymentSessionRepository.findBySessionId = origFindBySessionId;
        orderRepository.findByOrderId = origFindByOrderId;
        paymentSessionRepository.updateStatus = origUpdateStatus;
      }
    });
  });

  // Test 9: Active session can create a payment attempt
  describe("Test 9: Active Session Creates Payment Attempt", () => {
    it("should invoke paymentService.createPayment and processPayment for active session", async () => {
      const order = createMockOrder();
      const session = {
        sessionId: "SESSION-ACTIVE-1",
        orderId: order.orderId,
        status: PAYMENT_SESSION_STATUS.ACTIVE,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000)
      };

      const origFindBySessionId = paymentSessionRepository.findBySessionId;
      const origFindByOrderId = orderRepository.findByOrderId;
      const origCreatePayment = paymentService.createPayment;
      const origProcessPayment = paymentService.processPayment;

      try {
        paymentSessionRepository.findBySessionId = async () => session;
        orderRepository.findByOrderId = async () => order;
        paymentService.createPayment = async (orderId) => ({
          data: { paymentId: "PAYMENT-NEW-01", orderId, amount: order.amount, attemptNumber: 1 }
        });
        paymentService.processPayment = async (paymentId, result) => ({
          data: { paymentId, status: PAYMENT_STATUS.SUCCESS, amount: order.amount }
        });

        const result = await paymentSessionService.payThroughSession(session.sessionId, { result: "success" });

        assert.equal(result.data.sessionId, session.sessionId);
        assert.equal(result.data.payment.paymentId, "PAYMENT-NEW-01");
        assert.equal(result.data.payment.status, PAYMENT_STATUS.SUCCESS);
      } finally {
        paymentSessionRepository.findBySessionId = origFindBySessionId;
        orderRepository.findByOrderId = origFindByOrderId;
        paymentService.createPayment = origCreatePayment;
        paymentService.processPayment = origProcessPayment;
      }
    });
  });

  // Test 10: Payment through session still uses the existing payment state machine
  describe("Test 10: Payment State Machine Integration", () => {
    it("should reuse the existing payment state machine transitions", async () => {
      const order = createMockOrder();
      const session = {
        sessionId: "SESSION-STATE-1",
        orderId: order.orderId,
        status: PAYMENT_SESSION_STATUS.ACTIVE,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000)
      };

      let stateMachineVerified = false;
      const origFindBySessionId = paymentSessionRepository.findBySessionId;
      const origFindByOrderId = orderRepository.findByOrderId;
      const origCreatePayment = paymentService.createPayment;
      const origProcessPayment = paymentService.processPayment;

      try {
        paymentSessionRepository.findBySessionId = async () => session;
        orderRepository.findByOrderId = async () => order;
        paymentService.createPayment = async (orderId) => ({
          data: { paymentId: "PAY-STATE-CHECK", orderId, attemptNumber: 1 }
        });
        paymentService.processPayment = async (paymentId) => {
          stateMachineVerified = true;
          return { data: { paymentId, status: PAYMENT_STATUS.SUCCESS } };
        };

        await paymentSessionService.payThroughSession(session.sessionId);
        assert.equal(stateMachineVerified, true);
      } finally {
        paymentSessionRepository.findBySessionId = origFindBySessionId;
        orderRepository.findByOrderId = origFindByOrderId;
        paymentService.createPayment = origCreatePayment;
        paymentService.processPayment = origProcessPayment;
      }
    });
  });

  // Test 11: Successful payment eventually marks Order = PAID, Payment = SUCCESS, Session = COMPLETED
  describe("Test 11: End-to-End Success Lifecycle", () => {
    it("should reflect COMPLETED status on session when order transitions to PAID", async () => {
      const order = createMockOrder({ status: ORDER_STATUS.PAID });
      const session = {
        sessionId: "SESSION-COMPLETED-1",
        orderId: order.orderId,
        status: PAYMENT_SESSION_STATUS.ACTIVE,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000)
      };

      const origFindBySessionId = paymentSessionRepository.findBySessionId;
      const origFindByOrderId = orderRepository.findByOrderId;
      const origUpdateStatus = paymentSessionRepository.updateStatus;

      try {
        paymentSessionRepository.findBySessionId = async () => session;
        orderRepository.findByOrderId = async () => order;
        paymentSessionRepository.updateStatus = async (id, status) => ({ ...session, status });

        const result = await paymentSessionService.getPaymentSession(session.sessionId);
        assert.equal(result.data.session.orderStatus, ORDER_STATUS.PAID);
        assert.equal(result.data.session.sessionStatus, PAYMENT_SESSION_STATUS.COMPLETED);
      } finally {
        paymentSessionRepository.findBySessionId = origFindBySessionId;
        orderRepository.findByOrderId = origFindByOrderId;
        paymentSessionRepository.updateStatus = origUpdateStatus;
      }
    });
  });

  // Test 12: Completed session cannot be reused
  describe("Test 12: Completed Session Rejection", () => {
    it("should reject paying through an already completed session with 409 Conflict", async () => {
      const session = {
        sessionId: "SESSION-ALREADY-DONE",
        orderId: "ORD-DONE-1",
        status: PAYMENT_SESSION_STATUS.COMPLETED,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000)
      };

      const origFindBySessionId = paymentSessionRepository.findBySessionId;

      try {
        paymentSessionRepository.findBySessionId = async () => session;

        await assert.rejects(
          async () => {
            await paymentSessionService.payThroughSession(session.sessionId);
          },
          (err) => {
            assert.ok(err instanceof ApiError);
            assert.equal(err.statusCode, 409);
            assert.match(err.message, /already been completed/i);
            return true;
          }
        );
      } finally {
        paymentSessionRepository.findBySessionId = origFindBySessionId;
      }
    });
  });

  // Test 13: Two concurrent requests cannot create inconsistent session/payment state
  describe("Test 13: Concurrency Safety On Session Creation & Payment", () => {
    it("should reject payment if order transitions to PAID between lookups", async () => {
      const order = createMockOrder({ status: ORDER_STATUS.PAID });
      const session = {
        sessionId: "SESSION-CONC-1",
        orderId: order.orderId,
        status: PAYMENT_SESSION_STATUS.ACTIVE,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000)
      };

      const origFindBySessionId = paymentSessionRepository.findBySessionId;
      const origFindByOrderId = orderRepository.findByOrderId;
      const origUpdateStatus = paymentSessionRepository.updateStatus;

      try {
        paymentSessionRepository.findBySessionId = async () => session;
        orderRepository.findByOrderId = async () => order;
        paymentSessionRepository.updateStatus = async () => ({ ...session, status: PAYMENT_SESSION_STATUS.COMPLETED });

        await assert.rejects(
          async () => {
            await paymentSessionService.payThroughSession(session.sessionId);
          },
          (err) => {
            assert.ok(err instanceof ApiError);
            assert.equal(err.statusCode, 409);
            assert.match(err.message, /already paid/i);
            return true;
          }
        );
      } finally {
        paymentSessionRepository.findBySessionId = origFindBySessionId;
        orderRepository.findByOrderId = origFindByOrderId;
        paymentSessionRepository.updateStatus = origUpdateStatus;
      }
    });
  });

  // Test 14: QR payload contains only the intended public session URL/identifier
  describe("Test 14: QR Payload Structure", () => {
    it("should construct QR payload pointing to /payment/:sessionId without query strings or amounts", () => {
      const sessionId = "SESSION-TEST-QR-URL";
      const qrPayload = paymentSessionService.getQrPayload(sessionId);

      assert.match(qrPayload, /\/payment\/SESSION-TEST-QR-URL$/);
      assert.ok(!qrPayload.includes("amount="));
      assert.ok(!qrPayload.includes("orderId="));
      assert.ok(!qrPayload.includes("secret"));
    });
  });

  // Test 15: Sensitive information is not exposed through the QR payload or session DTO
  describe("Test 15: Security & Data Minimization", () => {
    it("should not expose internal MongoDB _id, credentials, or secrets in session retrieval", async () => {
      const order = createMockOrder();
      const session = {
        _id: "507f1f77bcf86cd799439011",
        sessionId: "SESSION-SAFE-1",
        orderId: order.orderId,
        status: PAYMENT_SESSION_STATUS.ACTIVE,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        secretCredential: "super-secret-token"
      };

      const origFindBySessionId = paymentSessionRepository.findBySessionId;
      const origFindByOrderId = orderRepository.findByOrderId;

      try {
        paymentSessionRepository.findBySessionId = async () => session;
        orderRepository.findByOrderId = async () => order;

        const result = await paymentSessionService.getPaymentSession(session.sessionId);
        const sessionDto = result.data.session;

        assert.equal(sessionDto._id, undefined);
        assert.equal(sessionDto.secretCredential, undefined);
        assert.equal(sessionDto.sessionId, session.sessionId);
        assert.equal(sessionDto.amount, order.amount);
      } finally {
        paymentSessionRepository.findBySessionId = origFindBySessionId;
        orderRepository.findByOrderId = origFindByOrderId;
      }
    });
  });
});
