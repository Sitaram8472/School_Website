const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const sendEmail = require("../utils/sendEmail");

// ===== Account Lockout System (in-memory fallback) =====
const failedAttempts = new Map();

// ===== Email Cooldown System (in-memory fallback) =====
const emailCooldown = new Map();

const normalizeEmail = (email) => {
  return email?.trim().toLowerCase();
};

// ===== Password Validation Function =====
const validatePassword = (password) => {
  const regex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
  return regex.test(password);
};

// ===== Account Lockout Check (fallback) =====
const checkAccountLockout = (email) => {
  const attempts = failedAttempts.get(email);
  if (attempts && attempts.count >= 5) {
    const lockoutTime = attempts.lockoutTime || 0;
    if (Date.now() - lockoutTime < 15 * 60 * 1000) {
      return true;
    } else {
      failedAttempts.delete(email);
    }
  }
  return false;
};

// ===== Record Failed Attempt (fallback) =====
const recordFailedAttempt = (email) => {
  const attempts = failedAttempts.get(email) || { count: 0 };
  attempts.count += 1;
  if (attempts.count >= 5) {
    attempts.lockoutTime = Date.now();
  }
  failedAttempts.set(email, attempts);
};

// ===== Email Cooldown Check (fallback) =====
const checkEmailCooldown = (email) => {
  const lastSent = emailCooldown.get(email);
  if (lastSent && Date.now() - lastSent < 5 * 60 * 1000) {
    return true;
  }
  emailCooldown.set(email, Date.now());
  return false;
};

// ============================================
// REGISTER
// ============================================
exports.register = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    const normalizedEmail = normalizeEmail(email);

    // ===== Input Sanitization (XSS Protection) =====
    const sanitizedName = name?.trim().replace(/[<>]/g, '');
    if (!sanitizedName || sanitizedName.length < 2) {
      return res.status(400).json({ message: "Valid name is required (minimum 2 characters)" });
    }

    let user = await User.findOne({
      email: normalizedEmail
    });
    if (user) return res.status(400).json({ message: "User already exists" });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: "Invalid email format" });
    }

    // ===== MODIFIED: Password Strength Validation =====
    if (!validatePassword(password)) {
      return res.status(400).json({
        message: "Password must be at least 8 characters and contain at least one uppercase, one lowercase, one number, and one special character (@$!%*?&)"
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
    const hashedToken = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");

    user.verificationToken = hashedToken;
    user.verificationTokenExpiry = Date.now() + 24 * 60 * 60 * 1000;
    await user.save();

    const verifyUrl = `${process.env.CLIENT_URL || process.env.FRONTEND_URL || "http://localhost:5173"
      }/verify-email/${rawToken}`;

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
      message:
        "Registration successful. Please check your inbox to verify your account before logging in.",
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

// ============================================
// LOGIN
// ============================================
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = normalizeEmail(email);

    // ===== Check in-memory lockout =====
    if (checkAccountLockout(normalizedEmail)) {
      return res.status(403).json({
        message: "Account is temporarily locked. Please try again after 15 minutes."
      });
    }

    const user = await User.findOne({
      email: normalizedEmail
    });
    if (!user) {
      recordFailedAttempt(normalizedEmail);
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // ===== NEW: Check if account is active =====
    if (user.isActive === false) {
      return res.status(403).json({
        message: "Account is deactivated. Please contact support."
      });
    }

    // ===== NEW: Check model-based lockout =====
    if (user.isAccountLocked && user.isAccountLocked()) {
      const minutesLeft = Math.ceil((user.lockoutUntil - new Date()) / 60000);
      return res.status(403).json({
        message: `Account is locked. Please try again after ${minutesLeft} minutes.`
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      // ===== NEW: Use model method =====
      if (user.incrementFailedAttempts) {
        await user.incrementFailedAttempts();
      } else {
        recordFailedAttempt(normalizedEmail);
      }
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // ===== NEW: Reset failed attempts =====
    if (user.resetFailedAttempts) {
      await user.resetFailedAttempts();
    }
    failedAttempts.delete(normalizedEmail);

    // ===== NEW: Update last login =====
    if (user.updateLastLogin) {
      await user.updateLastLogin();
    }

    if (!user.isVerified) {
      return res.status(403).json({
        message: "Please verify your email to log in",
        needsVerification: true,
      });
    }

    // ===== Generate Tokens =====
    const token = jwt.sign(
      { id: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    const refreshToken = jwt.sign(
      { id: user._id, email: user.email },
      process.env.REFRESH_TOKEN_SECRET || "your_refresh_secret_key",
      { expiresIn: "7d" }
    );

    user.refreshToken = refreshToken;
    await user.save();

    res
      .cookie("token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 900000,
      })
      .cookie("refreshToken", refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      })
      .status(200)
      .json({
        message: "Login successful",
        token,
        refreshToken,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          lastLoginAt: user.lastLoginAt,
        },
      });
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// ============================================
// LOGOUT
// ============================================
exports.logout = async (req, res) => {
  try {
    const token = req.cookies?.token;
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded?.id) {
          await User.findByIdAndUpdate(decoded.id, { refreshToken: null });
        }
      } catch (err) {
        // Token invalid, continue
      }
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
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// ============================================
// FORGOT PASSWORD
// ============================================
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const normalizedEmail = normalizeEmail(email);

    const user = await User.findOne({
      email: normalizedEmail
    });

    if (!user) {
      return res
        .status(200)
        .json({
          message: "If that email is registered, a reset link has been sent.",
        });
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");

    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = Date.now() + 3600000;
    await user.save();

    const frontendUrl =
      process.env.CLIENT_URL || process.env.FRONTEND_URL || "http://localhost:5173";
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

    res
      .status(200)
      .json({ message: "If that email is registered, a reset link has been sent." });
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// ============================================
// RESET PASSWORD
// ============================================
exports.resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res
        .status(400)
        .json({ message: "Token and new password are required." });
    }

    if (!validatePassword(password)) {
      return res.status(400).json({
        message: "Password must be at least 8 characters and contain at least one uppercase, one lowercase, one number, and one special character (@$!%*?&)"
      });
    }

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res
        .status(400)
        .json({
          message:
            "Reset link is invalid or has expired. Please request a new one.",
        });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    user.refreshToken = null;
    await user.save();

    res.status(200).json({
      message: "Password reset successfully. You can now log in with your new password.",
    });
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// ============================================
// VERIFY EMAIL
// ============================================
exports.verifyEmail = async (req, res) => {
  try {
    const hashedToken = crypto
      .createHash("sha256")
      .update(req.params.token)
      .digest("hex");

    const user = await User.findOne({
      verificationToken: hashedToken,
      verificationTokenExpiry: { $gt: Date.now() },
    });

    if (!user) {
      return res
        .status(400)
        .json({ message: "Verification link is invalid or has expired." });
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

// ============================================
// RESEND VERIFICATION
// ============================================
exports.resendVerification = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const normalizedEmail = normalizeEmail(email);

    // ===== Check in-memory cooldown =====
    if (checkEmailCooldown(normalizedEmail)) {
      return res.status(429).json({
        message: "Please wait 5 minutes before requesting another verification email."
      });
    }

    const user = await User.findOne({
      email: normalizedEmail
    });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.isVerified) {
      return res.status(400).json({ message: "Email is already verified" });
    }

    // ===== Use model method if available =====
    if (user.canResendVerificationEmail && !user.canResendVerificationEmail()) {
      return res.status(429).json({
        message: "Please wait 5 minutes before requesting another verification email."
      });
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");

    user.verificationToken = hashedToken;
    user.verificationTokenExpiry = Date.now() + 24 * 60 * 60 * 1000;

    if (user.updateVerificationEmailSent) {
      await user.updateVerificationEmailSent();
    }
    await user.save();

    const verifyUrl = `${process.env.CLIENT_URL || process.env.FRONTEND_URL || "http://localhost:5173"
      }/verify-email/${rawToken}`;

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

// ============================================
// REFRESH TOKEN
// ============================================
exports.refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(401).json({
        success: false,
        message: 'Refresh token required'
      });
    }

    const decoded = jwt.verify(
      refreshToken,
      process.env.REFRESH_TOKEN_SECRET || "your_refresh_secret_key"
    );

    const user = await User.findById(decoded.id);

    if (!user || user.refreshToken !== refreshToken) {
      return res.status(403).json({
        success: false,
        message: 'Invalid refresh token'
      });
    }

    // ===== Check if account is active =====
    if (user.isActive === false) {
      return res.status(403).json({
        success: false,
        message: 'Account is deactivated'
      });
    }

    const newAccessToken = jwt.sign(
      { id: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    res.json({
      success: true,
      accessToken: newAccessToken
    });

  } catch (error) {
    res.status(403).json({
      success: false,
      message: 'Invalid refresh token'
    });
  }
};