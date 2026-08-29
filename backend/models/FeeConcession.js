const mongoose = require('mongoose');

/**
 * Standing fee concessions: sibling, staff ward, quota, agreed bursary.
 *
 * `FeeInvoice` bills the total of a `FeeStructure` and keeps the money going in
 * honest. What it cannot express is the most ordinary thing a school does to a
 * bill — charge somebody less than the published rate, for a stated reason,
 * without pretending the published rate was different. The only lever today is
 * `waiveInvoice`, which is all-or-nothing and erases the record that anything
 * was ever owed.
 *
 * The property this file is built around is that **the invoice is never
 * edited**. `lineItems` and `totalAmount` go on saying exactly what the school
 * publishes for that class; the reduction is derived from the concessions live
 * on the day the invoice is read, and recomputed every time.
 *
 * A discount stored on the invoice is a number that stops matching its own
 * reason the moment the concession is revoked, a second one is approved, or the
 * scheme rate changes — and the failure is silent, because the invoice still
 * looks fine. Deriving it means revoking a concession corrects every unpaid
 * invoice at once, while the rate and basis frozen onto the concession at grant
 * time stop a scheme edit restating a bill somebody already paid.
 */

const CONCESSION_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'revoked',
  'expired',
];

// A concession in one of these reduces a bill and holds its slot. A rejected,
// revoked or expired one releases both.
const LIVE_STATUSES = ['approved'];

// ...and in one of these it occupies the unique slot, so a family cannot have
// two live requests for the same scheme running at once.
const HOLDING_STATUSES = ['draft', 'submitted', 'approved'];

const BASES = ['percentage', 'fixed'];

/**
 * Which parts of a bill a scheme is allowed to touch.
 *
 * `mandatory-only` reads `FeeStructure.components[].mandatory`, which already
 * exists and is exactly the flag that should decide this. A board examination
 * fee the school collects and remits onward is not the school's money and is
 * not discounted by a sibling concession.
 */
const APPLIES_TO = ['mandatory-only', 'tuition-only', 'all-components'];

// The ceiling on everything stacked together. Sibling 25 plus staff ward 50
// plus merit 20 is 95% off, and the only thing currently stopping that is that
// nobody has tried it yet.
const MAX_TOTAL_CONCESSION_PERCENT = 75;

// Labels treated as tuition when a scheme says `tuition-only`. Kept here rather
// than in a request so the answer to "is this line tuition" is the same for
// every family.
const TUITION_PATTERN = /tuition|academic\s*fee|instruction/i;

const YEAR_PATTERN = /^\d{4}-\d{4}$|^\d{4}-\d{2}$/;

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
 * What the school offers, defined once.
 *
 * A scheme is the policy; a concession is one family holding it. Separating
 * them is what makes "how much did we give away in sibling discounts this year"
 * a question with an answer.
 */
const concessionSchemeSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, 'A scheme needs a code'],
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: [40, 'Code cannot exceed 40 characters'],
      match: [/^[a-z0-9-]+$/, 'Code may contain lowercase letters, digits and hyphens only'],
    },
    name: {
      type: String,
      required: [true, 'A scheme needs a name'],
      trim: true,
      maxlength: [80, 'Name cannot exceed 80 characters'],
    },
    description: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    basis: {
      type: String,
      enum: { values: BASES, message: 'Invalid concession basis' },
      required: [true, 'A scheme needs a basis'],
    },
    rate: {
      type: Number,
      required: [true, 'A scheme needs a rate'],
      min: [1, 'A rate of zero is not a concession'],
    },

    appliesTo: {
      type: String,
      enum: { values: APPLIES_TO, message: 'Invalid appliesTo' },
      default: 'all-components',
    },

    /**
     * A non-stackable scheme, once applied, excludes every other. Used for the
     * schemes that are already a total settlement — a full staff remission is
     * not 100% plus a sibling discount.
     */
    stackable: { type: Boolean, default: true },

    requiresEvidence: { type: Boolean, default: true },
    evidenceLabel: { type: String, trim: true, maxlength: [120, 'Too long'], default: '' },

    academicYear: {
      type: String,
      required: [true, 'A scheme belongs to an academic year'],
      trim: true,
      match: [YEAR_PATTERN, 'Academic year must look like 2026-2027'],
    },

    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true }
);

concessionSchemeSchema.index({ academicYear: 1, isActive: 1 });

concessionSchemeSchema.pre('save', function guardScheme() {
  if (this.basis === 'percentage' && this.rate > 100) {
    throw new Error('A percentage concession cannot exceed 100%');
  }
});

const feeConcessionSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A concession must name a student'],
    },
    studentName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },
    className: { type: String, trim: true, maxlength: [40, 'Too long'], default: '' },

    academicYear: {
      type: String,
      required: [true, 'A concession belongs to an academic year'],
      trim: true,
      match: [YEAR_PATTERN, 'Academic year must look like 2026-2027'],
    },

    scheme: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ConcessionScheme',
      required: [true, 'A concession must name a scheme'],
    },
    schemeCode: { type: String, trim: true, default: '' },
    schemeName: { type: String, trim: true, default: '' },

    /**
     * Copied from the scheme at grant time and frozen afterwards.
     *
     * Changing a scheme from 25% to 20% next year must not restate the bill of
     * a family who was granted it at 25%. Reading the rate through the ref at
     * render time is how that happens by accident.
     */
    basis: {
      type: String,
      enum: { values: BASES, message: 'Invalid concession basis' },
      required: true,
    },
    rate: { type: Number, required: true, min: 1 },
    appliesTo: {
      type: String,
      enum: { values: APPLIES_TO, message: 'Invalid appliesTo' },
      default: 'all-components',
    },
    stackable: { type: Boolean, default: true },

    status: {
      type: String,
      enum: { values: CONCESSION_STATUSES, message: 'Invalid concession status' },
      default: 'draft',
    },

    reason: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    evidenceRequired: { type: Boolean, default: true },
    evidenceReference: { type: String, trim: true, maxlength: [120, 'Too long'], default: '' },
    evidenceSeenBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    evidenceSeenByName: { type: String, trim: true, default: '' },
    evidenceSeenAt: { type: Date, default: null },

    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    requestedByName: { type: String, trim: true, default: '' },
    submittedAt: { type: Date, default: null },

    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedByName: { type: String, trim: true, default: '' },
    approvedAt: { type: Date, default: null },

    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    revokedAt: { type: Date, default: null },
    revocationReason: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    effectiveFrom: { type: Date, default: Date.now },
    // Set at revocation. A concession is forward-only: invoices already settled
    // keep the figures they were settled on.
    effectiveTo: { type: Date, default: null },

    /**
     * Derived from `status`. It backs the unique partial index, because a
     * `partialFilterExpression` cannot express a negation and a rejected
     * concession has to release its slot so a corrected one can be granted.
     */
    isHolding: { type: Boolean, default: true },

    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true }
);

// One live concession per student per scheme per year.
feeConcessionSchema.index(
  { student: 1, scheme: 1, academicYear: 1 },
  { unique: true, partialFilterExpression: { isHolding: true } }
);

feeConcessionSchema.index({ student: 1, academicYear: 1, status: 1 });
feeConcessionSchema.index({ status: 1, createdAt: -1 });
feeConcessionSchema.index({ academicYear: 1, schemeCode: 1, status: 1 });

feeConcessionSchema.pre('save', function guardConcession() {
  this.isHolding = HOLDING_STATUSES.includes(this.status);

  if (this.approvedBy && this.requestedBy && this.approvedBy.equals(this.requestedBy)) {
    throw new Error('A concession cannot be approved by the person who requested it');
  }

  if (this.evidenceSeenBy && this.requestedBy && this.evidenceSeenBy.equals(this.requestedBy)) {
    throw new Error('Evidence cannot be verified by the person who requested the concession');
  }

  if (this.basis === 'percentage' && this.rate > 100) {
    throw new Error('A percentage concession cannot exceed 100%');
  }

  // Once decided, the terms it was decided on are fixed.
  if (!this.isNew && !['draft', 'submitted'].includes(this.status)) {
    const frozen = ['basis', 'rate', 'appliesTo', 'scheme', 'student', 'academicYear'];
    const edited = frozen.find((field) => this.isModified(field));

    if (edited) {
      throw new Error(`"${edited}" cannot be changed once the concession has been decided`);
    }
  }
});

feeConcessionSchema.methods.log = function log(action, actor, note = '') {
  this.history.push({
    action,
    by: actor ? actor._id : undefined,
    byName: (actor && actor.name) || '',
    at: new Date(),
    note,
  });

  return this;
};

feeConcessionSchema.methods.isLiveOn = function isLiveOn(when = new Date()) {
  if (!LIVE_STATUSES.includes(this.status)) return false;
  if (this.effectiveFrom && this.effectiveFrom > when) return false;
  if (this.effectiveTo && this.effectiveTo <= when) return false;
  return true;
};

feeConcessionSchema.methods.submit = function submit(actor) {
  if (this.status !== 'draft') {
    throw new Error(`Only a draft concession can be submitted; this one is ${this.status}`);
  }

  this.status = 'submitted';
  this.submittedAt = new Date();

  return this.log('submitted', actor);
};

feeConcessionSchema.methods.recordEvidence = function recordEvidence(actor, reference) {
  if (!['draft', 'submitted'].includes(this.status)) {
    throw new Error('Evidence can only be recorded before the concession is decided');
  }
  if (!reference || !String(reference).trim()) {
    throw new Error('An evidence reference is required');
  }
  if (this.requestedBy && actor._id.equals(this.requestedBy)) {
    throw new Error('Evidence cannot be verified by the person who requested the concession');
  }

  this.evidenceReference = String(reference).trim();
  this.evidenceSeenBy = actor._id;
  this.evidenceSeenByName = actor.name || '';
  this.evidenceSeenAt = new Date();

  return this.log('evidence-verified', actor, this.evidenceReference);
};

feeConcessionSchema.methods.approve = function approve(actor) {
  if (this.status !== 'submitted') {
    throw new Error(`Only a submitted concession can be approved; this one is ${this.status}`);
  }
  if (this.requestedBy && actor._id.equals(this.requestedBy)) {
    throw new Error('A concession cannot be approved by the person who requested it');
  }
  if (this.evidenceRequired && !this.evidenceSeenAt) {
    throw new Error('This scheme requires evidence, and none has been verified');
  }

  this.status = 'approved';
  this.approvedBy = actor._id;
  this.approvedByName = actor.name || '';
  this.approvedAt = new Date();

  return this.log('approved', actor);
};

feeConcessionSchema.methods.reject = function reject(actor, reason) {
  if (!['draft', 'submitted'].includes(this.status)) {
    throw new Error(`A ${this.status} concession cannot be rejected`);
  }
  if (this.requestedBy && actor._id.equals(this.requestedBy)) {
    throw new Error('A concession cannot be rejected by the person who requested it');
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('A rejection reason is required');
  }

  this.status = 'rejected';
  this.rejectedBy = actor._id;
  this.rejectedAt = new Date();
  this.rejectionReason = String(reason).trim();

  return this.log('rejected', actor, this.rejectionReason);
};

feeConcessionSchema.methods.revoke = function revoke(actor, reason) {
  if (this.status !== 'approved') {
    throw new Error(`Only an approved concession can be revoked; this one is ${this.status}`);
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('A revocation reason is required');
  }

  this.status = 'revoked';
  this.revokedBy = actor._id;
  this.revokedAt = new Date();
  this.revocationReason = String(reason).trim();
  // Forward-only. Anything already settled keeps the figures it was settled on.
  this.effectiveTo = new Date();

  return this.log('revoked', actor, this.revocationReason);
};

/**
 * Which of an invoice's line items a scheme is allowed to reduce.
 *
 * Matched against the structure's components by label, because that is the only
 * link between the two — `lineItemSchema` carries no `mandatory` flag of its
 * own. A line with no matching component is treated as non-mandatory, which is
 * the conservative reading: an unrecognised line is not automatically a
 * pass-through the school may not discount, but neither is it counted as one.
 */
const eligibleBaseFor = (invoice, structure, appliesTo) => {
  const lines = invoice.lineItems || [];

  if (appliesTo === 'all-components') {
    return lines.reduce((sum, line) => sum + (line.amount || 0), 0);
  }

  if (appliesTo === 'tuition-only') {
    return lines
      .filter((line) => TUITION_PATTERN.test(line.label || ''))
      .reduce((sum, line) => sum + (line.amount || 0), 0);
  }

  const mandatory = new Map(
    ((structure && structure.components) || []).map((component) => [
      String(component.label || '').trim().toLowerCase(),
      component.mandatory !== false,
    ])
  );

  return lines
    .filter((line) => mandatory.get(String(line.label || '').trim().toLowerCase()) === true)
    .reduce((sum, line) => sum + (line.amount || 0), 0);
};

/**
 * Apportion a rounded total back across the schemes that produced it.
 *
 * Largest remainder, so the per-scheme figures always add up to the total
 * shown. Rounding each scheme's share independently and then summing is exactly
 * how a concession total stops matching the invoice it came from — and it is
 * the family, reading two numbers that differ by one rupee, who notices.
 */
const apportion = (shares, total) => {
  const raw = shares.map((share) => share.raw);
  const rawTotal = raw.reduce((sum, value) => sum + value, 0);

  if (rawTotal <= 0 || total <= 0) {
    return shares.map((share) => ({ ...share, amount: 0 }));
  }

  const scaled = raw.map((value) => (value / rawTotal) * total);
  const floors = scaled.map((value) => Math.floor(value));
  let remainder = total - floors.reduce((sum, value) => sum + value, 0);

  const order = scaled
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);

  const amounts = floors.slice();
  for (let i = 0; remainder > 0 && i < order.length; i += 1) {
    amounts[order[i].index] += 1;
    remainder -= 1;
  }

  return shares.map((share, index) => ({ ...share, amount: amounts[index] }));
};

/**
 * The whole arithmetic of the module.
 *
 * Fixed amounts first, then percentages largest-first, clamped at the stacking
 * ceiling and again at what is still owed, rounded once at the end and
 * apportioned back so the rows sum to the total.
 *
 * A static over the concessions rather than a field on the invoice, for the
 * reason the file header gives: a stored figure is a figure that has stopped
 * being true and cannot say so.
 */
feeConcessionSchema.statics.applyTo = function applyTo(invoice, structure, concessions, when = new Date()) {
  const total = invoice.totalAmount || 0;
  const paid = invoice.amountPaid || 0;
  const outstanding = Math.max(0, total - paid);

  const live = (concessions || []).filter((concession) =>
    typeof concession.isLiveOn === 'function'
      ? concession.isLiveOn(when)
      : LIVE_STATUSES.includes(concession.status)
  );

  // Fixed first — a fixed amount is a settled figure, and letting a percentage
  // consume the ceiling ahead of it is how a promised ₹5,000 becomes ₹3,200.
  const ordered = live
    .slice()
    .sort((a, b) => {
      if (a.basis !== b.basis) return a.basis === 'fixed' ? -1 : 1;
      return b.rate - a.rate;
    });

  const shares = [];
  let excluded = null;

  for (const concession of ordered) {
    if (excluded) {
      shares.push({
        concession,
        raw: 0,
        base: 0,
        suppressed: `Excluded by ${excluded.schemeName}, which does not stack`,
      });
      continue;
    }

    const base = eligibleBaseFor(invoice, structure, concession.appliesTo);
    const raw =
      concession.basis === 'percentage'
        ? (base * concession.rate) / 100
        : Math.min(concession.rate, base);

    shares.push({ concession, raw, base, suppressed: null });

    if (!concession.stackable) excluded = concession;
  }

  const rawTotal = shares.reduce((sum, share) => sum + share.raw, 0);

  // Both ceilings, applied to the total rather than per scheme. Clamping each
  // scheme separately lets three of them add up past the limit the clamp was
  // supposed to enforce.
  const stackingCeiling = (total * MAX_TOTAL_CONCESSION_PERCENT) / 100;
  const clampedRaw = Math.min(rawTotal, stackingCeiling, outstanding);

  // Rounded once, here, at the end.
  const concessionAmount = Math.round(Math.max(0, clampedRaw));

  return {
    totalAmount: total,
    amountPaid: paid,
    outstanding,
    concessionAmount,
    netPayable: Math.max(0, total - concessionAmount),
    stillOwed: Math.max(0, outstanding - concessionAmount),
    rawTotal: Math.round(rawTotal),
    stackingCeiling: Math.round(stackingCeiling),
    stackingCeilingPercent: MAX_TOTAL_CONCESSION_PERCENT,
    cappedByStacking: rawTotal > stackingCeiling && stackingCeiling <= outstanding,
    cappedByOutstanding: rawTotal > outstanding && outstanding < stackingCeiling,
    rows: apportion(shares, concessionAmount).map((share) => ({
      concession: share.concession._id,
      schemeCode: share.concession.schemeCode,
      schemeName: share.concession.schemeName,
      basis: share.concession.basis,
      rate: share.concession.rate,
      appliesTo: share.concession.appliesTo,
      eligibleBase: Math.round(share.base),
      amount: share.amount,
      suppressed: share.suppressed,
    })),
  };
};

feeConcessionSchema.statics.CONCESSION_STATUSES = CONCESSION_STATUSES;
feeConcessionSchema.statics.LIVE_STATUSES = LIVE_STATUSES;
feeConcessionSchema.statics.HOLDING_STATUSES = HOLDING_STATUSES;
feeConcessionSchema.statics.BASES = BASES;
feeConcessionSchema.statics.APPLIES_TO = APPLIES_TO;
feeConcessionSchema.statics.MAX_TOTAL_CONCESSION_PERCENT = MAX_TOTAL_CONCESSION_PERCENT;
feeConcessionSchema.statics.eligibleBaseFor = eligibleBaseFor;

concessionSchemeSchema.statics.BASES = BASES;
concessionSchemeSchema.statics.APPLIES_TO = APPLIES_TO;

const ConcessionScheme = mongoose.model('ConcessionScheme', concessionSchemeSchema);
const FeeConcession = mongoose.model('FeeConcession', feeConcessionSchema);

module.exports = FeeConcession;
module.exports.FeeConcession = FeeConcession;
module.exports.ConcessionScheme = ConcessionScheme;
