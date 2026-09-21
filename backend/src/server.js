import "dotenv/config";
import "./config/dns.js";
import mongoose from "mongoose";
import app from "./app.js";
import connectDB from "./databases/db.js";
import { webhookRetryWorker } from "./workers/webhookRetry.worker.js";
import { webhookRetryQueue } from "./queues/webhookRetry.queue.js";
import orderService from "./services/order.service.js";

const PORT = Number(process.env.PORT ?? 5000);
const SWEEP_INTERVAL_MS = Number(process.env.ORDER_EXPIRATION_SWEEP_INTERVAL_MS ?? 60000);

let server;
let sweepInterval;

const startServer = async () => {
  await connectDB();
  server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // Start background order expiration sweeper
  sweepInterval = setInterval(async () => {
    try {
      const cancelledCount = await orderService.sweepExpiredOrders();
      if (cancelledCount > 0) {
        console.log(`[OrderSweeper] Cancelled ${cancelledCount} expired pending order(s).`);
      }
    } catch (err) {
      console.error("[OrderSweeper] Error during expired order sweep:", err.message);
    }
  }, SWEEP_INTERVAL_MS);
};

const gracefulShutdown = async (signal) => {
  console.log(`\n[Server] Received ${signal}. Initiating graceful shutdown...`);

  if (sweepInterval) {
    clearInterval(sweepInterval);
    console.log("[Server] Order expiration sweeper stopped.");
  }

  if (server) {
    server.close(() => {
      console.log("[Server] HTTP server stopped accepting connections.");
    });
  }

  try {
    if (webhookRetryWorker) {
      console.log("[Server] Closing BullMQ worker...");
      await webhookRetryWorker.close();
      console.log("[Server] BullMQ worker closed.");
    }

    if (webhookRetryQueue) {
      console.log("[Server] Closing BullMQ queue...");
      await webhookRetryQueue.close();
      console.log("[Server] BullMQ queue closed.");
    }

    console.log("[Server] Closing MongoDB connection...");
    await mongoose.connection.close();
    console.log("[Server] MongoDB connection closed.");

    process.exit(0);
  } catch (error) {
    console.error("[Server] Error during graceful shutdown:", error.message);
    process.exit(1);
  }
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

startServer();