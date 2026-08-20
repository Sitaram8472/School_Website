const mongoose = require('mongoose');

/**
 * Exam re-evaluation appeals.
 *
 * The repo already has exams and submissions. What it does not have is the
 * thing that happens next in every real school: a student says the mark is
 * wrong. Today that is an email thread, and it has all the properties you would
 * expect — no deadline, no second reader, and a score edited in place with no
 * record of what it was before.
 *
 * This model fixes the third of those. `originalTotal` is snapshotted when the
 * appeal opens, `revisedTotal` is recomputed from the per-question decisions,
 * and every transition appends to `audit`. The submission's own score is only
 * written by the controller in the same request that appends the corresponding
 * audit row — see `decideAppeal`.
 *
 * The first two are enforced by `windowClosesAt` and by
 * `reviewerEligibilityError` below.
 */

const REASONS = [
  'calculation-error',
  'unmarked-answer',
  'marking-scheme-mismatch',
  'answer-misread',
  'technical-issue',
  'other',
];

const STATUSES = [
  'submitted',
  'under-review',
  'accepted',
  'partially-accepted',
  'rejected',
  'withdrawn',
];

const QUESTION_DECISIONS = ['pending', 'upheld', 'partially-upheld', 'rejected'];

// An appeal in one of these states has not been decided, so it still blocks a
// second appeal against the same submission and may still be withdrawn.
const OPEN_STATUSES = ['submitted', 'under-review'];

// An appeal in one of these states has a recorded outcome.
const DECIDED_STATUSES = ['accepted', 'partially-accepted', 'rejected'];

// How long after a result a student may appeal. A window that can be waived
// per request is not a window, so this is not configurable per appeal — the
// only way past it is an admin reopening a specific appeal, which is audited.
const APPEAL_WINDOW_DAYS = 14;

const MIN_NARRATIVE = 20;
const MAX_NARRATIVE = 2000;
const MAX_DISPUTED_ANSWERS = 30;

const disputedAnswerSchema = new mongoose.Schema(
  {
    questionId: {
      type: mongoose.Schema.Types.ObjectId,
      required: [true, 'A disputed answer must name its question'],
    },
    questionText: {
      type: String,
      trim: true,
      maxlength: [1000, 'Question text cannot exceed 1000 characters'],
    },
    maxMarks: {
      type: Number,
      min: 0,
    },
    awardedMarks: {
      type: Number,
      required: [true, 'The marks originally awarded are required'],
      min: [0, 'Awarded marks cannot be negative'],
    },
    claimedMarks: {
      type: Number,
      required: [true, 'The marks being claimed are required'],
      min: [0, 'Claimed marks cannot be negative'],
    },
    studentNote: {
      type: String,
      trim: true,
      maxlength: [1000, 'Note cannot exceed 1000 characters'],
    },
    // Everything below is the reviewer's, and is never accepted from a student.
    reviewerNote: {
      type: String,
      trim: true,
      maxlength: [1000, 'Reviewer note cannot exceed 1000 characters'],
    },
    revisedMarks: {
      type: Number,
      min: [0, 'Revised marks cannot be negative'],
    },
    decision: {
      type: String,
      enum: {
        values: QUESTION_DECISIONS,
        message: 'Invalid decision',
      },
      default: 'pending',
    },
  },
  { _id: true, timestamps: false }
);

const auditSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: [40, 'Action cannot exceed 40 characters'],
    },
    // `from` and `to` carry whatever the transition changed — a status pair, or
    // a mark pair. Kept as loose strings so one trail can record both.
    from: {
      type: String,
      trim: true,
      maxlength: [80, 'From cannot exceed 80 characters'],
    },
    to: {
      type: String,
      trim: true,
      maxlength: [80, 'To cannot exceed 80 characters'],
    },
    note: {
      type: String,
      trim: true,
      maxlength: [1000, 'Note cannot exceed 1000 characters'],
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

const remarkAppealSchema = new mongoose.Schema(
  {
    submission: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Submission',
      required: [true, 'An appeal must reference a submission'],
    },
    exam: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: [true, 'An appeal must reference an exam'],
    },
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'An appeal must belong to a student'],
    },
    // The person whose marking is being challenged. Snapshotted at creation so
    // the eligibility check does not depend on the exam still existing in its
    // current form.
    originalMarker: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    reason: {
      type: String,
      required: [true, 'A reason is required'],
      enum: {
        values: REASONS,
        message: 'Invalid reason',
      },
    },
    narrative: {
      type: String,
      required: [true, 'Please set out your case'],
      trim: true,
      minlength: [MIN_NARRATIVE, `Please write at least ${MIN_NARRATIVE} characters`],
      maxlength: [MAX_NARRATIVE, `Please keep this under ${MAX_NARRATIVE} characters`],
    },
    disputedAnswers: {
      type: [disputedAnswerSchema],
      default: [],
      validate: {
        validator: (v) => v.length > 0 && v.length <= MAX_DISPUTED_ANSWERS,
        message: `An appeal must dispute between 1 and ${MAX_DISPUTED_ANSWERS} questions`,
      },
    },
    status: {
      type: String,
      enum: {
        values: STATUSES,
        message: 'Invalid status',
      },
      default: 'submitted',
    },
    windowClosesAt: {
      type: Date,
      required: true,
    },
    openedAt: {
      type: Date,
      default: Date.now,
    },
    reviewer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    reviewStartedAt: {
      type: Date,
    },
    decidedAt: {
      type: Date,
    },
    decisionNote: {
      type: String,
      trim: true,
      maxlength: [2000, 'Decision note cannot exceed 2000 characters'],
    },
    // All three are server-derived. `originalTotal` is a snapshot so that a
    // later unrelated change to the submission cannot make the delta lie.
    originalTotal: {
      type: Number,
      required: true,
      min: 0,
    },
    revisedTotal: {
      type: Number,
      min: 0,
    },
    marksDelta: {
      type: Number,
      default: 0,
    },
    audit: {
      type: [auditSchema],
      default: [],
    },
  },
  { timestamps: true }
);

remarkAppealSchema.index({ student: 1, createdAt: -1 });
remarkAppealSchema.index({ status: 1, createdAt: 1 });
remarkAppealSchema.index({ reviewer: 1, status: 1 });
// One open appeal per submission is enforced in the controller rather than by a
// unique index, because a decided appeal must not block a later admin reopen.
remarkAppealSchema.index({ submission: 1, status: 1 });

remarkAppealSchema.pre('validate', async function derive() {
  for (const answer of this.disputedAnswers || []) {
    // An appeal asking for fewer marks is a mis-click, every time.
    if (
      Number.isFinite(answer.claimedMarks) &&
      Number.isFinite(answer.awardedMarks) &&
      answer.claimedMarks <= answer.awardedMarks
    ) {
      this.invalidate(
        'disputedAnswers',
        'Each disputed question must claim more marks than it was awarded'
      );
    }

    if (
      Number.isFinite(answer.maxMarks) &&
      Number.isFinite(answer.claimedMarks) &&
      answer.claimedMarks > answer.maxMarks
    ) {
      this.invalidate(
        'disputedAnswers',
        `A question worth ${answer.maxMarks} marks cannot be claimed at ${answer.claimedMarks}`
      );
    }

    if (
      Number.isFinite(answer.revisedMarks) &&
      Number.isFinite(answer.maxMarks) &&
      (answer.revisedMarks < 0 || answer.revisedMarks > answer.maxMarks)
    ) {
      this.invalidate(
        'disputedAnswers',
        `Revised marks must be between 0 and ${answer.maxMarks}`
      );
    }
  }

  this.recomputeTotals();

  if (!DECIDED_STATUSES.includes(this.status)) {
    this.decidedAt = undefined;
  }
});

/**
 * The revised total is the original, plus the movement on every question where
 * the reviewer has actually set a mark. A question left `pending` contributes
 * nothing, so a half-finished review reports the score as it stands rather than
 * as it might become.
 */
remarkAppealSchema.methods.recomputeTotals = function recomputeTotals() {
  let delta = 0;
  let anyRevised = false;

  for (const answer of this.disputedAnswers || []) {
    if (!Number.isFinite(answer.revisedMarks)) continue;
    anyRevised = true;
    delta += answer.revisedMarks - answer.awardedMarks;
  }

  if (!anyRevised) {
    this.revisedTotal = undefined;
    this.marksDelta = 0;
    return;
  }

  const revised = Math.max((this.originalTotal || 0) + delta, 0);
  this.revisedTotal = revised;
  this.marksDelta = revised - (this.originalTotal || 0);
};

remarkAppealSchema.methods.isOpen = function isOpen() {
  return OPEN_STATUSES.includes(this.status);
};

remarkAppealSchema.methods.isDecided = function isDecided() {
  return DECIDED_STATUSES.includes(this.status);
};

remarkAppealSchema.methods.isOwnedBy = function isOwnedBy(user) {
  if (!user) return false;
  return String(this.student) === String(user._id);
};

/**
 * Why `candidate` may not review this appeal, or null when they may.
 *
 * This is the rule the whole feature exists for. A school with one physics
 * teacher has to send it to the head of department, and that is the correct
 * outcome rather than an inconvenience to route around — so there is no flag.
 */
remarkAppealSchema.methods.reviewerEligibilityError =
  function reviewerEligibilityError(candidate) {
    if (!candidate) return 'Not authenticated';

    if (String(this.student) === String(candidate._id)) {
      return 'A student cannot review their own appeal';
    }

    if (this.originalMarker && String(this.originalMarker) === String(candidate._id)) {
      return 'You marked this submission, so somebody else must review the appeal';
    }

    return null;
  };

/** Days left in the appeal window, negative once it has closed. */
remarkAppealSchema.methods.daysRemaining = function daysRemaining(now = new Date()) {
  if (!this.windowClosesAt) return null;
  return Math.ceil((this.windowClosesAt.getTime() - now.getTime()) / 86400000);
};

remarkAppealSchema.methods.recordAudit = function recordAudit(entry) {
  this.audit.push({
    action: entry.action,
    from: entry.from === undefined || entry.from === null ? undefined : String(entry.from),
    to: entry.to === undefined || entry.to === null ? undefined : String(entry.to),
    note: entry.note,
    by: entry.by,
    at: new Date(),
  });
};

remarkAppealSchema.methods.toRow = function toRow(now = new Date()) {
  return {
    _id: this._id,
    submission: this.submission,
    exam: this.exam,
    student: this.student,
    originalMarker: this.originalMarker,
    reason: this.reason,
    narrative: this.narrative,
    disputedAnswers: this.disputedAnswers,
    status: this.status,
    windowClosesAt: this.windowClosesAt,
    daysRemaining: this.daysRemaining(now),
    openedAt: this.openedAt,
    reviewer: this.reviewer,
    reviewStartedAt: this.reviewStartedAt,
    decidedAt: this.decidedAt,
    decisionNote: this.decisionNote,
    originalTotal: this.originalTotal,
    revisedTotal: this.revisedTotal ?? null,
    marksDelta: this.marksDelta,
    isOpen: this.isOpen(),
    isDecided: this.isDecided(),
    createdAt: this.createdAt,
  };
};

/**
 * When the window closes for a result published at `resultAt`.
 */
remarkAppealSchema.statics.windowFor = function windowFor(resultAt) {
  const base = resultAt instanceof Date ? resultAt : new Date(resultAt);
  if (Number.isNaN(base.getTime())) return null;
  return new Date(base.getTime() + APPEAL_WINDOW_DAYS * 86400000);
};

remarkAppealSchema.statics.REASONS = REASONS;
remarkAppealSchema.statics.STATUSES = STATUSES;
remarkAppealSchema.statics.QUESTION_DECISIONS = QUESTION_DECISIONS;
remarkAppealSchema.statics.OPEN_STATUSES = OPEN_STATUSES;
remarkAppealSchema.statics.DECIDED_STATUSES = DECIDED_STATUSES;
remarkAppealSchema.statics.APPEAL_WINDOW_DAYS = APPEAL_WINDOW_DAYS;
remarkAppealSchema.statics.MAX_DISPUTED_ANSWERS = MAX_DISPUTED_ANSWERS;

module.exports = mongoose.model('RemarkAppeal', remarkAppealSchema);
