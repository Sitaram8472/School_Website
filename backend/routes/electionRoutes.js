const express = require('express');
const router = express.Router();
const electionController = require('../controllers/electionController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Nothing here is public. A ballot paper on the open internet is a ballot paper
// anybody can fill in.
router.use(protect);

// --- Fixed paths first, so none of them is ever read as an :id --------------
router.get('/meta', electionController.getMeta);
router.get('/seconders', electionController.getSeconders);
router.get('/stats', verifyRole('teacher', 'staff', 'admin'), electionController.getStats);

// --- Running an election -----------------------------------------------------
router.post('/', verifyRole('admin'), electionController.createElection);
router.get('/', electionController.listElections);
router.get('/:id', electionController.getElection);
router.patch('/:id', verifyRole('admin'), electionController.updateElection);
router.patch('/:id/status', verifyRole('admin'), electionController.setStatus);

// --- Nominations -------------------------------------------------------------
// Standing is self-nomination only: the handler reads the candidate off the
// session, so there is no field in which to name somebody else.
router.post('/:id/nominate', verifyRole('student'), electionController.nominate);
router.patch(
  '/:id/nominations/withdraw',
  verifyRole('student'),
  electionController.withdrawNomination
);
router.get(
  '/:id/nominations',
  verifyRole('teacher', 'staff', 'admin'),
  electionController.listNominations
);
router.patch(
  '/:id/nominations/:cid',
  verifyRole('teacher', 'staff', 'admin'),
  electionController.reviewNomination
);

// --- Voting ------------------------------------------------------------------
// The roll entry is written before any ballot, so the unique index rejects a
// second vote before a ballot can exist. See the controller.
router.post('/:id/vote', verifyRole('student'), electionController.castVote);

// Answers only "have I voted". There is no endpoint that answers it about
// anybody else, and no stored data that could answer what anybody chose.
router.get('/:id/my-status', electionController.getMyStatus);

// --- Results -----------------------------------------------------------------
router.patch('/:id/publish', verifyRole('admin'), electionController.publishResults);
router.get('/:id/results', electionController.getResults);

module.exports = router;
