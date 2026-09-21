import express from "express";
import {
  getPaymentSession,
  payThroughSession
} from "../controllers/paymentSession.controller.js";

const router = express.Router();

router.get("/:sessionId", getPaymentSession);
router.post("/:sessionId/pay", payThroughSession);

export default router;
