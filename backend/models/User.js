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

    password: {
      type: String,
      required: [true, "Password is required"],
      validate: {
        validator: function(v) {
          return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/.test(v);
        },
        message: "Password must be 8+ characters with uppercase, lowercase, number and special character (@$!%*?&)"
      }
    },

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

    // =============================================
    // SECURITY FIELDS
    // =============================================
    failedLoginAttempts: {
      type: Number,
      default: 0,
    },

    accountLockedUntil: {
      type: Date,
      default: null,
    },

    refreshToken: {
      type: String,
      default: null,
    },

    lastLoginAt: {
      type: Date,
      default: null,
    },

    lastLoginIP: {
      type: String,
      default: null,
    },

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

    lastPasswordChangeAt: {
      type: Date,
      default: null,
    },

    emailResendCooldown: {
      type: Date,
      default: null,
    },

    passwordHistory: {
      type: [String],
      default: [],
      maxlength: 5,
    },

    securityLogs: [
      {
        event: {
          type: String,
          enum: ["login", "logout", "password_change", "email_verification", "account_lockout", "account_deactivation"],
        },
        timestamp: {
          type: Date,
          default: Date.now,
        },
        ip: String,
        userAgent: String,
      },
    ],
  },
  {
    timestamps: true,
  }
);

// =============================================
// INDEXES FOR PERFORMANCE
// =============================================
userSchema.index({ email: 1 });
userSchema.index({ role: 1 });
userSchema.index({ isVerified: 1 });
userSchema.index({ isActive: 1 });
userSchema.index({ resetPasswordToken: 1 });
userSchema.index({ verificationToken: 1 });
userSchema.index({ accountLockedUntil: 1 });

// =============================================
// INSTANCE METHODS
// =============================================

// Check if account is locked
userSchema.methods.isAccountLocked = function() {
  if (!this.accountLockedUntil) return false;
  return this.accountLockedUntil > Date.now();
};

// Get remaining lock time in minutes
userSchema.methods.getRemainingLockTime = function() {
  if (!this.isAccountLocked()) return 0;
  return Math.ceil((this.accountLockedUntil - Date.now()) / 60000);
};

// Increment failed login attempts
userSchema.methods.incrementFailedAttempts = async function() {
  this.failedLoginAttempts = (this.failedLoginAttempts || 0) + 1;

  if (this.failedLoginAttempts >= 5) {
    this.accountLockedUntil = new Date(Date.now() + 15 * 60 * 1000);
    this.failedLoginAttempts = 0;

    this.securityLogs.push({
      event: "account_lockout",
      timestamp: new Date(),
    });
  }

  await this.save();
  return this;
};

// Reset failed attempts on successful login
userSchema.methods.resetFailedAttempts = async function(ip, userAgent) {
  this.failedLoginAttempts = 0;
  this.accountLockedUntil = null;
  this.lastLoginAt = new Date();
  this.lastLoginIP = ip;

  this.securityLogs.push({
    event: "login",
    ip: ip,
    userAgent: userAgent,
  });

  await this.save();
  return this;
};

// Update refresh token
userSchema.methods.updateRefreshToken = async function(token) {
  this.refreshToken = token;
  await this.save();
  return this;
};

// Clear refresh token
userSchema.methods.clearRefreshToken = async function() {
  this.refreshToken = null;
  await this.save();
  return this;
};

// Deactivate account
userSchema.methods.deactivateAccount = async function(reason) {
  this.isActive = false;
  this.deactivatedAt = new Date();
  this.deactivationReason = reason;
  this.refreshToken = null;

  this.securityLogs.push({
    event: "account_deactivation",
    timestamp: new Date(),
  });

  await this.save();
  return this;
};

// Activate account
userSchema.methods.activateAccount = async function() {
  this.isActive = true;
  this.deactivatedAt = null;
  this.deactivationReason = null;
  await this.save();
  return this;
};

// Check if email resend is allowed (cooldown: 5 minutes)
userSchema.methods.canResendEmail = function() {
  if (!this.emailResendCooldown) return true;
  return Date.now() - this.emailResendCooldown > 5 * 60 * 1000;
};

// Update email resend cooldown
userSchema.methods.updateEmailCooldown = async function() {
  this.emailResendCooldown = new Date();
  await this.save();
  return this;
};

// =============================================
// STATIC METHODS
// =============================================

// Find active users only
userSchema.statics.findActive = function() {
  return this.find({ isActive: true });
};

// Find users by role
userSchema.statics.findByRole = function(role) {
  return this.find({ role: role, isActive: true });
};

// Get locked accounts
userSchema.statics.getLockedAccounts = function() {
  return this.find({
    accountLockedUntil: { $gt: new Date() },
  });
};

module.exports = mongoose.model("User", userSchema);