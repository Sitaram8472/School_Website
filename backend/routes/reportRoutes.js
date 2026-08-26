const express = require("express");
const router = express.Router();
const reportController = require("../controllers/reportController");
const { protect } = require("../middleware/Auth");
const verifyRole = require("../middleware/verifyRole");

// Route to get a student's report card PDF
// Students can access their own, teachers/admins can access any
router.get(
  "/student/:id",
  protect,
  verifyRole("student", "teacher", "admin"),
  reportController.generateReportCard
);

// --- Report card releases ----------------------------------------------------
// A report card is generated on demand from whatever is in the database at that
// instant. These routes add the decision around it: when a class's reports may
// be handed over, and to whom.
//
// The controller is a separate file because reportController.js has open
// changes against it. The existing /student/:id route is deliberately untouched
// — the gate is exported as ReportRelease.visibilityFor and adopting it there is
// a three-line follow-up once that change lands.
const releases = require("../controllers/reportReleaseController");

// The existing route is "/student/:id", which is itself behind a static
// segment, so nothing here can be swallowed by it. Within this block the static
// segments still come before "/releases/:id" for the same reason.
router.get("/releases/meta", protect, verifyRole("teacher", "admin"), releases.getReleaseMeta);
router.get("/releases/roll", protect, verifyRole("teacher", "admin"), releases.getRoll);

// The gated student-facing read path. A student asks only about themselves.
router.get(
  "/releases/mine",
  protect,
  verifyRole("student", "teacher", "admin"),
  releases.getMyReleaseStatus
);

router.get("/releases", protect, verifyRole("teacher", "admin"), releases.listReleases);

// Teachers assemble the run and place holds; only an admin decides it goes out.
// The person who prepared the reports is not the person who releases them.
router.post("/releases", protect, verifyRole("teacher", "admin"), releases.prepareRelease);
router.get("/releases/:id", protect, verifyRole("teacher", "admin"), releases.getRelease);

router.patch(
  "/releases/:id/entries/:studentId/hold",
  protect,
  verifyRole("teacher", "admin"),
  releases.holdEntry
);
router.patch(
  "/releases/:id/entries/:studentId/lift",
  protect,
  verifyRole("teacher", "admin"),
  releases.liftHold
);

router.patch("/releases/:id/release", protect, verifyRole("admin"), releases.releaseRun);
router.patch("/releases/:id/withdraw", protect, verifyRole("admin"), releases.withdrawRun);

// A correction is a new run that supersedes the old one, never an edit to the
// version a family already has.
router.post("/releases/:id/revise", protect, verifyRole("admin"), releases.reviseRun);

module.exports = router;
