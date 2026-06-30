const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const mongoose = require("mongoose");

const authRoutes = require("./routes/Auth");
const inquiryRoutes = require('./routes/inquiryRoutes.js');
dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// routes
app.use("/api/auth", authRoutes);
app.use("/api/inquiries", inquiryRoutes);
// connect to mongodb

// connect to mongodb with proper try-catch
async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log(" connected to mongodb");
  } catch (error) {
    console.log(" Database connection failed:", error.message);
    process.exit(1);
  }
}


const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    await connectDB();

    app.listen(PORT, () => {
      console.log(`🚀 Server started on port ${PORT}`);
    });
  } catch (err) {
    console.log("Failed to start server:", err.message);
    process.exit(1);
  }
}

startServer();
