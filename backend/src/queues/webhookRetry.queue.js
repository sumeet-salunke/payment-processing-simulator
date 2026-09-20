import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";

export const WEBHOOK_RETRY_QUEUE_NAME = "webhook-retry-queue";

export const webhookRetryQueue = new Queue(WEBHOOK_RETRY_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 1000,
    removeOnFail: 5000
  }
});

export const addWebhookRetryJob = async ({ eventId, paymentId }, delayMs = 0) => {
  const jobId = `retry-${eventId}-${Date.now()}`;
  console.log(
    `[WebhookQueue] Enqueued retry job for eventId=${eventId} paymentId=${paymentId} delay=${delayMs}ms jobId=${jobId}`
  );
  return webhookRetryQueue.add(
    "retry-webhook-event",
    { eventId, paymentId },
    {
      jobId,
      delay: Math.max(0, delayMs)
    }
  );
};
