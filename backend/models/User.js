const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      minlength: [2, "Name must be at least 2 characters"],
      maxlength: [50, "Name cannot exceed 50 characters"],
    },

    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      trim: true,
      lowercase: true,
      match: [
        /^\S+@\S+\.\S+$/,
        "Please enter a valid email",
      ],
    },

    // ===== MODIFIED: Enhanced Password Validation =====
    password: {
      type: String,
      required: [true, "Password is required"],
      validate: {
        validator: function(v) {
          return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/.test(v);
        },
        message: "Password must be 8+ characters with at least one uppercase, one lowercase, one number, and one special character (@$!%*?&)"
      }
    },

    // ===== NEW: Security Fields =====
    isVerified: {
      type: Boolean,
      default: false,
    },

    role: {
      type: String,
      enum: {
        values: ["student", "teacher", "staff", "admin"],
        message: "Invalid role selected",
      },
      default: "student",
    },

    // ===== NEW: Account Lockout Tracking =====
    failedLoginAttempts: {
      type: Number,
      default: 0,
    },

    lockoutUntil: {
      type: Date,
      default: null,
    },

    // ===== NEW: Last Login Tracking =====
    lastLoginAt: {
      type: Date,
      default: null,
    },

    // ===== NEW: Account Status =====
    isActive: {
      type: Boolean,
      default: true,
    },

    deactivatedAt: {
      type: Date,
      default: null,
    },

    deactivationReason: {
      type: String,
      default: null,
    },

    // ===== NEW: Refresh Token =====
    refreshToken: {
      type: String,
      default: null,
    },

    // ===== NEW: Email Resend Cooldown =====
    lastVerificationEmailSent: {
      type: Date,
      default: null,
    },

    // ===== Existing Token Fields =====
    resetPasswordToken: {
      type: String,
      default: null,
    },

    resetPasswordExpires: {
      type: Date,
      default: null,
    },

    verificationToken: {
      type: String,
      default: null,
    },

    verificationTokenExpiry: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// ===== NEW: MongoDB Indexes for Performance =====
userSchema.index({ email: 1 });
userSchema.index({ isActive: 1 });
userSchema.index({ role: 1 });
userSchema.index({ createdAt: -1 });

// ===== NEW: Utility Methods =====

// Check if account is locked
userSchema.methods.isAccountLocked = function() {
  if (!this.lockoutUntil) return false;
  return this.lockoutUntil > new Date();
};

// Check if account is active
userSchema.methods.isAccountActive = function() {
  return this.isActive === true;
};

// Increment failed login attempts
userSchema.methods.incrementFailedAttempts = function() {
  this.failedLoginAttempts += 1;
  if (this.failedLoginAttempts >= 5) {
    this.lockoutUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
  }
  return this.save();
};

// Reset failed login attempts
userSchema.methods.resetFailedAttempts = function() {
  this.failedLoginAttempts = 0;
  this.lockoutUntil = null;
  return this.save();
};

// Update last login
userSchema.methods.updateLastLogin = function() {
  this.lastLoginAt = new Date();
  return this.save();
};

// Deactivate account
userSchema.methods.deactivate = function(reason = "User requested") {
  this.isActive = false;
  this.deactivatedAt = new Date();
  this.deactivationReason = reason;
  this.refreshToken = null;
  return this.save();
};

// Reactivate account
userSchema.methods.reactivate = function() {
  this.isActive = true;
  this.deactivatedAt = null;
  this.deactivationReason = null;
  this.failedLoginAttempts = 0;
  this.lockoutUntil = null;
  return this.save();
};

// Check email resend cooldown (5 minutes)
userSchema.methods.canResendVerificationEmail = function() {
  if (!this.lastVerificationEmailSent) return true;
  const cooldown = 5 * 60 * 1000; // 5 minutes
  return (Date.now() - this.lastVerificationEmailSent.getTime()) > cooldown;
};

// Update verification email timestamp
userSchema.methods.updateVerificationEmailSent = function() {
  this.lastVerificationEmailSent = new Date();
  return this.save();
};

module.exports = mongoose.model("User", userSchema);