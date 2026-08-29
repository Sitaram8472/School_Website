const mongoose = require('mongoose');

/**
 * Employer matching, and the budget it is drawn from.
 *
 * `Pledge` is careful about the difference between money promised and money
 * received, because the thermometer in reception must not show funds nobody has
 * sent. This file extends that care to a third kind of money, which the school
 * currently records nowhere: the match an employer pays on top of a gift its
 * employee has already made.
 *
 * The rule the whole module exists for is that **a claim is raised against a
 * payment that actually arrived**. Not against a pledge — against one specific
 * payment on it, found by reference. A claim for a gift nobody made is the
 * failure mode that turns matching from income into a receivable that never
 * lands, and it is the failure the spreadsheet version produces every year.
 *
 * The second rule is that a submitted claim already *holds* part of the
 * employer's budget. Two people in the development office must not both be able
 * to lodge a claim against the last forty thousand rupees of a programme while
 * the first is still with that employer's payroll department.
 */

const PROGRAMME_STATUSES = ['active', 'paused', 'closed'];

const CLAIM_STATUSES = ['draft', 'submitted', 'verified', 'received', 'declined', 'withdrawn'];

// Statuses that still hold part of the employer's budget and the donor's annual
// cap. Declining and withdrawing release it; everything else keeps it spoken
// for, including `received`, which has spent it outright.
const ENCUMBERING_STATUSES = ['submitted', 'verified', 'received'];

const DECLINE_REASONS = [
  'outside-claim-window',
  'donor-not-eligible',
  'programme-budget-exhausted',
  'evidence-insufficient',
  'employer-policy-changed',
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

/* ------------------------------------------------------------------------- *
 * The programme: what one employer has agreed to do
 * ------------------------------------------------------------------------- */

const matchingGiftProgrammeSchema = new mongoose.Schema(
  {
    employerName: {
      type: String,
      required: [true, 'An employer name is required'],
      trim: true,
      maxlength: [140, 'Employer name cannot exceed 140 characters'],
    },

    // Derived from the name, and the handle staff actually type.
    slug: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: [160, 'Slug cannot exceed 160 characters'],
    },

    contactName: { type: String, trim: true, maxlength: [120, 'Too long'], default: '' },
    contactEmail: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: [120, 'Too long'],
      default: '',
    },

    // The multiplier applied to the employee's gift. 0.5 is a half match, 2 is
    // a double match; both are ordinary.
    matchRatio: {
      type: Number,
      required: [true, 'A match ratio is required'],
      min: [0.01, 'A match ratio must be greater than zero'],
      max: [10, 'A match ratio above 10 is almost certainly a typo'],
    },

    // The most one employee may have matched in a programme year.
    perDonorAnnualCap: {
      type: Number,
      required: [true, 'A per-donor annual cap is required'],
      min: [1, 'The per-donor cap must be greater than zero'],
    },

    // The most this employer will spend in total. Null means uncapped, which is
    // a different fact from "we have not asked".
    programmeBudget: {
      type: Number,
      default: null,
      min: [1, 'A programme budget must be greater than zero'],
    },

    // How long after the gift a claim may still be lodged. Every real
    // programme has one, and missing it is how matching money is lost.
    claimWindowDays: {
      type: Number,
      required: [true, 'A claim window is required'],
      min: [1, 'A claim window must be at least one day'],
      max: [1095, 'A claim window beyond three years is not a window'],
    },

    startsOn: { type: Date, required: [true, 'A start date is required'] },
    endsOn: { type: Date, default: null },

    status: {
      type: String,
      enum: { values: PROGRAMME_STATUSES, message: 'Invalid programme status' },
      default: 'active',
    },

    // Evidence this employer insists on before it will pay.
    requiresPayrollId: { type: Boolean, default: false },
    requiresReceiptCopy: { type: Boolean, default: true },

    notes: { type: String, trim: true, maxlength: [1000, 'Too long'], default: '' },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

matchingGiftProgrammeSchema.index({ slug: 1 }, { unique: true });
matchingGiftProgrammeSchema.index({ status: 1, employerName: 1 });

matchingGiftProgrammeSchema.pre('validate', function derive() {
  if (this.employerName && !this.slug) {
    this.slug = this.employerName
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 160);
  }

  if (this.endsOn && this.startsOn && this.endsOn <= this.startsOn) {
    this.invalidate('endsOn', 'A programme cannot end before it starts');
  }
});

/**
 * Whether a claim may be lodged against this programme at all, and why not.
 *
 * Returned as a reason string rather than a boolean because "no" without a
 * reason is the response that gets re-tried until somebody rings the school.
 */
matchingGiftProgrammeSchema.methods.blockedReason = function blockedReason(now = new Date()) {
  if (this.status === 'closed') return 'This matching programme has closed';
  if (this.status === 'paused') return 'This matching programme is currently paused';
  if (this.startsOn && this.startsOn > now) {
    return 'This matching programme has not opened yet';
  }
  if (this.endsOn && this.endsOn < now) return 'This matching programme has ended';
  return null;
};

matchingGiftProgrammeSchema.methods.recordHistory = function recordHistory(entry) {
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

matchingGiftProgrammeSchema.statics.STATUSES = PROGRAMME_STATUSES;

/* ------------------------------------------------------------------------- *
 * The claim: one employer match, for one gift
 * ------------------------------------------------------------------------- */

const matchingGiftClaimSchema = new mongoose.Schema(
  {
    programme: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MatchingGiftProgramme',
      required: [true, 'A claim must belong to a matching programme'],
    },

    // Denormalised the way Pledge denormalises the donor, so a claim queue
    // renders without a join per row.
    employerName: { type: String, trim: true, maxlength: [140, 'Too long'], default: '' },

    pledge: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Pledge',
      required: [true, 'A claim must reference the pledge the gift was made against'],
    },

    // Which payment on that pledge. This, with `pledge`, is the identity of the
    // gift being matched, and the pair carries the unique index.
    paymentReference: {
      type: String,
      required: [true, 'A payment reference is required'],
      trim: true,
      maxlength: [80, 'Reference cannot exceed 80 characters'],
    },

    campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign' },

    donor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    donorName: {
      type: String,
      required: [true, 'A donor name is required'],
      trim: true,
      maxlength: [120, 'Too long'],
    },

    // A frozen copy of the payment amount, taken from the ledger rather than
    // typed. A claim whose stated gift disagrees with the pledge is
    // unanswerable when the employer queries it.
    giftAmount: {
      type: Number,
      required: [true, 'The gift amount is required'],
      min: [0.01, 'A gift amount must be greater than zero'],
    },

    // The date the money arrived, copied for the same reason, and the date the
    // claim window is measured from.
    giftReceivedOn: {
      type: Date,
      required: [true, 'The date the gift was received is required'],
    },

    claimedAmount: {
      type: Number,
      required: [true, 'A claimed amount is required'],
      min: [0.01, 'A claimed amount must be greater than zero'],
    },

    currency: { type: String, default: 'INR', uppercase: true, trim: true },

    status: {
      type: String,
      enum: { values: CLAIM_STATUSES, message: 'Invalid claim status' },
      default: 'draft',
    },

    payrollId: { type: String, trim: true, maxlength: [60, 'Too long'], default: '' },

    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    submittedAt: { type: Date, default: null },

    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    verifiedAt: { type: Date, default: null },
    verificationNote: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    declinedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    declinedAt: { type: Date, default: null },
    declineReason: {
      type: String,
      enum: { values: DECLINE_REASONS, message: 'Invalid decline reason' },
      default: null,
    },
    declineNote: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    withdrawnAt: { type: Date, default: null },
    withdrawalNote: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    receivedAt: { type: Date, default: null },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // The employer's own reference for the payment. Idempotency key for
    // recording receipt: a retried "mark received" finds this and moves
    // nothing.
    receiptReference: { type: String, trim: true, maxlength: [80, 'Too long'], default: null },

    // Derived from `status`. It exists because a unique partial index cannot
    // express a negation — MongoDB rejects `$ne` inside a
    // partialFilterExpression — so the boolean is what the index filters on.
    isEncumbering: { type: Boolean, default: false },

    // The programme year the donor's annual cap is counted within, derived
    // from `giftReceivedOn` so that a claim lodged in April against a March
    // gift is counted in March's year.
    capYear: { type: Number, default: null },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

/**
 * The once-only guarantee: one gift, one claim.
 *
 * At the database rather than in the controller, because the duplicate this
 * exists to stop is two members of the development office working the same
 * donor list within the same minute.
 */
matchingGiftClaimSchema.index(
  { pledge: 1, paymentReference: 1 },
  { unique: true, name: 'one_claim_per_gift' }
);

// Receipt references are only present once the money is in, so uniqueness has
// to be partial or every unreceived claim would collide on null.
matchingGiftClaimSchema.index(
  { receiptReference: 1 },
  {
    unique: true,
    partialFilterExpression: { receiptReference: { $type: 'string' } },
    name: 'receipt_reference_unique',
  }
);

// The two ceiling queries.
matchingGiftClaimSchema.index({ programme: 1, isEncumbering: 1 });
matchingGiftClaimSchema.index({ donor: 1, programme: 1, capYear: 1, isEncumbering: 1 });

matchingGiftClaimSchema.index({ status: 1, createdAt: -1 });
matchingGiftClaimSchema.index({ campaign: 1, status: 1 });

/**
 * Keep the derived fields in step, and refuse the edits that would make an
 * already-verified claim a different claim.
 */
matchingGiftClaimSchema.pre('save', function guard() {
  this.isEncumbering = ENCUMBERING_STATUSES.includes(this.status);

  if (this.giftReceivedOn) {
    this.capYear = new Date(this.giftReceivedOn).getUTCFullYear();
  }

  // Once the school has told an employer what it is claiming, the numbers on
  // the claim are the numbers that were sent. Correcting them means withdrawing
  // and raising another, so the claim the employer received still exists.
  if (!this.isNew && ['verified', 'received'].includes(this.status)) {
    const frozen = ['giftAmount', 'pledge', 'paymentReference', 'donor', 'programme'];
    const edited = frozen.find((field) => this.isModified(field));

    if (edited) {
      throw new Error(`"${edited}" cannot be changed once the claim has been verified`);
    }
  }

  if (this.verifiedBy && this.donor && String(this.verifiedBy) === String(this.donor)) {
    throw new Error('A donor cannot verify the matching claim on their own gift');
  }

  if (
    this.verifiedBy &&
    this.submittedBy &&
    String(this.verifiedBy) === String(this.submittedBy)
  ) {
    throw new Error('A matching claim cannot be verified by the person who submitted it');
  }

  if (this.declineReason === 'other' && !this.declineNote) {
    throw new Error('A note is required when the decline reason is "other"');
  }
});

matchingGiftClaimSchema.methods.recordHistory = function recordHistory(entry) {
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

matchingGiftClaimSchema.methods.isOwnedBy = function isOwnedBy(user) {
  if (!user || !this.donor) return false;
  return String(this.donor) === String(user._id);
};

matchingGiftClaimSchema.methods.submit = function submit(actor) {
  if (this.status !== 'draft') {
    throw new Error(`Only a draft claim can be submitted; this one is ${this.status}`);
  }

  this.status = 'submitted';
  this.submittedBy = actor._id;
  this.submittedAt = new Date();

  return this.recordHistory({
    action: 'submitted',
    from: 'draft',
    to: 'submitted',
    by: actor._id,
    byName: actor.name,
  });
};

matchingGiftClaimSchema.methods.verify = function verify(actor, note = '') {
  if (this.status !== 'submitted') {
    throw new Error(`Only a submitted claim can be verified; this one is ${this.status}`);
  }
  if (this.donor && String(actor._id) === String(this.donor)) {
    throw new Error('A donor cannot verify the matching claim on their own gift');
  }
  if (this.submittedBy && String(actor._id) === String(this.submittedBy)) {
    throw new Error('A matching claim cannot be verified by the person who submitted it');
  }

  this.status = 'verified';
  this.verifiedBy = actor._id;
  this.verifiedAt = new Date();
  this.verificationNote = note || '';

  return this.recordHistory({
    action: 'verified',
    from: 'submitted',
    to: 'verified',
    note,
    by: actor._id,
    byName: actor.name,
  });
};

matchingGiftClaimSchema.methods.decline = function decline(actor, reason, note = '') {
  if (!['submitted', 'verified'].includes(this.status)) {
    throw new Error(`A ${this.status} claim cannot be declined`);
  }
  if (!DECLINE_REASONS.includes(reason)) {
    throw new Error('A valid decline reason is required');
  }

  const from = this.status;

  this.status = 'declined';
  this.declinedBy = actor._id;
  this.declinedAt = new Date();
  this.declineReason = reason;
  this.declineNote = note || '';

  return this.recordHistory({
    action: 'declined',
    from,
    to: 'declined',
    note: note || reason,
    by: actor._id,
    byName: actor.name,
  });
};

matchingGiftClaimSchema.methods.withdraw = function withdraw(actor, note = '') {
  if (!['draft', 'submitted'].includes(this.status)) {
    throw new Error(`A ${this.status} claim cannot be withdrawn`);
  }

  const from = this.status;

  this.status = 'withdrawn';
  this.withdrawnAt = new Date();
  this.withdrawalNote = note || '';

  return this.recordHistory({
    action: 'withdrawn',
    from,
    to: 'withdrawn',
    note,
    by: actor._id,
    byName: actor.name,
  });
};

matchingGiftClaimSchema.methods.markReceived = function markReceived(actor, receiptReference) {
  if (this.status !== 'verified') {
    throw new Error(`Only a verified claim can be recorded as received; this one is ${this.status}`);
  }
  if (!receiptReference || !String(receiptReference).trim()) {
    throw new Error('A receipt reference is required');
  }

  this.status = 'received';
  this.receivedBy = actor._id;
  this.receivedAt = new Date();
  this.receiptReference = String(receiptReference).trim();

  return this.recordHistory({
    action: 'received',
    from: 'verified',
    to: 'received',
    note: this.receiptReference,
    by: actor._id,
    byName: actor.name,
  });
};

/**
 * How long a gift stays claimable, measured from the day the money arrived.
 *
 * Measured from the gift and not from the claim, because the window is the
 * employer's and the employer counts from their employee's donation date.
 */
matchingGiftClaimSchema.statics.claimWindowClosesOn = function claimWindowClosesOn(
  giftReceivedOn,
  claimWindowDays
) {
  const closes = new Date(giftReceivedOn);
  closes.setDate(closes.getDate() + Number(claimWindowDays || 0));
  return closes;
};

/**
 * Everything already spoken for against one programme.
 *
 * An aggregation over the claims rather than a counter on the programme,
 * because a counter is the field that ends up disagreeing with the rows it is
 * supposed to summarise.
 */
matchingGiftClaimSchema.statics.encumberedForProgramme = async function encumberedForProgramme(
  programmeId,
  { excludeClaimId = null } = {}
) {
  const match = {
    programme: new mongoose.Types.ObjectId(String(programmeId)),
    isEncumbering: true,
  };

  if (excludeClaimId) {
    match._id = { $ne: new mongoose.Types.ObjectId(String(excludeClaimId)) };
  }

  const [row] = await this.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$claimedAmount' } } },
  ]);

  return row ? row.total : 0;
};

/**
 * Everything one donor has already spoken for under one programme, in one
 * programme year.
 */
matchingGiftClaimSchema.statics.encumberedForDonor = async function encumberedForDonor(
  programmeId,
  donorId,
  capYear,
  { excludeClaimId = null } = {}
) {
  if (!donorId) return 0;

  const match = {
    programme: new mongoose.Types.ObjectId(String(programmeId)),
    donor: new mongoose.Types.ObjectId(String(donorId)),
    capYear: Number(capYear),
    isEncumbering: true,
  };

  if (excludeClaimId) {
    match._id = { $ne: new mongoose.Types.ObjectId(String(excludeClaimId)) };
  }

  const [row] = await this.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$claimedAmount' } } },
  ]);

  return row ? row.total : 0;
};

/**
 * The ceiling: the most this employer can still be asked for, against this
 * gift, by this donor.
 *
 *   min( gift × ratio, donor cap remaining, programme budget remaining )
 *
 * Every term on the right is derived. The breakdown is returned alongside the
 * figure because a development officer who sees a smaller ceiling than they
 * expected will otherwise assume the number is broken, and the useful answer is
 * *which* of the three limits bound it.
 */
matchingGiftClaimSchema.statics.claimableFor = async function claimableFor({
  programme,
  giftAmount,
  giftReceivedOn,
  donorId,
  excludeClaimId = null,
}) {
  const capYear = new Date(giftReceivedOn).getUTCFullYear();

  const [donorEncumbered, programmeEncumbered] = await Promise.all([
    this.encumberedForDonor(programme._id, donorId, capYear, { excludeClaimId }),
    this.encumberedForProgramme(programme._id, { excludeClaimId }),
  ]);

  const byRatio = round2(Number(giftAmount) * programme.matchRatio);
  const donorRemaining = Math.max(0, programme.perDonorAnnualCap - donorEncumbered);
  const budgetRemaining =
    programme.programmeBudget === null || programme.programmeBudget === undefined
      ? Infinity
      : Math.max(0, programme.programmeBudget - programmeEncumbered);

  const claimable = Math.min(byRatio, donorRemaining, budgetRemaining);

  // Which limit actually bound the figure. Ordered so that the tightest real
  // constraint is named, with the ratio last because it is the expected one.
  let boundBy = 'ratio';
  if (claimable === budgetRemaining && budgetRemaining < byRatio) boundBy = 'programme-budget';
  else if (claimable === donorRemaining && donorRemaining < byRatio) boundBy = 'donor-cap';

  return {
    capYear,
    matchRatio: programme.matchRatio,
    byRatio,
    donorCap: programme.perDonorAnnualCap,
    donorEncumbered,
    donorRemaining,
    programmeBudget: programme.programmeBudget,
    programmeEncumbered,
    programmeRemaining: budgetRemaining === Infinity ? null : budgetRemaining,
    claimable: Math.max(0, round2(claimable === Infinity ? byRatio : claimable)),
    boundBy,
  };
};

/**
 * What matching is worth to one campaign, split by certainty.
 *
 * Deliberately three numbers and not one. `received` is money in the bank,
 * `pending` is money an employer has been asked for, and they are never added
 * together — nor added into the campaign's own `amountReceived`, which keeps
 * meaning exactly what it means today.
 */
matchingGiftClaimSchema.statics.campaignMatchSummary = async function campaignMatchSummary(
  campaignId
) {
  const rows = await this.aggregate([
    { $match: { campaign: new mongoose.Types.ObjectId(String(campaignId)) } },
    { $group: { _id: '$status', total: { $sum: '$claimedAmount' }, count: { $sum: 1 } } },
  ]);

  const byStatus = {};
  rows.forEach((row) => {
    byStatus[row._id] = { total: row.total, count: row.count };
  });

  const pick = (status) => (byStatus[status] ? byStatus[status].total : 0);
  const pickCount = (status) => (byStatus[status] ? byStatus[status].count : 0);

  return {
    matchedReceived: round2(pick('received')),
    matchPending: round2(pick('submitted') + pick('verified')),
    matchDeclined: round2(pick('declined')),
    claimCount: CLAIM_STATUSES.reduce((sum, status) => sum + pickCount(status), 0),
    byStatus,
  };
};

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

matchingGiftClaimSchema.statics.STATUSES = CLAIM_STATUSES;
matchingGiftClaimSchema.statics.DECLINE_REASONS = DECLINE_REASONS;
matchingGiftClaimSchema.statics.ENCUMBERING_STATUSES = ENCUMBERING_STATUSES;

const MatchingGiftProgramme = mongoose.model(
  'MatchingGiftProgramme',
  matchingGiftProgrammeSchema
);
const MatchingGiftClaim = mongoose.model('MatchingGiftClaim', matchingGiftClaimSchema);

module.exports = { MatchingGiftProgramme, MatchingGiftClaim };
