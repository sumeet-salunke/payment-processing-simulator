import paymentService from "../services/payment.service.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import failureSimulationService from "../services/failureSimulation.service.js";
import idempotencyService from "../services/idempotency.service.js";
import { FAILURE_MODES } from "../constants/failureSimulation.constants.js";

export const createPayment = asyncHandler(async (req, res) => {
  const { orderId, amount } = req.body;
  const result = await paymentService.createPayment(orderId, amount);
  res.status(201).json(new ApiResponse(201, result.message, result.data));
});

export const processPayment = asyncHandler(async (req, res) => {
  const { paymentId } = req.params;
  const { result } = req.body || {};
  const idempotencyKey = req.headers["idempotency-key"] || req.headers["Idempotency-Key"];

  const executionResult = await idempotencyService.processWithIdempotency(
    {
      key: idempotencyKey,
      paymentId,
      endpoint: `/api/payments/${paymentId}/process`,
      body: req.body
    },
    async () => {
      const serviceResult = await paymentService.processPayment(paymentId, result);

      // Failure simulation hook: NETWORK_RESPONSE_LOST
      // Payment succeeds in DB and response is cached, but network socket is destroyed before sending to client
      if (failureSimulationService.checkFailure(FAILURE_MODES.NETWORK_RESPONSE_LOST, req)) {
        console.warn(`[FailureSimulation] Injecting NETWORK_RESPONSE_LOST for paymentId=${paymentId}. Destroying socket.`);
        req.socket.destroy();
        return serviceResult;
      }

      return serviceResult;
    }
  );

  if (req.socket?.destroyed) {
    return;
  }

  return res.status(executionResult.statusCode).json(executionResult.response);
});