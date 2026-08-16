const express = require('express');
const router = express.Router();
const paperModerationController = require('../controllers/paperModerationController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Everything behind this router is an unpublished question paper. There is no
// student-facing endpoint here — not a filtered one, none at all.
router.use(protect);
router.use(verifyRole('teacher', 'admin'));

// --- Reference data ---------------------------------------------------------
router.get('/meta', paperModerationController.getMeta);

// --- The two queues that follow the person, not the object ------------------
// Declared before `/reviews/:id` so neither word is ever read as an id.
router.get('/reviews/mine', paperModerationController.getMyReviews);
router.get('/reviews/assigned', paperModerationController.getAssignedReviews);
router.get('/reviews/queue', verifyRole('admin'), paperModerationController.getQueue);

// --- School-wide reporting (admin) ------------------------------------------
router.get('/reviews', verifyRole('admin'), paperModerationController.listReviews);
router.get('/stats', verifyRole('admin'), paperModerationController.getStats);

// --- Reviews ----------------------------------------------------------------
router.post('/reviews', paperModerationController.createReview);
router.get('/reviews/:id', paperModerationController.getReview);
router.patch('/reviews/:id', paperModerationController.updateReview);
router.get('/reviews/:id/blueprint', paperModerationController.getBlueprint);

// Submitting freezes a version: the fingerprint is taken here and the checks
// are re-run against the paper as it stands at this moment.
router.patch('/reviews/:id/submit', paperModerationController.submitReview);
router.patch('/reviews/:id/withdraw', paperModerationController.withdrawReview);

// --- Assignment -------------------------------------------------------------
// The author is refused by the model in both cases. An admin assigning and a
// teacher claiming go through exactly the same check.
router.patch(
  '/reviews/:id/assign',
  verifyRole('admin'),
  paperModerationController.assignModerator
);
router.patch('/reviews/:id/claim', paperModerationController.claimReview);

// --- Findings ---------------------------------------------------------------
router.post('/reviews/:id/findings', paperModerationController.addFinding);
router.patch(
  '/reviews/:id/findings/:findingId/resolve',
  paperModerationController.resolveFinding
);

// --- Verdict ----------------------------------------------------------------
router.patch('/reviews/:id/request-changes', paperModerationController.requestChanges);
router.patch('/reviews/:id/approve', paperModerationController.approveReview);
router.patch('/reviews/:id/reject', paperModerationController.rejectReview);

// --- Clearance --------------------------------------------------------------
// The question the exam module should ask before publishing anything.
router.get('/exams/:examId/clearance', paperModerationController.getClearance);

module.exports = router;
