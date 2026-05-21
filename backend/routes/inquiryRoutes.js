const express = require("express");
const router = express.Router();
const { createInquiry } = require("../controllers/inquiryController.js");

router.post("/", createInquiry);

module.exports = router;