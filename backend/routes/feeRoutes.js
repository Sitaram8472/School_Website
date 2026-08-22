const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');
const feeController = require('../controllers/feeController');
const refundController = require('../controllers/feeRefundController');

// Everything under /api/fees needs a session.
router.use(protect);

// Only the finance office touches structures, generation and payments.
const bursar = verifyRole('admin', 'staff');

// ---- Student-facing ----
// Declared before the parameterised invoice route so "/invoices/me" is never
// swallowed by "/invoices/:id".
router.get('/invoices/me', feeController.getMyInvoices);

// ---- Fee structures ----
router.get('/structures', feeController.getFeeStructures);
router.post('/structures', bursar, feeController.createFeeStructure);
router.put('/structures/:id', bursar, feeController.updateFeeStructure);
router.delete('/structures/:id', bursar, feeController.deleteFeeStructure);

// ---- Invoices ----
router.get('/invoices', bursar, feeController.getInvoices);
router.post('/invoices/generate', bursar, feeController.generateInvoices);

// Ownership is checked inside the controller so a student can open their own
// invoice while staff can open anyone's.
router.get('/invoices/:id', feeController.getInvoice);

router.post('/invoices/:id/payments', bursar, feeController.recordPayment);
router.patch('/invoices/:id/waive', verifyRole('admin'), feeController.waiveInvoice);

// ---- Refunds ----
// A refund is something that happens to an invoice rather than a thing in its
// own right, so it lives under /api/fees alongside the invoices it reverses.
// Only an admin may approve, reject or settle; staff may raise and cancel.
const approver = verifyRole('admin');

// Static segments first, so "/refunds/mine" is never captured by "/refunds/:id".
router.get('/refunds/meta', refundController.getRefundMeta);
router.get('/refunds/mine', refundController.getMyRefunds);
router.get('/refunds/summary', bursar, refundController.getRefundSummary);
router.get('/refunds/staff', bursar, refundController.getRefundStaff);

router.post('/refunds', bursar, refundController.requestRefund);
router.get('/refunds', bursar, refundController.getRefunds);

// How much of this invoice can still be given back, recomputed on every call.
router.get('/invoices/:id/refundable', bursar, refundController.getRefundable);

// Ownership is decided in the controller so a student can open their own.
router.get('/refunds/:id', refundController.getRefund);

router.patch('/refunds/:id/approve', approver, refundController.approveRefund);
router.patch('/refunds/:id/reject', approver, refundController.rejectRefund);
router.patch('/refunds/:id/settle', approver, refundController.settleRefund);
router.patch('/refunds/:id/cancel', bursar, refundController.cancelRefund);

// ---- Reporting ----
router.get('/summary', bursar, feeController.getCollectionSummary);

module.exports = router;
