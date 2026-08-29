const mongoose = require('mongoose');

/**
 * What happens after somebody fills in the enquiry form.
 *
 * `Inquiry` has four fields — name, email, department, message — and not one of
 * them is about what happened next. There is no status, no assignee, no record
 * of a reply, and (until this change) no GET route at all: the only way to read
 * an enquiry back out of the application was to open the database.
 *
 * For a school, admissions enquiries are the top of the funnel. This is the one
 * form on the site whose contents are worth money, and it is the one with no
 * follow-up machinery whatsoever.
 *
 * The rule the model exists for is that **the clock starts when the parent
 * asked, not when the school noticed.** `dueBy` is derived from
 * `inquiry.createdAt`. If it were measured from when a member of staff first
 * opened the record, the clock would start whenever it was convenient and every
 * enquiry would be answered on time by construction — which is how
 * response-time reporting usually ends up meaning nothing.
 */

const STATUSES = ['open', 'scheduled', 'completed', 'unreachable', 'closed'];

// Statuses in which the callback is still somebody's job. The unique index
// filters on the derived boolean, since MongoDB rejects `$ne` inside a
// partialFilterExpression.
const OPEN_STATUSES = ['open', 'scheduled'];

const CHANNELS = ['phone', 'email', 'in-person', 'video'];

const ATTEMPT_OUTCOMES = [
  'spoke',
  'no-answer',
  'engaged',
  'wrong-number',
  'left-message',
  'call-back-later',
];

const OUTCOMES = [
  'information-provided',
  'application-started',
  'visit-booked',
  'not-interested',
  'out-of-scope',
  'duplicate',
];

/**
 * How long each department has, in working hours.
 *
 * These are genuinely different commitments and flattening them to one number
 * would either make admissions look slow or make careers advice look urgent.
 * The keys match the enum already on `Inquiry.department`.
 */
const DEPARTMENT_SLA_HOURS = {
  Admissions: 4,
  'Academic Affairs': 16,
  'Sports Department': 24,
  'Career Counseling': 24,
};

const DEFAULT_SLA_HOURS = 24;

// The school answers the phone Monday to Saturday, 9 to 5. An SLA counted in
// wall-clock hours would put a Friday evening enquiry overdue before anyone was
// back at their desk.
const WORKING_DAY_START = 9;
const WORKING_DAY_END = 17;
const WORKING_HOURS_PER_DAY = WORKING_DAY_END - WORKING_DAY_START;

// `unreachable` is the status that makes a lead disappear, so it is the one
// that has to be earned.
const MIN_ATTEMPTS_FOR_UNREACHABLE = 3;
const MIN_DISTINCT_DAYS_FOR_UNREACHABLE = 2;

const historySchema = new mongoose.Schema(
  {
    action: { type: String, required: true, trim: true, maxlength: [40, 'Too long'] },
    from: { type: String, trim: true, maxlength: [80, 'Too long'] },
    to: { type: String, trim: true, maxlength: [80, 'Too long'] },
    note: { type: String, trim: true, maxlength: [500, 'Too long'] },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, trim: true, maxlength: [120, 'Too long'], default: '' },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const attemptSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, trim: true, maxlength: [120, 'Too long'], default: '' },
    channel: {
      type: String,
      enum: { values: CHANNELS, message: 'Invalid channel' },
      default: 'phone',
    },
    outcome: {
      type: String,
      enum: { values: ATTEMPT_OUTCOMES, message: 'Invalid attempt outcome' },
      required: [true, 'An attempt needs an outcome'],
    },
    note: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },
  },
  { _id: true }
);

const inquiryCallbackSchema = new mongoose.Schema(
  {
    inquiry: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Inquiry',
      required: [true, 'A callback must belong to an enquiry'],
    },

    // Copied at creation, so the queue renders without a join per row.
    department: { type: String, trim: true, maxlength: [60, 'Too long'], default: '' },
    contactName: { type: String, trim: true, maxlength: [120, 'Too long'], default: '' },
    contactEmail: { type: String, trim: true, lowercase: true, maxlength: [120, 'Too long'], default: '' },

    // `Inquiry` has no phone field. A callback needs one, and it is captured
    // here rather than bolted onto the public form, which is not being changed.
    phone: { type: String, trim: true, maxlength: [30, 'Too long'], default: '' },

    // The moment the parent asked. Copied so the SLA arithmetic does not depend
    // on the enquiry still existing in the shape it had.
    askedAt: { type: Date, required: [true, 'The time the enquiry arrived is required'] },

    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    assignedAt: { type: Date, default: null },

    // Derived from `askedAt` and the department SLA, and frozen thereafter.
    // Reassignment does not restart it: the work moving desk is not the
    // parent's problem.
    dueBy: { type: Date, required: [true, 'A deadline is required'] },
    slaHours: { type: Number, default: DEFAULT_SLA_HOURS },

    scheduledFor: { type: Date, default: null },
    channel: {
      type: String,
      enum: { values: CHANNELS, message: 'Invalid channel' },
      default: 'phone',
    },

    attempts: { type: [attemptSchema], default: [] },

    status: {
      type: String,
      enum: { values: STATUSES, message: 'Invalid status' },
      default: 'open',
    },

    outcome: {
      type: String,
      enum: { values: OUTCOMES, message: 'Invalid outcome' },
      default: null,
    },

    duplicateOf: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InquiryCallback',
      default: null,
    },

    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    closedAt: { type: Date, default: null },
    closeNote: { type: String, trim: true, maxlength: [1000, 'Too long'], default: '' },

    // A reopen is a new callback pointing at the old one, never a status flip,
    // so the first conversation keeps its own dates and outcome.
    reopenedFrom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InquiryCallback',
      default: null,
    },

    // Derived from `status`.
    isOpen: { type: Boolean, default: true },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

/**
 * One open callback per enquiry.
 *
 * At the database rather than in the controller, because the collision this
 * exists to stop is two members of staff picking the same row off the same
 * screen within the same second and both ringing the family.
 */
inquiryCallbackSchema.index(
  { inquiry: 1 },
  {
    unique: true,
    partialFilterExpression: { isOpen: true },
    name: 'one_open_callback_per_inquiry',
  }
);

inquiryCallbackSchema.index({ status: 1, dueBy: 1 });
inquiryCallbackSchema.index({ assignedTo: 1, status: 1 });
inquiryCallbackSchema.index({ department: 1, status: 1, dueBy: 1 });

inquiryCallbackSchema.pre('save', function guard() {
  this.isOpen = OPEN_STATUSES.includes(this.status);

  if (this.status === 'closed' && !this.outcome) {
    throw new Error('A callback cannot be closed without an outcome');
  }

  if (this.outcome === 'duplicate' && !this.duplicateOf) {
    throw new Error('Marking a callback as a duplicate requires the callback it duplicates');
  }
});

inquiryCallbackSchema.methods.recordHistory = function recordHistory(entry) {
  this.history.push({
    action: entry.action,
    from: entry.from === undefined || entry.from === null ? undefined : String(entry.from),
    to: entry.to === undefined || entry.to === null ? undefined : String(entry.to),
    note: entry.note,
    by: entry.by,
    byName: entry.byName || '',
    at: new Date(),
  });

  return this;
};

/**
 * Advance a date by a number of *working* hours.
 *
 * Counted Monday to Saturday, 09:00 to 17:00. A Friday-evening enquiry with a
 * four-hour SLA is due on Saturday morning, not at nine on Friday night — and
 * an SLA that goes overdue while the building is empty is one that gets
 * ignored rather than met.
 */
function addWorkingHours(from, hours) {
  const cursor = new Date(from);
  let remaining = Number(hours) || 0;

  // Sunday: move to Monday morning. Outside hours: move to the next boundary.
  const normalise = () => {
    for (let guard = 0; guard < 400; guard += 1) {
      if (cursor.getDay() === 0) {
        cursor.setDate(cursor.getDate() + 1);
        cursor.setHours(WORKING_DAY_START, 0, 0, 0);
        continue;
      }
      if (cursor.getHours() < WORKING_DAY_START) {
        cursor.setHours(WORKING_DAY_START, 0, 0, 0);
        continue;
      }
      if (cursor.getHours() >= WORKING_DAY_END) {
        cursor.setDate(cursor.getDate() + 1);
        cursor.setHours(WORKING_DAY_START, 0, 0, 0);
        continue;
      }
      return;
    }
  };

  normalise();

  for (let guard = 0; guard < 400 && remaining > 0; guard += 1) {
    const endOfDay = new Date(cursor);
    endOfDay.setHours(WORKING_DAY_END, 0, 0, 0);

    const availableToday = (endOfDay - cursor) / 3600000;

    if (remaining <= availableToday) {
      cursor.setTime(cursor.getTime() + remaining * 3600000);
      remaining = 0;
      break;
    }

    remaining -= availableToday;
    cursor.setTime(endOfDay.getTime());
    normalise();
  }

  return cursor;
}

inquiryCallbackSchema.statics.slaHoursFor = function slaHoursFor(department) {
  return DEPARTMENT_SLA_HOURS[department] || DEFAULT_SLA_HOURS;
};

/**
 * The deadline, measured from the moment the parent asked.
 */
inquiryCallbackSchema.statics.deadlineFor = function deadlineFor(askedAt, department) {
  const hours = this.slaHoursFor(department);
  return { dueBy: addWorkingHours(askedAt, hours), slaHours: hours };
};

/**
 * Breach, computed at read time.
 *
 * There is no cron job in this repository, and a stored `isOverdue` field would
 * depend on one having run. A flag that is stale exactly when the queue is
 * busiest is worse than no flag at all.
 */
inquiryCallbackSchema.methods.overdueState = function overdueState(now = new Date()) {
  if (!this.isOpen) {
    return {
      overdue: false,
      breached: this.closedAt ? this.closedAt > this.dueBy : false,
      hoursRemaining: null,
    };
  }

  const hoursRemaining = Math.round(((this.dueBy - now) / 3600000) * 10) / 10;

  return {
    overdue: this.dueBy < now,
    breached: this.dueBy < now,
    hoursRemaining,
  };
};

/**
 * Time to the *first recorded attempt*, not to closure.
 *
 * Closure time flatters: an enquiry closed as out-of-scope in thirty seconds is
 * not good service, and measuring to closure would rank it as the best result
 * of the week.
 */
inquiryCallbackSchema.methods.firstResponseHours = function firstResponseHours() {
  if (!this.attempts.length) return null;

  const first = this.attempts.reduce(
    (earliest, attempt) => (attempt.at < earliest.at ? attempt : earliest),
    this.attempts[0]
  );

  return Math.round(((first.at - this.askedAt) / 3600000) * 10) / 10;
};

inquiryCallbackSchema.methods.assignTo = function assignTo(userId, userName, actor) {
  const from = this.assignedTo ? String(this.assignedTo) : 'unassigned';

  this.assignedTo = userId;
  this.assignedBy = actor._id;
  this.assignedAt = new Date();

  // `dueBy` is deliberately untouched.
  return this.recordHistory({
    action: 'assigned',
    from,
    to: userName || String(userId),
    by: actor._id,
    byName: actor.name,
  });
};

inquiryCallbackSchema.methods.recordAttempt = function recordAttempt(actor, attempt) {
  if (!this.isOpen) {
    throw new Error(`A ${this.status} callback cannot take further attempts`);
  }
  if (!ATTEMPT_OUTCOMES.includes(attempt.outcome)) {
    throw new Error('An attempt needs a valid outcome');
  }

  this.attempts.push({
    at: attempt.at ? new Date(attempt.at) : new Date(),
    by: actor._id,
    byName: actor.name,
    channel: attempt.channel || this.channel,
    outcome: attempt.outcome,
    note: attempt.note || '',
  });

  return this.recordHistory({
    action: 'attempted',
    to: attempt.outcome,
    note: attempt.note,
    by: actor._id,
    byName: actor.name,
  });
};

/**
 * How many separate days somebody actually tried.
 *
 * A counter would do for the number of attempts; it would not do for this,
 * which is the half of the unreachable rule that stops three redials in one
 * afternoon from counting as a genuine effort.
 */
inquiryCallbackSchema.methods.distinctAttemptDays = function distinctAttemptDays() {
  const days = new Set(
    this.attempts.map((attempt) => new Date(attempt.at).toISOString().slice(0, 10))
  );
  return days.size;
};

inquiryCallbackSchema.methods.unreachableBlockedReason = function unreachableBlockedReason() {
  if (this.attempts.length < MIN_ATTEMPTS_FOR_UNREACHABLE) {
    return `At least ${MIN_ATTEMPTS_FOR_UNREACHABLE} attempts must be recorded before an ` +
      `enquiry can be closed as unreachable; there ${
        this.attempts.length === 1 ? 'is' : 'are'
      } ${this.attempts.length}`;
  }

  if (this.distinctAttemptDays() < MIN_DISTINCT_DAYS_FOR_UNREACHABLE) {
    return `Those attempts are all on the same day. One unanswered afternoon is not an ` +
      `unreachable family — try again on another day first`;
  }

  return null;
};

inquiryCallbackSchema.methods.markUnreachable = function markUnreachable(actor, note = '') {
  if (!this.isOpen) {
    throw new Error(`A ${this.status} callback cannot be marked unreachable`);
  }

  const blocked = this.unreachableBlockedReason();
  if (blocked) throw new Error(blocked);

  const from = this.status;

  this.status = 'unreachable';
  this.closedBy = actor._id;
  this.closedAt = new Date();
  this.closeNote = note || '';

  return this.recordHistory({
    action: 'unreachable',
    from,
    to: 'unreachable',
    note,
    by: actor._id,
    byName: actor.name,
  });
};

inquiryCallbackSchema.methods.close = function close(actor, { outcome, note, duplicateOf }) {
  if (!this.isOpen) {
    throw new Error(`This callback is already ${this.status}`);
  }
  if (!OUTCOMES.includes(outcome)) {
    throw new Error('An outcome is required to close a callback');
  }
  if (outcome === 'duplicate' && !duplicateOf) {
    throw new Error('Marking a callback as a duplicate requires the callback it duplicates');
  }

  const from = this.status;

  this.status = 'closed';
  this.outcome = outcome;
  this.duplicateOf = duplicateOf || null;
  this.closedBy = actor._id;
  this.closedAt = new Date();
  this.closeNote = note || '';

  return this.recordHistory({
    action: 'closed',
    from,
    to: outcome,
    note,
    by: actor._id,
    byName: actor.name,
  });
};

inquiryCallbackSchema.methods.schedule = function schedule(actor, when, channel) {
  if (!this.isOpen) {
    throw new Error(`A ${this.status} callback cannot be scheduled`);
  }

  const at = new Date(when);
  if (Number.isNaN(at.getTime())) throw new Error('That is not a valid date and time');

  this.status = 'scheduled';
  this.scheduledFor = at;
  if (channel) this.channel = channel;

  return this.recordHistory({
    action: 'scheduled',
    to: at.toISOString(),
    by: actor._id,
    byName: actor.name,
  });
};

/**
 * Per-department first-response reporting.
 *
 * Measured to the first attempt, and reported alongside how many were breached,
 * because an average that includes only the enquiries somebody got to is an
 * average of the good ones.
 */
inquiryCallbackSchema.statics.responseStats = async function responseStats(since) {
  const match = since ? { askedAt: { $gte: new Date(since) } } : {};

  const callbacks = await this.find(match).select(
    'department askedAt attempts dueBy status closedAt outcome'
  );

  const byDepartment = {};

  callbacks.forEach((callback) => {
    const key = callback.department || 'Unspecified';
    if (!byDepartment[key]) {
      byDepartment[key] = {
        department: key,
        total: 0,
        responded: 0,
        neverAttempted: 0,
        breached: 0,
        firstResponseHours: [],
        outcomes: {},
      };
    }

    const row = byDepartment[key];
    row.total += 1;

    const hours = callback.firstResponseHours();
    if (hours === null) {
      row.neverAttempted += 1;
    } else {
      row.responded += 1;
      row.firstResponseHours.push(hours);
    }

    if (callback.overdueState().breached) row.breached += 1;
    if (callback.outcome) {
      row.outcomes[callback.outcome] = (row.outcomes[callback.outcome] || 0) + 1;
    }
  });

  return Object.values(byDepartment).map((row) => {
    const sorted = [...row.firstResponseHours].sort((a, b) => a - b);
    const median = sorted.length
      ? sorted.length % 2
        ? sorted[(sorted.length - 1) / 2]
        : Math.round(((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) * 10) / 10
      : null;

    return {
      department: row.department,
      total: row.total,
      responded: row.responded,
      neverAttempted: row.neverAttempted,
      breached: row.breached,
      medianFirstResponseHours: median,
      outcomes: row.outcomes,
    };
  });
};

inquiryCallbackSchema.statics.STATUSES = STATUSES;
inquiryCallbackSchema.statics.OPEN_STATUSES = OPEN_STATUSES;
inquiryCallbackSchema.statics.CHANNELS = CHANNELS;
inquiryCallbackSchema.statics.ATTEMPT_OUTCOMES = ATTEMPT_OUTCOMES;
inquiryCallbackSchema.statics.OUTCOMES = OUTCOMES;
inquiryCallbackSchema.statics.DEPARTMENT_SLA_HOURS = DEPARTMENT_SLA_HOURS;
inquiryCallbackSchema.statics.MIN_ATTEMPTS_FOR_UNREACHABLE = MIN_ATTEMPTS_FOR_UNREACHABLE;
inquiryCallbackSchema.statics.MIN_DISTINCT_DAYS_FOR_UNREACHABLE = MIN_DISTINCT_DAYS_FOR_UNREACHABLE;
inquiryCallbackSchema.statics.addWorkingHours = addWorkingHours;
inquiryCallbackSchema.statics.WORKING_DAY_START = WORKING_DAY_START;
inquiryCallbackSchema.statics.WORKING_DAY_END = WORKING_DAY_END;
inquiryCallbackSchema.statics.WORKING_HOURS_PER_DAY = WORKING_HOURS_PER_DAY;

module.exports = mongoose.model('InquiryCallback', inquiryCallbackSchema);
