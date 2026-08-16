const mongoose = require('mongoose');
const {
  Committee,
  CommitteeMeeting,
  COMMITTEE_TYPES,
  MEMBER_ROLES,
  VOTING_ROLES,
  QUORUM_KINDS,
  MEETING_MODES,
  MEETING_STATUSES,
  ATTENDANCE_STATES,
  AGENDA_KINDS,
  MOTION_OUTCOMES,
  ACTION_STATUSES,
  LIVE_ACTION_STATUSES,
  todayKey,
} = require('../models/CommitteeMeeting');

/**
 * Committee governance.
 *
 * `recordMotion` is the handler this module exists for. It computes quorum at
 * the instant of the vote, refuses a vote that does not reconcile against the
 * people entitled to cast it, derives the outcome, and stores a motion taken
 * without quorum as void rather than deleting it.
 *
 * `approveMinutes` stores the fingerprint. `getMeeting` recomputes it on every
 * read, so minutes edited after approval say so on their own face.
 */

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

function serverError(res, error, message) {
  console.error(`${message}:`, error);
  return res.status(500).json({
    success: false,
    message,
    error: error.message,
  });
}

/**
 * Mongoose validation errors carry every failed path. Surfacing only the first
 * is how you get somebody fixing a form one field per submission.
 */
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

/** The academic year a date falls in, on a July start. */
function academicYearFor(dateKey = todayKey()) {
  const [year, month] = dateKey.split('-').map(Number);
  const startYear = month >= 7 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/**
 * Load a meeting and its committee, and check the caller may see them.
 *
 * A confidential committee's meetings are refused outright to non-members
 * rather than filtered in the UI. A disciplinary panel whose meetings are
 * enumerable is a disciplinary panel with no confidentiality.
 */
async function loadMeetingFor(id, user) {
  if (!isValidId(id)) return { status: 400, message: 'Invalid meeting id' };

  const meeting = await CommitteeMeeting.findById(id);
  if (!meeting) return { status: 404, message: 'Meeting not found' };

  const committee = await Committee.findById(meeting.committee);
  if (!committee) return { status: 409, message: 'That committee no longer exists' };

  const member = committee.isMember(user._id, meeting.scheduledFor);
  if (!member && !isAdmin(user)) {
    return { status: 403, message: 'You are not on this committee' };
  }

  return { meeting, committee, member };
}

/** Whether this person may minute or chair this meeting. */
function canMinute(committee, meeting, user) {
  const role = committee.roleOf(user._id, meeting.scheduledFor);
  return ['secretary', 'chair'].includes(role) || isAdmin(user);
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/**
 * GET /api/governance/meta
 */
exports.getMeta = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        committeeTypes: COMMITTEE_TYPES,
        memberRoles: MEMBER_ROLES,
        votingRoles: VOTING_ROLES,
        quorumKinds: QUORUM_KINDS,
        meetingModes: MEETING_MODES,
        meetingStatuses: MEETING_STATUSES,
        attendanceStates: ATTENDANCE_STATES,
        agendaKinds: AGENDA_KINDS,
        motionOutcomes: MOTION_OUTCOMES,
        actionStatuses: ACTION_STATUSES,
        liveActionStatuses: LIVE_ACTION_STATUSES,
        today: todayKey(),
        academicYear: academicYearFor(),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load governance reference data');
  }
};

// ---------------------------------------------------------------------------
// Committees
// ---------------------------------------------------------------------------

/**
 * POST /api/governance/committees
 */
exports.createCommittee = async (req, res) => {
  try {
    const committee = new Committee({
      name: req.body.name,
      type: req.body.type,
      purpose: req.body.purpose,
      termStart: req.body.termStart,
      termEnd: req.body.termEnd,
      serialPrefix: req.body.serialPrefix,
      quorumRule: req.body.quorumRule,
      members: Array.isArray(req.body.members)
        ? req.body.members.map((member) => ({
            user: member.user,
            name: member.name,
            role: member.role,
            votingRights: member.votingRights,
            joinedOn: member.joinedOn || todayKey(),
          }))
        : [],
    });

    await committee.save();

    return res.status(201).json({ success: true, data: committee });
  } catch (error) {
    if (error && error.code === 11000) {
      return fail(res, 409, 'A committee with that name already exists');
    }
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to create that committee');
  }
};

/**
 * GET /api/governance/committees
 *
 * Members see their own committees. An admin sees all of them. Nobody else sees
 * a confidential one at all.
 */
exports.listCommittees = async (req, res) => {
  try {
    const filter = isAdmin(req.user) ? {} : { 'members.user': req.user._id };
    const committees = await Committee.find(filter).sort({ name: 1 });

    const today = todayKey();

    return res.status(200).json({
      success: true,
      count: committees.length,
      data: committees.map((committee) => ({
        _id: committee._id,
        name: committee.name,
        slug: committee.slug,
        type: committee.type,
        purpose: committee.purpose,
        isActive: committee.isActive,
        isConfidential: committee.isConfidential(),
        memberCount: committee.membershipOn(today).length,
        quorum: committee.quorumOn(today),
        myRole: committee.roleOf(req.user._id, today),
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load committees');
  }
};

/**
 * GET /api/governance/committees/:id
 */
exports.getCommittee = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid committee id');

    const committee = await Committee.findById(id).populate('members.user', 'name email');
    if (!committee) return fail(res, 404, 'Committee not found');

    if (!committee.isMember(req.user._id) && !isAdmin(req.user)) {
      return fail(res, 403, 'You are not on this committee');
    }

    const today = todayKey();

    return res.status(200).json({
      success: true,
      data: {
        ...committee.toObject(),
        isConfidential: committee.isConfidential(),
        quorum: committee.quorumOn(today),
        myRole: committee.roleOf(req.user._id, today),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load that committee');
  }
};

/**
 * PATCH /api/governance/committees/:id
 */
exports.updateCommittee = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid committee id');

    const committee = await Committee.findById(id);
    if (!committee) return fail(res, 404, 'Committee not found');

    for (const field of ['name', 'purpose', 'termStart', 'termEnd', 'isActive']) {
      if (req.body[field] !== undefined) committee[field] = req.body[field];
    }
    if (req.body.quorumRule) committee.quorumRule = req.body.quorumRule;

    await committee.save();

    return res.status(200).json({ success: true, data: committee });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update that committee');
  }
};

/**
 * POST /api/governance/committees/:id/members
 */
exports.addMember = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid committee id');
    if (!isValidId(req.body.user)) return fail(res, 400, 'Invalid user id');

    const committee = await Committee.findById(id);
    if (!committee) return fail(res, 404, 'Committee not found');

    committee.members.push({
      user: req.body.user,
      name: req.body.name,
      role: req.body.role,
      votingRights: req.body.votingRights,
      joinedOn: req.body.joinedOn || todayKey(),
    });

    await committee.save();

    return res.status(201).json({
      success: true,
      message: 'Added to the committee',
      data: committee,
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to add that member');
  }
};

/**
 * PATCH /api/governance/committees/:id/members/:memberId
 *
 * Setting `leftOn` rather than deleting the row. A member who left in June was
 * present in May, and a May quorum recomputed against a June membership is a
 * May decision quietly becoming void.
 */
exports.updateMember = async (req, res) => {
  try {
    const { id, memberId } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid committee id');

    const committee = await Committee.findById(id);
    if (!committee) return fail(res, 404, 'Committee not found');

    const member = committee.members.id(memberId);
    if (!member) return fail(res, 404, 'That person is not on this committee');

    if (req.body.role) member.role = req.body.role;
    if (req.body.votingRights !== undefined) member.votingRights = req.body.votingRights;
    if (req.body.leftOn !== undefined) member.leftOn = req.body.leftOn;

    await committee.save();

    return res.status(200).json({ success: true, data: committee });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update that membership');
  }
};

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

/**
 * POST /api/governance/committees/:id/meetings
 *
 * The serial is issued with `$inc` in a single `findOneAndUpdate`, which is
 * atomic under concurrency in a way that `count + 1` is not — two secretaries
 * opening a meeting at the same moment get 004 and 005, not 004 twice.
 */
exports.createMeeting = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid committee id');

    const committee = await Committee.findById(id);
    if (!committee) return fail(res, 404, 'Committee not found');

    const role = committee.roleOf(req.user._id);
    if (!['chair', 'secretary'].includes(role) && !isAdmin(req.user)) {
      return fail(res, 403, 'Only the chair or the secretary can call a meeting');
    }

    const scheduledFor = req.body.scheduledFor || todayKey();

    const counted = await Committee.findOneAndUpdate(
      { _id: id },
      { $inc: { meetingSequence: 1 } },
      { new: true }
    );
    const serial = `${counted.serialPrefix}/${academicYearFor(scheduledFor)}/${String(
      counted.meetingSequence
    ).padStart(3, '0')}`;

    // Everybody on the committee that day starts as an apology, so the
    // attendance list is complete before anybody types into it and nobody is
    // silently missing from the denominator.
    const attendance = committee.membershipOn(scheduledFor).map((member) => ({
      member: member.user,
      name: member.name,
      state: 'absent',
      isVoting: committee.memberVotes(member),
    }));

    const meeting = new CommitteeMeeting({
      committee: committee._id,
      committeeName: committee.name,
      serial,
      scheduledFor,
      startTime: req.body.startTime,
      endTime: req.body.endTime,
      venue: req.body.venue,
      mode: req.body.mode,
      attendance,
      agenda: Array.isArray(req.body.agenda)
        ? req.body.agenda.map((item, index) => ({
            index: index + 1,
            title: item.title,
            presenter: item.presenter,
            kind: item.kind,
            papers: item.papers,
          }))
        : [],
      status: 'scheduled',
    });

    meeting.recordHistory('called', req.user._id);
    await meeting.save();

    return res.status(201).json({
      success: true,
      message: `Meeting ${serial} called`,
      data: meeting.toRow(committee),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to call that meeting');
  }
};

/**
 * GET /api/governance/meetings/mine
 */
exports.getMyMeetings = async (req, res) => {
  try {
    const committees = await Committee.find({ 'members.user': req.user._id });
    const ids = committees.map((committee) => committee._id);
    const byId = new Map(committees.map((committee) => [String(committee._id), committee]));

    const meetings = await CommitteeMeeting.find({ committee: { $in: ids } })
      .sort({ scheduledFor: -1 })
      .limit(100);

    return res.status(200).json({
      success: true,
      count: meetings.length,
      data: meetings.map((meeting) =>
        meeting.toRow(byId.get(String(meeting.committee)))
      ),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load your meetings');
  }
};

/**
 * GET /api/governance/meetings
 */
exports.listMeetings = async (req, res) => {
  try {
    const filter = {};
    if (req.query.committee && isValidId(req.query.committee)) {
      filter.committee = req.query.committee;
    }
    if (req.query.status) filter.status = req.query.status;

    const meetings = await CommitteeMeeting.find(filter)
      .sort({ scheduledFor: -1 })
      .limit(Math.min(Number(req.query.limit) || 100, 300));

    return res.status(200).json({
      success: true,
      count: meetings.length,
      data: meetings.map((meeting) => meeting.toRow()),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load meetings');
  }
};

/**
 * GET /api/governance/meetings/:id
 */
exports.getMeeting = async (req, res) => {
  try {
    const result = await loadMeetingFor(req.params.id, req.user);
    if (result.status) return fail(res, result.status, result.message);

    const { meeting, committee } = result;

    return res.status(200).json({
      success: true,
      data: {
        ...meeting.toRow(committee),
        myRole: committee.roleOf(req.user._id, meeting.scheduledFor),
        canMinute: canMinute(committee, meeting, req.user),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load that meeting');
  }
};

/**
 * PATCH /api/governance/meetings/:id/agenda
 */
exports.updateAgenda = async (req, res) => {
  try {
    const result = await loadMeetingFor(req.params.id, req.user);
    if (result.status) return fail(res, result.status, result.message);

    const { meeting, committee } = result;
    if (!canMinute(committee, meeting, req.user)) {
      return fail(res, 403, 'Only the chair or the secretary can set the agenda');
    }
    if (['approved', 'cancelled'].includes(meeting.status)) {
      return fail(res, 409, `A ${meeting.status} meeting cannot be edited`);
    }

    meeting.agenda = (req.body.agenda || []).map((item, index) => ({
      index: index + 1,
      title: item.title,
      presenter: item.presenter,
      kind: item.kind,
      papers: item.papers,
      discussion: item.discussion,
    }));

    meeting.recordHistory('agenda-set', req.user._id);
    await meeting.save();

    return res.status(200).json({
      success: true,
      message: 'Agenda saved',
      data: meeting.toRow(committee),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to save that agenda');
  }
};

/**
 * PATCH /api/governance/meetings/:id/attendance
 */
exports.updateAttendance = async (req, res) => {
  try {
    const result = await loadMeetingFor(req.params.id, req.user);
    if (result.status) return fail(res, result.status, result.message);

    const { meeting, committee } = result;
    if (!canMinute(committee, meeting, req.user)) {
      return fail(res, 403, 'Only the chair or the secretary can record attendance');
    }
    if (['approved', 'cancelled'].includes(meeting.status)) {
      return fail(res, 409, `A ${meeting.status} meeting cannot be edited`);
    }

    for (const update of req.body.attendance || []) {
      const entry = meeting.attendance.find(
        (row) => String(row.member) === String(update.member)
      );
      if (!entry) continue;
      if (update.state) entry.state = update.state;
      if (update.arrivedAt !== undefined) entry.arrivedAt = update.arrivedAt;
      if (update.leftAt !== undefined) entry.leftAt = update.leftAt;
    }

    if (meeting.status === 'scheduled') meeting.status = 'in-session';
    meeting.recordHistory('attendance-recorded', req.user._id);
    await meeting.save();

    return res.status(200).json({
      success: true,
      message: 'Attendance recorded',
      data: {
        ...meeting.toRow(committee),
        quorum: meeting.quorumStatus(committee),
      },
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record attendance');
  }
};

/**
 * POST /api/governance/meetings/:id/motions
 *
 * The handler this module exists for.
 *
 * Quorum is computed here, from the attendance list minus everybody who had
 * left by this point, minus non-voting attendees, minus every recusal on this
 * motion. The vote is checked against that number, the outcome is derived from
 * it, and a motion taken without quorum is stored with its figures intact and
 * marked void.
 */
exports.recordMotion = async (req, res) => {
  try {
    const result = await loadMeetingFor(req.params.id, req.user);
    if (result.status) return fail(res, result.status, result.message);

    const { meeting, committee } = result;
    if (!canMinute(committee, meeting, req.user)) {
      return fail(res, 403, 'Only the chair or the secretary can record a motion');
    }
    if (['approved', 'cancelled'].includes(meeting.status)) {
      return fail(res, 409, `A ${meeting.status} meeting cannot take new motions`);
    }

    const votesFor = Number(req.body.votesFor) || 0;
    const votesAgainst = Number(req.body.votesAgainst) || 0;
    const abstentions = Number(req.body.abstentions) || 0;

    const recusals = Array.isArray(req.body.recusals)
      ? req.body.recusals
          .filter((entry) => isValidId(entry.member))
          .map((entry) => ({ member: entry.member, reason: entry.reason }))
      : [];

    const atTime = req.body.atTime || null;
    const eligible = meeting.eligibleAt(
      recusals.map((entry) => entry.member),
      atTime
    );

    const reconciliation = meeting.voteReconciliationError(
      { votesFor, votesAgainst, abstentions },
      eligible.length
    );
    if (reconciliation) return fail(res, 409, reconciliation);

    const rule = committee.quorumOn(meeting.scheduledFor);
    const outcome = meeting.deriveOutcome(
      { votesFor, votesAgainst },
      { present: eligible.length, required: rule.required }
    );

    meeting.motions.push({
      agendaIndex: req.body.agendaIndex ?? null,
      text: req.body.text,
      movedBy: req.body.movedBy,
      secondedBy: req.body.secondedBy,
      votesFor,
      votesAgainst,
      abstentions,
      recusals,
      quorumAtVote: rule.required,
      membersPresentAtVote: meeting.presentAt(atTime).length,
      eligibleAtVote: eligible.length,
      outcome,
      decidedAt: new Date(),
      recordedBy: req.user._id,
    });

    meeting.recordHistory('motion-recorded', req.user._id, outcome);
    await meeting.save();

    const motion = meeting.motions[meeting.motions.length - 1];

    return res.status(201).json({
      success: true,
      message:
        outcome === 'void-no-quorum'
          ? `Recorded as void — ${eligible.length} entitled to vote against a quorum of ${rule.required}`
          : `Motion ${outcome} (${votesFor}–${votesAgainst}, ${abstentions} abstaining)`,
      data: { motion, quorum: meeting.quorumStatus(committee, atTime) },
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record that motion');
  }
};

/**
 * PATCH /api/governance/meetings/:id/motions/:motionId/recuse
 *
 * Recusing recomputes the whole motion — denominator, reconciliation and
 * outcome — because a declared interest that leaves the arithmetic alone is a
 * footnote, and a footnote is what this replaces.
 */
exports.recuseFromMotion = async (req, res) => {
  try {
    const result = await loadMeetingFor(req.params.id, req.user);
    if (result.status) return fail(res, result.status, result.message);

    const { meeting, committee } = result;
    if (['approved', 'cancelled'].includes(meeting.status)) {
      return fail(res, 409, `A ${meeting.status} meeting cannot be changed`);
    }
    if (!req.body.reason || !String(req.body.reason).trim()) {
      return fail(res, 400, 'A recusal has to say what the interest is');
    }

    const motion = meeting.motions.id(req.params.motionId);
    if (!motion) return fail(res, 404, 'Motion not found');

    const memberId = req.body.member || req.user._id;
    if (String(memberId) !== String(req.user._id) && !canMinute(committee, meeting, req.user)) {
      return fail(res, 403, 'You can only recuse yourself');
    }
    if (motion.recusals.some((entry) => String(entry.member) === String(memberId))) {
      return fail(res, 409, 'That member has already recused themselves');
    }

    motion.recusals.push({ member: memberId, reason: req.body.reason });

    const eligible = meeting.eligibleAt(
      motion.recusals.map((entry) => entry.member),
      null
    );
    const rule = committee.quorumOn(meeting.scheduledFor);

    const reconciliation = meeting.voteReconciliationError(motion, eligible.length);
    if (reconciliation) {
      return fail(
        res,
        409,
        `${reconciliation}. Re-take the vote before recording the recusal.`
      );
    }

    motion.eligibleAtVote = eligible.length;
    motion.quorumAtVote = rule.required;
    motion.outcome = meeting.deriveOutcome(motion, {
      present: eligible.length,
      required: rule.required,
    });

    meeting.recordHistory('recusal', req.user._id, req.body.reason);
    await meeting.save();

    return res.status(200).json({
      success: true,
      message:
        motion.outcome === 'void-no-quorum'
          ? 'Recorded. With that recusal the motion no longer has quorum and is void.'
          : `Recorded. The motion is ${motion.outcome} with ${eligible.length} entitled to vote.`,
      data: motion,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to record that recusal');
  }
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * POST /api/governance/meetings/:id/actions
 */
exports.addAction = async (req, res) => {
  try {
    const result = await loadMeetingFor(req.params.id, req.user);
    if (result.status) return fail(res, result.status, result.message);

    const { meeting, committee } = result;
    if (!canMinute(committee, meeting, req.user)) {
      return fail(res, 403, 'Only the chair or the secretary can record an action');
    }
    if (!isValidId(req.body.owner)) return fail(res, 400, 'An action needs an owner');

    const nextIndex = meeting.actions.length + 1;

    meeting.actions.push({
      ref: req.body.ref || `${meeting.serial}/A${nextIndex}`,
      description: req.body.description,
      owner: req.body.owner,
      ownerName: req.body.ownerName,
      dueBy: req.body.dueBy,
      status: 'open',
    });

    meeting.recordHistory('action-added', req.user._id);
    await meeting.save();

    return res.status(201).json({
      success: true,
      message: 'Action recorded',
      data: meeting.toRow(committee),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record that action');
  }
};

/**
 * PATCH /api/governance/meetings/:id/actions/:actionId
 */
exports.updateAction = async (req, res) => {
  try {
    const result = await loadMeetingFor(req.params.id, req.user);
    if (result.status) return fail(res, result.status, result.message);

    const { meeting, committee } = result;
    const action = meeting.actions.id(req.params.actionId);
    if (!action) return fail(res, 404, 'Action not found');

    const owns = String(action.owner) === String(req.user._id);
    if (!owns && !canMinute(committee, meeting, req.user)) {
      return fail(res, 403, 'That action belongs to somebody else');
    }

    if (req.body.status) action.status = req.body.status;
    if (req.body.dueBy !== undefined) action.dueBy = req.body.dueBy;
    if (req.body.closingNote !== undefined) action.closingNote = req.body.closingNote;
    if (action.status === 'done' && !action.closedOn) {
      action.closedOn = todayKey();
    }

    meeting.recordHistory('action-updated', req.user._id, action.status);
    await meeting.save();

    return res.status(200).json({
      success: true,
      message: `Action marked ${action.status}`,
      data: action,
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update that action');
  }
};

/**
 * GET /api/governance/actions/mine
 */
exports.getMyActions = async (req, res) => {
  try {
    const meetings = await CommitteeMeeting.find({
      'actions.owner': req.user._id,
    }).sort({ scheduledFor: -1 });

    const rows = [];
    for (const meeting of meetings) {
      for (const action of meeting.actions) {
        if (String(action.owner) !== String(req.user._id)) continue;
        if (!LIVE_ACTION_STATUSES.includes(action.status)) continue;
        rows.push({
          ...action.toObject(),
          meeting: meeting._id,
          serial: meeting.serial,
          committeeName: meeting.committeeName,
          scheduledFor: meeting.scheduledFor,
          isOverdue: Boolean(action.dueBy && action.dueBy < todayKey()),
        });
      }
    }

    rows.sort((a, b) => Number(b.isOverdue) - Number(a.isOverdue));

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    return serverError(res, error, 'Failed to load your actions');
  }
};

/**
 * GET /api/governance/actions/overdue
 *
 * Every live action past its date, with how many times it has been carried. An
 * action carried four times is the report.
 */
exports.getOverdueActions = async (req, res) => {
  try {
    const today = todayKey();
    const meetings = await CommitteeMeeting.find({
      'actions.status': { $in: LIVE_ACTION_STATUSES },
    }).sort({ scheduledFor: -1 });

    const rows = [];
    for (const meeting of meetings) {
      for (const action of meeting.actions) {
        if (!LIVE_ACTION_STATUSES.includes(action.status)) continue;
        if (!action.dueBy || action.dueBy >= today) continue;
        rows.push({
          ...action.toObject(),
          meeting: meeting._id,
          serial: meeting.serial,
          committeeName: meeting.committeeName,
          daysOverdue: Math.round(
            (Date.parse(`${today}T00:00:00`) - Date.parse(`${action.dueBy}T00:00:00`)) /
              86400000
          ),
        });
      }
    }

    rows.sort((a, b) => b.daysOverdue - a.daysOverdue);

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    return serverError(res, error, 'Failed to load overdue actions');
  }
};

// ---------------------------------------------------------------------------
// Minutes
// ---------------------------------------------------------------------------

/**
 * PATCH /api/governance/meetings/:id/minute
 *
 * Writing the minutes also carries forward every open action into the next
 * meeting of this committee, if one exists. They carry as the same action with
 * the count incremented rather than being retyped — an action carried three
 * times is the report, and retyping it hides exactly that.
 */
exports.minuteMeeting = async (req, res) => {
  try {
    const result = await loadMeetingFor(req.params.id, req.user);
    if (result.status) return fail(res, result.status, result.message);

    const { meeting, committee } = result;
    if (!canMinute(committee, meeting, req.user)) {
      return fail(res, 403, 'Only the secretary or the chair can minute a meeting');
    }
    if (meeting.status === 'approved') {
      return fail(res, 409, 'These minutes are approved and cannot be rewritten');
    }

    meeting.minutesText = req.body.minutesText;
    meeting.status = 'minuted';
    meeting.recordHistory('minuted', req.user._id);
    await meeting.save();

    let carried = 0;
    if (req.body.carryForwardTo && isValidId(req.body.carryForwardTo)) {
      const next = await CommitteeMeeting.findById(req.body.carryForwardTo);
      if (next && String(next.committee) === String(meeting.committee)) {
        for (const action of meeting.actionsToCarryForward()) {
          const already = next.actions.some(
            (existing) => existing.originalRef === action.originalRef
          );
          if (already) continue;
          next.actions.push(action);
          carried += 1;
        }
        if (carried) {
          next.recordHistory(
            'actions-carried',
            req.user._id,
            `${carried} from ${meeting.serial}`
          );
          await next.save();
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: carried
        ? `Minutes saved; ${carried} open action(s) carried forward`
        : 'Minutes saved',
      data: meeting.toRow(committee),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to save those minutes');
  }
};

/**
 * PATCH /api/governance/meetings/:id/circulate
 */
exports.circulateMinutes = async (req, res) => {
  try {
    const result = await loadMeetingFor(req.params.id, req.user);
    if (result.status) return fail(res, result.status, result.message);

    const { meeting, committee } = result;
    if (!canMinute(committee, meeting, req.user)) {
      return fail(res, 403, 'Only the secretary or the chair can circulate minutes');
    }
    if (meeting.status !== 'minuted') {
      return fail(res, 409, 'Write the minutes before circulating them');
    }

    meeting.status = 'circulated';
    meeting.recordHistory('circulated', req.user._id);
    await meeting.save();

    return res.status(200).json({
      success: true,
      message: 'Circulated to the committee',
      data: meeting.toRow(committee),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to circulate those minutes');
  }
};

/**
 * PATCH /api/governance/meetings/:id/approve
 *
 * Minutes are approved at a *later* meeting of the same committee, by the
 * chair. That is how minutes are actually approved, and storing which meeting
 * did it makes the trail complete.
 *
 * The fingerprint is taken here. Anything edited afterwards makes
 * `integrityState()` report `edited-since-approval` on the next read.
 */
exports.approveMinutes = async (req, res) => {
  try {
    const result = await loadMeetingFor(req.params.id, req.user);
    if (result.status) return fail(res, result.status, result.message);

    const { meeting, committee } = result;

    const role = committee.roleOf(req.user._id, meeting.scheduledFor);
    if (role !== 'chair' && !isAdmin(req.user)) {
      return fail(res, 403, 'Only the chair can approve minutes');
    }
    if (meeting.status === 'approved') {
      return fail(res, 409, 'These minutes are already approved');
    }
    if (!['minuted', 'circulated'].includes(meeting.status)) {
      return fail(res, 409, 'There are no minutes here to approve');
    }
    if (!isValidId(req.body.approvalMeeting)) {
      return fail(
        res,
        400,
        'Name the meeting at which these minutes were approved — minutes are approved at the next meeting, not by an email'
      );
    }

    const approvalMeeting = await CommitteeMeeting.findById(req.body.approvalMeeting);
    if (!approvalMeeting) return fail(res, 404, 'That approving meeting does not exist');
    if (String(approvalMeeting.committee) !== String(meeting.committee)) {
      return fail(res, 409, 'That meeting belongs to a different committee');
    }
    if (String(approvalMeeting._id) === String(meeting._id)) {
      return fail(res, 409, 'A meeting cannot approve its own minutes');
    }
    if (approvalMeeting.scheduledFor < meeting.scheduledFor) {
      return fail(res, 409, 'Minutes cannot be approved at an earlier meeting');
    }

    meeting.status = 'approved';
    meeting.approvedAt = new Date();
    meeting.approvedBy = req.user._id;
    meeting.approvalMeeting = approvalMeeting._id;
    meeting.minutesFingerprint = meeting.computeFingerprint();

    meeting.recordHistory(
      'approved',
      req.user._id,
      `Approved at ${approvalMeeting.serial}`
    );
    await meeting.save();

    return res.status(200).json({
      success: true,
      message: `Approved at ${approvalMeeting.serial}. Any later edit will show on the record.`,
      data: meeting.toRow(committee),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to approve those minutes');
  }
};

/**
 * GET /api/governance/stats
 */
exports.getStats = async (req, res) => {
  try {
    const meetings = await CommitteeMeeting.find({});
    const committees = await Committee.countDocuments({ isActive: true });

    const byStatus = {};
    const byOutcome = {};
    let motions = 0;
    let voidMotions = 0;
    let recusals = 0;
    let openActions = 0;
    let carriedActions = 0;
    let editedAfterApproval = 0;

    for (const meeting of meetings) {
      byStatus[meeting.status] = (byStatus[meeting.status] || 0) + 1;

      for (const motion of meeting.motions) {
        motions += 1;
        byOutcome[motion.outcome] = (byOutcome[motion.outcome] || 0) + 1;
        if (motion.outcome === 'void-no-quorum') voidMotions += 1;
        recusals += motion.recusals.length;
      }

      for (const action of meeting.actions) {
        if (LIVE_ACTION_STATUSES.includes(action.status)) openActions += 1;
        if ((action.carryCount || 0) > 0) carriedActions += 1;
      }

      if (meeting.integrityState().state === 'edited-since-approval') {
        editedAfterApproval += 1;
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        activeCommittees: committees,
        meetingCount: meetings.length,
        byStatus,
        motions,
        byOutcome,
        // The number the school currently cannot produce: decisions taken
        // without quorum, and therefore void.
        voidMotions,
        recusals,
        openActions,
        carriedActions,
        // Approved minutes whose content no longer matches the approval.
        editedAfterApproval,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build governance statistics');
  }
};
