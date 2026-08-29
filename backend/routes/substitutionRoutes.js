const express = require('express');
const router = express.Router();
const substitutionController = require('../controllers/substitutionController');
const claimController = require('../controllers/coverClaimController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Nothing here is public. A cover board is a list of which staff are absent and
// which classes are unsupervised, which is not information for the internet.
router.use(protect);

// --- Reporting an absence ---------------------------------------------------
// Teachers report their own; the controller checks that anyone reporting on
// somebody else's behalf is an admin.
router.post('/absences', verifyRole('teacher', 'admin'), substitutionController.createAbsence);
router.get('/absences/mine', verifyRole('teacher', 'admin'), substitutionController.getMyAbsences);

// --- The substitute's own view ----------------------------------------------
// Declared before `/absences/:id` so "my-cover" is never read as an id.
router.get('/my-cover', verifyRole('teacher', 'admin'), substitutionController.getMyCover);

// --- Cover availability -----------------------------------------------------
// Working patterns, dated exclusions and load caps. A static prefix declared
// above `/absences/:id`, so none of its segments is read as an absence id.
router.use('/availability', require('./coverAvailabilityRoutes'));

// --- Cover claims -----------------------------------------------------------
// Payment for cover actually taught. Declared above `/absences/:id` so none of
// these static segments is ever read as an absence id.
const teacherOrAdmin = verifyRole('teacher', 'admin');
const payroll = verifyRole('admin');

router.get('/claims/meta', teacherOrAdmin, claimController.getClaimMeta);
router.get('/claims/mine', teacherOrAdmin, claimController.getMyClaims);
router.get('/claims/claimable', teacherOrAdmin, claimController.getClaimable);
router.get('/claims/summary/mine', teacherOrAdmin, claimController.getMyMonthSummary);

// The load report includes cover nobody claimed for, which is the point of it.
router.get('/claims/load', payroll, claimController.getLoadReport);

// Batches are declared before `/claims/:id` for the same reason.
router.get('/claims/batches', payroll, claimController.getBatches);
router.post('/claims/batches/:monthKey/lock', payroll, claimController.lockBatch);
router.patch('/claims/batches/:monthKey/unlock', payroll, claimController.unlockBatch);
router.patch('/claims/batches/:monthKey/pay', payroll, claimController.payBatch);

router.post('/claims', teacherOrAdmin, claimController.createClaim);
router.get('/claims', payroll, claimController.getClaims);

// Ownership is decided in the handler so a teacher can open their own.
router.get('/claims/:id', teacherOrAdmin, claimController.getClaim);

// Self-approval is refused in the handler. Holding the admin role is
// necessary but not sufficient.
router.patch('/claims/:id/approve', payroll, claimController.approveClaim);
router.patch('/claims/:id/reject', payroll, claimController.rejectClaim);
router.patch('/claims/:id/cancel', teacherOrAdmin, claimController.cancelClaim);

// --- The cover board --------------------------------------------------------
router.get('/board', verifyRole('admin'), substitutionController.getBoard);
router.get('/available', verifyRole('admin'), substitutionController.getAvailableStaff);
router.get('/stats', verifyRole('admin'), substitutionController.getStats);

router.get('/absences', verifyRole('admin'), substitutionController.listAbsences);
router.get('/absences/:id', verifyRole('teacher', 'admin'), substitutionController.getAbsence);
router.patch('/absences/:id', verifyRole('teacher', 'admin'), substitutionController.updateAbsence);
router.patch('/absences/:id/cancel', verifyRole('teacher', 'admin'), substitutionController.cancelAbsence);

// --- Approval (admin) -------------------------------------------------------
router.patch('/absences/:id/approve', verifyRole('admin'), substitutionController.approveAbsence);
router.patch('/absences/:id/reject', verifyRole('admin'), substitutionController.rejectAbsence);

// --- Assignment (admin) -----------------------------------------------------
router.patch(
  '/absences/:id/periods/:periodId/assign',
  verifyRole('admin'),
  substitutionController.assignCover
);
router.patch(
  '/absences/:id/periods/:periodId/release',
  verifyRole('admin'),
  substitutionController.releaseCover
);
router.patch(
  '/absences/:id/periods/:periodId/not-required',
  verifyRole('admin'),
  substitutionController.markNotRequired
);

// --- The substitute answering (the assigned teacher, checked in the handler) -
router.patch(
  '/absences/:id/periods/:periodId/decline',
  verifyRole('teacher', 'admin'),
  substitutionController.declineCover
);
router.patch(
  '/absences/:id/periods/:periodId/complete',
  verifyRole('teacher', 'admin'),
  substitutionController.completeCover
);

module.exports = router;
