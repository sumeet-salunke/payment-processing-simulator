import express from "express";
import { createOrder, getOrderPayments } from "../controllers/order.controller.js";

const router = express.Router();

router.post("/", createOrder);
router.get("/:orderId/payments", getOrderPayments);

export default router;