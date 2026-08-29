const express = require('express');
const router = express.Router();
const recruitmentController = require('../controllers/recruitmentController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Candidate contact details, interview scores and offers. Nothing here is
// public, and nothing here is reachable by students or families.
router.use(protect);
router.use(verifyRole('teacher', 'staff', 'admin'));

// --- Reference data ---------------------------------------------------------
router.get('/meta', recruitmentController.getMeta);

// --- A panellist's own work -------------------------------------------------
// Declared first so `/panel/mine` is never read as an id.
router.get('/panel/mine', recruitmentController.getMyPanelWork);

// --- Postings ---------------------------------------------------------------
router.get('/postings', verifyRole('staff', 'admin'), recruitmentController.listPostings);
router.post('/postings', verifyRole('admin'), recruitmentController.createPosting);
router.get('/postings/:id', recruitmentController.getPosting);
router.patch('/postings/:id', verifyRole('admin'), recruitmentController.updatePosting);
router.patch('/postings/:id/publish', verifyRole('admin'), recruitmentController.publishPosting);
router.patch('/postings/:id/close', verifyRole('admin'), recruitmentController.closePosting);

// The panel has to exist before publication, because the seal on the scores is
// defined by how many people are on it.
router.post('/postings/:id/panel', verifyRole('admin'), recruitmentController.addPanellist);
router.delete(
  '/postings/:id/panel/:uid',
  verifyRole('admin'),
  recruitmentController.removePanellist
);

// --- Applications -----------------------------------------------------------
router.post(
  '/postings/:id/applications',
  verifyRole('staff', 'admin'),
  recruitmentController.createApplication
);
router.get(
  '/postings/:id/applications',
  verifyRole('staff', 'admin'),
  recruitmentController.listApplications
);
router.get('/applications/:id', recruitmentController.getApplication);
router.patch(
  '/applications/:id/screen',
  verifyRole('staff', 'admin'),
  recruitmentController.screenApplication
);
router.patch(
  '/applications/:id/shortlist',
  verifyRole('admin'),
  recruitmentController.shortlistApplication
);

// Scoring is gated on being on the panel, checked in the controller. Holding a
// staff role is necessary and not sufficient.
router.post('/applications/:id/scores', recruitmentController.submitScore);

router.patch(
  '/applications/:id/interviewed',
  verifyRole('admin'),
  recruitmentController.markInterviewed
);

// --- Offers -----------------------------------------------------------------
router.patch('/applications/:id/offer', verifyRole('admin'), recruitmentController.makeOffer);
router.patch(
  '/applications/:id/offer/respond',
  verifyRole('admin'),
  recruitmentController.respondToOffer
);
router.patch(
  '/applications/:id/reject',
  verifyRole('admin'),
  recruitmentController.rejectApplication
);

// Lapses expired offers and frees the posts. Safe to call repeatedly.
router.post('/postings/:id/reconcile', verifyRole('admin'), recruitmentController.reconcilePosting);

// --- Reporting --------------------------------------------------------------
router.get('/stats', verifyRole('admin'), recruitmentController.getStats);

module.exports = router;
