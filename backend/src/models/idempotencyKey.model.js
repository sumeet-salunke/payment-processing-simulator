import mongoose from "mongoose";
import { IDEMPOTENCY_STATUS } from "../constants/idempotency.constants.js";

const idempotencyKeySchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    paymentId: {
      type: String,
      required: true,
      index: true
    },
    requestFingerprint: {
      type: String,
      required: true
    },
    status: {
      type: String,
      enum: Object.values(IDEMPOTENCY_STATUS),
      default: IDEMPOTENCY_STATUS.PROCESSING,
      required: true
    },
    statusCode: {
      type: Number,
      default: null
    },
    response: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },
    errorMessage: {
      type: String,
      default: null
    },
    expiresAt: {
      type: Date,
      required: true
    }
  },
  { timestamps: true }
);

// MongoDB TTL index to automatically expire records when expiresAt is reached
idempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const IdempotencyKey = mongoose.model("IdempotencyKey", idempotencyKeySchema);

export default IdempotencyKey;
