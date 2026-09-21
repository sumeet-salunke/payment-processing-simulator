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

webhookRetryQueue.on("error", (err) => {
  // Gracefully log Redis connection error without crashing or throwing unhandled rejection
  console.warn(`[WebhookQueue] Queue warning/error (Redis status):`, err.message);
});

export const addWebhookRetryJob = async ({ eventId, paymentId }, delayMs = 0) => {
  const jobId = `retry-${eventId}-${Date.now()}`;
  console.log(
    `[WebhookQueue] Enqueued retry job for eventId=${eventId} paymentId=${paymentId} delay=${delayMs}ms jobId=${jobId}`
  );
  try {
    const enqueuePromise = webhookRetryQueue.add(
      "retry-webhook-event",
      { eventId, paymentId },
      {
        jobId,
        delay: Math.max(0, delayMs)
      }
    );
    // Timeout race: if Redis does not respond within 1500ms, fail gracefully without hanging process
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Redis connection timeout")), 1500)
    );
    return await Promise.race([enqueuePromise, timeoutPromise]);
  } catch (queueErr) {
    console.warn(`[WebhookQueue] Failed to enqueue retry job (Redis unavailable):`, queueErr.message);
    return null;
  }
};
