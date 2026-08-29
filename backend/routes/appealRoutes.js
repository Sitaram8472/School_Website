const express = require('express');
const router = express.Router();
const appealController = require('../controllers/appealController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Appeals carry a student's marks and their case for changing them. Nothing
// here is public.
router.use(protect);

// --- Reference data ---------------------------------------------------------
router.get('/meta', appealController.getMeta);

// --- Appeal windows ---------------------------------------------------------
// When a cohort may appeal a given exam, and until when. Mounted well above
// `/:id` so "windows" is never read as an appeal id, and required inline so
// this sub-resource costs the file one line rather than two.
router.use('/windows', require('./appealWindowRoutes'));

// --- A student's own view ---------------------------------------------------
// Declared before `/:id` so none of these words is ever read as an id.
router.get('/mine', appealController.getMyAppeals);
router.get('/appealable', appealController.getAppealable);

router.post('/', appealController.createAppeal);
router.patch('/:id/withdraw', appealController.withdrawAppeal);

// --- The reviewer's queue (staff) -------------------------------------------
router.get('/queue', verifyRole('teacher', 'admin'), appealController.getQueue);
router.get('/stats', verifyRole('admin'), appealController.getStats);
router.get('/', verifyRole('teacher', 'admin'), appealController.listAppeals);

// Ownership for a student, staff access for everyone else, checked in the
// handler because the rule depends on the document rather than the role alone.
router.get('/:id', appealController.getAppeal);

// --- Review -----------------------------------------------------------------
// Reviewer eligibility is enforced in the controller on every one of these:
// the person who marked the submission cannot become its reviewer by any path,
// including by picking it up off the queue themselves.
router.patch('/:id/assign', verifyRole('admin'), appealController.assignReviewer);
router.patch('/:id/start', verifyRole('teacher', 'admin'), appealController.startReview);
router.patch(
  '/:id/questions/:answerId',
  verifyRole('teacher', 'admin'),
  appealController.decideQuestion
);

// The only route that writes a mark back to a submission, and it appends the
// audit row in the same request.
router.patch(
  '/:id/decide',
  verifyRole('teacher', 'admin'),
  appealController.decideAppeal
);

// The only way past a closed window, and itself audited.
router.patch('/:id/reopen', verifyRole('admin'), appealController.reopenAppeal);

module.exports = router;
