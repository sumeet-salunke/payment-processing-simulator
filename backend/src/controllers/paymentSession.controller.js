import paymentSessionService from "../services/paymentSession.service.js";
import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";

export const createPaymentSession = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const result = await paymentSessionService.createPaymentSession(orderId);
  return res.status(201).json(new ApiResponse(201, result.message, result.data));
});

export const getPaymentSession = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const result = await paymentSessionService.getPaymentSession(sessionId);
  return res.status(200).json(new ApiResponse(200, result.message, result.data));
});

export const payThroughSession = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { result } = req.body || {};
  const idempotencyKey = req.headers["idempotency-key"] || req.headers["Idempotency-Key"];
  const executionResult = await paymentSessionService.payThroughSession(sessionId, {
    result,
    idempotencyKey
  });
  return res.status(200).json(new ApiResponse(200, executionResult.message, executionResult.data));
});
