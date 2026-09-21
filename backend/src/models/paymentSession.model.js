import mongoose from "mongoose";
import { PAYMENT_SESSION_STATUS } from "../constants/paymentSession.constants.js";

const paymentSessionSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },
    orderId: {
      type: String,
      required: true,
      index: true
    },
    status: {
      type: String,
      enum: Object.values(PAYMENT_SESSION_STATUS),
      default: PAYMENT_SESSION_STATUS.ACTIVE,
      index: true
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true
    }
  },
  { timestamps: true }
);

const PaymentSession = mongoose.model("PaymentSession", paymentSessionSchema);

export default PaymentSession;
