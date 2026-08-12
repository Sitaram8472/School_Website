const mongoose = require('mongoose');

/**
 * Lesson observation and teaching appraisal.
 *
 * The observation happens two or three times a year. The paperwork mostly does
 * not: a Word document on somebody's laptop, emailed or printed or neither,
 * with a grade box at the top that gets filled in before the conversation.
 * Agreed actions are agreed and then unowned, so the next observation opens
 * with the same three points as the last one.
 *
 * The thing this model does that a form cannot is gate visibility on status.
 * While an observation is `scheduled` or `observed`, the domain scores are
 * readable by the observer and an admin and by nobody else — including the
 * person who was observed. `canObserveeSeeScores()` is the gate, and moving to
 * `feedback-shared` is the act of having had the conversation.
 *
 * That is not a courtesy. It is the difference between a development record and
 * a grade delivered by email, and the schema makes the second one impossible
 * rather than merely discouraged.
 */

const CYCLES = ['autumn', 'spring', 'summer', 'induction', 'follow-up', 'learning-walk'];

const STATUSES = [
  'scheduled',
  'observed',
  'feedback-shared',
  'acknowledged',
  'closed',
  'cancelled',
];

// Once an observation is in one of these, the observee may read the scores.
const SHARED_STATUSES = ['feedback-shared', 'acknowledged', 'closed'];

// These are still the observer's working document.
const DRAFT_STATUSES = ['scheduled', 'observed'];

const DOMAIN_KEYS = [
  'planning',
  'subject-knowledge',
  'questioning',
  'differentiation',
  'assessment-for-learning',
  'behaviour-management',
  'pupil-engagement',
  'use-of-resources',
];

const DOMAIN_LABELS = {
  planning: 'Planning and preparation',
  'subject-knowledge': 'Subject knowledge',
  questioning: 'Questioning and explanation',
  differentiation: 'Differentiation and challenge',
  'assessment-for-learning': 'Assessment for learning',
  'behaviour-management': 'Behaviour and climate',
  'pupil-engagement': 'Pupil engagement',
  'use-of-resources': 'Use of resources and time',
};

// A four-point scale on purpose. An odd-numbered scale collects a middle mark
// that means "I would rather not say", and a year of those tells nobody
// anything.
const MIN_SCORE = 1;
const MAX_SCORE = 4;

const SCORE_LABELS = {
  1: 'Needs development',
  2: 'Developing',
  3: 'Secure',
  4: 'Exemplary',
};

const ACTION_STATUSES = ['open', 'in-progress', 'completed', 'carried-forward'];

const RESOLVED_ACTION_STATUSES = ['completed', 'carried-forward'];

const MAX_ACTIONS = 10;

const domainSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: [true, 'A domain must have a key'],
      enum: { values: DOMAIN_KEYS, message: 'Unknown observation domain' },
    },
    score: {
      type: Number,
      min: [MIN_SCORE, `A score cannot be below ${MIN_SCORE}`],
      max: [MAX_SCORE, `A score cannot be above ${MAX_SCORE}`],
    },
    strengths: {
      type: String,
      trim: true,
      maxlength: [1500, 'Strengths cannot exceed 1500 characters'],
    },
    developmentPoints: {
      type: String,
      trim: true,
      maxlength: [1500, 'Development points cannot exceed 1500 characters'],
    },
  },
  { _id: false, timestamps: false }
);

const actionSchema = new mongoose.Schema(
  {
    description: {
      type: String,
      required: [true, 'An agreed action needs a description'],
      trim: true,
      minlength: [10, 'Describe the action in a little more detail'],
      maxlength: [800, 'An action cannot exceed 800 characters'],
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'An agreed action must have an owner'],
    },
    dueBy: {
      type: Date,
      required: [true, 'An agreed action must have a date'],
    },
    supportOffered: {
      type: String,
      trim: true,
      maxlength: [500, 'Support offered cannot exceed 500 characters'],
    },
    status: {
      type: String,
      enum: { values: ACTION_STATUSES, message: 'Invalid action status' },
      default: 'open',
    },
    completedAt: { type: Date },
    evidence: {
      type: String,
      trim: true,
      maxlength: [1000, 'Evidence cannot exceed 1000 characters'],
    },
  },
  { _id: true, timestamps: false }
);

const historySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: [40, 'Action cannot exceed 40 characters'],
    },
    from: { type: String, trim: true, maxlength: [80, 'From cannot exceed 80 characters'] },
    to: { type: String, trim: true, maxlength: [80, 'To cannot exceed 80 characters'] },
    note: { type: String, trim: true, maxlength: [500, 'Note cannot exceed 500 characters'] },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
  },
  { _id: true, timestamps: false }
);

const lessonObservationSchema = new mongoose.Schema(
  {
    observee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'An observation must name the teacher being observed'],
    },
    observer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'An observation must name its observer'],
    },
    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
    },
    subject: {
      type: String,
      trim: true,
      maxlength: [80, 'Subject cannot exceed 80 characters'],
    },
    yearGroup: {
      type: String,
      trim: true,
      maxlength: [40, 'Year group cannot exceed 40 characters'],
    },
    cycle: {
      type: String,
      required: [true, 'An observation must belong to a cycle'],
      enum: { values: CYCLES, message: 'Invalid observation cycle' },
    },
    academicYear: {
      type: String,
      required: [true, 'An academic year is required'],
      trim: true,
      match: [/^\d{4}-\d{2}$/, 'Use the form 2026-27'],
    },
    scheduledFor: {
      type: Date,
      required: [true, 'An observation must be scheduled for a date'],
    },
    observedAt: { type: Date },
    lessonDuration: {
      type: Number,
      min: [5, 'A lesson cannot be shorter than 5 minutes'],
      max: [300, 'A lesson cannot be longer than 300 minutes'],
    },
    pupilCount: {
      type: Number,
      min: [0, 'Pupil count cannot be negative'],
      max: [200, 'Pupil count cannot exceed 200'],
    },
    focusAreas: {
      type: [String],
      default: [],
      validate: {
        validator: (v) => v.every((key) => DOMAIN_KEYS.includes(key)),
        message: 'A focus area must be one of the observation domains',
      },
    },

    domains: {
      type: [domainSchema],
      default: [],
    },

    status: {
      type: String,
      enum: { values: STATUSES, message: 'Invalid status' },
      default: 'scheduled',
    },
    sharedAt: { type: Date },

    agreedActions: {
      type: [actionSchema],
      default: [],
      validate: {
        validator: (v) => v.length <= MAX_ACTIONS,
        message: `An observation cannot carry more than ${MAX_ACTIONS} agreed actions`,
      },
    },

    // The observee's own words, and the only field on the document they own.
    observeeResponse: {
      type: String,
      trim: true,
      maxlength: [2000, 'Your response cannot exceed 2000 characters'],
    },
    acknowledgedAt: { type: Date },

    // A second read of this observation, not a second observation.
    moderation: {
      moderator: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      moderatedAt: { type: Date },
      agreedScore: {
        type: Number,
        min: [MIN_SCORE, `A moderated score cannot be below ${MIN_SCORE}`],
        max: [MAX_SCORE, `A moderated score cannot be above ${MAX_SCORE}`],
      },
      varianceNote: {
        type: String,
        trim: true,
        maxlength: [1000, 'Variance note cannot exceed 1000 characters'],
      },
    },

    cancellationReason: {
      type: String,
      trim: true,
      maxlength: [500, 'Reason cannot exceed 500 characters'],
    },

    history: {
      type: [historySchema],
      default: [],
    },
  },
  { timestamps: true }
);

lessonObservationSchema.index({ observee: 1, academicYear: 1, scheduledFor: -1 });
lessonObservationSchema.index({ observer: 1, status: 1 });
lessonObservationSchema.index({ status: 1, scheduledFor: 1 });
// The follow-up query: my open actions, soonest due first.
lessonObservationSchema.index({ 'agreedActions.owner': 1, 'agreedActions.status': 1 });

lessonObservationSchema.pre('validate', function derive() {
  // A self-review is a different document and it is not this one. Checked in
  // the schema rather than the controller so no future route can miss it.
  if (this.observer && this.observee && String(this.observer) === String(this.observee)) {
    this.invalidate('observer', 'An observation must be carried out by somebody else');
  }

  // One row per domain. Two rows for `questioning` makes the mean depend on
  // insertion order, which is not a property a score should have.
  const seen = new Set();
  for (const domain of this.domains || []) {
    if (seen.has(domain.key)) {
      this.invalidate('domains', `The ${DOMAIN_LABELS[domain.key] || domain.key} domain appears twice`);
    }
    seen.add(domain.key);
  }

  if (this.observedAt && this.scheduledFor && this.observedAt < this.scheduledFor) {
    // Observing before the lesson was scheduled means somebody typed the wrong
    // date, and the wrong date is what the year-on-year view is ordered by.
    this.invalidate('observedAt', 'An observation cannot have happened before it was scheduled');
  }

  if (!SHARED_STATUSES.includes(this.status)) {
    this.sharedAt = undefined;
  }
  if (this.status !== 'acknowledged' && this.status !== 'closed') {
    this.acknowledgedAt = undefined;
  }
});

/**
 * The mean of the domains that have actually been scored, to one decimal.
 *
 * Null when nothing is scored. A half-finished observation reports what it has
 * rather than what it might become, which is the same reason the appeals
 * module recomputes its total from decided questions only.
 */
lessonObservationSchema.methods.overallScore = function overallScore() {
  const scored = (this.domains || []).filter((domain) => Number.isFinite(domain.score));
  if (!scored.length) return null;
  const total = scored.reduce((sum, domain) => sum + domain.score, 0);
  return Math.round((total / scored.length) * 10) / 10;
};

lessonObservationSchema.methods.scoredDomainCount = function scoredDomainCount() {
  return (this.domains || []).filter((domain) => Number.isFinite(domain.score)).length;
};

lessonObservationSchema.methods.isShared = function isShared() {
  return SHARED_STATUSES.includes(this.status);
};

lessonObservationSchema.methods.isDraft = function isDraft() {
  return DRAFT_STATUSES.includes(this.status);
};

/**
 * The gate the whole feature exists for.
 *
 * Until the observer has shared, the observee sees that an observation exists
 * and sees nothing that resembles a judgement.
 */
lessonObservationSchema.methods.canObserveeSeeScores = function canObserveeSeeScores() {
  return this.isShared();
};

lessonObservationSchema.methods.isObserver = function isObserver(user) {
  return Boolean(user && String(this.observer) === String(user._id));
};

lessonObservationSchema.methods.isObservee = function isObservee(user) {
  return Boolean(user && String(this.observee) === String(user._id));
};

/**
 * Why this observation may not be shared yet, or null when it may.
 *
 * Feedback with no action is a pleasant conversation, and a year of them is
 * what the school has now — so an action is a precondition rather than a
 * prompt.
 */
lessonObservationSchema.methods.shareBlockedReason = function shareBlockedReason() {
  if (this.status === 'cancelled') return 'This observation was cancelled';
  if (this.isShared()) return 'This observation has already been shared';
  if (!this.observedAt) return 'Record the observation before sharing it';
  if (!this.scoredDomainCount()) {
    return 'Score at least one domain before sharing';
  }
  if (!(this.agreedActions || []).length) {
    return 'Agree at least one action before sharing. Feedback without an action is a conversation, not a record.';
  }
  return null;
};

/**
 * Why this observation may not be closed, or null when it may.
 */
lessonObservationSchema.methods.closeBlockedReason = function closeBlockedReason() {
  if (this.status === 'cancelled') return 'This observation was cancelled';
  if (this.status === 'closed') return 'This observation is already closed';
  if (!this.isShared()) return 'Share the feedback before closing the observation';

  const open = this.openActions();
  if (open.length) {
    return `${open.length} agreed action${open.length === 1 ? ' is' : 's are'} still open. Complete or carry them forward first.`;
  }
  return null;
};

/**
 * Whether `candidate` may moderate this observation.
 *
 * A moderator who is the original observer is re-reading their own judgement,
 * which produces agreement every time and calibrates nothing.
 */
lessonObservationSchema.methods.moderatorEligibilityError =
  function moderatorEligibilityError(candidate) {
    if (!candidate) return 'Not authenticated';
    if (this.isObserver(candidate)) {
      return 'You carried out this observation, so somebody else must moderate it';
    }
    if (this.isObservee(candidate)) {
      return 'You cannot moderate an observation of your own teaching';
    }
    if (!this.isShared()) {
      return 'An observation can only be moderated once its feedback has been shared';
    }
    return null;
  };

lessonObservationSchema.methods.openActions = function openActions() {
  return (this.agreedActions || []).filter(
    (action) => !RESOLVED_ACTION_STATUSES.includes(action.status)
  );
};

/** Days an action is past its date; 0 when it is not late or already resolved. */
lessonObservationSchema.methods.actionDaysOverdue = function actionDaysOverdue(
  action,
  asOf = new Date()
) {
  if (!action || !action.dueBy) return 0;
  if (RESOLVED_ACTION_STATUSES.includes(action.status)) return 0;
  const diff = asOf.getTime() - new Date(action.dueBy).getTime();
  if (diff <= 0) return 0;
  return Math.floor(diff / 86400000);
};

/** How long the observee waited to be told. The one number that shames a process. */
lessonObservationSchema.methods.sharingLagDays = function sharingLagDays() {
  if (!this.observedAt || !this.sharedAt) return null;
  return Math.max(
    0,
    Math.round((this.sharedAt.getTime() - this.observedAt.getTime()) / 86400000)
  );
};

lessonObservationSchema.methods.recordHistory = function recordHistory(entry) {
  this.history.push({
    action: entry.action,
    from: entry.from === undefined || entry.from === null ? undefined : String(entry.from),
    to: entry.to === undefined || entry.to === null ? undefined : String(entry.to),
    note: entry.note,
    by: entry.by,
    at: new Date(),
  });
};

/**
 * The read shape, redacted for the viewer.
 *
 * The redaction happens here — once — rather than at each call site, because a
 * gate that every handler has to remember is a gate that one handler forgets.
 */
lessonObservationSchema.methods.toRowFor = function toRowFor(viewer, asOf = new Date()) {
  const isAdmin = Boolean(viewer && viewer.role === 'admin');
  const canSeeScores = isAdmin || this.isObserver(viewer) || this.canObserveeSeeScores();

  const base = {
    _id: this._id,
    observee: this.observee,
    observer: this.observer,
    course: this.course,
    subject: this.subject,
    yearGroup: this.yearGroup,
    cycle: this.cycle,
    academicYear: this.academicYear,
    scheduledFor: this.scheduledFor,
    observedAt: this.observedAt,
    lessonDuration: this.lessonDuration,
    pupilCount: this.pupilCount,
    focusAreas: this.focusAreas,
    status: this.status,
    sharedAt: this.sharedAt,
    acknowledgedAt: this.acknowledgedAt,
    isShared: this.isShared(),
    scoresVisible: canSeeScores,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };

  if (!canSeeScores) {
    // Deliberately not an empty array — the observee is told the observation
    // exists and that the feedback is not ready, rather than being shown a
    // record that looks blank.
    return {
      ...base,
      domains: [],
      overallScore: null,
      scoredDomainCount: 0,
      agreedActions: [],
      openActionCount: 0,
      awaitingFeedback: true,
    };
  }

  const actions = (this.agreedActions || []).map((action) => ({
    _id: action._id,
    description: action.description,
    owner: action.owner,
    dueBy: action.dueBy,
    supportOffered: action.supportOffered,
    status: action.status,
    completedAt: action.completedAt,
    evidence: action.evidence,
    daysOverdue: this.actionDaysOverdue(action, asOf),
  }));

  return {
    ...base,
    domains: this.domains,
    overallScore: this.overallScore(),
    scoredDomainCount: this.scoredDomainCount(),
    agreedActions: actions,
    openActionCount: this.openActions().length,
    observeeResponse: this.observeeResponse,
    moderation:
      this.moderation && this.moderation.moderator
        ? {
            moderator: this.moderation.moderator,
            moderatedAt: this.moderation.moderatedAt,
            agreedScore: this.moderation.agreedScore,
            varianceNote: this.moderation.varianceNote,
            variance:
              Number.isFinite(this.moderation.agreedScore) && this.overallScore() !== null
                ? Math.round((this.moderation.agreedScore - this.overallScore()) * 10) / 10
                : null,
          }
        : null,
    sharingLagDays: this.sharingLagDays(),
    awaitingFeedback: false,
  };
};

lessonObservationSchema.methods.toDetailFor = function toDetailFor(viewer, asOf = new Date()) {
  const row = this.toRowFor(viewer, asOf);
  const isAdmin = Boolean(viewer && viewer.role === 'admin');
  // The trail names who saw what and when, which only the observer and an
  // admin have any business reading.
  if (isAdmin || this.isObserver(viewer)) {
    return { ...row, history: this.history, cancellationReason: this.cancellationReason };
  }
  return row;
};

lessonObservationSchema.statics.CYCLES = CYCLES;
lessonObservationSchema.statics.STATUSES = STATUSES;
lessonObservationSchema.statics.SHARED_STATUSES = SHARED_STATUSES;
lessonObservationSchema.statics.DRAFT_STATUSES = DRAFT_STATUSES;
lessonObservationSchema.statics.DOMAIN_KEYS = DOMAIN_KEYS;
lessonObservationSchema.statics.DOMAIN_LABELS = DOMAIN_LABELS;
lessonObservationSchema.statics.SCORE_LABELS = SCORE_LABELS;
lessonObservationSchema.statics.ACTION_STATUSES = ACTION_STATUSES;
lessonObservationSchema.statics.RESOLVED_ACTION_STATUSES = RESOLVED_ACTION_STATUSES;
lessonObservationSchema.statics.MIN_SCORE = MIN_SCORE;
lessonObservationSchema.statics.MAX_SCORE = MAX_SCORE;
lessonObservationSchema.statics.MAX_ACTIONS = MAX_ACTIONS;

module.exports = mongoose.model('LessonObservation', lessonObservationSchema);
