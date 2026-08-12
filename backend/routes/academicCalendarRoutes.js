const express = require('express');
const router = express.Router();
const academicCalendarController = require('../controllers/academicCalendarController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Term dates are not a secret, but they are also not the front page, and the
// draft calendar behind them is a plan rather than a publication. Everything
// here is behind a login; drafts are filtered per role in the controller.
router.use(protect);

// --- Fixed paths first, so none of them is ever read as an :id --------------
router.get('/meta', academicCalendarController.getMeta);

// The two queries the rest of the codebase needs. Open to any signed-in user
// because an attendance denominator is no use behind an admin check.
router.get('/working-days', academicCalendarController.getWorkingDays);
router.get('/is-school-day', academicCalendarController.isSchoolDay);
router.get('/session/:session/summary', academicCalendarController.getSessionSummary);

// --- Terms -------------------------------------------------------------------
// `current` before `:id`, so the word is never read as an identifier.
router.get('/terms/current', academicCalendarController.getCurrentTerm);
router.get('/terms', academicCalendarController.listTerms);
router.get('/terms/:id', academicCalendarController.getTerm);
router.get('/terms/:id/days', academicCalendarController.getTermDays);
router.get('/terms/:id/summary', academicCalendarController.getTermSummary);

router.post('/terms', verifyRole('admin'), academicCalendarController.createTerm);
router.patch('/terms/:id', verifyRole('admin'), academicCalendarController.updateTerm);
router.patch('/terms/:id/status', verifyRole('admin'), academicCalendarController.setStatus);

// --- Exceptions --------------------------------------------------------------
// A range is one row. The handler expands it, checks it against the term
// bounds, and refuses a working day that already works.
router.post(
  '/terms/:id/exceptions',
  verifyRole('admin'),
  academicCalendarController.addException
);
router.delete(
  '/terms/:id/exceptions/:eid',
  verifyRole('admin'),
  academicCalendarController.removeException
);

module.exports = router;
