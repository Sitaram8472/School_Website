const mongoose = require('mongoose');

/**
 * Lost and found register.
 *
 * The hard part of a lost-and-found is not storage, it is adjudication. When a
 * decent pair of headphones is handed in, more than one student will claim it,
 * and the person behind the desk has nothing to decide on except who asked
 * first and who sounded most confident.
 *
 * So the register holds back the fields that actually discriminate — see
 * `redactFor` — and a claim is a written answer to them rather than an
 * assertion of ownership.
 */

const KINDS = ['found', 'lost'];

const CATEGORIES = [
  'electronics',
  'stationery',
  'clothing',
  'books',
  'id-card',
  'jewellery',
  'sports',
  'documents',
  'other',
];

/**
 * How long each category is held before it can be disposed of.
 *
 * Derived, never client-supplied: a reporter who could set their own retention
 * period could park a single glove in the cupboard until 2031.
 */
const RETENTION_DAYS = {
  electronics: 180,
  jewellery: 365,
  documents: 365,
  'id-card': 365,
  books: 90,
  clothing: 60,
  sports: 60,
  stationery: 30,
  other: 90,
};

const STATUSES = [
  'registered',
  'stored',
  'claim-pending',
  'matched',
  'handed-over',
  'disposed',
  'expired',
  'withdrawn',
];

// The lifecycle, as a table. Anything not listed is a 409.
const TRANSITIONS = {
  registered: ['stored', 'claim-pending', 'withdrawn'],
  stored: ['claim-pending', 'expired', 'disposed', 'withdrawn'],
  // Back to `stored` when every claim has been rejected.
  'claim-pending': ['matched', 'stored', 'withdrawn'],
  // Back to `claim-pending` if the approved claimant never turns up and
  // another claim is reopened.
  matched: ['handed-over', 'claim-pending', 'stored'],
  'handed-over': [],
  disposed: [],
  expired: ['disposed'],
  withdrawn: [],
};

const CLAIM_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'];

/**
 * Atomic sequence allotment.
 *
 * `countDocuments() + 1` is a race — two items handed in at the same moment
 * both read the same count and both get the same ticket id. `findOneAndUpdate`
 * with `$inc` and `upsert` is one operation, so the number is handed out once.
 */
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

const Counter =
  mongoose.models.LostFoundCounter || mongoose.model('LostFoundCounter', counterSchema);

/**
 * Words that appear in almost every description and so discriminate between
 * none of them. A plain length cut-off does not work here — it would drop
 * "red" and "bag" while keeping "the" and "and".
 */
const STOP_WORDS = new Set([
  'the', 'and', 'was', 'for', 'with', 'that', 'this', 'have', 'has', 'had',
  'from', 'its', 'it', 'a', 'an', 'in', 'on', 'at', 'of', 'to', 'is', 'are',
  'my', 'mine', 'his', 'her', 'their', 'our', 'one', 'some', 'any', 'into',
  'lost', 'found', 'item', 'thing', 'please', 'think', 'about', 'near',
]);

/**
 * Splits a description into comparable word tokens.
 */
function tokenise(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

/**
 * Scores a lost report against a found item, 0-100.
 *
 * Advisory only. It sorts the desk's work so likely pairs surface instead of
 * being scrolled past; it does not approve anything, and nothing in the model
 * reads it. Adjudication stays with a human looking at what the claimant wrote
 * down unprompted.
 */
function matchScore(lostReport, foundItem) {
  if (!lostReport || !foundItem) return 0;

  let score = 0;

  // Category is the coarsest filter and worth the most.
  if (lostReport.category && lostReport.category === foundItem.category) score += 30;

  if (
    lostReport.colour &&
    foundItem.colour &&
    lostReport.colour.trim().toLowerCase() === foundItem.colour.trim().toLowerCase()
  ) {
    score += 20;
  }

  if (
    lostReport.brand &&
    foundItem.brand &&
    lostReport.brand.trim().toLowerCase() === foundItem.brand.trim().toLowerCase()
  ) {
    score += 20;
  }

  // Something found three days after it was lost is a better candidate than
  // something found three months later.
  if (lostReport.occurredOn && foundItem.occurredOn) {
    const days = Math.abs(
      (new Date(foundItem.occurredOn).getTime() -
        new Date(lostReport.occurredOn).getTime()) /
        86400000
    );
    if (days <= 1) score += 15;
    else if (days <= 7) score += 10;
    else if (days <= 30) score += 5;
    // A "found" date before the item was lost is not impossible — people
    // misremember — but it earns nothing.
  }

  // Word overlap between the two free-text descriptions.
  const lostTokens = new Set([
    ...tokenise(lostReport.title),
    ...tokenise(lostReport.description),
  ]);
  const foundTokens = new Set([
    ...tokenise(foundItem.title),
    ...tokenise(foundItem.description),
  ]);
  if (lostTokens.size > 0 && foundTokens.size > 0) {
    let shared = 0;
    lostTokens.forEach((token) => {
      if (foundTokens.has(token)) shared += 1;
    });
    score += Math.min(15, shared * 5);
  }

  return Math.min(100, score);
}

const claimSchema = new mongoose.Schema(
  {
    claimant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    claimantName: { type: String, trim: true },
    className: { type: String, trim: true, maxlength: 30 },
    contact: { type: String, trim: true, maxlength: 60 },
    /**
     * What the claimant says about the item, unprompted. This is the whole
     * test — which is why the register does not publish the answer.
     */
    proofDescription: {
      type: String,
      required: [true, 'Describe the item so we can tell it is yours'],
      trim: true,
      minlength: [20, 'Please give at least 20 characters of detail'],
      maxlength: [800, 'Proof description cannot exceed 800 characters'],
    },
    // Asked for separately on high-value items, so the claimant has to commit
    // to specifics rather than restating the public listing back at us.
    answeredMarks: {
      type: String,
      trim: true,
      maxlength: [400, 'Answer cannot exceed 400 characters'],
      default: null,
    },
    status: {
      type: String,
      enum: CLAIM_STATUSES,
      default: 'pending',
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedByName: { type: String, trim: true, default: null },
    reviewNote: { type: String, trim: true, maxlength: 300, default: null },
    reviewedAt: { type: Date, default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

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

const lostFoundItemSchema = new mongoose.Schema(
  {
    ticketId: {
      type: String,
      unique: true,
      index: true,
    },
    kind: {
      type: String,
      enum: KINDS,
      required: [true, 'Say whether this is a found item or a lost report'],
      index: true,
    },
    title: {
      type: String,
      required: [true, 'A short title is required'],
      trim: true,
      minlength: [3, 'Title must be at least 3 characters'],
      maxlength: [100, 'Title cannot exceed 100 characters'],
    },
    description: {
      type: String,
      required: [true, 'A description is required'],
      trim: true,
      minlength: [10, 'Description must be at least 10 characters'],
      maxlength: [1000, 'Description cannot exceed 1000 characters'],
    },
    category: {
      type: String,
      enum: {
        values: CATEGORIES,
        message: 'Unknown category',
      },
      required: [true, 'Category is required'],
      index: true,
    },
    colour: { type: String, trim: true, maxlength: 30, default: null },
    brand: { type: String, trim: true, maxlength: 40, default: null },
    /**
     * The chipped hinge, the blue sticker, the name inked inside the flap.
     *
     * Recorded by whoever takes the item in, and never serialised to a viewer
     * who has not had a claim approved. See `redactFor` — publishing this
     * would tell every potential claimant the answer to the test.
     */
    distinguishingMarks: {
      type: String,
      trim: true,
      maxlength: [500, 'Distinguishing marks cannot exceed 500 characters'],
      default: null,
    },
    location: {
      type: String,
      required: [true, 'Where was it found or lost?'],
      trim: true,
      maxlength: [120, 'Location cannot exceed 120 characters'],
    },
    occurredOn: {
      type: Date,
      required: [true, 'When was it found or lost?'],
    },
    reportedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    reportedByName: { type: String, trim: true },
    storageLocation: { type: String, trim: true, maxlength: 120, default: null },
    custodian: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Set by staff, not by the reporter — it raises the evidence bar, so a
    // claimant must not be able to lower it.
    isHighValue: { type: Boolean, default: false },
    status: {
      type: String,
      enum: STATUSES,
      default: 'registered',
      index: true,
    },
    // Derived from the category.
    retentionUntil: { type: Date },
    claims: { type: [claimSchema], default: [] },
    handover: {
      to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      toName: { type: String, trim: true, default: null },
      at: { type: Date, default: null },
      byStaff: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      byStaffName: { type: String, trim: true, default: null },
      signatureNote: { type: String, trim: true, maxlength: 300, default: null },
    },
    disposedAt: { type: Date, default: null },
    disposalNote: { type: String, trim: true, maxlength: 300, default: null },
    auditTrail: { type: [auditSchema], default: [] },
  },
  { timestamps: true }
);

lostFoundItemSchema.index({ kind: 1, status: 1, occurredOn: -1 });
lostFoundItemSchema.index({ 'claims.claimant': 1 });

/**
 * Mongoose 9 has dropped callback-style middleware — a hook written
 * `pre('validate', function (next) {...})` is silently skipped, and this hook
 * is what derives `retentionUntil`.
 */
lostFoundItemSchema.pre('validate', async function derive() {
  if (this.occurredOn && this.occurredOn.getTime() > Date.now() + 86400000) {
    this.invalidate('occurredOn', 'That date is in the future');
    return;
  }

  const days = RETENTION_DAYS[this.category] || RETENTION_DAYS.other;
  const from = this.occurredOn || new Date();
  this.retentionUntil = new Date(from.getTime() + days * 86400000);
});

lostFoundItemSchema.virtual('approvedClaim').get(function approvedClaim() {
  return this.claims.find((claim) => claim.status === 'approved') || null;
});

lostFoundItemSchema.virtual('pendingClaims').get(function pendingClaims() {
  return this.claims.filter((claim) => claim.status === 'pending');
});

lostFoundItemSchema.virtual('isPastRetention').get(function isPastRetention() {
  return Boolean(this.retentionUntil && this.retentionUntil.getTime() < Date.now());
});

lostFoundItemSchema.virtual('isClosed').get(function isClosed() {
  return ['handed-over', 'disposed', 'withdrawn'].includes(this.status);
});

lostFoundItemSchema.methods.canTransition = function canTransition(to) {
  return (TRANSITIONS[this.status] || []).includes(to);
};

lostFoundItemSchema.methods.moveTo = function moveTo(to, actor, detail = null) {
  if (!this.canTransition(to)) {
    const error = new Error(`A ${this.status} item cannot become ${to}.`);
    error.code = 'ILLEGAL_TRANSITION';
    throw error;
  }
  const from = this.status;
  this.status = to;
  this.recordAudit(`status:${from}->${to}`, actor, detail, from, to);
  return this;
};

lostFoundItemSchema.methods.recordAudit = function recordAudit(
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

lostFoundItemSchema.methods.openClaimFor = function openClaimFor(userId) {
  return (
    this.claims.find(
      (claim) =>
        String(claim.claimant) === String(userId) &&
        ['pending', 'approved'].includes(claim.status)
    ) || null
  );
};

/**
 * Approves one claim and rejects every other pending one in the same
 * operation.
 *
 * The single-approved-claim rule lives here rather than in the controller so
 * that a second route added later cannot approve around it. Rejecting the
 * others at the same moment is what stops the register sitting in a state
 * where two people have both been told the item is theirs.
 */
lostFoundItemSchema.methods.approveClaim = function approveClaim(claimId, actor, note) {
  const existing = this.approvedClaim;
  if (existing) {
    const error = new Error(
      `A claim by ${existing.claimantName || 'another student'} has already been approved for this item.`
    );
    error.code = 'ALREADY_APPROVED';
    throw error;
  }

  const claim = this.claims.id(claimId);
  if (!claim) {
    const error = new Error('That claim is not on this item.');
    error.code = 'CLAIM_NOT_FOUND';
    throw error;
  }
  if (claim.status !== 'pending') {
    const error = new Error(`That claim is already ${claim.status}.`);
    error.code = 'CLAIM_NOT_PENDING';
    throw error;
  }

  const now = new Date();
  claim.status = 'approved';
  claim.reviewedBy = actor && (actor._id || actor.id);
  claim.reviewedByName = actor && actor.name;
  claim.reviewNote = note || null;
  claim.reviewedAt = now;

  let displaced = 0;
  this.claims.forEach((other) => {
    if (String(other._id) === String(claim._id)) return;
    if (other.status !== 'pending') return;
    other.status = 'rejected';
    other.reviewedBy = actor && (actor._id || actor.id);
    other.reviewedByName = actor && actor.name;
    other.reviewNote = 'Another claim was approved for this item.';
    other.reviewedAt = now;
    displaced += 1;
  });

  this.recordAudit(
    'claim:approved',
    actor,
    `${claim.claimantName || claim.claimant}${displaced ? `; ${displaced} other claim(s) rejected` : ''}`
  );

  return { claim, displaced };
};

/**
 * Records the physical handover.
 *
 * Only from `matched`, and only to the claimant whose claim was approved.
 * Handing the item to whoever is standing at the desk is the exact failure the
 * claim process exists to prevent, so the check is here rather than left to
 * the handler.
 */
lostFoundItemSchema.methods.recordHandover = function recordHandover(toUserId, actor, note) {
  if (this.status !== 'matched') {
    const error = new Error(
      `An item can only be handed over once a claim has been approved (this one is ${this.status}).`
    );
    error.code = 'NOT_MATCHED';
    throw error;
  }

  const approved = this.approvedClaim;
  if (!approved) {
    const error = new Error('No claim has been approved for this item.');
    error.code = 'NO_APPROVED_CLAIM';
    throw error;
  }
  if (String(approved.claimant) !== String(toUserId)) {
    const error = new Error(
      'This item can only be handed to the claimant whose claim was approved.'
    );
    error.code = 'WRONG_RECIPIENT';
    throw error;
  }

  this.handover = {
    to: approved.claimant,
    toName: approved.claimantName,
    at: new Date(),
    byStaff: actor && (actor._id || actor.id),
    byStaffName: actor && actor.name,
    signatureNote: note || null,
  };

  this.moveTo('handed-over', actor, `to ${approved.claimantName || approved.claimant}`);
  return this;
};

/**
 * Serialises for a viewer.
 *
 * Staff see everything. Everybody else sees the coarse fields — category,
 * colour, brand, where and roughly when — their own claim, and **not**
 * `distinguishingMarks`, which is held back until their claim is approved.
 *
 * That withholding is the whole design. A listing that reads "black earbuds,
 * case has a chipped hinge and a blue sticker" has just told every potential
 * claimant how to pass the test, and the claim form stops being worth filling
 * in. It has to happen at serialisation time rather than by remembering to
 * omit a field in each handler.
 */
lostFoundItemSchema.methods.redactFor = function redactFor(viewer) {
  const plain = this.toObject({ virtuals: true });
  delete plain.__v;

  const isStaff = viewer && ['teacher', 'staff', 'admin'].includes(viewer.role);
  if (isStaff) return plain;

  const viewerId = viewer && (viewer._id || viewer.id);
  const own = this.claims.filter(
    (claim) => viewerId && String(claim.claimant) === String(viewerId)
  );

  const hasApprovedClaim = own.some((claim) => claim.status === 'approved');
  if (!hasApprovedClaim) {
    plain.distinguishingMarks = null;
  }

  // Other claimants' proof text is the other half of the leak — it would tell
  // a later claimant what a plausible answer looks like.
  plain.claims = own.map((claim) => claim.toObject());

  // `approvedClaim` and `pendingClaims` are virtuals, and `toObject({ virtuals:
  // true })` has already expanded them from the *unfiltered* array — so
  // filtering `plain.claims` alone still ships every claimant's proof text one
  // key further down. Recompute them from what this viewer is allowed to see.
  plain.approvedClaim = plain.claims.find((claim) => claim.status === 'approved') || null;
  plain.pendingClaims = plain.claims.filter((claim) => claim.status === 'pending');
  // Whether *somebody* has been approved is not a secret, and the UI needs it
  // to stop offering a claim button. Who they are, and what they wrote, is.
  plain.hasApprovedClaim = Boolean(this.approvedClaim);

  plain.auditTrail = [];
  plain.storageLocation = null;
  plain.custodian = null;
  return plain;
};

lostFoundItemSchema.statics.nextTicketId = async function nextTicketId() {
  const year = new Date().getFullYear();
  const counter = await Counter.findOneAndUpdate(
    { _id: `LF-${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );
  return `LF-${year}-${String(counter.seq).padStart(4, '0')}`;
};

lostFoundItemSchema.statics.matchScore = matchScore;
lostFoundItemSchema.statics.tokenise = tokenise;
lostFoundItemSchema.statics.KINDS = KINDS;
lostFoundItemSchema.statics.CATEGORIES = CATEGORIES;
lostFoundItemSchema.statics.STATUSES = STATUSES;
lostFoundItemSchema.statics.TRANSITIONS = TRANSITIONS;
lostFoundItemSchema.statics.RETENTION_DAYS = RETENTION_DAYS;
lostFoundItemSchema.statics.Counter = Counter;

lostFoundItemSchema.set('toObject', { virtuals: true });
lostFoundItemSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('LostFoundItem', lostFoundItemSchema);
