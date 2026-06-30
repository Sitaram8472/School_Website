const express = require("express");
const router = express.Router();
const {
  register,
  login,
  logout,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerification,
  refreshToken,
  deactivateAccount,
  activateAccount,
  getAccountStatus,
} = require("../controllers/Authcontroller");

const {
  loginLimiter,
  registerLimiter,
  forgotPasswordLimiter,
  resendVerificationLimiter,
  refreshTokenLimiter,
} = require("../middleware/rateLimiter");

const { protect } = require("../middleware/auth");

router.post("/register", registerLimiter, register);
router.post("/login", loginLimiter, login);
router.post("/logout", logout);
router.post("/forgot-password", forgotPasswordLimiter, forgotPassword);
router.post("/reset-password", resetPassword);
router.get("/verify-email/:token", verifyEmail);
router.post("/resend-verification", resendVerificationLimiter, resendVerification);
router.post("/refresh-token", refreshTokenLimiter, refreshToken);

// New protected routes
router.post("/deactivate-account", protect, deactivateAccount);
router.post("/activate-account", protect, activateAccount);
router.get("/account-status", protect, getAccountStatus);

module.exports = router;