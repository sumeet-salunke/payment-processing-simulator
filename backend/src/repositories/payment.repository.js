import Payment from "../models/payment.model.js";

class PaymentRepository {

  async createPayment(data) {
    return Payment.create(data);
  }

  async findByPaymentId(paymentId) {
    return Payment.findOne({ paymentId });
  }

  async updatePaymentStatus(paymentId, newStatus, historyEntry) {
    return Payment.findOneAndUpdate(
      { paymentId }, {
      $set: {
        status: newStatus
      }, $push: {
        history: historyEntry
      }
    }, {
      returnDocument: "after"
    }
    )
  }


}


export default new PaymentRepository();