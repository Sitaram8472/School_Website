const mongoose = require('mongoose');

/**
 * A fundraising campaign.
 *
 * The campaign holds no totals. Its progress is an aggregation over the
 * pledges, computed per request — see `pledgeProgress` in the controller. A
 * stored counter is a number that drifts the first time anything is cancelled
 * or waived, and it drifts silently, which is how the thermometer in reception
 * ends up showing money the school does not have.
 *
 * What the campaign does hold is `receiptSequence`, which is incremented with
 * `findOneAndUpdate` and `$inc`. That is atomic under concurrency in a way
 * `count() + 1` is not, and it is why there cannot be two receipt number 47s
 * the way there are with two paper books.
 */

const CATEGORIES = [
  'infrastructure',
  'scholarship',
  'library',
  'sports',
  'technology',
  'transport',
  'emergency-relief',
  'general',
];

const STATUSES = ['draft', 'active', 'paused', 'closed', 'cancelled'];

// A campaign in one of these accepts new pledges.
const OPEN_STATUSES = ['active'];

const VISIBILITIES = ['public', 'internal'];

const historySchema = new mongoose.Schema(
  {
    action: { type: String, required: true, trim: true, maxlength: [40, 'Too long'] },
    from: { type: String, trim: true, maxlength: [80, 'Too long'] },
    to: { type: String, trim: true, maxlength: [80, 'Too long'] },
    note: { type: String, trim: true, maxlength: [500, 'Too long'] },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
  },
  { _id: true, timestamps: false }
);

const campaignSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'A campaign needs a title'],
      trim: true,
      minlength: [4, 'Title must be at least 4 characters'],
      maxlength: [150, 'Title cannot exceed 150 characters'],
    },
    slug: {
      type: String,
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: [80, 'Slug cannot exceed 80 characters'],
    },
    purpose: {
      type: String,
      required: [true, 'Say what the money is for'],
      trim: true,
      minlength: [20, 'Please describe the purpose in a little more detail'],
      maxlength: [3000, 'Purpose cannot exceed 3000 characters'],
    },
    category: {
      type: String,
      required: [true, 'A category is required'],
      enum: { values: CATEGORIES, message: 'Invalid category' },
    },

    goalAmount: {
      type: Number,
      required: [true, 'A goal is required'],
      min: [1, 'A goal must be more than zero'],
    },
    currency: {
      type: String,
      default: 'INR',
      trim: true,
      uppercase: true,
      maxlength: [3, 'Use a three-letter currency code'],
    },

    startsOn: { type: Date, required: [true, 'A start date is required'] },
    endsOn: { type: Date },

    status: {
      type: String,
      enum: { values: STATUSES, message: 'Invalid status' },
      default: 'draft',
    },
    visibility: {
      type: String,
      enum: { values: VISIBILITIES, message: 'Invalid visibility' },
      default: 'public',
    },

    receiptPrefix: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: [10, 'A receipt prefix cannot exceed 10 characters'],
      match: [/^[A-Z0-9]*$/, 'Use letters and digits only'],
    },
    // Never written directly. `Campaign.nextReceiptSerial` is the only path.
    receiptSequence: {
      type: Number,
      default: 0,
      min: [0, 'A receipt sequence cannot be negative'],
    },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

campaignSchema.index({ status: 1, startsOn: -1 });
campaignSchema.index({ category: 1 });

/** A url-safe slug from a title. */
function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

campaignSchema.pre('validate', function derive() {
  if (!this.slug && this.title) {
    this.slug = slugify(this.title);
  }
  if (!this.receiptPrefix && this.category) {
    this.receiptPrefix = this.category.replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase();
  }
  if (this.startsOn && this.endsOn && this.endsOn < this.startsOn) {
    this.invalidate('endsOn', 'A campaign cannot close before it opens');
  }
});

campaignSchema.methods.isOpen = function isOpen(now = new Date()) {
  if (!OPEN_STATUSES.includes(this.status)) return false;
  if (this.startsOn && now < this.startsOn) return false;
  if (this.endsOn && now > this.endsOn) return false;
  return true;
};

/** Why a pledge cannot be made against this campaign, or null when it can. */
campaignSchema.methods.pledgeBlockedReason = function pledgeBlockedReason(now = new Date()) {
  if (this.status === 'draft') return 'This appeal has not opened yet';
  if (this.status === 'paused') return 'This appeal is paused';
  if (this.status === 'closed') return 'This appeal has closed';
  if (this.status === 'cancelled') return 'This appeal was cancelled';
  if (this.startsOn && now < this.startsOn) {
    return `This appeal opens on ${this.startsOn.toISOString().slice(0, 10)}`;
  }
  if (this.endsOn && now > this.endsOn) {
    return `This appeal closed on ${this.endsOn.toISOString().slice(0, 10)}`;
  }
  return null;
};

campaignSchema.methods.recordHistory = function recordHistory(entry) {
  this.history.push({
    action: entry.action,
    from: entry.from === undefined || entry.from === null ? undefined : String(entry.from),
    to: entry.to === undefined || entry.to === null ? undefined : String(entry.to),
    note: entry.note,
    by: entry.by,
    at: new Date(),
  });
};

campaignSchema.methods.toRow = function toRow(progress = null, now = new Date()) {
  return {
    _id: this._id,
    title: this.title,
    slug: this.slug,
    purpose: this.purpose,
    category: this.category,
    goalAmount: this.goalAmount,
    currency: this.currency,
    startsOn: this.startsOn,
    endsOn: this.endsOn,
    status: this.status,
    visibility: this.visibility,
    isOpen: this.isOpen(now),
    blockedReason: this.pledgeBlockedReason(now),
    receiptPrefix: this.receiptPrefix,
    // Always both figures, never one. Showing only the pledged total is how a
    // school plans against money that has not arrived.
    progress: progress || {
      amountPledged: 0,
      amountReceived: 0,
      amountOutstanding: 0,
      pledgeCount: 0,
      donorCount: 0,
      receivedPercent: 0,
      pledgedPercent: 0,
    },
    createdAt: this.createdAt,
  };
};

/**
 * The next receipt serial for `campaignId`, e.g. `LIBRAR/2026-27/000041`.
 *
 * `$inc` inside `findOneAndUpdate` is a single atomic operation on the server,
 * so two payments recorded at the same instant get different numbers. Reading
 * a count and adding one does not have that property, and the failure produces
 * two receipts bearing the same number — which is a problem for the school
 * rather than for the donor claiming relief on it.
 */
campaignSchema.statics.nextReceiptSerial = async function nextReceiptSerial(
  campaignId,
  financialYear
) {
  const updated = await this.findOneAndUpdate(
    { _id: campaignId },
    { $inc: { receiptSequence: 1 } },
    { new: true }
  );
  if (!updated) return null;

  const prefix = updated.receiptPrefix || 'GIFT';
  return `${prefix}/${financialYear}/${String(updated.receiptSequence).padStart(6, '0')}`;
};

campaignSchema.statics.CATEGORIES = CATEGORIES;
campaignSchema.statics.STATUSES = STATUSES;
campaignSchema.statics.OPEN_STATUSES = OPEN_STATUSES;
campaignSchema.statics.VISIBILITIES = VISIBILITIES;
campaignSchema.statics.slugify = slugify;

module.exports = mongoose.model('Campaign', campaignSchema);
