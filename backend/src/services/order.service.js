import { generateOrderID } from "../helpers/generateOrderID.js";
import orderRepository from "../repositories/order.repository.js";
import ApiError from "../utils/ApiError.js";
import { ORDER_STATUS, ORDER_EXPIRY_MS } from "../constants/order.constants.js";
import paymentRepository from "../repositories/payment.repository.js";

class OrderService {
  async createOrder(data) {
    if (!data || !data.userId || !data.amount) {
      throw new ApiError(400, "Invalid order data: userId and amount are required");
    }

    const numAmount = Number(data.amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      throw new ApiError(400, "Invalid order amount: must be a positive number");
    }

    const orderId = generateOrderID();
    const expiresAt = new Date(Date.now() + ORDER_EXPIRY_MS);

    const order = await orderRepository.createOrder({
      orderId,
      userId: String(data.userId).trim(),
      amount: numAmount,
      status: ORDER_STATUS.PENDING,
      expiresAt
    });

    return {
      message: "Order Created successfully",
      data: order
    };
  }

  /**
   * Safely cancels a specific order if it has passed its expiration time,
   * provided it is still PENDING and has no in-flight PROCESSING payment attempt.
   */
  async checkAndCancelExpiredOrder(orderId) {
    const order = await orderRepository.findByOrderId(orderId);
    if (!order) return null;

    // Never cancel non-pending orders (e.g. PAID or CANCELLED)
    if (order.status !== ORDER_STATUS.PENDING) {
      return order;
    }

    // Check if expiration timestamp has passed
    if (!order.expiresAt || new Date() <= new Date(order.expiresAt)) {
      return order;
    }

    // Guard: Do not cancel if an attempt is currently in-flight PROCESSING
    const activeAttempt = await paymentRepository.findActiveAttemptByOrderId(orderId);
    if (activeAttempt) {
      console.log(`[OrderExpiration] Skipping cancellation for order ${orderId}: payment attempt ${activeAttempt.paymentId} is in-flight PROCESSING.`);
      return order;
    }

    // Atomically cancel
    const cancelledOrder = await orderRepository.cancelExpiredOrder(orderId);
    if (cancelledOrder) {
      console.log(`[OrderExpiration] Order ${orderId} has expired and was transitioned to CANCELLED.`);
    }
    return cancelledOrder || order;
  }

  /**
   * Sweeps and expires all stale PENDING orders whose expiresAt has passed,
   * skipping any with active in-flight processing payments.
   */
  async sweepExpiredOrders() {
    const expiredOrders = await orderRepository.findExpiredPendingOrders(new Date(), 50);
    const results = [];

    for (const order of expiredOrders) {
      const cancelled = await this.checkAndCancelExpiredOrder(order.orderId);
      if (cancelled?.status === ORDER_STATUS.CANCELLED) {
        results.push(order.orderId);
      }
    }

    return results;
  }
}

export default new OrderService();