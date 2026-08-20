const mongoose = require('mongoose');

/**
 * Staff professional development and certification.
 *
 * Two derivations carry the whole feature, and neither is ever accepted from a
 * client:
 *
 *   creditHours count toward an annual total only when `status === 'completed'`.
 *     A planned course is visible on the person's page and excluded from every
 *     total, which fixes structurally the spreadsheet habit of putting intent
 *     and achievement in the same column.
 *
 *   certificate.expiresOn is computed from `issuedOn + validMonths`. It is the
 *     field most likely to be mistyped off a paper certificate, and it is the
 *     one the compliance report depends on, so nobody types it.
 *
 * From that second derivation the query that does not exist in a spreadsheet
 * becomes trivial: every mandatory certification in the school lapsing inside
 * the next N days, soonest first.
 */

const TRAINING_TYPES = [
  'workshop',
  'online-course',
  'conference',
  'webinar',
  'in-house',
  'mentoring',
  'certification',
];

const COMPETENCIES = [
  'pedagogy',
  'assessment',
  'safeguarding',
  'first-aid',
  'lab-safety',
  'fire-safety',
  'inclusion',
  'digital-skills',
  'leadership',
  'subject-knowledge',
  'other',
];

const RECORD_STATUSES = ['planned', 'in-progress', 'completed', 'cancelled'];

const APPROVAL_STATUSES = ['not-required', 'pending', 'approved', 'declined'];

// Only a completed record contributes credit hours. This is the whole point of
// having a status at all.
const COUNTING_STATUSES = ['completed'];

// A record in one of these states may still be edited by its owner.
const EDITABLE_STATUSES = ['planned', 'in-progress'];

// How long a certification in each competency stays valid, in months. Having
// the common cases here means the usual record needs no input at all, and the
// unusual one can still override it.
const DEFAULT_VALID_MONTHS = {
  safeguarding: 36,
  'first-aid': 36,
  'lab-safety': 24,
  'fire-safety': 12,
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_PATTERN = /^\d{4}-\d{2}$/;

const MIN_CREDIT_HOURS = 0.5;
const MAX_CREDIT_HOURS = 200;
const MAX_VALID_MONTHS = 120;

// A certification inside this many days of expiry is reported as expiring.
const EXPIRING_SOON_DAYS = 90;

const DEFAULT_ANNUAL_REQUIREMENT = 30;

/** Today in the server's local zone, as the YYYY-MM-DD key the model stores. */
function todayKey(now = new Date()) {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * Add whole months to a YYYY-MM-DD key, clamping the day rather than rolling
 * over. 31 January plus one month is 28 February, not 3 March — a certificate
 * that silently gains three days of validity is a small bug with an
 * embarrassing failure mode.
 */
function addMonths(dateKey, months) {
  if (typeof dateKey !== 'string' || !DATE_PATTERN.test(dateKey)) return null;
  if (!Number.isFinite(months)) return null;

  const [year, month, day] = dateKey.split('-').map(Number);
  const targetMonthIndex = month - 1 + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const normalisedMonth = ((targetMonthIndex % 12) + 12) % 12;

  // Day 0 of the following month is the last day of this one.
  const daysInTargetMonth = new Date(targetYear, normalisedMonth + 1, 0).getDate();
  const clampedDay = Math.min(day, daysInTargetMonth);

  return [
    targetYear,
    String(normalisedMonth + 1).padStart(2, '0'),
    String(clampedDay).padStart(2, '0'),
  ].join('-');
}

/** Whole days between two YYYY-MM-DD keys. Negative when `to` is in the past. */
function daysBetween(from, to) {
  const fromMs = Date.parse(`${from}T00:00:00`);
  const toMs = Date.parse(`${to}T00:00:00`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  return Math.round((toMs - fromMs) / 86400000);
}

const certificateSchema = new mongoose.Schema(
  {
    reference: {
      type: String,
      trim: true,
      maxlength: [80, 'Certificate reference cannot exceed 80 characters'],
    },
    issuedOn: {
      type: String,
      match: [DATE_PATTERN, 'Issue date must be in YYYY-MM-DD format'],
    },
    validMonths: {
      type: Number,
      min: [1, 'Validity must be at least one month'],
      max: [MAX_VALID_MONTHS, `Validity cannot exceed ${MAX_VALID_MONTHS} months`],
      validate: {
        validator: (v) => v === undefined || v === null || Number.isInteger(v),
        message: 'Validity must be a whole number of months',
      },
    },
    // Derived in the parent's pre-validate hook. Never accepted from a client.
    expiresOn: {
      type: String,
      match: [DATE_PATTERN, 'Expiry date must be in YYYY-MM-DD format'],
    },
    fileUrl: {
      type: String,
      trim: true,
      maxlength: [500, 'Certificate link cannot exceed 500 characters'],
    },
  },
  { _id: false, timestamps: false }
);

const historySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: [40, 'Action cannot exceed 40 characters'],
    },
    note: {
      type: String,
      trim: true,
      maxlength: [500, 'Note cannot exceed 500 characters'],
    },
    by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    at: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true, timestamps: false }
);

const trainingRecordSchema = new mongoose.Schema(
  {
    staff: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A record must belong to a member of staff'],
    },
    academicYear: {
      type: String,
      required: [true, 'Academic year is required'],
      trim: true,
      match: [YEAR_PATTERN, 'Academic year must look like 2026-27'],
    },
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      maxlength: [160, 'Title cannot exceed 160 characters'],
    },
    provider: {
      type: String,
      required: [true, 'Provider is required'],
      trim: true,
      maxlength: [120, 'Provider cannot exceed 120 characters'],
    },
    type: {
      type: String,
      required: [true, 'Type is required'],
      enum: {
        values: TRAINING_TYPES,
        message: 'Invalid training type',
      },
    },
    competency: {
      type: String,
      required: [true, 'Competency is required'],
      enum: {
        values: COMPETENCIES,
        message: 'Invalid competency',
      },
    },
    startDate: {
      type: String,
      required: [true, 'Start date is required'],
      match: [DATE_PATTERN, 'Start date must be in YYYY-MM-DD format'],
    },
    endDate: {
      type: String,
      required: [true, 'End date is required'],
      match: [DATE_PATTERN, 'End date must be in YYYY-MM-DD format'],
    },
    creditHours: {
      type: Number,
      required: [true, 'Credit hours are required'],
      min: [MIN_CREDIT_HOURS, `Credit hours must be at least ${MIN_CREDIT_HOURS}`],
      max: [MAX_CREDIT_HOURS, `Credit hours cannot exceed ${MAX_CREDIT_HOURS}`],
    },
    status: {
      type: String,
      enum: {
        values: RECORD_STATUSES,
        message: 'Invalid status',
      },
      default: 'planned',
    },
    isMandatory: {
      type: Boolean,
      default: false,
    },
    approvalStatus: {
      type: String,
      enum: {
        values: APPROVAL_STATUSES,
        message: 'Invalid approval status',
      },
      default: 'not-required',
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    approvedAt: {
      type: Date,
    },
    declineReason: {
      type: String,
      trim: true,
      maxlength: [500, 'Decline reason cannot exceed 500 characters'],
    },
    certificate: {
      type: certificateSchema,
      default: () => ({}),
    },
    reflection: {
      type: String,
      trim: true,
      maxlength: [2000, 'Reflection cannot exceed 2000 characters'],
    },
    evidenceNote: {
      type: String,
      trim: true,
      maxlength: [1000, 'Evidence note cannot exceed 1000 characters'],
    },
    completedAt: {
      type: Date,
    },
    history: {
      type: [historySchema],
      default: [],
    },
  },
  { timestamps: true }
);

trainingRecordSchema.index({ staff: 1, academicYear: 1 });
trainingRecordSchema.index({ status: 1, isMandatory: 1 });
trainingRecordSchema.index({ 'certificate.expiresOn': 1, isMandatory: 1 });
trainingRecordSchema.index({ approvalStatus: 1 });

/**
 * Everything derived lives here, so there is exactly one place where a stored
 * value can come from a client value.
 */
trainingRecordSchema.pre('validate', async function derive() {
  if (this.startDate && this.endDate && this.endDate < this.startDate) {
    this.invalidate('endDate', 'Training cannot end before it starts');
  }

  // A mandatory record needs sign-off; an optional one needs nobody. Flipping
  // `isMandatory` moves the approval state rather than leaving a stale one.
  if (this.isMandatory && this.approvalStatus === 'not-required') {
    this.approvalStatus = 'pending';
  }
  if (!this.isMandatory && this.approvalStatus === 'pending') {
    this.approvalStatus = 'not-required';
  }
  if (this.approvalStatus !== 'approved') {
    this.approvedBy = undefined;
    this.approvedAt = undefined;
  }
  if (this.approvalStatus !== 'declined') {
    this.declineReason = undefined;
  }

  const certificate = this.certificate;
  if (certificate && certificate.issuedOn) {
    // Fall back to the competency default, then to a generic three years. A
    // certificate with an issue date always gets an expiry.
    if (!certificate.validMonths) {
      certificate.validMonths = DEFAULT_VALID_MONTHS[this.competency] || 36;
    }
    certificate.expiresOn = addMonths(certificate.issuedOn, certificate.validMonths);
  } else if (certificate) {
    certificate.expiresOn = undefined;
  }

  if (this.status !== 'completed') {
    this.completedAt = undefined;
  }
});

/** Whether the credit hours on this record count toward an annual total. */
trainingRecordSchema.methods.countsTowardTotal = function countsTowardTotal() {
  return COUNTING_STATUSES.includes(this.status);
};

trainingRecordSchema.methods.isEditable = function isEditable() {
  return EDITABLE_STATUSES.includes(this.status);
};

trainingRecordSchema.methods.isOwnedBy = function isOwnedBy(user) {
  if (!user) return false;
  return String(this.staff) === String(user._id);
};

/**
 * The expiry state as one word, derived on every read. A stored flag would be
 * exactly the thing that goes stale between the day it is written and the day
 * an inspector asks.
 */
trainingRecordSchema.methods.expiryState = function expiryState(today = todayKey()) {
  const expiresOn = this.certificate && this.certificate.expiresOn;
  if (!expiresOn) {
    return { state: 'not-applicable', expiresOn: null, daysRemaining: null };
  }

  const daysRemaining = daysBetween(today, expiresOn);
  let state = 'valid';
  if (daysRemaining === null) state = 'not-applicable';
  else if (daysRemaining < 0) state = 'expired';
  else if (daysRemaining <= EXPIRING_SOON_DAYS) state = 'expiring-soon';

  return { state, expiresOn, daysRemaining };
};

/**
 * Why this record cannot be completed, or null when it can.
 *
 * Two refusals matter. A course that has not finished cannot be completed —
 * that is the twelve-hour-conference claim, and the annual total is built on
 * it. And a certification with no certificate is just a course, so completing
 * one without a reference and an issue date is refused.
 */
trainingRecordSchema.methods.completabilityError = function completabilityError(
  today = todayKey()
) {
  if (this.status === 'completed') return 'This record is already complete';
  if (this.status === 'cancelled') return 'This record was cancelled';

  if (this.endDate > today) {
    return `This training runs until ${this.endDate} and cannot be completed yet`;
  }

  if (this.isMandatory && this.approvalStatus !== 'approved') {
    return 'Mandatory training must be approved before it can be completed';
  }

  if (this.type === 'certification') {
    const certificate = this.certificate || {};
    if (!certificate.reference || !certificate.issuedOn) {
      return 'A certification needs a certificate reference and issue date before it can be completed';
    }
  }

  return null;
};

/** Why `approver` may not approve this record, or null when they may. */
trainingRecordSchema.methods.approvabilityErrorFor = function approvabilityErrorFor(
  approver
) {
  if (!approver) return 'Not authenticated';
  if (String(this.staff) === String(approver._id)) {
    return 'You cannot approve your own training record';
  }
  if (this.approvalStatus === 'not-required') {
    return 'This record is not mandatory and does not need approval';
  }
  return null;
};

trainingRecordSchema.methods.recordHistory = function recordHistory(action, userId, note) {
  this.history.push({ action, by: userId, at: new Date(), note });
  if (this.history.length > 50) {
    this.history = this.history.slice(-50);
  }
};

trainingRecordSchema.methods.toRow = function toRow(today = todayKey()) {
  const expiry = this.expiryState(today);
  return {
    _id: this._id,
    staff: this.staff,
    academicYear: this.academicYear,
    title: this.title,
    provider: this.provider,
    type: this.type,
    competency: this.competency,
    startDate: this.startDate,
    endDate: this.endDate,
    creditHours: this.creditHours,
    status: this.status,
    isMandatory: this.isMandatory,
    approvalStatus: this.approvalStatus,
    approvedBy: this.approvedBy,
    approvedAt: this.approvedAt,
    declineReason: this.declineReason,
    certificate: this.certificate,
    expiry,
    countsTowardTotal: this.countsTowardTotal(),
    isEditable: this.isEditable(),
    completedAt: this.completedAt,
    createdAt: this.createdAt,
  };
};

/**
 * Fold records into an annual summary.
 *
 * Completed and planned hours are reported as separate quantities and never
 * added together, for the same reason the status exists at all.
 */
trainingRecordSchema.statics.buildSummary = function buildSummary(
  records,
  requiredHours = DEFAULT_ANNUAL_REQUIREMENT,
  today = todayKey()
) {
  let completedHours = 0;
  let plannedHours = 0;

  const byCompetency = {};
  const certifications = [];

  for (const record of records) {
    if (COUNTING_STATUSES.includes(record.status)) {
      completedHours += record.creditHours;
      byCompetency[record.competency] =
        (byCompetency[record.competency] || 0) + record.creditHours;
    } else if (['planned', 'in-progress'].includes(record.status)) {
      plannedHours += record.creditHours;
    }

    const expiry = record.expiryState(today);
    if (expiry.state !== 'not-applicable') {
      certifications.push({
        _id: record._id,
        title: record.title,
        competency: record.competency,
        isMandatory: record.isMandatory,
        reference: record.certificate?.reference || null,
        ...expiry,
      });
    }
  }

  // Soonest expiry first: the list is only useful in that order.
  certifications.sort((a, b) => (a.daysRemaining ?? 0) - (b.daysRemaining ?? 0));

  return {
    requiredHours,
    completedHours: Math.round(completedHours * 10) / 10,
    plannedHours: Math.round(plannedHours * 10) / 10,
    remainingHours: Math.round(Math.max(requiredHours - completedHours, 0) * 10) / 10,
    percentComplete: requiredHours
      ? Math.min(Math.round((completedHours / requiredHours) * 1000) / 10, 100)
      : 0,
    requirementMet: completedHours >= requiredHours,
    recordCount: records.length,
    byCompetency: Object.entries(byCompetency).map(([competency, hours]) => ({
      competency,
      hours: Math.round(hours * 10) / 10,
    })),
    certifications,
    expiredCount: certifications.filter((c) => c.state === 'expired').length,
    expiringSoonCount: certifications.filter((c) => c.state === 'expiring-soon').length,
  };
};

trainingRecordSchema.statics.todayKey = todayKey;
trainingRecordSchema.statics.addMonths = addMonths;
trainingRecordSchema.statics.daysBetween = daysBetween;
trainingRecordSchema.statics.TRAINING_TYPES = TRAINING_TYPES;
trainingRecordSchema.statics.COMPETENCIES = COMPETENCIES;
trainingRecordSchema.statics.RECORD_STATUSES = RECORD_STATUSES;
trainingRecordSchema.statics.APPROVAL_STATUSES = APPROVAL_STATUSES;
trainingRecordSchema.statics.COUNTING_STATUSES = COUNTING_STATUSES;
trainingRecordSchema.statics.EDITABLE_STATUSES = EDITABLE_STATUSES;
trainingRecordSchema.statics.DEFAULT_VALID_MONTHS = DEFAULT_VALID_MONTHS;
trainingRecordSchema.statics.EXPIRING_SOON_DAYS = EXPIRING_SOON_DAYS;
trainingRecordSchema.statics.DEFAULT_ANNUAL_REQUIREMENT = DEFAULT_ANNUAL_REQUIREMENT;

module.exports = mongoose.model('TrainingRecord', trainingRecordSchema);
