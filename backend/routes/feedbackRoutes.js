const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');
const feedbackController = require('../controllers/feedbackController');

// Everything under /api/feedback needs a session — the respondent key is
// derived from the signed-in user, so an anonymous survey still requires
// authentication. That is what makes "one response per person" possible without
// storing who anybody is.
router.use(protect);

const author = verifyRole('teacher', 'admin');

// ---- Reading ----
// Literal paths first so they are not swallowed by "/surveys/:id".
router.get('/surveys/mine', author, feedbackController.getMySurveys);
router.get('/my-submissions', feedbackController.getMySubmissions);

router.get('/surveys', feedbackController.getOpenSurveys);
router.post('/surveys', author, feedbackController.createSurvey);

// Audience and ownership are both checked inside the controller.
router.get('/surveys/:id', feedbackController.getSurvey);

// ---- Authoring ----
router.patch('/surveys/:id', author, feedbackController.updateSurvey);
router.patch('/surveys/:id/publish', author, feedbackController.publishSurvey);
router.patch('/surveys/:id/close', author, feedbackController.closeSurvey);
router.delete('/surveys/:id', author, feedbackController.deleteSurvey);

// ---- Responding ----
router.post('/surveys/:id/responses', feedbackController.submitResponse);

// ---- Results ----
// Threshold-gated inside the controller, including for the survey's own author.
router.get('/surveys/:id/results', author, feedbackController.getResults);

router.get('/stats', author, feedbackController.getStats);

module.exports = router;
