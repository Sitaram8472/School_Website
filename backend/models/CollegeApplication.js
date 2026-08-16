const mongoose = require('mongoose');

/**
 * College applications, deadlines, and the references the school writes.
 *
 * Three rules carry the module, and each of them is enforcement rather than a
 * feature:
 *
 *   The student owns the request; the referee owns the letter; the student
 *     never reads it. `letterBody`, `strengthRating` and `recommendationLevel`
 *     are stripped by `toStudentView()` — one serializer, so there is exactly
 *     one place the confidentiality could be got wrong instead of one place per
 *     endpoint. A reference the subject can read is not a reference, which
 *     teachers know, which is why an openly-visible one says nothing useful.
 *
 *   Deadline state is derived on every read. `upcoming`, `due-soon`,
 *     `due-today`, `overdue`, `met`. From that, the counsellor's at-risk list —
 *     every application in the cohort closing inside a fortnight with
 *     requirements or references outstanding — is one indexed query, and it
 *     currently cannot be produced in any form.
 *
 *   One firm acceptance per student per cohort year, enforced by a partial
 *     unique index. Enforcing it in application code means enforcing it until
 *     two requests arrive together.
 */

const APPLICATION_LEVELS = ['undergraduate', 'diploma', 'certificate', 'foundation'];

const APPLICATION_TYPES = [
  'early-decision',
  'early-action',
  'regular',
  'rolling',
  'direct',
];

const APPLICATION_STATUSES = [
  'researching',
  'in-progress',
  'submitted',
  'interview',
  'offer',
  'conditional-offer',
  'rejected',
  'waitlisted',
  'withdrawn',
  'accepted',
  'declined-offer',
];

// A status in one of these has left the student's hands. The deadline stops
// mattering and the application stops appearing on the at-risk list.
const SUBMITTED_STATUSES = [
  'submitted',
  'interview',
  'offer',
  'conditional-offer',
  'rejected',
  'waitlisted',
  'accepted',
  'declined-offer',
];

// A status in one of these is finished with; nothing more is chased.
const CLOSED_STATUSES = ['rejected', 'withdrawn', 'declined-offer'];

const PRIORITIES = ['dream', 'target', 'safety'];

const REQUIREMENT_KINDS = [
  'transcript',
  'test-score',
  'essay',
  'portfolio',
  'fee',
  'form',
  'interview',
  'other',
];

const REQUIREMENT_STATUSES = ['outstanding', 'in-progress', 'done', 'waived'];

const REFEREE_RELATIONSHIPS = [
  'class-teacher',
  'subject-teacher',
  'counsellor',
  'head',
  'coach',
  'mentor',
];

const REFERENCE_STATUSES = [
  'requested',
  'accepted',
  'declined',
  'submitted',
  'withdrawn',
  'expired',
];

// A reference in one of these states is still expected to arrive, so it counts
// as outstanding against the deadline.
const PENDING_REFERENCE_STATUSES = ['requested', 'accepted'];

const RECOMMENDATION_LEVELS = [
  'reservations',
  'recommend',
  'strongly-recommend',
  'unreservedly-recommend',
];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_PATTERN = /^\d{4}-\d{2}$/;

// An application closing inside this many days with anything outstanding is
// on the at-risk list.
const AT_RISK_DAYS = 14;
const DUE_SOON_DAYS = 7;

const MAX_REFERENCES_PER_APPLICATION = 4;
const MAX_REQUIREMENTS = 20;

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

const referenceRequestSchema = new mongoose.Schema(
  {
    referee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A reference request must name a referee'],
    },
    refereeName: {
      type: String,
      trim: true,
    },
    relationship: {
      type: String,
      required: [true, 'How the referee knows the student is required'],
      enum: {
        values: REFEREE_RELATIONSHIPS,
        message: 'Invalid relationship',
      },
    },
    requestedAt: {
      type: Date,
      default: Date.now,
    },
    dueBy: {
      type: String,
      match: [DATE_PATTERN, 'Due date must be in YYYY-MM-DD format'],
      default: null,
    },
    status: {
      type: String,
      enum: {
        values: REFERENCE_STATUSES,
        message: 'Invalid reference status',
      },
      default: 'requested',
    },
    respondedAt: {
      type: Date,
      default: null,
    },
    declineReason: {
      type: String,
      trim: true,
      maxlength: [500, 'Decline reason cannot exceed 500 characters'],
      default: null,
    },
    submittedAt: {
      type: Date,
      default: null,
    },
    // Where the institution says it received it. Useful to the student; the
    // letter itself is not.
    submissionRef: {
      type: String,
      trim: true,
      maxlength: [120, 'Submission reference cannot exceed 120 characters'],
      default: null,
    },

    // --- Confidential. Never serialised to the student, at any endpoint. -----
    letterBody: {
      type: String,
      trim: true,
      maxlength: [8000, 'A reference cannot exceed 8000 characters'],
      default: null,
    },
    strengthRating: {
      type: Number,
      min: [1, 'Rating runs from 1 to 5'],
      max: [5, 'Rating runs from 1 to 5'],
      default: null,
    },
    recommendationLevel: {
      type: String,
      enum: {
        values: RECOMMENDATION_LEVELS,
        message: 'Invalid recommendation level',
      },
      default: null,
    },
  },
  { _id: true }
);

const requirementSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      required: [true, 'A requirement needs a label'],
      trim: true,
      maxlength: [120, 'Label cannot exceed 120 characters'],
    },
    kind: {
      type: String,
      enum: {
        values: REQUIREMENT_KINDS,
        message: 'Invalid requirement kind',
      },
      default: 'other',
    },
    isRequired: {
      type: Boolean,
      default: true,
    },
    status: {
      type: String,
      enum: {
        values: REQUIREMENT_STATUSES,
        message: 'Invalid requirement status',
      },
      default: 'outstanding',
    },
    completedOn: {
      type: String,
      match: [DATE_PATTERN, 'Completion date must be in YYYY-MM-DD format'],
      default: null,
    },
    note: {
      type: String,
      trim: true,
      maxlength: [500, 'Note cannot exceed 500 characters'],
      default: null,
    },
  },
  { _id: true }
);

const counsellorNoteSchema = new mongoose.Schema(
  {
    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: [2000, 'A note cannot exceed 2000 characters'],
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
  { _id: true }
);

const historySchema = new mongoose.Schema(
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

const collegeApplicationSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'An application must belong to a student'],
      index: true,
    },
    studentName: {
      type: String,
      trim: true,
    },
    cohortYear: {
      type: String,
      required: [true, 'Cohort year is required'],
      trim: true,
      match: [YEAR_PATTERN, 'Cohort year must look like 2026-27'],
      index: true,
    },
    institution: {
      type: String,
      required: [true, 'The institution is required'],
      trim: true,
      maxlength: [160, 'Institution cannot exceed 160 characters'],
    },
    country: {
      type: String,
      trim: true,
      maxlength: [80, 'Country cannot exceed 80 characters'],
      default: null,
    },
    programme: {
      type: String,
      required: [true, 'The programme is required'],
      trim: true,
      maxlength: [160, 'Programme cannot exceed 160 characters'],
    },
    level: {
      type: String,
      enum: {
        values: APPLICATION_LEVELS,
        message: 'Invalid level',
      },
      default: 'undergraduate',
    },
    applicationType: {
      type: String,
      enum: {
        values: APPLICATION_TYPES,
        message: 'Invalid application type',
      },
      default: 'regular',
    },
    priority: {
      type: String,
      enum: {
        values: PRIORITIES,
        message: 'Invalid priority',
      },
      default: 'target',
    },
    deadline: {
      type: String,
      required: [true, 'A deadline is required'],
      match: [DATE_PATTERN, 'Deadline must be in YYYY-MM-DD format'],
      index: true,
    },
    submittedOn: {
      type: String,
      match: [DATE_PATTERN, 'Submission date must be in YYYY-MM-DD format'],
      default: null,
    },
    portalRef: {
      type: String,
      trim: true,
      maxlength: [120, 'Portal reference cannot exceed 120 characters'],
      default: null,
    },
    status: {
      type: String,
      enum: {
        values: APPLICATION_STATUSES,
        message: 'Invalid status',
      },
      default: 'researching',
      index: true,
    },
    requirements: {
      type: [requirementSchema],
      default: [],
    },
    references: {
      type: [referenceRequestSchema],
      default: [],
    },
    offer: {
      receivedOn: {
        type: String,
        match: [DATE_PATTERN, 'Offer date must be in YYYY-MM-DD format'],
        default: null,
      },
      respondBy: {
        type: String,
        match: [DATE_PATTERN, 'Respond-by must be in YYYY-MM-DD format'],
        default: null,
      },
      conditions: {
        type: String,
        trim: true,
        maxlength: [1000, 'Conditions cannot exceed 1000 characters'],
        default: null,
      },
      scholarshipAmount: {
        type: Number,
        min: [0, 'A scholarship cannot be negative'],
        default: null,
      },
      // The field the partial unique index is built on. True on at most one
      // application per student per cohort year, enforced by the database.
      isFirmAcceptance: {
        type: Boolean,
        default: false,
      },
      acceptedAt: {
        type: Date,
        default: null,
      },
    },
    counsellorNotes: {
      type: [counsellorNoteSchema],
      default: [],
    },
    history: {
      type: [historySchema],
      default: [],
    },
  },
  { timestamps: true }
);

collegeApplicationSchema.index({ student: 1, cohortYear: 1 });
collegeApplicationSchema.index({ cohortYear: 1, deadline: 1, status: 1 });
collegeApplicationSchema.index({ 'references.referee': 1, 'references.status': 1 });

/**
 * One firm acceptance per student per cohort year.
 *
 * Partial, so the index only covers the rows where the flag is actually true —
 * every other application is free to exist. Some boards treat a double firm
 * acceptance as fraud, and it is always a mess; a unique index refuses the
 * second one even when two requests arrive together, which application-level
 * checking does not.
 */
collegeApplicationSchema.index(
  { student: 1, cohortYear: 1, 'offer.isFirmAcceptance': 1 },
  {
    unique: true,
    partialFilterExpression: { 'offer.isFirmAcceptance': true },
    name: 'one_firm_acceptance_per_student_per_year',
  }
);

collegeApplicationSchema.pre('validate', function derive() {
  if (this.requirements.length > MAX_REQUIREMENTS) {
    this.invalidate(
      'requirements',
      `An application cannot list more than ${MAX_REQUIREMENTS} requirements`
    );
  }
  if (this.references.length > MAX_REFERENCES_PER_APPLICATION) {
    this.invalidate(
      'references',
      `An application cannot ask for more than ${MAX_REFERENCES_PER_APPLICATION} references`
    );
  }

  // One referee, once. Asking the same teacher twice for the same application
  // is a mistake in the form, not a second reference.
  const seen = new Set();
  for (const reference of this.references) {
    const key = String(reference.referee);
    if (seen.has(key)) {
      this.invalidate('references', 'That teacher has already been asked for this application');
    }
    seen.add(key);
  }

  if (this.offer.respondBy && this.offer.receivedOn) {
    if (this.offer.respondBy < this.offer.receivedOn) {
      this.invalidate('offer.respondBy', 'The reply date is before the offer date');
    }
  }

  // A firm acceptance is only meaningful against an offer that exists.
  if (this.offer.isFirmAcceptance && !this.offer.receivedOn) {
    this.invalidate(
      'offer.isFirmAcceptance',
      'An acceptance needs an offer to accept'
    );
  }
  if (!this.offer.isFirmAcceptance) {
    this.offer.acceptedAt = null;
  }

  if (!SUBMITTED_STATUSES.includes(this.status)) {
    this.submittedOn = null;
  }

  for (const requirement of this.requirements) {
    if (requirement.status !== 'done') requirement.completedOn = null;
  }
});

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * The deadline as a state rather than a date.
 *
 * Derived on every read. A stored state is one that is right on the day it was
 * written and wrong every day after.
 */
collegeApplicationSchema.methods.deadlineState = function deadlineState(
  today = todayKey()
) {
  if (SUBMITTED_STATUSES.includes(this.status)) {
    return { state: 'met', daysRemaining: null, deadline: this.deadline };
  }
  if (CLOSED_STATUSES.includes(this.status)) {
    return { state: 'closed', daysRemaining: null, deadline: this.deadline };
  }

  const daysRemaining = daysBetween(today, this.deadline);
  let state = 'upcoming';
  if (daysRemaining === null) state = 'unknown';
  else if (daysRemaining < 0) state = 'overdue';
  else if (daysRemaining === 0) state = 'due-today';
  else if (daysRemaining <= DUE_SOON_DAYS) state = 'due-soon';

  return { state, daysRemaining, deadline: this.deadline };
};

/**
 * How ready this application is, and what is outstanding by name.
 *
 * A percentage on its own tells a student they are 60% done. The named list
 * tells them to chase Mrs Rao about the reference.
 */
collegeApplicationSchema.methods.readiness = function readiness() {
  const required = this.requirements.filter((r) => r.isRequired);
  const done = required.filter((r) => ['done', 'waived'].includes(r.status));

  const referencesWanted = this.references.filter(
    (r) => !['withdrawn', 'declined'].includes(r.status)
  );
  const referencesIn = referencesWanted.filter((r) => r.status === 'submitted');

  const outstanding = [
    ...required
      .filter((r) => !['done', 'waived'].includes(r.status))
      .map((r) => ({ kind: 'requirement', label: r.label, status: r.status })),
    ...referencesWanted
      .filter((r) => r.status !== 'submitted')
      .map((r) => ({
        kind: 'reference',
        label: `Reference from ${r.refereeName || 'a teacher'}`,
        status: r.status,
      })),
    // A teacher who will not write is information the student needs in October
    // and not in December, so it is outstanding rather than silently gone.
    ...this.references
      .filter((r) => r.status === 'declined')
      .map((r) => ({
        kind: 'reference',
        label: `${r.refereeName || 'A teacher'} declined — ask somebody else`,
        status: 'declined',
      })),
  ];

  const totalItems = required.length + referencesWanted.length;
  const completedItems = done.length + referencesIn.length;

  return {
    percent: totalItems ? Math.round((completedItems / totalItems) * 100) : 100,
    completedItems,
    totalItems,
    outstanding,
    isComplete: outstanding.length === 0,
  };
};

/** Whether this application counts as at risk on a given day. */
collegeApplicationSchema.methods.isAtRisk = function isAtRisk(today = todayKey()) {
  const deadline = this.deadlineState(today);
  if (!['upcoming', 'due-soon', 'due-today', 'overdue'].includes(deadline.state)) {
    return false;
  }
  if (deadline.daysRemaining !== null && deadline.daysRemaining > AT_RISK_DAYS) {
    return false;
  }
  return !this.readiness().isComplete;
};

collegeApplicationSchema.methods.isOwnedBy = function isOwnedBy(user) {
  if (!user) return false;
  return String(this.student) === String(user._id);
};

/** Why this application cannot be marked submitted, or null when it can. */
collegeApplicationSchema.methods.submittabilityError = function submittabilityError() {
  if (SUBMITTED_STATUSES.includes(this.status)) {
    return 'This application has already gone';
  }
  if (CLOSED_STATUSES.includes(this.status)) {
    return `A ${this.status} application cannot be submitted`;
  }

  const readiness = this.readiness();
  if (!readiness.isComplete) {
    const first = readiness.outstanding[0];
    return `${readiness.outstanding.length} item(s) outstanding — first: ${first.label}`;
  }

  return null;
};

collegeApplicationSchema.methods.recordHistory = function recordHistory(
  action,
  userId,
  note
) {
  this.history.push({ action, by: userId, at: new Date(), note });
  if (this.history.length > 80) this.history = this.history.slice(-80);
};

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * The application as the student may see it.
 *
 * The letter body, the rating, the recommendation level and every counsellor
 * note are removed here — one place, so there is no endpoint that has to
 * remember. The student sees three things about a reference: requested,
 * accepted, submitted. That is the whole point.
 */
collegeApplicationSchema.methods.toStudentView = function toStudentView(
  today = todayKey()
) {
  const base = this.toObject({ depopulate: false });

  base.references = (base.references || []).map((reference) => ({
    _id: reference._id,
    referee: reference.referee,
    refereeName: reference.refereeName,
    relationship: reference.relationship,
    requestedAt: reference.requestedAt,
    dueBy: reference.dueBy,
    status: reference.status,
    respondedAt: reference.respondedAt,
    // A decline is shown, with its reason — the student has to go and ask
    // somebody else, and needs to know that in October.
    declineReason: reference.status === 'declined' ? reference.declineReason : null,
    submittedAt: reference.submittedAt,
    submissionRef: reference.submissionRef,
  }));

  delete base.counsellorNotes;

  base.deadlineState = this.deadlineState(today);
  base.readiness = this.readiness();
  return base;
};

/** The full record, for the student's counsellor and for admins. */
collegeApplicationSchema.methods.toStaffView = function toStaffView(today = todayKey()) {
  const base = this.toObject({ depopulate: false });
  base.deadlineState = this.deadlineState(today);
  base.readiness = this.readiness();
  base.isAtRisk = this.isAtRisk(today);
  return base;
};

/**
 * One reference request, as the referee who was asked may see it.
 *
 * Carries the letter, because it is theirs. Carries nothing about the student's
 * other applications — which colleges a student is applying to is none of a
 * subject teacher's business.
 */
collegeApplicationSchema.methods.toRefereeView = function toRefereeView(reference) {
  return {
    applicationId: this._id,
    referenceId: reference._id,
    student: this.student,
    studentName: this.studentName,
    institution: this.institution,
    programme: this.programme,
    deadline: this.deadline,
    relationship: reference.relationship,
    requestedAt: reference.requestedAt,
    dueBy: reference.dueBy,
    status: reference.status,
    letterBody: reference.letterBody,
    strengthRating: reference.strengthRating,
    recommendationLevel: reference.recommendationLevel,
    submittedAt: reference.submittedAt,
    declineReason: reference.declineReason,
  };
};

/** Mark past-due requests expired, so silence is visible rather than assumed. */
collegeApplicationSchema.methods.expireStaleReferences = function expireStaleReferences(
  today = todayKey()
) {
  let expired = 0;
  for (const reference of this.references) {
    if (!PENDING_REFERENCE_STATUSES.includes(reference.status)) continue;
    if (!reference.dueBy || reference.dueBy >= today) continue;
    reference.status = 'expired';
    expired += 1;
  }
  return expired;
};

collegeApplicationSchema.statics.todayKey = todayKey;
collegeApplicationSchema.statics.daysBetween = daysBetween;
collegeApplicationSchema.statics.APPLICATION_LEVELS = APPLICATION_LEVELS;
collegeApplicationSchema.statics.APPLICATION_TYPES = APPLICATION_TYPES;
collegeApplicationSchema.statics.APPLICATION_STATUSES = APPLICATION_STATUSES;
collegeApplicationSchema.statics.SUBMITTED_STATUSES = SUBMITTED_STATUSES;
collegeApplicationSchema.statics.CLOSED_STATUSES = CLOSED_STATUSES;
collegeApplicationSchema.statics.PRIORITIES = PRIORITIES;
collegeApplicationSchema.statics.REQUIREMENT_KINDS = REQUIREMENT_KINDS;
collegeApplicationSchema.statics.REQUIREMENT_STATUSES = REQUIREMENT_STATUSES;
collegeApplicationSchema.statics.REFEREE_RELATIONSHIPS = REFEREE_RELATIONSHIPS;
collegeApplicationSchema.statics.REFERENCE_STATUSES = REFERENCE_STATUSES;
collegeApplicationSchema.statics.PENDING_REFERENCE_STATUSES = PENDING_REFERENCE_STATUSES;
collegeApplicationSchema.statics.RECOMMENDATION_LEVELS = RECOMMENDATION_LEVELS;
collegeApplicationSchema.statics.AT_RISK_DAYS = AT_RISK_DAYS;
collegeApplicationSchema.statics.MAX_REFERENCES_PER_APPLICATION =
  MAX_REFERENCES_PER_APPLICATION;

module.exports = mongoose.model('CollegeApplication', collegeApplicationSchema);
