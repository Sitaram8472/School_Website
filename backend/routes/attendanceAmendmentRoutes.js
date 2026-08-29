const express = require('express');

const router = express.Router();
const amendmentController = require('../controllers/attendanceAmendmentController');
const verifyRole = require('../middleware/verifyRole');

/**
 * Register amendments.
 *
 * Mounted under a static prefix on `/api/teacher`, which already applies
 * `protect` and `verifyRole('teacher', 'admin')`, so nothing here is reachable
 * without a staff session.
 *
 * The two-person rule is enforced in the handlers and again in the model.
 * Holding a role is necessary but not sufficient: a teacher may raise a
 * correction to their own register and may not approve it.
 */

const office = verifyRole('admin');

router.get('/meta', amendmentController.getMeta);

// --- Static segments first, so none of them is read as an amendment id ------
router.get('/mine', amendmentController.getMyAmendments);
// The queue carries the effect of each amendment on the student's percentage,
// computed before the decision rather than after it.
router.get('/pending', office, amendmentController.getPending);
router.get('/summary', office, amendmentController.getSummary);
router.get('/student', amendmentController.getStudentAttendance);

// --- Certification ----------------------------------------------------------
// Sealing a class-month. Declared above `/:id` for the same reason.
router.get('/certifications', office, amendmentController.listCertifications);
router.post('/certifications', office, amendmentController.certify);
router.patch('/certifications/:id/reopen', office, amendmentController.reopenCertification);

// --- Amendments -------------------------------------------------------------
router.post('/', amendmentController.createAmendment);
router.get('/', amendmentController.listAmendments);

// Ownership is decided in the handler, since "mine, or one I am being asked to
// decide" is not a role.
router.get('/:id', amendmentController.getAmendment);

router.patch('/:id/withdraw', amendmentController.withdrawAmendment);
router.patch('/:id/evidence', amendmentController.recordEvidence);

// Self-approval is refused in the handler and again in the model.
router.patch('/:id/approve', office, amendmentController.approveAmendment);
router.patch('/:id/reject', office, amendmentController.rejectAmendment);

// The guarded write. Separated from approval on purpose: approving is a
// judgement, applying is a change to a record, and the second can fail because
// the register moved even when the first succeeded.
router.patch('/:id/apply', office, amendmentController.applyAmendment);

module.exports = router;
