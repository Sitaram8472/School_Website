const express = require('express');
const router = express.Router();
const courseController = require('../controllers/courseController');
const { protect } = require('../middleware/Auth');
const { checkPermission } = require('../middleware/rbacMiddleware');
const multiLevelCache = require('../middleware/cacheMiddleware');
const verifyRole = require('../middleware/verifyRole');
const prerequisiteController = require('../controllers/prerequisiteController');

router.post('/', protect, checkPermission('createAny', 'course'), courseController.createCourse);
router.get('/', protect, checkPermission('readAny', 'course'), multiLevelCache(60), courseController.getCourses);
router.put('/:id', protect, checkPermission('updateOwn', 'course'), courseController.updateCourse);
// ---- Prerequisites ----
// Declared before '/:id' so "prerequisites" is never read as a course id.
//
// Rule writes are admin-only. The accesscontrol grants in config/roles.js give
// `createAny('course')` to teachers, which is right for creating a course and
// wrong for rewriting the curriculum graph every other course depends on, so
// these use verifyRole rather than checkPermission.
const curriculumLead = verifyRole('admin');
const teachingStaff = verifyRole('teacher', 'admin');

router.get('/prerequisites/meta', protect, prerequisiteController.getPrerequisiteMeta);
router.get('/prerequisites/mine', protect, prerequisiteController.getMyEligibility);

router.get('/prerequisites/waivers', protect, teachingStaff, prerequisiteController.getWaivers);
router.post('/prerequisites/waivers', protect, curriculumLead, prerequisiteController.createWaiver);
router.patch(
  '/prerequisites/waivers/:id/revoke',
  protect,
  curriculumLead,
  prerequisiteController.revokeWaiver
);

router.post('/prerequisites', protect, curriculumLead, prerequisiteController.createPrerequisite);
router.get('/prerequisites', protect, prerequisiteController.getPrerequisites);

router.patch('/prerequisites/:id', protect, curriculumLead, prerequisiteController.updatePrerequisite);
router.patch(
  '/prerequisites/:id/retire',
  protect,
  curriculumLead,
  prerequisiteController.retirePrerequisite
);

router.get('/prerequisites/:courseId/chain', protect, prerequisiteController.getChain);

// A student may evaluate themselves; the controller decides who else may.
router.post('/prerequisites/:courseId/evaluate', protect, prerequisiteController.evaluate);

router.post(
  '/prerequisites/:courseId/enrol',
  protect,
  teachingStaff,
  prerequisiteController.enrolWithCheck
);

router.delete('/:id', protect, checkPermission('deleteOwn', 'course'), courseController.deleteCourse);

module.exports = router;
