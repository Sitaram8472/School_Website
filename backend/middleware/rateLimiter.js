const rateLimit = require("express-rate-limit");

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 5, 

    message: {
        success: false,
        message: "Too many login attempts. Please try again after 15 minutes."
    },

    standardHeaders: true,
    legacyHeaders: false,
});

module.exports = authLimiter;