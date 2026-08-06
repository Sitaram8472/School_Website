const express = require('express');
const router = express.Router();
const conductController = require('../controllers/conductController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

router.use(protect);

const staffOnly = verifyRole('teacher', 'admin');

// Fixed paths before parameterised ones, so `me` and `stats` are never read as
// an entry id.
router.get('/catalogue', conductController.getCatalogue);
router.get('/me', conductController.getMyLedger);
router.get('/leaderboard', conductController.getLeaderboard);

router.get('/stats', staffOnly, conductController.getStats);
router.get('/appeals', staffOnly, conductController.getOpenAppeals);

// --- Recording -------------------------------------------------------------
// There is deliberately no PUT or PATCH for an entry's content. The ledger is
// append-only; a wrong entry is overturned on appeal or expunged by an admin,
// and both leave the original visible.
router.post('/', staffOnly, conductController.recordEntry);

// --- Reading ---------------------------------------------------------------
router.get('/student/:studentId', staffOnly, conductController.getStudentLedger);
router.get('/class/:className', staffOnly, conductController.getClassLedger);

// --- Appeals ---------------------------------------------------------------
// Filed by the student the entry is against; the model enforces that.
router.post('/:id/appeal', conductController.submitAppeal);
router.patch('/:id/appeal', staffOnly, conductController.decideAppeal);

// --- Administration --------------------------------------------------------
router.patch('/:id/notified', staffOnly, conductController.markParentNotified);
router.patch('/:id/expunge', verifyRole('admin'), conductController.expungeEntry);

module.exports = router;
