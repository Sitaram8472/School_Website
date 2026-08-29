const express = require('express');

const router = express.Router();
const progressionController = require('../controllers/progressionController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

/**
 * Year-end progression.
 *
 * Mounted under a static `/progression` prefix on `/api/reports`, which applies
 * `protect` per route rather than globally, so this router attaches it itself.
 *
 * A student reaches `/mine` and their own published decision, and nothing else.
 * Before publication the decision does not exist as far as they are concerned,
 * which is the only honest thing to say while it is still being argued about.
 */

router.use(protect);

const staff = verifyRole('teacher', 'admin');
const office = verifyRole('admin');

router.get('/meta', progressionController.getMeta);

// --- The student's own ------------------------------------------------------
// Declared before `/:id` so "mine" is never read as an identifier. Published
// decisions only, and never the reasoning behind them.
router.get('/mine', verifyRole('student', 'teacher', 'admin'), progressionController.getMine);

// --- Rules ------------------------------------------------------------------
// The thresholds, written down rather than remembered. Only an admin sets them,
// and they cannot move once the cohort has been published.
router.get('/rules', staff, progressionController.listRules);
router.post('/rules', office, progressionController.createRule);
router.patch('/rules/:id', office, progressionController.updateRule);

// --- Cohorts ----------------------------------------------------------------
// Static segments and the two-part class/year path are declared above `/:id`.
router.get('/cohorts', staff, progressionController.listCohorts);
router.get('/cohorts/:className/:academicYear', staff, progressionController.getCohort);
router.post(
  '/cohorts/:className/:academicYear/generate',
  office,
  progressionController.generateCohort
);
// One-way and cohort-wide. Refused while any decision is undecided or any
// override is uncountersigned.
router.post(
  '/cohorts/:className/:academicYear/publish',
  office,
  progressionController.publishCohort
);

// --- Evidence ---------------------------------------------------------------
// Computed from the registers and the submissions, on demand. Nothing a client
// sends is used.
router.get('/evidence/:studentId', staff, progressionController.getEvidence);

// --- Decisions --------------------------------------------------------------
router.get('/', staff, progressionController.listDecisions);

// Ownership is decided in the handler: a student may open their own once it is
// published, and sees the outcome without the reasoning.
router.get('/:id', progressionController.getDecision);

router.patch('/:id/decide', staff, progressionController.decide);

// An override is two people or it is not an override; self-countersigning is
// refused in the handler and again in the model.
router.patch('/:id/countersign', office, progressionController.countersign);

router.patch('/:id/withdraw', office, progressionController.withdraw);

router.post('/:id/conditions', staff, progressionController.addCondition);
// The one act allowed after publication, because discharging a condition later
// is the whole purpose of attaching one.
router.patch('/:id/conditions/:index/settle', staff, progressionController.settleCondition);

module.exports = router;
