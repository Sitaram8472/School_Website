const mongoose = require('mongoose');

/**
 * One scheduled run of one course, with a fixed number of chairs in it.
 *
 * `TrainingRecord` is a personal log: a member of staff writes down a course
 * they went on and how many hours it was worth. It has no idea that courses are
 * things the school *runs*. Safeguarding training on 14 September has a room
 * with twenty-four chairs, and nothing in the system knows the session exists
 * until people start filing records saying they went to it — by which point the
 * chairs are the problem.
 *
 * The property this file holds is that **the last seat goes to exactly one
 * person, and the first seat that frees goes to whoever has been waiting
 * longest**. Neither is achievable by reading a counter, adding one and saving,
 * so neither is done that way.
 */

const COHORT_STATUSES = [
  'draft',
  'open',
  'full',
  'closed',
  'running',
  'completed',
  'cancelled',
];

// A cohort in one of these has happened or is happening, so it can no longer be
// cancelled — people arranged their week around it.
const UNDER_WAY_STATUSES = ['running', 'completed'];

// ...and in one of these it still exists as a plan, so its shape may change.
const PLANNING_STATUSES = ['draft', 'open', 'full', 'closed'];

const ENROLMENT_STATES = [
  'enrolled',
  'waitlisted',
  'withdrawn',
  'attended',
  'no-show',
];

// A person in one of these holds a chair.
const SEATED_STATES = ['enrolled', 'attended', 'no-show'];

const TRAINING_TYPES = [
  'workshop',
  'online-course',
  'conference',
  'webinar',
  'in-house',
  'mentoring',
  'certification',
];

const COMPETENCIES = [
  'safeguarding',
  'first-aid',
  'pedagogy',
  'assessment',
  'inclusion',
  'technology',
  'leadership',
  'subject-knowledge',
  'wellbeing',
  'compliance',
];

const MODES = ['in-person', 'online', 'hybrid'];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const YEAR_PATTERN = /^\d{4}-\d{2}$/;

const MIN_CREDIT_HOURS = 0.5;
const MAX_CREDIT_HOURS = 200;

const MAX_SEATS = 500;
const DEFAULT_WAITLIST_CAPACITY = 50;

// How close to the start a withdrawal stops being a withdrawal and starts being
// a no-show. The school has catered and staffed by then.
const DEFAULT_WITHDRAWAL_CUTOFF_HOURS = 48;

const toDateTime = (dateKey, timeKey = '00:00') => {
  if (!DATE_PATTERN.test(dateKey || '')) return null;

  const [year, month, day] = dateKey.split('-').map(Number);
  const [hours, minutes] = (TIME_PATTERN.test(timeKey) ? timeKey : '00:00')
    .split(':')
    .map(Number);

  return new Date(year, month - 1, day, hours, minutes, 0, 0);
};

const enrolmentSchema = new mongoose.Schema(
  {
    staff: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    staffName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },
    staffRole: { type: String, trim: true, maxlength: [20, 'Too long'], default: '' },
    department: { type: String, trim: true, maxlength: [60, 'Too long'], default: '' },

    state: {
      type: String,
      enum: { values: ENROLMENT_STATES, message: 'Invalid enrolment state' },
      default: 'enrolled',
    },

    /**
     * The waitlist queue number.
     *
     * Assigned from a monotonically increasing counter on the cohort, never
     * from `enrolments.length` — that shrinks when somebody withdraws and would
     * hand two people the same place. Positions are never renumbered; the gaps
     * are the record of who left.
     */
    position: { type: Number, default: 0, min: 0 },

    joinedAt: { type: Date, default: Date.now },
    promotedAt: { type: Date, default: null },

    withdrawnAt: { type: Date, default: null },
    withdrawReason: { type: String, trim: true, maxlength: [300, 'Too long'], default: '' },
    // Set when the withdrawal fell inside the cutoff. Dropping out two hours
    // before a catered session is not the same act as dropping out three weeks
    // earlier, and the record should say which one happened.
    lateWithdrawal: { type: Boolean, default: false },

    attendanceMarkedAt: { type: Date, default: null },
    attendanceMarkedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // Awarded on attendance, never on enrolment, and always the cohort's own
    // figure — that is the whole reason for having cohorts rather than
    // twenty-four independently typed records.
    creditAwarded: { type: Number, default: 0, min: 0 },

    enrolledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: false }
);

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

const trainingCohortSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'A cohort needs a title'],
      trim: true,
      minlength: [4, 'Title must be at least 4 characters'],
      maxlength: [150, 'Title cannot exceed 150 characters'],
    },
    code: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: [30, 'Code cannot exceed 30 characters'],
      default: '',
    },
    provider: {
      type: String,
      required: [true, 'Say who is running it'],
      trim: true,
      maxlength: [120, 'Provider cannot exceed 120 characters'],
    },
    description: { type: String, trim: true, maxlength: [3000, 'Too long'], default: '' },

    type: {
      type: String,
      enum: { values: TRAINING_TYPES, message: 'Invalid training type' },
      required: [true, 'A type is required'],
    },
    competency: {
      type: String,
      enum: { values: COMPETENCIES, message: 'Invalid competency' },
      required: [true, 'A competency is required'],
    },

    academicYear: {
      type: String,
      required: [true, 'An academic year is required'],
      match: [YEAR_PATTERN, 'Academic year must be in YYYY-YY format'],
    },

    startDate: {
      type: String,
      required: [true, 'A start date is required'],
      match: [DATE_PATTERN, 'Start date must be in YYYY-MM-DD format'],
    },
    endDate: {
      type: String,
      required: [true, 'An end date is required'],
      match: [DATE_PATTERN, 'End date must be in YYYY-MM-DD format'],
    },
    startTime: { type: String, match: [TIME_PATTERN, 'Time must be HH:MM'], default: '09:00' },
    endTime: { type: String, match: [TIME_PATTERN, 'Time must be HH:MM'], default: '16:00' },

    venue: { type: String, trim: true, maxlength: [200, 'Too long'], default: '' },
    mode: {
      type: String,
      enum: { values: MODES, message: 'Invalid mode' },
      default: 'in-person',
    },

    /**
     * What the session is worth, once, for everybody on it.
     *
     * On the cohort rather than per enrolment on purpose: twenty-four people
     * typing their own figure for one afternoon is the spreadsheet this
     * replaces.
     */
    creditHours: {
      type: Number,
      required: [true, 'Say what this is worth in credit hours'],
      min: [MIN_CREDIT_HOURS, `Credit hours must be at least ${MIN_CREDIT_HOURS}`],
      max: [MAX_CREDIT_HOURS, `Credit hours cannot exceed ${MAX_CREDIT_HOURS}`],
    },

    isMandatory: { type: Boolean, default: false },
    // Role or department tags. The mandatory gap report is built from these.
    mandatoryFor: {
      type: [{ _id: false, tag: { type: String, trim: true, maxlength: 40 } }],
      default: [],
    },

    seatCapacity: {
      type: Number,
      required: [true, 'How many chairs are in the room?'],
      min: [1, 'A cohort needs at least one seat'],
      max: [MAX_SEATS, `A cohort cannot exceed ${MAX_SEATS} seats`],
    },
    /**
     * A counter, moved only by guarded atomic updates — never by reading it,
     * adding one and saving. Two people pressing enrol on the last chair within
     * the same tick is the exact failure this module exists to prevent, and a
     * check-then-write cannot prevent it.
     */
    seatsTaken: { type: Number, default: 0, min: 0 },
    waitlistCapacity: {
      type: Number,
      default: DEFAULT_WAITLIST_CAPACITY,
      min: [0, 'Cannot be negative'],
    },

    // The source of waitlist positions. Only ever incremented.
    positionCounter: { type: Number, default: 0, min: 0 },

    enrolmentOpensOn: { type: String, match: [DATE_PATTERN, 'Must be YYYY-MM-DD'], default: '' },
    enrolmentClosesOn: { type: String, match: [DATE_PATTERN, 'Must be YYYY-MM-DD'], default: '' },
    withdrawalCutoffHours: {
      type: Number,
      default: DEFAULT_WITHDRAWAL_CUTOFF_HOURS,
      min: [0, 'Cannot be negative'],
      max: [720, 'That is a month'],
    },

    status: {
      type: String,
      enum: { values: COHORT_STATUSES, message: 'Invalid status' },
      default: 'draft',
    },

    facilitator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    facilitatorName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },

    cancelReason: { type: String, trim: true, maxlength: [1000, 'Too long'], default: '' },
    cancelledAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    enrolments: { type: [enrolmentSchema], default: [] },

    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true }
);

// Nobody may hold two places on one cohort, waitlist included.
trainingCohortSchema.index({ _id: 1, 'enrolments.staff': 1 });

trainingCohortSchema.index({ status: 1, startDate: 1 });
trainingCohortSchema.index({ academicYear: 1, competency: 1 });
trainingCohortSchema.index({ 'enrolments.staff': 1, startDate: -1 });
// A course code is optional, so the uniqueness has to be partial or every
// cohort without one would collide. Filtered with `$gt: ''` rather than
// `$ne: ''` — MongoDB refuses a negation inside a partialFilterExpression, and
// any non-empty string sorts above the empty one.
trainingCohortSchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { code: { $type: 'string', $gt: '' } } }
);

trainingCohortSchema.pre('validate', function checkShape() {
  if (this.endDate && this.startDate && this.endDate < this.startDate) {
    this.invalidate('endDate', 'A cohort cannot end before it starts');
  }

  if (
    this.enrolmentClosesOn &&
    this.startDate &&
    this.enrolmentClosesOn > this.startDate
  ) {
    this.invalidate('enrolmentClosesOn', 'Enrolment cannot close after the session starts');
  }

  // Capacity may be raised but never lowered below the seats already held.
  // Turfing somebody out of a chair by editing a number is not a thing this
  // model allows — that has to be a withdrawal, with a name on it.
  if (this.seatCapacity < this.seatsTaken) {
    this.invalidate(
      'seatCapacity',
      `${this.seatsTaken} seat(s) are already taken; capacity cannot go below that. ` +
        `Withdraw somebody instead.`
    );
  }

  const seated = this.enrolments.filter((row) => SEATED_STATES.includes(row.state)).length;
  if (seated > this.seatCapacity) {
    this.invalidate('enrolments', 'More people hold seats than the room has chairs');
  }

  const holders = this.enrolments
    .filter((row) => row.state !== 'withdrawn')
    .map((row) => String(row.staff));

  if (new Set(holders).size !== holders.length) {
    this.invalidate('enrolments', 'Somebody holds two places on this cohort');
  }
});

trainingCohortSchema.pre('save', function guardCohort() {
  if (!this.isNew && this.isModified('creditHours') && UNDER_WAY_STATUSES.includes(this.status)) {
    throw new Error('Credit hours cannot change once the cohort has started');
  }

  if (this.status === 'completed' && this.isModified('status')) {
    this.completedAt = this.completedAt || new Date();
  }
});

trainingCohortSchema.virtual('seatsLeft').get(function seatsLeft() {
  return Math.max(0, this.seatCapacity - this.seatsTaken);
});

trainingCohortSchema.virtual('startsAt').get(function startsAt() {
  return toDateTime(this.startDate, this.startTime);
});

trainingCohortSchema.virtual('hasStarted').get(function hasStarted() {
  const start = toDateTime(this.startDate, this.startTime);
  return Boolean(start) && start <= new Date();
});

trainingCohortSchema.set('toJSON', { virtuals: true });
trainingCohortSchema.set('toObject', { virtuals: true });

/**
 * Why this person may not enrol, or null if they may. A sentence rather than a
 * boolean, because every one of these is worth saying out loud.
 */
trainingCohortSchema.methods.enrolmentError = function enrolmentError(now = new Date()) {
  if (this.status === 'cancelled') return 'This session has been cancelled.';
  if (this.status === 'draft') return 'This session has not been published yet.';
  if (UNDER_WAY_STATUSES.includes(this.status)) return 'This session has already run.';
  if (this.status === 'closed') return 'Enrolment for this session has closed.';

  const today = now.toISOString().slice(0, 10);

  if (this.enrolmentOpensOn && today < this.enrolmentOpensOn) {
    return `Enrolment opens on ${this.enrolmentOpensOn}.`;
  }
  if (this.enrolmentClosesOn && today > this.enrolmentClosesOn) {
    return `Enrolment closed on ${this.enrolmentClosesOn}.`;
  }
  if (this.hasStarted) return 'This session has already started.';

  return null;
};

trainingCohortSchema.methods.findEnrolment = function findEnrolment(staffId) {
  const wanted = String(staffId);
  return (
    this.enrolments.find(
      (row) => String(row.staff) === wanted && row.state !== 'withdrawn'
    ) || null
  );
};

trainingCohortSchema.methods.waitlist = function waitlist() {
  return this.enrolments
    .filter((row) => row.state === 'waitlisted')
    .sort((a, b) => a.position - b.position);
};

/**
 * Where somebody would be in the queue if they joined it now. Shown on the
 * button, so nobody has to guess whether joining is worth doing.
 */
trainingCohortSchema.methods.nextWaitlistPlace = function nextWaitlistPlace() {
  return this.waitlist().length + 1;
};

/**
 * Whether a withdrawal at this moment counts against the person.
 */
trainingCohortSchema.methods.isLateWithdrawal = function isLateWithdrawal(now = new Date()) {
  const start = toDateTime(this.startDate, this.startTime);
  if (!start) return false;

  const hoursUntil = (start - now) / (60 * 60 * 1000);

  return hoursUntil < this.withdrawalCutoffHours;
};

trainingCohortSchema.methods.log = function log(action, actor, note = '') {
  this.history.push({
    action,
    by: actor ? actor._id : undefined,
    byName: (actor && actor.name) || '',
    at: new Date(),
    note,
  });

  return this;
};

trainingCohortSchema.methods.tally = function tally() {
  const count = (state) => this.enrolments.filter((row) => row.state === state).length;

  return {
    seatCapacity: this.seatCapacity,
    seatsTaken: this.seatsTaken,
    seatsLeft: Math.max(0, this.seatCapacity - this.seatsTaken),
    enrolled: count('enrolled'),
    waitlisted: count('waitlisted'),
    withdrawn: count('withdrawn'),
    lateWithdrawals: this.enrolments.filter((row) => row.lateWithdrawal).length,
    attended: count('attended'),
    noShow: count('no-show'),
    creditAwarded: this.enrolments.reduce((sum, row) => sum + (row.creditAwarded || 0), 0),
  };
};

/**
 * The register a facilitator reads out, in a sensible order.
 */
trainingCohortSchema.methods.register = function register() {
  const order = { enrolled: 0, attended: 1, 'no-show': 2, waitlisted: 3, withdrawn: 4 };

  return this.enrolments
    .slice()
    .sort(
      (a, b) =>
        (order[a.state] ?? 9) - (order[b.state] ?? 9) ||
        a.position - b.position ||
        new Date(a.joinedAt) - new Date(b.joinedAt)
    )
    .map((row) => ({
      staff: row.staff,
      staffName: row.staffName,
      staffRole: row.staffRole,
      department: row.department,
      state: row.state,
      position: row.state === 'waitlisted' ? row.position : null,
      joinedAt: row.joinedAt,
      promotedAt: row.promotedAt,
      withdrawnAt: row.withdrawnAt,
      lateWithdrawal: row.lateWithdrawal,
      attendanceMarkedAt: row.attendanceMarkedAt,
      creditAwarded: row.creditAwarded,
    }));
};

trainingCohortSchema.statics.COHORT_STATUSES = COHORT_STATUSES;
trainingCohortSchema.statics.UNDER_WAY_STATUSES = UNDER_WAY_STATUSES;
trainingCohortSchema.statics.PLANNING_STATUSES = PLANNING_STATUSES;
trainingCohortSchema.statics.ENROLMENT_STATES = ENROLMENT_STATES;
trainingCohortSchema.statics.SEATED_STATES = SEATED_STATES;
trainingCohortSchema.statics.TRAINING_TYPES = TRAINING_TYPES;
trainingCohortSchema.statics.COMPETENCIES = COMPETENCIES;
trainingCohortSchema.statics.MODES = MODES;
trainingCohortSchema.statics.MAX_SEATS = MAX_SEATS;
trainingCohortSchema.statics.DEFAULT_WITHDRAWAL_CUTOFF_HOURS = DEFAULT_WITHDRAWAL_CUTOFF_HOURS;
trainingCohortSchema.statics.toDateTime = toDateTime;

module.exports = mongoose.model('TrainingCohort', trainingCohortSchema);
