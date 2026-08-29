const express = require("express");
const router = express.Router();
const reportController = require("../controllers/reportController");
const { protect } = require("../middleware/Auth");
const verifyRole = require("../middleware/verifyRole");

// Year-end progression — whether a student moves up, repeats, or moves up with
// conditions. A static prefix declared above `/student/:id`, so none of its
// segments is ever read as a student id.
router.use("/progression", require("./progressionRoutes"));

// Route to get a student's report card PDF
// Students can access their own, teachers/admins can access any
router.get(
  "/student/:id",
  protect,
  verifyRole("student", "teacher", "admin"),
  reportController.generateReportCard
);

module.exports = router;
