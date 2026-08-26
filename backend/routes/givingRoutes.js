const express = require('express');
const router = express.Router();
const givingController = require('../controllers/givingController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Nothing here is public. Even the campaign list carries donor names on its
// leaderboard, and an appeal marked internal is not for the internet at all.
router.use(protect);

// --- Fixed paths first, so none of them is ever read as an :id --------------
router.get('/meta', givingController.getMeta);
router.get('/stats', verifyRole('admin'), givingController.getStats);

// --- Campaigns ---------------------------------------------------------------
router.post('/campaigns', verifyRole('admin'), givingController.createCampaign);
router.get('/campaigns', givingController.listCampaigns);
router.get('/campaigns/:id', givingController.getCampaign);
router.get('/campaigns/:id/leaderboard', givingController.getLeaderboard);
router.patch('/campaigns/:id', verifyRole('admin'), givingController.updateCampaign);
router.patch('/campaigns/:id/status', verifyRole('admin'), givingController.setCampaignStatus);

// --- Pledges -----------------------------------------------------------------
// `mine` and `overdue` before `:id`, so neither word is read as an identifier.
router.get('/pledges/mine', givingController.getMyPledges);
router.get('/pledges/overdue', verifyRole('admin'), givingController.getOverduePledges);

router.post('/pledges', givingController.createPledge);
router.get('/pledges', verifyRole('admin'), givingController.listPledges);

// Ownership is checked in the handler, since "mine or admin" is not a role.
router.get('/pledges/:id', givingController.getPledge);
router.patch('/pledges/:id/cancel', givingController.cancelPledge);

// --- Payments ----------------------------------------------------------------
// Idempotent on the reference in the body: a repeat returns the original
// payment and its original receipt serial, and moves no total.
router.post('/pledges/:id/payments', verifyRole('admin'), givingController.recordPayment);
router.get('/pledges/:id/receipt/:serial', givingController.getReceipt);
router.patch(
  '/pledges/:id/instalments/:idx/waive',
  verifyRole('admin'),
  givingController.waiveInstalment
);

// --- Employer matching -------------------------------------------------------
// Mounted under /matching rather than at the top level because a match is
// something that happens to a gift, not a thing in its own right. The whole
// prefix is a static segment, so none of it can be read as a campaign or
// pledge id by the routes above.
const matchingGiftController = require('../controllers/matchingGiftController');

router.get('/matching/meta', matchingGiftController.getMatchingMeta);

// Programmes. The list is readable by any signed-in donor — they have to pick
// their employer from it — but it is narrowed to active programmes for them.
router.post('/matching/programmes', verifyRole('admin'), matchingGiftController.createProgramme);
router.get('/matching/programmes', matchingGiftController.listProgrammes);
router.patch(
  '/matching/programmes/:id',
  verifyRole('admin'),
  matchingGiftController.updateProgramme
);
router.patch(
  '/matching/programmes/:id/status',
  verifyRole('admin'),
  matchingGiftController.setProgrammeStatus
);

// The ceiling, asked for before an amount is typed rather than after the
// server rejects one.
router.get('/matching/claimable', matchingGiftController.getClaimable);

// Claims. `mine` before `:id`, so the word is never read as an identifier.
router.get('/matching/claims/mine', matchingGiftController.getMyClaims);
router.get('/matching/claims', verifyRole('admin'), matchingGiftController.listClaims);
router.post('/matching/claims', matchingGiftController.createClaim);

// Ownership is checked in the handler, since "mine or admin" is not a role.
router.get('/matching/claims/:id', matchingGiftController.getClaim);
router.patch('/matching/claims/:id/submit', matchingGiftController.submitClaim);
router.patch('/matching/claims/:id/withdraw', matchingGiftController.withdrawClaim);

// The two-person rule: whoever verifies may be neither the donor nor the
// person who submitted, enforced in the controller and again in the model.
router.patch('/matching/claims/:id/verify', verifyRole('admin'), matchingGiftController.verifyClaim);
router.patch(
  '/matching/claims/:id/decline',
  verifyRole('admin'),
  matchingGiftController.declineClaim
);

// Idempotent on the receipt reference in the body, and the ceiling is derived
// again here in case other claims have spent the budget in the meantime.
router.patch(
  '/matching/claims/:id/receipt',
  verifyRole('admin'),
  matchingGiftController.recordReceipt
);

// Reported beside the campaign's own totals, never folded into them.
router.get('/campaigns/:id/matching', matchingGiftController.getCampaignMatching);

module.exports = router;
