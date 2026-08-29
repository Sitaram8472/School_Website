const mongoose = require('mongoose');

/**
 * Staff leave: entitlement, requests, and the balance between them.
 *
 * `StaffAbsence` already records that somebody is out and arranges cover for
 * the periods they leave behind. It deliberately says nothing about how much
 * leave that person is entitled to, and this file is the other half.
 *
 * Three things are derived here and never accepted from a client:
 *
 *   dayUnits is computed from the date range and the two half-day flags,
 *     skipping weekends and the school's non-working dates. The client sends
 *     dates; it never sends a number of days, because the number of days is
 *     precisely the thing a spreadsheet gets wrong — a Friday-to-Monday leave
 *     is two days, and a morning appointment is half of one.
 *
 *   The balance is an aggregation over approved requests, computed per read.
 *     A stored balance is wrong from the first cancellation onward and it is
 *     wrong quietly, which is the failure mode where a teacher is told in March
 *     that they have two days left when they have five and cannot argue.
 *
 *   Carry-over is min(remaining, carryCap), applied by closing a year. The rule
 *     lives in code so that April is arithmetic rather than a negotiation.
 *
 * Everything is stored in halves. A leave is 0.5, 1, 1.5 — there is no unit
 * smaller than half a day and no code path that rounds one away.
 */

const LEAVE_TYPES = [
  'casual',
  'sick',
  'earned',
  'maternity',
  'paternity',
  'bereavement',
  'unpaid',
  'study',
  'compensatory',
];

const REQUEST_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'cancelled',
  'withdrawn',
];

// A request in one of these states has been granted, so it counts against the
// balance. Nothing else does — a pending request is not a decision.
const CONSUMING_STATUSES = ['approved'];

// A request in one of these states may still be edited by the person who
// raised it.
const EDITABLE_STATUSES = ['draft', 'submitted'];

// A request in one of these states occupies the calendar, so a second
// overlapping request for the same person is refused.
const BLOCKING_STATUSES = ['submitted', 'approved'];

const HALF_DAY_MARKERS = ['full', 'morning', 'afternoon'];

// Leave of these types is unpaid or statutory and is not drawn from an annual
// allowance, so a shortfall never blocks the approval.
const UNMETERED_TYPES = ['unpaid', 'maternity', 'paternity', 'bereavement'];

// Sick leave longer than this many days needs a certificate reference. The rule
// lives here so that it is the same rule for everybody.
const CERTIFICATE_THRESHOLD_DAYS = 3;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_PATTERN = /^\d{4}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const MAX_LEAVE_SPAN_DAYS = 190;
const MAX_COVER_PERIODS = 40;
const MAX_ALLOWANCE_DAYS = 365;

// Sensible starting allowances, so a new entitlement row needs no input at all
// and an unusual one can still override every line.
const DEFAULT_ALLOWANCES = [
  { type: 'casual', days: 12, carryCap: 0 },
  { type: 'sick', days: 10, carryCap: 5 },
  { type: 'earned', days: 15, carryCap: 30 },
  { type: 'compensatory', days: 0, carryCap: 10 },
  { type: 'study', days: 5, carryCap: 0 },
];

/** Today in the server's local zone, as the YYYY-MM-DD key the model stores. */
function todayKey(now = new Date()) {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/** Whole days between two YYYY-MM-DD keys. Negative when `to` is in the past. */
function daysBetween(from, to) {
  const fromMs = Date.parse(`${from}T00:00:00`);
  const toMs = Date.parse(`${to}T00:00:00`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  return Math.round((toMs - fromMs) / 86400000);
}

/** The next YYYY-MM-DD key after this one. */
function nextDay(dateKey) {
  const ms = Date.parse(`${dateKey}T00:00:00`);
  if (!Number.isFinite(ms)) return null;
  return todayKey(new Date(ms + 86400000));
}

/** 0 = Sunday .. 6 = Saturday, for a YYYY-MM-DD key. */
function weekdayOf(dateKey) {
  const ms = Date.parse(`${dateKey}T00:00:00`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).getDay();
}

function isWeekend(dateKey) {
  const day = weekdayOf(dateKey);
  return day === 0 || day === 6;
}

/**
 * Every working date in an inclusive range, weekends and the supplied holiday
 * set removed. Bounded by MAX_LEAVE_SPAN_DAYS so a mistyped year cannot walk
 * the loop for a decade.
 */
function workingDatesBetween(startDate, endDate, holidays = []) {
  if (!DATE_PATTERN.test(startDate || '') || !DATE_PATTERN.test(endDate || '')) {
    return [];
  }
  const span = daysBetween(startDate, endDate);
  if (span === null || span < 0 || span > MAX_LEAVE_SPAN_DAYS) return [];

  const skip = new Set(holidays || []);
  const dates = [];
  let cursor = startDate;
  for (let i = 0; i <= span; i += 1) {
    if (!isWeekend(cursor) && !skip.has(cursor)) dates.push(cursor);
    cursor = nextDay(cursor);
    if (!cursor) break;
  }
  return dates;
}

/**
 * The cost of a leave in days, counted in halves.
 *
 * A single working day marked `morning` or `afternoon` is 0.5. A multi-day
 * leave loses half a day at each end that is not a full day. The half-day flags
 * only bite when the corresponding end is itself a working date — a leave that
 * starts on a Saturday morning starts, in fact, on the Monday.
 */
function computeDayUnits(startDate, endDate, startHalf, endHalf, holidays = []) {
  const dates = workingDatesBetween(startDate, endDate, holidays);
  if (dates.length === 0) return 0;

  let units = dates.length;

  const firstIsWorking = dates[0] === startDate;
  const lastIsWorking = dates[dates.length - 1] === endDate;

  if (dates.length === 1) {
    // One working date: either end's half-day flag halves it, and both flags
    // pointing at the same date still only halve it once.
    const halved =
      (firstIsWorking && startHalf && startHalf !== 'full') ||
      (lastIsWorking && endHalf && endHalf !== 'full');
    return halved ? 0.5 : 1;
  }

  if (firstIsWorking && startHalf === 'afternoon') units -= 0.5;
  if (lastIsWorking && endHalf === 'morning') units -= 0.5;

  return Math.max(units, 0.5);
}

/** Round to the nearest half, so no arithmetic here can produce 2.4999. */
function toHalves(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 2) / 2;
}

/**
 * Do two inclusive date ranges share a day? Used to refuse a second leave for
 * somebody who is already off — two approvals over the same dates mean two
 * cover requests and a substitute booked against a person who is not there.
 */
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

// ---------------------------------------------------------------------------
// Entitlement
// ---------------------------------------------------------------------------

const allowanceSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: [true, 'Leave type is required'],
      enum: {
        values: LEAVE_TYPES,
        message: 'Invalid leave type',
      },
    },
    days: {
      type: Number,
      required: [true, 'Allowance is required'],
      min: [0, 'An allowance cannot be negative'],
      max: [MAX_ALLOWANCE_DAYS, `An allowance cannot exceed ${MAX_ALLOWANCE_DAYS} days`],
    },
    // What arrived from last year. Written by closing the previous year, never
    // typed, because a carried figure that somebody typed is a figure nobody
    // can reproduce.
    carriedIn: {
      type: Number,
      default: 0,
      min: [0, 'Carried leave cannot be negative'],
    },
    carryCap: {
      type: Number,
      default: 0,
      min: [0, 'A carry cap cannot be negative'],
      max: [MAX_ALLOWANCE_DAYS, 'A carry cap cannot exceed a year'],
    },
  },
  { _id: false }
);

const entitlementHistorySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: [40, 'Action cannot exceed 40 characters'],
    },
    note: {
      type: String,
      trim: true,
      maxlength: [500, 'Note cannot exceed 500 characters'],
    },
    by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    at: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true, timestamps: false }
);

const leaveEntitlementSchema = new mongoose.Schema(
  {
    staff: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'An entitlement must belong to a member of staff'],
      index: true,
    },
    academicYear: {
      type: String,
      required: [true, 'Academic year is required'],
      trim: true,
      match: [YEAR_PATTERN, 'Academic year must look like 2026-27'],
    },
    allowances: {
      type: [allowanceSchema],
      default: () => DEFAULT_ALLOWANCES.map((a) => ({ ...a, carriedIn: 0 })),
    },
    // The mid-year joiner, the returned secondment, the negotiated exception.
    // Always with a reason, because an adjustment nobody can explain is
    // indistinguishable from a mistake.
    openingAdjustment: {
      type: Number,
      default: 0,
      min: [-MAX_ALLOWANCE_DAYS, 'Adjustment out of range'],
      max: [MAX_ALLOWANCE_DAYS, 'Adjustment out of range'],
    },
    adjustmentType: {
      type: String,
      enum: {
        values: LEAVE_TYPES,
        message: 'Invalid leave type',
      },
      default: 'casual',
    },
    adjustmentReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Reason cannot exceed 300 characters'],
      default: null,
    },
    // Dates on which the school is shut. Held per entitlement rather than
    // globally so a year can be corrected without rewriting history.
    nonWorkingDates: {
      type: [String],
      default: [],
      validate: {
        validator: (dates) => dates.every((d) => DATE_PATTERN.test(d)),
        message: 'Non-working dates must be in YYYY-MM-DD format',
      },
    },
    isClosed: {
      type: Boolean,
      default: false,
    },
    closedAt: {
      type: Date,
      default: null,
    },
    closedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    history: {
      type: [entitlementHistorySchema],
      default: [],
    },
  },
  { timestamps: true }
);

leaveEntitlementSchema.index({ staff: 1, academicYear: 1 }, { unique: true });
leaveEntitlementSchema.index({ academicYear: 1, isClosed: 1 });

leaveEntitlementSchema.pre('validate', function normalise() {
  if (this.openingAdjustment && !this.adjustmentReason) {
    this.invalidate('adjustmentReason', 'An opening adjustment needs a reason');
  }

  // One row per type. A duplicate would make the balance depend on which row
  // the lookup happened to find first.
  const seen = new Set();
  for (const allowance of this.allowances || []) {
    if (seen.has(allowance.type)) {
      this.invalidate('allowances', `Duplicate allowance for ${allowance.type}`);
    }
    seen.add(allowance.type);
    if (allowance.carriedIn > allowance.carryCap) {
      // Not an error — a cap can be lowered after leave was carried. Clamp so
      // the stored figure never exceeds the rule that is now in force.
      allowance.carriedIn = allowance.carryCap;
    }
  }

  if (this.nonWorkingDates && this.nonWorkingDates.length) {
    this.nonWorkingDates = [...new Set(this.nonWorkingDates)].sort();
  }
});

leaveEntitlementSchema.methods.allowanceFor = function allowanceFor(type) {
  return (this.allowances || []).find((a) => a.type === type) || null;
};

/** The gross entitlement for one type, before anything is taken. */
leaveEntitlementSchema.methods.grantedFor = function grantedFor(type) {
  const allowance = this.allowanceFor(type);
  if (!allowance) return 0;
  const adjustment = this.adjustmentType === type ? this.openingAdjustment || 0 : 0;
  return toHalves((allowance.days || 0) + (allowance.carriedIn || 0) + adjustment);
};

leaveEntitlementSchema.methods.recordHistory = function recordHistory(action, userId, note) {
  this.history.push({ action, by: userId, at: new Date(), note });
  if (this.history.length > 60) this.history = this.history.slice(-60);
};

/**
 * Fold approved and pending requests into a per-type ledger.
 *
 * Pending is reported as its own quantity and is never subtracted from the
 * remaining balance. A request that has not been decided is not leave that has
 * been taken, and mixing the two is how somebody is refused leave they have.
 */
leaveEntitlementSchema.methods.buildLedger = function buildLedger(requests = []) {
  const taken = {};
  const pending = {};

  for (const request of requests) {
    const units = request.dayUnits || 0;
    if (CONSUMING_STATUSES.includes(request.status)) {
      taken[request.type] = toHalves((taken[request.type] || 0) + units);
    } else if (request.status === 'submitted') {
      pending[request.type] = toHalves((pending[request.type] || 0) + units);
    }
  }

  const types = new Set([
    ...(this.allowances || []).map((a) => a.type),
    ...Object.keys(taken),
    ...Object.keys(pending),
  ]);

  const lines = [...types].map((type) => {
    const allowance = this.allowanceFor(type);
    const granted = this.grantedFor(type);
    const used = taken[type] || 0;
    const awaiting = pending[type] || 0;
    return {
      type,
      metered: !UNMETERED_TYPES.includes(type),
      days: allowance ? allowance.days : 0,
      carriedIn: allowance ? allowance.carriedIn : 0,
      carryCap: allowance ? allowance.carryCap : 0,
      granted,
      taken: used,
      pending: awaiting,
      remaining: toHalves(Math.max(granted - used, 0)),
      overdrawn: toHalves(Math.max(used - granted, 0)),
    };
  });

  lines.sort((a, b) => LEAVE_TYPES.indexOf(a.type) - LEAVE_TYPES.indexOf(b.type));

  return {
    academicYear: this.academicYear,
    isClosed: this.isClosed,
    openingAdjustment: this.openingAdjustment,
    adjustmentType: this.adjustmentType,
    adjustmentReason: this.adjustmentReason,
    lines,
    totals: {
      granted: toHalves(lines.reduce((sum, l) => sum + (l.metered ? l.granted : 0), 0)),
      taken: toHalves(lines.reduce((sum, l) => sum + l.taken, 0)),
      pending: toHalves(lines.reduce((sum, l) => sum + l.pending, 0)),
      remaining: toHalves(
        lines.reduce((sum, l) => sum + (l.metered ? l.remaining : 0), 0)
      ),
    },
  };
};

/**
 * What would carry into next year, capped per type. Returns the discarded
 * remainder as well, because the figure somebody loses is the figure they will
 * ask about.
 */
leaveEntitlementSchema.methods.computeCarryOver = function computeCarryOver(requests = []) {
  const ledger = this.buildLedger(requests);
  return ledger.lines
    .filter((line) => line.metered)
    .map((line) => {
      const carried = toHalves(Math.min(line.remaining, line.carryCap));
      return {
        type: line.type,
        remaining: line.remaining,
        carryCap: line.carryCap,
        carried,
        forfeited: toHalves(line.remaining - carried),
      };
    });
};

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const requestHistorySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: [40, 'Action cannot exceed 40 characters'],
    },
    note: {
      type: String,
      trim: true,
      maxlength: [500, 'Note cannot exceed 500 characters'],
    },
    by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    at: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true, timestamps: false }
);

/**
 * A lesson that will need covering, described once per weekday rather than once
 * per date. A fortnight's leave is five of these, not fifty, and the approval
 * expands them across the working days it actually falls on.
 *
 * The shape matches `StaffAbsence`'s cover period deliberately, so handing one
 * to the other is a copy rather than a translation.
 */
const coverPeriodTemplateSchema = new mongoose.Schema(
  {
    dayOfWeek: {
      type: Number,
      required: [true, 'A cover period needs a day of the week'],
      min: [0, 'Day of week must be 0 (Sunday) to 6 (Saturday)'],
      max: [6, 'Day of week must be 0 (Sunday) to 6 (Saturday)'],
    },
    periodLabel: {
      type: String,
      required: [true, 'Period label is required'],
      trim: true,
      maxlength: [30, 'Period label cannot exceed 30 characters'],
    },
    startTime: {
      type: String,
      required: [true, 'Period start time is required'],
      match: [TIME_PATTERN, 'Start time must be in HH:MM format'],
    },
    endTime: {
      type: String,
      required: [true, 'Period end time is required'],
      match: [TIME_PATTERN, 'End time must be in HH:MM format'],
    },
    className: {
      type: String,
      required: [true, 'Class name is required'],
      trim: true,
      maxlength: [40, 'Class name cannot exceed 40 characters'],
    },
    subject: {
      type: String,
      required: [true, 'Subject is required'],
      trim: true,
      maxlength: [60, 'Subject cannot exceed 60 characters'],
    },
    room: {
      type: String,
      trim: true,
      maxlength: [40, 'Room cannot exceed 40 characters'],
      default: null,
    },
    lessonPlan: {
      type: String,
      trim: true,
      maxlength: [1500, 'Lesson plan cannot exceed 1500 characters'],
      default: null,
    },
  },
  { _id: true }
);

const leaveRequestSchema = new mongoose.Schema(
  {
    staff: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A request must belong to a member of staff'],
      index: true,
    },
    staffName: {
      type: String,
      trim: true,
    },
    academicYear: {
      type: String,
      required: [true, 'Academic year is required'],
      trim: true,
      match: [YEAR_PATTERN, 'Academic year must look like 2026-27'],
    },
    type: {
      type: String,
      required: [true, 'Leave type is required'],
      enum: {
        values: LEAVE_TYPES,
        message: 'Invalid leave type',
      },
    },
    startDate: {
      type: String,
      required: [true, 'Start date is required'],
      match: [DATE_PATTERN, 'Start date must be in YYYY-MM-DD format'],
      index: true,
    },
    endDate: {
      type: String,
      required: [true, 'End date is required'],
      match: [DATE_PATTERN, 'End date must be in YYYY-MM-DD format'],
    },
    startHalf: {
      type: String,
      enum: {
        values: HALF_DAY_MARKERS,
        message: 'Invalid half-day marker',
      },
      default: 'full',
    },
    endHalf: {
      type: String,
      enum: {
        values: HALF_DAY_MARKERS,
        message: 'Invalid half-day marker',
      },
      default: 'full',
    },
    // Derived in the pre-validate hook from the dates, the half-day flags and
    // the working calendar. Never accepted from a client.
    dayUnits: {
      type: Number,
      default: 0,
      min: [0, 'A leave cannot be negative'],
    },
    workingDays: {
      type: [String],
      default: [],
    },
    reason: {
      type: String,
      required: [true, 'A reason is required'],
      trim: true,
      maxlength: [800, 'Reason cannot exceed 800 characters'],
    },
    contactDuringLeave: {
      type: String,
      trim: true,
      maxlength: [80, 'Contact cannot exceed 80 characters'],
      default: null,
    },
    medicalCertificateRef: {
      type: String,
      trim: true,
      maxlength: [120, 'Certificate reference cannot exceed 120 characters'],
      default: null,
    },
    status: {
      type: String,
      enum: {
        values: REQUEST_STATUSES,
        message: 'Invalid status',
      },
      default: 'draft',
      index: true,
    },
    submittedAt: {
      type: Date,
      default: null,
    },
    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    decidedAt: {
      type: Date,
      default: null,
    },
    decisionNote: {
      type: String,
      trim: true,
      maxlength: [500, 'Decision note cannot exceed 500 characters'],
      default: null,
    },
    coverRequired: {
      type: Boolean,
      default: false,
    },
    coverPeriods: {
      type: [coverPeriodTemplateSchema],
      default: [],
    },
    // The absences this leave created on approval, one per working day. Keeping
    // the ids means cancelling the leave can cancel the cover rather than
    // leaving a substitute booked for a lesson nobody is missing.
    linkedAbsences: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'StaffAbsence',
        },
      ],
      default: [],
    },
    history: {
      type: [requestHistorySchema],
      default: [],
    },
  },
  { timestamps: true }
);

leaveRequestSchema.index({ staff: 1, academicYear: 1, status: 1 });
leaveRequestSchema.index({ status: 1, startDate: 1 });
leaveRequestSchema.index({ startDate: 1, endDate: 1 });

/**
 * Everything derived lives here, so there is exactly one place where a stored
 * value could come from a client value.
 *
 * The holiday set is handed in by the controller before saving, because the
 * model must not go looking for another document mid-validation.
 */
leaveRequestSchema.pre('validate', function derive() {
  if (this.startDate && this.endDate && this.endDate < this.startDate) {
    this.invalidate('endDate', 'Leave cannot end before it starts');
    return;
  }

  const span =
    this.startDate && this.endDate ? daysBetween(this.startDate, this.endDate) : null;
  if (span !== null && span > MAX_LEAVE_SPAN_DAYS) {
    this.invalidate('endDate', `A single request cannot exceed ${MAX_LEAVE_SPAN_DAYS} days`);
    return;
  }

  const holidays = this.$locals.nonWorkingDates || [];
  const dates = workingDatesBetween(this.startDate, this.endDate, holidays);

  this.workingDays = dates;
  this.dayUnits = toHalves(
    computeDayUnits(this.startDate, this.endDate, this.startHalf, this.endHalf, holidays)
  );

  if (dates.length === 0) {
    this.invalidate(
      'startDate',
      'That range contains no working days — the school is closed throughout'
    );
  }

  // A half-day marker on an end that spans several days only makes sense in one
  // direction. Silently correcting the other one is kinder than refusing it and
  // keeps the cost honest.
  if (dates.length > 1) {
    if (this.startHalf === 'morning') this.startHalf = 'full';
    if (this.endHalf === 'afternoon') this.endHalf = 'full';
  }

  if (
    this.type === 'sick' &&
    this.dayUnits > CERTIFICATE_THRESHOLD_DAYS &&
    !this.medicalCertificateRef
  ) {
    this.invalidate(
      'medicalCertificateRef',
      `Sick leave of more than ${CERTIFICATE_THRESHOLD_DAYS} days needs a certificate reference`
    );
  }

  if ((this.coverPeriods || []).length > MAX_COVER_PERIODS) {
    this.invalidate(
      'coverPeriods',
      `A request cannot describe more than ${MAX_COVER_PERIODS} cover periods`
    );
  }

  // Two lessons on the same weekday cannot overlap; a teacher timetabled into
  // two rooms at once is a timetable bug, and importing it into the cover board
  // books one substitute for two places.
  const byDay = new Map();
  for (const period of this.coverPeriods || []) {
    const start = Date.parse(`1970-01-01T${period.startTime}:00`);
    const end = Date.parse(`1970-01-01T${period.endTime}:00`);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end <= start) {
      this.invalidate('coverPeriods', `${period.periodLabel} ends before it starts`);
      continue;
    }
    const bucket = byDay.get(period.dayOfWeek) || [];
    for (const other of bucket) {
      if (start < other.end && other.start < end) {
        this.invalidate(
          'coverPeriods',
          `${period.periodLabel} overlaps ${other.label} on the same day`
        );
        break;
      }
    }
    bucket.push({ start, end, label: period.periodLabel });
    byDay.set(period.dayOfWeek, bucket);
  }

  if (this.status !== 'approved') {
    this.decidedBy = undefined;
    this.decidedAt = undefined;
  }
  if (!['rejected', 'withdrawn', 'cancelled'].includes(this.status)) {
    if (this.status !== 'approved') this.decisionNote = null;
  }
  if (this.status === 'draft') {
    this.submittedAt = null;
  }
});

leaveRequestSchema.methods.isOwnedBy = function isOwnedBy(user) {
  if (!user) return false;
  return String(this.staff) === String(user._id);
};

leaveRequestSchema.methods.isEditable = function isEditable() {
  return EDITABLE_STATUSES.includes(this.status);
};

leaveRequestSchema.methods.consumesBalance = function consumesBalance() {
  return CONSUMING_STATUSES.includes(this.status);
};

leaveRequestSchema.methods.isMetered = function isMetered() {
  return !UNMETERED_TYPES.includes(this.type);
};

/** Whether this leave covers a given YYYY-MM-DD key. */
leaveRequestSchema.methods.coversDate = function coversDate(dateKey) {
  return (this.workingDays || []).includes(dateKey);
};

/**
 * The cover periods that fall on one date, shaped for `StaffAbsence`.
 *
 * A half day only surrenders the half it is actually absent for: a morning-only
 * leave hands over the periods that end by midday and keeps the rest, because
 * arranging cover for a lesson the teacher is present at is how a substitute
 * ends up standing in a room with the regular teacher already in it.
 */
leaveRequestSchema.methods.absencePeriodsFor = function absencePeriodsFor(dateKey) {
  if (!this.coversDate(dateKey)) return [];

  const weekday = weekdayOf(dateKey);
  const midday = 12 * 60;

  let half = 'full';
  if (dateKey === this.startDate && this.startHalf !== 'full') half = this.startHalf;
  if (dateKey === this.endDate && this.endHalf !== 'full') half = this.endHalf;

  return (this.coverPeriods || [])
    .filter((period) => period.dayOfWeek === weekday)
    .filter((period) => {
      if (half === 'full') return true;
      const [h, m] = period.startTime.split(':').map(Number);
      const startMinute = h * 60 + m;
      // `afternoon` means away from midday onward, so the afternoon lessons are
      // the ones that need covering, and vice versa.
      return half === 'afternoon' ? startMinute >= midday : startMinute < midday;
    })
    .map((period) => ({
      periodLabel: period.periodLabel,
      startTime: period.startTime,
      endTime: period.endTime,
      className: period.className,
      subject: period.subject,
      room: period.room || null,
      lessonPlan: period.lessonPlan || null,
    }));
};

/** Every date in this leave that has at least one period needing cover. */
leaveRequestSchema.methods.datesNeedingCover = function datesNeedingCover() {
  if (!this.coverRequired) return [];
  return (this.workingDays || []).filter(
    (date) => this.absencePeriodsFor(date).length > 0
  );
};

/**
 * Why `approver` may not approve this request, or null when they may.
 *
 * The shortfall is stated as a number rather than as "insufficient balance",
 * because the person reading it has to decide whether to re-type the request as
 * unpaid leave, and that decision needs the figure.
 */
leaveRequestSchema.methods.approvabilityErrorFor = function approvabilityErrorFor(
  approver,
  { remaining = null, entitlement = null, overlapping = [] } = {}
) {
  if (!approver) return 'Not authenticated';

  if (String(this.staff) === String(approver._id)) {
    return 'You cannot approve your own leave';
  }
  if (this.status === 'approved') return 'This request is already approved';
  if (this.status !== 'submitted') {
    return `A ${this.status} request cannot be approved`;
  }
  if (entitlement && entitlement.isClosed) {
    return `${this.academicYear} is closed and cannot take new leave`;
  }
  if (overlapping.length) {
    const first = overlapping[0];
    return `This overlaps leave already booked from ${first.startDate} to ${first.endDate}`;
  }
  if (this.coverRequired && this.datesNeedingCover().length === 0) {
    return 'Cover was asked for but no lessons were listed, so approving this would arrange nothing';
  }
  if (this.isMetered() && remaining !== null && this.dayUnits > remaining) {
    const short = toHalves(this.dayUnits - remaining);
    return `This is ${short} day(s) more ${this.type} leave than remains (${remaining} left). Re-raise the excess as unpaid leave.`;
  }

  return null;
};

leaveRequestSchema.methods.recordHistory = function recordHistory(action, userId, note) {
  this.history.push({ action, by: userId, at: new Date(), note });
  if (this.history.length > 60) this.history = this.history.slice(-60);
};

leaveRequestSchema.methods.toRow = function toRow() {
  return {
    _id: this._id,
    staff: this.staff,
    staffName: this.staffName,
    academicYear: this.academicYear,
    type: this.type,
    startDate: this.startDate,
    endDate: this.endDate,
    startHalf: this.startHalf,
    endHalf: this.endHalf,
    dayUnits: this.dayUnits,
    workingDays: this.workingDays,
    reason: this.reason,
    contactDuringLeave: this.contactDuringLeave,
    medicalCertificateRef: this.medicalCertificateRef,
    status: this.status,
    submittedAt: this.submittedAt,
    decidedBy: this.decidedBy,
    decidedAt: this.decidedAt,
    decisionNote: this.decisionNote,
    coverRequired: this.coverRequired,
    coverPeriods: this.coverPeriods,
    datesNeedingCover: this.datesNeedingCover(),
    linkedAbsences: this.linkedAbsences,
    isEditable: this.isEditable(),
    isMetered: this.isMetered(),
    createdAt: this.createdAt,
  };
};

/**
 * Which of `requests` overlap the given range, ignoring one id. Used before an
 * approval so the refusal names the leave it clashes with.
 */
leaveRequestSchema.statics.findOverlaps = function findOverlaps(
  requests,
  startDate,
  endDate,
  ignoreId
) {
  return (requests || []).filter((request) => {
    if (ignoreId && String(request._id) === String(ignoreId)) return false;
    if (!BLOCKING_STATUSES.includes(request.status)) return false;
    return rangesOverlap(startDate, endDate, request.startDate, request.endDate);
  });
};

/**
 * Who is out on each date in a range. The calendar the approver needs before
 * granting the fourth request from one department for results week.
 */
leaveRequestSchema.statics.buildCalendar = function buildCalendar(requests, from, to) {
  const byDate = new Map();

  for (const request of requests) {
    for (const date of request.workingDays || []) {
      if (date < from || date > to) continue;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push({
        _id: request._id,
        staff: request.staff,
        staffName: request.staffName,
        type: request.type,
        status: request.status,
        isPartial:
          (date === request.startDate && request.startHalf !== 'full') ||
          (date === request.endDate && request.endHalf !== 'full'),
      });
    }
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, people]) => ({ date, count: people.length, people }));
};

leaveRequestSchema.statics.todayKey = todayKey;
leaveRequestSchema.statics.daysBetween = daysBetween;
leaveRequestSchema.statics.workingDatesBetween = workingDatesBetween;
leaveRequestSchema.statics.computeDayUnits = computeDayUnits;
leaveRequestSchema.statics.LEAVE_TYPES = LEAVE_TYPES;
leaveRequestSchema.statics.REQUEST_STATUSES = REQUEST_STATUSES;
leaveRequestSchema.statics.HALF_DAY_MARKERS = HALF_DAY_MARKERS;
leaveRequestSchema.statics.UNMETERED_TYPES = UNMETERED_TYPES;
leaveRequestSchema.statics.EDITABLE_STATUSES = EDITABLE_STATUSES;
leaveRequestSchema.statics.BLOCKING_STATUSES = BLOCKING_STATUSES;
leaveRequestSchema.statics.CONSUMING_STATUSES = CONSUMING_STATUSES;
leaveRequestSchema.statics.CERTIFICATE_THRESHOLD_DAYS = CERTIFICATE_THRESHOLD_DAYS;

leaveEntitlementSchema.statics.DEFAULT_ALLOWANCES = DEFAULT_ALLOWANCES;
leaveEntitlementSchema.statics.LEAVE_TYPES = LEAVE_TYPES;
leaveEntitlementSchema.statics.UNMETERED_TYPES = UNMETERED_TYPES;
leaveEntitlementSchema.statics.todayKey = todayKey;
leaveEntitlementSchema.statics.toHalves = toHalves;

const StaffLeaveEntitlement = mongoose.model('StaffLeaveEntitlement', leaveEntitlementSchema);
const StaffLeaveRequest = mongoose.model('StaffLeaveRequest', leaveRequestSchema);

module.exports = {
  StaffLeaveEntitlement,
  StaffLeaveRequest,
  LEAVE_TYPES,
  REQUEST_STATUSES,
  HALF_DAY_MARKERS,
  UNMETERED_TYPES,
  DEFAULT_ALLOWANCES,
  CERTIFICATE_THRESHOLD_DAYS,
  todayKey,
  daysBetween,
  workingDatesBetween,
  computeDayUnits,
  toHalves,
};
