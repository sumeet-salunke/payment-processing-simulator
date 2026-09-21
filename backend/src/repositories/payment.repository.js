import mongoose from "mongoose";
import Payment from "../models/payment.model.js";

class PaymentRepository {
  async createPayment(data, session = null) {
    if (session) {
      const doc = new Payment(data);
      return doc.save({ session });
    }
    return Payment.create(data);
  }

  async findByPaymentId(paymentId, session = null) {
    const query = Payment.findOne({ paymentId });
    if (session) {
      query.session(session);
    }
    return query;
  }

  async updatePaymentStatus(paymentId, currentStatus, newStatus, historyEntry, session = null) {
    const options = { returnDocument: "after" };
    if (session) {
      options.session = session;
    }

    return Payment.findOneAndUpdate(
      {
        paymentId,
        status: currentStatus
      },
      {
        $set: {
          status: newStatus
        },
        $push: {
          history: historyEntry
        }
      },
      options
    );
  }

  async findLatestByOrderId(orderId, session = null) {
    if (mongoose.connection.readyState !== 1) {
      return null;
    }
    const query = Payment.findOne({ orderId }).sort({ attemptNumber: -1, createdAt: -1 });
    if (session) {
      query.session(session);
    }
    return query;
  }

  async findByOrderId(orderId, session = null) {
    const query = Payment.find({ orderId })
      .sort({ attemptNumber: 1, createdAt: 1 })
      .select("paymentId orderId attemptNumber amount status history createdAt updatedAt -_id");
    if (session) {
      query.session(session);
    }
    return query;
  }
  async findActiveAttemptByOrderId(orderId, session = null) {
    if (mongoose.connection.readyState !== 1) {
      return null;
    }
    const query = Payment.findOne({
      orderId,
      status: "processing"
    });
    if (session) {
      query.session(session);
    }
    return query;
  }
}

export default new PaymentRepository();