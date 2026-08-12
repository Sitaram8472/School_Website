const mongoose = require('mongoose');

/**
 * The academic calendar.
 *
 * `frontend/src/pages/EventCalendar.jsx` renders a calendar; nothing behind it
 * knows what a school term is. So nothing in this codebase can answer whether a
 * given date is a school day, which means attendance percentages are computed
 * over whatever rows happen to exist. A term with two snow days and a strike
 * has a smaller denominator than the term it is compared with, nobody adjusts
 * for it, and the comparison is made anyway.
 *
 * The whole model turns on one idea: **every date in the term is classified
 * exactly once, by a pure function of this document.** `classifyDay` resolves a
 * date through a fixed precedence and returns one bucket. `walk` runs it over
 * the term. Nothing is added to or subtracted from a running total, so there is
 * nothing to double-subtract — which removes the standing bug in every
 * hand-made version of this, where a holiday declared on a Sunday is taken off
 * a total that never counted Sundays.
 */

const TERM_NAMES = ['term-1', 'term-2', 'term-3', 'summer-session'];

const STATUSES = ['draft', 'published', 'archived'];

const EXCEPTION_KINDS = [
  'holiday', // closed, planned
  'closure', // closed, unplanned — tracked apart because make-up days answer these
  'working-day', // open despite the weekly pattern
  'exam-block', // open, instruction suspended
  'event', // open and instructing; calendar only
];

/**
 * How a date is finally classified. Exactly one of these applies to any date.
 *
 * `instructional` is the number attendance should be measured against.
 * `school-day` is open but not teaching, which is what an exam block is.
 */
const DAY_KINDS = ['instructional', 'school-day', 'weekly-off', 'holiday', 'closure'];

// Kinds that close the school. Precedence: these beat everything.
const CLOSING_KINDS = ['holiday', 'closure'];

/**
 * The statutory requirement is a figure for the **year**, not for a term.
 *
 * So a term's own `statutoryTarget` is whatever share of it the school has
 * chosen to apportion there, and defaults to 0 meaning "not apportioned" — the
 * alternative is a default of 190 on each of three terms, which sums to 570 and
 * reports every school year as catastrophically short.
 */
const ANNUAL_STATUTORY_TARGET = 190;
const DEFAULT_TERM_TARGET = 0;

const MAX_EXCEPTIONS = 400;
const MAX_TERM_DAYS = 400;

const exceptionSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      required: [true, 'An exception needs a date'],
    },
    // Inclusive. Half term is one row, not nine.
    endDate: {
      type: Date,
    },
    kind: {
      type: String,
      required: [true, 'An exception needs a kind'],
      enum: { values: EXCEPTION_KINDS, message: 'Invalid exception kind' },
    },
    title: {
      type: String,
      required: [true, 'An exception needs a title'],
      trim: true,
      maxlength: [120, 'Title cannot exceed 120 characters'],
    },
    note: {
      type: String,
      trim: true,
      maxlength: [500, 'Note cannot exceed 500 characters'],
    },
    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    addedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true, timestamps: false }
);

const historySchema = new mongoose.Schema(
  {
    action: { type: String, required: true, trim: true, maxlength: [40, 'Too long'] },
    note: { type: String, trim: true, maxlength: [500, 'Too long'] },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
  },
  { _id: true, timestamps: false }
);

const academicTermSchema = new mongoose.Schema(
  {
    session: {
      type: String,
      required: [true, 'A session is required'],
      trim: true,
      match: [/^\d{4}-\d{2}$/, 'Use the form 2026-27'],
    },
    name: {
      type: String,
      required: [true, 'A term name is required'],
      enum: { values: TERM_NAMES, message: 'Invalid term name' },
    },
    label: {
      type: String,
      trim: true,
      maxlength: [80, 'Label cannot exceed 80 characters'],
    },
    startDate: {
      type: Date,
      required: [true, 'A start date is required'],
    },
    endDate: {
      type: Date,
      required: [true, 'An end date is required'],
    },
    // Day indices as JavaScript uses them: 0 is Sunday.
    weeklyOffDays: {
      type: [Number],
      default: [0],
      validate: {
        validator: (v) => v.every((day) => Number.isInteger(day) && day >= 0 && day <= 6),
        message: 'Weekly off days are indices from 0 (Sunday) to 6 (Saturday)',
      },
    },
    exceptions: {
      type: [exceptionSchema],
      default: [],
      validate: {
        validator: (v) => v.length <= MAX_EXCEPTIONS,
        message: `A term cannot carry more than ${MAX_EXCEPTIONS} exceptions`,
      },
    },
    // This term's apportioned share of the annual requirement. 0 means the
    // school has not apportioned one, and no shortfall is reported for it.
    statutoryTarget: {
      type: Number,
      default: DEFAULT_TERM_TARGET,
      min: [0, 'A statutory target cannot be negative'],
      max: [366, 'A statutory target cannot exceed 366'],
    },
    status: {
      type: String,
      enum: { values: STATUSES, message: 'Invalid status' },
      default: 'draft',
    },
    history: {
      type: [historySchema],
      default: [],
    },
  },
  { timestamps: true }
);

academicTermSchema.index({ session: 1, startDate: 1 });
academicTermSchema.index({ status: 1, startDate: 1 });
academicTermSchema.index({ startDate: 1, endDate: 1 });

/** Midnight UTC on the day containing `value`. Every date here is a whole day. */
function toDayStart(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

/** The `YYYY-MM-DD` key for a date, used for comparison and grouping. */
function toDayKey(value) {
  const date = toDayStart(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

academicTermSchema.pre('validate', function derive() {
  if (this.startDate) this.startDate = toDayStart(this.startDate);
  if (this.endDate) this.endDate = toDayStart(this.endDate);

  if (this.startDate && this.endDate && this.endDate < this.startDate) {
    this.invalidate('endDate', 'A term cannot end before it starts');
  }

  if (this.startDate && this.endDate) {
    const span = Math.round((this.endDate - this.startDate) / 86400000) + 1;
    if (span > MAX_TERM_DAYS) {
      this.invalidate('endDate', `A term cannot run longer than ${MAX_TERM_DAYS} days`);
    }
  }

  // Every weekly off day, all seven of them, means a term with no school in it.
  if ((this.weeklyOffDays || []).length >= 7) {
    this.invalidate('weeklyOffDays', 'A term cannot have every day of the week off');
  }

  for (const exception of this.exceptions || []) {
    exception.date = toDayStart(exception.date);
    if (exception.endDate) exception.endDate = toDayStart(exception.endDate);

    if (exception.endDate && exception.endDate < exception.date) {
      this.invalidate('exceptions', `"${exception.title}" ends before it starts`);
    }

    // An exception outside its term is a typo, every time, and today it
    // silently does nothing at all.
    if (this.startDate && this.endDate) {
      const last = exception.endDate || exception.date;
      if (exception.date < this.startDate || last > this.endDate) {
        this.invalidate(
          'exceptions',
          `"${exception.title}" falls outside the term it is attached to`
        );
      }
    }
  }
});

/**
 * Where an exception sits in the resolution order. Higher wins.
 *
 * Precedence rather than insertion order, so the classification of a date does
 * not depend on which admin typed which row first.
 */
const KIND_PRECEDENCE = {
  event: 1,
  'exam-block': 2,
  'working-day': 3,
  holiday: 4,
  closure: 5,
};

/** Every exception covering `dayKey`, strongest first. */
academicTermSchema.methods.exceptionsOn = function exceptionsOn(dayKey) {
  const matches = [];
  for (const exception of this.exceptions || []) {
    const from = toDayKey(exception.date);
    const to = exception.endDate ? toDayKey(exception.endDate) : from;
    if (dayKey >= from && dayKey <= to) matches.push(exception);
  }
  return matches.sort(
    (a, b) => (KIND_PRECEDENCE[b.kind] || 0) - (KIND_PRECEDENCE[a.kind] || 0)
  );
};

/**
 * The classification of one date. The function the whole module rests on.
 *
 * Returns exactly one bucket, plus the reason, so the calendar can say *why*
 * the 14th is closed rather than only that it is.
 */
academicTermSchema.methods.classifyDay = function classifyDay(value) {
  const date = toDayStart(value);
  if (!date) return null;

  const dayKey = toDayKey(date);
  const covering = this.exceptionsOn(dayKey);
  const weeklyOff = (this.weeklyOffDays || []).includes(date.getUTCDay());

  // Closed beats everything, planned or not.
  const closing = covering.find((exception) => CLOSING_KINDS.includes(exception.kind));
  if (closing) {
    return {
      date,
      dayKey,
      kind: closing.kind,
      // A holiday declared on a Sunday is still not an instructional day, and
      // was not one before either. Nothing is subtracted anywhere, so the
      // total does not move — which is the double-count bug, gone.
      instructional: false,
      open: false,
      reason: closing.title,
      exceptionKind: closing.kind,
      overridesWeeklyOff: weeklyOff,
    };
  }

  const working = covering.find((exception) => exception.kind === 'working-day');
  const examBlock = covering.find((exception) => exception.kind === 'exam-block');
  const event = covering.find((exception) => exception.kind === 'event');

  // A working day beats the weekly pattern. This is the make-up Saturday, and
  // it is the case a weekly pattern alone cannot express.
  if (weeklyOff && !working) {
    return {
      date,
      dayKey,
      kind: 'weekly-off',
      instructional: false,
      open: false,
      reason: 'Weekly closure',
      exceptionKind: null,
      overridesWeeklyOff: false,
    };
  }

  if (examBlock) {
    return {
      date,
      dayKey,
      kind: 'school-day',
      // Open, and not teaching. Counting an exam block as instruction is how a
      // term reports 190 days of teaching over a fortnight of exams.
      instructional: false,
      open: true,
      reason: examBlock.title,
      exceptionKind: 'exam-block',
      overridesWeeklyOff: Boolean(working),
    };
  }

  return {
    date,
    dayKey,
    kind: 'instructional',
    instructional: true,
    open: true,
    reason: working ? working.title : event ? event.title : null,
    exceptionKind: working ? 'working-day' : event ? 'event' : null,
    overridesWeeklyOff: Boolean(working && weeklyOff),
  };
};

/**
 * Every day of the term, classified. Optionally clipped to a range.
 */
academicTermSchema.methods.walk = function walk(from, to) {
  if (!this.startDate || !this.endDate) return [];

  const start = from ? toDayStart(from) : this.startDate;
  const end = to ? toDayStart(to) : this.endDate;
  if (!start || !end) return [];

  const first = start > this.startDate ? start : this.startDate;
  const last = end < this.endDate ? end : this.endDate;
  if (last < first) return [];

  const days = [];
  for (let cursor = first; cursor <= last; cursor = addDays(cursor, 1)) {
    days.push(this.classifyDay(cursor));
  }
  return days;
};

/**
 * The three numbers, derived. None of them is stored, so none of them is the
 * August figure still sitting there in March.
 */
academicTermSchema.methods.summary = function summary() {
  const days = this.walk();

  const counts = DAY_KINDS.reduce((acc, kind) => {
    acc[kind] = 0;
    return acc;
  }, {});

  const byMonth = new Map();

  for (const day of days) {
    counts[day.kind] += 1;

    const monthKey = day.dayKey.slice(0, 7);
    if (!byMonth.has(monthKey)) {
      byMonth.set(monthKey, { month: monthKey, instructional: 0, schoolDays: 0, closed: 0 });
    }
    const month = byMonth.get(monthKey);
    if (day.instructional) month.instructional += 1;
    if (day.open) month.schoolDays += 1;
    else month.closed += 1;
  }

  const instructionalDays = counts.instructional;
  const schoolDays = counts.instructional + counts['school-day'];
  const target = this.statutoryTarget || 0;

  // Days recovered by working days against days lost to unplanned closures —
  // the pair that decides whether another make-up Saturday is needed.
  let recovered = 0;
  for (const day of days) {
    if (day.overridesWeeklyOff && day.instructional) recovered += 1;
  }

  return {
    totalDays: days.length,
    instructionalDays,
    schoolDays,
    weeklyOffDays: counts['weekly-off'],
    holidays: counts.holiday,
    unplannedClosures: counts.closure,
    examBlockDays: counts['school-day'],
    recoveredByWorkingDays: recovered,
    statutoryTarget: target,
    // Null rather than 0 when no target is apportioned, so "on target" and
    // "nobody said" are distinguishable at the call site.
    shortfall: target ? Math.max(target - instructionalDays, 0) : null,
    surplus: target ? Math.max(instructionalDays - target, 0) : null,
    byMonth: Array.from(byMonth.values()),
  };
};

/** Instructional days between two dates, clipped to this term. */
academicTermSchema.methods.instructionalDaysBetween = function instructionalDaysBetween(from, to) {
  return this.walk(from, to).filter((day) => day.instructional).length;
};

academicTermSchema.methods.contains = function contains(value) {
  const date = toDayStart(value);
  if (!date || !this.startDate || !this.endDate) return false;
  return date >= this.startDate && date <= this.endDate;
};

/**
 * Whether this term's dates overlap `other`'s.
 *
 * Two terms claiming the same Tuesday makes every count ambiguous, so this is
 * checked on save against the rest of the session.
 */
academicTermSchema.methods.overlaps = function overlaps(other) {
  if (!other || !other.startDate || !other.endDate) return false;
  return this.startDate <= other.endDate && other.startDate <= this.endDate;
};

academicTermSchema.methods.recordHistory = function recordHistory(entry) {
  this.history.push({
    action: entry.action,
    note: entry.note,
    by: entry.by,
    at: new Date(),
  });
};

academicTermSchema.methods.toRow = function toRow() {
  return {
    _id: this._id,
    session: this.session,
    name: this.name,
    label: this.label || this.name,
    startDate: this.startDate,
    endDate: this.endDate,
    weeklyOffDays: this.weeklyOffDays,
    statutoryTarget: this.statutoryTarget,
    status: this.status,
    exceptionCount: (this.exceptions || []).length,
    summary: this.summary(),
    createdAt: this.createdAt,
  };
};

academicTermSchema.methods.toDetail = function toDetail() {
  return {
    ...this.toRow(),
    exceptions: (this.exceptions || [])
      .slice()
      .sort((a, b) => a.date - b.date)
      .map((exception) => ({
        _id: exception._id,
        date: exception.date,
        endDate: exception.endDate,
        kind: exception.kind,
        title: exception.title,
        note: exception.note,
        addedAt: exception.addedAt,
      })),
    history: this.history,
  };
};

academicTermSchema.statics.TERM_NAMES = TERM_NAMES;
academicTermSchema.statics.STATUSES = STATUSES;
academicTermSchema.statics.EXCEPTION_KINDS = EXCEPTION_KINDS;
academicTermSchema.statics.DAY_KINDS = DAY_KINDS;
academicTermSchema.statics.CLOSING_KINDS = CLOSING_KINDS;
academicTermSchema.statics.KIND_PRECEDENCE = KIND_PRECEDENCE;
academicTermSchema.statics.ANNUAL_STATUTORY_TARGET = ANNUAL_STATUTORY_TARGET;
academicTermSchema.statics.DEFAULT_TERM_TARGET = DEFAULT_TERM_TARGET;
academicTermSchema.statics.MAX_EXCEPTIONS = MAX_EXCEPTIONS;
academicTermSchema.statics.toDayStart = toDayStart;
academicTermSchema.statics.toDayKey = toDayKey;
academicTermSchema.statics.addDays = addDays;

module.exports = mongoose.model('AcademicTerm', academicTermSchema);
