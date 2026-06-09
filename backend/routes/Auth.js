const express = require("express");
const router = express.Router();
const { register, login, forgotPassword, resetPassword } = require("../controllers/Authcontroller");
const { loginLimiter, forgotPasswordLimiter } = require("../middleware/rateLimiter");

router.post("/register", register);
router.post("/login",loginLimiter, login);
router.post("/forgot-password",forgotPasswordLimiter, forgotPassword);
router.post("/reset-password", resetPassword);

module.exports = router;
