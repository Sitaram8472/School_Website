const express = require('express');

const router = express.Router();
const { protect, optionalProtect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');
const reportController = require('../controllers/appealReportController');

/**
 * Published appeal outcome reports, mounted at /api/appeals/statistics.
 *
 * This router is mounted **above** the parent's `router.use(protect)`, because
 * published transparency figures have to be readable without a session — a
 * family deciding whether the appeals process is fair reads them before they
 * have an account, let alone an appeal. Nothing is inherited from the parent
 * as a result, so every route that is not deliberately public attaches
 * `protect` and a role guard itself.
 *
 * `optionalProtect` on the public reads exists so a signed-in admin browsing
 * the About page still gets `canManage` back from `/meta` rather than being
 * treated as an anonymous visitor.
 */

const staff = [protect, verifyRole('teacher', 'admin')];
const admin = [protect, verifyRole('admin')];

// --- Public -----------------------------------------------------------------
// Declared before `/:id` so none of these words is ever read as a report id.
router.get('/meta', optionalProtect, reportController.getMeta);
router.get('/published', optionalProtect, reportController.listPublished);
router.get('/published/:id', optionalProtect, reportController.getPublished);

// --- Staff ------------------------------------------------------------------
router.get('/', ...staff, reportController.listReports);

// Computing without saving, so a threshold can be chosen by seeing how much of
// the report it takes out before anything is committed to the record.
router.post('/preview', ...admin, reportController.previewReport);
router.post('/', ...admin, reportController.createReport);

router.get('/:id', ...staff, reportController.getReport);
router.patch('/:id/threshold', ...admin, reportController.setThreshold);

// The two-person step, and the two one-way steps after it.
router.patch('/:id/approve', ...admin, reportController.approveReport);
router.patch('/:id/publish', ...admin, reportController.publishReport);
router.patch('/:id/withdraw', ...admin, reportController.withdrawReport);

module.exports = router;
