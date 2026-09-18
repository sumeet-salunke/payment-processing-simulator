import paymentService from "../services/payment.service.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";

export const createPayment = asyncHandler(async (req, res) => {
  const { orderId } = req.body;
  const result = await paymentService.createPayment(orderId);
  res.status(201).json(new ApiResponse(201, result.message, result.data));
});
