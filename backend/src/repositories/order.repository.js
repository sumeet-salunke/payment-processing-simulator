import Order from "../models/order.model.js";

class OrderRepository {

  async createOrder(data) {
    return Order.create(data);
  }

  async findById(orderId) {
    return Order.findById(orderId);
  }

  async findByOrderId(orderId) {
    return Order.findOne({ orderId });
  }

}

export default new OrderRepository();