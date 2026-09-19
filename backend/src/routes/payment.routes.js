import express from "express";
import { createPayment, processPayment } from "../controllers/payment.controller.js";

const router = express.Router();




router.post("/", createPayment);

router.post("/:paymentId/process", processPayment);



export default router;