const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');
const grievanceController = require('../controllers/grievanceController');

// Anonymity here means "the committee cannot see who you are", not "anyone can
// post". A ticket still needs a session, otherwise the queue fills with noise
// and nobody can be told their complaint was resolved.
router.use(protect);

const committee = verifyRole('teacher', 'staff', 'admin');

// ---- Reporter-facing ----
// Literal paths first, so they are never captured as an id.
router.get('/me', grievanceController.getMyGrievances);
router.post('/', grievanceController.raiseGrievance);

// ---- Committee-facing ----
router.get('/queue', committee, grievanceController.getGrievanceQueue);
router.get('/stats', committee, grievanceController.getGrievanceStats);
router.post('/escalate-overdue', committee, grievanceController.escalateOverdue);

router.patch('/:id/acknowledge', committee, grievanceController.acknowledgeGrievance);
router.patch('/:id/assign', committee, grievanceController.assignGrievance);
router.patch('/:id/escalate', committee, grievanceController.escalateGrievance);
router.patch('/:id/resolve', committee, grievanceController.resolveGrievance);
router.patch('/:id/reject', committee, grievanceController.rejectGrievance);
router.patch('/:id/close', committee, grievanceController.closeGrievance);

// ---- Shared ----
// Commenting, reopening and rating are checked against ownership inside the
// controller rather than by role: a reporter may act on their own ticket, the
// committee on any.
router.post('/:id/comments', grievanceController.addComment);
router.patch('/:id/reopen', grievanceController.reopenGrievance);
router.patch('/:id/rate', grievanceController.rateResolution);

router.get('/:id', grievanceController.getGrievance);

module.exports = router;
