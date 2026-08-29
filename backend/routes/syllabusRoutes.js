const express = require('express');
const router = express.Router();
const syllabusController = require('../controllers/syllabusController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// A syllabus plan says which classes are behind and by how much. That is staff
// information, so nothing here is public and nothing here is open to students.
router.use(protect);
router.use(verifyRole('teacher', 'admin'));

// --- A teacher's own plans --------------------------------------------------
// Declared before `/plans/:id` so "mine" is never read as an id.
router.get('/plans/mine', syllabusController.getMyPlans);

// --- School-wide reporting (admin) ------------------------------------------
router.get('/overview', verifyRole('admin'), syllabusController.getOverview);
router.get('/stats', verifyRole('admin'), syllabusController.getStats);
router.get('/plans', verifyRole('admin'), syllabusController.listPlans);

// --- Plans ------------------------------------------------------------------
router.post('/plans', syllabusController.createPlan);
router.get('/plans/:id', syllabusController.getPlan);
router.patch('/plans/:id', syllabusController.updatePlan);
router.patch('/plans/:id/activate', syllabusController.activatePlan);
router.patch('/plans/:id/archive', verifyRole('admin'), syllabusController.archivePlan);

// --- Units ------------------------------------------------------------------
// Ownership is checked in the controller, so a teacher can only reach their own.
router.post('/plans/:id/units', syllabusController.addUnit);
router.patch('/plans/:id/units/:unitId', syllabusController.updateUnit);
router.patch('/plans/:id/units/:unitId/reorder', syllabusController.reorderUnit);
router.patch('/plans/:id/units/:unitId/complete', syllabusController.completeUnit);
router.patch('/plans/:id/units/:unitId/defer', syllabusController.deferUnit);
router.delete('/plans/:id/units/:unitId', syllabusController.removeUnit);

// --- The lesson log ---------------------------------------------------------
// Coverage is derived from these, so this is the only route that can move a
// plan's percentage.
router.post('/plans/:id/units/:unitId/sessions', syllabusController.logSession);
router.delete(
  '/plans/:id/units/:unitId/sessions/:sessionId',
  syllabusController.removeSession
);

module.exports = router;
