const express = require('express');
const router = express.Router();
const examController = require('../controllers/examController');
const { protect } = require('../middleware/Auth');
const { checkPermission } = require('../middleware/rbacMiddleware');

router.post('/', protect, checkPermission('createAny', 'exam'), examController.createExam);
router.get('/', protect, checkPermission('readAny', 'exam'), examController.getAllExams);
router.get('/course/:courseId', protect, checkPermission('readAny', 'exam'), examController.getExamsForCourse);
router.get('/:id', protect, checkPermission('readAny', 'exam'), examController.getExam);
router.put('/:id', protect, checkPermission('updateOwn', 'exam'), examController.updateExam);
router.delete('/:id', protect, checkPermission('deleteOwn', 'exam'), examController.deleteExam);

module.exports = router;
