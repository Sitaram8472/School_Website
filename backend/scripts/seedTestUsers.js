/**
 * Seed test accounts for RBAC testing.
 * Run: node scripts/seedTestUsers.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../models/User");

const TEST_USERS = [
  { name: "Test Student", email: "student@test.com", password: "test123", role: "student" },
  { name: "Test Teacher", email: "teacher@test.com", password: "test123", role: "teacher" },
  { name: "Test Teacher 2", email: "teacher2@test.com", password: "test123", role: "teacher" },
  { name: "Test Admin", email: "admin@test.com", password: "test123", role: "admin" },
];

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URL);

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash("test123", salt);

  for (const account of TEST_USERS) {
    const existing = await User.findOne({ email: account.email });

    if (existing) {
      existing.name = account.name;
      existing.role = account.role;
      existing.password = hashedPassword;
      existing.isVerified = true;
      await existing.save();
      console.log(`Updated: ${account.email} (${account.role})`);
    } else {
      await User.create({
        ...account,
        password: hashedPassword,
        isVerified: true,
      });
      console.log(`Created: ${account.email} (${account.role})`);
    }
  }

  console.log("\nAll test accounts use password: test123");
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
