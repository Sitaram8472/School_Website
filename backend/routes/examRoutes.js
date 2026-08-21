const express = require('express');
const router = express.Router();
const examController = require('../controllers/examController');
const { protect } = require('../middleware/Auth');
const { checkPermission } = require('../middleware/rbacMiddleware');
const verifyRole = require('../middleware/verifyRole');
const itemAnalysisController = require('../controllers/itemAnalysisController');

router.post('/', protect, checkPermission('createAny', 'exam'), examController.createExam);
router.get('/', protect, checkPermission('readAny', 'exam'), examController.getAllExams);
router.get('/course/:courseId', protect, checkPermission('readAny', 'exam'), examController.getExamsForCourse);
router.get('/:id', protect, checkPermission('readAny', 'exam'), examController.getExam);
// ---- Item analysis ----
// Declared before '/:id' so "item-analysis" is never read as an exam id.
//
// There is deliberately no student-facing route here. Per-question statistics
// on a small cohort say who got what wrong, and the accesscontrol grants give
// students readAny('exam') — so these use verifyRole instead, and the
// controller narrows it again to the exam's own creator.
const analyst = verifyRole('teacher', 'admin');

router.get('/item-analysis/meta', protect, analyst, itemAnalysisController.getAnalysisMeta);
router.get('/item-analysis/flagged', protect, verifyRole('admin'), itemAnalysisController.getFlagged);
router.get('/item-analysis/:id', protect, analyst, itemAnalysisController.getAnalysis);
router.post('/item-analysis/:id/notes', protect, analyst, itemAnalysisController.addNote);

router.post('/:examId/item-analysis', protect, analyst, itemAnalysisController.runAnalysis);
router.get('/:examId/item-analysis', protect, analyst, itemAnalysisController.getLatestAnalysis);
router.get(
  '/:examId/item-analysis/history',
  protect,
  analyst,
  itemAnalysisController.getAnalysisHistory
);

router.put('/:id', protect, checkPermission('updateOwn', 'exam'), examController.updateExam);
router.delete('/:id', protect, checkPermission('deleteOwn', 'exam'), examController.deleteExam);

module.exports = router;
