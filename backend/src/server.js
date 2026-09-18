import "dotenv/config";
import "./config/dns.js";
import app from "./app.js";
import connectDB from "./databases/db.js";

const PORT = Number(process.env.PORT ?? 5000);

const startServer = async () => {
  connectDB();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  })
}

startServer();