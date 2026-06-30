const express = require("express");

const router = express.Router();

const {
  createApplication,
  getApplications,
} = require("../controllers/applicationController");
const { protect } = require("../middleware/Auth");
const verifyRole = require("../middleware/verifyRole");

router.post("/", createApplication);
router.get("/", protect, verifyRole("admin"), getApplications);

module.exports = router;