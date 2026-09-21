import PaymentSession from "../models/paymentSession.model.js";

class PaymentSessionRepository {
  async createSession(data, session = null) {
    if (session) {
      const doc = new PaymentSession(data);
      return doc.save({ session });
    }
    return PaymentSession.create(data);
  }

  async findBySessionId(sessionId, session = null) {
    const query = PaymentSession.findOne({ sessionId });
    if (session) {
      query.session(session);
    }
    return query;
  }

  async findByOrderId(orderId, session = null) {
    const query = PaymentSession.find({ orderId }).sort({ createdAt: -1 });
    if (session) {
      query.session(session);
    }
    return query;
  }

  async updateStatus(sessionId, status, session = null) {
    const options = { returnDocument: "after" };
    if (session) {
      options.session = session;
    }
    return PaymentSession.findOneAndUpdate(
      { sessionId },
      { $set: { status } },
      options
    );
  }

  async completeActiveSessionsForOrder(orderId, session = null) {
    const options = {};
    if (session) {
      options.session = session;
    }
    return PaymentSession.updateMany(
      { orderId, status: "active" },
      { $set: { status: "completed" } },
      options
    );
  }
}

export default new PaymentSessionRepository();
