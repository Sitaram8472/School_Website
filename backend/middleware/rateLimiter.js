const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: (process.env.RATE_LIMIT_LOGIN_WINDOW || 15) * 60 * 1000,
  max: process.env.RATE_LIMIT_LOGIN_MAX || 5,
  message: { error: 'Too many login attempts. Please try again after 15 minutes.' },
});

const registerLimiter = rateLimit({
  windowMs: (process.env.RATE_LIMIT_REGISTER_WINDOW || 60) * 60 * 1000,
  max: process.env.RATE_LIMIT_REGISTER_MAX || 3,
  message: { error: 'Too many registration attempts. Please try again after an hour.' },
});

const forgotPasswordLimiter = rateLimit({
  windowMs: (process.env.RATE_LIMIT_FORGOT_PASSWORD_WINDOW || 60) * 60 * 1000,
  max: process.env.RATE_LIMIT_FORGOT_PASSWORD_MAX || 3,
  message: { error: 'Too many forgot password attempts. Please try again after an hour.' },
});

const resendVerificationLimiter = rateLimit({
  windowMs: (process.env.RATE_LIMIT_RESEND_VERIFICATION_WINDOW || 60) * 60 * 1000,
  max: process.env.RATE_LIMIT_RESEND_VERIFICATION_MAX || 3,
  message: { error: 'Too many verification attempts. Please try again after an hour.' },
});

const refreshTokenLimiter = rateLimit({
  windowMs: (process.env.RATE_LIMIT_REFRESH_TOKEN_WINDOW || 15) * 60 * 1000,
  max: process.env.RATE_LIMIT_REFRESH_TOKEN_MAX || 10,
  message: { error: 'Too many refresh attempts. Please try again after 15 minutes.' },
});

module.exports = {
  loginLimiter,
  registerLimiter,
  forgotPasswordLimiter,
  resendVerificationLimiter,
  refreshTokenLimiter,
};