const express = require('express');
const router = express.Router();
const staffTrainingController = require('../controllers/staffTrainingController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Training records carry reflections and decline reasons about named staff.
// Nothing here is public and nothing here is open to students.
router.use(protect);
router.use(verifyRole('teacher', 'staff', 'admin'));

// --- Reference data ---------------------------------------------------------
router.get('/meta', staffTrainingController.getMeta);

// --- A member of staff's own records ----------------------------------------
// Declared before `/records/:id` so "mine" is never read as an id.
router.get('/records/mine', staffTrainingController.getMyRecords);
router.get('/summary/mine', staffTrainingController.getMySummary);

// --- School-wide reporting (admin) ------------------------------------------
// `/expiring` is the query this module exists for.
router.get('/expiring', verifyRole('admin'), staffTrainingController.getExpiring);
router.get('/stats', verifyRole('admin'), staffTrainingController.getStats);
router.get('/records', verifyRole('admin'), staffTrainingController.listRecords);
router.get(
  '/summary/:staffId',
  verifyRole('admin'),
  staffTrainingController.getStaffSummary
);

// --- Records ----------------------------------------------------------------
router.post('/records', staffTrainingController.createRecord);
router.get('/records/:id', staffTrainingController.getRecord);
router.patch('/records/:id', staffTrainingController.updateRecord);
router.patch('/records/:id/start', staffTrainingController.startRecord);
router.patch('/records/:id/complete', staffTrainingController.completeRecord);
router.patch('/records/:id/cancel', staffTrainingController.cancelRecord);

// Recording a certificate is what produces the expiry date; the date itself is
// never in the payload.
router.patch('/records/:id/certificate', staffTrainingController.setCertificate);

// --- Approval ---------------------------------------------------------------
router.patch(
  '/records/:id/request-approval',
  staffTrainingController.requestApproval
);
// Self-approval is refused in the controller. Holding the admin role is
// necessary but not sufficient.
router.patch(
  '/records/:id/approve',
  verifyRole('admin'),
  staffTrainingController.approveRecord
);
router.patch(
  '/records/:id/decline',
  verifyRole('admin'),
  staffTrainingController.declineRecord
);

module.exports = router;
