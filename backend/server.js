const swaggerUi = require("swagger-ui-express");
const swaggerJsdoc = require("swagger-jsdoc");
const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
const validateEnv = require("./config/validateEnv.js");
const cookieParser = require("cookie-parser");
const validateEnv = require("./config/validateEnv.js");

const cookieParser = require("cookie-parser");
upstream/main
const authRoutes = require("./routes/Auth");
const inquiryRoutes = require("./routes/inquiryRoutes.js");
const noticeRoutes = require("./routes/noticeRoutes.js");
const applicationRoutes = require("./routes/applicationRoutes");
const contactRoutes = require("./routes/contactRoutes.js");
const teacherRoutes = require("./routes/teacherRoutes.js");
dotenv.config();
const app = express();

const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "EduStream Academy API",
      version: "1.0.0",
      description:
        "API documentation for EduStream Academy Management Portal",
    },
    servers: [
      {
        url: "http://localhost:5000",
      },
    ],
  },
  apis: ["./routes/*.js"],
};
const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use(cors());

app.use(cors({ origin: "http://localhost:5173", credentials: true }));
upstream/main
app.use(express.json());
validateEnv();
app.use(cookieParser());

// routes
app.use("/api/auth", authRoutes);
app.use("/api/inquiries", inquiryRoutes);
app.use("/api/notices", noticeRoutes);
app.use("/api/applications", applicationRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/teacher", teacherRoutes);
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec)
);
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
