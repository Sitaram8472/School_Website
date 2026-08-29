const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');
const clubController = require('../controllers/clubController');

router.use(protect);

// Creating a club needs staff; who may *manage* a given club is a narrower
// question (its coordinator, or an admin) and is answered inside the
// controller, because the router cannot know who coordinates what.
const staff = verifyRole('teacher', 'staff', 'admin');

// ---- Student-facing ----
// Literal paths come before "/:id" so they are never captured as an id.
router.get('/me', clubController.getMyClubs);
router.get('/stats', staff, clubController.getClubStats);

router.get('/', clubController.getClubs);
router.post('/', staff, clubController.createClub);

router.get('/:id', clubController.getClub);
router.put('/:id', staff, clubController.updateClub);
router.delete('/:id', verifyRole('admin'), clubController.deleteClub);

// Joining and leaving are the student's own actions — no role gate, the
// controller uses the token's identity.
router.post('/:id/join', clubController.joinClub);
router.patch('/:id/leave', clubController.leaveClub);

// ---- Coordinator-facing ----
router.patch('/memberships/:membershipId/decision', staff, clubController.decideMembership);
router.patch('/memberships/:membershipId/role', staff, clubController.setMemberRole);

router.post('/:id/sessions', staff, clubController.scheduleSession);
router.patch('/:id/sessions/:sessionId/cancel', staff, clubController.cancelSession);
router.post('/:id/sessions/:sessionId/attendance', staff, clubController.markAttendance);

router.post('/:id/achievements', staff, clubController.addAchievement);

module.exports = router;
