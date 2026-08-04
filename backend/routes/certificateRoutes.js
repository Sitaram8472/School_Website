const express = require('express');
const router = express.Router();
const certificateController = require('../controllers/certificateController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

/**
 * Public verification.
 *
 * Declared before `router.use(protect)` on purpose: the party who needs to
 * check a certificate is an admissions clerk at another institution who has no
 * account here and never will. Requiring a login would make the feature
 * pointless.
 *
 * Declared before `/:id` as well, so `verify` is never swallowed as a request
 * id.
 */
router.get('/verify/:code', certificateController.verifyCertificate);

// Everything below needs an account.
router.use(protect);

const officeOnly = verifyRole('teacher', 'staff', 'admin');

// --- Office queue ----------------------------------------------------------
router.get('/queue', officeOnly, certificateController.getQueue);
router.get('/stats', officeOnly, certificateController.getStats);

// --- Requester -------------------------------------------------------------
router.post('/', certificateController.submitRequest);
router.get('/mine', certificateController.getMyRequests);
router.get('/:id', certificateController.getRequest);
router.patch('/:id/cancel', certificateController.cancelRequest);

// Both sides post here; the controller decides whether a remark may be
// internal.
router.post('/:id/remarks', certificateController.addRemark);

// --- Processing ------------------------------------------------------------
router.patch('/:id/review', officeOnly, certificateController.startReview);
router.patch('/:id/request-info', officeOnly, certificateController.requestInformation);
router.patch('/:id/approve', officeOnly, certificateController.approveRequest);
router.patch('/:id/issue', officeOnly, certificateController.issueCertificate);
router.patch('/:id/collected', officeOnly, certificateController.markCollected);
router.patch('/:id/reject', officeOnly, certificateController.rejectRequest);

// Revoking an issued document is an admin decision, not a counter decision.
router.patch('/:id/revoke', verifyRole('admin'), certificateController.revokeCertificate);

module.exports = router;
