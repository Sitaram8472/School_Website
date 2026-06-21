const validateEnv = () => {
  const errors = [];
  const warnings = [];

  // ─── Required Variables ───────────────────────────────────────────
  const requiredVars = {
    MONGO_URL: process.env.MONGO_URL,
    JWT_SECRET: process.env.JWT_SECRET,
  };

  const placeholders = [
    "your_jwt_secret_key_here",
    "your_email@gmail.com",
    "your_gmail_app_password",
  ];

  for (const [key, value] of Object.entries(requiredVars)) {
    if (!value || placeholders.includes(value)) {
      errors.push(`❌ Missing or placeholder value: ${key}`);
    }
  }

  // ─── Optional Variables ───────────────────────────────────────────
  const optionalVars = ["EMAIL_SERVICE", "EMAIL_USER", "EMAIL_PASS", "FRONTEND_URL"];

  for (const key of optionalVars) {
    const value = process.env[key];
    if (!value || placeholders.includes(value)) {
      warnings.push(`⚠️  Optional var not set: ${key}`);
    }
  }

  // ─── Output ───────────────────────────────────────────────────────
  if (warnings.length > 0) {
    console.warn("\n[ENV] Warnings:");
    warnings.forEach((w) => console.warn(" ", w));
  }

  if (errors.length > 0) {
    console.error("\n[ENV] Critical errors — server cannot start:");
    errors.forEach((e) => console.error(" ", e));
    process.exit(1);
  }

  console.log("✅ Environment variables validated successfully.\n");
};

module.exports = validateEnv;