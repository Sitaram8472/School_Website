// backend/controllers/coverAvailabilityController.js
const mongoose = require('mongoose');
const User = require('../models/User');
const StaffAbsence = require('../models/StaffAbsence');
const CoverAvailability = require('../models/CoverAvailability');

/**
 * Cover availability: who may be asked, and how much.
 *
 * The single idea running through this file is that **load is counted, never
 * stored**. `usageFor` reads `StaffAbsence` every time and adds up the periods
 * that actually exist. Nothing here increments a counter on assignment, so
 * nothing here has to remember to decrement one on release, on cancellation, or
 * when a period is marked not-required — three code paths that live in another
 * controller and would each have to be correct forever.
 *
 * The second idea is that a refusal is a list of reasons rather than a boolean.
 * "Unavailable" produces a phone call to the office; "not in school after 13:00
 * and already on 3 of 3 covers today" does not.
 */

const handleError = (res, err, message = 'Server error') => {
  console.error('[cover-availability]', err);
  return res.status(500).json({ success: false, message, error: err.message });
};

const fail = (res, status, message, extra = {}) =>
  res.status(status).json({ success: false, message, ...extra });

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const isAdmin = (user) => user && user.role === 'admin';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const COMMITTED = StaffAbsence.COMMITTED_COVER_STATUSES;

const getPagination = (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
};

/**
 * Every committed cover period this person holds in the day and in the week
 * containing `dateKey`, counted out of the absence documents themselves.
 *
 * `excludeAbsence` and `excludePeriod` keep a period from clashing with itself
 * when an existing assignment is being re-checked.
 */
const usageFor = async (staffId, dateKey, excludeAbsence = null, excludePeriod = null) => {
  const week = CoverAvailability.weekBoundsOf(dateKey);
  if (!week) {
    return {
      dailyPeriods: 0,
      weeklyPeriods: 0,
      dailyMinutes: 0,
      weeklyMinutes: 0,
      week: null,
      rows: [],
    };
  }

  const absences = await StaffAbsence.find({
    date: { $gte: week.from, $lte: week.to },
    status: { $ne: 'cancelled' },
    'periods.substitute': staffId,
  }).select('date status periods staffName');

  const rows = [];

  absences.forEach((absence) => {
    absence.periods.forEach((period) => {
      if (!period.substitute) return;
      if (String(period.substitute) !== String(staffId)) return;
      if (!COMMITTED.includes(period.coverStatus)) return;

      if (
        excludeAbsence &&
        String(absence._id) === String(excludeAbsence) &&
        excludePeriod &&
        String(period._id) === String(excludePeriod)
      ) {
        return;
      }

      rows.push({
        absence: absence._id,
        periodId: period._id,
        date: absence.date,
        periodLabel: period.periodLabel,
        className: period.className,
        subject: period.subject,
        startTime: period.startTime,
        endTime: period.endTime,
        minutes: Math.max(0, (period.endMinute || 0) - (period.startMinute || 0)),
        coverStatus: period.coverStatus,
      });
    });
  });

  const onDay = rows.filter((row) => row.date === dateKey);

  return {
    dailyPeriods: onDay.length,
    dailyMinutes: onDay.reduce((sum, row) => sum + row.minutes, 0),
    weeklyPeriods: rows.length,
    weeklyMinutes: rows.reduce((sum, row) => sum + row.minutes, 0),
    week,
    rows,
  };
};

/**
 * The whole decision for one person against one window.
 *
 * Returns hard blocks, cap state and a single `blocked` boolean derived from
 * both — separated, because an admin may override the second kind and may not
 * override the first, and the caller has to be able to tell them apart.
 *
 * A missing profile is not a blocked profile. Staff with no document are
 * treated as full-time and capped at the school default; the feature adds
 * constraints where they have been stated and changes nothing where they have
 * not.
 */
const decideFor = async (staffId, dateKey, window, options = {}) => {
  const profile = await CoverAvailability.forStaff(staffId);
  const used = await usageFor(staffId, dateKey, options.excludeAbsence, options.excludePeriod);

  const candidateMinutes = window ? Math.max(0, window.endMinute - window.startMinute) : 0;

  const hard = profile ? profile.hardBlocksFor(dateKey, window) : [];

  // Somebody with no profile still gets the school's caps. Otherwise the way to
  // uncap a teacher would be to delete their profile, which is exactly the
  // wrong incentive.
  const capState = profile
    ? profile.capStateFor({ ...used, candidateMinutes })
    : new CoverAvailability({ staff: staffId }).capStateFor({ ...used, candidateMinutes });

  return {
    profile,
    used,
    hard,
    caps: capState,
    hasProfile: Boolean(profile),
    blocked: hard.length > 0,
    overCap: capState.exceeded.length > 0,
  };
};

/**
 * The refusal message, assembled from whatever applied.
 *
 * Confidential reasons are named as a reason without their detail for anybody
 * but the person themselves and an admin — the board has to know somebody
 * cannot be asked, not why.
 */
const explain = (name, decision, { includeConfidential = false } = {}) => {
  const parts = [];

  decision.hard.forEach((reason) => {
    if (reason.confidential && !includeConfidential) {
      parts.push('Excluded from cover on a recorded adjustment');
    } else {
      parts.push(reason.message);
    }
  });

  decision.caps.exceeded.forEach((entry) => parts.push(entry.message));

  if (!parts.length) return '';
  return `${name}: ${parts.join('; ')}.`;
};

/**
 * The gate used by `assignCover`.
 *
 * Exported rather than duplicated, so an assignment made from a stale board, a
 * script or a direct API call meets the same rule as one made from the panel. A
 * UI that greys out a button is a suggestion.
 */
const assertAssignable = async ({ staffId, staffName, dateKey, window, actor, override, context }) => {
  const decision = await decideFor(staffId, dateKey, window, context || {});

  if (decision.blocked) {
    return {
      ok: false,
      overridable: false,
      message: explain(staffName || 'That teacher', decision, {
        includeConfidential: isAdmin(actor),
      }),
      decision,
    };
  }

  if (decision.overCap) {
    const reason = override && String(override).trim();

    if (!reason) {
      return {
        ok: false,
        // Soft. The office can proceed with a reason, and the panel says so.
        overridable: true,
        message: explain(staffName || 'That teacher', decision),
        decision,
      };
    }

    if (decision.profile) {
      decision.profile.recordOverride({
        date: dateKey,
        periodLabel: (context && context.periodLabel) || '',
        capExceeded: decision.caps.exceeded.map((entry) => entry.cap).join(', '),
        by: actor && actor._id,
        byName: (actor && actor.name) || '',
        reason,
      });
      decision.profile.log('cap-override', actor, reason);
      await decision.profile.save();
    }

    return { ok: true, overridden: true, decision };
  }

  return { ok: true, overridden: false, decision };
};

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

exports.getMeta = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        profileStatuses: CoverAvailability.PROFILE_STATUSES,
        blockReasons: CoverAvailability.BLOCK_REASONS,
        exclusionReasons: CoverAvailability.EXCLUSION_REASONS,
        optOutReasons: CoverAvailability.OPT_OUT_REASONS,
        dayNames: CoverAvailability.DAY_NAMES,
        defaults: {
          dailyCapPeriods: CoverAvailability.DEFAULT_DAILY_CAP_PERIODS,
          weeklyCapPeriods: CoverAvailability.DEFAULT_WEEKLY_CAP_PERIODS,
          dailyCapMinutes: CoverAvailability.DEFAULT_DAILY_CAP_MINUTES,
          weeklyCapMinutes: CoverAvailability.DEFAULT_WEEKLY_CAP_MINUTES,
        },
        maxOptOutDays: CoverAvailability.MAX_OPT_OUT_DAYS,
        maxExclusionDays: CoverAvailability.MAX_EXCLUSION_DAYS,
        today: CoverAvailability.todayKey(),
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load availability reference data');
  }
};

// ---------------------------------------------------------------------------
// The staff member's own view
// ---------------------------------------------------------------------------

/**
 * GET /availability/mine
 *
 * Leads with this week's load rather than with the profile, because the number
 * that matters to a teacher is how much cover they have already done.
 */
exports.getMine = async (req, res) => {
  try {
    const dateKey = DATE_PATTERN.test(req.query.date || '')
      ? req.query.date
      : CoverAvailability.todayKey();

    const profile = await CoverAvailability.forStaff(req.user._id);
    const used = await usageFor(req.user._id, dateKey);

    const capState = (profile || new CoverAvailability({ staff: req.user._id })).capStateFor({
      ...used,
      candidateMinutes: 0,
    });

    return res.status(200).json({
      success: true,
      data: {
        date: dateKey,
        week: used.week,
        hasProfile: Boolean(profile),
        profile: profile ? profile.redactFor(req.user) : null,
        caps: capState,
        thisWeek: used.rows.sort((a, b) => a.date.localeCompare(b.date)),
        optOut: profile ? profile.optOutOn(dateKey) : null,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load your cover availability');
  }
};

/**
 * PATCH /availability/mine/opt-out
 *
 * The one part of the profile that belongs to the person it describes. Bounded
 * in the model at `MAX_OPT_OUT_DAYS`, and it creates the profile if there is
 * not one, because a teacher should not have to be set up by the office before
 * they can say no for a fortnight.
 */
exports.setMyOptOut = async (req, res) => {
  try {
    const { untilDate, reason, note = '' } = req.body;

    let profile = await CoverAvailability.forStaff(req.user._id);
    if (!profile) {
      profile = new CoverAvailability({ staff: req.user._id, staffName: req.user.name });
    }

    profile.setOptOut(req.user, untilDate, reason, note);
    await profile.save();

    return res.status(200).json({
      success: true,
      message: `You are opted out of cover until ${untilDate}.`,
      data: profile.redactFor(req.user),
    });
  } catch (err) {
    if (err instanceof Error && !err.name.includes('Mongo')) {
      return fail(res, 400, err.message);
    }
    return handleError(res, err, 'Could not record your opt-out');
  }
};

exports.clearMyOptOut = async (req, res) => {
  try {
    const profile = await CoverAvailability.forStaff(req.user._id);
    if (!profile) return fail(res, 404, 'You have no availability profile.');

    profile.clearOptOut(req.user);
    await profile.save();

    return res.status(200).json({
      success: true,
      message: 'You are available for cover again.',
      data: profile.redactFor(req.user),
    });
  } catch (err) {
    if (err instanceof Error && !err.name.includes('Mongo')) {
      return fail(res, 400, err.message);
    }
    return handleError(res, err, 'Could not clear your opt-out');
  }
};

// ---------------------------------------------------------------------------
// The office's view
// ---------------------------------------------------------------------------

/**
 * GET /availability/eligible?date&startTime&endTime
 *
 * The same shape `getAvailableStaff` returns, with the constraints applied and
 * the blocked people kept visible rather than hidden.
 *
 * Hiding a blocked teacher produces the phone call asking why they were not
 * asked. Showing the reason answers it before it is made.
 */
exports.getEligible = async (req, res) => {
  try {
    const { date, startTime, endTime } = req.query;

    const startMinute = StaffAbsence.toMinutes(startTime);
    const endMinute = StaffAbsence.toMinutes(endTime);

    if (!DATE_PATTERN.test(date || '') || startMinute === null || endMinute === null) {
      return fail(res, 400, 'date (YYYY-MM-DD), startTime and endTime (HH:MM) are all required.');
    }
    if (endMinute <= startMinute) {
      return fail(res, 400, 'endTime must be after startTime.');
    }

    const window = { startMinute, endMinute };

    const staff = await User.find({ role: { $in: ['teacher', 'admin'] } })
      .select('name email role')
      .sort({ name: 1 })
      .limit(300);

    // Every absence on the date, fetched once, so the clash check does not
    // become one query per teacher.
    const absences = await StaffAbsence.find({
      date,
      status: { $ne: 'cancelled' },
    }).select('staff status date periods');

    const profiles = await CoverAvailability.find({
      staff: { $in: staff.map((person) => person._id) },
    });
    const byStaff = new Map(profiles.map((profile) => [String(profile.staff), profile]));

    const available = [];
    const blocked = [];
    const busy = [];

    for (const person of staff) {
      const commitments = absences.flatMap((absence) => absence.commitmentsFor(person._id));
      const clash = commitments.find((commitment) => StaffAbsence.overlaps(commitment, window));

      const used = await usageFor(person._id, date);
      const profile = byStaff.get(String(person._id)) || null;

      const capState = (profile || new CoverAvailability({ staff: person._id })).capStateFor({
        ...used,
        candidateMinutes: endMinute - startMinute,
      });
      const hard = profile ? profile.hardBlocksFor(date, window) : [];

      const entry = {
        _id: person._id,
        name: person.name,
        email: person.email,
        role: person.role,
        hasProfile: Boolean(profile),
        coverPeriodsToday: used.dailyPeriods,
        coverPeriodsThisWeek: used.weeklyPeriods,
        dailyPeriodsLeft: capState.dailyPeriodsLeft,
        weeklyPeriodsLeft: capState.weeklyPeriodsLeft,
        dailyMinutesLeft: capState.dailyMinutesLeft,
        weeklyMinutesLeft: capState.weeklyMinutesLeft,
      };

      if (clash) {
        busy.push({
          ...entry,
          reason:
            clash.kind === 'absent'
              ? `Absent themself (${clash.label})`
              : `Already covering ${clash.label} at ${clash.startTime}`,
        });
        continue;
      }

      if (hard.length) {
        blocked.push({
          ...entry,
          // Hard means hard: no override offered, so no button is drawn.
          overridable: false,
          reasons: hard.map((reason) =>
            reason.confidential && !isAdmin(req.user)
              ? 'Excluded from cover on a recorded adjustment'
              : reason.message
          ),
        });
        continue;
      }

      if (capState.exceeded.length) {
        blocked.push({
          ...entry,
          overridable: true,
          reasons: capState.exceeded.map((cap) => cap.message),
        });
        continue;
      }

      available.push(entry);
    }

    /**
     * Sorted by what is left rather than by what has been done today, so the
     * ordering means what the old comment already claimed. A part-timer with
     * one period left is offered after a full-timer with six.
     */
    available.sort(
      (a, b) =>
        b.weeklyPeriodsLeft - a.weeklyPeriodsLeft ||
        b.dailyPeriodsLeft - a.dailyPeriodsLeft ||
        a.name.localeCompare(b.name)
    );

    blocked.sort((a, b) => a.name.localeCompare(b.name));

    return res.status(200).json({
      success: true,
      date,
      window: { startTime, endTime },
      count: available.length,
      data: available,
      blocked,
      busy,
    });
  } catch (err) {
    return handleError(res, err, 'Could not work out who is eligible');
  }
};

/**
 * GET /availability/check?staffId&date&startTime&endTime
 *
 * One person, one window, answered as reasons. Used by the panel before it
 * offers an override box, so the box only appears where an override is legal.
 */
exports.check = async (req, res) => {
  try {
    const { staffId, date, startTime, endTime } = req.query;

    if (!isValidId(staffId)) return fail(res, 400, 'Invalid staff id.');
    if (!DATE_PATTERN.test(date || '')) return fail(res, 400, 'date must be YYYY-MM-DD.');

    const startMinute = StaffAbsence.toMinutes(startTime);
    const endMinute = StaffAbsence.toMinutes(endTime);
    if (startMinute === null || endMinute === null || endMinute <= startMinute) {
      return fail(res, 400, 'startTime and endTime (HH:MM) are required, and must be in order.');
    }

    const person = await User.findById(staffId).select('name role');
    if (!person) return fail(res, 404, 'That staff member does not exist.');

    const decision = await decideFor(staffId, date, { startMinute, endMinute });

    return res.status(200).json({
      success: true,
      data: {
        staff: person._id,
        name: person.name,
        date,
        hasProfile: decision.hasProfile,
        allowed: !decision.blocked && !decision.overCap,
        blocked: decision.blocked,
        overridable: !decision.blocked && decision.overCap,
        reasons: [
          ...decision.hard.map((reason) =>
            reason.confidential && !isAdmin(req.user)
              ? 'Excluded from cover on a recorded adjustment'
              : reason.message
          ),
          ...decision.caps.exceeded.map((cap) => cap.message),
        ],
        caps: decision.caps,
        week: decision.used.week,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not check that assignment');
  }
};

/**
 * GET /availability/load?date
 *
 * The whole staff for one week, in one table. This is the report that answers
 * "who is carrying cover", which is currently a question with no answer.
 */
exports.getLoad = async (req, res) => {
  try {
    const dateKey = DATE_PATTERN.test(req.query.date || '')
      ? req.query.date
      : CoverAvailability.todayKey();

    const week = CoverAvailability.weekBoundsOf(dateKey);
    if (!week) return fail(res, 400, 'date must be YYYY-MM-DD.');

    const staff = await User.find({ role: { $in: ['teacher', 'admin'] } })
      .select('name role')
      .sort({ name: 1 })
      .limit(300);

    const profiles = await CoverAvailability.find({});
    const byStaff = new Map(profiles.map((profile) => [String(profile.staff), profile]));

    const rows = [];

    for (const person of staff) {
      const used = await usageFor(person._id, dateKey);
      const profile = byStaff.get(String(person._id)) || null;

      // Somebody who has never covered and has no profile is not interesting,
      // and 300 rows of zeroes is how a useful report gets ignored.
      if (!used.weeklyPeriods && !profile) continue;

      const capState = (profile || new CoverAvailability({ staff: person._id })).capStateFor({
        ...used,
        candidateMinutes: 0,
      });

      rows.push({
        staff: person._id,
        name: person.name,
        hasProfile: Boolean(profile),
        contractFraction: profile ? profile.contractFraction : 1,
        periodsThisWeek: used.weeklyPeriods,
        minutesThisWeek: used.weeklyMinutes,
        periodsToday: used.dailyPeriods,
        weeklyPeriodsCap: capState.weeklyPeriodsCap,
        weeklyPeriodsLeft: capState.weeklyPeriodsLeft,
        atCap: capState.weeklyPeriodsLeft === 0,
        optedOut: Boolean(profile && profile.optOutOn(dateKey)),
        overridesThisTerm: profile
          ? profile.overrides.filter((entry) => entry.date >= week.from).length
          : 0,
      });
    }

    rows.sort((a, b) => b.minutesThisWeek - a.minutesThisWeek || a.name.localeCompare(b.name));

    return res.status(200).json({
      success: true,
      data: {
        week,
        date: dateKey,
        totalPeriods: rows.reduce((sum, row) => sum + row.periodsThisWeek, 0),
        totalMinutes: rows.reduce((sum, row) => sum + row.minutesThisWeek, 0),
        atCapCount: rows.filter((row) => row.atCap).length,
        rows,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not build the load report');
  }
};

// ---------------------------------------------------------------------------
// Profile administration
// ---------------------------------------------------------------------------

exports.listProfiles = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = {};

    if (req.query.status) filter.status = req.query.status;

    const [profiles, total] = await Promise.all([
      CoverAvailability.find(filter).sort({ staffName: 1 }).skip(skip).limit(limit),
      CoverAvailability.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      count: profiles.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      data: profiles.map((profile) => profile.redactFor(req.user)),
    });
  } catch (err) {
    return handleError(res, err, 'Could not list availability profiles');
  }
};

exports.createProfile = async (req, res) => {
  try {
    const { staffId } = req.params;
    if (!isValidId(staffId)) return fail(res, 400, 'Invalid staff id.');

    const person = await User.findById(staffId).select('name role');
    if (!person) return fail(res, 404, 'That staff member does not exist.');
    if (!['teacher', 'admin'].includes(person.role)) {
      return fail(res, 400, 'Only teaching staff have a cover availability profile.');
    }

    const existing = await CoverAvailability.forStaff(staffId);
    if (existing) {
      return fail(res, 409, `${person.name} already has an availability profile.`);
    }

    const profile = new CoverAvailability({
      staff: person._id,
      staffName: person.name,
      contractFraction: req.body.contractFraction || 1,
      dailyCapPeriods: req.body.dailyCapPeriods || 0,
      weeklyCapPeriods: req.body.weeklyCapPeriods || 0,
      dailyCapMinutes: req.body.dailyCapMinutes || 0,
      weeklyCapMinutes: req.body.weeklyCapMinutes || 0,
      note: req.body.note || '',
    });

    profile.log('created', req.user);
    await profile.save();

    return res.status(201).json({
      success: true,
      message: `Availability profile created for ${person.name}.`,
      data: profile.redactFor(req.user),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'ValidationError') {
      return fail(res, 400, Object.values(err.errors)[0].message);
    }
    return handleError(res, err, 'Could not create the profile');
  }
};

exports.getProfile = async (req, res) => {
  try {
    const { staffId } = req.params;
    if (!isValidId(staffId)) return fail(res, 400, 'Invalid staff id.');

    const profile = await CoverAvailability.forStaff(staffId);
    if (!profile) {
      // Not an error. It means "full-time, uncapped by anything stated", and
      // the caller has to be able to tell that from a lookup failure.
      return res.status(200).json({ success: true, hasProfile: false, data: null });
    }

    return res.status(200).json({
      success: true,
      hasProfile: true,
      data: profile.redactFor(req.user),
    });
  } catch (err) {
    return handleError(res, err, 'Could not load that profile');
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const { staffId } = req.params;
    if (!isValidId(staffId)) return fail(res, 400, 'Invalid staff id.');

    const profile = await CoverAvailability.forStaff(staffId);
    if (!profile) return fail(res, 404, 'No availability profile for that person.');

    const fields = [
      'contractFraction',
      'dailyCapPeriods',
      'weeklyCapPeriods',
      'dailyCapMinutes',
      'weeklyCapMinutes',
      'note',
    ];

    const changed = [];
    fields.forEach((field) => {
      if (req.body[field] === undefined) return;
      if (profile[field] === req.body[field]) return;
      profile[field] = req.body[field];
      changed.push(field);
    });

    if (!changed.length) {
      return fail(res, 400, 'Nothing to change.');
    }

    profile.log('updated', req.user, changed.join(', '));
    await profile.save();

    return res.status(200).json({
      success: true,
      message: 'Profile updated.',
      data: profile.redactFor(req.user),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'ValidationError') {
      return fail(res, 400, Object.values(err.errors)[0].message);
    }
    return handleError(res, err, 'Could not update the profile');
  }
};

exports.setStatus = async (req, res) => {
  try {
    const { staffId } = req.params;
    const { status, reason = '' } = req.body;

    if (!isValidId(staffId)) return fail(res, 400, 'Invalid staff id.');
    if (!CoverAvailability.PROFILE_STATUSES.includes(status)) {
      return fail(res, 400, 'Invalid status.');
    }

    const profile = await CoverAvailability.forStaff(staffId);
    if (!profile) return fail(res, 404, 'No availability profile for that person.');

    if (status === 'suspended' && !reason.trim()) {
      return fail(res, 400, 'Removing somebody from the cover pool needs a reason.');
    }

    profile.status = status;
    profile.log(status === 'suspended' ? 'suspended' : 'reinstated', req.user, reason);
    await profile.save();

    return res.status(200).json({
      success: true,
      message:
        status === 'suspended'
          ? `${profile.staffName} is out of the cover pool.`
          : `${profile.staffName} is back in the cover pool.`,
      data: profile.redactFor(req.user),
    });
  } catch (err) {
    return handleError(res, err, 'Could not change the profile status');
  }
};

// ---------------------------------------------------------------------------
// Weekly pattern
// ---------------------------------------------------------------------------

exports.addBlock = async (req, res) => {
  try {
    const { staffId } = req.params;
    const { dayOfWeek, startTime, endTime, label = '', reason = 'part-time-contract' } = req.body;

    if (!isValidId(staffId)) return fail(res, 400, 'Invalid staff id.');

    const startMinute = StaffAbsence.toMinutes(startTime);
    const endMinute = StaffAbsence.toMinutes(endTime);
    if (startMinute === null || endMinute === null) {
      return fail(res, 400, 'startTime and endTime must be HH:MM.');
    }
    if (endMinute <= startMinute) {
      return fail(res, 400, 'endTime must be after startTime.');
    }

    const day = Number(dayOfWeek);
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      return fail(res, 400, 'dayOfWeek must be 0 (Sunday) to 6 (Saturday).');
    }

    const profile = await CoverAvailability.forStaff(staffId);
    if (!profile) return fail(res, 404, 'No availability profile for that person.');

    profile.weeklyBlocks.push({
      dayOfWeek: day,
      startMinute,
      endMinute,
      label,
      reason,
      addedBy: req.user._id,
    });

    profile.log(
      'block-added',
      req.user,
      `${CoverAvailability.DAY_NAMES[day]} ${startTime}-${endTime}`
    );
    await profile.save();

    return res.status(201).json({
      success: true,
      message: `${profile.staffName} is not available ${CoverAvailability.DAY_NAMES[day]} ${startTime}–${endTime}.`,
      data: profile.redactFor(req.user),
    });
  } catch (err) {
    if (err instanceof Error && !err.name.includes('Mongo')) {
      return fail(res, 400, err.message);
    }
    return handleError(res, err, 'Could not add the block');
  }
};

exports.removeBlock = async (req, res) => {
  try {
    const { staffId, blockId } = req.params;
    if (!isValidId(staffId) || !isValidId(blockId)) {
      return fail(res, 400, 'Invalid staff or block id.');
    }

    const profile = await CoverAvailability.forStaff(staffId);
    if (!profile) return fail(res, 404, 'No availability profile for that person.');

    const block = profile.weeklyBlocks.id(blockId);
    if (!block) return fail(res, 404, 'That block is not on this profile.');

    block.deleteOne();
    profile.log('block-removed', req.user);
    await profile.save();

    return res.status(200).json({
      success: true,
      message: 'Block removed.',
      data: profile.redactFor(req.user),
    });
  } catch (err) {
    return handleError(res, err, 'Could not remove the block');
  }
};

// ---------------------------------------------------------------------------
// Dated exclusions
// ---------------------------------------------------------------------------

exports.addExclusion = async (req, res) => {
  try {
    const { staffId } = req.params;
    const { fromDate, toDate, startTime, endTime, reason, note = '' } = req.body;

    if (!isValidId(staffId)) return fail(res, 400, 'Invalid staff id.');
    if (!DATE_PATTERN.test(fromDate || '') || !DATE_PATTERN.test(toDate || '')) {
      return fail(res, 400, 'fromDate and toDate must be YYYY-MM-DD.');
    }
    if (!CoverAvailability.EXCLUSION_REASONS.includes(reason)) {
      return fail(res, 400, 'An exclusion needs a valid reason.');
    }

    // Part-day is optional, but half of it is not.
    const startMinute = startTime ? StaffAbsence.toMinutes(startTime) : null;
    const endMinute = endTime ? StaffAbsence.toMinutes(endTime) : null;
    if ((startTime && startMinute === null) || (endTime && endMinute === null)) {
      return fail(res, 400, 'startTime and endTime must be HH:MM when given.');
    }
    if ((startMinute === null) !== (endMinute === null)) {
      return fail(res, 400, 'A part-day exclusion needs both a start and an end.');
    }

    const profile = await CoverAvailability.forStaff(staffId);
    if (!profile) return fail(res, 404, 'No availability profile for that person.');

    profile.exclusions.push({
      fromDate,
      toDate,
      startMinute,
      endMinute,
      reason,
      note,
      addedBy: req.user._id,
      addedByName: req.user.name,
    });

    profile.log('exclusion-added', req.user, `${fromDate} to ${toDate} (${reason})`);
    await profile.save();

    return res.status(201).json({
      success: true,
      message: `${profile.staffName} is excluded from cover ${fromDate} to ${toDate}.`,
      data: profile.redactFor(req.user),
    });
  } catch (err) {
    if (err instanceof Error && !err.name.includes('Mongo')) {
      return fail(res, 400, err.message);
    }
    return handleError(res, err, 'Could not add the exclusion');
  }
};

exports.removeExclusion = async (req, res) => {
  try {
    const { staffId, exclusionId } = req.params;
    if (!isValidId(staffId) || !isValidId(exclusionId)) {
      return fail(res, 400, 'Invalid staff or exclusion id.');
    }

    const profile = await CoverAvailability.forStaff(staffId);
    if (!profile) return fail(res, 404, 'No availability profile for that person.');

    const exclusion = profile.exclusions.id(exclusionId);
    if (!exclusion) return fail(res, 404, 'That exclusion is not on this profile.');

    exclusion.deleteOne();
    profile.log('exclusion-removed', req.user);
    await profile.save();

    return res.status(200).json({
      success: true,
      message: 'Exclusion removed.',
      data: profile.redactFor(req.user),
    });
  } catch (err) {
    return handleError(res, err, 'Could not remove the exclusion');
  }
};

// Exported for `substitutionController.assignCover`, so the rule is enforced
// where the write happens rather than only where the button is.
exports.assertAssignable = assertAssignable;
exports.usageFor = usageFor;
exports.decideFor = decideFor;
