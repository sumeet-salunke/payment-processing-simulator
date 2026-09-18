import express from "express";
import cors from "cors";
import orderRoutes from "./routes/order.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/auth", (req, res) => {
  res.json({
    success: true,
    message: "API is Running/......"
  })
})
app.use("/api/orders", orderRoutes);
app.use("/api/payments", paymentRoutes);

export default app;