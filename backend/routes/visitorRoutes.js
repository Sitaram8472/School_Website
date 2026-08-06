const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');
const visitorController = require('../controllers/visitorController');

// Everything under /api/visitors needs a session.
router.use(protect);

// The gate desk and the office.
const gate = verifyRole('admin', 'staff');

// Teachers reach exactly two things here: the visits waiting on their approval,
// and the passes they are hosting.
const gateOrTeacher = verifyRole('admin', 'staff', 'teacher');

// ---- Reading ----
// Literal paths first so they are not swallowed by "/passes/:id".
router.get('/passes/on-campus', gate, visitorController.getOnCampus);
router.get('/my-approvals', gateOrTeacher, visitorController.getMyApprovals);

router.get('/passes', gate, visitorController.getPasses);
router.post('/passes', gate, visitorController.createPass);

// Host visibility is decided inside the controller, so a teacher can open a
// visit they are hosting through the same URL the desk uses.
router.get('/passes/:id', gateOrTeacher, visitorController.getPass);

// ---- Approval ----
// Who may approve depends on the pass type, so the check lives in the
// controller rather than being split across two middleware chains.
router.patch('/passes/:id/approve', gateOrTeacher, visitorController.approvePass);

// ---- Movement ----
router.patch('/passes/:id/check-in', gate, visitorController.checkIn);
router.patch('/passes/:id/check-out', gate, visitorController.checkOut);
router.patch('/passes/:id/cancel', gate, visitorController.cancelPass);

// Bulk end-of-day close. Admin only — it writes an assumption into the record,
// and that should be a deliberate act by one person.
router.post('/passes/reconcile', verifyRole('admin'), visitorController.reconcile);

// ---- Reporting ----
router.get('/stats', gate, visitorController.getStats);

module.exports = router;
