const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * A periodised, publishable snapshot of appeal outcomes.
 *
 * `appealController.getStats` is the only reporting the module has today. It
 * runs `RemarkAppeal.find({})` — every appeal ever recorded, into memory, on
 * every request — reduces it in a JavaScript loop, and hides the answer behind
 * `verifyRole('admin')`.
 *
 * Three things follow. There is no period, so 2024 and 2026 are added together
 * and last term's rate silently changes every time a new appeal is decided.
 * Nothing is publishable, so the two audiences these figures exist for — a
 * student deciding whether an appeal is worth submitting and a parent deciding
 * whether the process is fair — see nothing at all. And there is no
 * suppression, so publishing it as it stands would identify individual
 * students in small cohorts.
 *
 * A report fixes all three by being a *record* rather than a query: computed
 * once, suppressed at computation, approved by a second person, and immutable
 * once published. The figures are the report. They do not change next year.
 */

const REPORT_STATUSES = ['draft', 'approved', 'published', 'withdrawn'];

// A report in one of these states is the current one for its period. A
// withdrawn or superseded report leaves, so a corrected one can take its place
// without the original being deleted.
const LIVE_STATUSES = ['draft', 'approved', 'published'];

const SCOPES = ['whole-school', 'course'];

/**
 * The cohort below which a row says nothing but its own name.
 *
 * Five is the default and three is the floor. Outcome statistics about a class
 * of nine, where one appeal was upheld, identify that student to everybody who
 * was in the room — suppression is not a nicety here, it is the reason these
 * figures can be published at all.
 */
const DEFAULT_SUPPRESSION_THRESHOLD = 5;
const MIN_SUPPRESSION_THRESHOLD = 3;

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
 * One line of the report.
 *
 * A suppressed row keeps its name and loses its numbers. That is deliberate:
 * dropping the row entirely hands the reader a shorter list and no way to know
 * it is shorter, which is a different kind of dishonesty from the one
 * suppression is meant to prevent.
 */
const rowSchema = new mongoose.Schema(
  {
    courseName: {
      type: String,
      trim: true,
      maxlength: [120, 'Course name cannot exceed 120 characters'],
      default: 'Unattributed',
    },
    submitted: { type: Number, default: null },
    decided: { type: Number, default: null },
    upheld: { type: Number, default: null },
    partiallyUpheld: { type: Number, default: null },
    rejected: { type: Number, default: null },
    withdrawn: { type: Number, default: null },
    upheldRate: { type: Number, default: null },
    medianDaysToDecision: { type: Number, default: null },
    marksMoved: { type: Number, default: null },
    suppressed: { type: Boolean, default: false },
  },
  { _id: false }
);

const totalsSchema = new mongoose.Schema(
  {
    submitted: { type: Number, default: 0 },
    decided: { type: Number, default: 0 },
    upheld: { type: Number, default: 0 },
    partiallyUpheld: { type: Number, default: 0 },
    rejected: { type: Number, default: 0 },
    withdrawn: { type: Number, default: 0 },
    upheldRate: { type: Number, default: 0 },
    medianDaysToDecision: { type: Number, default: null },
    marksMoved: { type: Number, default: 0 },
    coursesReported: { type: Number, default: 0 },
    coursesSuppressed: { type: Number, default: 0 },
  },
  { _id: false }
);

const appealReportSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'A report title is required'],
      trim: true,
      maxlength: [160, 'Title cannot exceed 160 characters'],
    },

    academicYear: {
      type: String,
      trim: true,
      maxlength: [20, 'Academic year cannot exceed 20 characters'],
      default: '',
    },

    period: {
      label: {
        type: String,
        required: [true, 'A period label is required'],
        trim: true,
        maxlength: [60, 'Period label cannot exceed 60 characters'],
      },
      from: {
        type: Date,
        required: [true, 'A period start is required'],
      },
      to: {
        type: Date,
        required: [true, 'A period end is required'],
      },
    },

    scope: {
      type: String,
      enum: {
        values: SCOPES,
        message: 'Invalid report scope',
      },
      default: 'whole-school',
    },

    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      default: null,
    },

    courseName: {
      type: String,
      trim: true,
      maxlength: [120, 'Course name cannot exceed 120 characters'],
      default: '',
    },

    status: {
      type: String,
      enum: {
        values: REPORT_STATUSES,
        message: 'Invalid report status',
      },
      default: 'draft',
    },

    /**
     * Derived from `status` in `pre('save')`. MongoDB refuses `$ne` inside a
     * `partialFilterExpression`, so "one current report per period and scope"
     * has to be expressed as an equality on a flag.
     */
    isLive: {
      type: Boolean,
      default: true,
    },

    suppressionThreshold: {
      type: Number,
      default: DEFAULT_SUPPRESSION_THRESHOLD,
      min: [
        MIN_SUPPRESSION_THRESHOLD,
        `A suppression threshold below ${MIN_SUPPRESSION_THRESHOLD} does not suppress anything meaningful`,
      ],
      max: [50, 'A suppression threshold above 50 would suppress the whole report'],
    },

    rows: {
      type: [rowSchema],
      default: [],
    },

    totals: {
      type: totalsSchema,
      default: () => ({}),
    },

    // Counts per appeal reason, suppressed on the same rule as the rows.
    byReason: {
      type: [
        new mongoose.Schema(
          {
            reason: { type: String, trim: true },
            count: { type: Number, default: null },
            suppressed: { type: Boolean, default: false },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    narrative: {
      type: String,
      trim: true,
      maxlength: [2000, 'Narrative cannot exceed 2000 characters'],
      default: '',
    },

    computedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A report has to record who computed it'],
    },

    computedByName: {
      type: String,
      trim: true,
      maxlength: [100, 'Name cannot exceed 100 characters'],
      default: '',
    },

    computedAt: {
      type: Date,
      default: Date.now,
    },

    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    approvedByName: {
      type: String,
      trim: true,
      maxlength: [100, 'Name cannot exceed 100 characters'],
      default: '',
    },

    approvedAt: {
      type: Date,
    },

    publishedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    publishedAt: {
      type: Date,
    },

    withdrawnBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    withdrawnAt: {
      type: Date,
    },

    withdrawalReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Withdrawal reason cannot exceed 300 characters'],
      default: '',
    },

    /**
     * A digest over the figures as published.
     *
     * Not a security control — anybody with write access could recompute it.
     * It is an integrity check: it answers "are the numbers in this document
     * the ones that were approved", which is the question asked when a
     * published percentage and a quoted percentage disagree.
     */
    checksum: {
      type: String,
      trim: true,
      default: '',
    },

    supersedes: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AppealReport',
      default: null,
    },

    supersededBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AppealReport',
      default: null,
    },

    history: {
      type: [historyEntrySchema],
      default: [],
    },
  },
  { timestamps: true }
);

// One current report per period and scope. Two people preparing the same
// term's figures cannot each end up with their own published version.
appealReportSchema.index(
  { academicYear: 1, 'period.label': 1, scope: 1, course: 1 },
  { unique: true, partialFilterExpression: { isLive: true } }
);

appealReportSchema.index({ status: 1, publishedAt: -1 });

appealReportSchema.methods.log = function log(action, actor, note = '') {
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
 * The digest over what this report says.
 *
 * Only the figures go in — not the title, not the narrative, not the
 * timestamps — because the question it answers is "are these the numbers that
 * were approved", and a reworded heading does not change the numbers.
 */
appealReportSchema.methods.computeChecksum = function computeChecksum() {
  const canonical = JSON.stringify({
    period: {
      label: this.period.label,
      from: this.period.from,
      to: this.period.to,
    },
    threshold: this.suppressionThreshold,
    // Hashed exactly as stored, not as rendered. Suppression already nulled
    // these at computation, so re-nulling them here would leave a suppressed
    // row's hidden numbers outside the digest — and therefore editable after
    // approval without the checksum noticing.
    rows: this.rows.map((row) => [
      row.courseName,
      row.submitted,
      row.decided,
      row.upheld,
      row.partiallyUpheld,
      row.rejected,
      row.withdrawn,
      row.marksMoved,
      row.suppressed,
    ]),
    totals: [
      this.totals.submitted,
      this.totals.decided,
      this.totals.upheld,
      this.totals.partiallyUpheld,
      this.totals.rejected,
      this.totals.withdrawn,
      this.totals.marksMoved,
    ],
  });

  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
};

appealReportSchema.methods.checksumMatches = function checksumMatches() {
  if (!this.checksum) return false;
  return this.checksum === this.computeChecksum();
};

/**
 * Approval.
 *
 * The rule that makes a published figure mean something: not the person who
 * computed it. The same two-person rule the fee module applies to money,
 * applied here to a public statement.
 */
appealReportSchema.methods.approve = function approve(actor) {
  if (this.status !== 'draft') {
    throw new Error(`Only a draft report can be approved; this one is ${this.status}`);
  }
  if (!actor || !actor._id) {
    throw new Error('An approver is required');
  }
  if (String(this.computedBy) === String(actor._id)) {
    throw new Error('A report cannot be approved by the person who computed it');
  }

  this.status = 'approved';
  this.approvedBy = actor._id;
  this.approvedByName = actor.name || '';
  this.approvedAt = new Date();
  this.checksum = this.computeChecksum();

  return this.log('approved', actor, this.checksum);
};

appealReportSchema.methods.publish = function publish(actor) {
  if (this.status !== 'approved') {
    throw new Error(`Only an approved report can be published; this one is ${this.status}`);
  }

  // If the figures have moved since approval, what was approved is not what
  // would be published. That is a bug rather than a workflow step, so it stops
  // here rather than quietly re-stamping the digest.
  if (!this.checksumMatches()) {
    throw new Error(
      'The figures no longer match the ones that were approved. Compute a fresh report'
    );
  }

  this.status = 'published';
  this.publishedBy = actor ? actor._id : undefined;
  this.publishedAt = new Date();

  return this.log('published', actor);
};

/**
 * Withdrawal keeps `publishedAt`. The figures were published; that is now a
 * fact about the past and the record should say so.
 */
appealReportSchema.methods.withdraw = function withdraw(actor, reason) {
  if (this.status !== 'published') {
    throw new Error(`A ${this.status} report cannot be withdrawn`);
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('A withdrawal reason is required');
  }

  this.status = 'withdrawn';
  this.withdrawnBy = actor ? actor._id : undefined;
  this.withdrawnAt = new Date();
  this.withdrawalReason = String(reason).trim();

  return this.log('withdrawn', actor, this.withdrawalReason);
};

/**
 * What a member of the public sees.
 *
 * No `computedBy`, no `approvedBy`, no history. Publishing outcome statistics
 * is not a reason to publish the names of the people who prepared them.
 */
appealReportSchema.methods.toPublicRow = function toPublicRow() {
  return {
    _id: this._id,
    title: this.title,
    academicYear: this.academicYear,
    period: this.period,
    scope: this.scope,
    courseName: this.courseName,
    suppressionThreshold: this.suppressionThreshold,
    rows: this.rows,
    totals: this.totals,
    byReason: this.byReason,
    narrative: this.narrative,
    publishedAt: this.publishedAt,
    checksum: this.checksum,
    supersedes: this.supersedes,
  };
};

/** What staff see, with the accountability fields attached. */
appealReportSchema.methods.toRow = function toRow() {
  return {
    ...this.toPublicRow(),
    status: this.status,
    computedBy: this.computedBy,
    computedByName: this.computedByName,
    computedAt: this.computedAt,
    approvedByName: this.approvedByName,
    approvedAt: this.approvedAt,
    withdrawnAt: this.withdrawnAt,
    withdrawalReason: this.withdrawalReason,
    supersededBy: this.supersededBy,
    checksumValid: this.checksumMatches(),
    createdAt: this.createdAt,
  };
};

/**
 * Derived flag and the invariants that need more than one field.
 *
 * Mongoose 9 passes no callback to middleware, so this throws rather than
 * calling `next(err)`.
 */
appealReportSchema.pre('save', function beforeSave() {
  this.isLive = LIVE_STATUSES.includes(this.status);

  if (this.period && this.period.from && this.period.to) {
    if (this.period.to <= this.period.from) {
      throw new Error('A reporting period must end after it begins');
    }
  }

  if (this.scope === 'course' && !this.course) {
    throw new Error('A course-scoped report needs a course');
  }

  if (this.approvedBy && String(this.approvedBy) === String(this.computedBy)) {
    throw new Error('A report cannot be approved by the person who computed it');
  }

  // A published report is a record. Correcting it means computing a new one
  // that supersedes it, not editing the figures under the same identity.
  if (!this.isNew && (this.status === 'published' || this.status === 'withdrawn')) {
    const frozen = ['rows', 'totals', 'byReason', 'suppressionThreshold', 'period', 'scope'];
    const edited = frozen.find((field) => this.isModified(field));

    if (edited) {
      throw new Error(
        `"${edited}" cannot be changed once the report has been published; compute a superseding report instead`
      );
    }
  }
});

appealReportSchema.statics.STATUSES = REPORT_STATUSES;
appealReportSchema.statics.LIVE_STATUSES = LIVE_STATUSES;
appealReportSchema.statics.SCOPES = SCOPES;
appealReportSchema.statics.DEFAULT_SUPPRESSION_THRESHOLD = DEFAULT_SUPPRESSION_THRESHOLD;
appealReportSchema.statics.MIN_SUPPRESSION_THRESHOLD = MIN_SUPPRESSION_THRESHOLD;

/**
 * Apply the threshold to a set of freshly computed rows.
 *
 * Applied at computation, so unsuppressed per-course figures are never stored
 * on a document that can be published. The totals are computed from the raw
 * rows first — a school-wide total over hundreds of appeals discloses nothing
 * about anybody, and suppressing it would make the report useless.
 */
appealReportSchema.statics.suppress = function suppress(rawRows, threshold) {
  return rawRows.map((row) => {
    if (row.submitted >= threshold) {
      return { ...row, suppressed: false };
    }

    return {
      courseName: row.courseName,
      submitted: null,
      decided: null,
      upheld: null,
      partiallyUpheld: null,
      rejected: null,
      withdrawn: null,
      upheldRate: null,
      medianDaysToDecision: null,
      marksMoved: null,
      suppressed: true,
    };
  });
};

module.exports = mongoose.model('AppealReport', appealReportSchema);
