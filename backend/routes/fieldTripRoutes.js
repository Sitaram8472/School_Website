const express = require('express');
const router = express.Router();
const fieldTripController = require('../controllers/fieldTripController');
const tripRiskController = require('../controllers/tripRiskController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Nothing here is public. A trip listing carries departure times and a meeting
// point for a coach full of children, which is not information for the internet.
router.use(protect);

// --- Fixed paths first, so none of them is ever read as an :id --------------
router.get('/mine', verifyRole('teacher', 'admin'), fieldTripController.getMyTrips);
router.get('/my-registrations', fieldTripController.getMyRegistrations);
router.get('/stats', verifyRole('teacher', 'admin'), fieldTripController.getStats);

// --- Risk assessment --------------------------------------------------------
// The document that has to exist before a coach leaves. Declared here, above
// the parameterised routes, so "/risk/..." is never read as a trip id.
// Nothing student-facing exists: an assessment names children.
router.get('/risk/meta', verifyRole('teacher', 'admin'), tripRiskController.getRiskMeta);
router.get('/risk/outstanding', verifyRole('admin'), tripRiskController.getOutstanding);
router.get('/risk/queue', verifyRole('admin'), tripRiskController.getQueue);

router.get('/risk/:id', verifyRole('teacher', 'admin'), tripRiskController.getAssessment);
router.patch('/risk/:id', verifyRole('teacher', 'admin'), tripRiskController.updateAssessment);
router.patch('/risk/:id/submit', verifyRole('teacher', 'admin'), tripRiskController.submitAssessment);
router.patch('/risk/:id/withdraw', verifyRole('teacher', 'admin'), tripRiskController.withdrawAssessment);

// Approval is refused for anyone escorting the trip, checked in the handler.
// Holding the role is necessary but not sufficient.
router.patch('/risk/:id/approve', verifyRole('teacher', 'admin'), tripRiskController.approveAssessment);
router.patch('/risk/:id/reject', verifyRole('teacher', 'admin'), tripRiskController.rejectAssessment);

// --- Organising (teachers and admins) ---------------------------------------
router.post('/', verifyRole('teacher', 'admin'), fieldTripController.createTrip);

// --- Browsing (any authenticated user) --------------------------------------
router.get('/', fieldTripController.listTrips);
router.get('/:id', fieldTripController.getTrip);

// --- Per-trip risk ----------------------------------------------------------
// "Can this trip open?" answered as a list of reasons rather than a boolean.
router.post('/:tripId/risk', verifyRole('teacher', 'admin'), tripRiskController.createAssessment);
router.get('/:tripId/risk', verifyRole('teacher', 'admin'), tripRiskController.getAssessmentForTrip);
router.get('/:tripId/risk/history', verifyRole('teacher', 'admin'), tripRiskController.getAssessmentHistory);
router.get('/:tripId/risk/readiness', verifyRole('teacher', 'admin'), tripRiskController.getReadiness);

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
