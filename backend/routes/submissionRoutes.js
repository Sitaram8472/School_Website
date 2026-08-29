const express = require('express');
const router = express.Router();
const submissionController = require('../controllers/submissionController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');
const integrityController = require('../controllers/integrityController');

// ---- Academic integrity ----
// A case is something that happens to a submission, so it lives here rather
// than at a top-level /api/integrity that would imply it exists on its own.
// Declared before the '/:examId' routes so "integrity" is never read as an id.
const reviewer = verifyRole('teacher', 'admin');

router.get('/integrity/meta', protect, integrityController.getIntegrityMeta);
router.get('/integrity/mine', protect, integrityController.getMyCases);
router.get('/integrity/stats', protect, verifyRole('admin'), integrityController.getStats);

router.post('/integrity', protect, reviewer, integrityController.openCase);
router.get('/integrity', protect, reviewer, integrityController.getCases);

// The student, the reviewing staff and admins each see a different amount of
// this; the controller decides which.
router.get('/integrity/:id', protect, integrityController.getCase);

router.post('/integrity/:id/evidence', protect, reviewer, integrityController.addEvidence);

// Only the student named in the case may answer it.
router.post('/integrity/:id/response', protect, integrityController.recordResponse);

router.patch('/integrity/:id/review', protect, reviewer, integrityController.reviewCase);
router.patch('/integrity/:id/withdraw', protect, reviewer, integrityController.withdrawCase);

router.post('/:examId/submit', protect, verifyRole('student'), submissionController.submitExam);
router.post('/:examId/warning', protect, verifyRole('student'), submissionController.logWarning);
router.get('/exam/:examId', protect, verifyRole('teacher', 'admin'), submissionController.getSubmissions);

module.exports = router;
