const mongoose = require('mongoose');

/**
 * Student conduct ledger — merit and demerit entries with a derived balance.
 *
 * Three properties do the work here, and each of them is a deliberate refusal
 * of the obvious implementation:
 *
 *   1. The ledger is APPEND-ONLY. There is no update path for `points`,
 *      `category` or `description`. An entry made in error is overturned, and
 *      the fact that it was made and then overturned stays visible. A conduct
 *      record that can be quietly rewritten after an argument with a parent is
 *      worth nothing.
 *
 *   2. Points come from a CATALOGUE, not from the teacher. If each teacher
 *      picks the number, the ledger measures how annoyed the teacher was
 *      rather than what the student did, and a balance computed across
 *      teachers means nothing.
 *
 *   3. The balance is DERIVED, never stored on the student. There is no
 *      counter, so there is nothing to drift out of step with the entries.
 */

const TYPES = ['merit', 'demerit'];

/**
 * The catalogue. One table, easy for a school to tune.
 *
 * `min`/`max` bound what a teacher may award for that category; a submitted
 * value outside the band is rejected rather than clamped, because silently
 * changing somebody's number is worse than telling them it was wrong.
 *
 * `expiresAfterDays` is null for merits — they do not age out. Demerits do:
 * a conduct system with no forgetting punishes an eleven-year-old for the rest
 * of their school career, and it also destroys its own signal, because a
 * balance where everything counts forever stops tracking current behaviour.
 */
const CATEGORY_CATALOGUE = {
  // --- Merits ---
  'academic-excellence': { type: 'merit', min: 3, max: 10, label: 'Academic excellence', expiresAfterDays: null },
  leadership: { type: 'merit', min: 3, max: 10, label: 'Leadership', expiresAfterDays: null },
  'community-service': { type: 'merit', min: 2, max: 8, label: 'Community service', expiresAfterDays: null },
  sportsmanship: { type: 'merit', min: 2, max: 8, label: 'Sportsmanship', expiresAfterDays: null },
  improvement: { type: 'merit', min: 2, max: 6, label: 'Marked improvement', expiresAfterDays: null },
  helpfulness: { type: 'merit', min: 1, max: 5, label: 'Helpfulness', expiresAfterDays: null },

  // --- Demerits ---
  'late-arrival': { type: 'demerit', min: 1, max: 3, label: 'Late arrival', expiresAfterDays: 90 },
  uniform: { type: 'demerit', min: 1, max: 3, label: 'Uniform', expiresAfterDays: 90 },
  homework: { type: 'demerit', min: 1, max: 4, label: 'Homework not done', expiresAfterDays: 120 },
  disruption: { type: 'demerit', min: 2, max: 6, label: 'Disruption in class', expiresAfterDays: 180 },
  disrespect: { type: 'demerit', min: 3, max: 8, label: 'Disrespect', expiresAfterDays: 240 },
  'property-damage': { type: 'demerit', min: 4, max: 10, label: 'Damage to property', expiresAfterDays: 365 },
  absconding: { type: 'demerit', min: 5, max: 12, label: 'Leaving without permission', expiresAfterDays: 365 },
  bullying: { type: 'demerit', min: 6, max: 15, label: 'Bullying', expiresAfterDays: 730 },
};

const STATUSES = ['active', 'appealed', 'upheld', 'overturned', 'expunged'];

/**
 * Only these statuses count toward a balance.
 *
 * `overturned` means the entry was wrong; `expunged` means it should never
 * have existed. Both stay readable — that is the append-only part — and
 * neither ever counts.
 */
const COUNTING_STATUSES = ['active', 'upheld'];

// How long a student has to appeal, from the date of the incident.
const APPEAL_WINDOW_DAYS = 14;

// The window the intervention thresholds look back over.
const ROLLING_WINDOW_DAYS = 60;

/**
 * Intervention tiers, in escalating order.
 *
 * A table rather than a chain of `if`s so the school can see the whole policy
 * at once and change it in one place. A student hits a tier when *either* the
 * demerit count in the rolling window or the net balance crosses its
 * threshold — six small incidents across six teachers look like nothing to
 * each of them individually, and nobody sees the sixth one land.
 */
const INTERVENTION_TIERS = [
  { tier: 'disciplinary-review', minDemerits: 24, maxNet: -20, label: 'Disciplinary review' },
  { tier: 'counselling-referral', minDemerits: 16, maxNet: -12, label: 'Counselling referral' },
  { tier: 'parent-informed', minDemerits: 10, maxNet: -6, label: 'Parent to be informed' },
  { tier: 'verbal-warning', minDemerits: 5, maxNet: -2, label: 'Verbal warning' },
];

/**
 * Atomic sequence allotment. `countDocuments() + 1` hands the same id to two
 * entries recorded at the same moment.
 */
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

const Counter =
  mongoose.models.ConductCounter || mongoose.model('ConductCounter', counterSchema);

/**
 * Whether an entry should be counted as of a given moment.
 *
 * Pure, and shared by `computeBalance` and `evaluateInterventions` so the two
 * can never disagree about which entries are live.
 */
function counts(entry, asOf = new Date()) {
  if (!COUNTING_STATUSES.includes(entry.status)) return false;
  if (entry.expiresOn && new Date(entry.expiresOn).getTime() <= asOf.getTime()) return false;
  return true;
}

/**
 * Merit total, demerit total and net, from the entries alone.
 */
function computeBalance(entries, asOf = new Date()) {
  let merit = 0;
  let demerit = 0;
  let counted = 0;
  let expired = 0;
  let excluded = 0;

  (entries || []).forEach((entry) => {
    if (!COUNTING_STATUSES.includes(entry.status)) {
      excluded += 1;
      return;
    }
    if (entry.expiresOn && new Date(entry.expiresOn).getTime() <= asOf.getTime()) {
      expired += 1;
      return;
    }
    counted += 1;
    if (entry.type === 'merit') merit += entry.points;
    else demerit += entry.points;
  });

  return {
    merit,
    demerit,
    net: merit - demerit,
    countedEntries: counted,
    expiredEntries: expired,
    excludedEntries: excluded,
    totalEntries: (entries || []).length,
  };
}

/**
 * Which intervention, if any, the ledger currently calls for.
 *
 * Returns the highest tier reached plus the numbers behind it, so the panel
 * can say *why* rather than just showing a badge.
 */
function evaluateInterventions(entries, asOf = new Date()) {
  const windowStart = new Date(asOf.getTime() - ROLLING_WINDOW_DAYS * 86400000);

  let rollingDemerits = 0;
  (entries || []).forEach((entry) => {
    if (entry.type !== 'demerit') return;
    if (!counts(entry, asOf)) return;
    if (new Date(entry.occurredOn).getTime() < windowStart.getTime()) return;
    rollingDemerits += entry.points;
  });

  const balance = computeBalance(entries, asOf);

  const reached = INTERVENTION_TIERS.find(
    (tier) => rollingDemerits >= tier.minDemerits || balance.net <= tier.maxNet
  );

  const reasons = [];
  if (reached) {
    if (rollingDemerits >= reached.minDemerits) {
      reasons.push(
        `${rollingDemerits} demerit points in the last ${ROLLING_WINDOW_DAYS} days (threshold ${reached.minDemerits})`
      );
    }
    if (balance.net <= reached.maxNet) {
      reasons.push(`net balance of ${balance.net} (threshold ${reached.maxNet})`);
    }
  }

  return {
    tier: reached ? reached.tier : 'none',
    label: reached ? reached.label : 'No action needed',
    rollingDemerits,
    rollingWindowDays: ROLLING_WINDOW_DAYS,
    net: balance.net,
    reasons,
  };
}

const auditSchema = new mongoose.Schema(
  {
    action: { type: String, required: true },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    performedByName: { type: String, trim: true },
    fromStatus: { type: String, default: null },
    toStatus: { type: String, default: null },
    detail: { type: String, trim: true, maxlength: 300, default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const conductEntrySchema = new mongoose.Schema(
  {
    entryId: {
      type: String,
      unique: true,
      index: true,
    },
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Student is required'],
      index: true,
    },
    studentName: {
      type: String,
      required: [true, 'Student name is required'],
      trim: true,
      maxlength: [80, 'Student name cannot exceed 80 characters'],
    },
    className: {
      type: String,
      trim: true,
      maxlength: [30, 'Class name cannot exceed 30 characters'],
      index: true,
    },
    type: {
      type: String,
      enum: { values: TYPES, message: 'Type must be merit or demerit' },
      required: [true, 'Type is required'],
    },
    category: {
      type: String,
      enum: {
        values: Object.keys(CATEGORY_CATALOGUE),
        message: 'Unknown conduct category',
      },
      required: [true, 'Category is required'],
    },
    points: {
      type: Number,
      required: [true, 'Points are required'],
      min: [1, 'Points must be at least 1'],
    },
    description: {
      type: String,
      required: [true, 'Say what happened'],
      trim: true,
      minlength: [10, 'Description must be at least 10 characters'],
      maxlength: [800, 'Description cannot exceed 800 characters'],
    },
    occurredOn: {
      type: Date,
      required: [true, 'Date of the incident is required'],
      index: true,
    },
    location: {
      type: String,
      trim: true,
      maxlength: [120, 'Location cannot exceed 120 characters'],
      default: null,
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    recordedByName: { type: String, trim: true },
    status: {
      type: String,
      enum: STATUSES,
      default: 'active',
      index: true,
    },
    // Derived from the category. Null for merits.
    expiresOn: { type: Date, default: null },

    appeal: {
      submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      submittedAt: { type: Date, default: null },
      statement: { type: String, trim: true, maxlength: 800, default: null },
      decision: {
        type: String,
        enum: ['upheld', 'overturned', null],
        default: null,
      },
      decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      decidedByName: { type: String, trim: true, default: null },
      decidedAt: { type: Date, default: null },
      decisionNote: { type: String, trim: true, maxlength: 500, default: null },
    },

    parentNotified: { type: Boolean, default: false },
    parentNotifiedAt: { type: Date, default: null },

    expungedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    expungedAt: { type: Date, default: null },
    expungementReason: { type: String, trim: true, maxlength: 300, default: null },

    auditTrail: { type: [auditSchema], default: [] },
  },
  { timestamps: true }
);

conductEntrySchema.index({ student: 1, occurredOn: -1 });
conductEntrySchema.index({ className: 1, occurredOn: -1 });
conductEntrySchema.index({ status: 1, type: 1 });

/**
 * Validates against the catalogue and derives `expiresOn`.
 *
 * Mongoose 9 has dropped callback-style middleware — a hook written
 * `pre('validate', function (next) {...})` is silently skipped, which would
 * take the entire points-band check with it and leave `expiresOn` unset. Async
 * function, throws rather than calling next(err).
 */
conductEntrySchema.pre('validate', async function derive() {
  const entry = CATEGORY_CATALOGUE[this.category];
  if (!entry) return; // the enum validator will report it

  // A merit filed under `bullying` is not a data-entry slip worth guessing at.
  if (entry.type !== this.type) {
    this.invalidate(
      'category',
      `"${entry.label}" is a ${entry.type} category and cannot be recorded as a ${this.type}`
    );
    return;
  }

  if (typeof this.points === 'number') {
    if (this.points < entry.min || this.points > entry.max) {
      this.invalidate(
        'points',
        `"${entry.label}" carries between ${entry.min} and ${entry.max} points; ${this.points} is outside that band`
      );
      return;
    }
  }

  if (this.occurredOn && this.occurredOn.getTime() > Date.now() + 86400000) {
    this.invalidate('occurredOn', 'That date is in the future');
    return;
  }

  if (this.isNew) {
    this.expiresOn = entry.expiresAfterDays
      ? new Date(
          (this.occurredOn || new Date()).getTime() + entry.expiresAfterDays * 86400000
        )
      : null;
  }
});

conductEntrySchema.virtual('categoryLabel').get(function categoryLabel() {
  return (CATEGORY_CATALOGUE[this.category] || {}).label || this.category;
});

conductEntrySchema.virtual('isExpired').get(function isExpired() {
  return Boolean(this.expiresOn && this.expiresOn.getTime() <= Date.now());
});

conductEntrySchema.virtual('countsTowardBalance').get(function countsTowardBalance() {
  return counts(this);
});

conductEntrySchema.virtual('appealDeadline').get(function appealDeadline() {
  if (!this.occurredOn) return null;
  return new Date(this.occurredOn.getTime() + APPEAL_WINDOW_DAYS * 86400000);
});

conductEntrySchema.virtual('canBeAppealed').get(function canBeAppealed() {
  return this.appealError() === null;
});

/**
 * Why this entry cannot be appealed, or null if it can.
 */
conductEntrySchema.methods.appealError = function appealError(now = new Date()) {
  if (this.status !== 'active') {
    return this.status === 'appealed'
      ? 'This entry has already been appealed.'
      : `A ${this.status} entry cannot be appealed.`;
  }
  const deadline = this.appealDeadline;
  if (deadline && now.getTime() > deadline.getTime()) {
    return `Appeals close ${APPEAL_WINDOW_DAYS} days after the incident.`;
  }
  return null;
};

conductEntrySchema.methods.recordAudit = function recordAudit(
  action,
  actor,
  detail = null,
  fromStatus = null,
  toStatus = null
) {
  this.auditTrail.push({
    action,
    performedBy: actor && (actor._id || actor.id),
    performedByName: actor && actor.name,
    fromStatus,
    toStatus,
    detail,
    at: new Date(),
  });
  return this;
};

/**
 * Files an appeal. Only the student the entry is against, only while active,
 * and only inside the window.
 */
conductEntrySchema.methods.submitAppeal = function submitAppeal(actor, statement) {
  if (String(this.student) !== String(actor._id || actor.id)) {
    const error = new Error('You can only appeal an entry recorded against you.');
    error.code = 'NOT_YOUR_ENTRY';
    throw error;
  }

  const refusal = this.appealError();
  if (refusal) {
    const error = new Error(refusal);
    error.code = 'APPEAL_REFUSED';
    throw error;
  }

  if (!statement || statement.trim().length < 20) {
    const error = new Error('Please explain the appeal in at least 20 characters.');
    error.code = 'APPEAL_TOO_SHORT';
    throw error;
  }

  const from = this.status;
  this.status = 'appealed';
  this.appeal.submittedBy = actor._id || actor.id;
  this.appeal.submittedAt = new Date();
  this.appeal.statement = statement.trim();

  this.recordAudit('appeal:submitted', actor, null, from, 'appealed');
  return this;
};

/**
 * Decides an appeal.
 *
 * The teacher who recorded the entry cannot decide the appeal against it. That
 * is not a comment on any individual teacher — it is that an appeal heard by
 * the person being appealed against is not an appeal, and a student can tell.
 */
conductEntrySchema.methods.decideAppeal = function decideAppeal(actor, decision, note) {
  if (this.status !== 'appealed') {
    const error = new Error(`There is no open appeal on this entry (it is ${this.status}).`);
    error.code = 'NO_OPEN_APPEAL';
    throw error;
  }

  const actorId = String(actor._id || actor.id);
  if (String(this.recordedBy) === actorId && actor.role !== 'admin') {
    const error = new Error(
      'The teacher who recorded an entry cannot decide the appeal against it.'
    );
    error.code = 'SELF_REVIEW';
    throw error;
  }

  if (!['upheld', 'overturned'].includes(decision)) {
    const error = new Error("Decision must be 'upheld' or 'overturned'.");
    error.code = 'BAD_DECISION';
    throw error;
  }

  const from = this.status;
  this.status = decision;
  this.appeal.decision = decision;
  this.appeal.decidedBy = actor._id || actor.id;
  this.appeal.decidedByName = actor.name;
  this.appeal.decidedAt = new Date();
  this.appeal.decisionNote = note || null;

  this.recordAudit(`appeal:${decision}`, actor, note || null, from, decision);
  return this;
};

/**
 * Expunges an entry. Admin only, reason required.
 *
 * Note what this does *not* do: it does not delete the document. The entry
 * stays on file, stops counting, and disappears from every listing except an
 * admin's. Deleting it would leave the ledger looking like the entry was never
 * made, which is exactly the property the append-only design exists to
 * prevent.
 */
conductEntrySchema.methods.expunge = function expunge(actor, reason) {
  if (actor.role !== 'admin') {
    const error = new Error('Only an administrator can expunge a conduct entry.');
    error.code = 'NOT_ADMIN';
    throw error;
  }
  if (this.status === 'expunged') {
    const error = new Error('This entry is already expunged.');
    error.code = 'ALREADY_EXPUNGED';
    throw error;
  }
  if (!reason || !reason.trim()) {
    const error = new Error('A reason is required to expunge an entry.');
    error.code = 'REASON_REQUIRED';
    throw error;
  }

  const from = this.status;
  this.status = 'expunged';
  this.expungedBy = actor._id || actor.id;
  this.expungedAt = new Date();
  this.expungementReason = reason.trim();

  this.recordAudit('entry:expunged', actor, reason.trim(), from, 'expunged');
  return this;
};

/**
 * Serialises for a viewer. A student sees their own entry without the audit
 * trail; staff see everything.
 */
conductEntrySchema.methods.redactFor = function redactFor(viewer) {
  const plain = this.toObject({ virtuals: true });
  delete plain.__v;

  const isStaff = viewer && ['teacher', 'staff', 'admin'].includes(viewer.role);
  if (isStaff) return plain;

  plain.auditTrail = [];
  return plain;
};

conductEntrySchema.statics.nextEntryId = async function nextEntryId() {
  const year = new Date().getFullYear();
  const counter = await Counter.findOneAndUpdate(
    { _id: `CDT-${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );
  return `CDT-${year}-${String(counter.seq).padStart(4, '0')}`;
};

conductEntrySchema.statics.computeBalance = computeBalance;
conductEntrySchema.statics.evaluateInterventions = evaluateInterventions;
conductEntrySchema.statics.counts = counts;
conductEntrySchema.statics.CATEGORY_CATALOGUE = CATEGORY_CATALOGUE;
conductEntrySchema.statics.INTERVENTION_TIERS = INTERVENTION_TIERS;
conductEntrySchema.statics.COUNTING_STATUSES = COUNTING_STATUSES;
conductEntrySchema.statics.STATUSES = STATUSES;
conductEntrySchema.statics.TYPES = TYPES;
conductEntrySchema.statics.APPEAL_WINDOW_DAYS = APPEAL_WINDOW_DAYS;
conductEntrySchema.statics.ROLLING_WINDOW_DAYS = ROLLING_WINDOW_DAYS;
conductEntrySchema.statics.Counter = Counter;

conductEntrySchema.set('toObject', { virtuals: true });
conductEntrySchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('ConductEntry', conductEntrySchema);
