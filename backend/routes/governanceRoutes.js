const express = require('express');
const router = express.Router();
const governanceController = require('../controllers/governanceController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Committee papers carry disciplinary matters and tender decisions. Nothing
// here is open to students or parents, and membership is checked again in the
// controller — a confidential committee's meetings are refused to non-members
// rather than filtered out of a list.
router.use(protect);
router.use(verifyRole('teacher', 'staff', 'admin'));

// --- Reference data ---------------------------------------------------------
router.get('/meta', governanceController.getMeta);

// --- A member's own view ----------------------------------------------------
// Declared before the parameterised routes so "mine" is never read as an id.
router.get('/meetings/mine', governanceController.getMyMeetings);
router.get('/actions/mine', governanceController.getMyActions);

// --- Reporting (admin) ------------------------------------------------------
router.get('/actions/overdue', verifyRole('admin'), governanceController.getOverdueActions);
router.get('/meetings', verifyRole('admin'), governanceController.listMeetings);
router.get('/stats', verifyRole('admin'), governanceController.getStats);

// --- Committees -------------------------------------------------------------
router.post('/committees', verifyRole('admin'), governanceController.createCommittee);
router.get('/committees', governanceController.listCommittees);
router.get('/committees/:id', governanceController.getCommittee);
router.patch('/committees/:id', verifyRole('admin'), governanceController.updateCommittee);
router.post('/committees/:id/members', verifyRole('admin'), governanceController.addMember);
// Setting `leftOn` rather than deleting the row, so a May quorum is still
// evaluated against the May membership.
router.patch(
  '/committees/:id/members/:memberId',
  verifyRole('admin'),
  governanceController.updateMember
);

// Serials are issued with $inc, so two secretaries calling a meeting at the
// same moment get 004 and 005 rather than 004 twice.
router.post('/committees/:id/meetings', governanceController.createMeeting);

// --- Meetings ---------------------------------------------------------------
router.get('/meetings/:id', governanceController.getMeeting);
router.patch('/meetings/:id/agenda', governanceController.updateAgenda);
router.patch('/meetings/:id/attendance', governanceController.updateAttendance);

// --- Motions ----------------------------------------------------------------
// Quorum is computed at the instant of the vote, the vote is checked against
// the members entitled to cast it, and the outcome is derived. None of the
// three is ever accepted from a client.
router.post('/meetings/:id/motions', governanceController.recordMotion);
router.patch(
  '/meetings/:id/motions/:motionId/recuse',
  governanceController.recuseFromMotion
);

// --- Actions ----------------------------------------------------------------
router.post('/meetings/:id/actions', governanceController.addAction);
router.patch('/meetings/:id/actions/:actionId', governanceController.updateAction);

// --- Minutes ----------------------------------------------------------------
router.patch('/meetings/:id/minute', governanceController.minuteMeeting);
router.patch('/meetings/:id/circulate', governanceController.circulateMinutes);
// Approval is by the chair, at a later meeting, and it fingerprints the record.
router.patch('/meetings/:id/approve', governanceController.approveMinutes);

module.exports = router;
