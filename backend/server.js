const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const mongoose = require("mongoose");

const authRoutes = require("./routes/Auth");
const inquiryRoutes = require('./routes/inquiryRoutes.js');
const contactRoutes = require('./routes/contactRoutes.js');
dotenv.config();
const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URL =
  process.env.MONGO_URL || "mongodb://127.0.0.1:27017/school_website";
app.use(cors());
app.use(express.json());

// routes
app.use("/api/auth", authRoutes);
app.use("/api/inquiries", inquiryRoutes);
app.use("/api/contact", contactRoutes);
// connect to mongodb

// connect to mongodb with proper try-catch
async function connectDB() {
  try {
    await mongoose.connect(MONGO_URL);
    console.log(" connected to mongodb");
  } catch (error) {
    console.log(" Database connection failed:", error.message);
    process.exit(1);
  }
}


connectDB();


// Start server with error handling
app
  .listen(PORT, () => {
    console.log(`server is started on port ${PORT}`);
  })
  .on("error", (err) => {
    console.log("Server error:", err.message);
    process.exit(1);
  });
