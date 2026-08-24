// backend/controllers/meetingOutcomeController.js
const mongoose = require('mongoose');
const MeetingSlot = require('../models/MeetingSlot');
const MeetingOutcome = require('../models/MeetingOutcome');

/**
 * Write-ups of parent-teacher meetings.
 *
 * Two things are load-bearing here and neither is enforced by a validator.
 *
 * The first is that the family's copy is built by *naming* the fields it may
 * contain, not by deleting the ones it may not. A redaction that works by
 * deletion is one added field away from leaking `privateNote`, and this is
 * exactly the kind of object that grows fields.
 *
 * The second is that an outcome may only be raised against a booking the slot
 * says was attended. Whether the meeting happened is a fact `MeetingSlot`
 * already holds; taking it from the request body would make "write up a meeting
 * that never occurred" an available operation.
 */

const handleError = (res, err, message = 'Server error') => {
  console.error('[meeting-outcomes]', err);
  return res.status(500).json({ success: false, message, error: err.message });
};

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const getPagination = (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
};

const isAdmin = (user) => user && user.role === 'admin';

const ownsAsTeacher = (outcome, user) =>
  isAdmin(user) || String(outcome.teacher) === String(user._id);

const ownsAsFamily = (outcome, user) => String(outcome.requestedBy) === String(user._id);

/**
 * The staff view. Everything, including the private note.
 */
const staffOutcome = (outcome) => ({
  _id: outcome._id,
  slot: outcome.slot,
  bookingReference: outcome.bookingReference,
  teacher: outcome.teacher,
  teacherName: outcome.teacherName,
  requestedBy: outcome.requestedBy,
  guardianName: outcome.guardianName,
  studentName: outcome.studentName,
  className: outcome.className,
  meetingDate: outcome.meetingDate,
  purpose: outcome.purpose,
  discussionSummary: outcome.discussionSummary,
  strengths: outcome.strengths,
  concerns: outcome.concerns,
  privateNote: outcome.privateNote,
  actions: outcome.actionRows(),
  tally: outcome.actionTally(),
  status: outcome.status,
  publishedAt: outcome.publishedAt,
  closedAt: outcome.closedAt,
  closureNote: outcome.closureNote,
  addenda: outcome.addenda,
  acknowledgedAt: outcome.acknowledgedAt,
  previousOutcome: outcome.previousOutcome,
  history: outcome.history,
  createdAt: outcome.createdAt,
});

/**
 * The family's copy.
 *
 * Built field by field on purpose. `privateNote` is not deleted here — it is
 * never mentioned, which is a different and stronger guarantee.
 */
const familyOutcome = (outcome) => ({
  _id: outcome._id,
  teacherName: outcome.teacherName,
  studentName: outcome.studentName,
  className: outcome.className,
  meetingDate: outcome.meetingDate,
  purpose: outcome.purpose,
  discussionSummary: outcome.discussionSummary,
  strengths: outcome.strengths,
  concerns: outcome.concerns,
  actions: outcome.actionRows().map((action) => ({
    index: action.index,
    description: action.description,
    ownerRole: action.ownerRole,
    ownerName: action.ownerName,
    dueOn: action.dueOn,
    status: action.status,
    completedAt: action.completedAt,
    overdue: action.overdue,
    daysLate: action.daysLate,
  })),
  tally: outcome.actionTally(),
  status: outcome.status,
  publishedAt: outcome.publishedAt,
  closedAt: outcome.closedAt,
  addenda: outcome.addenda
    .filter((addendum) => addendum.visibleToFamily)
    .map((addendum) => ({
      text: addendum.text,
      addedByName: addendum.addedByName,
      addedByRole: addendum.addedByRole,
      addedAt: addendum.addedAt,
    })),
  acknowledgedAt: outcome.acknowledgedAt,
});

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

exports.getOutcomeMeta = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        statuses: MeetingOutcome.OUTCOME_STATUSES,
        actionOwnerRoles: MeetingOutcome.ACTION_OWNER_ROLES,
        actionStatuses: MeetingOutcome.ACTION_STATUSES,
        settledActionStatuses: MeetingOutcome.SETTLED_ACTION_STATUSES,
        purposes: MeetingOutcome.MEETING_PURPOSES,
        maxActions: MeetingOutcome.MAX_ACTIONS,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load outcome reference data');
  }
};

// ---------------------------------------------------------------------------
// Writing one up
// ---------------------------------------------------------------------------

exports.createOutcome = async (req, res) => {
  try {
    const { id, bookingId } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid slot id' });
    }

    const slot = await MeetingSlot.findById(id);
    if (!slot) {
      return res.status(404).json({ success: false, message: 'Slot not found' });
    }

    if (!isAdmin(req.user) && String(slot.teacher) !== String(req.user._id)) {
      return res.status(403).json({
        success: false,
        message: 'Only the teacher who held the meeting may write it up',
      });
    }

    const booking = slot.bookings.id(bookingId) ||
      slot.bookings.find((row) => row.reference === bookingId);

    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found on this slot' });
    }

    /**
     * The meeting has to have happened.
     *
     * `attended` is a fact the slot already holds. Reading it from here rather
     * than trusting the caller is what stops "write up a meeting that did not
     * occur" being an available operation.
     */
    if (booking.status !== 'attended') {
      return res.status(400).json({
        success: false,
        message: `That booking is marked "${booking.status}". Only an attended meeting can be written up.`,
      });
    }

    const existing = await MeetingOutcome.findOne({
      slot: slot._id,
      bookingReference: booking.reference,
    });

    if (existing) {
      return res.status(200).json({
        success: true,
        message: 'This meeting has already been written up',
        data: staffOutcome(existing),
      });
    }

    // What was agreed last time, so the teacher does not start from zero.
    const previous = await MeetingOutcome.findOne({
      studentName: booking.studentName,
      status: { $in: ['published', 'closed'] },
    }).sort({ meetingDate: -1, createdAt: -1 });

    const { discussionSummary, strengths = [], concerns = [], privateNote = '', actions = [] } =
      req.body;

    const outcome = new MeetingOutcome({
      slot: slot._id,
      bookingReference: booking.reference,
      teacher: slot.teacher,
      teacherName: slot.teacherName,
      requestedBy: booking.requestedBy,
      guardianName: booking.guardianName,
      studentName: booking.studentName,
      className: booking.className,
      meetingDate: slot.date,
      purpose: slot.purpose,
      discussionSummary,
      strengths: strengths.map((text) => ({ text })),
      concerns: concerns.map((text) => ({ text })),
      privateNote,
      previousOutcome: previous ? previous._id : null,
      status: 'draft',
    });

    actions.forEach((action) => outcome.addAction(req.user, action));
    outcome.log('drafted', req.user);

    try {
      await outcome.save();
    } catch (saveErr) {
      if (saveErr.code === 11000) {
        const other = await MeetingOutcome.findOne({
          slot: slot._id,
          bookingReference: booking.reference,
        });
        return res.status(409).json({
          success: false,
          message: 'This meeting has already been written up',
          data: other ? staffOutcome(other) : null,
        });
      }
      if (saveErr.name === 'ValidationError') {
        return res.status(400).json({ success: false, message: saveErr.message });
      }
      throw saveErr;
    }

    return res.status(201).json({
      success: true,
      message: 'Draft saved. It is not visible to the family until you publish it.',
      data: staffOutcome(outcome),
    });
  } catch (err) {
    return handleError(res, err, 'Could not write up the meeting');
  }
};

exports.updateOutcome = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid outcome id' });
    }

    const outcome = await MeetingOutcome.findById(id);
    if (!outcome) {
      return res.status(404).json({ success: false, message: 'Outcome not found' });
    }

    if (!ownsAsTeacher(outcome, req.user)) {
      return res.status(403).json({ success: false, message: 'This is not your write-up' });
    }

    if (outcome.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: 'A published write-up cannot be edited. Add an addendum instead.',
      });
    }

    if (req.body.discussionSummary !== undefined) {
      outcome.discussionSummary = req.body.discussionSummary;
    }
    if (Array.isArray(req.body.strengths)) {
      outcome.strengths = req.body.strengths.map((text) => ({ text }));
    }
    if (Array.isArray(req.body.concerns)) {
      outcome.concerns = req.body.concerns.map((text) => ({ text }));
    }
    if (req.body.privateNote !== undefined) outcome.privateNote = req.body.privateNote;

    outcome.log('edited', req.user);

    try {
      await outcome.save();
    } catch (saveErr) {
      if (saveErr.name === 'ValidationError') {
        return res.status(400).json({ success: false, message: saveErr.message });
      }
      throw saveErr;
    }

    return res.status(200).json({ success: true, message: 'Draft updated', data: staffOutcome(outcome) });
  } catch (err) {
    return handleError(res, err, 'Could not update the write-up');
  }
};

exports.publishOutcome = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid outcome id' });
    }

    const outcome = await MeetingOutcome.findById(id);
    if (!outcome) {
      return res.status(404).json({ success: false, message: 'Outcome not found' });
    }

    if (!ownsAsTeacher(outcome, req.user)) {
      return res.status(403).json({ success: false, message: 'This is not your write-up' });
    }

    try {
      outcome.publish(req.user);
    } catch (stateErr) {
      return res.status(400).json({ success: false, message: stateErr.message });
    }

    await outcome.save();

    return res.status(200).json({
      success: true,
      message: 'Published. The family can now read it, and it can no longer be edited.',
      data: staffOutcome(outcome),
    });
  } catch (err) {
    return handleError(res, err, 'Could not publish the write-up');
  }
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

exports.addAction = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid outcome id' });
    }

    const outcome = await MeetingOutcome.findById(id);
    if (!outcome) {
      return res.status(404).json({ success: false, message: 'Outcome not found' });
    }

    if (!ownsAsTeacher(outcome, req.user)) {
      return res.status(403).json({ success: false, message: 'This is not your write-up' });
    }

    if (outcome.status === 'closed') {
      return res
        .status(400)
        .json({ success: false, message: 'This outcome is closed; reopen the conversation instead' });
    }

    outcome.addAction(req.user, req.body);

    try {
      await outcome.save();
    } catch (saveErr) {
      if (saveErr.name === 'ValidationError') {
        return res.status(400).json({ success: false, message: saveErr.message });
      }
      throw saveErr;
    }

    return res.status(201).json({
      success: true,
      message: 'Action added',
      data: staffOutcome(outcome),
    });
  } catch (err) {
    return handleError(res, err, 'Could not add the action');
  }
};

/**
 * Settle one action.
 *
 * A family may settle an action they own, because the person who undertook to
 * do the thing is the person who knows it is done. They may not touch the
 * school's.
 */
exports.settleAction = async (req, res) => {
  try {
    const { id, actionIndex } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid outcome id' });
    }

    const outcome = await MeetingOutcome.findById(id);
    if (!outcome) {
      return res.status(404).json({ success: false, message: 'Outcome not found' });
    }

    const asTeacher = ownsAsTeacher(outcome, req.user);
    const asFamily = ownsAsFamily(outcome, req.user);

    if (!asTeacher && !asFamily) {
      return res.status(403).json({ success: false, message: 'This is not your write-up' });
    }

    const action = outcome.actions.find((row) => row.index === Number(actionIndex));
    if (!action) {
      return res.status(404).json({ success: false, message: `There is no action ${actionIndex}` });
    }

    if (!asTeacher && action.ownerRole === 'school') {
      return res.status(403).json({
        success: false,
        message: 'That action belongs to the school',
      });
    }

    try {
      outcome.settleAction(actionIndex, req.user, req.body);
    } catch (stateErr) {
      return res.status(400).json({ success: false, message: stateErr.message });
    }

    await outcome.save();

    return res.status(200).json({
      success: true,
      message: `Action ${actionIndex} updated`,
      data: asTeacher ? staffOutcome(outcome) : familyOutcome(outcome),
    });
  } catch (err) {
    return handleError(res, err, 'Could not update the action');
  }
};

exports.addAddendum = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid outcome id' });
    }

    const outcome = await MeetingOutcome.findById(id);
    if (!outcome) {
      return res.status(404).json({ success: false, message: 'Outcome not found' });
    }

    const asTeacher = ownsAsTeacher(outcome, req.user);
    const asFamily = ownsAsFamily(outcome, req.user);

    if (!asTeacher && !asFamily) {
      return res.status(403).json({ success: false, message: 'This is not your write-up' });
    }

    if (!req.body.text || !String(req.body.text).trim()) {
      return res.status(400).json({ success: false, message: 'An addendum needs some text' });
    }

    try {
      outcome.addAddendum(req.user, String(req.body.text).trim(), asFamily && !asTeacher);
    } catch (stateErr) {
      return res.status(400).json({ success: false, message: stateErr.message });
    }

    await outcome.save();

    return res.status(201).json({
      success: true,
      message: 'Addendum added',
      data: asTeacher ? staffOutcome(outcome) : familyOutcome(outcome),
    });
  } catch (err) {
    return handleError(res, err, 'Could not add the addendum');
  }
};

exports.acknowledgeOutcome = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid outcome id' });
    }

    const outcome = await MeetingOutcome.findById(id);
    if (!outcome) {
      return res.status(404).json({ success: false, message: 'Outcome not found' });
    }

    if (!ownsAsFamily(outcome, req.user)) {
      return res
        .status(403)
        .json({ success: false, message: 'Only the family that booked may acknowledge this' });
    }

    try {
      outcome.acknowledge(req.user);
    } catch (stateErr) {
      return res.status(400).json({ success: false, message: stateErr.message });
    }

    await outcome.save();

    return res.status(200).json({
      success: true,
      message: 'Thank you — the school can see that you have read it.',
      data: familyOutcome(outcome),
    });
  } catch (err) {
    return handleError(res, err, 'Could not acknowledge the write-up');
  }
};

exports.closeOutcome = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid outcome id' });
    }

    const outcome = await MeetingOutcome.findById(id);
    if (!outcome) {
      return res.status(404).json({ success: false, message: 'Outcome not found' });
    }

    if (!ownsAsTeacher(outcome, req.user)) {
      return res.status(403).json({ success: false, message: 'This is not your write-up' });
    }

    try {
      outcome.close(req.user, req.body.note);
    } catch (stateErr) {
      return res.status(400).json({ success: false, message: stateErr.message });
    }

    await outcome.save();

    return res.status(200).json({
      success: true,
      message: 'Outcome closed',
      data: staffOutcome(outcome),
    });
  } catch (err) {
    return handleError(res, err, 'Could not close the outcome');
  }
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

exports.getOutcomes = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = {};

    // A teacher sees their own; an admin sees everything.
    if (!isAdmin(req.user)) filter.teacher = req.user._id;

    if (req.query.status && MeetingOutcome.OUTCOME_STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (req.query.studentName) {
      filter.studentName = { $regex: String(req.query.studentName).trim(), $options: 'i' };
    }

    const [outcomes, total] = await Promise.all([
      MeetingOutcome.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      MeetingOutcome.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      count: outcomes.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      data: outcomes.map(staffOutcome),
    });
  } catch (err) {
    return handleError(res, err, 'Could not load write-ups');
  }
};

exports.getMyOutcomes = async (req, res) => {
  try {
    // Drafts are the teacher's working copy and are not the family's business.
    const outcomes = await MeetingOutcome.find({
      requestedBy: req.user._id,
      status: { $in: ['published', 'closed'] },
    }).sort({ meetingDate: -1, createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: outcomes.length,
      data: outcomes.map(familyOutcome),
    });
  } catch (err) {
    return handleError(res, err, 'Could not load your meeting write-ups');
  }
};

exports.getOutcome = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid outcome id' });
    }

    const outcome = await MeetingOutcome.findById(id);
    if (!outcome) {
      return res.status(404).json({ success: false, message: 'Outcome not found' });
    }

    if (ownsAsTeacher(outcome, req.user)) {
      return res.status(200).json({ success: true, data: staffOutcome(outcome) });
    }

    if (ownsAsFamily(outcome, req.user)) {
      if (outcome.status === 'draft') {
        return res
          .status(404)
          .json({ success: false, message: 'That meeting has not been written up yet' });
      }
      return res.status(200).json({ success: true, data: familyOutcome(outcome) });
    }

    return res.status(403).json({ success: false, message: 'This is not your write-up' });
  } catch (err) {
    return handleError(res, err, 'Could not load the write-up');
  }
};

/**
 * Attended meetings with no write-up. The teacher's backlog, oldest first.
 */
exports.getPendingWriteUps = async (req, res) => {
  try {
    const filter = { 'bookings.status': 'attended' };
    if (!isAdmin(req.user)) filter.teacher = req.user._id;

    const slots = await MeetingSlot.find(filter).sort({ date: 1 }).limit(200);

    const written = await MeetingOutcome.find({
      slot: { $in: slots.map((slot) => slot._id) },
    }).select('slot bookingReference');

    const done = new Set(written.map((row) => `${row.slot}:${row.bookingReference}`));
    const pending = [];

    slots.forEach((slot) => {
      slot.bookings
        .filter((booking) => booking.status === 'attended')
        .forEach((booking) => {
          if (done.has(`${slot._id}:${booking.reference}`)) return;

          pending.push({
            slot: slot._id,
            bookingId: booking._id,
            bookingReference: booking.reference,
            teacherName: slot.teacherName,
            date: slot.date,
            startTime: slot.startTime,
            purpose: slot.purpose,
            guardianName: booking.guardianName,
            studentName: booking.studentName,
            className: booking.className,
            agenda: booking.agenda,
          });
        });
    });

    pending.sort((a, b) => (a.date < b.date ? -1 : 1));

    return res.status(200).json({ success: true, count: pending.length, data: pending });
  } catch (err) {
    return handleError(res, err, 'Could not load the write-up backlog');
  }
};

/**
 * What the school promised and has not done.
 *
 * School-owned and family-owned actions are counted apart, because a list that
 * mixes them is not a list anybody can act on.
 */
exports.getOpenActions = async (req, res) => {
  try {
    const filter = { status: 'published' };
    if (!isAdmin(req.user)) filter.teacher = req.user._id;

    const outcomes = await MeetingOutcome.find(filter);
    const rows = [];

    outcomes.forEach((outcome) => {
      outcome.actionRows().forEach((action) => {
        if (action.status !== 'open') return;

        rows.push({
          outcome: outcome._id,
          studentName: outcome.studentName,
          className: outcome.className,
          teacherName: outcome.teacherName,
          meetingDate: outcome.meetingDate,
          index: action.index,
          description: action.description,
          ownerRole: action.ownerRole,
          ownerName: action.ownerName,
          dueOn: action.dueOn,
          overdue: action.overdue,
          daysLate: action.daysLate,
        });
      });
    });

    // Most overdue first — the chase list is only useful in that order.
    rows.sort((a, b) => b.daysLate - a.daysLate || new Date(a.dueOn) - new Date(b.dueOn));

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows,
      summary: {
        total: rows.length,
        overdue: rows.filter((row) => row.overdue).length,
        school: rows.filter((row) => row.ownerRole === 'school').length,
        schoolOverdue: rows.filter((row) => row.ownerRole === 'school' && row.overdue).length,
        family: rows.filter((row) => row.ownerRole !== 'school').length,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load open actions');
  }
};

exports.getOutcomeStats = async (req, res) => {
  try {
    const outcomes = await MeetingOutcome.find({});

    let published = 0;
    let closed = 0;
    let drafts = 0;
    let acknowledged = 0;
    let openActions = 0;
    let overdueActions = 0;

    outcomes.forEach((outcome) => {
      if (outcome.status === 'draft') drafts += 1;
      if (outcome.status === 'published') published += 1;
      if (outcome.status === 'closed') closed += 1;
      if (outcome.acknowledgedAt) acknowledged += 1;

      const tally = outcome.actionTally();
      openActions += tally.open;
      overdueActions += tally.overdue;
    });

    return res.status(200).json({
      success: true,
      data: {
        total: outcomes.length,
        drafts,
        published,
        closed,
        acknowledged,
        // How many families have actually read what was agreed. The figure the
        // school currently has no way of knowing at all.
        acknowledgementRate: published + closed
          ? Math.round((acknowledged / (published + closed)) * 100)
          : 0,
        openActions,
        overdueActions,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not build outcome statistics');
  }
};
