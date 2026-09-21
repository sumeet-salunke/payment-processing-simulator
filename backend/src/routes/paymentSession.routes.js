import express from "express";
import {
  getPaymentSession,
  payThroughSession
} from "../controllers/paymentSession.controller.js";
import {
  validateSessionIdParam,
  validatePayThroughSession
} from "../middlewares/validation.middleware.js";

const router = express.Router();

router.get("/:sessionId", validateSessionIdParam, getPaymentSession);
router.post("/:sessionId/pay", validatePayThroughSession, payThroughSession);

export default router;
