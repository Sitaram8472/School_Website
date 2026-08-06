const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');
const healthController = require('../controllers/healthController');

// No public path exists in this module by design.
router.use(protect);

const medicalStaff = verifyRole('admin', 'staff');

// ---- Student-facing ----
// Literal segments come before any "/:id" so they are never read as an id.
router.get('/me', healthController.getMyHealthProfile);

// A student may maintain their own profile; the office may maintain anyone's.
// Which of the two applies is decided inside the controller.
router.post('/profile', healthController.upsertHealthProfile);
router.put('/profile', healthController.upsertHealthProfile);

// ---- Infirmary ----
router.get('/infirmary/summary', medicalStaff, healthController.getInfirmarySummary);
router.get('/visits', medicalStaff, healthController.getVisits);
router.post('/visits', medicalStaff, healthController.recordVisit);
router.patch('/visits/:id/notify-parent', medicalStaff, healthController.markParentNotified);
router.patch('/visits/:id/complete-follow-up', medicalStaff, healthController.completeFollowUp);

// There is deliberately no DELETE for a visit — the log is append-only, which
// is the only way it stays worth anything if it is ever questioned.

// ---- Profiles ----
router.get('/profiles', medicalStaff, healthController.listHealthProfiles);
router.get('/profiles/:studentId/alerts', medicalStaff, healthController.getCriticalAlerts);

// Ownership is enforced in the controller: the owning student, or the office.
router.get('/profiles/:studentId', healthController.getStudentHealthProfile);
router.get('/visits/student/:studentId', healthController.getStudentVisits);

module.exports = router;
