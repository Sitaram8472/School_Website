const express = require('express');
const router = express.Router();
const noticeController = require('../controllers/noticeController');

// Define the GET request path
router.get('/', noticeController.getNotices);
// Define the POST request path
router.post('/', noticeController.createNotice);

module.exports = router;