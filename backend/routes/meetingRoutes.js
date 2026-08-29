const express = require('express');
const router = express.Router();
const meetingController = require('../controllers/meetingController');
const outcomeController = require('../controllers/meetingOutcomeController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Nothing here is public — a slot list carries teacher names and a room
// number, and the booking side needs an account to attach a booking to.
router.use(protect);

// --- Publishing (teachers and admins) --------------------------------------
router.post('/slots', verifyRole('teacher', 'admin'), meetingController.createSlots);
router.get('/slots/mine', verifyRole('teacher', 'admin'), meetingController.getMySlots);
router.get('/stats', verifyRole('teacher', 'admin'), meetingController.getStats);

// --- Meeting write-ups ------------------------------------------------------
// What was agreed in the room, as opposed to the one free-text `outcomeNote`
// the booking already carries. Static segments are declared here, above
// `/slots/:id`, so none of them is ever read as a slot id.
router.get('/outcomes/meta', outcomeController.getOutcomeMeta);

// The family's own copies. Drafts are excluded in the controller.
router.get('/outcomes/mine', outcomeController.getMyOutcomes);

router.get('/outcomes/pending', verifyRole('teacher', 'admin'), outcomeController.getPendingWriteUps);
router.get('/outcomes/actions/open', verifyRole('teacher', 'admin'), outcomeController.getOpenActions);
router.get('/outcomes/stats', verifyRole('admin'), outcomeController.getOutcomeStats);
router.get('/outcomes', verifyRole('teacher', 'admin'), outcomeController.getOutcomes);

// Whether the caller is the teacher or the family is decided in the handler,
// and it decides which of the two serialisers answers.
router.get('/outcomes/:id', outcomeController.getOutcome);

router.patch('/outcomes/:id', verifyRole('teacher', 'admin'), outcomeController.updateOutcome);
router.patch('/outcomes/:id/publish', verifyRole('teacher', 'admin'), outcomeController.publishOutcome);
router.patch('/outcomes/:id/close', verifyRole('teacher', 'admin'), outcomeController.closeOutcome);
router.post('/outcomes/:id/actions', verifyRole('teacher', 'admin'), outcomeController.addAction);

// A family may settle an action they own and may add an addendum, but may
// not edit anything. Ownership is checked in the handler.
router.patch('/outcomes/:id/actions/:actionIndex', outcomeController.settleAction);
router.post('/outcomes/:id/addenda', outcomeController.addAddendum);
router.patch('/outcomes/:id/acknowledge', outcomeController.acknowledgeOutcome);

// --- Browsing and booking (any authenticated user) -------------------------
router.get('/slots', meetingController.browseSlots);
router.get('/my-bookings', meetingController.getMyBookings);
router.get('/slots/:id', meetingController.getSlot);
router.post('/slots/:id/book', meetingController.bookSlot);

// Either side may cancel a booking; the controller decides which rules apply.
router.patch('/slots/:id/bookings/:bookingId/cancel', meetingController.cancelBooking);

// --- After the meeting (owning teacher or admin) ---------------------------
router.patch(
  '/slots/:id/bookings/:bookingId/attendance',
  verifyRole('teacher', 'admin'),
  meetingController.recordAttendance
);
router.patch(
  '/slots/:id/bookings/:bookingId/outcome',
  verifyRole('teacher', 'admin'),
  meetingController.recordOutcome
);

// The structured write-up, as opposed to the single note above. Named
// `outcome-record` so it does not collide with the existing route.
router.post(
  '/slots/:id/bookings/:bookingId/outcome-record',
  verifyRole('teacher', 'admin'),
  outcomeController.createOutcome
);

// --- Slot administration (owning teacher or admin) -------------------------
router.patch('/slots/:id', verifyRole('teacher', 'admin'), meetingController.updateSlot);
router.patch('/slots/:id/cancel', verifyRole('teacher', 'admin'), meetingController.cancelSlot);
router.delete('/slots/:id', verifyRole('teacher', 'admin'), meetingController.deleteSlot);

module.exports = router;
