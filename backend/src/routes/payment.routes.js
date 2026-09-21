import express from "express";
import { createPayment, processPayment } from "../controllers/payment.controller.js";
import {
  validateCreatePayment,
  validateProcessPayment
} from "../middlewares/validation.middleware.js";

const router = express.Router();

router.post("/", validateCreatePayment, createPayment);
router.post("/:paymentId/process", validateProcessPayment, processPayment);

export default router;