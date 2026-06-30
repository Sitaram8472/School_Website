const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const sendEmail = require("../utils/sendEmail");

// =============================================
// Helper Functions
// =============================================

const normalizeEmail = (email) => {
  return email?.trim().toLowerCase();
};

const sanitizeInput = (input) => {
  if (typeof input !== 'string') return input;
  return input.replace(/[<>]/g, '');
};

const validatePassword = (password) => {
  const regex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
  return regex.test(password);
};

const generateAccessToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: "1h" });
};

const generateRefreshToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET, { expiresIn: "7d" });
};

// =============================================
// Register Controller
// =============================================

exports.register = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    const sanitizedName = sanitizeInput(name);
    const normalizedEmail = normalizeEmail(email);

    let user = await User.findOne({ email: normalizedEmail });
    if (user) return res.status(400).json({ message: "User already exists" });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: "Invalid email format" });
    }

    // Password validation - model will also validate, but keeping here for early response
    if (!validatePassword(password)) {
      return res.status(400).json({
        message: "Password must be at least 8 characters with uppercase, lowercase, number, and special character (@$!%*?&)"
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    if (role && !["student", "teacher"].includes(role)) {
      return res.status(403).json({ message: "Invalid role" });
    }
    const userRole = ["student", "teacher"].includes(role) ? role : "student";

    user = await User.create({
      name: sanitizedName,
      email: normalizedEmail,
      password: hashedPassword,
      role: userRole,
      isVerified: false,
    });

    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");

    user.verificationToken = hashedToken;
    user.verificationTokenExpiry = Date.now() + 24 * 60 * 60 * 1000;
    await user.save();

    const verifyUrl = `${process.env.CLIENT_URL || process.env.FRONTEND_URL || "http://localhost:5173"}/verify-email/${rawToken}`;

    try {
      await sendEmail({
        to: user.email,
        subject: "EduStream Academy - Verify Your Email",
        html: `
          <p>Hi ${user.name},</p>
          <p>Thank you for registering. Please verify your email using the link below (valid for 24 hours):</p>
          <p><a href="${verifyUrl}">${verifyUrl}</a></p>
          <br/>
          <p>- EduStream Academy</p>
        `,
      });
    } catch (emailError) {
      console.error("Verification email error:", emailError.message);
      console.log(`[DEV] Verification link for ${email}: ${verifyUrl}`);
    }

    res.status(201).json({
      message: "Registration successful. Please check your inbox to verify your account before logging in.",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// =============================================
// Login Controller (with Account Lockout)
// =============================================

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = normalizeEmail(email);

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    // Check if account is active
    if (!user.isActive) {
      return res.status(403).json({
        message: "Account has been deactivated. Please contact support.",
      });
    }

    // Check if account is locked using model method
    if (user.isAccountLocked()) {
      const remainingMinutes = user.getRemainingLockTime();
      return res.status(403).json({
        message: `Account locked. Please try again after ${remainingMinutes} minutes.`,
        locked: true,
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      // Using model method to increment failed attempts
      await user.incrementFailedAttempts();
      
      // Check if account got locked
      if (user.isAccountLocked()) {
        await user.save();
        return res.status(403).json({
          message: "Account locked due to too many failed attempts. Try again after 15 minutes.",
          locked: true,
        });
      }
      
      return res.status(400).json({
        message: "Invalid credentials",
        remainingAttempts: 5 - user.failedLoginAttempts,
      });
    }

    // Reset failed attempts using model method
    const ip = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    await user.resetFailedAttempts(ip, userAgent);

    if (!user.isVerified) {
      await user.save();
      return res.status(403).json({
        message: "Please verify your email to log in",
        needsVerification: true,
      });
    }

    const accessToken = generateAccessToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    await user.updateRefreshToken(refreshToken);

    res.cookie("token", accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 3600000,
    });

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      message: "Login successful",
      accessToken,
      refreshToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        lastLoginAt: user.lastLoginAt,
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// =============================================
// Refresh Token Controller
// =============================================

exports.refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(401).json({ message: "Refresh token required" });
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET);

    const user = await User.findById(decoded.id);
    if (!user || user.refreshToken !== refreshToken) {
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    // Check if account is active
    if (!user.isActive) {
      return res.status(403).json({ message: "Account is deactivated" });
    }

    const newAccessToken = generateAccessToken(user._id);
    const newRefreshToken = generateRefreshToken(user._id);
    await user.updateRefreshToken(newRefreshToken);

    res.cookie("token", newAccessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 3600000,
    });

    res.status(200).json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (error) {
    res.status(401).json({ message: "Invalid or expired refresh token" });
  }
};

// =============================================
// Logout Controller
// =============================================

exports.logout = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (userId) {
      const user = await User.findById(userId);
      if (user) {
        await user.clearRefreshToken();
        
        user.securityLogs.push({
          event: "logout",
          timestamp: new Date(),
          ip: req.ip || req.connection.remoteAddress,
          userAgent: req.headers['user-agent'],
        });
        await user.save();
      }
    }
  } catch (error) {
    // Continue with logout even if DB fails
  }

  res
    .clearCookie("token", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
    })
    .clearCookie("refreshToken", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
    })
    .status(200)
    .json({ message: "Logout successful" });
};

// =============================================
// Forgot Password Controller
// =============================================

exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const normalizedEmail = normalizeEmail(email);

    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(200).json({
        message: "If that email is registered, a reset link has been sent.",
      });
    }

    // Check if account is active
    if (!user.isActive) {
      return res.status(200).json({
        message: "If that email is registered, a reset link has been sent.",
      });
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");

    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = Date.now() + 3600000;
    await user.save();

    const frontendUrl = process.env.CLIENT_URL || process.env.FRONTEND_URL || "http://localhost:5173";
    const resetUrl = `${frontendUrl}/reset-password/${rawToken}`;

    try {
      await sendEmail({
        to: user.email,
        subject: "EduStream Academy - Password Reset Request",
        html: `
          <p>Hi ${user.name},</p>
          <p>We received a request to reset your password. Click the link below. It expires in <strong>1 hour</strong>.</p>
          <p><a href="${resetUrl}">${resetUrl}</a></p>
          <p>If you did not request this, you can safely ignore this email.</p>
          <br/>
          <p>- EduStream Academy</p>
        `,
      });
    } catch (emailError) {
      console.log(`[DEV] Password reset link for ${email}: ${resetUrl}`);
    }

    res.status(200).json({
      message: "If that email is registered, a reset link has been sent.",
    });
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// =============================================
// Reset Password Controller
// =============================================

exports.resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ message: "Token and new password are required." });
    }

    if (!validatePassword(password)) {
      return res.status(400).json({
        message: "Password must be at least 8 characters with uppercase, lowercase, number, and special character (@$!%*?&)"
      });
    }

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        message: "Reset link is invalid or has expired. Please request a new one.",
      });
    }

    // Check if account is active
    if (!user.isActive) {
      return res.status(403).json({
        message: "Account is deactivated. Cannot reset password.",
      });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    user.lastPasswordChangeAt = new Date();
    await user.save();

    res.status(200).json({
      message: "Password reset successfully. You can now log in with your new password.",
    });
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// =============================================
// Verify Email Controller
// =============================================

exports.verifyEmail = async (req, res) => {
  try {
    const hashedToken = crypto.createHash("sha256").update(req.params.token).digest("hex");

    const user = await User.findOne({
      verificationToken: hashedToken,
      verificationTokenExpiry: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ message: "Verification link is invalid or has expired." });
    }

    user.isVerified = true;
    user.verificationToken = null;
    user.verificationTokenExpiry = null;
    await user.save();

    return res.status(200).json({ message: "Email verified successfully" });
  } catch (error) {
    return res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// =============================================
// Resend Verification Controller (with Cooldown)
// =============================================

const emailCooldown = new Map();

exports.resendVerification = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const normalizedEmail = normalizeEmail(email);

    const lastSent = emailCooldown.get(normalizedEmail);
    if (lastSent && Date.now() - lastSent < 5 * 60 * 1000) {
      const remainingSeconds = Math.ceil((5 * 60 * 1000 - (Date.now() - lastSent)) / 1000);
      const remainingMinutes = Math.ceil(remainingSeconds / 60);
      return res.status(429).json({
        message: `Please wait ${remainingMinutes} minute(s) before requesting again.`,
        retryAfter: remainingSeconds,
      });
    }

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.isVerified) {
      return res.status(400).json({ message: "Email is already verified" });
    }

    // Check if account is active
    if (!user.isActive) {
      return res.status(403).json({ message: "Account is deactivated" });
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");

    user.verificationToken = hashedToken;
    user.verificationTokenExpiry = Date.now() + 24 * 60 * 60 * 1000;
    await user.save();

    emailCooldown.set(normalizedEmail, Date.now());

    setTimeout(() => {
      emailCooldown.delete(normalizedEmail);
    }, 5 * 60 * 1000);

    const verifyUrl = `${process.env.CLIENT_URL || process.env.FRONTEND_URL || "http://localhost:5173"}/verify-email/${rawToken}`;

    try {
      await sendEmail({
        to: user.email,
        subject: "EduStream Academy - Verify Your Email",
        html: `
          <p>Hi ${user.name},</p>
          <p>Here is your new verification link (valid for 24 hours):</p>
          <p><a href="${verifyUrl}">${verifyUrl}</a></p>
          <br/>
          <p>- EduStream Academy</p>
        `,
      });
    } catch (emailError) {
      console.error("Resend verification email error:", emailError.message);
      console.log(`[DEV] Verification link for ${email}: ${verifyUrl}`);
    }

    return res.status(200).json({
      message: "A fresh verification link has been sent to your email.",
    });
  } catch (error) {
    return res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// =============================================
// Deactivate Account Controller
// =============================================

exports.deactivateAccount = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { reason } = req.body;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    await user.deactivateAccount(reason || "User requested deactivation");

    res.clearCookie("token", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
    });
    res.clearCookie("refreshToken", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
    });

    res.status(200).json({
      message: "Account deactivated successfully",
    });
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// =============================================
// Activate Account Controller (Admin only)
// =============================================

exports.activateAccount = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const normalizedEmail = normalizeEmail(email);
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    await user.activateAccount();

    res.status(200).json({
      message: "Account activated successfully",
    });
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// =============================================
// Get Account Status Controller
// =============================================

exports.getAccountStatus = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const user = await User.findById(userId).select('-password -refreshToken -resetPasswordToken -verificationToken');

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isVerified: user.isVerified,
        isActive: user.isActive,
        lastLoginAt: user.lastLoginAt,
        isLocked: user.isAccountLocked(),
        failedLoginAttempts: user.failedLoginAttempts,
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};