const express = require('express');
const router = express.Router();
const broadcastController = require('../controllers/broadcastController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Everybody signed in can read and acknowledge their own alerts. Composing and
// dispatching are staff acts, and the per-broadcast receipt list — which is the
// record of who did and did not answer — is admin only.
router.use(protect);

// --- Reference data ---------------------------------------------------------
router.get('/meta', broadcastController.getMeta);

// --- A recipient's own alerts -----------------------------------------------
// Declared before `/:id` so "mine" is never read as an id.
router.get('/mine', broadcastController.getMyAlerts);
router.patch('/receipts/:id/acknowledge', broadcastController.acknowledgeReceipt);

// --- Composing --------------------------------------------------------------
router.get('/stats', verifyRole('staff', 'admin'), broadcastController.getStats);
router.get('/', verifyRole('staff', 'admin'), broadcastController.listBroadcasts);
router.post('/', verifyRole('staff', 'admin'), broadcastController.createBroadcast);
router.get('/:id', verifyRole('staff', 'admin'), broadcastController.getBroadcast);
router.patch('/:id', verifyRole('staff', 'admin'), broadcastController.updateBroadcast);

// --- Dispatch and the incident ----------------------------------------------
// Idempotent on the dispatch key: a retry writes no second wave.
router.post('/:id/dispatch', verifyRole('staff', 'admin'), broadcastController.dispatchBroadcast);

// Safe to call repeatedly; each person is escalated at most once.
router.post('/:id/reconcile', verifyRole('staff', 'admin'), broadcastController.reconcileBroadcast);

router.patch('/:id/close', verifyRole('staff', 'admin'), broadcastController.closeBroadcast);
router.patch('/:id/cancel', verifyRole('staff', 'admin'), broadcastController.cancelBroadcast);

// Who has and has not answered. Admins only.
router.get('/:id/receipts', verifyRole('admin'), broadcastController.listReceipts);

module.exports = router;
