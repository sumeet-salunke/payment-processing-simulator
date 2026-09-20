import IdempotencyKey from "../models/idempotencyKey.model.js";
import { IDEMPOTENCY_STATUS } from "../constants/idempotency.constants.js";

class IdempotencyKeyRepository {
  async create(data, session = null) {
    if (session) {
      const doc = new IdempotencyKey(data);
      return doc.save({ session });
    }
    return IdempotencyKey.create(data);
  }

  async findByKey(key, session = null) {
    const query = IdempotencyKey.findOne({ key });
    if (session) {
      query.session(session);
    }
    return query;
  }

  async markCompleted(key, { statusCode, response }, session = null) {
    const options = { returnDocument: "after" };
    if (session) {
      options.session = session;
    }

    return IdempotencyKey.findOneAndUpdate(
      { key },
      {
        $set: {
          status: IDEMPOTENCY_STATUS.COMPLETED,
          statusCode,
          response,
          errorMessage: null
        }
      },
      options
    );
  }

  async markFailed(key, errorMessage, session = null) {
    const options = { returnDocument: "after" };
    if (session) {
      options.session = session;
    }

    return IdempotencyKey.findOneAndUpdate(
      { key },
      {
        $set: {
          status: IDEMPOTENCY_STATUS.FAILED,
          errorMessage
        }
      },
      options
    );
  }

  async updateStatus(key, currentStatus, newStatus, session = null) {
    const options = { returnDocument: "after" };
    if (session) {
      options.session = session;
    }

    return IdempotencyKey.findOneAndUpdate(
      { key, status: currentStatus },
      { $set: { status: newStatus } },
      options
    );
  }
}

export default new IdempotencyKeyRepository();
