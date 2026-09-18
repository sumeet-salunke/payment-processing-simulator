import crypto from "crypto";

export const generateOrderID = () => {
  return `ORD-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
};

