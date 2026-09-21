import ApiError from "../utils/ApiError.js";

const HTTP_ERROR_CODES = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  410: "GONE",
  422: "UNPROCESSABLE_ENTITY",
  429: "TOO_MANY_REQUESTS",
  500: "INTERNAL_SERVER_ERROR"
};

const getErrorCode = (err, statusCode) => {
  if (err?.errorCode) return err.errorCode;
  if (err?.code && typeof err.code === "string") return err.code;
  return HTTP_ERROR_CODES[statusCode] || "INTERNAL_SERVER_ERROR";
};

export const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || "Internal Server Error";

  // Handle operational ApiError instances
  if (err instanceof ApiError || err.isOperational) {
    return res.status(statusCode).json({
      success: false,
      statusCode,
      message,
      error: {
        code: getErrorCode(err, statusCode),
        message
      },
      data: null
    });
  }

  // Handle common parsing or database formatting errors safely
  if (err.name === "CastError") {
    return res.status(400).json({
      success: false,
      statusCode: 400,
      message: `Invalid format for field: ${err.path}`,
      error: {
        code: "INVALID_FIELD_FORMAT",
        message: `Invalid format for field: ${err.path}`
      },
      data: null
    });
  }

  if (err.name === "ValidationError") {
    return res.status(400).json({
      success: false,
      statusCode: 400,
      message: err.message,
      error: {
        code: "VALIDATION_ERROR",
        message: err.message
      },
      data: null
    });
  }

  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({
      success: false,
      statusCode: 400,
      message: "Malformed JSON payload",
      error: {
        code: "MALFORMED_JSON",
        message: "Malformed JSON payload"
      },
      data: null
    });
  }

  // Log unhandled unexpected errors for debugging without leaking sensitive internals
  console.error("Unhandled server error:", err);

  // Return a generic safe response without leaking internal stack traces or database details
  return res.status(500).json({
    success: false,
    statusCode: 500,
    message: "Internal Server Error",
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "Internal Server Error"
    },
    data: null
  });
};
