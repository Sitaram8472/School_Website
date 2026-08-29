const mongoose = require('mongoose');
const MealPlan = require('./MealPlan');

/**
 * A student's prepaid canteen account.
 *
 * This is deliberately not a `FeeInvoice`. An invoice is a fixed amount settled
 * once; a canteen balance is decremented many times a day in small amounts and
 * topped back up. Modelling one as the other means half the fields on the
 * shared schema mean something different depending on a mode flag.
 *
 * The ledger is append-only and every entry carries the balance it produced, so
 * the account can be audited by reading one row rather than replaying the sum
 * of every entry before it.
 */

const LEDGER_TYPES = ['topup', 'charge', 'refund', 'reversal', 'adjustment'];
const ACCOUNT_STATUSES = ['active', 'suspended', 'closed'];
const TOPUP_METHODS = ['cash', 'upi', 'card', 'bank-transfer', 'cheque', 'online'];

const ledgerEntrySchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: {
        values: LEDGER_TYPES,
        message: 'Invalid ledger entry type',
      },
      required: [true, 'Ledger entry type is required'],
    },

    // Always positive. The sign lives in `type`, because an amount that can be
    // negative means every report has to remember which convention it is under.
    amount: {
      type: Number,
      required: [true, 'Ledger entry amount is required'],
      min: [1, 'Ledger entry amount must be greater than zero'],
    },

    // The balance immediately after this entry was applied. Written by the
    // update pipeline that moves the balance, so it cannot disagree with it.
    balanceAfter: {
      type: Number,
      required: [true, 'balanceAfter is required'],
      min: [0, 'balanceAfter cannot be negative'],
    },

    description: {
      type: String,
      required: [true, 'A description is required on every ledger entry'],
      trim: true,
      maxlength: [200, 'Description cannot exceed 200 characters'],
    },

    mealPlan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MealPlan',
      default: null,
    },

    mealPlanName: {
      type: String,
      trim: true,
      maxlength: [80, 'Meal plan name cannot exceed 80 characters'],
      default: '',
    },

    method: {
      type: String,
      enum: {
        values: TOPUP_METHODS,
        message: 'Invalid payment method',
      },
      default: null,
    },

    /**
     * Client-supplied de-duplication key.
     *
     * The counter tablet runs on school wifi. A request that times out after the
     * server committed it gets retried by a human pressing the button again, and
     * without this the student pays twice for one sandwich.
     */
    idempotencyKey: {
      type: String,
      trim: true,
      maxlength: [100, 'Idempotency key cannot exceed 100 characters'],
      default: null,
    },

    reference: {
      type: String,
      trim: true,
      maxlength: [100, 'Reference cannot exceed 100 characters'],
      default: '',
    },

    // For refunds and reversals: the ledger entry being undone.
    relatedEntry: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'The staff member recording the entry is required'],
    },

    recordedByName: {
      type: String,
      trim: true,
      maxlength: [100, 'Recorder name cannot exceed 100 characters'],
      default: '',
    },

    occurredAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const subscriptionSchema = new mongoose.Schema(
  {
    mealPlan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MealPlan',
      required: [true, 'Meal plan is required'],
    },

    planName: {
      type: String,
      trim: true,
      maxlength: [80, 'Plan name cannot exceed 80 characters'],
      default: '',
    },

    startsOn: {
      type: Date,
      required: [true, 'Subscription start date is required'],
    },

    endsOn: {
      type: Date,
      required: [true, 'Subscription end date is required'],
    },

    pricePaid: {
      type: Number,
      required: [true, 'Price paid is required'],
      min: [0, 'Price paid cannot be negative'],
    },

    status: {
      type: String,
      enum: {
        values: ['active', 'expired', 'cancelled'],
        message: 'Invalid subscription status',
      },
      default: 'active',
    },

    subscribedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const canteenAccountSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Student is required'],
      unique: true,
    },

    studentName: {
      type: String,
      trim: true,
      maxlength: [100, 'Student name cannot exceed 100 characters'],
      default: '',
    },

    className: {
      type: String,
      trim: true,
      maxlength: [50, 'Class name cannot exceed 50 characters'],
      default: '',
    },

    balance: {
      type: Number,
      default: 0,
      min: [0, 'Balance cannot be negative'],
    },

    lifetimeTopUp: {
      type: Number,
      default: 0,
      min: [0, 'Lifetime top-up cannot be negative'],
    },

    lifetimeSpend: {
      type: Number,
      default: 0,
      min: [0, 'Lifetime spend cannot be negative'],
    },

    currency: {
      type: String,
      default: 'INR',
      uppercase: true,
      trim: true,
    },

    // Parent-set cap. 0 means no cap.
    dailySpendLimit: {
      type: Number,
      default: 0,
      min: [0, 'Daily spend limit cannot be negative'],
    },

    lowBalanceThreshold: {
      type: Number,
      default: 100,
      min: [0, 'Low balance threshold cannot be negative'],
    },

    /**
     * The student's declared allergens, from the same closed vocabulary the
     * plans use. The counter refuses a sale whose plan intersects this list.
     */
    dietaryFlags: {
      type: [String],
      default: [],
      validate: {
        validator(values) {
          return (
            Array.isArray(values) &&
            values.every((value) => MealPlan.ALLERGENS.includes(value))
          );
        },
        message: `Dietary flags must be drawn from: ${MealPlan.ALLERGENS.join(', ')}`,
      },
    },

    dietaryNotes: {
      type: String,
      trim: true,
      maxlength: [300, 'Dietary notes cannot exceed 300 characters'],
      default: '',
    },

    subscriptions: {
      type: [subscriptionSchema],
      default: [],
    },

    ledger: {
      type: [ledgerEntrySchema],
      default: [],
    },

    status: {
      type: String,
      enum: {
        values: ACCOUNT_STATUSES,
        message: 'Invalid account status',
      },
      default: 'active',
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

canteenAccountSchema.index({ status: 1, className: 1 });
canteenAccountSchema.index({ 'ledger.idempotencyKey': 1 }, { sparse: true });
canteenAccountSchema.index({ 'ledger.occurredAt': -1 });

canteenAccountSchema.virtual('isLow').get(function () {
  return this.balance <= this.lowBalanceThreshold;
});

/**
 * Total charged today, used for the daily-limit pre-check.
 *
 * Refunds are subtracted so a mistaken charge that was reversed does not eat
 * into the day's allowance — the student never actually spent it.
 */
canteenAccountSchema.methods.spentOn = function (date = new Date()) {
  const day = new Date(date);
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  return this.ledger.reduce((total, entry) => {
    const at = entry.occurredAt ? entry.occurredAt.getTime() : 0;
    if (at < start.getTime() || at >= end.getTime()) return total;
    if (entry.type === 'charge') return total + entry.amount;
    if (entry.type === 'refund' || entry.type === 'reversal') return total - entry.amount;
    return total;
  }, 0);
};

/**
 * What is left of today's allowance, or null when no cap is set.
 */
canteenAccountSchema.methods.remainingToday = function (date = new Date()) {
  if (!this.dailySpendLimit) return null;
  return Math.max(0, this.dailySpendLimit - this.spentOn(date));
};

canteenAccountSchema.methods.findEntryByKey = function (idempotencyKey) {
  if (!idempotencyKey) return null;
  return this.ledger.find((entry) => entry.idempotencyKey === idempotencyKey) || null;
};

canteenAccountSchema.methods.activeSubscriptionFor = function (mealPlanId) {
  const now = Date.now();
  return (
    this.subscriptions.find(
      (subscription) =>
        String(subscription.mealPlan) === String(mealPlanId) &&
        subscription.status === 'active' &&
        subscription.endsOn.getTime() >= now
    ) || null
  );
};

/**
 * Why this account cannot be charged, or null when it can be.
 */
canteenAccountSchema.methods.chargeError = function (amount) {
  if (this.status === 'closed') return 'This account is closed.';
  if (this.status === 'suspended') return 'This account is suspended.';
  if (this.balance < amount) {
    return `Insufficient balance. The account holds ${this.balance} and the charge is ${amount}.`;
  }
  return null;
};

/**
 * The student-facing shape. The ledger is trimmed to the most recent entries
 * because the full history of a three-year account is not something a phone
 * needs to download to show a balance.
 */
canteenAccountSchema.methods.summaryFor = function (limit = 40) {
  const recent = [...this.ledger]
    .sort((a, b) => b.occurredAt - a.occurredAt)
    .slice(0, limit);

  return {
    _id: this._id,
    student: this.student,
    studentName: this.studentName,
    className: this.className,
    balance: this.balance,
    currency: this.currency,
    lifetimeTopUp: this.lifetimeTopUp,
    lifetimeSpend: this.lifetimeSpend,
    dailySpendLimit: this.dailySpendLimit,
    remainingToday: this.remainingToday(),
    lowBalanceThreshold: this.lowBalanceThreshold,
    isLow: this.balance <= this.lowBalanceThreshold,
    dietaryFlags: this.dietaryFlags,
    dietaryNotes: this.dietaryNotes,
    status: this.status,
    subscriptions: this.subscriptions,
    ledger: recent,
    ledgerCount: this.ledger.length,
    updatedAt: this.updatedAt,
  };
};

canteenAccountSchema.statics.LEDGER_TYPES = LEDGER_TYPES;
canteenAccountSchema.statics.ACCOUNT_STATUSES = ACCOUNT_STATUSES;
canteenAccountSchema.statics.TOPUP_METHODS = TOPUP_METHODS;

module.exports = mongoose.model('CanteenAccount', canteenAccountSchema);
