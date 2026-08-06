const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');
const transportController = require('../controllers/transportController');

// Nothing in the transport module is public — a stop list plus a timetable is
// exactly the information you would not want a stranger to have.
router.use(protect);

const transportOffice = verifyRole('admin', 'staff');

// ---- Student-facing ----
// "/me" and "/summary" are declared before "/:id" so those literal paths are
// never swallowed by the id parameter.
router.get('/me', transportController.getMyTransport);

// ---- Office-facing reads ----
router.get('/summary', transportOffice, transportController.getTransportSummary);
router.post('/recompute-occupancy', verifyRole('admin'), transportController.recomputeOccupancy);

// ---- Routes ----
router.get('/routes', transportController.getRoutes);
router.post('/routes', transportOffice, transportController.createRoute);
router.get('/routes/:id', transportController.getRoute);
router.put('/routes/:id', transportOffice, transportController.updateRoute);
router.put('/routes/:id/stops', transportOffice, transportController.replaceStops);
router.get('/routes/:id/roster', transportOffice, transportController.getRouteRoster);
router.delete('/routes/:id', verifyRole('admin'), transportController.deleteRoute);

// ---- Assignments ----
router.post('/assignments', transportOffice, transportController.assignStudent);
router.patch('/assignments/:id/cancel', transportOffice, transportController.cancelAssignment);

// Ownership is checked inside the controller: a student may read their own
// history, the transport office may read anyone's.
router.get('/assignments/student/:studentId', transportController.getStudentAssignment);

module.exports = router;
