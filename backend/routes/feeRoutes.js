const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');
const feeController = require('../controllers/feeController');

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

// ---- Reporting ----
router.get('/summary', bursar, feeController.getCollectionSummary);

module.exports = router;
