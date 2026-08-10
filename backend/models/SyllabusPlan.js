const mongoose = require('mongoose');

/**
 * Syllabus plans: the scheme of work for one class, one subject, one year, and
 * the record of what was actually taught against it.
 *
 * The point of the model is that "behind" becomes a number instead of a
 * feeling. Two quantities do that, and neither is ever typed by a human:
 *
 *   coveragePercent  - periods actually taught / periods planned
 *   expectedPercent  - periods whose planned end date has passed / periods planned
 *
 * The gap between them is the lag. Because both sides come from stored facts,
 * the answer to "is 9B behind in Physics" is the same for the teacher, the head
 * of department and the principal, which is the entire point and is not true of
 * a spreadsheet.
 *
 * `periodsTaught` is recomputed from `sessions` on every save. There is no path
 * by which a client can set it, so it cannot drift from the log it summarises.
 */

const PLAN_STATUSES = ['draft', 'active', 'archived'];

const UNIT_STATUSES = ['not-started', 'in-progress', 'completed', 'deferred'];

// A unit in one of these states is being taught or has been taught, so the
// periods logged against it count toward coverage. A deferred unit stays in the
// denominator but contributes nothing to the numerator — dropping it from both
// would make coverage improve by teaching less, which is precisely backwards.
const COVERING_UNIT_STATUSES = ['in-progress', 'completed'];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_PATTERN = /^\d{4}-\d{2}$/;

const MAX_UNITS_PER_PLAN = 60;
const MAX_SESSIONS_PER_UNIT = 200;
const MAX_PERIODS_PER_SESSION = 8;
const MAX_PLANNED_PERIODS = 200;

// Thresholds on the lag, in percentage points, that turn a number into a word.
const AHEAD_THRESHOLD = -5;
const SLIPPING_THRESHOLD = 10;
const BEHIND_THRESHOLD = 20;

/** Today in the server's local zone, as the YYYY-MM-DD key the model stores. */
function todayKey(now = new Date()) {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

function roundTo(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

const sessionSchema = new mongoose.Schema(
  {
    date: {
      type: String,
      required: [true, 'Session date is required'],
      match: [DATE_PATTERN, 'Session date must be in YYYY-MM-DD format'],
    },
    periods: {
      type: Number,
      required: [true, 'Number of periods is required'],
      min: [1, 'A session must be at least one period'],
      max: [
        MAX_PERIODS_PER_SESSION,
        `A session cannot exceed ${MAX_PERIODS_PER_SESSION} periods`,
      ],
      validate: {
        validator: Number.isInteger,
        message: 'Periods must be a whole number',
      },
    },
    topic: {
      type: String,
      required: [true, 'Topic is required'],
      trim: true,
      maxlength: [160, 'Topic cannot exceed 160 characters'],
    },
    note: {
      type: String,
      trim: true,
      maxlength: [500, 'Note cannot exceed 500 characters'],
    },
    loggedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    loggedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true, timestamps: false }
);

const unitSchema = new mongoose.Schema(
  {
    // Contiguous from 0, re-normalised server-side on every insert, reorder and
    // delete. Gaps and duplicates are how a syllabus quietly loses a unit.
    orderIndex: {
      type: Number,
      required: true,
      min: 0,
    },
    title: {
      type: String,
      required: [true, 'Unit title is required'],
      trim: true,
      maxlength: [160, 'Unit title cannot exceed 160 characters'],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [1000, 'Description cannot exceed 1000 characters'],
    },
    plannedPeriods: {
      type: Number,
      required: [true, 'Planned periods are required'],
      min: [1, 'A unit must plan at least one period'],
      max: [
        MAX_PLANNED_PERIODS,
        `A unit cannot plan more than ${MAX_PLANNED_PERIODS} periods`,
      ],
      validate: {
        validator: Number.isInteger,
        message: 'Planned periods must be a whole number',
      },
    },
    plannedStartDate: {
      type: String,
      match: [DATE_PATTERN, 'Planned start date must be in YYYY-MM-DD format'],
    },
    plannedEndDate: {
      type: String,
      match: [DATE_PATTERN, 'Planned end date must be in YYYY-MM-DD format'],
    },
    status: {
      type: String,
      enum: {
        values: UNIT_STATUSES,
        message: 'Invalid unit status',
      },
      default: 'not-started',
    },
    // Derived from `sessions` in the parent's pre-validate hook. Never accepted
    // from a client.
    periodsTaught: {
      type: Number,
      default: 0,
      min: 0,
    },
    completedOn: {
      type: String,
      match: [DATE_PATTERN, 'Completion date must be in YYYY-MM-DD format'],
    },
    completionNote: {
      type: String,
      trim: true,
      maxlength: [500, 'Completion note cannot exceed 500 characters'],
    },
    deferralReason: {
      type: String,
      trim: true,
      maxlength: [500, 'Deferral reason cannot exceed 500 characters'],
    },
    sessions: {
      type: [sessionSchema],
      default: [],
      validate: {
        validator: (v) => v.length <= MAX_SESSIONS_PER_UNIT,
        message: `A unit cannot hold more than ${MAX_SESSIONS_PER_UNIT} sessions`,
      },
    },
  },
  { _id: true, timestamps: false }
);

const revisionSchema = new mongoose.Schema(
  {
    summary: {
      type: String,
      required: true,
      trim: true,
      maxlength: [300, 'Revision summary cannot exceed 300 characters'],
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    changedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true, timestamps: false }
);

const syllabusPlanSchema = new mongoose.Schema(
  {
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
    academicYear: {
      type: String,
      required: [true, 'Academic year is required'],
      trim: true,
      match: [YEAR_PATTERN, 'Academic year must look like 2026-27'],
    },
    teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A plan needs an owning teacher'],
    },
    termStartDate: {
      type: String,
      required: [true, 'Term start date is required'],
      match: [DATE_PATTERN, 'Term start date must be in YYYY-MM-DD format'],
    },
    termEndDate: {
      type: String,
      required: [true, 'Term end date is required'],
      match: [DATE_PATTERN, 'Term end date must be in YYYY-MM-DD format'],
    },
    status: {
      type: String,
      enum: {
        values: PLAN_STATUSES,
        message: 'Invalid plan status',
      },
      default: 'draft',
    },
    units: {
      type: [unitSchema],
      default: [],
      validate: {
        validator: (v) => v.length <= MAX_UNITS_PER_PLAN,
        message: `A plan cannot hold more than ${MAX_UNITS_PER_PLAN} units`,
      },
    },
    revisions: {
      type: [revisionSchema],
      default: [],
    },
    archivedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

syllabusPlanSchema.index({ teacher: 1, academicYear: 1 });
syllabusPlanSchema.index({ className: 1, subject: 1, academicYear: 1 });
syllabusPlanSchema.index({ status: 1, academicYear: 1 });

/**
 * Everything derived lives here, so there is exactly one place where a stored
 * value can come from a client value.
 */
syllabusPlanSchema.pre('validate', async function derive() {
  if (this.termStartDate && this.termEndDate && this.termEndDate < this.termStartDate) {
    this.invalidate('termEndDate', 'The term cannot end before it starts');
  }

  // Re-normalise unit order. Sorting by the current index and rewriting it
  // means a caller can insert at 2.5 or leave a gap after a delete and still
  // get a contiguous list back.
  const units = this.units || [];
  units.sort((a, b) => a.orderIndex - b.orderIndex);
  units.forEach((unit, index) => {
    unit.orderIndex = index;
  });

  for (const unit of units) {
    if (
      unit.plannedStartDate &&
      unit.plannedEndDate &&
      unit.plannedEndDate < unit.plannedStartDate
    ) {
      this.invalidate(
        'units',
        `Unit "${unit.title}" cannot end before it starts`
      );
    }

    // The one line that makes coverage trustworthy.
    unit.periodsTaught = (unit.sessions || []).reduce(
      (total, session) => total + (session.periods || 0),
      0
    );

    if (unit.status === 'completed' && unit.periodsTaught === 0) {
      this.invalidate(
        'units',
        `Unit "${unit.title}" cannot be completed with no lessons logged against it`
      );
    }

    if (unit.status !== 'completed') {
      unit.completedOn = undefined;
    }
  }
});

/**
 * Total periods planned across the whole scheme of work, including deferred
 * units. See the note on COVERING_UNIT_STATUSES for why deferred stays in.
 */
syllabusPlanSchema.methods.totalPlannedPeriods = function totalPlannedPeriods() {
  return (this.units || []).reduce((total, unit) => total + (unit.plannedPeriods || 0), 0);
};

syllabusPlanSchema.methods.totalPeriodsTaught = function totalPeriodsTaught() {
  return (this.units || [])
    .filter((unit) => COVERING_UNIT_STATUSES.includes(unit.status))
    .reduce((total, unit) => total + (unit.periodsTaught || 0), 0);
};

/**
 * How far through the scheme of work the calendar says we ought to be: every
 * unit whose planned end date has passed, as a share of the whole plan. A unit
 * that is mid-window contributes proportionally rather than all-or-nothing, so
 * the expected line moves smoothly instead of in cliffs.
 */
syllabusPlanSchema.methods.expectedPeriods = function expectedPeriods(today = todayKey()) {
  let expected = 0;

  for (const unit of this.units || []) {
    const planned = unit.plannedPeriods || 0;
    const start = unit.plannedStartDate;
    const end = unit.plannedEndDate;

    if (!end) continue;
    if (today >= end) {
      expected += planned;
      continue;
    }
    if (!start || today <= start) continue;

    // Mid-window: interpolate on calendar days. Not exact — it does not know
    // about half terms — but it is monotonic and it never overstates.
    const startMs = Date.parse(`${start}T00:00:00`);
    const endMs = Date.parse(`${end}T00:00:00`);
    const todayMs = Date.parse(`${today}T00:00:00`);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      continue;
    }
    const fraction = (todayMs - startMs) / (endMs - startMs);
    expected += planned * Math.min(Math.max(fraction, 0), 1);
  }

  return expected;
};

/**
 * The plan's health as one word. Everything on the frontend that colours a row
 * reads this rather than re-deriving its own thresholds.
 */
syllabusPlanSchema.methods.progress = function progress(today = todayKey()) {
  const plannedTotal = this.totalPlannedPeriods();
  const taught = this.totalPeriodsTaught();
  const expected = this.expectedPeriods(today);

  const coveragePercent = plannedTotal ? (taught / plannedTotal) * 100 : 0;
  const expectedPercent = plannedTotal ? (expected / plannedTotal) * 100 : 0;
  const lagPercent = expectedPercent - coveragePercent;

  let health = 'on-track';
  if (plannedTotal === 0) health = 'empty';
  else if (lagPercent <= AHEAD_THRESHOLD) health = 'ahead';
  else if (lagPercent >= BEHIND_THRESHOLD) health = 'behind';
  else if (lagPercent >= SLIPPING_THRESHOLD) health = 'slipping';

  const units = this.units || [];

  return {
    plannedPeriods: plannedTotal,
    periodsTaught: taught,
    expectedPeriods: roundTo(expected),
    coveragePercent: roundTo(coveragePercent),
    expectedPercent: roundTo(expectedPercent),
    lagPercent: roundTo(lagPercent),
    health,
    unitCount: units.length,
    unitsCompleted: units.filter((u) => u.status === 'completed').length,
    unitsInProgress: units.filter((u) => u.status === 'in-progress').length,
    unitsDeferred: units.filter((u) => u.status === 'deferred').length,
    // Overrun is surfaced rather than clamped. A unit that took twelve periods
    // against eight planned is where next year's plan gets fixed.
    unitsOverrunning: units.filter(
      (u) => (u.periodsTaught || 0) > (u.plannedPeriods || 0)
    ).length,
  };
};

syllabusPlanSchema.methods.findUnit = function findUnit(unitId) {
  if (!mongoose.Types.ObjectId.isValid(unitId)) return null;
  return (this.units || []).id(unitId);
};

syllabusPlanSchema.methods.isOwnedBy = function isOwnedBy(user) {
  if (!user) return false;
  return String(this.teacher) === String(user._id) || user.role === 'admin';
};

/** Why this plan rejects writes, or null when it accepts them. */
syllabusPlanSchema.methods.writabilityError = function writabilityError() {
  if (this.status === 'archived') {
    return 'This plan is archived. Archived plans are read-only.';
  }
  return null;
};

syllabusPlanSchema.methods.recordRevision = function recordRevision(summary, userId) {
  this.revisions.push({ summary, changedBy: userId, changedAt: new Date() });
  // The trail is append-only, but it does not need to be infinite.
  if (this.revisions.length > 100) {
    this.revisions = this.revisions.slice(-100);
  }
};

/** The public shape, with the derived block attached. */
syllabusPlanSchema.methods.toSummary = function toSummary(today = todayKey()) {
  return {
    _id: this._id,
    className: this.className,
    subject: this.subject,
    academicYear: this.academicYear,
    teacher: this.teacher,
    termStartDate: this.termStartDate,
    termEndDate: this.termEndDate,
    status: this.status,
    progress: this.progress(today),
    updatedAt: this.updatedAt,
  };
};

syllabusPlanSchema.methods.toDetail = function toDetail(today = todayKey()) {
  return {
    ...this.toSummary(today),
    units: (this.units || []).map((unit) => ({
      _id: unit._id,
      orderIndex: unit.orderIndex,
      title: unit.title,
      description: unit.description,
      plannedPeriods: unit.plannedPeriods,
      plannedStartDate: unit.plannedStartDate,
      plannedEndDate: unit.plannedEndDate,
      status: unit.status,
      periodsTaught: unit.periodsTaught,
      completedOn: unit.completedOn,
      completionNote: unit.completionNote,
      deferralReason: unit.deferralReason,
      isOverrunning: (unit.periodsTaught || 0) > (unit.plannedPeriods || 0),
      sessions: unit.sessions,
    })),
    revisions: this.revisions,
  };
};

syllabusPlanSchema.statics.todayKey = todayKey;
syllabusPlanSchema.statics.PLAN_STATUSES = PLAN_STATUSES;
syllabusPlanSchema.statics.UNIT_STATUSES = UNIT_STATUSES;
syllabusPlanSchema.statics.COVERING_UNIT_STATUSES = COVERING_UNIT_STATUSES;
syllabusPlanSchema.statics.MAX_UNITS_PER_PLAN = MAX_UNITS_PER_PLAN;
syllabusPlanSchema.statics.MAX_PERIODS_PER_SESSION = MAX_PERIODS_PER_SESSION;
syllabusPlanSchema.statics.HEALTH_THRESHOLDS = {
  ahead: AHEAD_THRESHOLD,
  slipping: SLIPPING_THRESHOLD,
  behind: BEHIND_THRESHOLD,
};

module.exports = mongoose.model('SyllabusPlan', syllabusPlanSchema);
