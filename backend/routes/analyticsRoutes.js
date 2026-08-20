const express = require('express');
const router = express.Router();
const { getAnalyticsOverview } = require('../controllers/analyticsController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// All analytics routes require auth and admin/staff role
router.use(protect);
router.use(verifyRole('admin', 'staff'));

router.get('/overview', getAnalyticsOverview);

module.exports = router;
