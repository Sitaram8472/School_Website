const express = require('express');
const router = express.Router();
const fieldTripController = require('../controllers/fieldTripController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Nothing here is public. A trip listing carries departure times and a meeting
// point for a coach full of children, which is not information for the internet.
router.use(protect);

// --- Fixed paths first, so none of them is ever read as an :id --------------
router.get('/mine', verifyRole('teacher', 'admin'), fieldTripController.getMyTrips);
router.get('/my-registrations', fieldTripController.getMyRegistrations);
router.get('/stats', verifyRole('teacher', 'admin'), fieldTripController.getStats);

// --- Organising (teachers and admins) ---------------------------------------
router.post('/', verifyRole('teacher', 'admin'), fieldTripController.createTrip);

// --- Browsing (any authenticated user) --------------------------------------
router.get('/', fieldTripController.listTrips);
router.get('/:id', fieldTripController.getTrip);

// --- Registration (any authenticated user; consent enforced in the handler) --
router.post('/:id/register', fieldTripController.register);
router.patch('/:id/participants/:pid/withdraw', fieldTripController.withdraw);

// --- Trip administration (organiser or admin, checked in the handler) -------
router.patch('/:id', verifyRole('teacher', 'admin'), fieldTripController.updateTrip);
router.patch('/:id/status', verifyRole('teacher', 'admin'), fieldTripController.setStatus);
router.patch('/:id/cancel', verifyRole('teacher', 'admin'), fieldTripController.cancelTrip);
router.patch(
  '/:id/participants/:pid/payment',
  verifyRole('teacher', 'admin'),
  fieldTripController.setPayment
);

// --- On the day -------------------------------------------------------------
// The manifest carries other families' medical details, so the handler checks
// membership of this trip's escort list rather than trusting the role alone.
router.get('/:id/manifest', verifyRole('teacher', 'admin'), fieldTripController.getManifest);
router.patch(
  '/:id/participants/:pid/attendance',
  verifyRole('teacher', 'admin'),
  fieldTripController.markAttendance
);

module.exports = router;
