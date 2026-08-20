const express = require('express');
const router = express.Router();
const procurementController = require('../controllers/procurementController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Departmental spending. Staff raise requisitions, the office records
// quotations, an admin approves — and nobody approves their own.
router.use(protect);
router.use(verifyRole('teacher', 'staff', 'admin'));

// --- Reference data ---------------------------------------------------------
// The threshold is published so the form can say three quotations are coming
// before somebody has typed the whole requisition.
router.get('/meta', procurementController.getMeta);

// --- Budget lines -----------------------------------------------------------
router.get('/budget-lines', procurementController.listBudgetLines);
router.post('/budget-lines', verifyRole('admin'), procurementController.createBudgetLine);
router.patch('/budget-lines/:id', verifyRole('admin'), procurementController.updateBudgetLine);

// --- Requisitions -----------------------------------------------------------
// Declared before `/requisitions/:id` so "mine" is never read as an id.
router.get('/requisitions/mine', procurementController.getMyRequisitions);
router.get('/requisitions', verifyRole('admin'), procurementController.listRequisitions);
router.post('/requisitions', procurementController.createRequisition);
router.get('/requisitions/:id', procurementController.getRequisition);
router.patch('/requisitions/:id', procurementController.updateRequisition);
router.patch('/requisitions/:id/submit', procurementController.submitRequisition);

// --- Quotations -------------------------------------------------------------
router.post(
  '/requisitions/:id/quotes',
  verifyRole('staff', 'admin'),
  procurementController.addQuote
);
router.patch(
  '/requisitions/:id/quotes/:qid/select',
  verifyRole('staff', 'admin'),
  procurementController.selectQuote
);

// --- Approval and the money -------------------------------------------------
// Approving commits budget against the line; rejecting releases it. Both are
// guarded so a retry cannot move the money twice.
router.patch(
  '/requisitions/:id/approve',
  verifyRole('admin'),
  procurementController.approveRequisition
);
router.patch(
  '/requisitions/:id/reject',
  verifyRole('admin'),
  procurementController.rejectRequisition
);
router.patch('/requisitions/:id/order', verifyRole('admin'), procurementController.orderRequisition);

// --- Goods received ---------------------------------------------------------
router.post(
  '/requisitions/:id/receipts',
  verifyRole('staff', 'admin'),
  procurementController.recordReceipt
);
router.patch(
  '/requisitions/:id/close',
  verifyRole('admin'),
  procurementController.closeRequisition
);
router.patch('/requisitions/:id/cancel', procurementController.cancelRequisition);

// --- Reporting --------------------------------------------------------------
router.get('/stats', verifyRole('admin'), procurementController.getStats);

module.exports = router;
