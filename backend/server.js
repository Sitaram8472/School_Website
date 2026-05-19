const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const mongoose = require("mongoose");

const authRoutes = require("./routes/Auth");

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// routes
app.use("/api/auth", authRoutes);


// connect to mongodb with proper try-catch
async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log("connected to mongodb");
  } catch (error) {
    console.log("Database connection failed:", error.message);
    // Exit process if database connection fails
    process.exit(1);
  }
}

connectDB();

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
