const express = require('express');
const router = express.Router();
const observationController = require('../controllers/observationController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Nothing here is public, and nothing here is for students. An observation
// record is a judgement about a member of staff's practice.
router.use(protect);
router.use(verifyRole('teacher', 'staff', 'admin'));

// --- Fixed paths first, so none of them is ever read as an :id --------------
router.get('/meta', observationController.getMeta);
router.get('/mine', observationController.getMyObservations);
router.get('/by-me', observationController.getObservationsByMe);
router.get('/actions/mine', observationController.getMyActions);
router.get('/teachers', observationController.getTeachers);
router.get('/stats', verifyRole('admin'), observationController.getStats);

// The handler lets a teacher read their own history and refuses everybody
// else's, which a role check on its own cannot express.
router.get('/history/:teacherId', observationController.getTeacherHistory);

// --- Scheduling and recording ------------------------------------------------
router.post('/', observationController.scheduleObservation);
router.get('/', verifyRole('admin'), observationController.listObservations);

// Read access is decided per document — observee, observer, moderator or
// admin — and the response is redacted by status inside the model.
router.get('/:id', observationController.getObservation);
router.patch('/:id', observationController.updateObservation);
router.patch('/:id/record', observationController.recordObservation);

// --- The gate ----------------------------------------------------------------
// Sharing is the observer's act alone, and acknowledging is the observee's.
// Neither is delegable, which is why neither is behind a role check.
router.patch('/:id/share', observationController.shareFeedback);
router.patch('/:id/acknowledge', observationController.acknowledge);

// --- Agreed actions ----------------------------------------------------------
router.post('/:id/actions', observationController.addAction);
router.patch('/:id/actions/:aid', observationController.updateAction);

// --- Moderation and closing --------------------------------------------------
// Eligibility (not the observer, not the observee, already shared) is checked
// in the handler.
router.patch('/:id/moderate', verifyRole('admin'), observationController.moderate);
router.patch('/:id/close', observationController.closeObservation);
router.patch('/:id/cancel', observationController.cancelObservation);

module.exports = router;
