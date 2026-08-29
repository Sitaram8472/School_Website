const express = require('express');
const router = express.Router();
const allotmentController = require('../controllers/allotmentController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// A merit list names children and their marks. None of it is public, and the
// family-facing half is scoped to the signed-in guardian in the controller.
router.use(protect);

// --- Reference data ---------------------------------------------------------
router.get('/meta', allotmentController.getMeta);

// --- A family's own offer ---------------------------------------------------
// Declared before the staff routes so `/offers/mine` is never read as an id.
router.get('/offers/mine', allotmentController.getMyOffers);
router.patch('/offers/:id/accept', allotmentController.acceptOffer);
router.patch('/offers/:id/decline', allotmentController.declineOffer);

// Withdrawing somebody else's seat is an admin act and needs a reason.
router.patch('/offers/:id/withdraw', verifyRole('admin'), allotmentController.withdrawOffer);

// --- Rounds -----------------------------------------------------------------
router.get('/rounds', verifyRole('staff', 'admin'), allotmentController.listRounds);
router.get('/rounds/:id', verifyRole('staff', 'admin'), allotmentController.getRound);
router.post('/rounds', verifyRole('admin'), allotmentController.createRound);
router.patch('/rounds/:id', verifyRole('admin'), allotmentController.updateRound);
router.patch('/rounds/:id/close', verifyRole('admin'), allotmentController.closeRound);

// --- Candidates -------------------------------------------------------------
router.get(
  '/rounds/:id/candidates',
  verifyRole('staff', 'admin'),
  allotmentController.listCandidates
);
router.post(
  '/rounds/:id/candidates',
  verifyRole('staff', 'admin'),
  allotmentController.addCandidate
);
router.patch(
  '/rounds/:id/candidates/:cid',
  verifyRole('staff', 'admin'),
  allotmentController.updateCandidate
);

// --- Ranking and allotment --------------------------------------------------
// Ranking derives every composite and every rank; nothing here takes a rank
// from the caller.
router.post('/rounds/:id/rank', verifyRole('admin'), allotmentController.rankRound);
router.post('/rounds/:id/publish', verifyRole('admin'), allotmentController.publishRound);
router.get('/rounds/:id/allotment', verifyRole('staff', 'admin'), allotmentController.getAllotment);
router.get('/rounds/:id/waitlist', verifyRole('staff', 'admin'), allotmentController.getWaitlist);

// The sweep that makes the confirmation deadline real. Safe to call repeatedly.
router.post('/rounds/:id/reconcile', verifyRole('admin'), allotmentController.reconcileRound);

// --- Reporting --------------------------------------------------------------
router.get('/stats', verifyRole('admin'), allotmentController.getStats);

module.exports = router;
