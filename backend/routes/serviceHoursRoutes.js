const express = require('express');
const router = express.Router();
const serviceHoursController = require('../controllers/serviceHoursController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// A service ledger names students, the organisations they worked with and the
// adults who supervised them. None of that is for the internet.
router.use(protect);

// --- Reference data ---------------------------------------------------------
router.get('/meta', serviceHoursController.getMeta);

// --- A student's own ledger -------------------------------------------------
// Declared before `/entries/:id` so "mine" is never read as an id.
router.get('/entries/mine', serviceHoursController.getMyEntries);
router.get('/progress/mine', serviceHoursController.getMyProgress);

router.post('/entries', serviceHoursController.createEntry);
router.patch('/entries/:id', serviceHoursController.updateEntry);
router.patch('/entries/:id/withdraw', serviceHoursController.withdrawEntry);

// --- The verification queue (staff) -----------------------------------------
router.get(
  '/pending',
  verifyRole('teacher', 'admin'),
  serviceHoursController.getPendingQueue
);
router.get(
  '/entries',
  verifyRole('teacher', 'admin'),
  serviceHoursController.listEntries
);
router.get(
  '/stats',
  verifyRole('admin'),
  serviceHoursController.getStats
);
router.get(
  '/progress/:studentId',
  verifyRole('teacher', 'admin'),
  serviceHoursController.getStudentProgress
);

// Ownership for a student, staff access for everyone else, checked in the
// handler because the rule depends on the document rather than the role alone.
router.get('/entries/:id', serviceHoursController.getEntry);

// --- Verification -----------------------------------------------------------
// Eligibility is enforced in the controller: not your own, not the one you
// supervised. Holding the role is necessary but not sufficient.
router.patch(
  '/entries/:id/verify',
  verifyRole('teacher', 'admin'),
  serviceHoursController.verifyEntry
);
router.patch(
  '/entries/:id/reject',
  verifyRole('teacher', 'admin'),
  serviceHoursController.rejectEntry
);

module.exports = router;
