import Order from "../models/order.model.js";

class OrderRepository {
  async createOrder(data, session = null) {
    if (session) {
      const doc = new Order(data);
      return doc.save({ session });
    }
    return Order.create(data);
  }

  async findById(orderId, session = null) {
    const query = Order.findById(orderId);
    if (session) {
      query.session(session);
    }
    return query;
  }

  async findByOrderId(orderId, session = null) {
    const query = Order.findOne({ orderId });
    if (session) {
      query.session(session);
    }
    return query;
  }

  async updateOrderStatus(orderId, status, session = null) {
    const options = { returnDocument: "after" };
    if (session) {
      options.session = session;
    }

    return Order.findOneAndUpdate(
      { orderId },
      { $set: { status } },
      options
    );
  }
}

export default new OrderRepository();