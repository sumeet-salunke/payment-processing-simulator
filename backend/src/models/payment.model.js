import mongoose from "mongoose";
import { PAYMENT_STATUS } from "../constants/payment.constants.js";

const paymentSchema = new mongoose.Schema({
  paymentId: {
    type: String,
    required: true,
    unique: true,
  },
  orderId: {
    type: String,
    required: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  status: {
    type: String,
    enum: Object.values(PAYMENT_STATUS),
    default: PAYMENT_STATUS.PENDING,
  },
  history: [{
    status: String,
    message: String,
    timestamp: Date
  }]

}, { timestamps: true });

const Payment = mongoose.model("Payment", paymentSchema);

export default Payment;