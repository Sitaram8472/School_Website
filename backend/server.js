const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
const cookieParser = require("cookie-parser");
const http = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");

// Load environment variables first
dotenv.config();

// Import and run environment validator
const { validateEnv, checkProductionSecurity } = require("./utils/envValidator");
validateEnv();
checkProductionSecurity();

// Import routes
const authRoutes = require("./routes/Auth");
const inquiryRoutes = require('./routes/inquiryRoutes.js');
const noticeRoutes = require('./routes/noticeRoutes.js');
const applicationRoutes = require('./routes/ApplicationRoutes.js');
const contactRoutes = require('./routes/contactRoutes.js');
const teacherRoutes = require('./routes/teacherRoutes.js');
const chatRoutes = require('./routes/chatRoutes.js');
const courseRoutes = require('./routes/courseRoutes.js');
const examRoutes = require('./routes/examRoutes.js');
const submissionRoutes = require('./routes/submissionRoutes.js');
const reportRoutes = require('./routes/reportRoutes.js');

dotenv.config();

const app = express();

// Middleware
app.use(cors({ 
  origin: process.env.CLIENT_URL || "http://localhost:5173", 
  credentials: true 
}));
app.use(express.json());
app.use(cookieParser());

// Static files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/inquiries", inquiryRoutes);
app.use("/api/notices", noticeRoutes);
app.use("/api/applications", applicationRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/teacher", teacherRoutes);
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/api", chatRoutes);
app.use("/api/courses", courseRoutes);
app.use("/api/exams", examRoutes);
app.use("/api/submissions", submissionRoutes);
app.use("/api/reports", reportRoutes);


// Database connection
async function connectDB() {
  const mongoUrl = process.env.MONGODB_URI || process.env.MONGO_URL;
  
  if (!mongoUrl) {
    console.warn("MONGODB_URI not found. Skipping database connection. API endpoints that require the database will not work.");
    return;
  }
  
  try {
    await mongoose.connect(mongoUrl);
    console.log("Connected to MongoDB");
  } catch (error) {
    console.log("Database connection failed:", error.message);
    process.exit(1);
  }
}

connectDB();

// Initialize notice scheduler
require("./scheduler/noticeScheduler");

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Server is running",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});


const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    credentials: true
  }
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error: Token missing'));
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (err) {
    next(new Error('Authentication error: Invalid token'));
  }
});

io.on("connection", (socket) => {
  console.log(`[Socket] User connected: ${socket.user.id || socket.user._id}`);
  
  socket.on("disconnect", () => {
    console.log(`[Socket] User disconnected: ${socket.user.id || socket.user._id}`);
  });
});

app.set('io', io);

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
}).on("error", (err) => {
  console.log("Server error:", err.message);
  process.exit(1);
});