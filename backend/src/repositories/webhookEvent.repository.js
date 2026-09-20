import WebhookEvent from "../models/webhookEvent.model.js";
import { WEBHOOK_EVENT_STATUS } from "../constants/webhookEvent.constants.js";

class WebhookEventRepository {
  async create(data, session = null) {
    if (session) {
      const doc = new WebhookEvent(data);
      return doc.save({ session });
    }
    return WebhookEvent.create(data);
  }

  async findByEventId(eventId, session = null) {
    const query = WebhookEvent.findOne({ eventId });
    if (session) {
      query.session(session);
    }
    return query;
  }

  async markProcessed(eventId, session = null) {
    const options = { returnDocument: "after" };
    if (session) {
      options.session = session;
    }

    return WebhookEvent.findOneAndUpdate(
      { eventId },
      {
        $set: {
          status: WEBHOOK_EVENT_STATUS.PROCESSED,
          processedAt: new Date(),
          errorMessage: null,
          nextRetryAt: null
        }
      },
      options
    );
  }

  async markFailed(eventId, errorMessage, nextRetryAt = null, session = null) {
    const options = { returnDocument: "after" };
    if (session) {
      options.session = session;
    }

    return WebhookEvent.findOneAndUpdate(
      { eventId },
      {
        $set: {
          status: WEBHOOK_EVENT_STATUS.FAILED,
          lastError: errorMessage,
          errorMessage,
          lastAttemptAt: new Date(),
          nextRetryAt
        },
        $inc: {
          attempts: 1
        }
      },
      options
    );
  }

  async markDead(eventId, errorMessage, session = null) {
    const options = { returnDocument: "after" };
    if (session) {
      options.session = session;
    }

    return WebhookEvent.findOneAndUpdate(
      { eventId },
      {
        $set: {
          status: WEBHOOK_EVENT_STATUS.DEAD,
          lastError: errorMessage,
          errorMessage,
          lastAttemptAt: new Date(),
          nextRetryAt: null
        },
        $inc: {
          attempts: 1
        }
      },
      options
    );
  }

  async updateStatus(eventId, currentStatus, newStatus, session = null) {
    const options = { returnDocument: "after" };
    if (session) {
      options.session = session;
    }

    return WebhookEvent.findOneAndUpdate(
      { eventId, status: currentStatus },
      { $set: { status: newStatus } },
      options
    );
  }
}

export default new WebhookEventRepository();
