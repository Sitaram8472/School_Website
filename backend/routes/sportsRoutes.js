const express = require('express');
const router = express.Router();
const sportsController = require('../controllers/sportsController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Fixtures and standings are for the school, not the internet. Everything here
// needs a session; the difference between a student and a member of staff is
// read against write, applied per route below.
router.use(protect);

// --- Reference data ---------------------------------------------------------
router.get('/meta', sportsController.getMeta);

// --- Reading (any signed-in user) -------------------------------------------
// `/standings` and `/schedule` are declared before `/fixtures/:id` so neither
// word can ever be read as an id.
router.get('/standings', sportsController.getStandings);
router.get('/schedule', sportsController.getSchedule);
router.get('/stats', verifyRole('teacher', 'admin'), sportsController.getStats);

router.get('/fixtures', sportsController.listFixtures);
router.get('/fixtures/:id', sportsController.getFixture);

// --- Running the competition (staff) ----------------------------------------
router.post(
  '/fixtures',
  verifyRole('teacher', 'admin'),
  sportsController.createFixture
);
router.patch(
  '/fixtures/:id',
  verifyRole('teacher', 'admin'),
  sportsController.updateFixture
);
router.post(
  '/fixtures/:id/officials',
  verifyRole('teacher', 'admin'),
  sportsController.assignOfficials
);

// --- Match day --------------------------------------------------------------
router.patch(
  '/fixtures/:id/start',
  verifyRole('teacher', 'admin'),
  sportsController.startFixture
);
router.patch(
  '/fixtures/:id/result',
  verifyRole('teacher', 'admin'),
  sportsController.recordResult
);
router.patch(
  '/fixtures/:id/walkover',
  verifyRole('teacher', 'admin'),
  sportsController.recordWalkover
);
router.patch(
  '/fixtures/:id/abandon',
  verifyRole('teacher', 'admin'),
  sportsController.abandonFixture
);

// Corrections. Clearing a result reopens the fixture and the table recomputes.
router.delete(
  '/fixtures/:id/result',
  verifyRole('teacher', 'admin'),
  sportsController.clearResult
);
router.patch(
  '/fixtures/:id/cancel',
  verifyRole('teacher', 'admin'),
  sportsController.cancelFixture
);

module.exports = router;
