import paymentRepository from "../repositories/payment.repository.js";
import ApiError from "../utils/ApiError.js";
import orderRepository from "../repositories/order.repository.js";
import { generatePaymentID } from "../helpers/generatePaymentID.js";
import { PAYMENT_STATUS } from "../constants/payment.constants.js";

class PaymentService {
  async createPayment(orderId) {
    if (!orderId) {
      throw new ApiError(400, "Invalid orderId");
    }
    const order = await orderRepository.findByOrderId(orderId);
    if (!order) {
      throw new ApiError(404, "Order does not exists");
    }
    const paymentId = generatePaymentID();
    const payment = await paymentRepository.createPayment({
      paymentId,
      orderId,
      amount: order.amount,
      status: PAYMENT_STATUS.PENDING,
      history: [{
        status: PAYMENT_STATUS.PENDING,
        message: "Payment Initialized.",
        timestamp: new Date()
      }]

    })
    return {
      message: "Payment created successfully",
      data: payment
    }

  }

}

export default new PaymentService();