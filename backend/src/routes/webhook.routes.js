import express from "express";
import { handlePaymentWebhook } from "../controllers/webhook.controller.js";

const router = express.Router();

router.post("/payment", handlePaymentWebhook);

export default router;