import paymentSessionRepository from "../repositories/paymentSession.repository.js";
import orderRepository from "../repositories/order.repository.js";
import paymentRepository from "../repositories/payment.repository.js";
import paymentService from "./payment.service.js";
import idempotencyService from "./idempotency.service.js";
import ApiError from "../utils/ApiError.js";
import { generateSessionID } from "../helpers/generateSessionID.js";
import {
  PAYMENT_SESSION_STATUS,
  PAYMENT_SESSION_TTL_MS
} from "../constants/paymentSession.constants.js";
import { ORDER_STATUS } from "../constants/order.constants.js";

class PaymentSessionService {
  /**
   * Helper to build the configurable public payment URL for QR payload
   */
  getQrPayload(sessionId) {
    const baseUrl = process.env.PUBLIC_FRONTEND_URL || process.env.FRONTEND_URL || "http://127.0.0.1:5173";
    const cleanBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    return `${cleanBase}/payment/${sessionId}`;
  }

  /**
   * Check if a session has passed its expiration time and mark it EXPIRED if still ACTIVE
   */
  async checkAndSyncExpiration(session) {
    if (!session) return session;

    if (
      session.status === PAYMENT_SESSION_STATUS.ACTIVE &&
      session.expiresAt &&
      new Date() > new Date(session.expiresAt)
    ) {
      session = await paymentSessionRepository.updateStatus(
        session.sessionId,
        PAYMENT_SESSION_STATUS.EXPIRED
      );
    }
    return session;
  }

  /**
   * Create a new payment session for an Order
   */
  async createPaymentSession(orderId) {
    if (!orderId) {
      throw new ApiError(400, "Invalid orderId");
    }

    const order = await orderRepository.findByOrderId(orderId);
    if (!order) {
      throw new ApiError(404, "Order does not exist");
    }

    // Step 4 & 5: Prevent creating sessions for already-paid orders
    if (order.status === ORDER_STATUS.PAID) {
      throw new ApiError(409, "Order is already paid. Cannot create a new payment session.");
    }

    const sessionId = generateSessionID();
    const expiresAt = new Date(Date.now() + PAYMENT_SESSION_TTL_MS);

    const newSession = await paymentSessionRepository.createSession({
      sessionId,
      orderId: order.orderId,
      status: PAYMENT_SESSION_STATUS.ACTIVE,
      expiresAt
    });

    const qrPayload = this.getQrPayload(sessionId);

    return {
      message: "Payment session created successfully",
      data: {
        session: {
          sessionId: newSession.sessionId,
          orderId: order.orderId,
          amount: order.amount, // Authoritative amount from Order
          status: newSession.status,
          expiresAt: newSession.expiresAt
        },
        qrPayload
      }
    };
  }

  /**
   * Retrieve an existing payment session by sessionId
   */
  async getPaymentSession(sessionId) {
    if (!sessionId) {
      throw new ApiError(400, "sessionId required");
    }

    let session = await paymentSessionRepository.findBySessionId(sessionId);
    if (!session) {
      throw new ApiError(404, "Payment session not found");
    }

    // Sync expiration status dynamically
    session = await this.checkAndSyncExpiration(session);

    // Retrieve corresponding order for authoritative source of truth
    const order = await orderRepository.findByOrderId(session.orderId);
    if (!order) {
      throw new ApiError(404, "Associated order not found");
    }

    // If order was marked PAID, ensure session reflects completion if not already marked
    let effectiveSessionStatus = session.status;
    if (order.status === ORDER_STATUS.PAID && effectiveSessionStatus === PAYMENT_SESSION_STATUS.ACTIVE) {
      effectiveSessionStatus = PAYMENT_SESSION_STATUS.COMPLETED;
      await paymentSessionRepository.updateStatus(session.sessionId, PAYMENT_SESSION_STATUS.COMPLETED);
    }

    const qrPayload = this.getQrPayload(sessionId);

    // Retrieve latest payment attempt for this order if any
    const latestPayment = await paymentRepository.findLatestByOrderId(session.orderId);

    return {
      message: "Payment session retrieved successfully",
      data: {
        session: {
          sessionId: session.sessionId,
          orderId: session.orderId,
          amount: order.amount, // Authoritative order amount
          orderStatus: order.status,
          sessionStatus: effectiveSessionStatus,
          expiresAt: session.expiresAt,
          latestPayment: latestPayment
            ? {
                paymentId: latestPayment.paymentId,
                attemptNumber: latestPayment.attemptNumber,
                status: latestPayment.status
              }
            : null
        },
        qrPayload
      }
    };
  }

  /**
   * Process payment through an active session
   */
  async payThroughSession(sessionId, { result = "success", idempotencyKey = null } = {}) {
    if (!sessionId) {
      throw new ApiError(400, "sessionId required");
    }

    // If an idempotencyKey is provided, check idempotency first so duplicate retries replay cached responses
    if (idempotencyKey) {
      const idempotencyResult = await idempotencyService.processWithIdempotency(
        {
          key: idempotencyKey,
          paymentId: `SESSION-${sessionId}`,
          endpoint: `/api/payment-sessions/${sessionId}/pay`,
          body: { result }
        },
        async () => {
          return this._executePayThroughSession(sessionId, { result });
        }
      );

      return {
        message: "Payment processed successfully",
        data: idempotencyResult.response.data
      };
    }

    const execResult = await this._executePayThroughSession(sessionId, { result });
    return {
      message: "Payment initiated and processed successfully",
      data: execResult
    };
  }

  async _executePayThroughSession(sessionId, { result = "success" } = {}) {
    let session = await paymentSessionRepository.findBySessionId(sessionId);
    if (!session) {
      throw new ApiError(404, "Payment session not found");
    }

    // Check expiration
    session = await this.checkAndSyncExpiration(session);

    if (session.status === PAYMENT_SESSION_STATUS.EXPIRED) {
      throw new ApiError(410, "Payment session has expired. Please initiate a new session.");
    }

    if (session.status === PAYMENT_SESSION_STATUS.COMPLETED) {
      throw new ApiError(409, "Payment session has already been completed.");
    }

    if (session.status === PAYMENT_SESSION_STATUS.CANCELLED) {
      throw new ApiError(409, "Payment session has been cancelled.");
    }

    if (session.status !== PAYMENT_SESSION_STATUS.ACTIVE) {
      throw new ApiError(400, `Cannot pay through session in status '${session.status}'`);
    }

    const order = await orderRepository.findByOrderId(session.orderId);
    if (!order) {
      throw new ApiError(404, "Associated order not found");
    }

    if (order.status === ORDER_STATUS.PAID) {
      await paymentSessionRepository.updateStatus(sessionId, PAYMENT_SESSION_STATUS.COMPLETED);
      throw new ApiError(409, "Order is already paid. No further payment attempts allowed.");
    }

    const paymentResult = await paymentService.createPayment(session.orderId);
    const payment = paymentResult.data;
    const processResult = await paymentService.processPayment(payment.paymentId, result);

    return {
      sessionId: session.sessionId,
      orderId: session.orderId,
      payment: processResult.data
    };
  }
}

export default new PaymentSessionService();
