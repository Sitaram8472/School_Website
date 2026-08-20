const express = require('express');
const router = express.Router();
const meetingController = require('../controllers/meetingController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Nothing here is public — a slot list carries teacher names and a room
// number, and the booking side needs an account to attach a booking to.
router.use(protect);

// --- Publishing (teachers and admins) --------------------------------------
router.post('/slots', verifyRole('teacher', 'admin'), meetingController.createSlots);
router.get('/slots/mine', verifyRole('teacher', 'admin'), meetingController.getMySlots);
router.get('/stats', verifyRole('teacher', 'admin'), meetingController.getStats);

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

// --- Slot administration (owning teacher or admin) -------------------------
router.patch('/slots/:id', verifyRole('teacher', 'admin'), meetingController.updateSlot);
router.patch('/slots/:id/cancel', verifyRole('teacher', 'admin'), meetingController.cancelSlot);
router.delete('/slots/:id', verifyRole('teacher', 'admin'), meetingController.deleteSlot);

module.exports = router;
