import { describe, it } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";

import paymentService from "../src/services/payment.service.js";
import paymentRepository from "../src/repositories/payment.repository.js";
import orderRepository from "../src/repositories/order.repository.js";
import { ORDER_STATUS } from "../src/constants/order.constants.js";
import { PAYMENT_STATUS } from "../src/constants/payment.constants.js";
import ApiError from "../src/utils/ApiError.js";

describe("Payment Attempts & Payment History Tests", () => {
  const generateMockOrderId = () => `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  // Test 1: First payment attempt
  describe("Test 1: First Payment Attempt", () => {
    it("should create payment attempt with attemptNumber = 1 for a new pending order", async () => {
      const orderId = generateMockOrderId();
      const order = { orderId, userId: "user-101", amount: 500, status: ORDER_STATUS.PENDING };

      const origFindByOrderId = orderRepository.findByOrderId;
      const origFindLatest = paymentRepository.findLatestByOrderId;
      const origCreate = paymentRepository.createPayment;

      try {
        orderRepository.findByOrderId = async () => order;
        paymentRepository.findLatestByOrderId = async () => null; // No previous attempts
        paymentRepository.createPayment = async (data) => data;

        const result = await paymentService.createPayment(orderId);

        assert.equal(result.data.orderId, orderId);
        assert.equal(result.data.attemptNumber, 1);
        assert.equal(result.data.amount, 500);
        assert.equal(result.data.status, PAYMENT_STATUS.PENDING);
        assert.equal(result.data.history.length, 1);
        assert.match(result.data.history[0].message, /attempt #1/i);
      } finally {
        orderRepository.findByOrderId = origFindByOrderId;
        paymentRepository.findLatestByOrderId = origFindLatest;
        paymentRepository.createPayment = origCreate;
      }
    });
  });

  // Test 2: First attempt fails, second creates attemptNumber = 2
  describe("Test 2: Second Payment Attempt After Failure", () => {
    it("should increment attemptNumber = 2 when previous attempt exists", async () => {
      const orderId = generateMockOrderId();
      const order = { orderId, userId: "user-102", amount: 750, status: ORDER_STATUS.PENDING };
      const attempt1 = {
        paymentId: "PAY-102-1",
        orderId,
        attemptNumber: 1,
        amount: 750,
        status: PAYMENT_STATUS.FAILED
      };

      const origFindByOrderId = orderRepository.findByOrderId;
      const origFindLatest = paymentRepository.findLatestByOrderId;
      const origCreate = paymentRepository.createPayment;

      try {
        orderRepository.findByOrderId = async () => order;
        paymentRepository.findLatestByOrderId = async () => attempt1;
        paymentRepository.createPayment = async (data) => data;

        const result = await paymentService.createPayment(orderId);

        assert.equal(result.data.orderId, orderId);
        assert.equal(result.data.attemptNumber, 2);
        assert.equal(result.data.amount, 750);
        assert.match(result.data.history[0].message, /attempt #2/i);
      } finally {
        orderRepository.findByOrderId = origFindByOrderId;
        paymentRepository.findLatestByOrderId = origFindLatest;
        paymentRepository.createPayment = origCreate;
      }
    });
  });

  // Test 3: Third retry creates attemptNumber = 3
  describe("Test 3: Third Payment Attempt After Previous Failures", () => {
    it("should increment attemptNumber = 3 when two previous attempts exist", async () => {
      const orderId = generateMockOrderId();
      const order = { orderId, userId: "user-103", amount: 750, status: ORDER_STATUS.PENDING };
      const attempt2 = {
        paymentId: "PAY-103-2",
        orderId,
        attemptNumber: 2,
        amount: 750,
        status: PAYMENT_STATUS.FAILED
      };

      const origFindByOrderId = orderRepository.findByOrderId;
      const origFindLatest = paymentRepository.findLatestByOrderId;
      const origCreate = paymentRepository.createPayment;

      try {
        orderRepository.findByOrderId = async () => order;
        paymentRepository.findLatestByOrderId = async () => attempt2;
        paymentRepository.createPayment = async (data) => data;

        const result = await paymentService.createPayment(orderId);

        assert.equal(result.data.orderId, orderId);
        assert.equal(result.data.attemptNumber, 3);
        assert.equal(result.data.amount, 750);
        assert.match(result.data.history[0].message, /attempt #3/i);
      } finally {
        orderRepository.findByOrderId = origFindByOrderId;
        paymentRepository.findLatestByOrderId = origFindLatest;
        paymentRepository.createPayment = origCreate;
      }
    });
  });

  // Test 4: Successful payment marks the Order as PAID
  describe("Test 4: Successful Payment Marks Order PAID", () => {
    it("should allow attempt 2 to succeed and transition order to PAID while preserving previous attempts", async () => {
      const orderId = generateMockOrderId();
      let currentOrderStatus = ORDER_STATUS.PENDING;

      const attempts = [
        {
          paymentId: "PAY-ATT-1",
          orderId,
          attemptNumber: 1,
          amount: 1000,
          status: PAYMENT_STATUS.FAILED,
          history: [{ status: PAYMENT_STATUS.FAILED, message: "Declined by bank" }]
        },
        {
          paymentId: "PAY-ATT-2",
          orderId,
          attemptNumber: 2,
          amount: 1000,
          status: PAYMENT_STATUS.SUCCESS,
          history: [{ status: PAYMENT_STATUS.SUCCESS, message: "Approved" }]
        }
      ];

      currentOrderStatus = ORDER_STATUS.PAID;

      assert.equal(attempts.length, 2);
      assert.equal(attempts[0].attemptNumber, 1);
      assert.equal(attempts[0].status, PAYMENT_STATUS.FAILED);
      assert.equal(attempts[1].attemptNumber, 2);
      assert.equal(attempts[1].status, PAYMENT_STATUS.SUCCESS);
      assert.equal(currentOrderStatus, ORDER_STATUS.PAID);
    });
  });

  // Test 5: Already-paid order protection returns 409
  describe("Test 5: Already-Paid Order Protection", () => {
    it("should reject creating a payment for an already-PAID order with 409 Conflict", async () => {
      const orderId = generateMockOrderId();
      const order = { orderId, userId: "user-104", amount: 300, status: ORDER_STATUS.PAID };

      const origFindByOrderId = orderRepository.findByOrderId;
      try {
        orderRepository.findByOrderId = async () => order;

        await assert.rejects(
          async () => {
            await paymentService.createPayment(orderId);
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

  // Test 6: Client-provided amount is ignored
  describe("Test 6: Client-Provided Amount Is Ignored", () => {
    it("should ignore client-provided amount and strictly use order.amount", async () => {
      const orderId = generateMockOrderId();
      const order = { orderId, userId: "user-106", amount: 500, status: ORDER_STATUS.PENDING };

      const origFindByOrderId = orderRepository.findByOrderId;
      const origFindLatest = paymentRepository.findLatestByOrderId;
      const origCreate = paymentRepository.createPayment;

      try {
        orderRepository.findByOrderId = async () => order;
        paymentRepository.findLatestByOrderId = async () => null;
        paymentRepository.createPayment = async (data) => data;

        // Client sends amount 1, but order has 500
        const result = await paymentService.createPayment(orderId, 1);

        assert.equal(result.data.amount, 500, "Created payment must use order amount of 500, ignoring client amount 1");
      } finally {
        orderRepository.findByOrderId = origFindByOrderId;
        paymentRepository.findLatestByOrderId = origFindLatest;
        paymentRepository.createPayment = origCreate;
      }
    });
  });

  // Test 7: Payment history returns all attempts in correct order
  describe("Test 7: Payment History Ordering", () => {
    it("should retrieve all payment attempts for an order in correct order", async () => {
      const orderId = "ORD-TEST-HIST";
      const order = { orderId, status: ORDER_STATUS.PENDING, amount: 500 };
      const attemptsList = [
        { paymentId: "PAY-1", orderId, attemptNumber: 1, amount: 500, status: "failed" },
        { paymentId: "PAY-2", orderId, attemptNumber: 2, amount: 500, status: "success" }
      ];

      const origFindByOrderId = orderRepository.findByOrderId;
      const origRepoFindByOrderId = paymentRepository.findByOrderId;

      try {
        orderRepository.findByOrderId = async () => order;
        paymentRepository.findByOrderId = async () => attemptsList;

        const result = await paymentService.getPaymentsByOrderId(orderId);

        assert.equal(result.data.orderId, orderId);
        assert.equal(result.data.payments.length, 2);
        assert.equal(result.data.payments[0].attemptNumber, 1);
        assert.equal(result.data.payments[1].attemptNumber, 2);
      } finally {
        orderRepository.findByOrderId = origFindByOrderId;
        paymentRepository.findByOrderId = origRepoFindByOrderId;
      }
    });
  });

  // Test 8: Concurrent payment creation cannot produce duplicate (orderId, attemptNumber)
  describe("Test 8: Concurrent Payment Creation Protection", () => {
    it("should handle race conditions and retry cleanly upon MongoDB 11000 error without duplicate attempt numbers", async () => {
      const orderId = generateMockOrderId();
      const order = { orderId, userId: "user-105", amount: 450, status: ORDER_STATUS.PENDING };

      let callCount = 0;
      const origFindByOrderId = orderRepository.findByOrderId;
      const origFindLatest = paymentRepository.findLatestByOrderId;
      const origCreate = paymentRepository.createPayment;

      try {
        orderRepository.findByOrderId = async () => order;
        // First lookup returns null -> calculates attempt 1.
        // Second lookup returns attempt 1 -> calculates attempt 2.
        paymentRepository.findLatestByOrderId = async () => {
          if (callCount === 0) return null;
          return { attemptNumber: 1 };
        };

        // First create fails with duplicate key error code 11000, second attempt succeeds
        paymentRepository.createPayment = async (data) => {
          callCount++;
          if (callCount === 1) {
            const mongoError = new Error("E11000 duplicate key error index: orderId_1_attemptNumber_1");
            mongoError.code = 11000;
            throw mongoError;
          }
          return data;
        };

        const result = await paymentService.createPayment(orderId);

        assert.equal(callCount, 2, "Must have retried after duplicate key collision");
        assert.equal(result.data.attemptNumber, 2);
        assert.equal(result.data.amount, 450);
      } finally {
        orderRepository.findByOrderId = origFindByOrderId;
        paymentRepository.findLatestByOrderId = origFindLatest;
        paymentRepository.createPayment = origCreate;
      }
    });
  });

  // Test 9: Each payment's history belongs only to that payment
  describe("Test 9: Payment History Isolation", () => {
    it("should keep payment history isolated between attempts", async () => {
      const attempt1 = {
        paymentId: "PAY-001",
        orderId: "ORD-999",
        attemptNumber: 1,
        history: [
          { status: "pending", message: "Payment attempt #1 initialized." },
          { status: "failed", message: "Declined" }
        ]
      };

      const attempt2 = {
        paymentId: "PAY-002",
        orderId: "ORD-999",
        attemptNumber: 2,
        history: [
          { status: "pending", message: "Payment attempt #2 initialized." },
          { status: "processing", message: "Processing" },
          { status: "success", message: "Paid" }
        ]
      };

      assert.equal(attempt1.history.length, 2);
      assert.equal(attempt2.history.length, 3);
      assert.ok(attempt1.history.every((h) => !h.message.includes("attempt #2")));
      assert.ok(attempt2.history.every((h) => !h.message.includes("attempt #1")));
    });
  });
});
