const express = require('express');
const router = express.Router();
const pickupController = require('../controllers/pickupController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Every route here concerns a named child and the adults around them. Nothing
// is public, and students have no route into the module at all.
router.use(protect);

const staffOnly = verifyRole('teacher', 'staff', 'admin');

// --- Reference data ---------------------------------------------------------
router.get('/meta', pickupController.getMeta);

// --- A parent's own records -------------------------------------------------
// Declared before the parameterised routes so "mine" is never read as an id.
router.get('/authorisations/mine', pickupController.getMyAuthorisations);
router.get('/releases/mine', pickupController.getMyReleases);

// --- The gate ---------------------------------------------------------------
// Who may collect this child right now. Validity is computed per request, so a
// permission that has run out is refused without anybody having run a sweep.
router.get(
  '/students/:studentId/collectors',
  staffOnly,
  pickupController.getCollectors
);

router.post('/releases', staffOnly, pickupController.createRelease);
router.get('/releases/today', staffOnly, pickupController.getTodaysReleases);
router.get('/releases/open', staffOnly, pickupController.getOpenReleases);
router.patch('/releases/:id/return', staffOnly, pickupController.recordReturn);

// The Monday report — every release made without a valid authorisation.
router.get('/releases/overrides', verifyRole('admin'), pickupController.getOverrides);

// --- Authorisations ---------------------------------------------------------
router.post('/authorisations', pickupController.createAuthorisation);
router.get('/authorisations/pending', staffOnly, pickupController.getPendingAuthorisations);
router.get('/authorisations', staffOnly, pickupController.listAuthorisations);
router.get('/authorisations/:id', pickupController.getAuthorisation);
router.patch('/authorisations/:id', pickupController.updateAuthorisation);

// A parent cannot approve their own new collector. That is the whole point of
// the record, and the controller refuses it even for staff who requested it.
router.patch(
  '/authorisations/:id/approve',
  staffOnly,
  pickupController.approveAuthorisation
);
router.patch(
  '/authorisations/:id/suspend',
  staffOnly,
  pickupController.suspendAuthorisation
);
// Revocation is permanent — a revoked authorisation is never reactivated.
router.patch(
  '/authorisations/:id/revoke',
  staffOnly,
  pickupController.revokeAuthorisation
);
router.post('/authorisations/:id/code', pickupController.reissueCode);

// Makes the stored status agree with what the checks already compute. Safe to
// run twice, and safe never to run at all.
router.post('/authorisations/sweep', verifyRole('admin'), pickupController.sweepExpired);

// --- Reporting --------------------------------------------------------------
router.get('/stats', verifyRole('admin'), pickupController.getStats);

module.exports = router;
