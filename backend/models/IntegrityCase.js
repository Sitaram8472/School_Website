const mongoose = require('mongoose');

/**
 * An academic-integrity case against one exam submission.
 *
 * `Submission.cheatWarnings` already counts tab-switches, and SubmissionList
 * renders the count as a red chip. That is telemetry, not a finding: three
 * tab-switches might be a phone call from home or a second window with the
 * answers in it, and the count asserts they are the same thing.
 *
 * What was missing is the case — a stated allegation, a reply from the student,
 * a decision by somebody who was not the accuser, and an outcome applied once
 * and never quietly edited afterwards.
 */

const ALLEGATIONS = [
  'tab-switching',
  'impersonation',
  'unauthorised-material',
  'collusion',
  'answer-similarity',
  'disallowed-device',
  'other',
];

const EVIDENCE_KINDS = [
  'warning-count',
  'timing-anomaly',
  'invigilator-note',
  'similarity',
  'other',
];

const SEVERITIES = ['minor', 'moderate', 'serious'];

const CASE_STATUSES = [
  'open',
  'awaiting-response',
  'under-review',
  'upheld',
  'dismissed',
  'withdrawn',
];

// Statuses in which the case is still live. A case is only "open" for the
// purpose of the one-case-per-submission rule while it is one of these.
const LIVE_STATUSES = ['open', 'awaiting-response', 'under-review'];

const OUTCOMES = [
  'no-action',
  'warning-recorded',
  'partial-penalty',
  'score-void',
  'resit-required',
];

// Outcomes that change the recorded score. Everything else leaves the
// submission byte-identical.
const SCORE_CHANGING_OUTCOMES = ['partial-penalty', 'score-void'];

const DEFAULT_RESPONSE_DAYS = 5;

const evidenceSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: {
        values: EVIDENCE_KINDS,
        message: 'Invalid evidence kind',
      },
      required: [true, 'Evidence kind is required'],
    },
    detail: {
      type: String,
      required: [true, 'Evidence detail is required'],
      trim: true,
      maxlength: [500, 'Evidence detail cannot exceed 500 characters'],
    },
    capturedAt: {
      type: Date,
      default: Date.now,
    },
    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'The person adding the evidence is required'],
    },
    addedByName: {
      type: String,
      trim: true,
      default: '',
    },
  },
  { _id: false }
);

const historyEntrySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: [40, 'History action cannot exceed 40 characters'],
    },
    by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    byName: {
      type: String,
      trim: true,
      maxlength: [100, 'History actor name cannot exceed 100 characters'],
      default: '',
    },
    at: {
      type: Date,
      default: Date.now,
    },
    note: {
      type: String,
      trim: true,
      maxlength: [400, 'History note cannot exceed 400 characters'],
      default: '',
    },
  },
  { _id: false }
);

const integrityCaseSchema = new mongoose.Schema(
  {
    // Server-issued and printed on anything the student is shown. Derived from
    // the document id the way FeeInvoice derives its invoice number, so no
    // counter collection is needed for a reference that only has to be
    // readable and unique.
    caseRef: {
      type: String,
      unique: true,
      trim: true,
    },

    submission: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Submission',
      required: [true, 'The submission under review is required'],
    },

    exam: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: [true, 'Exam is required'],
    },

    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Student is required'],
    },

    examTitle: {
      type: String,
      trim: true,
      default: '',
    },

    studentName: {
      type: String,
      trim: true,
      default: '',
    },

    allegation: {
      type: String,
      enum: {
        values: ALLEGATIONS,
        message: 'Invalid allegation',
      },
      required: [true, 'An allegation is required'],
    },

    // What was actually observed. A minimum length because "cheating" is an
    // accusation, not an observation, and a case built on it cannot be answered.
    narrative: {
      type: String,
      required: [true, 'Describe what was observed'],
      trim: true,
      minlength: [20, 'Describe what was observed in at least 20 characters'],
      maxlength: [2000, 'Narrative cannot exceed 2000 characters'],
    },

    evidence: {
      type: [evidenceSchema],
      default: [],
    },

    // Snapshot. The live counter on the submission can still move; this one is
    // the number the case was opened on.
    warningCountAtOpen: {
      type: Number,
      default: 0,
      min: [0, 'Warning count cannot be negative'],
    },

    severityClaimed: {
      type: String,
      enum: {
        values: SEVERITIES,
        message: 'Invalid severity',
      },
      default: 'moderate',
    },

    status: {
      type: String,
      enum: {
        values: CASE_STATUSES,
        message: 'Invalid case status',
      },
      default: 'open',
    },

    openedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'The person opening the case is required'],
    },

    openedAt: {
      type: Date,
      default: Date.now,
    },

    respondByDate: {
      type: Date,
      required: [true, 'A date by which the student may reply is required'],
    },

    studentResponse: {
      text: {
        type: String,
        trim: true,
        maxlength: [2000, 'A response cannot exceed 2000 characters'],
        default: '',
      },
      submittedAt: {
        type: Date,
        default: null,
      },
      // Stored rather than used to discard the reply. A late answer is still
      // an answer; pretending it never arrived is the same error in a coat.
      wasLate: {
        type: Boolean,
        default: false,
      },
    },

    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    reviewedAt: {
      type: Date,
      default: null,
    },

    decisionNote: {
      type: String,
      trim: true,
      maxlength: [1000, 'Decision note cannot exceed 1000 characters'],
      default: '',
    },

    // Recorded when a case is decided without the student having answered, so
    // the record says so rather than implying they were heard.
    decidedWithoutResponse: {
      type: Boolean,
      default: false,
    },

    outcome: {
      type: String,
      enum: {
        values: OUTCOMES,
        message: 'Invalid outcome',
      },
      default: null,
    },

    penaltyPercent: {
      type: Number,
      min: [1, 'A partial penalty must remove at least 1%'],
      max: [100, 'A partial penalty cannot exceed 100%'],
      default: null,
    },

    // The before/after pair is what makes the change explicable a year later.
    // A score of 0 with no record of what it was before is indistinguishable
    // from a student who genuinely scored nothing.
    scoreBeforeOutcome: {
      type: Number,
      default: null,
    },

    scoreAfterOutcome: {
      type: Number,
      default: null,
    },

    outcomeAppliedAt: {
      type: Date,
      default: null,
    },

    // A reversal is a new case pointing back at the old one, never an edit.
    supersedes: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'IntegrityCase',
      default: null,
    },

    // Derived from `status`. A unique partial index cannot express a negation,
    // so the boolean is what the index filters on.
    isOpen: {
      type: Boolean,
      default: true,
    },

    history: {
      type: [historyEntrySchema],
      default: [],
    },
  },
  { timestamps: true }
);

/**
 * One live case per submission.
 *
 * Enforced at the database rather than by a read-then-write check, because the
 * duplicate this exists to stop is two teachers opening a case on the same
 * submission at the same moment. The second one should be adding evidence to
 * the first case, not starting a parallel proceeding.
 */
integrityCaseSchema.index(
  { submission: 1 },
  { unique: true, partialFilterExpression: { isOpen: true } }
);

integrityCaseSchema.index({ status: 1, respondByDate: 1 });
integrityCaseSchema.index({ student: 1, openedAt: -1 });
integrityCaseSchema.index({ exam: 1, openedAt: -1 });

integrityCaseSchema.pre('validate', function () {
  if (!this.caseRef) {
    const now = this.openedAt || new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    this.caseRef = `INT/${month}/${this._id.toString().slice(-6).toUpperCase()}`;
  }

  if (!this.respondByDate) {
    const from = this.openedAt || new Date();
    this.respondByDate = new Date(from.getTime() + DEFAULT_RESPONSE_DAYS * 24 * 60 * 60 * 1000);
  }
});

integrityCaseSchema.pre('save', function () {
  this.isOpen = LIVE_STATUSES.includes(this.status);

  if (this.outcome === 'partial-penalty' && !(this.penaltyPercent > 0)) {
    throw new Error('A partial penalty needs a penalty percent');
  }
  if (this.outcome && this.outcome !== 'partial-penalty') {
    this.penaltyPercent = null;
  }

  if (this.reviewedBy && this.openedBy && this.reviewedBy.equals(this.openedBy)) {
    throw new Error('A case cannot be decided by the person who opened it');
  }
  if (this.reviewedBy && this.student && this.reviewedBy.equals(this.student)) {
    throw new Error('A student cannot decide their own case');
  }

  // Once a decision has been applied, the case is the record of that decision.
  // Reversing it means opening a new case that supersedes this one.
  if (!this.isNew && this.outcomeAppliedAt) {
    const frozen = ['allegation', 'outcome', 'penaltyPercent', 'scoreBeforeOutcome', 'submission'];
    const edited = frozen.find((field) => this.isModified(field));

    if (edited) {
      throw new Error(`"${edited}" cannot be changed once the outcome has been applied`);
    }
  }
});

integrityCaseSchema.methods.log = function (action, actor, note = '') {
  this.history.push({
    action,
    by: actor ? actor._id : undefined,
    byName: (actor && actor.name) || '',
    at: new Date(),
    note,
  });

  return this;
};

integrityCaseSchema.methods.addEvidence = function (actor, { kind, detail, capturedAt }) {
  if (!this.isOpen) {
    throw new Error('Evidence cannot be added to a closed case');
  }
  if (!EVIDENCE_KINDS.includes(kind)) {
    throw new Error(`Evidence kind must be one of: ${EVIDENCE_KINDS.join(', ')}`);
  }
  if (!detail || !String(detail).trim()) {
    throw new Error('Evidence needs a detail');
  }

  this.evidence.push({
    kind,
    detail: String(detail).trim(),
    capturedAt: capturedAt ? new Date(capturedAt) : new Date(),
    addedBy: actor._id,
    addedByName: actor.name || '',
  });

  return this.log('evidence-added', actor, kind);
};

/**
 * The student's answer. Only the student may write it, it may only be written
 * once, and lateness is recorded rather than punished by refusal.
 */
integrityCaseSchema.methods.recordResponse = function (actor, text) {
  if (!actor._id.equals(this.student)) {
    throw new Error('Only the student named in the case may answer it');
  }
  if (!this.isOpen) {
    throw new Error('This case has already been decided');
  }
  if (this.studentResponse && this.studentResponse.submittedAt) {
    throw new Error('A response has already been recorded for this case');
  }
  if (!text || String(text).trim().length < 10) {
    throw new Error('Write at least a sentence in reply');
  }

  const now = new Date();

  this.studentResponse = {
    text: String(text).trim(),
    submittedAt: now,
    wasLate: now.getTime() > this.respondByDate.getTime(),
  };

  this.status = 'under-review';

  return this.log('response-recorded', actor, this.studentResponse.wasLate ? 'late' : 'on time');
};

/**
 * Has the student had their chance?
 *
 * Either they answered, or the window they were given has closed. A decision
 * taken before both is the thing that gets overturned the moment a parent
 * escalates it.
 */
integrityCaseSchema.methods.responseWindowClosed = function () {
  if (this.studentResponse && this.studentResponse.submittedAt) return true;
  return this.respondByDate.getTime() <= Date.now();
};

/**
 * What the submission's score becomes under a given outcome. Pure, so the UI
 * can show the result before anyone commits to it.
 */
integrityCaseSchema.methods.projectedScore = function (currentScore, outcome, penaltyPercent) {
  const score = Number(currentScore) || 0;

  if (outcome === 'score-void') return 0;
  if (outcome === 'partial-penalty') {
    return Math.round(score * (1 - (Number(penaltyPercent) || 0) / 100));
  }

  return score;
};

integrityCaseSchema.methods.decide = function (actor, { outcome, penaltyPercent, note }) {
  if (!this.isOpen) {
    throw new Error(`This case is already ${this.status}`);
  }
  if (actor._id.equals(this.openedBy)) {
    throw new Error('A case cannot be decided by the person who opened it');
  }
  if (actor._id.equals(this.student)) {
    throw new Error('A student cannot decide their own case');
  }
  if (!OUTCOMES.includes(outcome)) {
    throw new Error(`Outcome must be one of: ${OUTCOMES.join(', ')}`);
  }
  if (!this.responseWindowClosed()) {
    throw new Error(
      'The student has not answered and their response window is still open. ' +
        `It closes on ${this.respondByDate.toISOString().slice(0, 10)}.`
    );
  }
  if (outcome === 'partial-penalty' && !(Number(penaltyPercent) > 0)) {
    throw new Error('A partial penalty needs a penalty percent above zero');
  }

  const answered = Boolean(this.studentResponse && this.studentResponse.submittedAt);

  this.outcome = outcome;
  this.penaltyPercent = outcome === 'partial-penalty' ? Number(penaltyPercent) : null;
  this.decisionNote = String(note || '').trim();
  this.reviewedBy = actor._id;
  this.reviewedAt = new Date();
  this.decidedWithoutResponse = !answered;
  this.status = outcome === 'no-action' ? 'dismissed' : 'upheld';

  return this.log('decided', actor, outcome);
};

integrityCaseSchema.methods.withdraw = function (actor, reason) {
  if (!actor._id.equals(this.openedBy) && actor.role !== 'admin') {
    throw new Error('Only the person who opened the case, or an admin, may withdraw it');
  }
  if (!this.isOpen) {
    throw new Error(`This case is already ${this.status}`);
  }
  if (this.studentResponse && this.studentResponse.submittedAt) {
    throw new Error('The student has already answered; the case has to be decided, not withdrawn');
  }

  this.status = 'withdrawn';

  return this.log('withdrawn', actor, String(reason || '').trim());
};

integrityCaseSchema.statics.ALLEGATIONS = ALLEGATIONS;
integrityCaseSchema.statics.EVIDENCE_KINDS = EVIDENCE_KINDS;
integrityCaseSchema.statics.SEVERITIES = SEVERITIES;
integrityCaseSchema.statics.STATUSES = CASE_STATUSES;
integrityCaseSchema.statics.LIVE_STATUSES = LIVE_STATUSES;
integrityCaseSchema.statics.OUTCOMES = OUTCOMES;
integrityCaseSchema.statics.SCORE_CHANGING_OUTCOMES = SCORE_CHANGING_OUTCOMES;
integrityCaseSchema.statics.DEFAULT_RESPONSE_DAYS = DEFAULT_RESPONSE_DAYS;

module.exports = mongoose.model('IntegrityCase', integrityCaseSchema);
