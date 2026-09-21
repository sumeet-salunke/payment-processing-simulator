import "dotenv/config";
import "../src/config/dns.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import app from "../src/app.js";
import orderService from "../src/services/order.service.js";
import paymentService from "../src/services/payment.service.js";
import Order from "../src/models/order.model.js";
import Payment from "../src/models/payment.model.js";
import { ORDER_STATUS } from "../src/constants/order.constants.js";
import { PAYMENT_STATUS } from "../src/constants/payment.constants.js";

await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/payment_simulator");

describe("Phase 15: Production Hardening & Reliability Tests", () => {
  let server;
  let baseUrl;

  before(async () => {
    await new Promise((resolve, reject) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
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
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
    }
  });

  describe("In-Flight Payment Attempt Overlap Protection", () => {
    test("Attempt 1 PROCESSING blocks Attempt 2 creation with 409 Conflict", async () => {
      const order = await orderService.createOrder({ userId: "user-overlap-1", amount: 150 });
      const orderId = order.data.orderId;

      // Create Attempt 1 and move it to PROCESSING
      const attempt1 = await paymentService.createPayment(orderId);
      await Payment.updateOne(
        { paymentId: attempt1.data.paymentId },
        { $set: { status: PAYMENT_STATUS.PROCESSING } }
      );

      // Attempt 2 creation while Attempt 1 is PROCESSING must throw 409
      await assert.rejects(
        async () => {
          await paymentService.createPayment(orderId);
        },
        (err) => {
          assert.equal(err.statusCode, 409);
          assert.match(err.message, /currently processing/i);
          return true;
        }
      );
    });

    test("Failed Attempt 1 allows Attempt 2 to be created", async () => {
      const order = await orderService.createOrder({ userId: "user-overlap-2", amount: 200 });
      const orderId = order.data.orderId;

      // Create Attempt 1
      const attempt1 = await paymentService.createPayment(orderId);

      // Transition Attempt 1 to FAILED
      await Payment.updateOne(
        { paymentId: attempt1.data.paymentId },
        { $set: { status: PAYMENT_STATUS.FAILED } }
      );

      // Attempt 2 should now succeed and receive attemptNumber: 2
      const attempt2 = await paymentService.createPayment(orderId);
      assert.equal(attempt2.data.status, PAYMENT_STATUS.PENDING);
      assert.equal(attempt2.data.attemptNumber, 2);
    });

    test("Successful Attempt 1 blocks further payment attempts", async () => {
      const order = await orderService.createOrder({ userId: "user-overlap-3", amount: 300 });
      const orderId = order.data.orderId;

      const attempt1 = await paymentService.createPayment(orderId);

      // Transition Attempt 1 to SUCCESS and Order to PAID
      await Payment.updateOne(
        { paymentId: attempt1.data.paymentId },
        { $set: { status: PAYMENT_STATUS.SUCCESS } }
      );
      await Order.updateOne(
        { orderId },
        { $set: { status: ORDER_STATUS.PAID } }
      );

      // Attempt 2 creation must be rejected because order is already PAID
      await assert.rejects(
        async () => {
          await paymentService.createPayment(orderId);
        },
        (err) => {
          assert.equal(err.statusCode, 409);
          assert.match(err.message, /already paid/i);
          return true;
        }
      );
    });
  });

  describe("Order Expiration Lifecycle & Background Sweeper", () => {
    test("Expired PENDING order is safely cancelled by sweeper", async () => {
      const order = await orderService.createOrder({ userId: "user-exp-1", amount: 99 });
      const orderId = order.data.orderId;

      // Manually backdate expiresAt into the past
      await Order.updateOne(
        { orderId },
        { $set: { expiresAt: new Date(Date.now() - 60000) } }
      );

      // Trigger the background sweeper
      const cancelledList = await orderService.sweepExpiredOrders();
      assert.ok(Array.isArray(cancelledList));
      assert.ok(cancelledList.includes(orderId), "Expired order should be in cancelled list");

      // Verify order status in database is CANCELLED
      const updatedOrder = await Order.findOne({ orderId });
      assert.equal(updatedOrder.status, ORDER_STATUS.CANCELLED);
    });

    test("Expired order with active PROCESSING payment is NOT cancelled", async () => {
      const order = await orderService.createOrder({ userId: "user-exp-2", amount: 250 });
      const orderId = order.data.orderId;

      // Create an in-flight payment attempt and set to PROCESSING
      const attempt = await paymentService.createPayment(orderId);
      await Payment.updateOne(
        { paymentId: attempt.data.paymentId },
        { $set: { status: PAYMENT_STATUS.PROCESSING } }
      );

      // Manually backdate expiresAt into the past
      await Order.updateOne(
        { orderId },
        { $set: { expiresAt: new Date(Date.now() - 60000) } }
      );

      // Trigger sweeper
      await orderService.sweepExpiredOrders();

      // Verify order is STILL PENDING because a payment is actively processing
      const currentOrder = await Order.findOne({ orderId });
      assert.equal(currentOrder.status, ORDER_STATUS.PENDING);
    });

    test("PAID order is NEVER cancelled by expiration sweeper", async () => {
      const order = await orderService.createOrder({ userId: "user-exp-3", amount: 450 });
      const orderId = order.data.orderId;

      // Mark order as PAID
      await Order.updateOne(
        { orderId },
        { $set: { status: ORDER_STATUS.PAID, expiresAt: new Date(Date.now() - 60000) } }
      );

      // Trigger sweeper
      await orderService.sweepExpiredOrders();

      // Verify order remains PAID
      const currentOrder = await Order.findOne({ orderId });
      assert.equal(currentOrder.status, ORDER_STATUS.PAID);
    });
  });

  describe("Request Validation Middleware & Error Standardization", () => {
    test("Create order rejects non-numeric or negative amount with 400", async () => {
      const response = await fetch(`${baseUrl}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user-val-1", amount: -50 })
      });

      assert.equal(response.status, 400);
      const data = await response.json();
      assert.equal(data.success, false);
      assert.equal(data.error.code, "BAD_REQUEST");
      assert.match(data.error.message, /positive/i);
    });

    test("Create payment rejects missing or empty orderId with 400", async () => {
      const response = await fetch(`${baseUrl}/api/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });

      assert.equal(response.status, 400);
      const data = await response.json();
      assert.equal(data.success, false);
      assert.equal(data.error.code, "BAD_REQUEST");
    });

    test("Non-existent order returns 404 when creating payment session", async () => {
      const response = await fetch(`${baseUrl}/api/orders/ORD-NONEXISTENT-999/payment-session`, {
        method: "POST"
      });

      assert.equal(response.status, 404);
      const data = await response.json();
      assert.equal(data.success, false);
      assert.equal(data.error.code, "NOT_FOUND");
    });
  });

  describe("Health & System Diagnostics", () => {
    test("Health check reports database status and uptime without exposing secrets", async () => {
      const response = await fetch(`${baseUrl}/api/health`);
      assert.equal(response.status, 200);

      const data = await response.json();
      assert.equal(data.success, true);
      assert.equal(data.status, "healthy");
      assert.equal(data.services.database, "connected");
      assert.ok(typeof data.uptime === "number");
      assert.ok(!data.mongoUri);
      assert.ok(!data.webhookSecret);
    });
  });
});
