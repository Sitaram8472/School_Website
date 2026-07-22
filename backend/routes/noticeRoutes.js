const express = require('express');
const router = express.Router();
const noticeController = require('../controllers/noticeController');
const { protect, optionalProtect } = require('../middleware/Auth');
const { checkPermission } = require('../middleware/rbacMiddleware');
const multiLevelCache = require('../middleware/cacheMiddleware');

router.get('/', optionalProtect, multiLevelCache(60), noticeController.getNotices);

// Protected routes for managing notices
router.post('/', protect, checkPermission('createAny', 'notice'), noticeController.createNotice);
router.put('/:id', protect, checkPermission('updateOwn', 'notice'), noticeController.updateNotice);
router.patch('/:id', protect, checkPermission('updateOwn', 'notice'), noticeController.updateNotice);

// Scheduling routes
router.patch('/:id/schedule', protect, checkPermission('updateOwn', 'notice'), noticeController.scheduleNotice);
router.patch('/schedule/:id', protect, checkPermission('updateOwn', 'notice'), noticeController.scheduleNotice);

// Cancel schedule
router.patch('/:id/cancel', protect, checkPermission('updateOwn', 'notice'), noticeController.cancelSchedule);
router.patch('/cancel/:id', protect, checkPermission('updateOwn', 'notice'), noticeController.cancelSchedule);

// Archive
router.patch('/:id/archive', protect, checkPermission('updateOwn', 'notice'), noticeController.archiveNotice);
router.patch('/archive/:id', protect, checkPermission('updateOwn', 'notice'), noticeController.archiveNotice);

module.exports = router;