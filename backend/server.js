const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
const validateEnv = require("./config/validateEnv.js");

const cookieParser = require("cookie-parser");

const authRoutes = require("./routes/Auth");
const inquiryRoutes = require("./routes/inquiryRoutes.js");
const noticeRoutes = require("./routes/noticeRoutes.js");
const applicationRoutes = require("./routes/applicationRoutes");
const contactRoutes = require("./routes/contactRoutes.js");
const teacherRoutes = require("./routes/teacherRoutes.js");
dotenv.config();
const app = express();
app.use(cors({ origin: "http://localhost:5173", credentials: true }));
app.use(express.json());
validateEnv();
app.use(cookieParser());

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/inquiries", inquiryRoutes);
app.use("/api/notices", noticeRoutes);
app.use("/api/applications", applicationRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/teacher", teacherRoutes);
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Connect to mongodb with try-catch
async function connectDB() {
  if (!process.env.MONGO_URL) {
    console.warn("WARNING: MONGO_URL not found. Skipping database connection. API endpoints that require the database will not work.");
    return;
  }
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log(" connected to mongodb");
  } catch (error) {
    console.log(" Database connection failed:", error.message);
    process.exit(1);
  }
}

connectDB();

// Initialize notice scheduler
require("./scheduler/noticeScheduler");

const PORT = process.env.PORT || 5000;

// Start server with error handling
app
  .listen(PORT, () => {
    console.log(`server is started on port ${PORT}`);
  })
  .on("error", (err) => {
    console.log("Server error:", err.message);
    process.exit(1);
  });
