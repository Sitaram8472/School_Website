const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
const cookieParser = require("cookie-parser");

const validateEnv = require("./config/validateEnv.js");

const authRoutes = require("./routes/Auth");
const inquiryRoutes = require("./routes/inquiryRoutes.js");
const noticeRoutes = require("./routes/noticeRoutes.js");
const applicationRoutes = require("./routes/applicationRoutes");
const contactRoutes = require("./routes/contactRoutes.js");
const teacherRoutes = require("./routes/teacherRoutes.js");

// Load values from .env when available
dotenv.config();

// Safe development fallbacks
process.env.PORT = process.env.PORT || "5000";
process.env.MONGO_URL =
  process.env.MONGO_URL || "mongodb://127.0.0.1:27017/school_website";
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "fallback_development_secret_key";

const PORT = process.env.PORT;
const MONGO_URL = process.env.MONGO_URL;

const app = express();

// Middleware
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  })
);

app.use(express.json());
app.use(cookieParser());

// Validate environment variables after applying fallbacks
validateEnv();

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/inquiries", inquiryRoutes);
app.use("/api/notices", noticeRoutes);
app.use("/api/applications", applicationRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/teacher", teacherRoutes);
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Connect to MongoDB
async function connectDB() {
  try {
    await mongoose.connect(MONGO_URL);
    console.log("Connected to MongoDB");
  } catch (error) {
    console.error("Database connection failed:", error.message);
    process.exit(1);
  }
}

// Start the server after MongoDB connects
async function startServer() {
  await connectDB();

  app
    .listen(PORT, () => {
      console.log(`Server started on port ${PORT}`);
    })
    .on("error", (error) => {
      console.error("Server error:", error.message);
      process.exit(1);
    });
}

startServer();