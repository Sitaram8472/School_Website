const mongoose = require('mongoose');

/**
 * Whether a student moves up at the end of the year.
 *
 * It is the highest-stakes routine decision a school makes, it is made for
 * every child at once in a compressed window, and it is the only major academic
 * process with no representation in this repository at all.
 *
 * Everything the decision depends on is already here. `Submission` holds scores
 * against `Exam`, `Attendance` holds the registers, `Course` links students to
 * subjects, and `reportController` already gathers a student's results into a
 * document. The inputs exist; the decision does not. So `className` on `User`
 * is a free string nothing ever changes, the criteria live in a staff meeting,
 * and a retention is recorded as an edited spreadsheet cell.
 *
 * The property this file is built around is that **the recommendation is
 * computed and never overwritten; the decision is stored beside it, and any
 * divergence costs a reason and a second signature.**
 *
 * A single `outcome` field that starts as the computed value and is then edited
 * loses the computation the moment anybody touches it — and with it the only
 * evidence that a departure from policy ever happened. Keeping both means
 * `isOverride` falls out for free, the override rate per class is a number the
 * head of year can be shown in July, and a decision challenged in September can
 * be answered with "the arithmetic said retain, we promoted anyway, here is who
 * signed it and why".
 */

const OUTCOMES = ['promote', 'promote-conditional', 'retain', 'refer'];

// What the arithmetic is allowed to conclude. `refer` is a human judgement —
// send this child for a re-test, or to a panel — and is not something a
// threshold can decide, so it is available as a decision and not as a
// recommendation.
const RECOMMENDATIONS = ['promote', 'promote-conditional', 'retain', 'insufficient-evidence'];

const DECISION_STATUSES = ['draft', 'decided', 'published', 'withdrawn'];

// A decision in one of these holds the slot for its student and year.
const HOLDING_STATUSES = ['draft', 'decided', 'published'];

const COHORT_STATUSES = ['open', 'published'];

const CONDITION_STATUSES = ['open', 'met', 'not-met', 'waived'];

/**
 * Below these, the evidence is not evidence.
 *
 * A student with no recorded sessions has 0% attendance arithmetically, and
 * treating that as a retention case is how a data-entry gap becomes a repeated
 * year. Below the floor the recommendation is `insufficient-evidence` and a
 * human has to look.
 */
const MIN_SESSIONS_FOR_EVIDENCE = 20;
const MIN_SUBJECTS_FOR_EVIDENCE = 1;

const YEAR_PATTERN = /^\d{4}-\d{4}$/;

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
 * The thresholds, stated once per class and year.
 *
 * Written down rather than remembered, which is the whole difference between a
 * policy and a habit. Two people applying "enough attendance and enough passes"
 * to two children in the same afternoon are applying two different rules.
 */
const progressionRuleSchema = new mongoose.Schema(
  {
    className: {
      type: String,
      required: [true, 'A rule needs a class'],
      trim: true,
      maxlength: [40, 'Too long'],
    },
    academicYear: {
      type: String,
      required: [true, 'A rule needs an academic year'],
      trim: true,
      match: [YEAR_PATTERN, 'Academic year must look like 2026-2027'],
    },

    minAttendancePercent: { type: Number, default: 75, min: 0, max: 100 },
    minSubjectsPassed: { type: Number, default: 0, min: 0 },
    passMarkPercent: { type: Number, default: 40, min: 0, max: 100 },

    /**
     * Beyond this many failures, conditional promotion is not offered.
     *
     * A promotion with five conditions attached is a retention nobody wanted to
     * say out loud, and the child carries it into a year they cannot follow.
     */
    maxConditionalSubjects: { type: Number, default: 2, min: 0, max: 10 },

    promotesTo: {
      type: String,
      required: [true, 'A rule must say which class a promotion moves into'],
      trim: true,
      maxlength: [40, 'Too long'],
    },

    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true }
);

progressionRuleSchema.index({ className: 1, academicYear: 1 }, { unique: true });

progressionRuleSchema.pre('save', function guardRule() {
  if (this.promotesTo === this.className) {
    throw new Error('A promotion cannot move a student into the class they are already in');
  }
});

const conditionSchema = new mongoose.Schema(
  {
    subject: {
      type: String,
      required: [true, 'A condition must name a subject'],
      trim: true,
      maxlength: [80, 'Too long'],
    },
    requirement: {
      type: String,
      required: [true, 'A condition must say what has to happen'],
      trim: true,
      maxlength: [300, 'Too long'],
    },
    dueBy: { type: Date, required: [true, 'A condition must have a date'] },
    status: {
      type: String,
      enum: { values: CONDITION_STATUSES, message: 'Invalid condition status' },
      default: 'open',
    },
    settledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    settledByName: { type: String, trim: true, default: '' },
    settledAt: { type: Date, default: null },
    note: { type: String, trim: true, maxlength: [300, 'Too long'], default: '' },
  },
  { _id: true }
);

const evidenceSchema = new mongoose.Schema(
  {
    attendancePercent: { type: Number, default: null },
    sessionsRecorded: { type: Number, default: 0, min: 0 },
    sessionsPresent: { type: Number, default: 0, min: 0 },
    subjectsAssessed: { type: Number, default: 0, min: 0 },
    subjectsPassed: { type: Number, default: 0, min: 0 },
    subjectsFailed: { type: [String], default: [] },
    averagePercent: { type: Number, default: null },
    computedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const progressionDecisionSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A decision must name a student'],
    },
    studentName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },

    academicYear: {
      type: String,
      required: [true, 'A decision belongs to an academic year'],
      trim: true,
      match: [YEAR_PATTERN, 'Academic year must look like 2026-2027'],
    },
    fromClass: {
      type: String,
      required: [true, 'A decision needs the class the student is in'],
      trim: true,
      maxlength: [40, 'Too long'],
    },
    // Taken from the rule's `promotesTo`, never from a request, and null on a
    // retention. A promotion into a class the school does not run is a typo
    // with a year's consequences.
    toClass: { type: String, trim: true, maxlength: [40, 'Too long'], default: null },

    evidence: { type: evidenceSchema, default: () => ({}) },

    /**
     * Computed from `evidence` against the rule in force. Never written by a
     * client, and never overwritten by the decision.
     */
    recommendation: {
      type: String,
      enum: { values: RECOMMENDATIONS, message: 'Invalid recommendation' },
      required: true,
    },
    recommendationReasons: { type: [String], default: [] },

    decision: {
      type: String,
      enum: { values: OUTCOMES, message: 'Invalid decision' },
      default: null,
    },

    // Derived in pre('save'). The gap between these two columns is the whole
    // review.
    isOverride: { type: Boolean, default: false },
    overrideReason: { type: String, trim: true, maxlength: [1000, 'Too long'], default: '' },

    counterSignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    counterSignedByName: { type: String, trim: true, default: '' },
    counterSignedAt: { type: Date, default: null },

    conditions: { type: [conditionSchema], default: [] },

    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedByName: { type: String, trim: true, default: '' },
    decidedAt: { type: Date, default: null },

    status: {
      type: String,
      enum: { values: DECISION_STATUSES, message: 'Invalid decision status' },
      default: 'draft',
    },

    publishedAt: { type: Date, default: null },

    withdrawnBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    withdrawnAt: { type: Date, default: null },
    withdrawalReason: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    /**
     * Derived from `status`. It backs the unique partial index, because a
     * `partialFilterExpression` cannot express a negation and a withdrawn
     * decision has to release the slot for its replacement.
     */
    isHolding: { type: Boolean, default: true },

    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true }
);

// One live decision per student per academic year.
progressionDecisionSchema.index(
  { student: 1, academicYear: 1 },
  { unique: true, partialFilterExpression: { isHolding: true } }
);

progressionDecisionSchema.index({ fromClass: 1, academicYear: 1, status: 1 });
progressionDecisionSchema.index({ status: 1, decidedAt: -1 });
progressionDecisionSchema.index({ isOverride: 1, academicYear: 1 });

progressionDecisionSchema.pre('save', function guardDecision() {
  this.isHolding = HOLDING_STATUSES.includes(this.status);

  // Derived, never set by a caller. A client that could write `isOverride`
  // could hide one.
  this.isOverride = Boolean(this.decision) && this.decision !== this.recommendation;

  if (this.isOverride && !this.overrideReason.trim()) {
    throw new Error('Departing from the recommendation requires a reason');
  }

  if (this.counterSignedBy && this.decidedBy && this.counterSignedBy.equals(this.decidedBy)) {
    throw new Error('An override cannot be countersigned by the person who decided it');
  }

  if (this.decision !== 'promote-conditional' && this.conditions.length) {
    throw new Error('Conditions can only be attached to a conditional promotion');
  }

  if (this.decision === 'retain' && this.toClass) {
    throw new Error('A retained student does not move class');
  }
});

progressionDecisionSchema.methods.log = function log(action, actor, note = '') {
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
 * Turn evidence into a recommendation, against a stated rule.
 *
 * Returns the reasons as well as the verdict, because "retain" on its own is
 * not something anybody can argue with or act on — and the reasons are what the
 * cohort table shows next to each row.
 */
progressionDecisionSchema.statics.recommend = function recommend(evidence, rule) {
  const reasons = [];

  const thinAttendance = (evidence.sessionsRecorded || 0) < MIN_SESSIONS_FOR_EVIDENCE;
  const thinResults = (evidence.subjectsAssessed || 0) < MIN_SUBJECTS_FOR_EVIDENCE;

  if (thinAttendance || thinResults) {
    if (thinAttendance) {
      reasons.push(
        `Only ${evidence.sessionsRecorded || 0} session(s) recorded; ${MIN_SESSIONS_FOR_EVIDENCE} are needed to judge attendance`
      );
    }
    if (thinResults) {
      reasons.push('No subject has been assessed');
    }
    return { recommendation: 'insufficient-evidence', reasons };
  }

  const attendanceOk = (evidence.attendancePercent ?? 0) >= rule.minAttendancePercent;
  const failed = (evidence.subjectsFailed || []).length;
  const passedOk = (evidence.subjectsPassed || 0) >= rule.minSubjectsPassed;

  if (!attendanceOk) {
    reasons.push(
      `Attendance ${evidence.attendancePercent}% is below the ${rule.minAttendancePercent}% required`
    );
  }
  if (!passedOk) {
    reasons.push(
      `${evidence.subjectsPassed} subject(s) passed, against ${rule.minSubjectsPassed} required`
    );
  }
  if (failed) {
    reasons.push(`Did not reach ${rule.passMarkPercent}% in: ${evidence.subjectsFailed.join(', ')}`);
  }

  // Attendance is the hard gate. A child who was not there did not do the year,
  // whatever the marks say about the lessons they did attend.
  if (!attendanceOk) return { recommendation: 'retain', reasons };

  if (!passedOk) return { recommendation: 'retain', reasons };

  if (failed === 0) {
    reasons.push('Met the attendance and pass thresholds in every subject');
    return { recommendation: 'promote', reasons };
  }

  if (failed <= rule.maxConditionalSubjects) {
    return { recommendation: 'promote-conditional', reasons };
  }

  reasons.push(
    `${failed} failed subject(s) is beyond the ${rule.maxConditionalSubjects} a conditional promotion allows`
  );
  return { recommendation: 'retain', reasons };
};

progressionDecisionSchema.methods.decide = function decide(actor, outcome, options = {}) {
  if (this.status === 'published') {
    throw new Error('This cohort has been published; the decision cannot be changed');
  }
  if (this.status === 'withdrawn') {
    throw new Error('This decision has been withdrawn');
  }
  if (!OUTCOMES.includes(outcome)) {
    throw new Error('Invalid decision');
  }

  /**
   * `insufficient-evidence` always needs a human with a reason, whatever the
   * outcome. Deciding a child's year off a gap in the data is the failure the
   * floor exists to catch, and letting it through unremarked would defeat it.
   */
  if (this.recommendation === 'insufficient-evidence') {
    if (actor.role !== 'admin') {
      throw new Error('A decision on insufficient evidence has to be taken by an administrator');
    }
    if (!options.reason || !String(options.reason).trim()) {
      throw new Error('A decision on insufficient evidence requires a reason');
    }
  }

  this.decision = outcome;
  this.decidedBy = actor._id;
  this.decidedByName = actor.name || '';
  this.decidedAt = new Date();
  this.status = 'decided';

  if (options.reason !== undefined) {
    this.overrideReason = String(options.reason || '').trim();
  }

  // Cleared, not preserved: a countersignature belongs to the decision it was
  // given for, and re-deciding is a new decision.
  this.counterSignedBy = null;
  this.counterSignedByName = '';
  this.counterSignedAt = null;

  if (outcome === 'retain' || outcome === 'refer') {
    this.toClass = null;
  } else {
    this.toClass = options.promotesTo || this.toClass;
  }

  if (outcome !== 'promote-conditional') {
    this.conditions = [];
  }

  return this.log('decided', actor, `${this.recommendation} → ${outcome}`);
};

progressionDecisionSchema.methods.countersign = function countersign(actor) {
  if (!this.isOverride) {
    throw new Error('Only a decision that departs from the recommendation needs countersigning');
  }
  if (this.status === 'published') {
    throw new Error('This cohort has been published');
  }
  if (this.decidedBy && actor._id.equals(this.decidedBy)) {
    throw new Error('An override cannot be countersigned by the person who decided it');
  }

  this.counterSignedBy = actor._id;
  this.counterSignedByName = actor.name || '';
  this.counterSignedAt = new Date();

  return this.log('countersigned', actor);
};

progressionDecisionSchema.methods.withdrawDecision = function withdrawDecision(actor, reason) {
  if (!reason || !String(reason).trim()) {
    throw new Error('Withdrawing a decision requires a reason');
  }
  if (this.status === 'withdrawn') {
    throw new Error('This decision has already been withdrawn');
  }

  this.status = 'withdrawn';
  this.withdrawnBy = actor._id;
  this.withdrawnAt = new Date();
  this.withdrawalReason = String(reason).trim();

  return this.log('withdrawn', actor, this.withdrawalReason);
};

progressionDecisionSchema.methods.addCondition = function addCondition(actor, condition, rule) {
  if (this.decision !== 'promote-conditional') {
    throw new Error('Conditions can only be attached to a conditional promotion');
  }
  if (this.status === 'published') {
    throw new Error('This cohort has been published');
  }
  if (rule && this.conditions.length >= rule.maxConditionalSubjects) {
    throw new Error(
      `A conditional promotion allows at most ${rule.maxConditionalSubjects} condition(s)`
    );
  }

  this.conditions.push({
    subject: condition.subject,
    requirement: condition.requirement,
    dueBy: condition.dueBy,
  });

  return this.log('condition-added', actor, condition.subject);
};

/**
 * Settling a condition is the one thing allowed after publication, and it is
 * the whole reason a condition exists: it is discharged later, by definition.
 */
progressionDecisionSchema.methods.settleCondition = function settleCondition(
  actor,
  index,
  status,
  note
) {
  const condition = this.conditions[index];
  if (!condition) {
    throw new Error('There is no condition at that position');
  }
  if (!CONDITION_STATUSES.includes(status) || status === 'open') {
    throw new Error('A condition is settled as met, not-met or waived');
  }
  if (condition.status !== 'open') {
    throw new Error(`That condition is already ${condition.status}`);
  }

  condition.status = status;
  condition.settledBy = actor._id;
  condition.settledByName = actor.name || '';
  condition.settledAt = new Date();
  condition.note = (note && String(note).trim()) || '';

  return this.log('condition-settled', actor, `${condition.subject}: ${status}`);
};

/**
 * What the student is shown once their cohort is published.
 *
 * The outcome and any conditions, and nothing else. Not the thresholds they
 * missed by, not the reasons, and never `overrideReason` — that is a
 * professional note about a child, written for the staff record.
 */
progressionDecisionSchema.methods.forStudent = function forStudent() {
  return {
    _id: this._id,
    academicYear: this.academicYear,
    fromClass: this.fromClass,
    toClass: this.toClass,
    decision: this.decision,
    publishedAt: this.publishedAt,
    conditions: this.conditions.map((condition) => ({
      subject: condition.subject,
      requirement: condition.requirement,
      dueBy: condition.dueBy,
      status: condition.status,
    })),
  };
};

progressionDecisionSchema.statics.OUTCOMES = OUTCOMES;
progressionDecisionSchema.statics.RECOMMENDATIONS = RECOMMENDATIONS;
progressionDecisionSchema.statics.DECISION_STATUSES = DECISION_STATUSES;
progressionDecisionSchema.statics.HOLDING_STATUSES = HOLDING_STATUSES;
progressionDecisionSchema.statics.CONDITION_STATUSES = CONDITION_STATUSES;
progressionDecisionSchema.statics.MIN_SESSIONS_FOR_EVIDENCE = MIN_SESSIONS_FOR_EVIDENCE;
progressionDecisionSchema.statics.MIN_SUBJECTS_FOR_EVIDENCE = MIN_SUBJECTS_FOR_EVIDENCE;

/**
 * One class-year, published once.
 *
 * Publication is the moment the decisions become real. Without it they leak
 * individually as they are made, and nothing stops one changing after a family
 * has been told.
 */
const progressionCohortSchema = new mongoose.Schema(
  {
    className: { type: String, required: true, trim: true, maxlength: [40, 'Too long'] },
    academicYear: {
      type: String,
      required: true,
      trim: true,
      match: [YEAR_PATTERN, 'Academic year must look like 2026-2027'],
    },

    status: {
      type: String,
      enum: { values: COHORT_STATUSES, message: 'Invalid cohort status' },
      default: 'open',
    },

    studentCount: { type: Number, default: 0, min: 0 },
    decidedCount: { type: Number, default: 0, min: 0 },
    overrideCount: { type: Number, default: 0, min: 0 },
    byRecommendation: { type: Map, of: Number, default: {} },
    byDecision: { type: Map, of: Number, default: {} },

    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    publishedByName: { type: String, trim: true, default: '' },
    publishedAt: { type: Date, default: null },

    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true }
);

progressionCohortSchema.index({ className: 1, academicYear: 1 }, { unique: true });

progressionCohortSchema.methods.log = progressionDecisionSchema.methods.log;

progressionCohortSchema.methods.publish = function publish(actor, totals) {
  if (this.status === 'published') {
    throw new Error('This cohort has already been published');
  }

  this.status = 'published';
  this.publishedBy = actor._id;
  this.publishedByName = actor.name || '';
  this.publishedAt = new Date();
  Object.assign(this, totals);

  return this.log(
    'published',
    actor,
    `${totals.decidedCount} decision(s), ${totals.overrideCount} override(s)`
  );
};

progressionCohortSchema.statics.COHORT_STATUSES = COHORT_STATUSES;

const ProgressionRule = mongoose.model('ProgressionRule', progressionRuleSchema);
const ProgressionDecision = mongoose.model('ProgressionDecision', progressionDecisionSchema);
const ProgressionCohort = mongoose.model('ProgressionCohort', progressionCohortSchema);

module.exports = ProgressionDecision;
module.exports.ProgressionDecision = ProgressionDecision;
module.exports.ProgressionRule = ProgressionRule;
module.exports.ProgressionCohort = ProgressionCohort;
