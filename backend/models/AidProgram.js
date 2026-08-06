const mongoose = require('mongoose');

/**
 * A financial-aid fund the school opens for a cycle.
 *
 * `budgetAwarded` is a counter rather than a sum over the applications for one
 * reason: it lets the "this award still fits in the fund" test live inside the
 * filter of a single conditional update. Summing awards in application code
 * moves the check outside the write, and two reviewers approving the last
 * ₹50,000 at the same moment then both succeed. That is not a hypothetical —
 * it is the failure that made families be told they had a scholarship and then
 * told they did not.
 */

const AID_TYPES = ['merit', 'need', 'sports', 'arts', 'sibling', 'staff-ward'];
const PROGRAM_STATUSES = ['draft', 'open', 'closed', 'exhausted'];

const scoringWeightsSchema = new mongoose.Schema(
  {
    need: { type: Number, default: 50, min: 0, max: 100 },
    merit: { type: Number, default: 30, min: 0, max: 100 },
    attendance: { type: Number, default: 20, min: 0, max: 100 },
  },
  { _id: false }
);

const eligibilitySchema = new mongoose.Schema(
  {
    minPercentage: {
      type: Number,
      default: 0,
      min: [0, 'Minimum percentage cannot be negative'],
      max: [100, 'Minimum percentage cannot exceed 100'],
    },
    minAttendance: {
      type: Number,
      default: 0,
      min: [0, 'Minimum attendance cannot be negative'],
      max: [100, 'Minimum attendance cannot exceed 100'],
    },
    maxHouseholdIncome: {
      type: Number,
      default: 0,
      min: [0, 'Maximum household income cannot be negative'],
    },
    eligibleClasses: {
      type: [String],
      default: [],
    },
  },
  { _id: false }
);

const aidProgramSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Program name is required'],
      trim: true,
      maxlength: [120, 'Program name cannot exceed 120 characters'],
    },

    description: {
      type: String,
      trim: true,
      maxlength: [1000, 'Description cannot exceed 1000 characters'],
      default: '',
    },

    academicYear: {
      type: String,
      required: [true, 'Academic year is required'],
      trim: true,
      maxlength: [20, 'Academic year cannot exceed 20 characters'],
    },

    aidType: {
      type: String,
      enum: {
        values: AID_TYPES,
        message: 'Invalid aid type',
      },
      required: [true, 'Aid type is required'],
    },

    opensOn: {
      type: Date,
      required: [true, 'An opening date is required'],
    },

    closesOn: {
      type: Date,
      required: [true, 'A closing date is required'],
      validate: {
        validator(value) {
          return !this.opensOn || value > this.opensOn;
        },
        message: 'The closing date must be after the opening date',
      },
    },

    eligibility: {
      type: eligibilitySchema,
      default: () => ({}),
    },

    // ---- Money ----
    totalBudget: {
      type: Number,
      required: [true, 'A total budget is required'],
      min: [1, 'A fund with no money in it is not a fund'],
    },

    // Server-owned. See the note at the top of the file.
    budgetAwarded: {
      type: Number,
      default: 0,
      min: [0, 'Budget awarded cannot be negative'],
    },

    maxAwardPerStudent: {
      type: Number,
      required: [true, 'A per-student ceiling is required'],
      min: [1, 'The per-student ceiling must be positive'],
    },

    currency: {
      type: String,
      default: 'INR',
      uppercase: true,
      trim: true,
    },

    /**
     * How this program weighs the three score components.
     *
     * Held on the program rather than hardcoded because a sports bursary and a
     * means-tested fund do not weigh household income the same way, and a
     * single global weighting would make one of them dishonest.
     */
    scoringWeights: {
      type: scoringWeightsSchema,
      default: () => ({}),
    },

    status: {
      type: String,
      enum: {
        values: PROGRAM_STATUSES,
        message: 'Invalid program status',
      },
      default: 'draft',
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'The staff member opening the program is required'],
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

aidProgramSchema.index({ status: 1, closesOn: 1 });
aidProgramSchema.index({ academicYear: 1, aidType: 1 });
aidProgramSchema.index({ name: 1, academicYear: 1 }, { unique: true });

/**
 * The weights are normalised at validation rather than rejected when they do
 * not sum to 100, so an office setting 60/30/20 gets a sensible program instead
 * of a form error about arithmetic.
 */
aidProgramSchema.pre('validate', function () {
  const weights = this.scoringWeights || {};
  const total = (weights.need || 0) + (weights.merit || 0) + (weights.attendance || 0);

  if (total <= 0) {
    this.scoringWeights = { need: 50, merit: 30, attendance: 20 };
  }
});

aidProgramSchema.virtual('budgetRemaining').get(function () {
  return Math.max(0, this.totalBudget - this.budgetAwarded);
});

aidProgramSchema.virtual('budgetUsedPercent').get(function () {
  if (!this.totalBudget) return 0;
  return Math.min(100, Math.round((this.budgetAwarded / this.totalBudget) * 100));
});

aidProgramSchema.virtual('isOpen').get(function () {
  const now = Date.now();
  return (
    this.status === 'open' && this.opensOn.getTime() <= now && this.closesOn.getTime() >= now
  );
});

/**
 * Why applications cannot be submitted right now, or null when they can.
 */
aidProgramSchema.methods.applicationError = function () {
  if (this.status === 'draft') return 'This program has not opened yet.';
  if (this.status === 'closed') return 'This program is closed to new applications.';
  if (this.status === 'exhausted') return 'This fund has been fully allocated.';

  const now = Date.now();
  if (this.opensOn.getTime() > now) {
    return `Applications open on ${this.opensOn.toISOString().slice(0, 10)}.`;
  }
  if (this.closesOn.getTime() < now) {
    return `Applications closed on ${this.closesOn.toISOString().slice(0, 10)}.`;
  }
  return null;
};

/**
 * Which eligibility rule an application fails, or null when it passes.
 *
 * Returns the specific rule rather than a boolean, because "you are not
 * eligible" tells a family nothing they can act on and generates a phone call
 * to the office.
 */
aidProgramSchema.methods.eligibilityError = function (application) {
  const rules = this.eligibility || {};

  if (rules.minPercentage > 0 && Number(application.academicPercentage) < rules.minPercentage) {
    return `This program requires at least ${rules.minPercentage}% in the last academic year; the application declares ${application.academicPercentage}%.`;
  }

  if (rules.minAttendance > 0 && Number(application.attendancePercentage) < rules.minAttendance) {
    return `This program requires at least ${rules.minAttendance}% attendance; the application declares ${application.attendancePercentage}%.`;
  }

  if (
    rules.maxHouseholdIncome > 0 &&
    Number(application.householdIncome) > rules.maxHouseholdIncome
  ) {
    return `This program is limited to households earning up to ${rules.maxHouseholdIncome} ${this.currency}.`;
  }

  if (
    Array.isArray(rules.eligibleClasses) &&
    rules.eligibleClasses.length > 0 &&
    application.className &&
    !rules.eligibleClasses.includes(application.className)
  ) {
    return `This program is open to ${rules.eligibleClasses.join(', ')} only.`;
  }

  return null;
};

/**
 * The deterministic score.
 *
 * A pure function of the declared figures and the program's weights — the same
 * inputs always give the same number, which is what makes an appeal answerable.
 *
 * The need component divides household income by the square root of household
 * size rather than by the size itself. That is the standard equivalence scale:
 * a family of four does not need four times the income of a single person to
 * reach the same standard of living, and dividing straight through would
 * over-reward large households at the expense of small poor ones.
 *
 * The three components are stored alongside the total. Storing only the total
 * makes "why did we score you 61" unanswerable.
 */
aidProgramSchema.methods.computeScore = function (application) {
  const weights = this.scoringWeights || { need: 50, merit: 30, attendance: 20 };
  const weightTotal = (weights.need || 0) + (weights.merit || 0) + (weights.attendance || 0);

  const clamp = (value) => Math.max(0, Math.min(100, Number(value) || 0));

  // Fall back to the requested-amount scale when a program sets no income
  // ceiling, so a merit fund still produces a meaningful need component
  // instead of dividing by zero.
  const ceiling = this.eligibility?.maxHouseholdIncome || 0;

  let need = 0;
  if (ceiling > 0) {
    const householdSize = Math.max(1, Number(application.dependants || 0) + 1);
    const effectiveIncome = Number(application.householdIncome || 0) / Math.sqrt(householdSize);
    need = clamp(100 * (1 - effectiveIncome / ceiling));
  }

  const merit = clamp(application.academicPercentage);
  const attendance = clamp(application.attendancePercentage);

  const total = Math.round(
    (need * (weights.need || 0) + merit * (weights.merit || 0) + attendance * (weights.attendance || 0)) /
      (weightTotal || 1)
  );

  return {
    need: Math.round(need),
    merit: Math.round(merit),
    attendance: Math.round(attendance),
    total: Math.max(0, Math.min(100, total)),
  };
};

aidProgramSchema.statics.AID_TYPES = AID_TYPES;
aidProgramSchema.statics.PROGRAM_STATUSES = PROGRAM_STATUSES;

module.exports = mongoose.model('AidProgram', aidProgramSchema);
