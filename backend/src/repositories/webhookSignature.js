import crypto from "crypto";

export const generateWebhookSignature = (payload, secret) => {
  return crypto.createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("hex");
};

export const verifyWebhookSignature = (payload, secret, receivedSignature) => {
  if (!receivedSignature) {
    return false;
  }
  const expectedSignature = generateWebhookSignature(payload, secret);

  const expectedBuffer = Buffer.from(expectedSignature, "hex");

  const receivedBuffer = Buffer.from(receivedSignature, "hex");

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}