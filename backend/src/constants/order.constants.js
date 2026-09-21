export const ORDER_STATUS = Object.freeze({
  PENDING: "pending",
  CONFIRMED: "confirmed",
  CANCELLED: "cancelled",
  PAID: "paid"
});

// Default order expiration: 30 minutes (in milliseconds)
export const ORDER_EXPIRY_MS = 30 * 60 * 1000;