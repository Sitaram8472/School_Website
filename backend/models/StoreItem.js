const mongoose = require('mongoose');

/**
 * Things the school store sells: textbooks, workbooks, uniform, PE kit,
 * stationery.
 *
 * Two counters per variant, not one:
 *
 *   stock     what is physically on the shelf, reserved units included
 *   reserved  what is spoken for but has not been handed over yet
 *
 * available = stock - reserved, and it is a virtual — storing it would give
 * three numbers that can disagree. Keeping `reserved` separate from `stock` is
 * what makes the multi-line order safe: a reservation can always be released
 * unconditionally, so a half-applied order can be undone without a transaction.
 * If ordering decremented `stock` directly, undoing a failed order would mean
 * inventing stock, and any crash between the two writes would leave the shelf
 * count wrong in a way nobody could reconstruct.
 *
 * `stock` moves in exactly two places: a reason-coded adjustment, and
 * collection. Those are the only moments something physically enters or leaves
 * the room.
 */

const ITEM_CATEGORIES = [
  'textbook',
  'workbook',
  'uniform',
  'sportswear',
  'stationery',
  'other',
];

const ITEM_STATUSES = ['active', 'discontinued'];

const ADJUSTMENT_REASONS = ['receive', 'damage', 'loss', 'correction', 'return'];

const variantSchema = new mongoose.Schema(
  {
    // Unique within the item, not globally. The pair (item, variantSku) is what
    // an order line points at.
    variantSku: {
      type: String,
      required: [true, 'Each variant needs a code'],
      trim: true,
      uppercase: true,
      maxlength: [30, 'Variant code cannot exceed 30 characters'],
    },
    label: {
      type: String,
      required: [true, 'Each variant needs a label'],
      trim: true,
      maxlength: [60, 'Label cannot exceed 60 characters'],
    },
    size: {
      type: String,
      trim: true,
      maxlength: [20, 'Size cannot exceed 20 characters'],
      default: null,
    },
    stock: {
      type: Number,
      required: true,
      default: 0,
      min: [0, 'Stock cannot be negative'],
    },
    reserved: {
      type: Number,
      required: true,
      default: 0,
      min: [0, 'Reserved cannot be negative'],
    },
    reorderLevel: {
      type: Number,
      default: 5,
      min: [0, 'Reorder level cannot be negative'],
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  { _id: true }
);

const stockMovementSchema = new mongoose.Schema(
  {
    variantSku: { type: String, required: true, trim: true, uppercase: true },
    reason: { type: String, enum: ADJUSTMENT_REASONS, required: true },
    delta: { type: Number, required: true },
    resultingStock: { type: Number, required: true },
    note: {
      type: String,
      trim: true,
      maxlength: [300, 'Note cannot exceed 300 characters'],
      default: null,
    },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    actorName: { type: String, trim: true },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const storeItemSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [140, 'Name cannot exceed 140 characters'],
    },
    sku: {
      type: String,
      required: [true, 'A code is required'],
      trim: true,
      uppercase: true,
      unique: true,
      maxlength: [30, 'Code cannot exceed 30 characters'],
    },
    category: {
      type: String,
      enum: ITEM_CATEGORIES,
      default: 'other',
      index: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: [1000, 'Description cannot exceed 1000 characters'],
      default: null,
    },
    unitPrice: {
      type: Number,
      required: [true, 'A price is required'],
      min: [0, 'Price cannot be negative'],
      max: [1000000, 'That price looks wrong'],
    },
    // Which classes are expected to buy it. Empty means everybody.
    classesApplicable: {
      type: [String],
      default: [],
    },
    // A mandatory item is one a family has to buy; worth flagging so the store
    // page can lead with them at the start of term.
    mandatory: {
      type: Boolean,
      default: false,
    },
    supplier: {
      type: String,
      trim: true,
      maxlength: [120, 'Supplier cannot exceed 120 characters'],
      default: null,
    },
    status: {
      type: String,
      enum: ITEM_STATUSES,
      default: 'active',
      index: true,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [500, 'Notes cannot exceed 500 characters'],
      default: null,
    },
    variants: {
      type: [variantSchema],
      default: [],
    },
    // Append-only. An inventory whose numbers can change with no record is an
    // inventory nobody trusts, and "nobody trusts it" is how the second
    // spreadsheet gets started.
    movements: {
      type: [stockMovementSchema],
      default: [],
    },
  },
  { timestamps: true }
);

storeItemSchema.index({ status: 1, category: 1 });
storeItemSchema.index({ 'variants.variantSku': 1 });

/**
 * Written as an async function that throws rather than a callback-style hook:
 * Mongoose 9 skips the old form silently, which here would let an item be saved
 * with two variants sharing a code — and the atomic reservation matches on that
 * code.
 */
storeItemSchema.pre('validate', async function derive() {
  if (!Array.isArray(this.variants) || this.variants.length === 0) {
    this.invalidate('variants', 'An item needs at least one variant');
    return;
  }

  const seen = new Set();
  for (const variant of this.variants) {
    const code = String(variant.variantSku || '').toUpperCase();
    if (seen.has(code)) {
      this.invalidate('variants', `Variant code ${code} is used twice on this item`);
      return;
    }
    seen.add(code);

    if (variant.reserved > variant.stock) {
      this.invalidate(
        'variants',
        `${code} has more reserved than it has in stock, which cannot be true`
      );
      return;
    }
  }
});

storeItemSchema.virtual('totalStock').get(function totalStock() {
  return this.variants.reduce((sum, variant) => sum + variant.stock, 0);
});

storeItemSchema.virtual('totalAvailable').get(function totalAvailable() {
  return this.variants.reduce(
    (sum, variant) => sum + Math.max(0, variant.stock - variant.reserved),
    0
  );
});

storeItemSchema.virtual('lowStockVariants').get(function lowStockVariants() {
  return this.variants
    .filter(
      (variant) => variant.active && variant.stock - variant.reserved <= variant.reorderLevel
    )
    .map((variant) => variant.variantSku);
});

storeItemSchema.methods.findVariant = function findVariant(variantSku) {
  const wanted = String(variantSku || '').toUpperCase();
  return this.variants.find((variant) => variant.variantSku === wanted) || null;
};

storeItemSchema.methods.availableOf = function availableOf(variantSku) {
  const variant = this.findVariant(variantSku);
  if (!variant) return 0;
  return Math.max(0, variant.stock - variant.reserved);
};

/**
 * Why a quantity of a variant cannot be ordered right now, in words. The
 * conditional update in the controller is the authority — this is the message
 * and the disabled button.
 */
storeItemSchema.methods.orderabilityError = function orderabilityError(variantSku, quantity) {
  if (this.status !== 'active') return `${this.name} is no longer sold.`;

  const variant = this.findVariant(variantSku);
  if (!variant) return 'That size is not one we stock.';
  if (!variant.active) return `${variant.label} is not currently sold.`;

  const available = Math.max(0, variant.stock - variant.reserved);
  if (available < quantity) {
    return available === 0
      ? `${this.name} (${variant.label}) is out of stock.`
      : `Only ${available} of ${this.name} (${variant.label}) left.`;
  }
  return null;
};

/**
 * The catalogue shape. `stock` and `reserved` are staff numbers — a family
 * needs to know whether they can have one, not how the storeroom is doing.
 */
storeItemSchema.methods.redactFor = function redactFor(viewer) {
  const plain = this.toObject({ virtuals: true });
  delete plain.__v;

  const isStaff = viewer && ['teacher', 'admin'].includes(viewer.role);
  if (isStaff) return plain;

  delete plain.movements;
  delete plain.supplier;
  plain.variants = (plain.variants || [])
    .filter((variant) => variant.active)
    .map((variant) => ({
      _id: variant._id,
      variantSku: variant.variantSku,
      label: variant.label,
      size: variant.size,
      available: Math.max(0, variant.stock - variant.reserved),
      inStock: variant.stock - variant.reserved > 0,
    }));
  return plain;
};

storeItemSchema.statics.ITEM_CATEGORIES = ITEM_CATEGORIES;
storeItemSchema.statics.ITEM_STATUSES = ITEM_STATUSES;
storeItemSchema.statics.ADJUSTMENT_REASONS = ADJUSTMENT_REASONS;

storeItemSchema.set('toObject', { virtuals: true });
storeItemSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('StoreItem', storeItemSchema);
