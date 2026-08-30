const mongoose = require('mongoose');
const StaffAbsence = require('../models/StaffAbsence');
const User = require('../models/User');

/**
 * Staff absence and substitute cover.
 *
 * The one handler worth reading closely is `assignCover`. Everything else in
 * this file is a form, a list or a state transition.
 */

const COMMITTED = StaffAbsence.COMMITTED_COVER_STATUSES;
const LIVE = StaffAbsence.LIVE_ABSENCE_STATUSES;

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

function ownsAbsence(absence, user) {
  return String(absence.staff) === String(user._id) || isAdmin(user);
}

/**
 * The periods a client may send. Everything to do with who is covering, and
 * when they were asked, is server-owned — a client that sends `coverStatus:
 * 'assigned'` alongside a `substitute` id would otherwise book a colleague.
 */
function sanitisePeriods(periods) {
  if (!Array.isArray(periods)) return [];
  return periods.map((period) => ({
    periodLabel: period.periodLabel,
    startTime: period.startTime,
    endTime: period.endTime,
    className: period.className,
    subject: period.subject,
    room: period.room,
    lessonPlan: period.lessonPlan,
  }));
}

/**
 * Every interval `userId` is already committed to on `date`, across every
 * absence on that date.
 *
 * One query, one pass. `commitmentsFor` on the model folds both kinds of
 * commitment — being absent, and having been assigned cover — into the same
 * shape, so the caller does not have to care which is which until it wants to
 * write the error message.
 */
async function commitmentsOn(date, userId, ignoreAbsenceId = null) {
  const filter = {
    date,
    status: { $ne: 'cancelled' },
    $or: [
      { staff: userId, status: { $in: LIVE } },
      {
        periods: {
          $elemMatch: { substitute: userId, coverStatus: { $in: COMMITTED } },
        },
      },
    ],
  };
  if (ignoreAbsenceId) filter._id = { $ne: ignoreAbsenceId };

  const absences = await StaffAbsence.find(filter).select(
    'staff status date periods'
  );

  return absences.flatMap((absence) => absence.commitmentsFor(userId));
}

// ---------------------------------------------------------------------------
// Reporting an absence
// ---------------------------------------------------------------------------

/**
 * POST /api/substitutions/absences
 *
 * A teacher reports their own absence; an admin may report one on anybody's
 * behalf, which is the common case at 07:40 when the teacher has phoned the
 * office rather than opened a laptop.
 */
exports.createAbsence = async (req, res) => {
  try {
    const { date, reason, details, periods, staff } = req.body;

    let subject = req.user;
    if (staff && String(staff) !== String(req.user._id)) {
      if (!isAdmin(req.user)) {
        return fail(res, 403, 'Only an admin can report an absence for someone else.');
      }
      if (!isValidId(staff)) return fail(res, 400, 'Invalid staff id.');

      subject = await User.findById(staff).select('name role');
      if (!subject) return fail(res, 404, 'That staff member does not exist.');
      if (!['teacher', 'admin'].includes(subject.role)) {
        return fail(res, 400, 'Only teaching staff can be marked absent.');
      }
    }

    const cleanPeriods = sanitisePeriods(periods);
    if (cleanPeriods.length === 0) {
      return fail(res, 400, 'List at least one period that needs covering.');
    }

    // One absence per person per day. Two half-day absences reported separately
    // produce two boards for the same teacher and a cover clash that looks like
    // a bug in the overlap check.
    const existing = await StaffAbsence.findOne({
      staff: subject._id,
      date,
      status: { $in: LIVE },
    });
    if (existing) {
      return fail(
        res,
        409,
        'An absence is already recorded for that person on that date. Edit it instead of adding a second one.'
      );
    }

    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    const earliest = cleanPeriods
      .map((period) => StaffAbsence.toMinutes(period.startTime))
      .filter((minute) => minute !== null)
      .sort((a, b) => a - b)[0];

    const absence = await StaffAbsence.create({
      staff: subject._id,
      staffName: subject.name,
      date,
      reason,
      details,
      periods: cleanPeriods,
      reportedBy: req.user._id,
      lateNotice:
        date === StaffAbsence.todayKey() && earliest !== undefined && nowMinutes > earliest,
      // status, approvedBy and every cover field are deliberately absent. They
      // are server-owned and a client-supplied value is dropped here.
    });

    return res.status(201).json({
      success: true,
      message: `Absence recorded with ${absence.periods.length} period${
        absence.periods.length === 1 ? '' : 's'
      } to cover.`,
      data: absence.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record the absence');
  }
};

/**
 * GET /api/substitutions/absences
 * The admin view of the register.
 */
exports.listAbsences = async (req, res) => {
  try {
    const { date, from, to, status, staff, uncoveredOnly } = req.query;

    const filter = {};
    if (date) filter.date = date;
    else if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = from;
      if (to) filter.date.$lte = to;
    }
    if (status) filter.status = status;
    if (staff && isValidId(staff)) filter.staff = staff;

    let absences = await StaffAbsence.find(filter)
      .sort({ date: -1, staffName: 1 })
      .limit(400);

    if (uncoveredOnly === 'true') {
      absences = absences.filter((absence) => absence.uncoveredCount > 0);
    }

    return res.status(200).json({
      success: true,
      count: absences.length,
      data: absences.map((absence) => absence.redactFor(req.user)),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch absences');
  }
};

/**
 * GET /api/substitutions/absences/mine
 */
exports.getMyAbsences = async (req, res) => {
  try {
    const absences = await StaffAbsence.find({ staff: req.user._id })
      .sort({ date: -1 })
      .limit(200);

    return res.status(200).json({
      success: true,
      count: absences.length,
      data: absences.map((absence) => absence.redactFor(req.user)),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch your absences');
  }
};

/**
 * GET /api/substitutions/absences/:id
 */
exports.getAbsence = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid absence id.');

    const absence = await StaffAbsence.findById(req.params.id);
    if (!absence) return fail(res, 404, 'Absence not found.');

    return res.status(200).json({
      success: true,
      data: absence.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the absence');
  }
};

/**
 * PATCH /api/substitutions/absences/:id
 *
 * Editing the period list once cover has been assigned would silently drop
 * assignments, so it is refused. Correcting a lesson plan is always allowed —
 * that is the field most likely to need fixing after somebody has been asked.
 */
exports.updateAbsence = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid absence id.');

    const absence = await StaffAbsence.findById(req.params.id);
    if (!absence) return fail(res, 404, 'Absence not found.');
    if (!ownsAbsence(absence, req.user)) {
      return fail(res, 403, 'You can only edit your own absences.');
    }
    if (absence.status === 'cancelled' || absence.status === 'rejected') {
      return fail(res, 409, 'This absence is closed and can no longer be edited.');
    }

    const { reason, details, periods } = req.body;
    if (reason !== undefined) absence.reason = reason;
    if (details !== undefined) absence.details = details;

    if (periods !== undefined) {
      if (absence.coveredCount > 0) {
        return fail(
          res,
          409,
          'Cover has already been assigned against this absence. Release the assignments before changing the periods.'
        );
      }
      absence.periods = sanitisePeriods(periods);
    }

    await absence.save();

    return res.status(200).json({
      success: true,
      message: 'Absence updated.',
      data: absence.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update the absence');
  }
};

/**
 * PATCH /api/substitutions/absences/:id/approve
 */
exports.approveAbsence = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid absence id.');

    const absence = await StaffAbsence.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      {
        $set: {
          status: 'approved',
          approvedBy: req.user._id,
          approvedAt: new Date(),
          rejectionReason: null,
        },
      },
      { new: true }
    );

    if (!absence) {
      return fail(res, 409, 'That absence is not awaiting a decision.');
    }

    return res.status(200).json({
      success: true,
      message: 'Absence approved.',
      data: absence.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to approve the absence');
  }
};

/**
 * PATCH /api/substitutions/absences/:id/reject
 */
exports.rejectAbsence = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid absence id.');

    const { rejectionReason } = req.body;
    if (!rejectionReason || String(rejectionReason).trim().length < 5) {
      return fail(res, 400, 'Give a reason of at least 5 characters.');
    }

    const absence = await StaffAbsence.findById(req.params.id);
    if (!absence) return fail(res, 404, 'Absence not found.');
    if (absence.status !== 'pending') {
      return fail(res, 409, 'That absence is not awaiting a decision.');
    }
    if (absence.coveredCount > 0) {
      return fail(
        res,
        409,
        'Cover has already been assigned against this absence. Release it before rejecting.'
      );
    }

    absence.status = 'rejected';
    absence.rejectionReason = rejectionReason;
    await absence.save();

    return res.status(200).json({
      success: true,
      message: 'Absence rejected.',
      data: absence.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to reject the absence');
  }
};

/**
 * PATCH /api/substitutions/absences/:id/cancel
 *
 * The teacher came in after all. Every assignment goes back so the substitutes
 * stop expecting a class, and the periods keep their history.
 */
exports.cancelAbsence = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid absence id.');

    const absence = await StaffAbsence.findById(req.params.id);
    if (!absence) return fail(res, 404, 'Absence not found.');
    if (!ownsAbsence(absence, req.user)) {
      return fail(res, 403, 'You can only cancel your own absences.');
    }
    if (absence.status === 'cancelled') {
      return fail(res, 409, 'That absence is already cancelled.');
    }

    absence.status = 'cancelled';
    absence.cancelReason = req.body.cancelReason || null;
    absence.cancelledAt = new Date();

    for (const period of absence.periods) {
      if (COMMITTED.includes(period.coverStatus)) {
        period.coverStatus = 'not-required';
        period.notRequiredReason = 'Absence cancelled.';
      }
    }

    await absence.save();

    return res.status(200).json({
      success: true,
      message: 'Absence cancelled and any cover released.',
      data: absence.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to cancel the absence');
  }
};

// ---------------------------------------------------------------------------
// The cover board
// ---------------------------------------------------------------------------

/**
 * GET /api/substitutions/board?date=YYYY-MM-DD
 *
 * One date, flattened to a list of periods sorted by start time — which is how
 * the person arranging cover thinks about the morning, rather than as a list of
 * absences each containing periods.
 */
exports.getBoard = async (req, res) => {
  try {
    const date = req.query.date || StaffAbsence.todayKey();

    const absences = await StaffAbsence.find({
      date,
      status: { $in: LIVE },
    }).sort({ staffName: 1 });

    const rows = [];
    for (const absence of absences) {
      for (const period of absence.periods) {
        rows.push({
          absenceId: absence._id,
          periodId: period._id,
          staffName: absence.staffName,
          reason: absence.reason,
          lateNotice: absence.lateNotice,
          absenceStatus: absence.status,
          periodLabel: period.periodLabel,
          startTime: period.startTime,
          endTime: period.endTime,
          startMinute: period.startMinute,
          endMinute: period.endMinute,
          className: period.className,
          subject: period.subject,
          room: period.room,
          coverStatus: period.coverStatus,
          substitute: period.substitute,
          substituteName: period.substituteName,
          notRequiredReason: period.notRequiredReason,
          declineReason: period.declineReason,
        });
      }
    }

    rows.sort((a, b) => a.startMinute - b.startMinute || a.className.localeCompare(b.className));

    const uncovered = rows.filter(
      (row) => row.coverStatus === 'unassigned' || row.coverStatus === 'declined'
    );

    return res.status(200).json({
      success: true,
      date,
      summary: {
        absentStaff: absences.length,
        periods: rows.length,
        uncovered: uncovered.length,
        covered: rows.filter((row) => COMMITTED.includes(row.coverStatus)).length,
      },
      data: rows,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build the cover board');
  }
};

/**
 * GET /api/substitutions/available?date=&startTime=&endTime=
 *
 * Which teachers have nothing else on in that window. This is the query the
 * whole module exists to answer; the assignment endpoint re-checks it on the
 * write, because a list fetched thirty seconds ago is a suggestion.
 */
exports.getAvailableStaff = async (req, res) => {
  try {
    const { date, startTime, endTime } = req.query;

    const startMinute = StaffAbsence.toMinutes(startTime);
    const endMinute = StaffAbsence.toMinutes(endTime);
    if (!date || startMinute === null || endMinute === null) {
      return fail(res, 400, 'date, startTime and endTime (HH:MM) are all required.');
    }
    if (endMinute <= startMinute) {
      return fail(res, 400, 'endTime must be after startTime.');
    }

    const window = { startMinute, endMinute };

    const staff = await User.find({ role: { $in: ['teacher', 'admin'] } })
      .select('name email role')
      .sort({ name: 1 })
      .limit(300);

    // Every absence on the date, fetched once. Filtering per teacher in memory
    // beats one query per teacher, and the day's absences are a handful of
    // documents.
    const absences = await StaffAbsence.find({
      date,
      status: { $ne: 'cancelled' },
    }).select('staff status date periods');

    const available = [];
    const busy = [];

    for (const person of staff) {
      const commitments = absences.flatMap((absence) =>
        absence.commitmentsFor(person._id)
      );
      const clash = commitments.find((commitment) =>
        StaffAbsence.overlaps(commitment, window)
      );

      const entry = {
        _id: person._id,
        name: person.name,
        email: person.email,
        role: person.role,
        coverPeriodsToday: commitments.filter((c) => c.kind === 'cover').length,
      };

      if (clash) {
        busy.push({
          ...entry,
          reason:
            clash.kind === 'absent'
              ? `Absent themself (${clash.label})`
              : `Already covering ${clash.label} at ${clash.startTime}`,
        });
      } else {
        available.push(entry);
      }
    }

    // Spread the load: the person who has covered least today is offered first.
    available.sort((a, b) => a.coverPeriodsToday - b.coverPeriodsToday || a.name.localeCompare(b.name));

    return res.status(200).json({
      success: true,
      date,
      window: { startTime, endTime },
      count: available.length,
      data: available,
      busy,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to work out who is available');
  }
};

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/**
 * PATCH /api/substitutions/absences/:id/periods/:periodId/assign
 *
 * Two races to close, and they are not the same race.
 *
 * The narrow one — two admins filling *the same* empty period at the same
 * instant — is closed atomically. The write is a single `findOneAndUpdate`
 * whose filter requires the period to still be unassigned:
 *
 *   { _id, periods: { $elemMatch: { _id: periodId,
 *                                   coverStatus: { $in: ['unassigned','declined'] } } } }
 *
 * The loser matches nothing and gets a 409 rather than quietly overwriting the
 * winner's choice, which is the failure that loses information: the first
 * substitute has already been told.
 *
 * The wide one — two admins booking the *same substitute* into two different
 * overlapping periods — spans documents and cannot be folded into a conditional
 * update without a transaction, which this deployment does not assume. It stays
 * a pre-check. That is a deliberate trade: the pre-check's race window is
 * milliseconds wide, the result is visible on the board immediately, and the
 * cost of losing it is a phone call. The same trade is documented in the
 * meetings module for the same reason.
 */
exports.assignCover = async (req, res) => {
  try {
    const { id, periodId } = req.params;
    const { substitute, lessonPlan } = req.body;

    if (!isValidId(id) || !isValidId(periodId)) {
      return fail(res, 400, 'Invalid absence or period id.');
    }
    if (!isValidId(substitute)) {
      return fail(res, 400, 'Choose a substitute.');
    }

    const absence = await StaffAbsence.findById(id);
    if (!absence) return fail(res, 404, 'Absence not found.');

    const blocked = absence.assignabilityError();
    if (blocked) return fail(res, 409, blocked);

    const period = absence.findPeriod(periodId);
    if (!period) return fail(res, 404, 'That period is not part of this absence.');
    if (COMMITTED.includes(period.coverStatus)) {
      return fail(res, 409, `${period.substituteName} is already covering that period.`);
    }
    if (period.coverStatus === 'not-required') {
      return fail(res, 409, 'That period has been marked as needing no cover.');
    }

    if (String(substitute) === String(absence.staff)) {
      return fail(res, 400, 'The absent teacher cannot cover their own period.');
    }

    const person = await User.findById(substitute).select('name role');
    if (!person) return fail(res, 404, 'That staff member does not exist.');
    if (!['teacher', 'admin'].includes(person.role)) {
      return fail(res, 400, 'Only teaching staff can be assigned cover.');
    }

    // The cross-document check. `commitmentsOn` includes this person's own
    // absences, so "do not ask someone who is off sick to cover" falls out of
    // it for free.
    const commitments = await commitmentsOn(absence.date, person._id, absence._id);
    const clash = commitments.find((commitment) =>
      StaffAbsence.overlaps(commitment, period)
    );
    if (clash) {
      return fail(
        res,
        409,
        clash.kind === 'absent'
          ? `${person.name} is absent themself at that time.`
          : `${person.name} is already covering ${clash.label} at ${clash.startTime}.`
      );
    }

    // Same-document commitments are not in `commitments` — the query excluded
    // this absence so the period being reassigned does not clash with itself.
    const selfClash = absence.periods.find(
      (other) =>
        String(other._id) !== String(period._id) &&
        other.substitute &&
        String(other.substitute) === String(person._id) &&
        COMMITTED.includes(other.coverStatus) &&
        StaffAbsence.overlaps(other, period)
    );
    if (selfClash) {
      return fail(
        res,
        409,
        `${person.name} is already covering ${selfClash.periodLabel} at ${selfClash.startTime}.`
      );
    }

    /**
     * The availability gate.
     *
     * A weekly non-availability block, a live exclusion and a live opt-out are
     * hard: the person is not in the building, is medically restricted, or has
     * said no, and no reason typed into a box changes any of those. A load cap
     * is soft — on a genuinely short morning the office has to be able to
     * exceed it — so an admin may, by supplying `overrideReason`, which is
     * appended to the profile where the pattern is visible next term.
     *
     * Checked here, in the handler that writes the assignment, rather than only
     * in the panel. A UI that greys out a button is a suggestion.
     */
    const { assertAssignable } = require('./coverAvailabilityController');
    const eligibility = await assertAssignable({
      staffId: person._id,
      staffName: person.name,
      dateKey: absence.date,
      window: { startMinute: period.startMinute, endMinute: period.endMinute },
      actor: req.user,
      override: req.body.overrideReason,
      context: {
        // This period does not count against its own reassignment.
        excludeAbsence: absence._id,
        excludePeriod: period._id,
        periodLabel: period.periodLabel,
      },
    });

    if (!eligibility.ok) {
      return fail(res, 409, eligibility.message, { overridable: eligibility.overridable });
    }

    const updated = await StaffAbsence.findOneAndUpdate(
      {
        _id: absence._id,
        status: { $in: LIVE },
        periods: {
          $elemMatch: {
            _id: period._id,
            coverStatus: { $in: ['unassigned', 'declined'] },
          },
        },
      },
      {
        $set: {
          'periods.$[target].coverStatus': 'assigned',
          'periods.$[target].substitute': person._id,
          'periods.$[target].substituteName': person.name,
          'periods.$[target].assignedBy': req.user._id,
          'periods.$[target].assignedAt': new Date(),
          'periods.$[target].declineReason': null,
          'periods.$[target].declinedAt': null,
          ...(lessonPlan !== undefined ? { 'periods.$[target].lessonPlan': lessonPlan } : {}),
        },
      },
      { new: true, arrayFilters: [{ 'target._id': period._id }] }
    );

    if (!updated) {
      return fail(
        res,
        409,
        'Somebody else filled that period a moment ago. Reload the board.'
      );
    }

    return res.status(200).json({
      success: true,
      message: `${person.name} is covering ${period.periodLabel}.`,
      data: updated.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to assign cover');
  }
};

/**
 * PATCH /api/substitutions/absences/:id/periods/:periodId/release
 *
 * Takes the period back to unassigned. Filtered on the substitute currently
 * recorded so that releasing a stale view of the board does not remove the
 * assignment somebody made in between.
 */
exports.releaseCover = async (req, res) => {
  try {
    const { id, periodId } = req.params;
    if (!isValidId(id) || !isValidId(periodId)) {
      return fail(res, 400, 'Invalid absence or period id.');
    }

    const absence = await StaffAbsence.findById(id);
    if (!absence) return fail(res, 404, 'Absence not found.');

    const period = absence.findPeriod(periodId);
    if (!period) return fail(res, 404, 'That period is not part of this absence.');
    if (!COMMITTED.includes(period.coverStatus)) {
      return fail(res, 409, 'Nobody is assigned to that period.');
    }
    if (period.coverStatus === 'completed') {
      return fail(res, 409, 'That period has already been taught. It cannot be released.');
    }

    const updated = await StaffAbsence.findOneAndUpdate(
      {
        _id: absence._id,
        periods: {
          $elemMatch: {
            _id: period._id,
            coverStatus: 'assigned',
            substitute: period.substitute,
          },
        },
      },
      {
        $set: {
          'periods.$[target].coverStatus': 'unassigned',
          'periods.$[target].substitute': null,
          'periods.$[target].substituteName': null,
          'periods.$[target].assignedBy': null,
          'periods.$[target].assignedAt': null,
        },
      },
      { new: true, arrayFilters: [{ 'target._id': period._id }] }
    );

    if (!updated) {
      return fail(res, 409, 'That assignment changed while you were looking at it. Reload the board.');
    }

    return res.status(200).json({
      success: true,
      message: 'Cover released. The period is back on the board.',
      data: updated.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to release the cover');
  }
};

/**
 * PATCH /api/substitutions/absences/:id/periods/:periodId/not-required
 *
 * Marking a period as needing nobody. The reason is mandatory and the period
 * stays on the board greyed out rather than vanishing — a period that
 * disappears without explanation is indistinguishable from a period everyone
 * forgot, which is the thing this module is for.
 */
exports.markNotRequired = async (req, res) => {
  try {
    const { id, periodId } = req.params;
    const { notRequiredReason } = req.body;

    if (!isValidId(id) || !isValidId(periodId)) {
      return fail(res, 400, 'Invalid absence or period id.');
    }
    if (!notRequiredReason || String(notRequiredReason).trim().length < 5) {
      return fail(res, 400, 'Say why this period needs no cover (at least 5 characters).');
    }

    const absence = await StaffAbsence.findById(id);
    if (!absence) return fail(res, 404, 'Absence not found.');

    const period = absence.findPeriod(periodId);
    if (!period) return fail(res, 404, 'That period is not part of this absence.');
    if (period.coverStatus === 'completed') {
      return fail(res, 409, 'That period has already been taught.');
    }
    if (period.coverStatus === 'assigned') {
      return fail(res, 409, 'Release the assigned substitute before marking the period as not required.');
    }

    period.coverStatus = 'not-required';
    period.notRequiredReason = notRequiredReason;
    await absence.save();

    return res.status(200).json({
      success: true,
      message: 'Period marked as needing no cover.',
      data: absence.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update the period');
  }
};

// ---------------------------------------------------------------------------
// The substitute's side
// ---------------------------------------------------------------------------

/**
 * GET /api/substitutions/my-cover
 * What I have been asked to teach, with the lesson plan attached.
 */
exports.getMyCover = async (req, res) => {
  try {
    const { from, to } = req.query;

    const filter = {
      status: { $in: LIVE },
      periods: {
        $elemMatch: { substitute: req.user._id, coverStatus: { $in: COMMITTED } },
      },
    };
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = from;
      if (to) filter.date.$lte = to;
    } else {
      filter.date = { $gte: StaffAbsence.todayKey() };
    }

    const absences = await StaffAbsence.find(filter).sort({ date: 1 }).limit(200);

    const rows = [];
    for (const absence of absences) {
      for (const period of absence.periods) {
        if (
          period.substitute &&
          String(period.substitute) === String(req.user._id) &&
          COMMITTED.includes(period.coverStatus)
        ) {
          rows.push({
            absenceId: absence._id,
            periodId: period._id,
            date: absence.date,
            absentTeacher: absence.staffName,
            periodLabel: period.periodLabel,
            startTime: period.startTime,
            endTime: period.endTime,
            startMinute: period.startMinute,
            className: period.className,
            subject: period.subject,
            room: period.room,
            lessonPlan: period.lessonPlan,
            coverStatus: period.coverStatus,
            assignedAt: period.assignedAt,
          });
        }
      }
    }

    rows.sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute);

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch your cover periods');
  }
};

/**
 * PATCH /api/substitutions/absences/:id/periods/:periodId/decline
 *
 * Only the assigned substitute may decline, and the reason is mandatory. A
 * declined period goes back on the board in red rather than silently to
 * unassigned, so whoever is arranging cover can see it was refused and does not
 * offer it to the same person again.
 */
exports.declineCover = async (req, res) => {
  try {
    const { id, periodId } = req.params;
    const { declineReason } = req.body;

    if (!isValidId(id) || !isValidId(periodId)) {
      return fail(res, 400, 'Invalid absence or period id.');
    }
    if (!declineReason || String(declineReason).trim().length < 5) {
      return fail(res, 400, 'Give a reason of at least 5 characters.');
    }

    const updated = await StaffAbsence.findOneAndUpdate(
      {
        _id: id,
        periods: {
          $elemMatch: {
            _id: periodId,
            substitute: req.user._id,
            coverStatus: 'assigned',
          },
        },
      },
      {
        $set: {
          'periods.$[target].coverStatus': 'declined',
          'periods.$[target].declineReason': declineReason,
          'periods.$[target].declinedAt': new Date(),
          'periods.$[target].substitute': null,
          'periods.$[target].substituteName': null,
        },
      },
      { new: true, arrayFilters: [{ 'target._id': periodId }] }
    );

    if (!updated) {
      return fail(res, 409, 'You are not the assigned substitute for that period.');
    }

    return res.status(200).json({
      success: true,
      message: 'Declined. The period is back on the cover board.',
      data: updated.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to decline the cover');
  }
};

/**
 * PATCH /api/substitutions/absences/:id/periods/:periodId/complete
 *
 * The substitute confirming they taught it. Admins can also mark it, for the
 * cover that happened but was never confirmed.
 */
exports.completeCover = async (req, res) => {
  try {
    const { id, periodId } = req.params;
    if (!isValidId(id) || !isValidId(periodId)) {
      return fail(res, 400, 'Invalid absence or period id.');
    }

    const match = {
      _id: id,
      periods: {
        $elemMatch: { _id: periodId, coverStatus: 'assigned' },
      },
    };
    if (!isAdmin(req.user)) {
      match.periods.$elemMatch.substitute = req.user._id;
    }

    const updated = await StaffAbsence.findOneAndUpdate(
      match,
      {
        $set: {
          'periods.$[target].coverStatus': 'completed',
          'periods.$[target].completedAt': new Date(),
        },
      },
      { new: true, arrayFilters: [{ 'target._id': periodId }] }
    );

    if (!updated) {
      return fail(res, 409, 'That period is not an assignment you can complete.');
    }

    return res.status(200).json({
      success: true,
      message: 'Cover marked as taught.',
      data: updated.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to mark the cover as taught');
  }
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * GET /api/substitutions/stats
 *
 * Cover load per teacher over a window. This is the answer to "how many periods
 * did I cover this month", which today is answered from memory.
 */
exports.getStats = async (req, res) => {
  try {
    const to = req.query.to || StaffAbsence.todayKey();
    const from = req.query.from || `${to.slice(0, 4)}-01-01`;

    const absences = await StaffAbsence.find({
      date: { $gte: from, $lte: to },
      status: { $in: LIVE },
    }).select('staff staffName date reason periods');

    const load = new Map();
    let periods = 0;
    let uncovered = 0;
    let notRequired = 0;
    const byReason = {};

    for (const absence of absences) {
      byReason[absence.reason] = (byReason[absence.reason] || 0) + 1;

      for (const period of absence.periods) {
        periods += 1;
        if (period.coverStatus === 'not-required') notRequired += 1;
        if (period.coverStatus === 'unassigned' || period.coverStatus === 'declined') {
          uncovered += 1;
        }
        if (period.substitute && COMMITTED.includes(period.coverStatus)) {
          const key = String(period.substitute);
          const entry = load.get(key) || { name: period.substituteName, periods: 0 };
          entry.periods += 1;
          load.set(key, entry);
        }
      }
    }

    const coverLoad = [...load.entries()]
      .map(([id, entry]) => ({ substitute: id, ...entry }))
      .sort((a, b) => b.periods - a.periods);

    return res.status(200).json({
      success: true,
      window: { from, to },
      stats: {
        absences: absences.length,
        periods,
        uncovered,
        notRequired,
        covered: periods - uncovered - notRequired,
        byReason,
        coverLoad,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build the cover statistics');
  }
};
