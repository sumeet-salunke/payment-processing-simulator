import { generateOrderID } from "../helpers/generateOrderID.js";
import orderRepository from "../repositories/order.repository.js";
import ApiError from "../utils/ApiError.js";
import { ORDER_STATUS } from "../constants/order.constants.js";

class OrderService {
  async createOrder(data) {
    if (!data || !data.userId || !data.amount) {
      throw new ApiError(400, "Invalid order data");
    }
    const orderId = generateOrderID();

    const order = await orderRepository.createOrder({
      orderId,
      userId: data.userId,
      amount: data.amount,
      status: ORDER_STATUS.PENDING,
    });
    return {
      message: "Order Created successfully",
      data: order
    };
  }

}

export default new OrderService();