import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/auth", (req, res) => {
  res.json({
    success: true,
    message: "API is Running/......"
  })
})


export default app;