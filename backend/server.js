const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const mongoose = require("mongoose");

const authRoutes = require("./routes/Auth");
const inquiryRoutes = require('./routes/inquiryRoutes.js');
const applicationRoutes = require("./routes/applicationRoutes");
const contactRoutes = require('./routes/contactRoutes.js');

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// --- IMPLEMENT FALLBACK CONFIGURATIONS HERE ---
const PORT = process.env.PORT || 5000;
const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/school_website';

// routes
app.use("/api/auth", authRoutes);
app.use("/api/inquiries", inquiryRoutes);
app.use("/api/applications", applicationRoutes);
app.use("/api/contact", contactRoutes);

// connect to mongodb with proper try-catch
async function connectDB() {
  try {
    // Update this line to use the new fallback variable
    await mongoose.connect(MONGO_URL);
    console.log(" connected to mongodb");
  } catch (error) {
    console.log(" Database connection failed:", error.message);
    process.exit(1);
  }
}

// Ensure the database connection is called
connectDB();

// Start the server using the fallback PORT
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});