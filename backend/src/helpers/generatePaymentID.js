import crypto from "crypto";

export const generatePaymentID = () => {
  return `PAYMENT-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
}