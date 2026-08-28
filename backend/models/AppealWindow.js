const mongoose = require('mongoose');

const RemarkAppeal = require('./RemarkAppeal');

/**
 * When a cohort may appeal a result.
 *
 * `RemarkAppeal` already answers this with one constant for the whole school —
 * fourteen days, measured from `submission.createdAt`. That constant is a good
 * default and this model does not remove it. What it fixes is the two things
 * the constant cannot know:
 *
 *   1. `submission.createdAt` is when the student pressed submit, not when the
 *      mark existed. A paper marked fifteen days later has a window that closed
 *      before anybody could have appealed against it.
 *   2. A weekly class test and a terminal exam do not have the same deadline
 *      pressure behind them, and there is nowhere to say so.
 *
 * A window is therefore anchored to `resultsPublishedAt` — an event a human
 * states — and it belongs to the exam rather than to any one appeal. When a
 * cohort's marking slips, one person moves one date and every student in the
 * cohort is covered, including the ones who would never have complained.
 */

const WINDOW_STATUSES = ['draft', 'published', 'closed', 'cancelled'];

// A window in one of these states governs its exam. `closed` and `cancelled`
// release it, so a replacement can be published without deleting history.
const LIVE_STATUSES = ['draft', 'published'];

const ASSESSMENT_TYPES = [
  'class-test',
  'unit-test',
  'mid-term',
  'terminal',
  'board-practice',
  'other',
];

// A window shorter than this is a window nobody can act on, and one longer than
// this is not a window. Both ends are refused rather than warned about.
const MIN_WINDOW_HOURS = 12;
const MAX_WINDOW_DAYS = 120;
const MAX_GRACE_HOURS = 72;

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
      maxlength: [300, 'History note cannot exceed 300 characters'],
      default: '',
    },
  },
  { _id: false }
);

/**
 * One recorded move of the closing date. Kept as its own array rather than
 * folded into the history, because "how many times has this been extended and
 * why" is a question asked on its own.
 */
const extensionSchema = new mongoose.Schema(
  {
    from: {
      type: Date,
      required: true,
    },
    to: {
      type: Date,
      required: true,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: [300, 'Extension reason cannot exceed 300 characters'],
    },
    by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    byName: {
      type: String,
      trim: true,
      maxlength: [100, 'Extension actor name cannot exceed 100 characters'],
      default: '',
    },
    at: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const appealWindowSchema = new mongoose.Schema(
  {
    exam: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: [true, 'The exam this window governs is required'],
    },

    // Denormalised the way RemarkAppeal already denormalises, so a calendar of
    // twenty windows renders without a join per row.
    examTitle: {
      type: String,
      trim: true,
      maxlength: [200, 'Exam title cannot exceed 200 characters'],
      default: '',
    },

    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
    },

    courseName: {
      type: String,
      trim: true,
      maxlength: [120, 'Course name cannot exceed 120 characters'],
      default: '',
    },

    academicYear: {
      type: String,
      trim: true,
      maxlength: [20, 'Academic year cannot exceed 20 characters'],
      default: '',
    },

    assessmentType: {
      type: String,
      enum: {
        values: ASSESSMENT_TYPES,
        message: 'Invalid assessment type',
      },
      default: 'other',
    },

    /**
     * The event the window is measured from, stated rather than inferred.
     * This is the whole point of the model: `submission.createdAt` is the
     * wrong anchor and there was nowhere to record the right one.
     */
    resultsPublishedAt: {
      type: Date,
      required: [true, 'The date results were published is required'],
    },

    opensAt: {
      type: Date,
      required: [true, 'An opening time is required'],
    },

    closesAt: {
      type: Date,
      required: [true, 'A closing time is required'],
    },

    // A late submission on the last afternoon is not the failure mode this
    // module exists to prevent, so a small, explicit tolerance is allowed.
    graceHours: {
      type: Number,
      default: 0,
      min: [0, 'Grace hours cannot be negative'],
      max: [MAX_GRACE_HOURS, `Grace cannot exceed ${MAX_GRACE_HOURS} hours`],
    },

    /**
     * A cap on how many appeals one student may raise against this exam.
     * `RemarkAppeal` already refuses a second open appeal against the same
     * submission; it says nothing about a student appealing every paper.
     */
    maxAppealsPerStudent: {
      type: Number,
      default: 1,
      min: [1, 'At least one appeal must be allowed'],
      max: [10, 'A per-student cap above 10 is not a cap'],
    },

    instructions: {
      type: String,
      trim: true,
      maxlength: [1000, 'Instructions cannot exceed 1000 characters'],
      default: '',
    },

    status: {
      type: String,
      enum: {
        values: WINDOW_STATUSES,
        message: 'Invalid window status',
      },
      default: 'draft',
    },

    /**
     * Derived from `status` in `pre('save')`. MongoDB refuses `$ne` inside a
     * `partialFilterExpression`, so "at most one window per exam that is not
     * closed or cancelled" has to be expressed as an equality on a flag.
     */
    isLive: {
      type: Boolean,
      default: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    publishedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    publishedAt: {
      type: Date,
    },

    closedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    closedAt: {
      type: Date,
    },

    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    cancelledAt: {
      type: Date,
    },

    cancellationReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Cancellation reason cannot exceed 300 characters'],
      default: '',
    },

    extensions: {
      type: [extensionSchema],
      default: [],
    },

    history: {
      type: [historyEntrySchema],
      default: [],
    },
  },
  { timestamps: true }
);

// At most one live window per exam. Two members of staff preparing results for
// the same paper cannot each publish their own deadline.
appealWindowSchema.index(
  { exam: 1 },
  { unique: true, partialFilterExpression: { isLive: true } }
);

// The calendar reads by closing time; the staff list reads by creation.
appealWindowSchema.index({ closesAt: 1, status: 1 });
appealWindowSchema.index({ status: 1, createdAt: -1 });
appealWindowSchema.index({ course: 1, academicYear: 1 });

/**
 * The moment appeals actually stop being accepted, grace included.
 */
appealWindowSchema.virtual('effectiveClosesAt').get(function effectiveClosesAt() {
  if (!this.closesAt) return null;
  return new Date(this.closesAt.getTime() + (this.graceHours || 0) * 3600000);
});

appealWindowSchema.set('toJSON', { virtuals: true });
appealWindowSchema.set('toObject', { virtuals: true });

/**
 * Where the window stands right now.
 *
 * Derived on read rather than flipped by a job. There is no scheduler in this
 * repository, and a window that opens only once something has run is a window
 * that either leaks early or never opens at all.
 */
appealWindowSchema.methods.stateAt = function stateAt(now = new Date()) {
  if (this.status === 'cancelled') return 'cancelled';
  if (this.status === 'closed') return 'closed';
  if (this.status === 'draft') return 'draft';

  const moment = now instanceof Date ? now : new Date(now);

  if (moment < this.opensAt) return 'scheduled';
  if (moment > this.effectiveClosesAt) return 'expired';

  return 'open';
};

appealWindowSchema.methods.isAcceptingAppeals = function isAcceptingAppeals(now = new Date()) {
  return this.stateAt(now) === 'open';
};

/** Hours left before appeals stop being accepted; negative once they have. */
appealWindowSchema.methods.hoursRemaining = function hoursRemaining(now = new Date()) {
  const closes = this.effectiveClosesAt;
  if (!closes) return null;

  const moment = now instanceof Date ? now : new Date(now);
  return Math.round(((closes.getTime() - moment.getTime()) / 3600000) * 10) / 10;
};

/**
 * Append one line to the audit trail. Every state change goes through here so
 * the trail cannot be half-kept.
 */
appealWindowSchema.methods.log = function log(action, actor, note = '') {
  this.history.push({
    action,
    by: actor ? actor._id : undefined,
    byName: (actor && actor.name) || '',
    at: new Date(),
    note,
  });

  return this;
};

appealWindowSchema.methods.publish = function publish(actor) {
  if (this.status !== 'draft') {
    throw new Error(`Only a draft window can be published; this one is ${this.status}`);
  }

  this.status = 'published';
  this.publishedBy = actor ? actor._id : undefined;
  this.publishedAt = new Date();

  return this.log('published', actor);
};

/**
 * Move the closing date later, and only later.
 *
 * Shortening a published window retracts a right students have already been
 * told they have. If it genuinely has to happen the window is cancelled with a
 * reason, and that stays on the record.
 */
appealWindowSchema.methods.extend = function extend(actor, newClosesAt, reason) {
  if (this.status !== 'published') {
    throw new Error(`A ${this.status} window cannot be extended`);
  }

  const target = newClosesAt instanceof Date ? newClosesAt : new Date(newClosesAt);
  if (Number.isNaN(target.getTime())) {
    throw new Error('The new closing date is not a valid date');
  }
  if (target <= this.closesAt) {
    throw new Error(
      'An appeal window can only be extended, never shortened. Cancel it instead if it must end early'
    );
  }
  if (target.getTime() - this.opensAt.getTime() > MAX_WINDOW_DAYS * 86400000) {
    throw new Error(`An appeal window cannot run longer than ${MAX_WINDOW_DAYS} days`);
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('An extension reason is required');
  }

  this.extensions.push({
    from: this.closesAt,
    to: target,
    reason: String(reason).trim(),
    by: actor ? actor._id : undefined,
    byName: (actor && actor.name) || '',
    at: new Date(),
  });

  this.closesAt = target;

  return this.log('extended', actor, String(reason).trim());
};

appealWindowSchema.methods.close = function close(actor, note = '') {
  if (this.status !== 'published') {
    throw new Error(`A ${this.status} window cannot be closed`);
  }

  this.status = 'closed';
  this.closedBy = actor ? actor._id : undefined;
  this.closedAt = new Date();

  return this.log('closed', actor, note);
};

appealWindowSchema.methods.cancel = function cancel(actor, reason) {
  if (this.status === 'cancelled') {
    throw new Error('This window has already been cancelled');
  }
  if (this.status === 'closed') {
    throw new Error('A closed window cannot be cancelled; it has already ended');
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('A cancellation reason is required');
  }

  this.status = 'cancelled';
  this.cancelledBy = actor ? actor._id : undefined;
  this.cancelledAt = new Date();
  this.cancellationReason = String(reason).trim();

  return this.log('cancelled', actor, this.cancellationReason);
};

/**
 * The shape the calendar and the staff table both render from.
 */
appealWindowSchema.methods.toRow = function toRow(now = new Date()) {
  return {
    _id: this._id,
    exam: this.exam,
    examTitle: this.examTitle,
    course: this.course,
    courseName: this.courseName,
    academicYear: this.academicYear,
    assessmentType: this.assessmentType,
    resultsPublishedAt: this.resultsPublishedAt,
    opensAt: this.opensAt,
    closesAt: this.closesAt,
    graceHours: this.graceHours,
    effectiveClosesAt: this.effectiveClosesAt,
    maxAppealsPerStudent: this.maxAppealsPerStudent,
    instructions: this.instructions,
    status: this.status,
    state: this.stateAt(now),
    hoursRemaining: this.hoursRemaining(now),
    extensionCount: this.extensions.length,
    publishedAt: this.publishedAt,
    cancellationReason: this.cancellationReason,
    createdAt: this.createdAt,
  };
};

/**
 * Validation that needs more than one field, and the derived flag the unique
 * partial index is built on.
 *
 * Mongoose 9 passes no callback to middleware, so this throws rather than
 * calling `next(err)`.
 */
appealWindowSchema.pre('save', function beforeSave() {
  this.isLive = LIVE_STATUSES.includes(this.status);

  if (this.opensAt && this.closesAt) {
    const span = this.closesAt.getTime() - this.opensAt.getTime();

    if (span <= 0) {
      throw new Error('An appeal window must close after it opens');
    }
    if (span < MIN_WINDOW_HOURS * 3600000) {
      throw new Error(`An appeal window must stay open for at least ${MIN_WINDOW_HOURS} hours`);
    }
    if (span > MAX_WINDOW_DAYS * 86400000) {
      throw new Error(`An appeal window cannot run longer than ${MAX_WINDOW_DAYS} days`);
    }
  }

  if (this.resultsPublishedAt && this.opensAt && this.opensAt < this.resultsPublishedAt) {
    throw new Error('An appeal window cannot open before the results it applies to are published');
  }

  // Once published, the exam and its anchor are what the cohort was told. They
  // are frozen; a mistake in either means cancelling and publishing again.
  if (this.status !== 'draft' && !this.isNew) {
    const frozen = ['exam', 'resultsPublishedAt', 'opensAt'];
    const edited = frozen.find((field) => this.isModified(field));

    if (edited) {
      throw new Error(`"${edited}" cannot be changed once the window has been published`);
    }
  }
});

/**
 * The live window governing an exam, if there is one.
 */
appealWindowSchema.statics.liveFor = function liveFor(examId) {
  return this.findOne({ exam: examId, isLive: true });
};

/**
 * What the deadline actually is for one exam.
 *
 * Returns the published window when a live one exists, and falls back to the
 * existing fourteen-day `RemarkAppeal.windowFor` rule when it does not. Exams
 * with no window behave exactly as they did before this model existed, which
 * is what makes adopting it safe.
 */
appealWindowSchema.statics.effectiveWindowFor = async function effectiveWindowFor(
  examId,
  submittedAt,
  now = new Date()
) {
  const window = examId ? await this.liveFor(examId) : null;

  if (window && window.status === 'published') {
    return {
      source: 'window',
      window,
      windowId: window._id,
      opensAt: window.opensAt,
      closesAt: window.effectiveClosesAt,
      accepting: window.isAcceptingAppeals(now),
      maxAppealsPerStudent: window.maxAppealsPerStudent,
      state: window.stateAt(now),
    };
  }

  const closesAt = submittedAt ? RemarkAppeal.windowFor(submittedAt) : null;

  return {
    source: 'default',
    window: null,
    windowId: null,
    opensAt: submittedAt ? new Date(submittedAt) : null,
    closesAt,
    accepting: closesAt ? now <= closesAt : false,
    maxAppealsPerStudent: 1,
    state: closesAt && now > closesAt ? 'expired' : 'open',
  };
};

appealWindowSchema.statics.STATUSES = WINDOW_STATUSES;
appealWindowSchema.statics.LIVE_STATUSES = LIVE_STATUSES;
appealWindowSchema.statics.ASSESSMENT_TYPES = ASSESSMENT_TYPES;
appealWindowSchema.statics.MIN_WINDOW_HOURS = MIN_WINDOW_HOURS;
appealWindowSchema.statics.MAX_WINDOW_DAYS = MAX_WINDOW_DAYS;
appealWindowSchema.statics.MAX_GRACE_HOURS = MAX_GRACE_HOURS;
appealWindowSchema.statics.DEFAULT_WINDOW_DAYS = RemarkAppeal.APPEAL_WINDOW_DAYS;

module.exports = mongoose.model('AppealWindow', appealWindowSchema);
