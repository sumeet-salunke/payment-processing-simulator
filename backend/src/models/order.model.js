import mongoose from "mongoose";
import { ORDER_STATUS } from "../constants/order.constants.js";
const orderSchema = new mongoose.Schema({
  orderId: {
    type: String,
    required: true,
    unique: true,
  },
  userId: {
    type: String,
    required: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  status: {
    type: String,
    enum: Object.values(ORDER_STATUS),
    required: true,
    default: ORDER_STATUS.PENDING,
    index: true
  },
  expiresAt: {
    type: Date,
    default: null,
    index: true
  }
}, { timestamps: true });

const Order = mongoose.model("Order", orderSchema);

export default Order;