const mongoose = require('mongoose');

/**
 * A meal plan the canteen offers.
 *
 * `allergens` is a closed vocabulary rather than free text. The counter checks
 * a plan's allergens against a student's declared flags before every sale, and
 * a comparison between "Nuts", "nuts " and "tree nuts" quietly finds nothing —
 * which is the worst possible outcome for the one check in this module that is
 * about safety rather than money.
 */

const MEAL_TYPES = ['breakfast', 'lunch', 'snack', 'dinner'];
const ALLERGENS = ['nuts', 'dairy', 'gluten', 'egg', 'soy', 'shellfish', 'fish', 'sesame'];
const SERVING_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const PLAN_CYCLES = ['daily', 'weekly', 'monthly', 'term'];
const PLAN_STATUSES = ['draft', 'active', 'paused', 'retired'];

const mealPlanSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Plan name is required'],
      trim: true,
      maxlength: [80, 'Plan name cannot exceed 80 characters'],
    },

    description: {
      type: String,
      trim: true,
      maxlength: [400, 'Description cannot exceed 400 characters'],
      default: '',
    },

    mealTypes: {
      type: [String],
      required: [true, 'At least one meal type is required'],
      validate: {
        validator(values) {
          return (
            Array.isArray(values) &&
            values.length > 0 &&
            values.every((value) => MEAL_TYPES.includes(value))
          );
        },
        message: `Meal types must be a non-empty selection from: ${MEAL_TYPES.join(', ')}`,
      },
    },

    servingDays: {
      type: [String],
      default: ['mon', 'tue', 'wed', 'thu', 'fri'],
      validate: {
        validator(values) {
          return Array.isArray(values) && values.every((value) => SERVING_DAYS.includes(value));
        },
        message: `Serving days must be drawn from: ${SERVING_DAYS.join(', ')}`,
      },
    },

    allergens: {
      type: [String],
      default: [],
      validate: {
        validator(values) {
          return Array.isArray(values) && values.every((value) => ALLERGENS.includes(value));
        },
        message: `Allergens must be drawn from: ${ALLERGENS.join(', ')}`,
      },
    },

    vegetarian: {
      type: Boolean,
      default: false,
    },

    calories: {
      type: Number,
      min: [0, 'Calories cannot be negative'],
      max: [5000, 'Calories per serving looks wrong above 5000'],
      default: null,
    },

    price: {
      type: Number,
      required: [true, 'Price is required'],
      min: [0, 'Price cannot be negative'],
    },

    currency: {
      type: String,
      default: 'INR',
      uppercase: true,
      trim: true,
    },

    cycle: {
      type: String,
      enum: {
        values: PLAN_CYCLES,
        message: 'Invalid billing cycle',
      },
      default: 'monthly',
    },

    validFrom: {
      type: Date,
      required: [true, 'validFrom is required'],
    },

    validTo: {
      type: Date,
      required: [true, 'validTo is required'],
      validate: {
        validator(value) {
          return !this.validFrom || value > this.validFrom;
        },
        message: 'validTo must be after validFrom',
      },
    },

    // What the kitchen can actually cook. 0 means uncapped.
    capacity: {
      type: Number,
      default: 0,
      min: [0, 'Capacity cannot be negative'],
    },

    // Server-owned counter. Kept alongside `capacity` so the subscription guard
    // fits inside the filter of a single conditional update.
    subscriberCount: {
      type: Number,
      default: 0,
      min: [0, 'Subscriber count cannot be negative'],
    },

    status: {
      type: String,
      enum: {
        values: PLAN_STATUSES,
        message: 'Invalid plan status',
      },
      default: 'draft',
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'The staff member publishing the plan is required'],
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

mealPlanSchema.index({ status: 1, validFrom: 1, validTo: 1 });
mealPlanSchema.index({ name: 1, validFrom: 1 }, { unique: true });

/**
 * Seats left, or null when the plan is uncapped. Null rather than Infinity so
 * the client can render "unlimited" instead of a number it has to special-case.
 */
mealPlanSchema.virtual('seatsLeft').get(function () {
  if (!this.capacity) return null;
  return Math.max(0, this.capacity - this.subscriberCount);
});

mealPlanSchema.virtual('isActive').get(function () {
  const now = Date.now();
  return (
    this.status === 'active' &&
    this.validFrom.getTime() <= now &&
    this.validTo.getTime() >= now
  );
});

/**
 * Why a plan cannot be subscribed to right now, or null when it can be.
 *
 * Returning the reason rather than a boolean is what lets the counter tell a
 * parent "that plan closed on the 3rd" instead of "unavailable".
 */
mealPlanSchema.methods.subscriptionError = function () {
  if (this.status === 'retired') return 'This plan has been retired.';
  if (this.status === 'draft') return 'This plan has not been published yet.';
  if (this.status === 'paused') return 'This plan is paused.';

  const now = Date.now();
  if (this.validFrom.getTime() > now) {
    return `This plan opens on ${this.validFrom.toISOString().slice(0, 10)}.`;
  }
  if (this.validTo.getTime() < now) {
    return `This plan closed on ${this.validTo.toISOString().slice(0, 10)}.`;
  }
  if (this.capacity && this.subscriberCount >= this.capacity) {
    return 'This plan is full.';
  }
  return null;
};

/**
 * The allergens this plan contains that the student has declared.
 *
 * Returns the intersection rather than a boolean so the refusal can name what
 * it found — "contains nuts" is actionable, "not suitable" is not.
 */
mealPlanSchema.methods.allergenConflicts = function (dietaryFlags = []) {
  if (!Array.isArray(dietaryFlags) || dietaryFlags.length === 0) return [];
  return this.allergens.filter((allergen) => dietaryFlags.includes(allergen));
};

/**
 * Whether the plan serves on a given date. `getDay()` is 0-indexed from Sunday
 * and SERVING_DAYS starts at Monday, hence the shift.
 */
mealPlanSchema.methods.servesOn = function (date = new Date()) {
  const index = (new Date(date).getDay() + 6) % 7;
  return this.servingDays.includes(SERVING_DAYS[index]);
};

mealPlanSchema.statics.MEAL_TYPES = MEAL_TYPES;
mealPlanSchema.statics.ALLERGENS = ALLERGENS;
mealPlanSchema.statics.SERVING_DAYS = SERVING_DAYS;
mealPlanSchema.statics.PLAN_CYCLES = PLAN_CYCLES;
mealPlanSchema.statics.PLAN_STATUSES = PLAN_STATUSES;

module.exports = mongoose.model('MealPlan', mealPlanSchema);
