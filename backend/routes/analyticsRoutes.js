const express = require('express');
const router = express.Router();
const { getAnalyticsOverview } = require('../controllers/analyticsController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// All analytics routes require auth and admin/staff role
router.use(protect);
router.use(verifyRole('admin', 'staff'));

router.get('/overview', getAnalyticsOverview);

// --- KPI targets -------------------------------------------------------------
// The router above already applies `protect` and `verifyRole('admin', 'staff')`,
// so the read side inherits the right audience and only the write side needs
// narrowing to admin. Every segment here is static, so nothing collides with a
// future `/:id` route on this file.
const kpiTargetController = require('../controllers/kpiTargetController');

router.get('/targets/meta', kpiTargetController.getTargetMeta);
router.get('/targets/scoreboard', kpiTargetController.getScoreboard);

router.get('/targets', kpiTargetController.listTargets);
router.post('/targets', verifyRole('admin'), kpiTargetController.createTarget);

router.get('/targets/:id', kpiTargetController.getTarget);

// Editing is only ever possible on a draft; the handler says so rather than
// returning a bare 403, because the reason is the feature.
router.patch('/targets/:id', verifyRole('admin'), kpiTargetController.updateTarget);
router.patch('/targets/:id/activate', verifyRole('admin'), kpiTargetController.activateTarget);

// One-way. A corrected figure is a new target that supersedes this one.
router.patch('/targets/:id/certify', verifyRole('admin'), kpiTargetController.certifyTarget);
router.patch('/targets/:id/abandon', verifyRole('admin'), kpiTargetController.abandonTarget);

module.exports = router;
