const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * When a class's report cards become visible, and to whom.
 *
 * `reportController.generateReportCard` builds a report card on demand from
 * whatever is in the database at that instant. There is no notion of a term
 * being finished and no notion of a report being *issued*, so a student can
 * pull their report halfway through marking, get a grade computed from three of
 * the eight assessments that will eventually count, and receive it as a PDF
 * that looks exactly like the real thing. Two hours later the same URL produces
 * a different grade, and neither document says which one it is.
 *
 * A PDF is not a screen. It gets forwarded, printed, and quoted back in
 * September.
 *
 * So a release is a deliberate, dated act, and the three things that make it
 * one are: **visibility is decided at read time**, **a hold is per student**,
 * and **release is one-way** — a correction is a revision that supersedes,
 * never an edit to the version a family already has.
 */

const STATUSES = ['preparing', 'scheduled', 'released', 'withdrawn', 'superseded'];

// The statuses in which this release is the authoritative one for its class.
// `preparing` deliberately is not among them: a revision has to be assembled
// while the previous release is still live.
const LIVE_STATUSES = ['scheduled', 'released'];

/**
 * Why a report is being held back.
 *
 * An enum rather than free text alone, because "how many are we holding and
 * why" is the question a head of year asks the day before parents' evening, and
 * free text cannot answer it.
 */
const HOLD_CATEGORIES = [
  'marks-incomplete',
  'under-appeal',
  'integrity-case',
  'fees',
  'safeguarding',
  'other',
];

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

const entrySchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'An entry needs a student'],
    },
    studentName: { type: String, trim: true, maxlength: [120, 'Too long'], default: '' },

    held: { type: Boolean, default: false },
    holdCategory: {
      type: String,
      enum: { values: [...HOLD_CATEGORIES, ''], message: 'Invalid hold category' },
      default: '',
    },
    holdReason: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },
    heldBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    heldAt: { type: Date, default: null },

    // Set when a hold is lifted after the class has already gone out, so the
    // one student's report becomes visible without re-releasing everybody.
    releasedIndividuallyAt: { type: Date, default: null },

    // A digest of the marks the report was computed from, taken at preparation.
    // Not the PDF: storing the rendered document doubles the storage of every
    // report and still cannot prove the marks behind it were the marks of the
    // day.
    snapshotHash: { type: String, trim: true, maxlength: [64, 'Too long'], default: '' },
    snapshotTakenAt: { type: Date, default: null },
  },
  { _id: true }
);

const reportReleaseSchema = new mongoose.Schema(
  {
    academicYear: {
      type: String,
      required: [true, 'An academic year is required'],
      trim: true,
      maxlength: [20, 'Too long'],
    },
    term: {
      type: String,
      required: [true, 'A term is required'],
      trim: true,
      maxlength: [40, 'Too long'],
    },
    className: {
      type: String,
      required: [true, 'A class is required'],
      trim: true,
      maxlength: [50, 'Too long'],
    },
    sections: { type: [{ type: String, trim: true, maxlength: [20, 'Too long'] }], default: [] },

    revision: { type: Number, default: 1, min: [1, 'Revisions start at 1'] },
    supersedes: { type: mongoose.Schema.Types.ObjectId, ref: 'ReportRelease', default: null },
    supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: 'ReportRelease', default: null },
    revisionReason: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    preparedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    preparedAt: { type: Date, default: Date.now },

    // When the reports *become* visible, which may be in the future. Compared
    // against the clock on every read rather than flipped by a job.
    releaseAt: { type: Date, default: null },

    // When a human actually pressed the button. Distinct from `releaseAt`, and
    // never cleared once set.
    releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    releasedAt: { type: Date, default: null },

    status: {
      type: String,
      enum: { values: STATUSES, message: 'Invalid release status' },
      default: 'preparing',
    },

    entries: { type: [entrySchema], default: [] },

    withdrawnBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    withdrawnAt: { type: Date, default: null },
    withdrawalReason: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    // Derived from `status`. It exists because a unique partial index cannot
    // express a negation — MongoDB rejects `$ne` inside a
    // partialFilterExpression — so the boolean is what the index filters on.
    isLive: { type: Boolean, default: false },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

/**
 * One authoritative release per class, per term.
 *
 * `preparing` is excluded from `isLive`, so a revision can be assembled while
 * the current release is still out — which is the whole point of revisions.
 */
reportReleaseSchema.index(
  { academicYear: 1, term: 1, className: 1 },
  {
    unique: true,
    partialFilterExpression: { isLive: true },
    name: 'one_live_release_per_class_term',
  }
);

// The student-facing lookup.
reportReleaseSchema.index({ 'entries.student': 1, isLive: 1 });
reportReleaseSchema.index({ status: 1, releaseAt: -1 });
reportReleaseSchema.index({ className: 1, academicYear: 1, term: 1, revision: -1 });

reportReleaseSchema.pre('save', function guard() {
  this.isLive = LIVE_STATUSES.includes(this.status);

  if (this.status === 'withdrawn' && !this.withdrawalReason) {
    throw new Error('A withdrawal reason is required');
  }

  // Once a class's reports have gone out, the roll they went out to is a fact.
  // Adding or removing students afterwards would change who was told what.
  if (!this.isNew && this.releasedAt && this.isModified('entries')) {
    const before = this.$locals.originalEntryCount;
    if (before !== undefined && before !== this.entries.length) {
      throw new Error('Students cannot be added to or removed from a released report run');
    }
  }
});

reportReleaseSchema.post('init', function remember() {
  // Stashed in $locals — Mongoose's documented per-document scratch space, not
  // persisted — so the guard above can tell an entry edit (a hold being lifted,
  // which is allowed) from a roll change (which is not).
  this.$locals.originalEntryCount = this.entries.length;
});

reportReleaseSchema.methods.recordHistory = function recordHistory(entry) {
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

reportReleaseSchema.methods.entryFor = function entryFor(studentId) {
  return (
    this.entries.find((entry) => String(entry.student) === String(studentId)) || null
  );
};

/**
 * Is this release actually showing anything yet?
 *
 * `releaseAt <= now` is evaluated here rather than by a job that flips a status
 * at four o'clock on results day. There is no scheduler in this repository, and
 * a scheduled release that depends on a job having run either leaks early or
 * never happens — both worse than not offering scheduling at all.
 */
reportReleaseSchema.methods.isShowingAt = function isShowingAt(now = new Date()) {
  if (!this.isLive) return false;
  if (this.status !== 'released') return false;
  if (this.releaseAt && this.releaseAt > now) return false;
  return true;
};

reportReleaseSchema.methods.hold = function hold(studentId, actor, { category, reason }) {
  const entry = this.entryFor(studentId);
  if (!entry) throw new Error('That student is not on this report run');

  if (!HOLD_CATEGORIES.includes(category)) {
    throw new Error('A hold needs a category');
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('A hold needs a reason');
  }

  entry.held = true;
  entry.holdCategory = category;
  entry.holdReason = String(reason).trim();
  entry.heldBy = actor._id;
  entry.heldAt = new Date();
  entry.releasedIndividuallyAt = null;

  return this.recordHistory({
    action: 'held',
    to: entry.studentName || String(studentId),
    note: `${category}: ${entry.holdReason}`,
    by: actor._id,
    byName: actor.name,
  });
};

/**
 * Lift one hold.
 *
 * If the class has already gone out, this makes that one student's report
 * visible immediately without re-releasing anybody else.
 */
reportReleaseSchema.methods.liftHold = function liftHold(studentId, actor, note = '') {
  const entry = this.entryFor(studentId);
  if (!entry) throw new Error('That student is not on this report run');
  if (!entry.held) throw new Error('That report is not being held');

  entry.held = false;
  entry.holdCategory = '';
  entry.holdReason = '';
  entry.releasedIndividuallyAt = this.status === 'released' ? new Date() : null;

  return this.recordHistory({
    action: 'hold-lifted',
    to: entry.studentName || String(studentId),
    note,
    by: actor._id,
    byName: actor.name,
  });
};

reportReleaseSchema.methods.release = function release(actor, { releaseAt } = {}) {
  if (this.status !== 'preparing' && this.status !== 'scheduled') {
    throw new Error(`A ${this.status} report run cannot be released`);
  }
  if (!this.entries.length) {
    throw new Error('There is nobody on this report run');
  }

  const now = new Date();
  const when = releaseAt ? new Date(releaseAt) : now;

  if (Number.isNaN(when.getTime())) throw new Error('That is not a valid release time');

  // Backdating would make the audit trail say the school published earlier than
  // it did, which is exactly the record a disputed grade turns on.
  if (when < now - 60000) {
    throw new Error('A release cannot be backdated');
  }

  const from = this.status;

  this.status = 'released';
  this.releaseAt = when;
  this.releasedBy = actor._id;
  this.releasedAt = now;

  return this.recordHistory({
    action: 'released',
    from,
    to: when > now ? `scheduled for ${when.toISOString()}` : 'released',
    by: actor._id,
    byName: actor.name,
  });
};

reportReleaseSchema.methods.withdraw = function withdraw(actor, reason) {
  if (this.status !== 'released' && this.status !== 'scheduled') {
    throw new Error(`A ${this.status} report run cannot be withdrawn`);
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('A withdrawal reason is required');
  }

  this.status = 'withdrawn';
  this.withdrawnBy = actor._id;
  this.withdrawnAt = new Date();
  this.withdrawalReason = String(reason).trim();

  // `releasedAt` is deliberately left alone. The reports *were* released; that
  // is now a fact about the past and the record should say so.
  return this.recordHistory({
    action: 'withdrawn',
    from: 'released',
    to: 'withdrawn',
    note: this.withdrawalReason,
    by: actor._id,
    byName: actor.name,
  });
};

reportReleaseSchema.methods.markSuperseded = function markSuperseded(replacement, actor) {
  this.status = 'superseded';
  this.supersededBy = replacement._id;

  return this.recordHistory({
    action: 'superseded',
    to: `revision ${replacement.revision}`,
    by: actor._id,
    byName: actor.name,
  });
};

/**
 * The gate.
 *
 * Every clause is evaluated here, at read time, and the answer carries a
 * machine-readable reason — "no" with no explanation is the response that
 * generates a phone call to the office.
 *
 * Exported as a static so `reportController.generateReportCard` can adopt it as
 * a three-line change. It is deliberately not wired in by this PR: that file has
 * open changes against it, and rewriting it here would put this work in conflict
 * with somebody else's.
 */
reportReleaseSchema.statics.visibilityFor = async function visibilityFor(
  studentId,
  { academicYear, term, now = new Date() } = {}
) {
  const filter = { 'entries.student': studentId, isLive: true };
  if (academicYear) filter.academicYear = academicYear;
  if (term) filter.term = term;

  const releases = await this.find(filter).sort({ releaseAt: -1 });

  if (!releases.length) {
    return {
      visible: false,
      reason: 'no-release',
      message: 'Report cards for this term have not been issued yet.',
      release: null,
    };
  }

  // The most recently released run that is actually showing wins.
  for (const release of releases) {
    const entry = release.entryFor(studentId);
    if (!entry) continue;

    if (!release.isShowingAt(now)) {
      return {
        visible: false,
        reason: release.releaseAt && release.releaseAt > now ? 'not-yet' : 'not-released',
        message:
          release.releaseAt && release.releaseAt > now
            ? `Report cards for this term are published on ${release.releaseAt.toDateString()}.`
            : 'Report cards for this term have not been issued yet.',
        release: release._id,
        releaseAt: release.releaseAt,
      };
    }

    if (entry.held) {
      return {
        visible: false,
        reason: 'held',
        // The category, never the reason. `holdReason` can name an integrity
        // case or fee arrears and is not for the student.
        message:
          'Your report card is being held. Please speak to the school office.',
        holdCategory: entry.holdCategory,
        release: release._id,
      };
    }

    return {
      visible: true,
      reason: 'released',
      message: 'Released',
      release: release._id,
      revision: release.revision,
      releasedAt: release.releasedAt,
      snapshotHash: entry.snapshotHash,
    };
  }

  return {
    visible: false,
    reason: 'no-release',
    message: 'Report cards for this term have not been issued yet.',
    release: null,
  };
};

/**
 * A digest of the marks a report was computed from.
 *
 * Sorted before hashing, because the order two queries return rows in is not
 * part of what the report said, and a hash that changes when it should not is
 * worse than no hash — it produces false disputes rather than settling real
 * ones.
 */
reportReleaseSchema.statics.snapshotOf = function snapshotOf(components) {
  const normalised = (components || [])
    .map((component) => ({
      k: String(component.key || ''),
      v: component.value === null || component.value === undefined ? '' : String(component.value),
    }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));

  return crypto.createHash('sha256').update(JSON.stringify(normalised)).digest('hex');
};

/**
 * How many are being held, and why.
 *
 * The question a head of year asks the day before parents' evening.
 */
reportReleaseSchema.methods.holdSummary = function holdSummary() {
  const byCategory = {};
  let held = 0;

  this.entries.forEach((entry) => {
    if (!entry.held) return;
    held += 1;
    byCategory[entry.holdCategory || 'other'] =
      (byCategory[entry.holdCategory || 'other'] || 0) + 1;
  });

  return {
    total: this.entries.length,
    held,
    releasable: this.entries.length - held,
    byCategory,
  };
};

reportReleaseSchema.statics.STATUSES = STATUSES;
reportReleaseSchema.statics.LIVE_STATUSES = LIVE_STATUSES;
reportReleaseSchema.statics.HOLD_CATEGORIES = HOLD_CATEGORIES;

module.exports = mongoose.model('ReportRelease', reportReleaseSchema);
