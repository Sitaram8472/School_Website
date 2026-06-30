const express = require('express');
const router = express.Router();
const noticeController = require('../controllers/noticeController');
const { protect, optionalProtect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

router.get('/', optionalProtect, noticeController.getNotices);

// Protected routes for managing notices
router.post('/', protect, verifyRole('teacher', 'admin'), noticeController.createNotice);
router.put('/:id', protect, verifyRole('teacher', 'admin'), noticeController.updateNotice);
router.patch('/:id', protect, verifyRole('teacher', 'admin'), noticeController.updateNotice);

// Scheduling routes
router.patch('/:id/schedule', protect, verifyRole('teacher', 'admin'), noticeController.scheduleNotice);
router.patch('/schedule/:id', protect, verifyRole('teacher', 'admin'), noticeController.scheduleNotice);

// Cancel scheduling routes
router.patch('/:id/cancel', protect, verifyRole('teacher', 'admin'), noticeController.cancelSchedule);
router.patch('/cancel/:id', protect, verifyRole('teacher', 'admin'), noticeController.cancelSchedule);

// Archive routes
router.patch('/:id/archive', protect, verifyRole('teacher', 'admin'), noticeController.archiveNotice);
router.patch('/archive/:id', protect, verifyRole('teacher', 'admin'), noticeController.archiveNotice);

module.exports = router;