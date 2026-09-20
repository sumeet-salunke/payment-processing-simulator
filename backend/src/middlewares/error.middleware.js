import ApiError from "../utils/ApiError.js";

export const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || "Internal Server Error";

  // Handle operational ApiError instances
  if (err instanceof ApiError || err.isOperational) {
    return res.status(statusCode).json({
      success: false,
      statusCode,
      message,
      data: null
    });
  }

  // Handle common parsing or database formatting errors safely
  if (err.name === "CastError") {
    return res.status(400).json({
      success: false,
      statusCode: 400,
      message: `Invalid format for field: ${err.path}`,
      data: null
    });
  }

  if (err.name === "ValidationError") {
    return res.status(400).json({
      success: false,
      statusCode: 400,
      message: err.message,
      data: null
    });
  }

  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({
      success: false,
      statusCode: 400,
      message: "Malformed JSON payload",
      data: null
    });
  }

  // Log unhandled unexpected errors for debugging
  console.error("Unhandled server error:", err);

  // Return a generic safe response without leaking internal stack traces
  return res.status(500).json({
    success: false,
    statusCode: 500,
    message: "Internal Server Error",
    data: null
  });
};
