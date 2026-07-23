const express = require('express');
const router = express.Router();
const courseController = require('../controllers/courseController');
const { protect } = require('../middleware/Auth');
const { checkPermission } = require('../middleware/rbacMiddleware');
const multiLevelCache = require('../middleware/cacheMiddleware');

router.post('/', protect, checkPermission('createAny', 'course'), courseController.createCourse);
router.get('/', protect, checkPermission('readAny', 'course'), multiLevelCache(60), courseController.getCourses);
router.put('/:id', protect, checkPermission('updateOwn', 'course'), courseController.updateCourse);
router.delete('/:id', protect, checkPermission('deleteOwn', 'course'), courseController.deleteCourse);

module.exports = router;
