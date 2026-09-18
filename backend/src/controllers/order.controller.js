import orderService from "../services/order.service.js";
import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";

export const createOrder = asyncHandler(async (req, res) => {
  const result = await orderService.createOrder(req.body);
  return res.status(201).json(new ApiResponse(201, result.message, result.data));
});