const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');
const timetableController = require('../controllers/timetableController');

// Every timetable endpoint needs a session — a school timetable is not public.
router.use(protect);

const staff = verifyRole('teacher', 'admin');

// ---- Resolved views (any signed-in user) ----
// Declared before "/:id" so these literal paths are not captured as an id.
router.get('/me', timetableController.getMyTimetable);
router.get('/today', timetableController.getTodaySchedule);

// ---- Management ----
router.get('/', staff, timetableController.getTimetables);
router.post('/', staff, timetableController.createTimetable);

router.get('/:id', timetableController.getTimetable);
router.put('/:id', staff, timetableController.updateTimetable);
router.delete('/:id', staff, timetableController.deleteTimetable);

// ---- Periods ----
router.post('/:id/periods', staff, timetableController.addPeriod);
router.put('/:id/periods/:periodId', staff, timetableController.updatePeriod);
router.delete('/:id/periods/:periodId', staff, timetableController.removePeriod);

// ---- Publishing ----
router.patch('/:id/activate', staff, timetableController.activateTimetable);
router.patch('/:id/deactivate', staff, timetableController.deactivateTimetable);

module.exports = router;
