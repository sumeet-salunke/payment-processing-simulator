import "dotenv/config";
import { generateWebhookSignature } from "./src/helpers/webhookSignature.js";

const payload = JSON.stringify({
  eventId: "evt-6815098FF9BFE9E9",
  event: "payment.success",
  paymentId: "PAYMENT-6815098FF9BFE9E9"
});

const signature = generateWebhookSignature(
  payload,
  process.env.WEBHOOK_SECRET
);

console.log(signature);