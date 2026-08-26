const mongoose = require('mongoose');

/**
 * An expectation, written down before the period it describes.
 *
 * `analyticsController` answers *what happened*. Nothing in this codebase
 * answers *whether it was good*, because no expectation was ever recorded, so
 * every figure on the dashboard is read against a remembered one.
 *
 * Underneath that sits the more serious problem this model exists to solve.
 * `AnalyticsEvent` is an event log. Event logs are pruned — that is what they
 * are for and what eventually happens to them — and every number on the
 * dashboard is re-derived from it on every request. The moment the log is
 * trimmed, last year's figures change, and a judgement recorded in a governors'
 * minute becomes unverifiable against the system that produced it.
 *
 * So: **an actual is derived while the period is open and frozen when it
 * closes.** Open targets aggregate over the log. Closed targets read
 * `certifiedActual` and never touch it again. That single split is the reason
 * to build this, and it is the only place in the codebase where a number is
 * kept deliberately rather than recomputed by default.
 */

const STATUSES = ['draft', 'live', 'closed', 'abandoned'];

const DIRECTIONS = ['at-least', 'at-most'];

const SCOPE_KINDS = ['school', 'role'];

const ROLES = ['student', 'teacher', 'staff', 'admin'];

/**
 * How each metric is counted.
 *
 * `distinct` is the difference between "how many downloads" and "how many
 * people downloaded", and it matters more than it looks: every other metric
 * here is a row count, so a distinct-user metric implemented as one would be
 * wrong in a way nobody notices until two numbers are compared.
 */
const METRICS = {
  logins: { eventType: 'LOGIN', distinct: false, label: 'Logins' },
  'resource-downloads': {
    eventType: 'RESOURCE_DOWNLOAD',
    distinct: false,
    label: 'Resource downloads',
  },
  'ai-queries': { eventType: 'AI_QUERY', distinct: false, label: 'AI queries' },
  'active-users': { eventType: 'LOGIN', distinct: true, label: 'Active users' },
};

const METRIC_KEYS = Object.keys(METRICS);

// A window longer than this is not a target, it is a hope.
const MAX_PERIOD_DAYS = 550;

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

const scopeSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: { values: SCOPE_KINDS, message: 'Invalid scope kind' },
      default: 'school',
    },
    // Only meaningful when `kind` is `role`. Stored as an empty string rather
    // than null for school-wide targets, so the unique index has something
    // stable to key on.
    role: {
      type: String,
      enum: { values: [...ROLES, ''], message: 'Invalid role' },
      default: '',
    },
  },
  { _id: false }
);

const kpiTargetSchema = new mongoose.Schema(
  {
    metric: {
      type: String,
      enum: { values: METRIC_KEYS, message: 'Invalid metric' },
      required: [true, 'A metric is required'],
    },

    scope: { type: scopeSchema, default: () => ({ kind: 'school', role: '' }) },

    label: {
      type: String,
      required: [true, 'A label is required'],
      trim: true,
      maxlength: [140, 'Label cannot exceed 140 characters'],
    },

    // Why this number was chosen. The thing nobody can reconstruct a year
    // later, and the reason a missed target can be argued about honestly.
    rationale: {
      type: String,
      trim: true,
      maxlength: [1000, 'Rationale cannot exceed 1000 characters'],
      default: '',
    },

    periodStart: { type: Date, required: [true, 'A period start is required'] },
    periodEnd: { type: Date, required: [true, 'A period end is required'] },

    // A normalised handle for the window, derived. Calendar months, quarters
    // and years get a tidy key; anything else gets an explicit `custom:` key so
    // two irregular windows never collide by accident.
    periodKey: { type: String, trim: true, maxlength: [60, 'Too long'], default: '' },

    targetValue: {
      type: Number,
      required: [true, 'A target value is required'],
      min: [0, 'A target cannot be negative'],
    },

    direction: {
      type: String,
      enum: { values: DIRECTIONS, message: 'Invalid direction' },
      default: 'at-least',
    },

    unit: { type: String, trim: true, maxlength: [30, 'Too long'], default: 'count' },

    // Below this many distinct users in scope, the result is suppressed rather
    // than rounded. "Staff engagement 33%" against three staff members is a
    // number that should not be shown at all.
    minimumCohort: { type: Number, default: 5, min: [0, 'Cannot be negative'] },

    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    ownerName: { type: String, trim: true, maxlength: [120, 'Too long'], default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    status: {
      type: String,
      enum: { values: STATUSES, message: 'Invalid status' },
      default: 'draft',
    },

    activatedAt: { type: Date, default: null },

    // The frozen result. Written once, at closure, and never again.
    certifiedActual: { type: Number, default: null },
    certifiedAttainment: { type: Number, default: null },
    certifiedCohort: { type: Number, default: null },
    certifiedAt: { type: Date, default: null },
    certifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    varianceNote: { type: String, trim: true, maxlength: [1000, 'Too long'], default: '' },

    abandonedAt: { type: Date, default: null },
    abandonReason: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    // A corrected figure is a new target pointing at the old one, never an edit
    // to the number a decision was taken against.
    supersedes: { type: mongoose.Schema.Types.ObjectId, ref: 'KpiTarget', default: null },
    supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: 'KpiTarget', default: null },

    // Derived from `status`. It exists because a unique partial index cannot
    // express a negation — MongoDB rejects `$ne` inside a
    // partialFilterExpression — so the boolean is what the index filters on.
    isLive: { type: Boolean, default: false },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

/**
 * Half of the overlap rule.
 *
 * This catches the common case exactly — two people setting a target for the
 * same metric, the same scope and the same calendar month — and it catches it
 * even when both writes arrive in the same millisecond, which the query half
 * cannot. It does *not* catch a six-week window overlapping a monthly one;
 * that is what `overlapping()` is for. Neither half is redundant.
 */
kpiTargetSchema.index(
  { metric: 1, 'scope.kind': 1, 'scope.role': 1, periodKey: 1 },
  {
    unique: true,
    partialFilterExpression: { isLive: true },
    name: 'one_live_target_per_metric_scope_period',
  }
);

kpiTargetSchema.index({ status: 1, periodEnd: -1 });
kpiTargetSchema.index({ metric: 1, periodStart: 1, periodEnd: 1 });
kpiTargetSchema.index({ owner: 1, status: 1 });

/**
 * A tidy key for the window where one exists, and an explicit custom key where
 * it does not.
 */
function derivePeriodKey(start, end) {
  const from = new Date(start);
  const to = new Date(end);

  const iso = (d) => d.toISOString().slice(0, 10);

  const startsMonth = from.getUTCDate() === 1;
  // The stored end is exclusive-feeling but compared inclusively, so a calendar
  // month runs to the first of the next month.
  const endsMonth = to.getUTCDate() === 1 && to > from;

  if (startsMonth && endsMonth) {
    const months =
      (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
      (to.getUTCMonth() - from.getUTCMonth());

    if (months === 1) {
      return `${from.getUTCFullYear()}-M${String(from.getUTCMonth() + 1).padStart(2, '0')}`;
    }
    if (months === 3 && from.getUTCMonth() % 3 === 0) {
      return `${from.getUTCFullYear()}-Q${Math.floor(from.getUTCMonth() / 3) + 1}`;
    }
    if (months === 12 && from.getUTCMonth() === 0) {
      return `${from.getUTCFullYear()}-Y`;
    }
  }

  return `custom:${iso(from)}:${iso(to)}`;
}

kpiTargetSchema.pre('validate', function derive() {
  if (this.periodStart && this.periodEnd) {
    if (this.periodEnd <= this.periodStart) {
      this.invalidate('periodEnd', 'A period must end after it starts');
    } else {
      const days = (this.periodEnd - this.periodStart) / 86400000;
      if (days > MAX_PERIOD_DAYS) {
        this.invalidate(
          'periodEnd',
          `A target period cannot be longer than ${MAX_PERIOD_DAYS} days`
        );
      }
      this.periodKey = derivePeriodKey(this.periodStart, this.periodEnd);
    }
  }

  if (this.scope && this.scope.kind === 'school') {
    this.scope.role = '';
  }

  if (this.scope && this.scope.kind === 'role' && !this.scope.role) {
    this.invalidate('scope.role', 'A role-scoped target needs a role');
  }
});

kpiTargetSchema.pre('save', function guard() {
  this.isLive = this.status === 'live';

  // Once a target is live, the expectation is the expectation a period was run
  // against. Moving the goalposts mid-period is the failure this whole model
  // exists to make impossible.
  if (!this.isNew && ['live', 'closed'].includes(this.status)) {
    const frozen = ['targetValue', 'periodStart', 'periodEnd', 'metric', 'direction'];
    const edited = frozen.find((field) => this.isModified(field));

    if (edited) {
      throw new Error(`"${edited}" cannot be changed once the target is live`);
    }
  }

  if (this.status === 'closed' && this.certifiedActual === null) {
    throw new Error('A closed target must carry a certified actual');
  }
});

kpiTargetSchema.methods.recordHistory = function recordHistory(entry) {
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

kpiTargetSchema.methods.activate = function activate(actor) {
  if (this.status !== 'draft') {
    throw new Error(`Only a draft target can be activated; this one is ${this.status}`);
  }

  // A target written for a window that has already closed is a target written
  // to match a result somebody already knows.
  if (this.periodEnd <= new Date()) {
    throw new Error(
      'That period has already ended. A target cannot be set for a window whose result is known.'
    );
  }

  this.status = 'live';
  this.activatedAt = new Date();

  return this.recordHistory({
    action: 'activated',
    from: 'draft',
    to: 'live',
    by: actor._id,
    byName: actor.name,
  });
};

kpiTargetSchema.methods.abandon = function abandon(actor, reason) {
  if (!['draft', 'live'].includes(this.status)) {
    throw new Error(`A ${this.status} target cannot be abandoned`);
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('A reason is required to abandon a target');
  }

  const from = this.status;

  this.status = 'abandoned';
  this.abandonedAt = new Date();
  this.abandonReason = String(reason).trim();

  return this.recordHistory({
    action: 'abandoned',
    from,
    to: 'abandoned',
    note: this.abandonReason,
    by: actor._id,
    byName: actor.name,
  });
};

/**
 * Freeze the result.
 *
 * One-way, deliberately. A figure that turns out to have been wrong is
 * corrected by raising a new target that supersedes this one — not by editing
 * the number a decision was taken against.
 */
kpiTargetSchema.methods.certify = function certify(actor, { actual, attainment, cohort, note }) {
  if (this.status !== 'live') {
    throw new Error(`Only a live target can be certified; this one is ${this.status}`);
  }
  if (this.periodEnd > new Date()) {
    throw new Error('This period has not ended yet');
  }
  if (this.certifiedAt) {
    throw new Error('This target has already been certified');
  }

  this.status = 'closed';
  this.certifiedActual = actual;
  this.certifiedAttainment = attainment;
  this.certifiedCohort = cohort;
  this.certifiedAt = new Date();
  this.certifiedBy = actor._id;
  this.varianceNote = note || '';

  return this.recordHistory({
    action: 'certified',
    from: 'live',
    to: 'closed',
    note: `actual ${actual}`,
    by: actor._id,
    byName: actor.name,
  });
};

/**
 * Attainment, in the direction the metric actually runs.
 *
 * For `at-least` more is better and attainment is actual over target. For
 * `at-most` less is better, so it inverts. A single ratio used for both is
 * silently wrong for every `at-most` metric, which is the sort of error that
 * survives for years because the number still looks like a percentage.
 */
kpiTargetSchema.statics.attainmentFor = function attainmentFor(actual, targetValue, direction) {
  const a = Number(actual) || 0;
  const t = Number(targetValue) || 0;

  if (direction === 'at-most') {
    if (a === 0) return t === 0 ? 1 : Infinity;
    return t / a;
  }

  if (t === 0) return a > 0 ? Infinity : 1;
  return a / t;
};

kpiTargetSchema.statics.isMet = function isMet(actual, targetValue, direction) {
  const a = Number(actual) || 0;
  const t = Number(targetValue) || 0;
  return direction === 'at-most' ? a <= t : a >= t;
};

/**
 * How far through the window we are, and whether the run rate is enough.
 *
 * A target 40% through its period at 30% of its value is behind, and saying so
 * mid-term is the only version of this feature that changes anything. Pace is
 * derived from elapsed time on every request and is never stored.
 */
kpiTargetSchema.methods.pace = function pace(actual, now = new Date()) {
  if (this.status === 'closed' || this.status === 'abandoned') return null;
  if (now < this.periodStart) return null;

  const total = this.periodEnd - this.periodStart;
  const elapsed = Math.min(Math.max(now - this.periodStart, 0), total);
  const fraction = total > 0 ? elapsed / total : 1;

  if (fraction <= 0) return null;

  // Both directions accrue: an `at-least` target should have reached this much
  // by now, and an `at-most` budget should not yet have spent more than it.
  const expectedByNow = this.targetValue * fraction;

  const a = Number(actual) || 0;
  const onTrack = this.direction === 'at-most' ? a <= expectedByNow : a >= expectedByNow;

  return {
    elapsedFraction: Math.round(fraction * 1000) / 1000,
    expectedByNow: Math.round(expectedByNow * 100) / 100,
    onTrack,
    // Positive means ahead for `at-least`, and ahead for `at-most` too — the
    // sign is normalised so a single chip can read it.
    variance:
      Math.round(
        (this.direction === 'at-most' ? expectedByNow - a : a - expectedByNow) * 100
      ) / 100,
  };
};

/**
 * The other half of the overlap rule.
 *
 * Two windows overlap when each starts before the other ends. Run before every
 * activation, because the index can only compare normalised keys and a six-week
 * target genuinely overlapping a monthly one produces two different keys.
 */
kpiTargetSchema.statics.overlapping = function overlapping(target) {
  return this.find({
    _id: { $ne: target._id },
    metric: target.metric,
    'scope.kind': target.scope.kind,
    'scope.role': target.scope.role || '',
    isLive: true,
    periodStart: { $lt: target.periodEnd },
    periodEnd: { $gt: target.periodStart },
  });
};

kpiTargetSchema.statics.STATUSES = STATUSES;
kpiTargetSchema.statics.DIRECTIONS = DIRECTIONS;
kpiTargetSchema.statics.SCOPE_KINDS = SCOPE_KINDS;
kpiTargetSchema.statics.ROLES = ROLES;
kpiTargetSchema.statics.METRICS = METRICS;
kpiTargetSchema.statics.METRIC_KEYS = METRIC_KEYS;
kpiTargetSchema.statics.MAX_PERIOD_DAYS = MAX_PERIOD_DAYS;
kpiTargetSchema.statics.derivePeriodKey = derivePeriodKey;

module.exports = mongoose.model('KpiTarget', kpiTargetSchema);
