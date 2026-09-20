import { Worker } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { WEBHOOK_RETRY_QUEUE_NAME } from "../queues/webhookRetry.queue.js";
import paymentWebhookService from "../services/paymentWebhook.service.js";

export const createWebhookRetryWorker = () => {
  const worker = new Worker(
    WEBHOOK_RETRY_QUEUE_NAME,
    async (job) => {
      const { eventId, paymentId } = job.data;
      console.log(
        `[WebhookWorker] Processing retry job id=${job.id} for eventId=${eventId} paymentId=${paymentId} (attempt ${job.attemptsMade + 1})`
      );

      return paymentWebhookService.retryWebhookEvent({ eventId, paymentId });
    },
    {
      connection: redisConnection,
      concurrency: 5 // Process up to 5 retries concurrently
    }
  );

  worker.on("completed", (job) => {
    console.log(
      `[WebhookWorker] Job id=${job.id} eventId=${job.data?.eventId} completed successfully.`
    );
  });

  worker.on("failed", (job, err) => {
    console.error(
      `[WebhookWorker] Job id=${job?.id} eventId=${job?.data?.eventId} failed: ${err.message}`
    );
  });

  worker.on("error", (err) => {
    console.error(`[WebhookWorker] Worker error:`, err.message);
  });

  return worker;
};

export const webhookRetryWorker = createWebhookRetryWorker();
