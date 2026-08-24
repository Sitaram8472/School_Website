const mongoose = require('mongoose');

/**
 * The document that has to exist before a coach leaves.
 *
 * `FieldTrip` is careful about consent, seats and medical notes. What it has no
 * opinion about is whether the trip should happen at all: `setStatus` moves a
 * trip from `draft` to `open` because somebody pressed a button, and one adult
 * may open a trip for sixty eight-year-olds.
 *
 * This file holds two properties:
 *
 *   1. a hazard's controls have to actually reduce it, and
 *   2. an assessment stops being current when the trip outgrows it.
 *
 * The second is the one that matters in practice. Whatever check happened at
 * fifteen children does not cover the thirty-one who eventually registered, and
 * nothing today notices.
 */

const ASSESSMENT_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'withdrawn',
  'superseded',
];

// An assessment in one of these is the trip's working document — it may be
// edited, and it is what the readiness check looks at.
const OPEN_STATUSES = ['draft', 'submitted'];

const ACTIVITY_CATEGORIES = [
  'low-risk-local',
  'standard',
  'residential',
  'water-based',
  'adventurous',
  'overseas',
];

const AGE_BANDS = ['early-years', 'primary', 'lower-secondary', 'upper-secondary', 'mixed'];

/**
 * Children per adult, by age band and activity.
 *
 * These are the numbers a school actually works to, and the reason they belong
 * in the model rather than in a request body is that the number of escorts a
 * trip needs is not a thing the organiser should be able to choose.
 */
const SUPERVISION_RATIOS = {
  'early-years': { default: 4, 'water-based': 3, adventurous: 3, overseas: 3 },
  primary: { default: 10, 'water-based': 8, adventurous: 6, overseas: 8, residential: 8 },
  'lower-secondary': { default: 15, 'water-based': 10, adventurous: 8, overseas: 10, residential: 12 },
  'upper-secondary': { default: 20, 'water-based': 12, adventurous: 10, overseas: 15, residential: 15 },
  mixed: { default: 10, 'water-based': 8, adventurous: 6, overseas: 8, residential: 10 },
};

// However small the group, somebody has to be able to stay with a casualty
// while somebody else stays with the group. One adult is never enough.
const MINIMUM_ESCORTS = 2;

/**
 * The highest residual rating each category will tolerate before submission is
 * refused. An adventurous trip carries more risk by definition; a walk to the
 * library does not get to.
 */
const RESIDUAL_TOLERANCE = {
  'low-risk-local': 6,
  standard: 8,
  residential: 9,
  'water-based': 9,
  adventurous: 12,
  overseas: 9,
};

// Categories where a named hospital and more than one headcount point are not
// optional.
const HIGH_ASSURANCE_CATEGORIES = ['water-based', 'adventurous', 'overseas', 'residential'];

const MIN_HEADCOUNT_POINTS = 2;

/**
 * Hazards that apply to nearly every trip, so the usual assessment needs no
 * typing and the unusual one can still add its own.
 */
const HAZARD_LIBRARY = [
  { code: 'road-transfer', label: 'Road transfer / coach travel', appliesTo: 'all' },
  { code: 'separation', label: 'Child separated from the group', appliesTo: 'all' },
  { code: 'medical-episode', label: 'Illness or existing medical condition', appliesTo: 'all' },
  { code: 'weather', label: 'Weather exposure', appliesTo: 'all' },
  { code: 'slips-trips', label: 'Slips, trips and uneven ground', appliesTo: 'all' },
  { code: 'open-water', label: 'Open or deep water', appliesTo: 'water-based' },
  { code: 'cold-shock', label: 'Cold water shock', appliesTo: 'water-based' },
  { code: 'height', label: 'Working or walking at height', appliesTo: 'adventurous' },
  { code: 'equipment', label: 'Specialist equipment failure', appliesTo: 'adventurous' },
  { code: 'overnight-supervision', label: 'Overnight supervision', appliesTo: 'residential' },
  { code: 'travel-documents', label: 'Passports, visas and border delay', appliesTo: 'overseas' },
  { code: 'unfamiliar-healthcare', label: 'Unfamiliar healthcare system', appliesTo: 'overseas' },
  { code: 'crowds', label: 'Crowds and public venues', appliesTo: 'all' },
  { code: 'lone-working', label: 'Staff working alone with children', appliesTo: 'all' },
];

const RATING_MIN = 1;
const RATING_MAX = 5;
const MAX_HAZARDS = 30;

const controlSchema = new mongoose.Schema(
  {
    measure: {
      type: String,
      required: [true, 'A control needs to say what will be done'],
      trim: true,
      minlength: [8, 'Please describe the control in a little more detail'],
      maxlength: [500, 'Control cannot exceed 500 characters'],
    },
    inPlace: { type: Boolean, default: false },
    ownerName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },
  },
  { _id: false }
);

const hazardSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, 'A hazard needs a code'],
      trim: true,
      maxlength: [40, 'Hazard code cannot exceed 40 characters'],
    },
    description: {
      type: String,
      required: [true, 'A hazard needs a description'],
      trim: true,
      minlength: [8, 'Please describe the hazard in a little more detail'],
      maxlength: [500, 'Description cannot exceed 500 characters'],
    },
    whoIsAtRisk: {
      type: String,
      required: [true, 'Say who is at risk'],
      trim: true,
      maxlength: [200, 'Cannot exceed 200 characters'],
    },

    likelihood: {
      type: Number,
      required: true,
      min: [RATING_MIN, 'Likelihood is 1 to 5'],
      max: [RATING_MAX, 'Likelihood is 1 to 5'],
    },
    severity: {
      type: Number,
      required: true,
      min: [RATING_MIN, 'Severity is 1 to 5'],
      max: [RATING_MAX, 'Severity is 1 to 5'],
    },
    // Derived in the parent's validate hook. Never accepted from a client.
    inherentRating: { type: Number, min: 1, max: 25 },

    controls: { type: [controlSchema], default: [] },

    residualLikelihood: {
      type: Number,
      required: true,
      min: [RATING_MIN, 'Residual likelihood is 1 to 5'],
      max: [RATING_MAX, 'Residual likelihood is 1 to 5'],
    },
    residualSeverity: {
      type: Number,
      required: true,
      min: [RATING_MIN, 'Residual severity is 1 to 5'],
      max: [RATING_MAX, 'Residual severity is 1 to 5'],
    },
    residualRating: { type: Number, min: 1, max: 25 },

    controlOwner: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },
  },
  { _id: false }
);

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

const tripRiskAssessmentSchema = new mongoose.Schema(
  {
    trip: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FieldTrip',
      required: [true, 'An assessment must belong to a trip'],
    },
    tripTitle: { type: String, trim: true, maxlength: [200, 'Too long'], default: '' },
    destination: { type: String, trim: true, maxlength: [200, 'Too long'], default: '' },
    departureDate: { type: String, trim: true, default: '' },

    version: { type: Number, default: 1, min: 1 },
    supersedes: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TripRiskAssessment',
      default: null,
    },

    activityCategory: {
      type: String,
      enum: { values: ACTIVITY_CATEGORIES, message: 'Invalid activity category' },
      default: 'standard',
    },
    ageBand: {
      type: String,
      enum: { values: AGE_BANDS, message: 'Invalid age band' },
      required: [true, 'An age band is required — it decides the supervision ratio'],
    },

    /**
     * The headcount the plan was written for, stamped at approval.
     *
     * This is the whole reason an assessment can go stale. Once the trip has
     * more children than this, the plan does not cover them and somebody has to
     * look at it again.
     */
    assessedHeadcount: { type: Number, default: 0, min: 0 },
    assessedEscortCount: { type: Number, default: 0, min: 0 },

    // Both derived. Never accepted from a client, because the number of adults
    // a trip needs is not a thing the organiser gets to choose.
    requiredEscorts: { type: Number, default: MINIMUM_ESCORTS, min: 0 },
    escortShortfall: { type: Number, default: 0, min: 0 },

    firstAiders: {
      type: [
        {
          _id: false,
          staff: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          name: { type: String, trim: true, maxlength: [80, 'Too long'] },
          qualification: { type: String, trim: true, maxlength: [120, 'Too long'], default: '' },
        },
      ],
      default: [],
    },

    // Recomputed from the trip's participants on every read. Stored so the
    // approved document records what was true when it was approved.
    noMedicalConsentCount: { type: Number, default: 0, min: 0 },

    hazards: {
      type: [hazardSchema],
      default: [],
      validate: {
        validator: (rows) => rows.length <= MAX_HAZARDS,
        message: `An assessment cannot carry more than ${MAX_HAZARDS} hazards`,
      },
    },

    emergencyPlan: {
      rendezvous: {
        type: String,
        required: [true, 'A rendezvous point is required'],
        trim: true,
        maxlength: [300, 'Too long'],
      },
      nearestHospital: { type: String, trim: true, maxlength: [300, 'Too long'], default: '' },
      // Where and when the group will be counted. More than one, for anything
      // that is not a walk down the road.
      headcountPoints: {
        type: [{ _id: false, label: { type: String, trim: true, maxlength: 120 } }],
        default: [],
      },
      communications: {
        type: String,
        required: [true, 'Say how the escorts will contact the school'],
        trim: true,
        maxlength: [500, 'Too long'],
      },
      recallProcedure: { type: String, trim: true, maxlength: [1000, 'Too long'], default: '' },
    },

    status: {
      type: String,
      enum: { values: ASSESSMENT_STATUSES, message: 'Invalid status' },
      default: 'draft',
    },

    assessedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'An assessment must record who wrote it'],
    },
    assessedByName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },
    assessedAt: { type: Date, default: Date.now },

    submittedAt: { type: Date, default: null },

    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedByName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },
    approvedAt: { type: Date, default: null },
    approvalNote: { type: String, trim: true, maxlength: [1000, 'Too long'], default: '' },

    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, maxlength: [1000, 'Too long'], default: '' },

    withdrawnAt: { type: Date, default: null },
    supersededAt: { type: Date, default: null },

    /**
     * Derived from `status`. A trip may have at most one assessment that is not
     * finished with, and a partialFilterExpression cannot express a negation.
     */
    isOpen: { type: Boolean, default: true },

    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true }
);

// One live assessment per trip. Editing an approved one forks a new version
// rather than mutating it, so this index is what stops two drafts existing.
tripRiskAssessmentSchema.index(
  { trip: 1 },
  { unique: true, partialFilterExpression: { isOpen: true } }
);

tripRiskAssessmentSchema.index({ trip: 1, version: -1 });
tripRiskAssessmentSchema.index({ status: 1, departureDate: 1 });
tripRiskAssessmentSchema.index({ assessedBy: 1, createdAt: -1 });

/**
 * How many adults this group needs.
 *
 * Derived rather than typed, so it recomputes when the trip changes and a
 * shortfall that appears three days after approval is visible.
 */
tripRiskAssessmentSchema.statics.requiredEscortsFor = function requiredEscortsFor(
  headcount,
  ageBand,
  activityCategory
) {
  const band = SUPERVISION_RATIOS[ageBand] || SUPERVISION_RATIOS.mixed;
  const perAdult = band[activityCategory] || band.default;
  const needed = Math.ceil(Math.max(0, Number(headcount) || 0) / perAdult);

  return {
    perAdult,
    // Two is the floor whatever the arithmetic says: somebody has to be able to
    // stay with a casualty while somebody else stays with the group.
    required: Math.max(MINIMUM_ESCORTS, needed),
  };
};

tripRiskAssessmentSchema.statics.hazardsForCategory = function hazardsForCategory(category) {
  return HAZARD_LIBRARY.filter(
    (hazard) => hazard.appliesTo === 'all' || hazard.appliesTo === category
  );
};

/**
 * Derive the ratings and refuse the assessment that only looks like one.
 */
tripRiskAssessmentSchema.pre('validate', function deriveRatings() {
  this.hazards.forEach((hazard) => {
    hazard.inherentRating = hazard.likelihood * hazard.severity;
    hazard.residualRating = hazard.residualLikelihood * hazard.residualSeverity;
  });

  /**
   * A control that changes nothing is not a control.
   *
   * This is the check the whole file exists for. Without it, an assessment is a
   * form somebody fills in to get past the form, and the residual column is
   * copied from the inherent one.
   */
  const uncontrolled = this.hazards.find(
    (hazard) => hazard.controls.length > 0 && hazard.residualRating >= hazard.inherentRating
  );

  if (uncontrolled) {
    this.invalidate(
      'hazards',
      `"${uncontrolled.code}" lists controls but the residual rating (${uncontrolled.residualRating}) ` +
        `is not lower than the inherent one (${uncontrolled.inherentRating}). ` +
        `A control that changes nothing is not a control.`
    );
  }

  const uncontrolledAtAll = this.hazards.find((hazard) => hazard.controls.length === 0);
  if (uncontrolledAtAll) {
    this.invalidate(
      'hazards',
      `"${uncontrolledAtAll.code}" has no control measure. Every hazard needs one.`
    );
  }

  const codes = this.hazards.map((hazard) => hazard.code);
  if (new Set(codes).size !== codes.length) {
    this.invalidate('hazards', 'The same hazard is listed twice');
  }

  const { required } = this.constructor.requiredEscortsFor(
    this.assessedHeadcount,
    this.ageBand,
    this.activityCategory
  );

  this.requiredEscorts = required;
  this.escortShortfall = Math.max(0, required - (this.assessedEscortCount || 0));
});

tripRiskAssessmentSchema.pre('save', function guardAssessment() {
  this.isOpen = OPEN_STATUSES.includes(this.status);

  if (this.approvedBy && this.assessedBy && this.approvedBy.equals(this.assessedBy)) {
    throw new Error('An assessment cannot be approved by the person who wrote it');
  }

  if (this.rejectedBy && this.assessedBy && this.rejectedBy.equals(this.assessedBy)) {
    throw new Error('An assessment cannot be rejected by the person who wrote it');
  }

  // An approved assessment is the document a decision was taken against.
  // Changing it means a new version, not an edit.
  if (!this.isNew && this.status === 'approved') {
    const frozen = ['hazards', 'ageBand', 'activityCategory', 'assessedHeadcount', 'emergencyPlan'];
    const edited = frozen.find((field) => this.isModified(field));

    if (edited) {
      throw new Error(
        `"${edited}" cannot be changed on an approved assessment; create a new version instead`
      );
    }
  }
});

tripRiskAssessmentSchema.methods.log = function log(action, actor, note = '') {
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
 * Every reason this assessment is not good enough to submit.
 *
 * Returned as a list rather than as the first failure, so a trip lead sees all
 * of them at once instead of discovering them one rejection at a time.
 */
tripRiskAssessmentSchema.methods.submissionBlockers = function submissionBlockers() {
  const blockers = [];
  const tolerance = RESIDUAL_TOLERANCE[this.activityCategory] || 8;

  if (this.hazards.length === 0) {
    blockers.push('No hazards have been identified.');
  }

  this.hazards.forEach((hazard) => {
    if (hazard.residualRating > tolerance) {
      blockers.push(
        `"${hazard.code}" still rates ${hazard.residualRating} after controls; ` +
          `${this.activityCategory} trips tolerate up to ${tolerance}.`
      );
    }
  });

  if (this.firstAiders.length === 0) {
    blockers.push('No first aider has been named.');
  }

  if (HIGH_ASSURANCE_CATEGORIES.includes(this.activityCategory)) {
    if (!this.emergencyPlan.nearestHospital) {
      blockers.push(
        `A ${this.activityCategory} trip must name the nearest hospital.`
      );
    }
    if ((this.emergencyPlan.headcountPoints || []).length < MIN_HEADCOUNT_POINTS) {
      blockers.push(
        `A ${this.activityCategory} trip needs at least ${MIN_HEADCOUNT_POINTS} headcount points.`
      );
    }
  }

  if (this.escortShortfall > 0) {
    blockers.push(
      `${this.assessedEscortCount} escort(s) named, ${this.requiredEscorts} required for ` +
        `${this.assessedHeadcount} ${this.ageBand} children on a ${this.activityCategory} trip.`
    );
  }

  return blockers;
};

/**
 * Whether this approved assessment still describes the trip it was approved
 * for. Computed against the live trip, never stored, because the whole point is
 * that the trip moves underneath it.
 */
tripRiskAssessmentSchema.methods.currencyAgainst = function currencyAgainst(trip) {
  if (!trip) return { isCurrent: false, reasons: ['The trip no longer exists.'] };

  const reasons = [];
  const liveHeadcount = trip.confirmedCount || 0;
  const liveEscorts = (trip.staffEscorts || []).length;

  if (liveHeadcount > this.assessedHeadcount) {
    reasons.push(
      `Approved for ${this.assessedHeadcount} children. ${liveHeadcount} are registered.`
    );
  }

  if (liveEscorts < this.assessedEscortCount) {
    reasons.push(
      `Approved with ${this.assessedEscortCount} escorts. ${liveEscorts} are named now.`
    );
  }

  const { required } = this.constructor.requiredEscortsFor(
    liveHeadcount,
    this.ageBand,
    this.activityCategory
  );

  if (liveEscorts < required) {
    reasons.push(
      `${liveEscorts} escort(s) for ${liveHeadcount} children needs ${required}.`
    );
  }

  if (this.departureDate && trip.departureDate && this.departureDate !== trip.departureDate) {
    reasons.push(`Approved for ${this.departureDate}; the trip now departs ${trip.departureDate}.`);
  }

  return {
    isCurrent: this.status === 'approved' && reasons.length === 0,
    reasons,
    liveHeadcount,
    liveEscorts,
    requiredForLive: required,
  };
};

tripRiskAssessmentSchema.methods.submit = function submit(actor) {
  if (this.status !== 'draft') {
    throw new Error(`Only a draft assessment can be submitted; this one is ${this.status}`);
  }

  const blockers = this.submissionBlockers();
  if (blockers.length > 0) {
    const error = new Error('This assessment is not ready to submit');
    error.blockers = blockers;
    throw error;
  }

  this.status = 'submitted';
  this.submittedAt = new Date();

  return this.log('submitted', actor);
};

tripRiskAssessmentSchema.methods.approve = function approve(actor, note = '') {
  if (this.status !== 'submitted') {
    throw new Error(`Only a submitted assessment can be approved; this one is ${this.status}`);
  }
  if (actor._id.equals(this.assessedBy)) {
    throw new Error('An assessment cannot be approved by the person who wrote it');
  }

  this.status = 'approved';
  this.approvedBy = actor._id;
  this.approvedByName = actor.name || '';
  this.approvedAt = new Date();
  this.approvalNote = note || '';

  return this.log('approved', actor, note);
};

tripRiskAssessmentSchema.methods.reject = function reject(actor, reason) {
  if (this.status !== 'submitted') {
    throw new Error(`Only a submitted assessment can be rejected; this one is ${this.status}`);
  }
  if (actor._id.equals(this.assessedBy)) {
    throw new Error('An assessment cannot be rejected by the person who wrote it');
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('A rejection reason is required');
  }

  // Back to draft rather than to a dead end — the point of rejecting is that
  // somebody fixes it.
  this.status = 'draft';
  this.rejectedBy = actor._id;
  this.rejectedAt = new Date();
  this.rejectionReason = String(reason).trim();

  return this.log('rejected', actor, this.rejectionReason);
};

tripRiskAssessmentSchema.methods.withdraw = function withdraw(actor, reason = '') {
  if (!OPEN_STATUSES.includes(this.status)) {
    throw new Error(`A ${this.status} assessment cannot be withdrawn`);
  }

  this.status = 'withdrawn';
  this.withdrawnAt = new Date();

  return this.log('withdrawn', actor, reason);
};

tripRiskAssessmentSchema.methods.markSuperseded = function markSuperseded(actor) {
  this.status = 'superseded';
  this.supersededAt = new Date();

  return this.log('superseded', actor);
};

tripRiskAssessmentSchema.statics.ASSESSMENT_STATUSES = ASSESSMENT_STATUSES;
tripRiskAssessmentSchema.statics.OPEN_STATUSES = OPEN_STATUSES;
tripRiskAssessmentSchema.statics.ACTIVITY_CATEGORIES = ACTIVITY_CATEGORIES;
tripRiskAssessmentSchema.statics.AGE_BANDS = AGE_BANDS;
tripRiskAssessmentSchema.statics.SUPERVISION_RATIOS = SUPERVISION_RATIOS;
tripRiskAssessmentSchema.statics.RESIDUAL_TOLERANCE = RESIDUAL_TOLERANCE;
tripRiskAssessmentSchema.statics.HAZARD_LIBRARY = HAZARD_LIBRARY;
tripRiskAssessmentSchema.statics.HIGH_ASSURANCE_CATEGORIES = HIGH_ASSURANCE_CATEGORIES;
tripRiskAssessmentSchema.statics.MINIMUM_ESCORTS = MINIMUM_ESCORTS;
tripRiskAssessmentSchema.statics.MIN_HEADCOUNT_POINTS = MIN_HEADCOUNT_POINTS;
tripRiskAssessmentSchema.statics.RATING_MAX = RATING_MAX;

module.exports = mongoose.model('TripRiskAssessment', tripRiskAssessmentSchema);
