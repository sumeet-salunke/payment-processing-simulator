import crypto from "crypto";

export const generateSessionID = () => {
  return `SESSION-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
};
