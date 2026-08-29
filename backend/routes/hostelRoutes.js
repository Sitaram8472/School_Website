const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');
const hostelController = require('../controllers/hostelController');

// Where a child sleeps is not public information — every path needs a session.
router.use(protect);

const warden = verifyRole('admin', 'staff');

// ---- Boarder-facing ----
// Literal paths are declared before "/rooms/:id" so they are never captured as
// an id.
router.get('/me', hostelController.getMyRoom);

// ---- Warden-facing reads ----
router.get('/summary', warden, hostelController.getOccupancySummary);
router.get('/boarders', warden, hostelController.getBoarders);
router.post('/recompute-occupancy', verifyRole('admin'), hostelController.recomputeOccupancy);

// ---- Rooms ----
router.get('/rooms', warden, hostelController.getRooms);
router.post('/rooms', warden, hostelController.createRoom);
router.get('/rooms/:id', warden, hostelController.getRoom);
router.put('/rooms/:id', warden, hostelController.updateRoom);
router.patch('/rooms/:id/bed-status', warden, hostelController.setBedStatus);
router.delete('/rooms/:id', verifyRole('admin'), hostelController.deleteRoom);

// ---- Allocations ----
router.post('/allocations', warden, hostelController.allocateRoom);
router.post('/allocations/transfer', warden, hostelController.transferRoom);
router.patch('/allocations/:id/vacate', warden, hostelController.vacateRoom);

// Ownership is checked in the controller: a boarder reads their own history,
// a warden reads anyone's.
router.get('/allocations/student/:studentId', hostelController.getStudentAllocations);

module.exports = router;
