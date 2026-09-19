import paymentRepository from "../repositories/payment.repository.js";
import ApiError from "../utils/ApiError.js";
import orderRepository from "../repositories/order.repository.js";
import { generatePaymentID } from "../helpers/generatePaymentID.js";
import { PAYMENT_STATUS } from "../constants/payment.constants.js";
import { canTransition } from "../helpers/paymentStateMachine.js";
import { PAYMENT_TRANSITIONS } from "../constants/payment.transition.js";


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

  async updatePaymentStatus(paymentId, newStatus, historyEntry) {
    const updatedPayment =
      await paymentRepository.updatePaymentStatus(
        paymentId,
        newStatus,
        historyEntry
      );

    if (!updatedPayment) {
      throw new ApiError(500, "Failed to update payment");
    }

    return {
      message: "Payment status updated successfully.",
      data: updatedPayment
    };
  }

  async processPayment(paymentId) {
    if (!paymentId) {
      throw new ApiError(400, "PaymentId required");
    }

    const payment = await paymentRepository.findByPaymentId(paymentId);

    if (!payment) {
      throw new ApiError(404, "Payment not found");
    }

    const canTransit = canTransition(
      payment.status,
      PAYMENT_STATUS.PROCESSING
    );

    if (!canTransit) {
      throw new ApiError(
        400,
        `Cannot process payment from ${payment.status} state`
      );
    }

    return this.updatePaymentStatus(
      paymentId,
      PAYMENT_STATUS.PROCESSING,
      {
        status: PAYMENT_STATUS.PROCESSING,
        message: "Payment processing initialized.",
        timestamp: new Date()
      }
    );
  }

}

export default new PaymentService();