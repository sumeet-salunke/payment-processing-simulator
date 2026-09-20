import ApiError from "../utils/ApiError.js";
import { generateWebhookSignature } from "../helpers/webhookSignature.js";
import { generateEventID } from "../helpers/generateEventID.js";
import failureSimulationService from "./failureSimulation.service.js";
import { FAILURE_MODES } from "../constants/failureSimulation.constants.js";

class PaymentProviderService {
  async processPayment(paymentId, result) {
    if (!paymentId) {
      throw new ApiError(400, "PaymentId required.");
    }
    if (!result) {
      throw new ApiError(400, "Provider result required");
    }
    if (result !== "success" && result !== "failed") {
      throw new ApiError(400, "Invalid provider result");
    }

    // Failure simulation hook: PROVIDER_FAILURE
    let effectiveResult = result;
    if (failureSimulationService.checkFailure(FAILURE_MODES.PROVIDER_FAILURE)) {
      console.warn(`[FailureSimulation] Injecting PROVIDER_FAILURE for paymentId=${paymentId}`);
      effectiveResult = "failed";
    }

    const eventId = generateEventID();

    if (effectiveResult === "success") {
      return {
        eventId,
        success: true,
        event: "payment.success",
        paymentId
      };
    }
    return {
      eventId,
      success: false,
      event: "payment.failed",
      paymentId
    };
  }

  async sendWebhook(event, paymentId, eventId = null) {
    // Failure simulation hook: WEBHOOK_FAILURE
    if (failureSimulationService.checkFailure(FAILURE_MODES.WEBHOOK_FAILURE)) {
      console.warn(`[FailureSimulation] Injecting WEBHOOK_FAILURE for eventId=${eventId}`);
      throw new ApiError(503, "Simulated webhook delivery network failure");
    }

    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) {
      throw new ApiError(500, "WEBHOOK_SECRET is not configured");
    }

    const resolvedEventId = eventId || generateEventID();
    const payload = JSON.stringify({
      eventId: resolvedEventId,
      event,
      paymentId
    });
    const signature = generateWebhookSignature(payload, secret);

    const port = Number(process.env.PORT ?? 5000);
    const webhookUrl = process.env.WEBHOOK_URL || `http://127.0.0.1:${port}/api/webhooks/payment`;

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-webhook-signature": signature
        },
        body: payload
      });

      const data = await response.json();
      if (!response.ok) {
        throw new ApiError(response.status, data.message || "Webhook delivery failed");
      }

      // Failure simulation hook: DUPLICATE_WEBHOOK
      if (failureSimulationService.checkFailure(FAILURE_MODES.DUPLICATE_WEBHOOK)) {
        console.warn(`[FailureSimulation] Injecting duplicate webhook delivery for eventId=${resolvedEventId}`);
        await fetch(webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-webhook-signature": signature
          },
          body: payload
        });
      }

      return data;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError(
        500,
        `Failed to deliver simulated webhook to ${webhookUrl}: ${error.message}`
      );
    }
  }
}

export default new PaymentProviderService();