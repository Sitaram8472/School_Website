const mongoose = require('mongoose');

/**
 * Community service hours.
 *
 * One entry is one activity on one date. The only thing that makes this
 * different from the paper slip it replaces is that an entry does not count
 * until somebody other than the student and other than the supervisor has said
 * it happened — see `verifiabilityErrorFor` below, and its caller in the
 * controller.
 *
 * Progress is never stored on the student. It is folded out of verified entries
 * on read, so a total can never disagree with the ledger it came from, and the
 * ledger is the evidence.
 */

const CATEGORIES = [
  'environment',
  'education',
  'elderly-care',
  'animal-welfare',
  'community-kitchen',
  'fundraising',
  'health-camp',
  'disaster-relief',
  'school-service',
  'other',
];

const STATUSES = ['pending', 'verified', 'rejected', 'withdrawn'];

// Only these count toward the requirement. `pending` is shown to the student,
// separately and greyed, because conflating "done" with "claimed" is how the
// shortfall stays hidden until the final term.
const COUNTING_STATUSES = ['verified'];

// An entry in one of these states may still be edited by its owner. Once
// verified it is immutable; the correction path is reject-and-resubmit, which
// leaves both states in the history.
const EDITABLE_STATUSES = ['pending', 'rejected'];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_PATTERN = /^\d{4}-\d{2}$/;

const MIN_HOURS = 0.5;
const MAX_HOURS_PER_ENTRY = 8;
const MAX_HOURS_PER_DAY = 12;

// The graduation requirement. Kept here rather than in the controller so the
// student's progress bar and any future transcript read the same number.
const DEFAULT_ANNUAL_REQUIREMENT = 30;

/** Today in the server's local zone, as the YYYY-MM-DD key the model stores. */
function todayKey(now = new Date()) {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/** Hours are logged in half-hour steps. 1.7 hours is a number nobody measured. */
function isHalfHourStep(value) {
  if (!Number.isFinite(value)) return false;
  return Math.abs(value * 2 - Math.round(value * 2)) < 1e-9;
}

function roundTo(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

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

const serviceLogSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'An entry must belong to a student'],
    },
    academicYear: {
      type: String,
      required: [true, 'Academic year is required'],
      trim: true,
      match: [YEAR_PATTERN, 'Academic year must look like 2026-27'],
    },
    activityTitle: {
      type: String,
      required: [true, 'Activity title is required'],
      trim: true,
      maxlength: [140, 'Activity title cannot exceed 140 characters'],
    },
    organisation: {
      type: String,
      required: [true, 'Organisation is required'],
      trim: true,
      maxlength: [120, 'Organisation cannot exceed 120 characters'],
    },
    category: {
      type: String,
      required: [true, 'Category is required'],
      enum: {
        values: CATEGORIES,
        message: 'Invalid category',
      },
    },
    date: {
      type: String,
      required: [true, 'Date is required'],
      match: [DATE_PATTERN, 'Date must be in YYYY-MM-DD format'],
    },
    hours: {
      type: Number,
      required: [true, 'Hours are required'],
      min: [MIN_HOURS, `An entry must be at least ${MIN_HOURS} hours`],
      max: [MAX_HOURS_PER_ENTRY, `An entry cannot exceed ${MAX_HOURS_PER_ENTRY} hours`],
      validate: {
        validator: isHalfHourStep,
        message: 'Hours must be logged in half-hour steps',
      },
    },
    description: {
      type: String,
      required: [true, 'A description of the work is required'],
      trim: true,
      minlength: [15, 'Please describe the work in at least 15 characters'],
      maxlength: [1500, 'Description cannot exceed 1500 characters'],
    },
    supervisorName: {
      type: String,
      required: [true, 'Supervisor name is required'],
      trim: true,
      maxlength: [100, 'Supervisor name cannot exceed 100 characters'],
    },
    supervisorContact: {
      type: String,
      required: [true, 'A supervisor contact is required'],
      trim: true,
      maxlength: [120, 'Supervisor contact cannot exceed 120 characters'],
    },
    // If the supervisor is a member of staff, naming them here is what lets the
    // controller stop that person signing off their own supervision.
    supervisorUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    evidenceUrl: {
      type: String,
      trim: true,
      maxlength: [500, 'Evidence link cannot exceed 500 characters'],
    },
    status: {
      type: String,
      enum: {
        values: STATUSES,
        message: 'Invalid status',
      },
      default: 'pending',
    },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    verifiedAt: {
      type: Date,
    },
    rejectionReason: {
      type: String,
      trim: true,
      maxlength: [500, 'Rejection reason cannot exceed 500 characters'],
    },
    history: {
      type: [historySchema],
      default: [],
    },
  },
  { timestamps: true }
);

serviceLogSchema.index({ student: 1, academicYear: 1 });
serviceLogSchema.index({ status: 1, createdAt: 1 });
serviceLogSchema.index({ student: 1, date: 1 });

serviceLogSchema.pre('validate', async function derive() {
  // Nothing in the future. Hours logged for next weekend are an intention.
  if (this.date && this.date > todayKey()) {
    this.invalidate('date', 'Service hours cannot be logged for a future date');
  }

  if (this.status !== 'verified') {
    this.verifiedBy = undefined;
    this.verifiedAt = undefined;
  }
  if (this.status !== 'rejected') {
    this.rejectionReason = undefined;
  }
});

/** Whether the owner may still edit this entry. */
serviceLogSchema.methods.isEditable = function isEditable() {
  return EDITABLE_STATUSES.includes(this.status);
};

serviceLogSchema.methods.isOwnedBy = function isOwnedBy(user) {
  if (!user) return false;
  return String(this.student) === String(user._id);
};

/**
 * Why `verifier` may not verify this entry, or null when they may.
 *
 * This is the rule the whole feature exists for. Verification means a second
 * person looked; letting the student or the supervisor sign it off reproduces
 * the paper slip exactly, with extra steps.
 */
serviceLogSchema.methods.verifiabilityErrorFor = function verifiabilityErrorFor(verifier) {
  if (!verifier) return 'Not authenticated';

  if (String(this.student) === String(verifier._id)) {
    return 'You cannot verify your own service hours';
  }

  if (this.supervisorUser && String(this.supervisorUser) === String(verifier._id)) {
    return 'You supervised this activity, so somebody else must verify it';
  }

  if (this.status === 'withdrawn') {
    return 'This entry was withdrawn by the student';
  }

  return null;
};

serviceLogSchema.methods.recordHistory = function recordHistory(action, userId, note) {
  this.history.push({ action, by: userId, at: new Date(), note });
  if (this.history.length > 50) {
    this.history = this.history.slice(-50);
  }
};

serviceLogSchema.methods.toRow = function toRow() {
  return {
    _id: this._id,
    student: this.student,
    academicYear: this.academicYear,
    activityTitle: this.activityTitle,
    organisation: this.organisation,
    category: this.category,
    date: this.date,
    hours: this.hours,
    description: this.description,
    supervisorName: this.supervisorName,
    supervisorContact: this.supervisorContact,
    evidenceUrl: this.evidenceUrl,
    status: this.status,
    verifiedBy: this.verifiedBy,
    verifiedAt: this.verifiedAt,
    rejectionReason: this.rejectionReason,
    isEditable: this.isEditable(),
    createdAt: this.createdAt,
  };
};

/**
 * Fold a set of entries into a progress report.
 *
 * Verified and pending are reported as separate quantities and never added
 * together. A student who has claimed forty hours and had six verified has six
 * hours, and the page must say so.
 */
serviceLogSchema.statics.buildProgress = function buildProgress(
  entries,
  requiredHours = DEFAULT_ANNUAL_REQUIREMENT
) {
  let verifiedHours = 0;
  let pendingHours = 0;
  let rejectedHours = 0;

  const byCategory = {};
  for (const category of CATEGORIES) {
    byCategory[category] = { verified: 0, pending: 0, entries: 0 };
  }

  for (const entry of entries) {
    const bucket = byCategory[entry.category] || {
      verified: 0,
      pending: 0,
      entries: 0,
    };
    bucket.entries += 1;

    if (COUNTING_STATUSES.includes(entry.status)) {
      verifiedHours += entry.hours;
      bucket.verified += entry.hours;
    } else if (entry.status === 'pending') {
      pendingHours += entry.hours;
      bucket.pending += entry.hours;
    } else if (entry.status === 'rejected') {
      rejectedHours += entry.hours;
    }

    byCategory[entry.category] = bucket;
  }

  const remaining = Math.max(requiredHours - verifiedHours, 0);

  return {
    requiredHours,
    verifiedHours: roundTo(verifiedHours),
    pendingHours: roundTo(pendingHours),
    rejectedHours: roundTo(rejectedHours),
    remainingHours: roundTo(remaining),
    percentComplete: requiredHours
      ? Math.min(roundTo((verifiedHours / requiredHours) * 100), 100)
      : 0,
    requirementMet: verifiedHours >= requiredHours,
    entryCount: entries.length,
    byCategory: Object.entries(byCategory)
      .filter(([, value]) => value.entries > 0)
      .map(([category, value]) => ({
        category,
        verified: roundTo(value.verified),
        pending: roundTo(value.pending),
        entries: value.entries,
      })),
  };
};

serviceLogSchema.statics.todayKey = todayKey;
serviceLogSchema.statics.CATEGORIES = CATEGORIES;
serviceLogSchema.statics.STATUSES = STATUSES;
serviceLogSchema.statics.COUNTING_STATUSES = COUNTING_STATUSES;
serviceLogSchema.statics.EDITABLE_STATUSES = EDITABLE_STATUSES;
serviceLogSchema.statics.MIN_HOURS = MIN_HOURS;
serviceLogSchema.statics.MAX_HOURS_PER_ENTRY = MAX_HOURS_PER_ENTRY;
serviceLogSchema.statics.MAX_HOURS_PER_DAY = MAX_HOURS_PER_DAY;
serviceLogSchema.statics.DEFAULT_ANNUAL_REQUIREMENT = DEFAULT_ANNUAL_REQUIREMENT;

module.exports = mongoose.model('ServiceLog', serviceLogSchema);
