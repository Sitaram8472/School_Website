const mongoose = require('mongoose');

/**
 * Admission merit lists and seat allotment.
 *
 * Two schemas live here — a round, and one candidate's place in it — because
 * neither is meaningful alone and every rule below reads across both.
 *
 * Three derivations carry the feature, and none of them is ever accepted from a
 * client:
 *
 *   compositeScore is the weighted sum of the component scores, rounded once.
 *     Ranking a list twice on two machines has to give the same list, so the
 *     rounding happens in exactly one place and the tie-break is written down
 *     rather than left to whatever order the array happened to be in.
 *
 *   rank and waitlistPosition come from that comparator, never from a payload.
 *
 *   expiresAt is offeredAt + the round's validity. It is the field a family is
 *     deciding against, and it is the one nobody should be able to type.
 *
 * The seat arithmetic is the point of the module. A seat under offer is a seat
 * that is gone, so `liveHolds` counts `offered` and `accepted` together; and a
 * seat released by a decline or an expiry is filled in the same operation that
 * released it, so there is no window in which it belongs to nobody and none in
 * which it belongs to two children.
 */

const CATEGORIES = [
  'general',
  'sibling',
  'staff-ward',
  'ews',
  'sports',
  'management',
];

// Reserved categories are every category other than the open one.
const RESERVED_CATEGORIES = CATEGORIES.filter((c) => c !== 'general');

const ROUND_STATUSES = ['draft', 'ranked', 'published', 'closed'];

const OFFER_STATES = [
  'registered',
  'offered',
  'accepted',
  'declined',
  'expired',
  'waitlisted',
  'not-selected',
  'withdrawn',
];

// A seat under offer is a seat that is gone. Counting only acceptances is how a
// school offers the last seat twice in one morning.
const LIVE_HOLD_STATES = ['offered', 'accepted'];

// States a candidate can still be promoted out of.
const PROMOTABLE_STATES = ['waitlisted'];

// Scores may only be edited while the round is still being assembled.
const SCORE_EDITABLE_STATUSES = ['draft', 'ranked'];

const SCORE_COMPONENTS = ['entrance', 'interaction', 'priorAcademic'];

const DEFAULT_WEIGHTS = { entrance: 60, interaction: 20, priorAcademic: 20 };

const MIN_VALIDITY_HOURS = 12;
const MAX_VALIDITY_HOURS = 720;
const DEFAULT_VALIDITY_HOURS = 72;

const MAX_SEATS = 2000;

const YEAR_PATTERN = /^\d{4}-\d{2}$/;

/** Round to two places through integers, so 0.145 does not depend on the moon. */
function round2(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * The weighted composite, out of 100.
 *
 * Each component is a percentage in its own right, so the weights simply
 * distribute across them. Rounding happens once, here, and nowhere else.
 */
function compositeFor(componentScores, weights) {
  const scores = componentScores || {};
  const w = weights || DEFAULT_WEIGHTS;

  const total = SCORE_COMPONENTS.reduce((sum, key) => {
    const score = Number(scores[key]) || 0;
    const weight = Number(w[key]) || 0;
    return sum + (score * weight) / 100;
  }, 0);

  return round2(total);
}

/**
 * The tie-break, written down.
 *
 * Composite descending, then the entrance paper, then the older child, then the
 * application id. Four deterministic steps: the same data ranks the same way on
 * any machine on any day, and a parent asking why the other child was ahead gets
 * an answer rather than a shrug.
 */
function compareCandidates(a, b) {
  const compositeGap = (b.compositeScore || 0) - (a.compositeScore || 0);
  if (compositeGap !== 0) return compositeGap;

  const entranceGap =
    (b.componentScores?.entrance || 0) - (a.componentScores?.entrance || 0);
  if (entranceGap !== 0) return entranceGap;

  const aBorn = a.dateOfBirth ? new Date(a.dateOfBirth).getTime() : Infinity;
  const bBorn = b.dateOfBirth ? new Date(b.dateOfBirth).getTime() : Infinity;
  if (aBorn !== bBorn) return aBorn - bBorn;

  return String(a.application || a._id).localeCompare(String(b.application || b._id));
}

// ---------------------------------------------------------------------------
// Round
// ---------------------------------------------------------------------------

const quotaSchema = new mongoose.Schema(
  {
    category: {
      type: String,
      enum: {
        values: RESERVED_CATEGORIES,
        message: 'general is not a quota; it is what is left over',
      },
      required: true,
    },
    seats: {
      type: Number,
      required: true,
      min: [1, 'A quota of zero seats is not a quota'],
      max: [MAX_SEATS, 'That is more seats than the school has'],
    },
  },
  { _id: false }
);

const historySchema = new mongoose.Schema(
  {
    action: { type: String, required: true, trim: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
    note: { type: String, trim: true, maxlength: 400 },
  },
  { _id: false }
);

const admissionRoundSchema = new mongoose.Schema(
  {
    academicYear: {
      type: String,
      required: [true, 'Academic year is required'],
      trim: true,
      match: [YEAR_PATTERN, 'Academic year must look like 2026-27'],
    },

    gradeLevel: {
      type: String,
      required: [true, 'Grade level is required'],
      trim: true,
      maxlength: [30, 'Grade level cannot exceed 30 characters'],
    },

    roundNumber: {
      type: Number,
      required: true,
      min: [1, 'Rounds start at 1'],
      max: [20, 'Twenty rounds is not an admission process'],
      default: 1,
    },

    totalSeats: {
      type: Number,
      required: [true, 'Total seats is required'],
      min: [1, 'A round with no seats has nothing to allot'],
      max: [MAX_SEATS, 'That is more seats than the school has'],
    },

    quotas: {
      type: [quotaSchema],
      default: [],
      validate: {
        validator(list) {
          const seen = new Set();
          return list.every((q) => {
            if (seen.has(q.category)) return false;
            seen.add(q.category);
            return true;
          });
        },
        message: 'Each category may appear once in the quota list',
      },
    },

    // Whether a reserved seat nobody eligible claimed returns to open merit.
    quotaSpillover: { type: Boolean, default: true },

    weights: {
      entrance: { type: Number, default: DEFAULT_WEIGHTS.entrance, min: 0, max: 100 },
      interaction: { type: Number, default: DEFAULT_WEIGHTS.interaction, min: 0, max: 100 },
      priorAcademic: { type: Number, default: DEFAULT_WEIGHTS.priorAcademic, min: 0, max: 100 },
    },

    offerValidityHours: {
      type: Number,
      default: DEFAULT_VALIDITY_HOURS,
      min: [MIN_VALIDITY_HOURS, 'Give a family at least half a day to answer'],
      max: [MAX_VALIDITY_HOURS, 'An offer open for a month is a seat held for a month'],
    },

    status: { type: String, enum: ROUND_STATUSES, default: 'draft', index: true },

    rankedAt: Date,
    // A digest of the published ranking. If a score is edited afterwards the
    // list reports itself as changed rather than quietly disagreeing with the
    // letters that have already gone out.
    rankFingerprint: { type: String, default: null },
    publishedAt: Date,
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    closedAt: Date,

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

admissionRoundSchema.index(
  { academicYear: 1, gradeLevel: 1, roundNumber: 1 },
  { unique: true }
);

/**
 * Weights that do not total 100 produce a composite out of something other than
 * 100, which then gets compared against one that is. Caught here rather than
 * discovered halfway down a merit list.
 */
admissionRoundSchema.pre('validate', function validateWeights() {
  const total = SCORE_COMPONENTS.reduce(
    (sum, key) => sum + (Number(this.weights?.[key]) || 0),
    0
  );
  if (total !== 100) {
    this.invalidate('weights', `The three weights add up to ${total}, not 100`);
  }
});

/** Seats set aside for a named category. */
admissionRoundSchema.methods.reservedSeatsFor = function reservedSeatsFor(category) {
  const quota = this.quotas.find((q) => q.category === category);
  return quota ? quota.seats : 0;
};

admissionRoundSchema.methods.totalReservedSeats = function totalReservedSeats() {
  return this.quotas.reduce((sum, q) => sum + q.seats, 0);
};

/** What is left for open merit once the quotas are taken out. */
admissionRoundSchema.methods.generalSeats = function generalSeats() {
  return Math.max(0, this.totalSeats - this.totalReservedSeats());
};

admissionRoundSchema.methods.isEditable = function isEditable() {
  return this.status === 'draft';
};

admissionRoundSchema.methods.acceptsScoreEdits = function acceptsScoreEdits() {
  return SCORE_EDITABLE_STATUSES.includes(this.status);
};

admissionRoundSchema.methods.recordHistory = function recordHistory(action, by, note) {
  this.history.push({ action, by, note, at: new Date() });
  if (this.history.length > 200) this.history = this.history.slice(-200);
  return this;
};

/**
 * A digest over the ranked list. Cheap, order-sensitive and good enough to
 * answer "is this still the list we published?".
 */
admissionRoundSchema.statics.fingerprintOf = function fingerprintOf(candidates) {
  const material = candidates
    .map((c) => `${c.application}:${c.compositeScore}:${c.rank}`)
    .join('|');

  let hash = 5381;
  for (let i = 0; i < material.length; i += 1) {
    hash = ((hash << 5) + hash + material.charCodeAt(i)) | 0;
  }
  return `r${(hash >>> 0).toString(16)}:${candidates.length}`;
};

admissionRoundSchema.set('toJSON', { virtuals: true });
admissionRoundSchema.set('toObject', { virtuals: true });

admissionRoundSchema.virtual('seatBreakdown').get(function seatBreakdown() {
  return {
    total: this.totalSeats,
    reserved: this.totalReservedSeats(),
    general: this.generalSeats(),
  };
});

// ---------------------------------------------------------------------------
// Candidacy
// ---------------------------------------------------------------------------

const seatOfferSchema = new mongoose.Schema(
  {
    round: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AdmissionRound',
      required: true,
      index: true,
    },

    application: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Application',
      required: true,
    },

    // The family that may accept or decline. Applications are taken from people
    // who do not necessarily hold an account, so this is optional.
    guardian: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    candidateName: { type: String, required: true, trim: true, maxlength: 80 },
    dateOfBirth: { type: Date, required: true },

    category: { type: String, enum: CATEGORIES, default: 'general', index: true },

    componentScores: {
      entrance: { type: Number, default: 0, min: 0, max: 100 },
      interaction: { type: Number, default: 0, min: 0, max: 100 },
      priorAcademic: { type: Number, default: 0, min: 0, max: 100 },
    },

    compositeScore: { type: Number, default: 0, min: 0, max: 100 },
    rank: { type: Number, default: null },
    waitlistPosition: { type: Number, default: null },

    state: { type: String, enum: OFFER_STATES, default: 'registered', index: true },

    // Which seat this candidate is holding — 'general' or a reserved category.
    // A promotion has to put somebody into the seat that was actually freed.
    seatKind: { type: String, enum: CATEGORIES, default: null },

    offeredAt: Date,
    expiresAt: Date,
    respondedAt: Date,
    promotedFrom: { type: String, default: null },
    promotedAt: Date,
    withdrawnReason: { type: String, trim: true, maxlength: 300 },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

// One candidacy per application per round. Publishing twice cannot produce two
// offers for one child.
seatOfferSchema.index({ round: 1, application: 1 }, { unique: true });
seatOfferSchema.index({ round: 1, rank: 1 });
seatOfferSchema.index({ state: 1, expiresAt: 1 });

// One accepted seat per application, across every round of the year. This is
// the database refusing what a spreadsheet cannot even notice.
seatOfferSchema.index(
  { application: 1 },
  { unique: true, partialFilterExpression: { state: 'accepted' } }
);

seatOfferSchema.methods.isLiveHold = function isLiveHold() {
  return LIVE_HOLD_STATES.includes(this.state);
};

seatOfferSchema.methods.hasExpired = function hasExpired(now = new Date()) {
  if (this.state !== 'offered' || !this.expiresAt) return false;
  return this.expiresAt.getTime() <= now.getTime();
};

/** Hours left on a live offer; negative once it has run out. */
seatOfferSchema.methods.hoursRemaining = function hoursRemaining(now = new Date()) {
  if (!this.expiresAt) return null;
  return round2((this.expiresAt.getTime() - now.getTime()) / 3600000);
};

seatOfferSchema.methods.isOwnedBy = function isOwnedBy(user) {
  if (!user || !this.guardian) return false;
  return String(this.guardian) === String(user._id);
};

seatOfferSchema.methods.recordHistory = function recordHistory(action, by, note) {
  this.history.push({ action, by, note, at: new Date() });
  if (this.history.length > 100) this.history = this.history.slice(-100);
  return this;
};

seatOfferSchema.methods.applyComposite = function applyComposite(weights) {
  this.compositeScore = compositeFor(this.componentScores, weights);
  return this.compositeScore;
};

/**
 * Rank a list in place and hand it back in merit order.
 *
 * Equal composites share nothing: the comparator always separates them, so
 * `rank` is a strict sequence and "joint fourth" — which cannot be allotted a
 * seat — never arises.
 */
seatOfferSchema.statics.rankAll = function rankAll(candidates, weights) {
  const ordered = [...candidates];
  ordered.forEach((c) => {
    c.compositeScore = compositeFor(c.componentScores, weights);
  });
  ordered.sort(compareCandidates);
  ordered.forEach((c, index) => {
    c.rank = index + 1;
  });
  return ordered;
};

/**
 * Decide who is offered a seat and who waits.
 *
 * Open merit first, then the quotas, then — if the round allows it — whatever
 * reserved seats nobody eligible claimed. Filling quotas first is the mistake
 * hand-sorting always makes: a sibling who ranks inside the open list should
 * take an open seat and leave their quota seat for the next sibling down.
 */
seatOfferSchema.statics.buildAllotment = function buildAllotment(round, rankedCandidates) {
  const capacity = new Map();
  capacity.set('general', round.generalSeats());
  round.quotas.forEach((q) => capacity.set(q.category, q.seats));

  const placed = new Map();
  const eligible = rankedCandidates.filter(
    (c) => !['withdrawn', 'accepted', 'declined'].includes(c.state)
  );

  // Pass 1 — open merit, category ignored.
  for (const candidate of eligible) {
    if (capacity.get('general') <= 0) break;
    placed.set(String(candidate._id), 'general');
    capacity.set('general', capacity.get('general') - 1);
  }

  // Pass 2 — reserved seats, in merit order within each category.
  for (const candidate of eligible) {
    if (placed.has(String(candidate._id))) continue;
    const seats = capacity.get(candidate.category) || 0;
    if (candidate.category === 'general' || seats <= 0) continue;
    placed.set(String(candidate._id), candidate.category);
    capacity.set(candidate.category, seats - 1);
  }

  // Pass 3 — reserved seats nobody eligible claimed, if the round allows it.
  if (round.quotaSpillover) {
    for (const candidate of eligible) {
      if (placed.has(String(candidate._id))) continue;
      const spare = RESERVED_CATEGORIES.find((cat) => (capacity.get(cat) || 0) > 0);
      if (!spare) break;
      placed.set(String(candidate._id), spare);
      capacity.set(spare, capacity.get(spare) - 1);
    }
  }

  const offers = [];
  const waitlist = [];
  eligible.forEach((candidate) => {
    const seatKind = placed.get(String(candidate._id));
    if (seatKind) offers.push({ candidate, seatKind });
    else waitlist.push(candidate);
  });

  return { offers, waitlist, remaining: capacity };
};

/**
 * Who takes a seat that has just come free.
 *
 * A general seat goes to the highest-ranked candidate waiting. A reserved seat
 * goes to the highest-ranked candidate of that category, and only falls through
 * to open merit when the round permits spillover — otherwise a sports quota
 * seat quietly becomes a general seat the first time one is declined.
 */
seatOfferSchema.statics.nextForSeat = function nextForSeat(round, seatKind, waiting) {
  const queue = [...waiting]
    .filter((c) => PROMOTABLE_STATES.includes(c.state))
    .sort(compareCandidates);

  if (seatKind === 'general') return queue[0] || null;

  const sameCategory = queue.find((c) => c.category === seatKind);
  if (sameCategory) return sameCategory;

  return round.quotaSpillover ? queue[0] || null : null;
};

seatOfferSchema.set('toJSON', { virtuals: true });
seatOfferSchema.set('toObject', { virtuals: true });

const AdmissionRound = mongoose.model('AdmissionRound', admissionRoundSchema);
const SeatOffer = mongoose.model('SeatOffer', seatOfferSchema);

module.exports = {
  AdmissionRound,
  SeatOffer,
  CATEGORIES,
  RESERVED_CATEGORIES,
  ROUND_STATUSES,
  OFFER_STATES,
  LIVE_HOLD_STATES,
  SCORE_COMPONENTS,
  DEFAULT_WEIGHTS,
  DEFAULT_VALIDITY_HOURS,
  compositeFor,
  compareCandidates,
};
