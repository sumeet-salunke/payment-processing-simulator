export const PAYMENT_SESSION_STATUS = Object.freeze({
  ACTIVE: "active",
  EXPIRED: "expired",
  COMPLETED: "completed",
  CANCELLED: "cancelled"
});

// Default session expiration: 15 minutes (in milliseconds)
export const PAYMENT_SESSION_TTL_MS = 15 * 60 * 1000;
