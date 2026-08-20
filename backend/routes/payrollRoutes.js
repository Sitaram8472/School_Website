const express = require('express');
const router = express.Router();
const payrollController = require('../controllers/payrollController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Salaries. Nothing here is public and nothing here is open to students; the
// staff-facing half is scoped to the signed-in user inside the controller.
router.use(protect);
router.use(verifyRole('teacher', 'staff', 'admin'));

// --- Reference data ---------------------------------------------------------
// The rate and the slabs are published so the page can show the arithmetic
// rather than a figure nobody can check.
router.get('/meta', payrollController.getMeta);

// --- A member of staff's own payslips ---------------------------------------
// Declared before `/payslips/:id` so "mine" is never read as an id.
router.get('/payslips/mine', payrollController.getMyPayslips);
router.get('/payslips/:id', payrollController.getPayslip);

// --- Runs -------------------------------------------------------------------
router.get('/runs', verifyRole('admin'), payrollController.listRuns);
router.get('/runs/:id', verifyRole('admin'), payrollController.getRun);
router.post('/runs', verifyRole('admin'), payrollController.createRun);
router.patch('/runs/:id', verifyRole('admin'), payrollController.updateRun);

// --- Payslips inside a run --------------------------------------------------
router.post('/runs/:id/payslips', verifyRole('admin'), payrollController.addPayslip);
router.patch('/runs/:id/payslips/:pid', verifyRole('admin'), payrollController.updatePayslip);
router.delete('/runs/:id/payslips/:pid', verifyRole('admin'), payrollController.removePayslip);

// --- Computation and the one-way lock ---------------------------------------
router.post('/runs/:id/recompute', verifyRole('admin'), payrollController.recomputeRunHandler);

// There is deliberately no unlock. A locked run is corrected by cancelling it
// and issuing another, both of which stay on the record.
router.patch('/runs/:id/lock', verifyRole('admin'), payrollController.lockRun);
router.patch('/runs/:id/mark-paid', verifyRole('admin'), payrollController.markRunPaid);
router.patch('/runs/:id/cancel', verifyRole('admin'), payrollController.cancelRun);

// --- Reporting --------------------------------------------------------------
router.get('/stats', verifyRole('admin'), payrollController.getStats);

module.exports = router;
