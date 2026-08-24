const express = require('express');
const router = express.Router();
const staffTrainingController = require('../controllers/staffTrainingController');
const cohortController = require('../controllers/trainingCohortController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Training records carry reflections and decline reasons about named staff.
// Nothing here is public and nothing here is open to students.
router.use(protect);
router.use(verifyRole('teacher', 'staff', 'admin'));

// --- Reference data ---------------------------------------------------------
router.get('/meta', staffTrainingController.getMeta);

// --- Cohorts ----------------------------------------------------------------
// A cohort is one scheduled run of one course, with a fixed number of chairs.
// TrainingRecord is what somebody did; this is what the school runs. Static
// segments are declared before `/cohorts/:id`.
router.get('/cohorts/meta', cohortController.getCohortMeta);
router.get('/cohorts/mine', cohortController.getMyCohorts);
router.get('/cohorts/calendar', cohortController.getCalendar);
router.get('/cohorts', cohortController.getCohorts);

// Only an admin schedules a session or changes its shape.
router.post('/cohorts', verifyRole('admin'), cohortController.createCohort);

router.get('/cohorts/:id', cohortController.getCohort);
router.patch('/cohorts/:id', verifyRole('admin'), cohortController.updateCohort);
router.patch('/cohorts/:id/status', verifyRole('admin'), cohortController.setStatus);
router.patch('/cohorts/:id/cancel', verifyRole('admin'), cohortController.cancelCohort);

// Any member of staff may take their own seat; enrolling somebody else is an
// admin act and is logged as one.
router.post('/cohorts/:id/enrol', cohortController.enrolSelf);
router.post('/cohorts/:id/enrol/:staffId', verifyRole('admin'), cohortController.enrolOther);
router.patch('/cohorts/:id/withdraw', cohortController.withdraw);
router.patch('/cohorts/:id/promote', verifyRole('admin'), cohortController.promote);

// The register belongs to the facilitator, checked in the handler rather than
// by role — an admin qualifies, any other teacher does not.
router.get('/cohorts/:id/register', cohortController.getRegister);
router.patch('/cohorts/:id/attendance/:staffId', cohortController.markAttendance);

// The report that makes `isMandatory` mean something.
router.get('/cohorts/:id/gap', verifyRole('admin'), cohortController.getMandatoryGap);

// --- A member of staff's own records ----------------------------------------
// Declared before `/records/:id` so "mine" is never read as an id.
router.get('/records/mine', staffTrainingController.getMyRecords);
router.get('/summary/mine', staffTrainingController.getMySummary);

// --- School-wide reporting (admin) ------------------------------------------
// `/expiring` is the query this module exists for.
router.get('/expiring', verifyRole('admin'), staffTrainingController.getExpiring);
router.get('/stats', verifyRole('admin'), staffTrainingController.getStats);
router.get('/records', verifyRole('admin'), staffTrainingController.listRecords);
router.get(
  '/summary/:staffId',
  verifyRole('admin'),
  staffTrainingController.getStaffSummary
);

// --- Records ----------------------------------------------------------------
router.post('/records', staffTrainingController.createRecord);
router.get('/records/:id', staffTrainingController.getRecord);
router.patch('/records/:id', staffTrainingController.updateRecord);
router.patch('/records/:id/start', staffTrainingController.startRecord);
router.patch('/records/:id/complete', staffTrainingController.completeRecord);
router.patch('/records/:id/cancel', staffTrainingController.cancelRecord);

// Recording a certificate is what produces the expiry date; the date itself is
// never in the payload.
router.patch('/records/:id/certificate', staffTrainingController.setCertificate);

// --- Approval ---------------------------------------------------------------
router.patch(
  '/records/:id/request-approval',
  staffTrainingController.requestApproval
);
// Self-approval is refused in the controller. Holding the admin role is
// necessary but not sufficient.
router.patch(
  '/records/:id/approve',
  verifyRole('admin'),
  staffTrainingController.approveRecord
);
router.patch(
  '/records/:id/decline',
  verifyRole('admin'),
  staffTrainingController.declineRecord
);

module.exports = router;
