import Order from "../models/order.model.js";

class OrderRepository {

  async createOrder(data) {
    return Order.create(data);
  }


}

export default new OrderRepository();