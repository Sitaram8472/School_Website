const express = require('express');
const router = express.Router();
const lostFoundController = require('../controllers/lostFoundController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

router.use(protect);

const deskOnly = verifyRole('teacher', 'staff', 'admin');

// Fixed paths before the parameterised ones, so `stats` is never read as an id.
router.get('/stats', deskOnly, lostFoundController.getStats);
router.post('/retention-sweep', deskOnly, lostFoundController.runRetentionSweep);

// --- Register --------------------------------------------------------------
router.post('/', lostFoundController.registerItem);
router.get('/', lostFoundController.searchRegister);
router.get('/:id', lostFoundController.getItem);
router.get('/:id/matches', deskOnly, lostFoundController.getSuggestedMatches);

// --- Claims ----------------------------------------------------------------
router.post('/:id/claims', lostFoundController.submitClaim);
router.patch('/:id/claims/:claimId/withdraw', lostFoundController.withdrawClaim);

// Adjudication. `getClaims` returns every claimant's proof text alongside the
// distinguishing marks, which is exactly what must not reach a claimant.
router.get('/:id/claims', deskOnly, lostFoundController.getClaims);
router.patch('/:id/claims/:claimId/approve', deskOnly, lostFoundController.approveClaim);
router.patch('/:id/claims/:claimId/reject', deskOnly, lostFoundController.rejectClaim);

// --- Custody ---------------------------------------------------------------
router.patch('/:id/store', deskOnly, lostFoundController.storeItem);
router.patch('/:id/handover', deskOnly, lostFoundController.recordHandover);
router.patch('/:id/dispose', deskOnly, lostFoundController.disposeItem);

module.exports = router;
