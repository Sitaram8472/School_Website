const express = require('express');
const router = express.Router();
const careersController = require('../controllers/careersController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// References are confidential and counsellor notes are staff-only. Nothing here
// is public, and the confidentiality is enforced by the serializer rather than
// by which route somebody reached.
router.use(protect);

const counsellorOnly = verifyRole('teacher', 'admin');

// --- Reference data ---------------------------------------------------------
router.get('/meta', careersController.getMeta);

// --- A student's own board --------------------------------------------------
// Declared before `/applications/:id` so neither word is read as an id.
router.get('/applications/mine', careersController.getMyApplications);

// The counsellor's job, in one query: every application closing inside a
// fortnight with anything outstanding.
router.get('/applications/at-risk', counsellorOnly, careersController.getAtRisk);
router.get('/applications', counsellorOnly, careersController.listApplications);
router.get('/stats', counsellorOnly, careersController.getStats);

// --- The referee's queue ----------------------------------------------------
// A teacher sees only the requests addressed to them — not the student's list
// of colleges, which is none of their business.
router.get('/references/mine', careersController.getMyReferenceRequests);
router.patch('/references/:appId/:refId/accept', careersController.acceptReference);
router.patch('/references/:appId/:refId/decline', careersController.declineReference);
// The letter goes in here and comes back out of nothing a student can reach.
router.patch('/references/:appId/:refId/submit', careersController.submitReference);

// --- Applications -----------------------------------------------------------
router.post('/applications', careersController.createApplication);
router.get('/applications/:id', careersController.getApplication);
router.patch('/applications/:id', careersController.updateApplication);
router.patch(
  '/applications/:id/requirements/:index',
  careersController.updateRequirement
);
router.patch('/applications/:id/submit', careersController.submitApplication);
router.patch('/applications/:id/status', careersController.updateStatus);
router.patch('/applications/:id/withdraw', careersController.withdrawApplication);

// --- Offers -----------------------------------------------------------------
router.post('/applications/:id/offer', careersController.recordOffer);
// Accepting releases any previous firm acceptance first; a partial unique index
// refuses the case where two of these arrive together.
router.patch('/applications/:id/accept', careersController.acceptOffer);

// --- References the student asks for ----------------------------------------
router.post('/applications/:id/references', careersController.requestReference);

// --- Counsellor -------------------------------------------------------------
router.post('/applications/:id/notes', counsellorOnly, careersController.addNote);

module.exports = router;
