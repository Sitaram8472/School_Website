const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');
const financialAidController = require('../controllers/financialAidController');

// Everything under /api/financial-aid needs a session.
router.use(protect);

// The aid committee. Teachers are not included — a teacher seeing a family's
// declared household income is not something this module needs to allow.
const committee = verifyRole('admin', 'staff');

// Opening a fund and moving its budget is an admin decision.
const admin = verifyRole('admin');

// ---- Programs ----
router.get('/programs', financialAidController.getPrograms);
router.post('/programs', admin, financialAidController.createProgram);
router.put('/programs/:id', admin, financialAidController.updateProgram);
router.patch('/programs/:id/close', admin, financialAidController.closeProgram);

// ---- Applications ----
// Declared before "/applications/:id" so the literal path is never swallowed by
// the parameterised route.
router.get('/applications/me', financialAidController.getMyApplications);

router.get('/applications', committee, financialAidController.getApplications);
router.post('/applications', financialAidController.createApplication);

// Ownership is checked inside the controller so a family can open their own
// application while the committee can open anyone's.
router.get('/applications/:id', financialAidController.getApplication);

router.patch('/applications/:id', financialAidController.updateApplication);
router.patch('/applications/:id/submit', financialAidController.submitApplication);
router.patch('/applications/:id/withdraw', financialAidController.withdrawApplication);

// The budget-guarded decision.
router.patch('/applications/:id/review', committee, financialAidController.reviewApplication);

// ---- Reporting ----
router.get('/summary', committee, financialAidController.getSummary);

module.exports = router;
