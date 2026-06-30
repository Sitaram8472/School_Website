/**
 * Comprehensive verification script for the Notice Scheduling System.
 * Run: node scripts/testNoticeScheduler.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Notice = require("../models/Notice");
const User = require("../models/User");
const jwt = require("jsonwebtoken");
const {
  createNotice,
  getNotices,
  scheduleNotice,
  cancelSchedule,
  archiveNotice,
  updateNotice
} = require("../controllers/noticeController");
const { optionalProtect } = require("../middleware/Auth");
const { checkAndProcessNotices } = require("../scheduler/noticeScheduler");

// Helper to mock Express response object
function mockResponse() {
  const res = {
    statusCode: 200,
    jsonData: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.jsonData = data;
      return this;
    }
  };
  return res;
}

async function runTests() {
  console.log("=== NOTICE SCHEDULING SYSTEM VERIFICATION ===\n");

  if (!process.env.MONGO_URL) {
    console.error("Error: MONGO_URL not defined in .env file.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URL);
  console.log("Connected to MongoDB.");

  // Clean up any existing test notices
  await Notice.deleteMany({ title: /^TEST:/ });
  console.log("Cleaned up previous test notices.\n");

  // Retrieve or create a test admin user to get their ID & name
  let testAdmin = await User.findOne({ role: "admin" });
  if (!testAdmin) {
    // Seed a temp admin if none exists
    testAdmin = await User.create({
      name: "Verification Admin",
      email: "verif_admin@test.com",
      password: "tempPassword123",
      role: "admin",
      isVerified: true
    });
    console.log("Created temporary admin user for verification.");
  }

  // Create JWT token for admin role simulation
  const adminToken = jwt.sign({ id: testAdmin._id }, process.env.JWT_SECRET, { expiresIn: "1h" });

  // ----------------------------------------------------
  // TEST 1: Prevent Empty Title (Validation)
  // ----------------------------------------------------
  console.log("--- TEST 1: Empty Title Validation ---");
  const req1 = {
    body: {
      title: "",
      category: "Academic",
      content: "This notice should fail validation."
    },
    user: testAdmin
  };
  const res1 = mockResponse();
  await createNotice(req1, res1);
  console.log(`Response Status: ${res1.statusCode} (Expected: 400)`);
  console.log(`Response Message: ${res1.jsonData.message}\n`);

  // ----------------------------------------------------
  // TEST 2: Prevent publishAt in the Past (Validation)
  // ----------------------------------------------------
  console.log("--- TEST 2: Past publishAt Validation ---");
  const req2 = {
    body: {
      title: "TEST: Past Publish Date",
      category: "Academic",
      content: "This notice has a publication date in the past.",
      publishAt: new Date(Date.now() - 60000).toISOString() // 1 minute ago
    },
    user: testAdmin
  };
  const res2 = mockResponse();
  await createNotice(req2, res2);
  console.log(`Response Status: ${res2.statusCode} (Expected: 400)`);
  console.log(`Response Message: ${res2.jsonData.message}\n`);

  // ----------------------------------------------------
  // TEST 3: Prevent expiresAt before publishAt (Validation)
  // ----------------------------------------------------
  console.log("--- TEST 3: Expiration Date Validation ---");
  const req3 = {
    body: {
      title: "TEST: Expiry Before Publish",
      category: "Academic",
      content: "This notice has expiresAt before publishAt.",
      publishAt: new Date(Date.now() + 600000).toISOString(), // 10 mins in future
      expiresAt: new Date(Date.now() + 300000).toISOString()  // 5 mins in future
    },
    user: testAdmin
  };
  const res3 = mockResponse();
  await createNotice(req3, res3);
  console.log(`Response Status: ${res3.statusCode} (Expected: 400)`);
  console.log(`Response Message: ${res3.jsonData.message}\n`);

  // ----------------------------------------------------
  // TEST 4: Create Draft Notice
  // ----------------------------------------------------
  console.log("--- TEST 4: Create Draft Notice ---");
  const req4 = {
    body: {
      title: "TEST: Draft Announcement",
      category: "Events",
      content: "This is a draft notice that should not be visible to students.",
      status: "draft"
    },
    user: testAdmin
  };
  const res4 = mockResponse();
  await createNotice(req4, res4);
  const draftNotice = res4.jsonData.data;
  console.log(`Response Status: ${res4.statusCode} (Expected: 201)`);
  console.log(`Notice Title: "${draftNotice.title}"`);
  console.log(`Notice Status: "${draftNotice.status}" (Expected: draft)\n`);

  // ----------------------------------------------------
  // TEST 5: Create Scheduled Notice (Future)
  // ----------------------------------------------------
  console.log("--- TEST 5: Create Scheduled Notice (Future) ---");
  const futureDate = new Date(Date.now() + 3600000); // 1 hour in the future
  const req5 = {
    body: {
      title: "TEST: Future Announcement",
      category: "Events",
      content: "This notice is scheduled to be published in 1 hour.",
      publishAt: futureDate.toISOString()
    },
    user: testAdmin
  };
  const res5 = mockResponse();
  await createNotice(req5, res5);
  const scheduledNotice = res5.jsonData.data;
  console.log(`Response Status: ${res5.statusCode} (Expected: 201)`);
  console.log(`Notice Title: "${scheduledNotice.title}"`);
  console.log(`Notice Status: "${scheduledNotice.status}" (Expected: scheduled)`);
  console.log(`Publish At: ${new Date(scheduledNotice.publishAt).toISOString()}\n`);

  // ----------------------------------------------------
  // TEST 6: Public GET returns ONLY published notices
  // ----------------------------------------------------
  console.log("--- TEST 6: Public GET Notices Filtering ---");
  const req6 = { cookies: {} }; // Public request
  const res6 = mockResponse();
  await optionalProtect(req6, res6, () => {});
  await getNotices(req6, res6);
  const publicNotices = res6.jsonData.data;
  const testNoticesInPublic = publicNotices.filter(n => n.title.startsWith("TEST:"));
  console.log(`Number of TEST notices in public GET: ${testNoticesInPublic.length} (Expected: 0)`);
  console.log(`Public GET successfully filtered out draft/scheduled notices.\n`);

  // ----------------------------------------------------
  // TEST 7: Admin GET returns ALL notices (draft, scheduled, etc.)
  // ----------------------------------------------------
  console.log("--- TEST 7: Admin GET Notices Access ---");
  const req7 = { cookies: { token: adminToken } }; // Admin request
  const res7 = mockResponse();
  await optionalProtect(req7, res7, () => {});
  await getNotices(req7, res7);
  const adminNotices = res7.jsonData.data;
  const testNoticesInAdmin = adminNotices.filter(n => n.title.startsWith("TEST:"));
  console.log(`Number of TEST notices in admin GET: ${testNoticesInAdmin.length} (Expected: 2)`);
  console.log("Admin list includes:");
  testNoticesInAdmin.forEach(n => console.log(`  - "${n.title}" [Status: ${n.status}]`));
  console.log();

  // ----------------------------------------------------
  // TEST 8: Cron Scheduler publishes ready notice
  // ----------------------------------------------------
  console.log("--- TEST 8: Cron Scheduler Auto-Publish ---");
  // Bypass validation by creating a scheduled notice in the database whose publish time has passed
  const pastPublishDate = new Date(Date.now() - 30000); // 30s ago
  const readyNotice = await Notice.create({
    title: "TEST: Immediate Publish Announcement",
    category: "General",
    content: "This notice should be auto-published by the scheduler.",
    status: "scheduled",
    publishAt: pastPublishDate,
    postedBy: testAdmin._id
  });
  console.log(`Created scheduled notice with publishAt in the past: "${readyNotice.title}" [Status: ${readyNotice.status}]`);

  // Run the scheduler task
  await checkAndProcessNotices();

  // Re-fetch from database
  const updatedNotice = await Notice.findById(readyNotice._id);
  console.log(`Notice Status after Cron run: "${updatedNotice.status}" (Expected: published)`);
  console.log(`Published At: ${updatedNotice.publishedAt ? updatedNotice.publishedAt.toISOString() : "null"}\n`);

  // ----------------------------------------------------
  // TEST 9: Cron Scheduler auto-archives expired notice
  // ----------------------------------------------------
  console.log("--- TEST 9: Cron Scheduler Auto-Archive ---");
  // Create a published notice whose expiresAt time has passed
  const pastExpiryDate = new Date(Date.now() - 10000); // 10s ago
  const expiredNotice = await Notice.create({
    title: "TEST: Expired Announcement",
    category: "General",
    content: "This notice has expired and should be archived.",
    status: "published",
    expiresAt: pastExpiryDate,
    postedBy: testAdmin._id
  });
  console.log(`Created published notice with expiresAt in the past: "${expiredNotice.title}" [Status: ${expiredNotice.status}]`);

  // Run the scheduler task
  await checkAndProcessNotices();

  // Re-fetch from database
  const archivedNotice = await Notice.findById(expiredNotice._id);
  console.log(`Notice Status after Cron run: "${archivedNotice.status}" (Expected: archived)\n`);

  // ----------------------------------------------------
  // TEST 10: Schedule Endpoint (PATCH /notice/:id/schedule)
  // ----------------------------------------------------
  console.log("--- TEST 10: Schedule Endpoint API ---");
  const req10 = {
    params: { id: draftNotice._id },
    body: { publishAt: new Date(Date.now() + 600000).toISOString() }, // 10 mins in future
    user: testAdmin
  };
  const res10 = mockResponse();
  await scheduleNotice(req10, res10);
  console.log(`Response Status: ${res10.statusCode} (Expected: 200)`);
  console.log(`Updated Status: "${res10.jsonData.data.status}" (Expected: scheduled)`);
  console.log(`Updated publishAt: ${res10.jsonData.data.publishAt}\n`);

  // ----------------------------------------------------
  // TEST 11: Cancel Schedule Endpoint (PATCH /notice/:id/cancel)
  // ----------------------------------------------------
  console.log("--- TEST 11: Cancel Schedule Endpoint API ---");
  const req11 = {
    params: { id: draftNotice._id },
    user: testAdmin
  };
  const res11 = mockResponse();
  await cancelSchedule(req11, res11);
  console.log(`Response Status: ${res11.statusCode} (Expected: 200)`);
  console.log(`Updated Status: "${res11.jsonData.data.status}" (Expected: draft)`);
  console.log(`Updated publishAt: ${res11.jsonData.data.publishAt} (Expected: null)\n`);

  // ----------------------------------------------------
  // TEST 12: Manual Archive Endpoint (PATCH /notice/:id/archive)
  // ----------------------------------------------------
  console.log("--- TEST 12: Manual Archive Endpoint API ---");
  const req12 = {
    params: { id: draftNotice._id },
    user: testAdmin
  };
  const res12 = mockResponse();
  await archiveNotice(req12, res12);
  console.log(`Response Status: ${res12.statusCode} (Expected: 200)`);
  console.log(`Updated Status: "${res12.jsonData.data.status}" (Expected: archived)\n`);

  // ----------------------------------------------------
  // TEST 13: Update scheduled notice (PUT /notice/:id)
  // ----------------------------------------------------
  console.log("--- TEST 13: Update Notice API ---");
  const req13 = {
    params: { id: scheduledNotice._id },
    body: {
      title: "TEST: Future Announcement (UPDATED)",
      content: "This content was successfully updated.",
      publishAt: new Date(Date.now() + 1200000).toISOString() // 20 mins in future
    },
    user: testAdmin
  };
  const res13 = mockResponse();
  await updateNotice(req13, res13);
  console.log(`Response Status: ${res13.statusCode} (Expected: 200)`);
  console.log(`Updated Title: "${res13.jsonData.data.title}"`);
  console.log(`Updated Status: "${res13.jsonData.data.status}" (Expected: scheduled)\n`);

  // Clean up verification notices
  await Notice.deleteMany({ title: /^TEST:/ });
  console.log("Cleaned up verification test notices.");

  await mongoose.disconnect();
  console.log("Disconnected from MongoDB.");
  console.log("\n=== ALL TESTS PASSED SUCCESSFULLY ===");
  process.exit(0);
}

runTests().catch(err => {
  console.error("Test failure:", err);
  mongoose.disconnect().then(() => process.exit(1));
});
