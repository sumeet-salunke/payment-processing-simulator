import express from "express";
import cors from "cors";
import orderRoutes from "./routes/order.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import webhookRoutes from "./routes/webhook.routes.js";
import paymentSessionRoutes from "./routes/paymentSession.routes.js";
import { errorHandler } from "./middlewares/error.middleware.js";

import mongoose from "mongoose";

const app = express();

const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.PUBLIC_FRONTEND_URL
].filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    // In development/test mode, or non-browser/server-to-server requests without Origin header, allow
    if (process.env.NODE_ENV !== "production" || !origin) {
      return callback(null, true);
    }
    // In production, restrict to allowed origins
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Blocked by CORS policy"));
  },
  credentials: true
};

app.use(cors(corsOptions));

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.get("/api/health", (req, res) => {
  const isDbConnected = mongoose.connection.readyState === 1;

  res.json({
    success: true,
    status: isDbConnected ? "healthy" : "degraded",
    services: {
      database: isDbConnected ? "connected" : "disconnected"
    },
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.use("/api/orders", orderRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/payment-sessions", paymentSessionRoutes);

// Error handling middleware (must be registered last)
app.use(errorHandler);

export default app;