const express = require('express');
const router = express.Router();
const safetyController = require('../controllers/safetyController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// A drill record names children who could not be found. None of it is public,
// and none of it is for students either.
router.use(protect);

// --- Fixed paths first, so none of them is ever read as an :id --------------
router.get('/stats', verifyRole('admin'), safetyController.getStats);

// --- Events -----------------------------------------------------------------
router.post('/events', verifyRole('admin'), safetyController.createEvent);
router.get('/events', verifyRole('teacher', 'admin'), safetyController.listEvents);
router.get('/events/:id', verifyRole('teacher', 'admin'), safetyController.getEvent);
router.patch('/events/:id', verifyRole('teacher', 'admin'), safetyController.updateEvent);
router.patch('/events/:id/start', verifyRole('teacher', 'admin'), safetyController.startEvent);
router.patch('/events/:id/cancel', verifyRole('admin'), safetyController.cancelEvent);

// --- Roll calls -------------------------------------------------------------
// Submitted per class by whoever is standing with that class, so the counts
// arrive in parallel instead of through one person with a clipboard.
router.post(
  '/events/:id/roll-calls',
  verifyRole('teacher', 'admin'),
  safetyController.submitRollCall
);
router.patch(
  '/events/:id/roll-calls/:rollCallId/unaccounted/:entryId/resolve',
  verifyRole('teacher', 'admin'),
  safetyController.resolveUnaccounted
);

// --- The live board (coordinator or admin, checked in the handler) ----------
router.get('/events/:id/board', verifyRole('teacher', 'admin'), safetyController.getBoard);

// --- Observations and follow-up actions -------------------------------------
router.post(
  '/events/:id/observations',
  verifyRole('teacher', 'admin'),
  safetyController.addObservation
);
router.post('/events/:id/actions', verifyRole('teacher', 'admin'), safetyController.addAction);
router.patch(
  '/events/:id/actions/:actionId',
  verifyRole('teacher', 'admin'),
  safetyController.updateAction
);

// --- All clear and closure --------------------------------------------------
// Both refuse while anybody is unaccounted for. There is no override.
router.patch(
  '/events/:id/all-clear',
  verifyRole('teacher', 'admin'),
  safetyController.soundAllClear
);
router.patch('/events/:id/close', verifyRole('admin'), safetyController.closeEvent);

module.exports = router;
