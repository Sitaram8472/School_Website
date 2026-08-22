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

module.exports = router;
