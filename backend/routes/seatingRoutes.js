const express = require('express');
const router = express.Router();
const seatingController = require('../controllers/seatingController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

router.use(protect);

// A student may look up their own seat, and nothing else here. Declared before
// the /plans routes so it is never shadowed by a parameterised path.
router.get('/my-seat', seatingController.getMySeat);

const staffOnly = verifyRole('teacher', 'admin');

router.get('/stats', staffOnly, seatingController.getStats);

// --- Plans -----------------------------------------------------------------
router.post('/plans', staffOnly, seatingController.createPlan);
router.get('/plans', staffOnly, seatingController.getPlans);
router.get('/plans/:id', staffOnly, seatingController.getPlan);

// --- Candidates ------------------------------------------------------------
router.post('/plans/:id/candidates', staffOnly, seatingController.addCandidates);
router.delete(
  '/plans/:id/candidates/:candidateId',
  staffOnly,
  seatingController.removeCandidate
);

// --- Allocation ------------------------------------------------------------
router.post('/plans/:id/allocate', staffOnly, seatingController.allocate);

// --- Invigilation ----------------------------------------------------------
router.post('/plans/:id/invigilators', staffOnly, seatingController.assignInvigilator);
router.delete(
  '/plans/:id/invigilators/:invigilatorId',
  staffOnly,
  seatingController.removeInvigilator
);

// --- Lifecycle -------------------------------------------------------------
router.patch('/plans/:id/publish', staffOnly, seatingController.publishPlan);
router.patch('/plans/:id/lock', staffOnly, seatingController.lockPlan);
router.patch('/plans/:id/cancel', staffOnly, seatingController.cancelPlan);
router.patch('/plans/:id/attendance', staffOnly, seatingController.recordAttendance);

module.exports = router;
