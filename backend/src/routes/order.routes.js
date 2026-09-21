import express from "express";
import { createOrder, getOrderPayments } from "../controllers/order.controller.js";
import { createPaymentSession } from "../controllers/paymentSession.controller.js";

const router = express.Router();

router.post("/", createOrder);
router.get("/:orderId/payments", getOrderPayments);
router.post("/:orderId/payment-session", createPaymentSession);

export default router;