const mongoose = require('mongoose');

/**
 * Who may be asked to cover, and how much.
 *
 * `substitutionController` decides availability from one fact: does this person
 * already have something in the diary at that time. That is a timetable check.
 * It is not an availability check, and the gap between the two is where cover
 * actually goes wrong — a 0.6 contract who is not in the building on Fridays
 * has no clash on a Friday, so the board offers them first.
 *
 * This file holds the rest of what a school knows: the contractual pattern,
 * dated adjustments, a ceiling on load, and a teacher's own temporary no.
 *
 * The property it is built around is that **capacity is measured against the
 * assignments that actually exist**. Nothing is incremented on assignment and
 * nothing is decremented on release, because a stored counter survives exactly
 * until the first `releaseCover` and is a fiction afterwards — one that locks
 * somebody out of cover they are not doing.
 *
 * The second property is that hard blocks and soft caps are different kinds of
 * thing. A weekly block, a live exclusion and a live opt-out mean the person is
 * not there, is restricted, or has said no; an admin cannot override any of
 * them. A cap exists to spread load, and on a genuinely short morning the
 * office must be able to exceed it — so it may, with a reason, and the reason
 * is kept where the pattern is visible next term.
 */

const PROFILE_STATUSES = ['active', 'suspended'];

// Why somebody is not in school at a given time. Kept as a closed list so the
// staff-facing view can redact the medical ones without parsing free text.
const BLOCK_REASONS = [
  'part-time-contract',
  'ppa-time',
  'management-time',
  'external-commitment',
  'other',
];

const EXCLUSION_REASONS = [
  'phased-return',
  'medical-restriction',
  'exam-board-duty',
  'training',
  'safeguarding',
  'other',
];

// Reasons a profile carries that are nobody else's business. A cover board is
// not the place to publish that a colleague is on a phased return.
const CONFIDENTIAL_REASONS = ['medical-restriction', 'phased-return', 'safeguarding'];

const OPT_OUT_REASONS = ['workload', 'personal', 'bereavement', 'study', 'other'];

// School defaults. They live here rather than in a request body for the obvious
// reason: a cap in a payload is a cap somebody can choose.
const DEFAULT_DAILY_CAP_PERIODS = 3;
const DEFAULT_WEEKLY_CAP_PERIODS = 8;
const DEFAULT_DAILY_CAP_MINUTES = 180;
const DEFAULT_WEEKLY_CAP_MINUTES = 480;

// An unbounded opt-out is a resignation from cover, which is not a thing one
// person decides alone. A fortnight is.
const MAX_OPT_OUT_DAYS = 14;

// An exclusion with no end date is how a temporary arrangement becomes a
// forgotten one. A permanent adjustment belongs in the weekly pattern.
const MAX_EXCLUSION_DAYS = 400;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const toDate = (dateKey) => {
  if (!DATE_PATTERN.test(dateKey || '')) return null;
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
};

const toKey = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const dayOfWeekOf = (dateKey) => {
  const date = toDate(dateKey);
  return date ? date.getDay() : null;
};

/**
 * The Monday-to-Sunday week containing a date, as two date keys.
 *
 * Derived from the date being covered, never from today, so assigning next
 * Thursday's cover is measured against next week rather than this one.
 */
const weekBoundsOf = (dateKey) => {
  const date = toDate(dateKey);
  if (!date) return null;

  // getDay() is Sunday-first; the school week is not.
  const offset = (date.getDay() + 6) % 7;
  const monday = new Date(date);
  monday.setDate(date.getDate() - offset);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  return { from: toKey(monday), to: toKey(sunday) };
};

const daysBetween = (fromKey, toKey_) => {
  const from = toDate(fromKey);
  const to = toDate(toKey_);
  if (!from || !to) return null;
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
};

const overlaps = (a, b) => a.startMinute < b.endMinute && b.startMinute < a.endMinute;

const formatMinute = (minute) => {
  const safe = Math.max(0, Math.min(1440, Number(minute) || 0));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
};

const historyEntrySchema = new mongoose.Schema(
  {
    action: { type: String, required: true, trim: true, maxlength: [40, 'Too long'] },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },
    at: { type: Date, default: Date.now },
    note: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },
  },
  { _id: false }
);

/**
 * A recurring part of the week this person is not in school.
 *
 * The contractual pattern. Set by an admin, because it is a term of employment
 * rather than a preference.
 */
const weeklyBlockSchema = new mongoose.Schema(
  {
    dayOfWeek: {
      type: Number,
      required: [true, 'A block needs a day'],
      min: [0, 'Day must be 0-6'],
      max: [6, 'Day must be 0-6'],
    },
    startMinute: {
      type: Number,
      required: [true, 'A block needs a start'],
      min: [0, 'Start must be within the day'],
      max: [1439, 'Start must be within the day'],
    },
    endMinute: {
      type: Number,
      required: [true, 'A block needs an end'],
      min: [1, 'End must be within the day'],
      max: [1440, 'End must be within the day'],
    },
    label: { type: String, trim: true, maxlength: [60, 'Too long'], default: '' },
    reason: {
      type: String,
      enum: { values: BLOCK_REASONS, message: 'Invalid block reason' },
      default: 'part-time-contract',
    },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

/**
 * A dated adjustment: a phased return, restricted duties, an exam-board week.
 *
 * Always has an end date. `MAX_EXCLUSION_DAYS` is not a policy about how long
 * somebody may be adjusted for; it is a policy about how long an adjustment may
 * sit unreviewed.
 */
const exclusionSchema = new mongoose.Schema(
  {
    fromDate: {
      type: String,
      required: [true, 'An exclusion needs a start date'],
      match: [DATE_PATTERN, 'Date must be in YYYY-MM-DD format'],
    },
    toDate: {
      type: String,
      required: [true, 'An exclusion needs an end date'],
      match: [DATE_PATTERN, 'Date must be in YYYY-MM-DD format'],
    },
    // Null on both means the whole day.
    startMinute: { type: Number, default: null, min: 0, max: 1439 },
    endMinute: { type: Number, default: null, min: 1, max: 1440 },
    reason: {
      type: String,
      enum: { values: EXCLUSION_REASONS, message: 'Invalid exclusion reason' },
      required: [true, 'An exclusion needs a reason'],
    },
    note: { type: String, trim: true, maxlength: [300, 'Too long'], default: '' },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    addedByName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

/**
 * Every time an admin assigned past a soft cap.
 *
 * Not a warning log — a record. One override on a snowy Tuesday is a school
 * working; the same name eleven times in a term is a staffing problem that
 * nobody would otherwise see.
 */
const overrideSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, match: [DATE_PATTERN, 'Invalid date'] },
    periodLabel: { type: String, trim: true, maxlength: [40, 'Too long'], default: '' },
    capExceeded: { type: String, trim: true, maxlength: [40, 'Too long'], default: '' },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },
    at: { type: Date, default: Date.now },
    reason: { type: String, trim: true, required: true, maxlength: [400, 'Too long'] },
  },
  { _id: true }
);

const optOutSchema = new mongoose.Schema(
  {
    untilDate: { type: String, default: null, match: [DATE_PATTERN, 'Invalid date'] },
    reason: {
      type: String,
      enum: { values: OPT_OUT_REASONS, message: 'Invalid opt-out reason' },
      default: null,
    },
    note: { type: String, trim: true, maxlength: [300, 'Too long'], default: '' },
    setAt: { type: Date, default: null },
  },
  { _id: false }
);

const coverAvailabilitySchema = new mongoose.Schema(
  {
    staff: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A profile must name a member of staff'],
      unique: true,
    },
    staffName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },

    /**
     * Informational. It is not used in the arithmetic — the weekly blocks are
     * what actually decide when somebody is in — but it is the number the
     * office recognises, and a profile whose blocks disagree with it is worth
     * looking at.
     */
    contractFraction: {
      type: Number,
      default: 1,
      min: [0.1, 'A contract fraction below 0.1 is not a contract'],
      max: [1, 'A contract fraction cannot exceed 1'],
    },

    weeklyBlocks: { type: [weeklyBlockSchema], default: [] },
    exclusions: { type: [exclusionSchema], default: [] },

    /**
     * Ceilings. Zero means "use the school default", so a profile created to
     * record a working pattern does not silently also uncap that person.
     */
    dailyCapPeriods: { type: Number, default: 0, min: 0, max: 12 },
    weeklyCapPeriods: { type: Number, default: 0, min: 0, max: 40 },
    dailyCapMinutes: { type: Number, default: 0, min: 0, max: 720 },
    weeklyCapMinutes: { type: Number, default: 0, min: 0, max: 2400 },

    optOut: { type: optOutSchema, default: () => ({}) },

    overrides: { type: [overrideSchema], default: [] },

    status: {
      type: String,
      enum: { values: PROFILE_STATUSES, message: 'Invalid profile status' },
      default: 'active',
    },

    note: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true }
);

coverAvailabilitySchema.index({ status: 1, staffName: 1 });
coverAvailabilitySchema.index({ 'exclusions.toDate': 1 });

coverAvailabilitySchema.pre('save', function guardProfile() {
  for (const block of this.weeklyBlocks) {
    if (block.endMinute <= block.startMinute) {
      throw new Error('A weekly block must end after it starts');
    }
  }

  for (const exclusion of this.exclusions) {
    if (exclusion.toDate < exclusion.fromDate) {
      throw new Error('An exclusion must end on or after the day it starts');
    }

    const span = daysBetween(exclusion.fromDate, exclusion.toDate);
    if (span !== null && span > MAX_EXCLUSION_DAYS) {
      throw new Error(
        `An exclusion cannot run longer than ${MAX_EXCLUSION_DAYS} days; a permanent adjustment belongs in the weekly pattern`
      );
    }

    const partial = exclusion.startMinute !== null || exclusion.endMinute !== null;
    if (partial && (exclusion.startMinute === null || exclusion.endMinute === null)) {
      throw new Error('A part-day exclusion needs both a start and an end');
    }
    if (partial && exclusion.endMinute <= exclusion.startMinute) {
      throw new Error('A part-day exclusion must end after it starts');
    }
  }

  if (this.optOut && this.optOut.untilDate) {
    if (!this.optOut.reason) {
      throw new Error('An opt-out needs a reason');
    }

    const span = daysBetween(toKey(new Date()), this.optOut.untilDate);
    if (span !== null && span > MAX_OPT_OUT_DAYS) {
      throw new Error(`An opt-out cannot run more than ${MAX_OPT_OUT_DAYS} days ahead`);
    }
  }
});

coverAvailabilitySchema.methods.log = function log(action, actor, note = '') {
  this.history.push({
    action,
    by: actor ? actor._id : undefined,
    byName: (actor && actor.name) || '',
    at: new Date(),
    note,
  });

  return this;
};

/**
 * The effective cap, falling back to the school default.
 *
 * Kept as one place so "zero means default" is decided once rather than at
 * every call site, which is where that kind of rule usually goes wrong.
 */
coverAvailabilitySchema.methods.caps = function caps() {
  return {
    dailyPeriods: this.dailyCapPeriods || DEFAULT_DAILY_CAP_PERIODS,
    weeklyPeriods: this.weeklyCapPeriods || DEFAULT_WEEKLY_CAP_PERIODS,
    dailyMinutes: this.dailyCapMinutes || DEFAULT_DAILY_CAP_MINUTES,
    weeklyMinutes: this.weeklyCapMinutes || DEFAULT_WEEKLY_CAP_MINUTES,
  };
};

/**
 * Is the opt-out live on this date?
 *
 * Compared as date keys rather than as Dates, because both are `YYYY-MM-DD`
 * and string comparison on that format is exactly date comparison, without a
 * timezone in the middle of it.
 */
coverAvailabilitySchema.methods.optOutOn = function optOutOn(dateKey) {
  if (!this.optOut || !this.optOut.untilDate) return null;
  if (dateKey > this.optOut.untilDate) return null;

  return {
    untilDate: this.optOut.untilDate,
    reason: this.optOut.reason,
    note: this.optOut.note,
  };
};

/**
 * The weekly blocks that cover a window on a date.
 */
coverAvailabilitySchema.methods.blocksAt = function blocksAt(dateKey, window) {
  const day = dayOfWeekOf(dateKey);
  if (day === null) return [];

  return this.weeklyBlocks.filter(
    (block) => block.dayOfWeek === day && (!window || overlaps(block, window))
  );
};

/**
 * The exclusions that cover a window on a date.
 *
 * A whole-day exclusion has null minutes and matches any window; a part-day one
 * has to actually overlap.
 */
coverAvailabilitySchema.methods.exclusionsAt = function exclusionsAt(dateKey, window) {
  return this.exclusions.filter((exclusion) => {
    if (dateKey < exclusion.fromDate || dateKey > exclusion.toDate) return false;
    if (exclusion.startMinute === null || exclusion.endMinute === null) return true;
    if (!window) return true;
    return overlaps(exclusion, window);
  });
};

/**
 * Everything hard that stops this person covering a window, as a list.
 *
 * A list rather than a boolean, because the board has to be able to say "over
 * the daily cap and not in school after 13:00" instead of "unavailable" — and
 * because the second reason is the one that stops somebody rescheduling.
 *
 * Soft caps are deliberately not in here. They are decided against live
 * assignment counts, which this document does not have and should not fetch.
 */
coverAvailabilitySchema.methods.hardBlocksFor = function hardBlocksFor(dateKey, window) {
  const reasons = [];

  if (this.status === 'suspended') {
    reasons.push({
      kind: 'suspended',
      confidential: false,
      message: 'Not currently in the cover pool',
    });
  }

  const optOut = this.optOutOn(dateKey);
  if (optOut) {
    reasons.push({
      kind: 'opt-out',
      confidential: false,
      message: `Opted out of cover until ${optOut.untilDate}`,
    });
  }

  this.blocksAt(dateKey, window).forEach((block) => {
    reasons.push({
      kind: 'weekly-block',
      confidential: false,
      message: `Not in school ${DAY_NAMES[block.dayOfWeek]} ${formatMinute(
        block.startMinute
      )}–${formatMinute(block.endMinute)}${block.label ? ` (${block.label})` : ''}`,
    });
  });

  this.exclusionsAt(dateKey, window).forEach((exclusion) => {
    reasons.push({
      kind: 'exclusion',
      confidential: CONFIDENTIAL_REASONS.includes(exclusion.reason),
      message: `Excluded from cover ${exclusion.fromDate} to ${exclusion.toDate}`,
      detail: exclusion.reason,
    });
  });

  return reasons;
};

/**
 * What a colleague may see.
 *
 * A profile carries medical adjustments. Somebody looking at the cover board
 * needs to know a person cannot be asked; they do not need to know why. Own
 * profile and admin see everything.
 */
coverAvailabilitySchema.methods.redactFor = function redactFor(viewer) {
  const isOwner = viewer && String(viewer._id) === String(this.staff);
  const isAdmin = viewer && viewer.role === 'admin';

  const plain = this.toObject();
  delete plain.__v;

  if (isOwner || isAdmin) return plain;

  return {
    _id: plain._id,
    staff: plain.staff,
    staffName: plain.staffName,
    status: plain.status,
    contractFraction: plain.contractFraction,
    // The shape of the week, without the reasons attached to it.
    weeklyBlocks: plain.weeklyBlocks.map((block) => ({
      _id: block._id,
      dayOfWeek: block.dayOfWeek,
      startMinute: block.startMinute,
      endMinute: block.endMinute,
    })),
    exclusionCount: plain.exclusions.length,
    optOut: plain.optOut && plain.optOut.untilDate ? { untilDate: plain.optOut.untilDate } : null,
    redacted: true,
  };
};

/**
 * Decide a cap against real usage.
 *
 * `used` comes from the caller, which counted it out of `StaffAbsence`. Keeping
 * the counting outside the model is deliberate: the model owns what the limits
 * are, and the controller owns where the truth about assignments lives.
 */
coverAvailabilitySchema.methods.capStateFor = function capStateFor(used) {
  const limits = this.caps();

  const state = {
    dailyPeriodsUsed: used.dailyPeriods,
    dailyPeriodsCap: limits.dailyPeriods,
    dailyPeriodsLeft: Math.max(0, limits.dailyPeriods - used.dailyPeriods),
    weeklyPeriodsUsed: used.weeklyPeriods,
    weeklyPeriodsCap: limits.weeklyPeriods,
    weeklyPeriodsLeft: Math.max(0, limits.weeklyPeriods - used.weeklyPeriods),
    dailyMinutesUsed: used.dailyMinutes,
    dailyMinutesCap: limits.dailyMinutes,
    dailyMinutesLeft: Math.max(0, limits.dailyMinutes - used.dailyMinutes),
    weeklyMinutesUsed: used.weeklyMinutes,
    weeklyMinutesCap: limits.weeklyMinutes,
    weeklyMinutesLeft: Math.max(0, limits.weeklyMinutes - used.weeklyMinutes),
    exceeded: [],
  };

  // Measured with the period being considered included, so the answer is "may
  // this assignment happen" rather than "has the cap already been breached".
  const extraMinutes = Math.max(0, Number(used.candidateMinutes) || 0);
  const extraPeriod = extraMinutes > 0 ? 1 : 0;

  if (used.dailyPeriods + extraPeriod > limits.dailyPeriods) {
    state.exceeded.push({
      cap: 'daily-periods',
      message: `Over the daily cover cap (${used.dailyPeriods + extraPeriod} of ${
        limits.dailyPeriods
      } periods)`,
    });
  }

  if (used.weeklyPeriods + extraPeriod > limits.weeklyPeriods) {
    state.exceeded.push({
      cap: 'weekly-periods',
      message: `Over the weekly cover cap (${used.weeklyPeriods + extraPeriod} of ${
        limits.weeklyPeriods
      } periods)`,
    });
  }

  if (used.dailyMinutes + extraMinutes > limits.dailyMinutes) {
    state.exceeded.push({
      cap: 'daily-minutes',
      message: `Over the daily cover cap (${used.dailyMinutes + extraMinutes} of ${
        limits.dailyMinutes
      } minutes)`,
    });
  }

  if (used.weeklyMinutes + extraMinutes > limits.weeklyMinutes) {
    state.exceeded.push({
      cap: 'weekly-minutes',
      message: `Over the weekly cover cap (${used.weeklyMinutes + extraMinutes} of ${
        limits.weeklyMinutes
      } minutes)`,
    });
  }

  return state;
};

coverAvailabilitySchema.methods.setOptOut = function setOptOut(actor, untilDate, reason, note) {
  if (!untilDate || !DATE_PATTERN.test(untilDate)) {
    throw new Error('An opt-out needs an end date in YYYY-MM-DD format');
  }

  const today = toKey(new Date());
  if (untilDate < today) {
    throw new Error('An opt-out cannot end in the past');
  }

  const span = daysBetween(today, untilDate);
  if (span !== null && span > MAX_OPT_OUT_DAYS) {
    throw new Error(
      `An opt-out cannot run more than ${MAX_OPT_OUT_DAYS} days ahead; ask the office for a dated exclusion instead`
    );
  }

  if (!OPT_OUT_REASONS.includes(reason)) {
    throw new Error('An opt-out needs a reason');
  }

  this.optOut = { untilDate, reason, note: note || '', setAt: new Date() };

  return this.log('opted-out', actor, `until ${untilDate} (${reason})`);
};

coverAvailabilitySchema.methods.clearOptOut = function clearOptOut(actor) {
  if (!this.optOut || !this.optOut.untilDate) {
    throw new Error('There is no opt-out to clear');
  }

  this.optOut = { untilDate: null, reason: null, note: '', setAt: null };

  return this.log('opt-out-cleared', actor);
};

coverAvailabilitySchema.methods.recordOverride = function recordOverride(entry) {
  if (!entry || !entry.reason || !String(entry.reason).trim()) {
    throw new Error('Assigning past a cap needs a reason');
  }

  this.overrides.push({
    date: entry.date,
    periodLabel: entry.periodLabel || '',
    capExceeded: entry.capExceeded || '',
    by: entry.by,
    byName: entry.byName || '',
    at: new Date(),
    reason: String(entry.reason).trim(),
  });

  return this;
};

/**
 * The profile for a person, or null.
 *
 * Null is a meaningful answer and every caller must handle it: staff without a
 * profile are full-time, uncapped-by-default and available. Introducing a model
 * must not empty the cover board on the day it ships.
 */
coverAvailabilitySchema.statics.forStaff = function forStaff(staffId) {
  return this.findOne({ staff: staffId });
};

coverAvailabilitySchema.statics.PROFILE_STATUSES = PROFILE_STATUSES;
coverAvailabilitySchema.statics.BLOCK_REASONS = BLOCK_REASONS;
coverAvailabilitySchema.statics.EXCLUSION_REASONS = EXCLUSION_REASONS;
coverAvailabilitySchema.statics.CONFIDENTIAL_REASONS = CONFIDENTIAL_REASONS;
coverAvailabilitySchema.statics.OPT_OUT_REASONS = OPT_OUT_REASONS;
coverAvailabilitySchema.statics.DEFAULT_DAILY_CAP_PERIODS = DEFAULT_DAILY_CAP_PERIODS;
coverAvailabilitySchema.statics.DEFAULT_WEEKLY_CAP_PERIODS = DEFAULT_WEEKLY_CAP_PERIODS;
coverAvailabilitySchema.statics.DEFAULT_DAILY_CAP_MINUTES = DEFAULT_DAILY_CAP_MINUTES;
coverAvailabilitySchema.statics.DEFAULT_WEEKLY_CAP_MINUTES = DEFAULT_WEEKLY_CAP_MINUTES;
coverAvailabilitySchema.statics.MAX_OPT_OUT_DAYS = MAX_OPT_OUT_DAYS;
coverAvailabilitySchema.statics.MAX_EXCLUSION_DAYS = MAX_EXCLUSION_DAYS;
coverAvailabilitySchema.statics.DAY_NAMES = DAY_NAMES;
coverAvailabilitySchema.statics.weekBoundsOf = weekBoundsOf;
coverAvailabilitySchema.statics.dayOfWeekOf = dayOfWeekOf;
coverAvailabilitySchema.statics.daysBetween = daysBetween;
coverAvailabilitySchema.statics.todayKey = () => toKey(new Date());
coverAvailabilitySchema.statics.formatMinute = formatMinute;

module.exports = mongoose.model('CoverAvailability', coverAvailabilitySchema);
