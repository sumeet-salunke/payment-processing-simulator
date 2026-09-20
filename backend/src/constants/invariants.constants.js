/**
 * Core Business Invariants for Payment Processing Simulator
 */
export const BUSINESS_INVARIANTS = Object.freeze({
  INVARIANT_1_SUCCESSFUL_PAYMENT: "If Payment is SUCCESS, its corresponding Order must eventually be PAID.",
  INVARIANT_2_PAID_ORDER: "If Order is PAID, there must exist at least one successful Payment attempt for that order.",
  INVARIANT_3_FAILED_PAYMENT: "If Payment is FAILED, the Order must NOT automatically become PAID.",
  INVARIANT_4_PAYMENT_AMOUNT: "Every Payment amount must equal the authoritative amount stored on its Order.",
  INVARIANT_5_ATTEMPT_UNIQUENESS: "For a given order, (orderId, attemptNumber) must always be strictly unique.",
  INVARIANT_6_WEBHOOK_IDEMPOTENCY: "Processing the same webhook eventId multiple times must not execute the business transition multiple times.",
  INVARIANT_7_CLIENT_IDEMPOTENCY: "Repeating the same client request with the same Idempotency-Key must not create duplicate payment attempts or provider calls.",
  INVARIANT_8_TRANSACTION_ATOMICITY: "Payment, Order, and WebhookEvent updates must be atomic; any failure must rollback all changes."
});
