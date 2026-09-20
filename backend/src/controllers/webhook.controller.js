import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
import ApiError from "../utils/ApiError.js";
import { verifyWebhookSignature } from "../helpers/webhookSignature.js";
import paymentWebhookService from "../services/paymentWebhook.service.js";

export const handlePaymentWebhook = asyncHandler(async (req, res) => {
  const signature = req.headers["x-webhook-signature"];
  if (!signature) {
    throw new ApiError(401, "Webhook signature missing");
  }

  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    throw new ApiError(500, "WEBHOOK_SECRET is not configured");
  }

  const payload = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body);
  const isValid = verifyWebhookSignature(payload, secret, signature);
  if (!isValid) {
    throw new ApiError(401, "Invalid webhook signature");
  }

  const { eventId, event, paymentId } = req.body || {};

  if (!eventId) {
    throw new ApiError(400, "Missing eventId in webhook payload");
  }

  if (!event || (event !== "payment.success" && event !== "payment.failed")) {
    throw new ApiError(400, "Invalid or unsupported webhook event");
  }

  if (!paymentId) {
    throw new ApiError(400, "Missing paymentId in webhook payload");
  }

  const result = await paymentWebhookService.processWebhookEvent({
    eventId,
    event,
    paymentId
  });

  const responseMessage = result.alreadyProcessed
    ? "Webhook event already processed"
    : "Webhook processed successfully";

  return res.status(200).json(new ApiResponse(200, responseMessage, result));
});