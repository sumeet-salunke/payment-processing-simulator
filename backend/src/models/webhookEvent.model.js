import mongoose from "mongoose";
import { WEBHOOK_EVENT_STATUS } from "../constants/webhookEvent.constants.js";
import { RETRY_POLICY } from "../config/retryPolicy.js";

const webhookEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    event: {
      type: String,
      required: true
    },
    paymentId: {
      type: String,
      required: true,
      index: true
    },
    status: {
      type: String,
      enum: Object.values(WEBHOOK_EVENT_STATUS),
      default: WEBHOOK_EVENT_STATUS.PROCESSING,
      required: true
    },
    processedAt: {
      type: Date,
      default: null
    },
    attempts: {
      type: Number,
      default: 0
    },
    maxAttempts: {
      type: Number,
      default: RETRY_POLICY.MAX_ATTEMPTS
    },
    lastAttemptAt: {
      type: Date,
      default: null
    },
    nextRetryAt: {
      type: Date,
      default: null
    },
    lastError: {
      type: String,
      default: null
    }
  },
  { timestamps: true }
);

const WebhookEvent = mongoose.model("WebhookEvent", webhookEventSchema);

export default WebhookEvent;
