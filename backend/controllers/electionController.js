const mongoose = require('mongoose');
const Election = require('../models/Election');
const { Ballot, VoterRoll, tallyElection, toHourBucket } = require('../models/Ballot');
const User = require('../models/User');

/**
 * Student council elections.
 *
 * `castVote` is the handler the module exists for, and the order of its writes
 * is the guarantee:
 *
 *   1. insert the `VoterRoll` entry
 *   2. if the unique index rejects it, stop — this student has already voted
 *   3. only then insert the ballots
 *
 * Doing it the other way round fails open. A counted ballot with no roll entry
 * is a double vote, and it is undetectable afterwards because the ballot does
 * not know who cast it. Failing *closed* — a roll entry with no ballots, from a
 * crash between steps 1 and 3 — costs that student their vote, which is bad and
 * is also visible, correctable by a human, and cannot silently change a result.
 *
 * `publishResults` counts from the ballot collection once and freezes the
 * answer on the election. There is no running counter anywhere in this module.
 */

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

function ok(res, data, extra = {}) {
  return res.status(200).json({ success: true, data, ...extra });
}

function serverError(res, error, message) {
  console.error(`${message}:`, error);
  return res.status(500).json({
    success: false,
    message,
    error: error.message,
  });
}

function validationMessage(error) {
  if (!error) return null;
  if (error.name === 'ValidationError') {
    return Object.values(error.errors)
      .map((e) => e.message)
      .join(' ');
  }
  if (error.name === 'ValidatorError' || error.name === 'CastError') {
    return error.message;
  }
  return null;
}

function isAdmin(user) {
  return user && user.role === 'admin';
}

function isStaff(user) {
  return user && (user.role === 'teacher' || user.role === 'staff' || user.role === 'admin');
}

function parseDate(value, fieldLabel) {
  if (value === undefined || value === null || value === '') return { value: undefined };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { error: `${fieldLabel} is not a valid date` };
  return { value: date };
}

/**
 * A user's year group.
 *
 * The `User` schema in this repo has no year-group field yet, so this reads
 * whichever of the plausible names is present rather than inventing a
 * migration. When none is set, `isEligibleFor` treats an unrestricted election
 * as open and a restricted one as closed, which is the safe direction.
 */
function yearGroupOf(user) {
  if (!user) return null;
  return user.yearGroup || user.className || user.grade || null;
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/**
 * GET /api/elections/meta
 */
exports.getMeta = async (req, res) => {
  try {
    return ok(res, {
      statuses: Election.STATUSES,
      transitions: Election.LEGAL_TRANSITIONS,
      candidateStatuses: Election.CANDIDATE_STATUSES,
      maxPositions: Election.MAX_POSITIONS,
      minManifesto: Election.MIN_MANIFESTO,
      maxManifesto: Election.MAX_MANIFESTO,
    });
  } catch (error) {
    return serverError(res, error, 'Could not load election reference data');
  }
};

// ---------------------------------------------------------------------------
// Running an election
// ---------------------------------------------------------------------------

/**
 * POST /api/elections
 */
exports.createElection = async (req, res) => {
  try {
    const {
      title,
      academicYear,
      description,
      positions,
      nominationOpensAt,
      nominationClosesAt,
      votingOpensAt,
      votingClosesAt,
      eligibleYearGroups,
    } = req.body;

    if (!Array.isArray(positions) || !positions.length) {
      return fail(res, 400, 'An election needs at least one position');
    }

    const dates = {};
    for (const [field, label] of [
      ['nominationOpensAt', 'Nomination opening'],
      ['nominationClosesAt', 'Nomination closing'],
      ['votingOpensAt', 'Voting opening'],
      ['votingClosesAt', 'Voting closing'],
    ]) {
      const parsed = parseDate(
        { nominationOpensAt, nominationClosesAt, votingOpensAt, votingClosesAt }[field],
        label
      );
      if (parsed.error) return fail(res, 400, parsed.error);
      if (!parsed.value) return fail(res, 400, `${label} time is required`);
      dates[field] = parsed.value;
    }

    const election = new Election({
      title,
      academicYear,
      description,
      positions: positions.map((position) => ({
        key: position.key,
        title: position.title,
        seats: position.seats,
        eligibleYearGroups: Array.isArray(position.eligibleYearGroups)
          ? position.eligibleYearGroups
          : [],
        description: position.description,
      })),
      ...dates,
      eligibleYearGroups: Array.isArray(eligibleYearGroups) ? eligibleYearGroups : [],
      status: 'draft',
    });

    election.recordHistory({
      action: 'created',
      to: 'draft',
      by: req.user._id,
      note: `${election.positions.length} position(s)`,
    });

    await election.save();

    return res.status(201).json({
      success: true,
      message: 'Election created as a draft',
      data: election.toRowFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not create the election');
  }
};

/**
 * PATCH /api/elections/:id
 */
exports.updateElection = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid election id');

    const election = await Election.findById(id);
    if (!election) return fail(res, 404, 'Election not found');

    // Once a single ballot exists, the rules of the election are the rules the
    // people who already voted were voting under.
    if (['voting-open', 'voting-closed', 'results-published'].includes(election.status)) {
      return fail(res, 409, 'Voting has begun. The terms of an election cannot change underneath it.');
    }

    const changed = [];
    for (const field of ['title', 'description', 'academicYear']) {
      if (req.body[field] === undefined) continue;
      election[field] = req.body[field];
      changed.push(field);
    }

    for (const field of [
      'nominationOpensAt',
      'nominationClosesAt',
      'votingOpensAt',
      'votingClosesAt',
    ]) {
      if (req.body[field] === undefined) continue;
      const parsed = parseDate(req.body[field], field);
      if (parsed.error) return fail(res, 400, parsed.error);
      election[field] = parsed.value;
      changed.push(field);
    }

    if (Array.isArray(req.body.eligibleYearGroups)) {
      election.eligibleYearGroups = req.body.eligibleYearGroups;
      changed.push('eligibleYearGroups');
    }

    if (Array.isArray(req.body.positions)) {
      if (election.candidates.length) {
        return fail(
          res,
          409,
          'Nominations have been received. Changing the positions now would orphan them.'
        );
      }
      election.positions = req.body.positions;
      changed.push('positions');
    }

    if (!changed.length) return fail(res, 400, 'Nothing to update');

    election.recordHistory({
      action: 'updated',
      by: req.user._id,
      note: `Changed ${changed.join(', ')}`,
    });

    await election.save();
    return ok(res, election.toRowFor(req.user), { message: 'Election updated' });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not update the election');
  }
};

/**
 * PATCH /api/elections/:id/status
 *
 * Only the transitions in `LEGAL_TRANSITIONS`. There is deliberately no path
 * out of `results-published`.
 */
exports.setStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, note } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid election id');
    if (!Election.STATUSES.includes(status)) return fail(res, 400, 'Invalid status');

    const election = await Election.findById(id);
    if (!election) return fail(res, 404, 'Election not found');

    if (!election.canTransitionTo(status)) {
      const allowed = Election.LEGAL_TRANSITIONS[election.status] || [];
      return fail(
        res,
        409,
        allowed.length
          ? `An election at "${election.status}" can only move to: ${allowed.join(', ')}`
          : `An election at "${election.status}" is final`
      );
    }

    // Publication has its own handler because it counts ballots.
    if (status === 'results-published') {
      return fail(res, 400, 'Use the publish endpoint — results are computed, not declared');
    }

    const previous = election.status;

    if (status === 'voting-open') {
      if (!election.candidates.some((candidate) => candidate.status === 'approved')) {
        return fail(res, 409, 'No candidate has been approved, so the ballot paper would be empty');
      }
      // Snapshot the denominator now, so turnout is measured against the roll
      // as it stood when voting opened.
      const eligible = await User.countDocuments({ role: 'student' });
      election.eligibleVoterCount = eligible;
    }

    election.status = status;

    election.recordHistory({
      action: 'status-changed',
      from: previous,
      to: status,
      by: req.user._id,
      note,
    });

    await election.save();
    return ok(res, election.toRowFor(req.user), { message: `Election moved to ${status}` });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not change the election status');
  }
};

// ---------------------------------------------------------------------------
// Nominations
// ---------------------------------------------------------------------------

/**
 * POST /api/elections/:id/nominate
 *
 * Self-nomination only. A student nominating somebody else is how a joke
 * candidacy ends up on a ballot paper with a real person's name on it.
 */
exports.nominate = async (req, res) => {
  try {
    const { id } = req.params;
    const { positionKey, manifesto, seconderId } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid election id');

    const election = await Election.findById(id);
    if (!election) return fail(res, 404, 'Election not found');

    if (!election.nominationsOpen()) {
      return fail(
        res,
        403,
        election.status === 'nominations-open'
          ? `Nominations close at ${election.nominationClosesAt.toISOString().slice(0, 16).replace('T', ' ')}`
          : 'Nominations are not open'
      );
    }

    const position = election.positionFor(String(positionKey || '').toLowerCase());
    if (!position) return fail(res, 400, 'That position is not part of this election');

    const yearGroup = yearGroupOf(req.user);
    if (!election.isEligibleFor(position.key, yearGroup)) {
      const list =
        position.eligibleYearGroups && position.eligibleYearGroups.length
          ? position.eligibleYearGroups
          : election.eligibleYearGroups;
      return fail(res, 403, `${position.title} is open to ${list.join(', ')} only`);
    }

    if (election.candidacyFor(req.user._id, position.key)) {
      return fail(res, 409, `You have already stood for ${position.title}`);
    }

    if (!isValidId(seconderId)) return fail(res, 400, 'A seconder is required');
    if (String(seconderId) === String(req.user._id)) {
      return fail(res, 400, 'You cannot second your own nomination');
    }

    const seconder = await User.findById(seconderId).select('name role');
    if (!seconder) return fail(res, 404, 'That seconder does not have an account');
    if (seconder.role !== 'student') {
      return fail(res, 400, 'A nomination is seconded by another student');
    }

    election.candidates.push({
      student: req.user._id,
      studentName: req.user.name,
      yearGroup,
      positionKey: position.key,
      manifesto,
      seconder: seconder._id,
      seconderName: seconder.name,
      status: 'pending',
      nominatedAt: new Date(),
    });

    election.recordHistory({
      action: 'nominated',
      to: position.key,
      by: req.user._id,
      note: `Seconded by ${seconder.name}`,
    });

    await election.save();

    return res.status(201).json({
      success: true,
      message: `You are standing for ${position.title}, subject to staff approval`,
      data: election.toRowFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not record the nomination');
  }
};

/**
 * PATCH /api/elections/:id/nominations/:cid
 */
exports.reviewNomination = async (req, res) => {
  try {
    const { id, cid } = req.params;
    const { decision, reason } = req.body;

    if (!isValidId(id) || !isValidId(cid)) return fail(res, 400, 'Invalid id');
    if (!['approved', 'rejected'].includes(decision)) {
      return fail(res, 400, 'A nomination is either approved or rejected');
    }
    if (decision === 'rejected' && (!reason || String(reason).trim().length < 5)) {
      return fail(res, 400, 'A rejected student is entitled to know why');
    }

    const election = await Election.findById(id);
    if (!election) return fail(res, 404, 'Election not found');

    if (['voting-open', 'voting-closed', 'results-published'].includes(election.status)) {
      return fail(res, 409, 'The ballot paper is final once voting has opened');
    }

    const candidate = election.candidates.id(cid);
    if (!candidate) return fail(res, 404, 'Nomination not found');
    if (candidate.status === 'withdrawn') {
      return fail(res, 409, 'That nomination was withdrawn');
    }

    const previous = candidate.status;
    candidate.status = decision;
    candidate.rejectionReason = decision === 'rejected' ? reason : undefined;
    candidate.reviewedBy = req.user._id;
    candidate.reviewedAt = new Date();

    election.recordHistory({
      action: 'nomination-reviewed',
      from: previous,
      to: decision,
      by: req.user._id,
      note: `${candidate.studentName} for ${candidate.positionKey}`,
    });

    await election.save();
    return ok(res, election.toRowFor(req.user), { message: `Nomination ${decision}` });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not review the nomination');
  }
};

/**
 * PATCH /api/elections/:id/nominations/withdraw
 */
exports.withdrawNomination = async (req, res) => {
  try {
    const { id } = req.params;
    const { positionKey } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid election id');

    const election = await Election.findById(id);
    if (!election) return fail(res, 404, 'Election not found');

    if (['voting-open', 'voting-closed', 'results-published'].includes(election.status)) {
      return fail(res, 409, 'Voting has opened. A name on the ballot paper stays on it.');
    }

    const candidate = election.candidacyFor(req.user._id, String(positionKey || '').toLowerCase());
    if (!candidate) return fail(res, 404, 'You are not standing for that position');

    candidate.status = 'withdrawn';

    election.recordHistory({
      action: 'nomination-withdrawn',
      to: candidate.positionKey,
      by: req.user._id,
    });

    await election.save();
    return ok(res, election.toRowFor(req.user), { message: 'Nomination withdrawn' });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not withdraw the nomination');
  }
};

/**
 * GET /api/elections/:id/nominations
 */
exports.listNominations = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid election id');

    const election = await Election.findById(id);
    if (!election) return fail(res, 404, 'Election not found');

    const rows = (election.candidates || []).map((candidate) => ({
      _id: candidate._id,
      student: candidate.student,
      studentName: candidate.studentName,
      yearGroup: candidate.yearGroup,
      positionKey: candidate.positionKey,
      positionTitle: (election.positionFor(candidate.positionKey) || {}).title,
      manifesto: candidate.manifesto,
      seconderName: candidate.seconderName,
      status: candidate.status,
      rejectionReason: candidate.rejectionReason,
      nominatedAt: candidate.nominatedAt,
      reviewedAt: candidate.reviewedAt,
    }));

    return ok(res, rows, {
      count: rows.length,
      pending: rows.filter((row) => row.status === 'pending').length,
    });
  } catch (error) {
    return serverError(res, error, 'Could not load nominations');
  }
};

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------

/**
 * POST /api/elections/:id/vote
 *
 * The roll entry goes in first. See the module comment for why the order is
 * the guarantee rather than an implementation detail.
 */
exports.castVote = async (req, res) => {
  try {
    const { id } = req.params;
    const { choices } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid election id');

    const election = await Election.findById(id);
    if (!election) return fail(res, 404, 'Election not found');

    const blocked = election.votingBlockedReason(req.user);
    if (blocked) return fail(res, 403, blocked);

    if (!Array.isArray(choices) || !choices.length) {
      return fail(res, 400, 'Make a choice on at least one position');
    }

    const yearGroup = yearGroupOf(req.user);
    const seen = new Set();
    const pending = [];

    for (const choice of choices) {
      const key = String(choice.positionKey || '').toLowerCase();
      const position = election.positionFor(key);
      if (!position) return fail(res, 400, `Unknown position: ${key}`);
      if (seen.has(key)) return fail(res, 400, `You voted twice on ${position.title}`);
      seen.add(key);

      if (!election.isEligibleFor(key, yearGroup)) {
        return fail(res, 403, `You are not eligible to vote on ${position.title}`);
      }

      // An abstention is a recorded choice, not a missing row.
      if (!choice.candidateId || choice.candidateId === 'abstain') {
        pending.push({ positionKey: key, candidate: undefined, candidateName: undefined });
        continue;
      }

      if (!isValidId(choice.candidateId)) return fail(res, 400, 'Invalid candidate id');

      const candidate = election.candidates.id(choice.candidateId);
      if (!candidate || candidate.positionKey !== key || candidate.status !== 'approved') {
        return fail(res, 400, `That candidate is not on the ballot for ${position.title}`);
      }

      pending.push({
        positionKey: key,
        candidate: candidate._id,
        candidateName: candidate.studentName,
      });
    }

    const at = toHourBucket(new Date());

    // 1. The roll entry. The unique index is the single-vote guarantee, and a
    //    duplicate-key error here means this student has already voted.
    try {
      await VoterRoll.create({ election: election._id, voter: req.user._id, votedAt: at });
    } catch (error) {
      if (error.code === 11000) {
        return fail(res, 409, 'You have already voted in this election. A vote cannot be changed.');
      }
      throw error;
    }

    // 2. The ballots, only now that the roll has accepted this voter.
    await Ballot.insertMany(
      pending.map((entry) => ({
        election: election._id,
        positionKey: entry.positionKey,
        candidate: entry.candidate,
        candidateName: entry.candidateName,
        castAt: at,
      }))
    );

    return res.status(201).json({
      success: true,
      message: 'Your vote has been recorded. It cannot be traced back to you, and it cannot be changed.',
      data: {
        positionsVoted: pending.length,
        abstentions: pending.filter((entry) => !entry.candidate).length,
      },
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not record your vote');
  }
};

/**
 * GET /api/elections/:id/my-status
 *
 * Whether *you* have voted. There is no endpoint that answers this about
 * anybody else, and there is no data that could answer what you chose.
 */
exports.getMyStatus = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid election id');

    const election = await Election.findById(id);
    if (!election) return fail(res, 404, 'Election not found');

    const entry = await VoterRoll.findOne({ election: election._id, voter: req.user._id });

    const yearGroup = yearGroupOf(req.user);
    const eligiblePositions = (election.positions || [])
      .filter((position) => election.isEligibleFor(position.key, yearGroup))
      .map((position) => position.key);

    const standing = (election.candidates || [])
      .filter((candidate) => String(candidate.student) === String(req.user._id))
      .map((candidate) => ({
        positionKey: candidate.positionKey,
        status: candidate.status,
        rejectionReason: candidate.rejectionReason,
      }));

    return ok(res, {
      hasVoted: Boolean(entry),
      votedAt: entry ? entry.votedAt : null,
      canVote: election.votingBlockedReason(req.user) === null && !entry,
      blockedReason: election.votingBlockedReason(req.user),
      eligiblePositions,
      standing,
    });
  } catch (error) {
    return serverError(res, error, 'Could not read your voting status');
  }
};

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * PATCH /api/elections/:id/publish
 *
 * Counts the ballots once and freezes the answer, with the time and the person
 * who ran it. Refused while voting is open — a count taken mid-poll is a count
 * that can be shown to a candidate who is behind.
 */
exports.publishResults = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid election id');

    const election = await Election.findById(id);
    if (!election) return fail(res, 404, 'Election not found');

    if (election.status === 'results-published') {
      return fail(res, 409, 'These results have already been published');
    }
    if (election.status !== 'voting-closed') {
      return fail(
        res,
        409,
        election.status === 'voting-open'
          ? 'Close the poll before counting. A count taken mid-poll is one somebody can be shown.'
          : 'This election has not reached a countable state'
      );
    }

    const tallies = await tallyElection(election);
    const votersRecorded = await VoterRoll.countDocuments({ election: election._id });
    const ballotsCast = await Ballot.countDocuments({ election: election._id });

    const eligible = election.eligibleVoterCount || 0;
    const turnout = eligible ? Math.round((votersRecorded / eligible) * 1000) / 10 : null;

    election.results = {
      tallies,
      turnout,
      ballotsCast,
      votersRecorded,
      computedAt: new Date(),
      computedBy: req.user._id,
    };
    election.status = 'results-published';

    election.recordHistory({
      action: 'published',
      from: 'voting-closed',
      to: 'results-published',
      by: req.user._id,
      note: `${votersRecorded} voter(s), ${ballotsCast} ballot(s)`,
    });

    await election.save();

    return ok(res, election.toResults(), {
      message: `Results published. Turnout ${turnout === null ? 'unknown' : `${turnout}%`}.`,
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not publish the results');
  }
};

/**
 * GET /api/elections/:id/results
 */
exports.getResults = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid election id');

    const election = await Election.findById(id);
    if (!election) return fail(res, 404, 'Election not found');

    const results = election.toResults();
    if (!results) {
      return fail(res, 409, 'Results have not been published for this election');
    }

    return ok(res, { election: election.toRowFor(req.user), results });
  } catch (error) {
    return serverError(res, error, 'Could not load the results');
  }
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * GET /api/elections
 */
exports.listElections = async (req, res) => {
  try {
    const query = {};
    // A draft election is a plan. Only staff see one.
    if (!isStaff(req.user)) query.status = { $nin: ['draft', 'cancelled'] };
    if (req.query.academicYear) query.academicYear = String(req.query.academicYear).slice(0, 10);

    const elections = await Election.find(query).sort({ votingOpensAt: -1 }).limit(100);
    const now = new Date();

    return ok(
      res,
      elections.map((election) => election.toRowFor(req.user, now))
    );
  } catch (error) {
    return serverError(res, error, 'Could not load elections');
  }
};

/**
 * GET /api/elections/:id
 */
exports.getElection = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid election id');

    const election = await Election.findById(id);
    if (!election) return fail(res, 404, 'Election not found');

    if (election.status === 'draft' && !isStaff(req.user)) {
      return fail(res, 404, 'Election not found');
    }

    const entry = await VoterRoll.findOne({ election: election._id, voter: req.user._id });

    return ok(res, {
      ...election.toRowFor(req.user),
      hasVoted: Boolean(entry),
      blockedReason: election.votingBlockedReason(req.user),
      results: election.toResults(),
    });
  } catch (error) {
    return serverError(res, error, 'Could not load the election');
  }
};

/**
 * GET /api/elections/stats
 *
 * Deliberately thin. Everything here is a count of an election, never of a
 * voter — there is no query in this module that produces a person and a choice
 * together, and adding one would need a schema change somebody would have to
 * defend.
 */
exports.getStats = async (req, res) => {
  try {
    const elections = await Election.find({}).limit(200);

    const byStatus = {};
    let candidacies = 0;
    let approved = 0;

    for (const election of elections) {
      byStatus[election.status] = (byStatus[election.status] || 0) + 1;
      candidacies += (election.candidates || []).length;
      approved += (election.candidates || []).filter((c) => c.status === 'approved').length;
    }

    const published = elections.filter((election) => election.status === 'results-published');
    const turnouts = published
      .map((election) => election.results.turnout)
      .filter((value) => Number.isFinite(value));

    return ok(res, {
      total: elections.length,
      byStatus,
      candidacies,
      approved,
      meanTurnout: turnouts.length
        ? Math.round((turnouts.reduce((a, b) => a + b, 0) / turnouts.length) * 10) / 10
        : null,
    });
  } catch (error) {
    return serverError(res, error, 'Could not compute election statistics');
  }
};

/**
 * GET /api/elections/seconders
 *
 * Students a nomination may be seconded by. Excludes the requester, since
 * seconding your own nomination is not a second opinion.
 */
exports.getSeconders = async (req, res) => {
  try {
    const students = await User.find({ role: 'student' })
      .select('name email')
      .sort({ name: 1 })
      .limit(500);

    return ok(res, students.filter((person) => String(person._id) !== String(req.user._id)));
  } catch (error) {
    return serverError(res, error, 'Could not load the student list');
  }
};

exports.isAdmin = isAdmin;
