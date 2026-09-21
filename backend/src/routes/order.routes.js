import express from "express";
import { createOrder, getOrderPayments } from "../controllers/order.controller.js";
import { createPaymentSession } from "../controllers/paymentSession.controller.js";
import {
  validateCreateOrder,
  validateOrderIdParam
} from "../middlewares/validation.middleware.js";

const router = express.Router();

router.post("/", validateCreateOrder, createOrder);
router.get("/:orderId/payments", validateOrderIdParam, getOrderPayments);
router.post("/:orderId/payment-session", validateOrderIdParam, createPaymentSession);

export default router;