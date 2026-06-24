const express = require('express');
const router = express.Router();
const noticeController = require('../controllers/noticeController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

router.get('/', noticeController.getNotices);
router.post('/', protect, verifyRole('teacher', 'admin'), noticeController.createNotice);

module.exports = router;