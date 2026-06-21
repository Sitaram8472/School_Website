const jwt = require("jsonwebtoken");
const User = require("../models/User");

const protect = async (req, res, next) => {
  try {
    let token = req.cookies.token;

    // Check token exists
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Not authorized, no token",
      });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Find user
    req.user = await User.findById(decoded.id).select("-password");

    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "User not found",
      });
    }

    next();
  } catch (error) {
    console.error("Auth Middleware Error:", error);

    return res.status(401).json({
      success: false,
      message: "Not authorized, token failed",
      error: error.message,
    });
  }
};

module.exports = { protect };