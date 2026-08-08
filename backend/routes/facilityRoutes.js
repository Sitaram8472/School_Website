const express = require('express');
const router = express.Router();
const facilityController = require('../controllers/facilityController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// A room calendar tells anyone reading it where a hundred students will be at
// two o'clock, so none of this is public.
router.use(protect);

// --- Fixed paths first, so none of them is ever matched as an :id -----------
router.get('/availability', facilityController.getAvailability);
router.get('/my-bookings', facilityController.getMyBookings);
router.get('/pending', verifyRole('admin'), facilityController.getPendingRequests);
router.get('/stats', verifyRole('admin'), facilityController.getStats);

// --- The register (admin) ---------------------------------------------------
router.post('/', verifyRole('admin'), facilityController.createFacility);
router.patch('/:id', verifyRole('admin'), facilityController.updateFacility);
router.patch('/:id/status', verifyRole('admin'), facilityController.setFacilityStatus);
router.delete('/:id', verifyRole('admin'), facilityController.deleteFacility);

// --- Browsing (any authenticated user) --------------------------------------
router.get('/', facilityController.listFacilities);
router.get('/:id', facilityController.getFacility);
router.get('/:id/schedule', facilityController.getSchedule);

// --- Booking ----------------------------------------------------------------
// Requesting a room is staff work; cancelling is open to the requester, and the
// handler checks ownership.
router.post('/:id/bookings', verifyRole('teacher', 'admin'), facilityController.createBooking);
router.patch('/:id/bookings/:bookingId/cancel', facilityController.cancelBooking);

// --- Approval (admin) -------------------------------------------------------
router.patch(
  '/:id/bookings/:bookingId/approve',
  verifyRole('admin'),
  facilityController.approveBooking
);
router.patch(
  '/:id/bookings/:bookingId/reject',
  verifyRole('admin'),
  facilityController.rejectBooking
);

module.exports = router;
