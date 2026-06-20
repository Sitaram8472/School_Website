const Resource = require("../models/Resource");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, "../uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer Setup
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({ storage: storage });
exports.upload = upload;

// Get all resources
exports.getResources = async (req, res) => {
  try {
    const data = await Resource.find().sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      message: "Resources fetched successfully",
      data,
    });
  } catch (error) {
    console.error("Server Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  }
};

// Create a new resource
exports.createResource = async (req, res) => {
  try {
    const { title, subject, teacherName, targetClass } = req.body;

    if (!title || !subject) {
      return res.status(400).json({
        success: false,
        message: "Title and subject are required",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "File is required",
      });
    }

    const fileUrl = `/uploads/${req.file.filename}`;
    const fileName = req.file.originalname;
    const fileType = req.file.mimetype;

    const newResource = await Resource.create({
      title,
      subject,
      fileUrl,
      fileName,
      fileType,
      teacherName: teacherName || "Admin",
      targetClass: targetClass || "All Classes",
      uploadedBy: req.user ? req.user._id : null, // If using protect middleware
    });

    return res.status(201).json({
      success: true,
      message: "Resource uploaded successfully",
      data: newResource,
    });
  } catch (error) {
    console.error("Create Resource Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};
