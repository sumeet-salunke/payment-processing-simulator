import assert from "node:assert/strict";
import { PAYMENT_STATUS } from "../constants/payment.constants.js";
import { ORDER_STATUS } from "../constants/order.constants.js";

/**
 * Validates core business invariants against the state of Order, Payments, and WebhookEvents.
 * 
 * @param {Object} context
 * @param {Object} context.order - The order document
 * @param {Array<Object>} context.payments - All payment attempt documents for this order
 * @param {Array<Object>} [context.webhookEvents] - Webhook events associated with this order's payments
 */
export const assertPaymentSystemConsistency = ({ order, payments = [], webhookEvents = [] }) => {
  assert.ok(order, "Invariant assertion failed: Order document must be provided");
  assert.ok(Array.isArray(payments), "Invariant assertion failed: Payments must be an array");

  // Invariant 1 & 2: Successful payment and Paid order synchronization
  const hasSuccessfulPayment = payments.some((p) => p.status === PAYMENT_STATUS.SUCCESS);
  if (hasSuccessfulPayment) {
    assert.equal(
      order.status,
      ORDER_STATUS.PAID,
      `Invariant 1 Violated: Found successful payment for order ${order.orderId}, but order status is '${order.status}' (expected '${ORDER_STATUS.PAID}')`
    );
  }

  if (order.status === ORDER_STATUS.PAID) {
    assert.ok(
      hasSuccessfulPayment,
      `Invariant 2 Violated: Order ${order.orderId} is PAID, but no payment attempt has status '${PAYMENT_STATUS.SUCCESS}'`
    );
  }

  // Invariant 3: Failed payments cannot mark order PAID unless another attempt succeeded
  const onlyFailedOrPending = payments.length > 0 && payments.every((p) => p.status === PAYMENT_STATUS.FAILED || p.status === PAYMENT_STATUS.PENDING);
  if (onlyFailedOrPending) {
    assert.notEqual(
      order.status,
      ORDER_STATUS.PAID,
      `Invariant 3 Violated: Order ${order.orderId} is PAID, but all payment attempts are failed or pending`
    );
  }

  // Invariant 4: Payment amounts must equal authoritative Order amount
  for (const payment of payments) {
    assert.equal(
      payment.amount,
      order.amount,
      `Invariant 4 Violated: Payment ${payment.paymentId} amount (${payment.amount}) does not match order amount (${order.amount})`
    );
  }

  // Invariant 5: Attempt number uniqueness per order
  const attemptNumbers = payments.map((p) => p.attemptNumber).filter((n) => n !== undefined && n !== null);
  const uniqueAttemptNumbers = new Set(attemptNumbers);
  assert.equal(
    attemptNumbers.length,
    uniqueAttemptNumbers.size,
    `Invariant 5 Violated: Duplicate attempt numbers found for order ${order.orderId}: [${attemptNumbers.join(", ")}]`
  );

  // Invariant 9: Payment history isolation
  for (const payment of payments) {
    if (Array.isArray(payment.history)) {
      for (const entry of payment.history) {
        if (entry.message && entry.message.includes("attempt #")) {
          assert.match(
            entry.message,
            new RegExp(`attempt #${payment.attemptNumber}`, "i"),
            `History Isolation Violated: Payment ${payment.paymentId} (attempt #${payment.attemptNumber}) contains foreign history message: "${entry.message}"`
          );
        }
      }
    }
  }
};
