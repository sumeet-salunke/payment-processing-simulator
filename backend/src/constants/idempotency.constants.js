export const IDEMPOTENCY_STATUS = Object.freeze({
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed"
});

export const IDEMPOTENCY_HEADER = "idempotency-key";

// 24 hours TTL retention for idempotency records
export const IDEMPOTENCY_EXPIRY_MS = 24 * 60 * 60 * 1000;
