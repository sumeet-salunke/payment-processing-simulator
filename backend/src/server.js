import "dotenv/config";
import "./config/dns.js";
import mongoose from "mongoose";
import app from "./app.js";
import connectDB from "./databases/db.js";
import { webhookRetryWorker } from "./workers/webhookRetry.worker.js";
import { webhookRetryQueue } from "./queues/webhookRetry.queue.js";

const PORT = Number(process.env.PORT ?? 5000);

let server;

const startServer = async () => {
  await connectDB();
  server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
};

const gracefulShutdown = async (signal) => {
  console.log(`\n[Server] Received ${signal}. Initiating graceful shutdown...`);

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