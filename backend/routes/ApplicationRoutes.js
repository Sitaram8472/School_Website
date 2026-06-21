const express = require("express");

const router = express.Router();

const {
  createApplication,
  getApplications,
} = require("../controllers/applicationController");

router.post("/", createApplication);
router.get("/", getApplications);

module.exports = router;