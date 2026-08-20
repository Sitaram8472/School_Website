const mongoose = require('mongoose');

/**
 * Staff recruitment — a vacancy, and the applications against it.
 *
 * Two rules shape everything here.
 *
 * **Nobody sees a panel score until every panellist has entered theirs.**
 * `aggregate.isComplete` is false until the number of submitted scores equals
 * the number of panellists assigned, and while it is false the controller
 * removes the scores from the response entirely — including from a panellist
 * who has already scored. A blurred figure in a table is a UI affordance; this
 * is what the endpoint returns.
 *
 * **Live offers may never exceed the establishment.** `liveOffers` is a counter
 * on the posting moved only by the offer lifecycle, and every move is a guarded
 * update, so two people making an offer at the same moment cannot both take the
 * last post. `offerHold` on the application is the state machine that makes each
 * release happen exactly once.
 */

const POSTING_STATUSES = [
  'draft',
  'open',
  'closed',
  'shortlisting',
  'interviewing',
  'offered',
  'filled',
  'cancelled',
];

// Statuses in which an application may still be received.
const ACCEPTING_STATUSES = ['open'];

const EMPLOYMENT_TYPES = ['permanent', 'contract', 'part-time', 'temporary'];

const APPLICATION_STAGES = [
  'received',
  'screened',
  'shortlisted',
  'interviewed',
  'offer-made',
  'offer-accepted',
  'offer-declined',
  'offer-lapsed',
  'rejected',
  'withdrawn',
];

// Stages that are holding one of the posts.
const LIVE_OFFER_STAGES = ['offer-made', 'offer-accepted'];

const OFFER_HOLD_STATES = ['none', 'held', 'released', 'confirmed'];

const DEFAULT_CRITERIA = [
  { key: 'subject-knowledge', label: 'Subject knowledge', weight: 35, maxScore: 10 },
  { key: 'teaching-practice', label: 'Teaching practice', weight: 35, maxScore: 10 },
  { key: 'communication', label: 'Communication', weight: 15, maxScore: 10 },
  { key: 'safeguarding', label: 'Safeguarding awareness', weight: 15, maxScore: 10 },
];

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

const DEFAULT_OFFER_VALIDITY_DAYS = 10;
const MAX_OFFER_VALIDITY_DAYS = 60;

const DAY_MS = 86400000;

function round2(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

const historySchema = new mongoose.Schema(
  {
    action: { type: String, required: true, trim: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
    note: { type: String, trim: true, maxlength: 400 },
  },
  { _id: false }
);

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

const criterionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 40 },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    weight: { type: Number, required: true, min: 1, max: 100 },
    maxScore: { type: Number, required: true, min: 1, max: 100 },
  },
  { _id: false }
);

const panelMemberSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const jobPostingSchema = new mongoose.Schema(
  {
    ref: { type: String, unique: true, sparse: true },

    title: { type: String, required: [true, 'A post needs a title'], trim: true, maxlength: 120 },
    department: { type: String, required: true, trim: true, maxlength: 60 },
    subject: { type: String, trim: true, maxlength: 60 },

    employmentType: { type: String, enum: EMPLOYMENT_TYPES, default: 'permanent' },

    vacancies: {
      type: Number,
      required: true,
      min: [1, 'A posting with no vacancy is not a posting'],
      max: [50, 'That is a recruitment drive, not a vacancy'],
    },

    // Moved only by the offer lifecycle, never set from a request.
    liveOffers: { type: Number, default: 0, min: 0 },

    minQualification: { type: String, trim: true, maxlength: 120 },
    minExperienceYears: { type: Number, default: 0, min: 0, max: 50 },
    salaryBand: { type: String, trim: true, maxlength: 60 },

    opensOn: Date,
    closesOn: { type: Date, required: [true, 'A closing date is required'] },

    status: { type: String, enum: POSTING_STATUSES, default: 'draft', index: true },

    criteria: { type: [criterionSchema], default: () => DEFAULT_CRITERIA },
    panel: { type: [panelMemberSchema], default: [] },

    offerValidityDays: {
      type: Number,
      default: DEFAULT_OFFER_VALIDITY_DAYS,
      min: [1, 'Give a candidate at least a day'],
      max: [MAX_OFFER_VALIDITY_DAYS, 'A post held for two months is a post nobody is filling'],
    },

    applicationCounter: { type: Number, default: 0 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

jobPostingSchema.index({ status: 1, closesOn: 1 });

/**
 * Weights that do not total 100 give a weighted total out of something else,
 * which then gets compared with one out of 100.
 */
jobPostingSchema.pre('validate', function validateCriteria() {
  if (!this.criteria.length) {
    this.invalidate('criteria', 'A posting needs at least one scoring criterion');
    return;
  }

  const total = this.criteria.reduce((sum, criterion) => sum + (criterion.weight || 0), 0);
  if (total !== 100) {
    this.invalidate('criteria', `The criteria weights add up to ${total}, not 100`);
  }

  const keys = new Set();
  const duplicate = this.criteria.find((criterion) => {
    if (keys.has(criterion.key)) return true;
    keys.add(criterion.key);
    return false;
  });
  if (duplicate) this.invalidate('criteria', `Criterion "${duplicate.key}" appears twice`);
});

jobPostingSchema.virtual('seatsFree').get(function seatsFree() {
  return Math.max(0, this.vacancies - this.liveOffers);
});

jobPostingSchema.virtual('panelSize').get(function panelSize() {
  return this.panel.length;
});

jobPostingSchema.methods.isAcceptingApplications = function isAcceptingApplications(
  now = new Date()
) {
  if (!ACCEPTING_STATUSES.includes(this.status)) return false;
  if (this.opensOn && this.opensOn.getTime() > now.getTime()) return false;
  return this.closesOn.getTime() >= now.getTime();
};

jobPostingSchema.methods.hasPanellist = function hasPanellist(userId) {
  return this.panel.some((member) => String(member.user) === String(userId));
};

jobPostingSchema.methods.criterionFor = function criterionFor(key) {
  return this.criteria.find((criterion) => criterion.key === key) || null;
};

jobPostingSchema.methods.recordHistory = function recordHistory(action, by, note) {
  this.history.push({ action, by, note, at: new Date() });
  if (this.history.length > 200) this.history = this.history.slice(-200);
  return this;
};

jobPostingSchema.set('toJSON', { virtuals: true });
jobPostingSchema.set('toObject', { virtuals: true });

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

const componentScoreSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    score: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const panelScoreSchema = new mongoose.Schema(
  {
    panellist: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    scores: { type: [componentScoreSchema], default: [] },
    weightedTotal: { type: Number, default: 0 },
    comment: { type: String, trim: true, maxlength: 600 },
    submittedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const jobApplicationSchema = new mongoose.Schema(
  {
    posting: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobPosting',
      required: true,
      index: true,
    },

    reference: { type: String, default: null },

    candidateName: { type: String, required: true, trim: true, maxlength: 90 },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: [EMAIL_PATTERN, 'Please give a valid email address'],
    },
    phone: { type: String, trim: true, maxlength: 20 },
    qualification: { type: String, trim: true, maxlength: 160 },
    yearsExperience: { type: Number, default: 0, min: 0, max: 60 },
    coverNote: { type: String, trim: true, maxlength: 2000 },

    stage: { type: String, enum: APPLICATION_STAGES, default: 'received', index: true },

    screening: {
      meetsQualification: { type: Boolean, default: null },
      meetsExperience: { type: Boolean, default: null },
      note: { type: String, trim: true, maxlength: 500 },
      screenedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      screenedAt: Date,
    },

    panelScores: { type: [panelScoreSchema], default: [] },

    aggregate: {
      panelCount: { type: Number, default: 0 },
      expectedPanel: { type: Number, default: 0 },
      mean: { type: Number, default: null },
      spread: { type: Number, default: null },
      isComplete: { type: Boolean, default: false },
    },

    offer: {
      madeAt: Date,
      madeBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      expiresAt: Date,
      salaryOffered: { type: String, trim: true, maxlength: 60 },
      respondedAt: Date,
      responseNote: { type: String, trim: true, maxlength: 400 },
    },

    // Makes each release of a post happen exactly once.
    offerHold: { type: String, enum: OFFER_HOLD_STATES, default: 'none' },

    decisionNote: { type: String, trim: true, maxlength: 500 },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

// One application per candidate per posting. The same person applying twice
// with a different subject line updates their file rather than creating a rival.
jobApplicationSchema.index({ posting: 1, email: 1 }, { unique: true });
jobApplicationSchema.index({ email: 1, stage: 1 });
jobApplicationSchema.index({ stage: 1, 'offer.expiresAt': 1 });

jobApplicationSchema.methods.isLiveOffer = function isLiveOffer() {
  return LIVE_OFFER_STAGES.includes(this.stage);
};

jobApplicationSchema.methods.offerHasExpired = function offerHasExpired(now = new Date()) {
  if (this.stage !== 'offer-made' || !this.offer?.expiresAt) return false;
  return this.offer.expiresAt.getTime() <= now.getTime();
};

jobApplicationSchema.methods.daysToRespond = function daysToRespond(now = new Date()) {
  if (!this.offer?.expiresAt) return null;
  return Math.ceil((this.offer.expiresAt.getTime() - now.getTime()) / DAY_MS);
};

jobApplicationSchema.methods.scoreBy = function scoreBy(userId) {
  return this.panelScores.find((entry) => String(entry.panellist) === String(userId)) || null;
};

/**
 * The weighted total for one panellist's card, out of 100.
 *
 * Each component is scored against that criterion's own maximum and scaled by
 * its weight, so a criterion out of 5 and one out of 10 contribute what the
 * posting says they should rather than what their raw numbers suggest.
 */
jobApplicationSchema.statics.weightedTotalFor = function weightedTotalFor(posting, scores) {
  const total = scores.reduce((sum, entry) => {
    const criterion = posting.criterionFor(entry.key);
    if (!criterion) return sum;
    const ratio = Math.min(1, entry.score / criterion.maxScore);
    return sum + ratio * criterion.weight;
  }, 0);

  return round2(total);
};

/**
 * Recompute the aggregate.
 *
 * `spread` is reported next to the mean because a panel that disagrees
 * violently is the useful signal, and averaging it away is how that gets lost:
 * 74 over forty points of spread is not the same recommendation as 74 over four.
 */
jobApplicationSchema.methods.recomputeAggregate = function recomputeAggregate(posting) {
  const totals = this.panelScores.map((entry) => entry.weightedTotal);
  const expected = posting.panel.length;

  this.aggregate = {
    panelCount: totals.length,
    expectedPanel: expected,
    mean: totals.length ? round2(totals.reduce((sum, t) => sum + t, 0) / totals.length) : null,
    spread: totals.length ? round2(Math.max(...totals) - Math.min(...totals)) : null,
    isComplete: expected > 0 && totals.length >= expected,
  };

  return this.aggregate;
};

jobApplicationSchema.methods.recordHistory = function recordHistory(action, by, note) {
  this.history.push({ action, by, note, at: new Date() });
  if (this.history.length > 120) this.history = this.history.slice(-120);
  return this;
};

/**
 * What this application looks like to somebody who is not entitled to see the
 * panel yet. The scores are removed rather than hidden, and their own card is
 * handed back separately so a panellist can still check what they entered.
 */
jobApplicationSchema.methods.forViewer = function forViewer(viewerId) {
  const plain = this.toObject();

  if (this.aggregate.isComplete) return plain;

  const own = this.scoreBy(viewerId);
  plain.panelScores = own ? [own] : [];
  plain.aggregate = {
    ...plain.aggregate,
    mean: null,
    spread: null,
  };
  plain.panelSealed = true;

  return plain;
};

jobApplicationSchema.set('toJSON', { virtuals: true });
jobApplicationSchema.set('toObject', { virtuals: true });

const JobPosting = mongoose.model('JobPosting', jobPostingSchema);
const JobApplication = mongoose.model('JobApplication', jobApplicationSchema);

module.exports = {
  JobPosting,
  JobApplication,
  POSTING_STATUSES,
  EMPLOYMENT_TYPES,
  APPLICATION_STAGES,
  LIVE_OFFER_STAGES,
  OFFER_HOLD_STATES,
  DEFAULT_CRITERIA,
  DEFAULT_OFFER_VALIDITY_DAYS,
};
