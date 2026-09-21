import ApiError from "../utils/ApiError.js";

const isValidIdString = (val) => typeof val === "string" && val.trim().length > 0 && val.length <= 128;

export const validateCreateOrder = (req, res, next) => {
  const { amount, currency, customerId, userId } = req.body || {};

  const orderUser = userId || customerId;
  if (!orderUser || typeof orderUser !== "string" || orderUser.trim().length === 0 || orderUser.length > 128) {
    return next(new ApiError(400, "userId is required to create an order"));
  }

  if (amount === undefined || amount === null || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return next(new ApiError(400, "Order amount must be a positive finite number"));
  }

  if (currency !== undefined && (typeof currency !== "string" || currency.trim().length === 0 || currency.length > 10)) {
    return next(new ApiError(400, "Invalid currency code provided"));
  }

  next();
};

export const validateOrderIdParam = (req, res, next) => {
  const { orderId } = req.params;
  if (!isValidIdString(orderId)) {
    return next(new ApiError(400, "Invalid or missing orderId parameter"));
  }
  next();
};

export const validatePaymentIdParam = (req, res, next) => {
  const { paymentId } = req.params;
  if (!isValidIdString(paymentId)) {
    return next(new ApiError(400, "Invalid or missing paymentId parameter"));
  }
  next();
};

export const validateSessionIdParam = (req, res, next) => {
  const { sessionId } = req.params;
  if (!isValidIdString(sessionId)) {
    return next(new ApiError(400, "Invalid or missing sessionId parameter"));
  }
  next();
};

export const validateCreatePayment = (req, res, next) => {
  const { orderId } = req.body || {};
  if (!isValidIdString(orderId)) {
    return next(new ApiError(400, "orderId is required to create a payment"));
  }
  next();
};

export const validateProcessPayment = (req, res, next) => {
  const { paymentId } = req.params;
  if (!isValidIdString(paymentId)) {
    return next(new ApiError(400, "Invalid or missing paymentId parameter"));
  }

  const { result } = req.body || {};
  if (result !== undefined && result !== "success" && result !== "failed") {
    return next(new ApiError(400, "Result must be either 'success' or 'failed' if provided"));
  }

  const idempotencyKey = req.headers["idempotency-key"] || req.headers["Idempotency-Key"];
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0 || idempotencyKey.length > 256)) {
    return next(new ApiError(400, "Invalid Idempotency-Key header"));
  }

  next();
};

export const validatePayThroughSession = (req, res, next) => {
  const { sessionId } = req.params;
  if (!isValidIdString(sessionId)) {
    return next(new ApiError(400, "Invalid or missing sessionId parameter"));
  }

  const { result } = req.body || {};
  if (result !== undefined && result !== "success" && result !== "failed") {
    return next(new ApiError(400, "Result must be either 'success' or 'failed' if provided"));
  }

  const idempotencyKey = req.headers["idempotency-key"] || req.headers["Idempotency-Key"];
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0 || idempotencyKey.length > 256)) {
    return next(new ApiError(400, "Invalid Idempotency-Key header"));
  }

  next();
};
