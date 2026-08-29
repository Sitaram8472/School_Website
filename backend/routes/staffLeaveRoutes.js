const express = require('express');
const router = express.Router();
const staffLeaveController = require('../controllers/staffLeaveController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Leave records carry medical certificate references and stated reasons about
// named colleagues. Nothing here is public and nothing here is open to
// students or parents.
router.use(protect);
router.use(verifyRole('teacher', 'staff', 'admin'));

// --- Reference data ---------------------------------------------------------
router.get('/meta', staffLeaveController.getMeta);

// --- A member of staff's own ledger -----------------------------------------
// Declared before the parameterised routes so "mine" is never read as an id.
router.get('/entitlements/mine', staffLeaveController.getMyEntitlement);
router.get('/requests/mine', staffLeaveController.getMyRequests);

// What would this leave cost, and what would be left? Answered before the
// request is raised rather than at approval time a fortnight later.
router.post('/requests/preview', staffLeaveController.previewRequest);

// --- Approval and reporting (admin) -----------------------------------------
router.get(
  '/requests/pending',
  verifyRole('admin'),
  staffLeaveController.getPendingRequests
);
router.get('/requests/calendar', verifyRole('admin'), staffLeaveController.getCalendar);
router.get('/requests', verifyRole('admin'), staffLeaveController.listRequests);
router.get('/stats', verifyRole('admin'), staffLeaveController.getStats);

// --- Entitlements -----------------------------------------------------------
router.get('/entitlements', verifyRole('admin'), staffLeaveController.listEntitlements);
router.post('/entitlements', verifyRole('admin'), staffLeaveController.createEntitlement);
router.get(
  '/entitlements/:staffId',
  verifyRole('admin'),
  staffLeaveController.getStaffEntitlement
);
router.patch(
  '/entitlements/:id',
  verifyRole('admin'),
  staffLeaveController.updateEntitlement
);

// Carry-over for everybody at once. Idempotent, so pressing it twice in April
// costs nobody their leave.
router.post('/years/:year/close', verifyRole('admin'), staffLeaveController.closeYear);

// --- Requests ---------------------------------------------------------------
router.post('/requests', staffLeaveController.createRequest);
router.get('/requests/:id', staffLeaveController.getRequest);
router.patch('/requests/:id', staffLeaveController.updateRequest);
router.patch('/requests/:id/submit', staffLeaveController.submitRequest);
router.patch('/requests/:id/cancel', staffLeaveController.cancelRequest);

// Self-approval is refused in the controller and in the model. Holding the
// admin role is necessary but not sufficient.
router.patch(
  '/requests/:id/approve',
  verifyRole('admin'),
  staffLeaveController.approveRequest
);
router.patch(
  '/requests/:id/reject',
  verifyRole('admin'),
  staffLeaveController.rejectRequest
);

module.exports = router;
