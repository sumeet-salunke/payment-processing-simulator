import Payment from "../models/payment.model.js";

class PaymentRepository {

  async createPayment(data) {
    return Payment.create(data);
  }


}


export default new PaymentRepository();