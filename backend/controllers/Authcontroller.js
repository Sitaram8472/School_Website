const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const sendEmail = require("../utils/sendEmail");

exports.register = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ message: "User already exists" });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: "Invalid email format" });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ message: "Password must be at least 6 characters" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    if (role && !["student", "teacher"].includes(role)) {
      return res.status(403).json({ message: "Invalid role" });
    }

    const userRole = ["student", "teacher"].includes(role) ? role : "student";

    user = await User.create({
      name,
      email,
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

    const verifyUrl = `${
      process.env.CLIENT_URL || process.env.FRONTEND_URL || "http://localhost:5173"
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

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch)
      return res.status(400).json({ message: "Invalid credentials" });

    if (!user.isVerified) {
      return res.status(403).json({
        message: "Please verify your email to log in",
        needsVerification: true,
      });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });

    res
      .cookie("token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 3600000,
      })
      .status(200)
      .json({
        message: "Login successful",
        token,
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

exports.logout = (req, res) => {
  res
    .clearCookie("token", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
    })
    .status(200)
    .json({ message: "Logout successful" });
};

exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });

    // Return same message regardless of whether email exists (prevents enumeration)
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

exports.resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res
        .status(400)
        .json({ message: "Token and new password are required." });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ message: "Password must be at least 6 characters." });
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
    await user.save();

    res.status(200).json({
      message: "Password reset successfully. You can now log in with your new password.",
    });
  } catch (error) {
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

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

exports.resendVerification = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.isVerified) {
      return res.status(400).json({ message: "Email is already verified" });
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");

    user.verificationToken = hashedToken;
    user.verificationTokenExpiry = Date.now() + 24 * 60 * 60 * 1000;
    await user.save();

    const verifyUrl = `${
      process.env.CLIENT_URL || process.env.FRONTEND_URL || "http://localhost:5173"
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
