import crypto from "crypto";

export const generateRequestFingerprint = ({ paymentId, endpoint = "/api/payments/process", body = {} }) => {
  const normalizedData = {
    paymentId: String(paymentId),
    endpoint: String(endpoint),
    result: body?.result || "success"
  };

  return crypto
    .createHash("sha256")
    .update(JSON.stringify(normalizedData))
    .digest("hex");
};
