import express from "express";
import cors from "cors";
import orderRoutes from "./routes/order.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import webhookRoutes from "./routes/webhook.routes.js";
import { errorHandler } from "./middlewares/error.middleware.js";

const app = express();

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "API is Running/......"
  });
});

app.use("/api/orders", orderRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/webhooks", webhookRoutes);

// Error handling middleware (must be registered last)
app.use(errorHandler);

export default app;