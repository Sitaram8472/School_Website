const mongoose = require('mongoose');

/**
 * An order against the school store.
 *
 * An order is a claim on stock, not a movement of it. While it is `reserved`
 * the units are still on the shelf and still counted in `StoreItem.stock`; they
 * are simply spoken for. Only collection moves them out — that is the moment
 * the item physically leaves the room, and it is the only place `stock` goes
 * down on the ordering path.
 *
 * Every line records the price it was taken at rather than reading it back off
 * the item. A price that changes next term should not silently rewrite what a
 * family agreed to pay in April.
 */

const ORDER_STATUSES = ['reserved', 'ready', 'collected', 'cancelled', 'expired'];

// An order in one of these states is holding stock.
const HOLDING_STATUSES = ['reserved', 'ready'];

const PAYMENT_STATUSES = ['pending', 'paid', 'waived', 'refunded'];

const orderLineSchema = new mongoose.Schema(
  {
    item: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'StoreItem',
      required: true,
    },
    itemName: { type: String, required: true, trim: true },
    itemSku: { type: String, required: true, trim: true, uppercase: true },
    variantSku: { type: String, required: true, trim: true, uppercase: true },
    variantLabel: { type: String, required: true, trim: true },
    unitPrice: {
      type: Number,
      required: true,
      min: [0, 'Unit price cannot be negative'],
    },
    quantity: {
      type: Number,
      required: true,
      min: [1, 'Order at least one'],
      max: [50, 'That quantity needs to go through the office'],
    },
    lineTotal: {
      type: Number,
      required: true,
      min: [0, 'Line total cannot be negative'],
    },
  },
  { _id: true }
);

const storeOrderSchema = new mongoose.Schema(
  {
    reference: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    orderedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    ordererName: { type: String, trim: true },
    studentName: {
      type: String,
      required: [true, 'Say who the order is for'],
      trim: true,
      maxlength: [80, 'Student name cannot exceed 80 characters'],
    },
    className: {
      type: String,
      trim: true,
      maxlength: [40, 'Class cannot exceed 40 characters'],
      default: null,
    },
    contactNumber: {
      type: String,
      trim: true,
      maxlength: [20, 'Contact number cannot exceed 20 characters'],
      default: null,
    },
    lines: {
      type: [orderLineSchema],
      default: [],
    },
    total: {
      type: Number,
      required: true,
      min: [0, 'Total cannot be negative'],
      default: 0,
    },
    status: {
      type: String,
      enum: ORDER_STATUSES,
      default: 'reserved',
      index: true,
    },
    paymentStatus: {
      type: String,
      enum: PAYMENT_STATUSES,
      default: 'pending',
    },
    // The hold expires here. An order somebody abandoned should not keep a
    // blazer out of circulation for the rest of term.
    reservedUntil: {
      type: Date,
      required: true,
      index: true,
    },
    readyAt: { type: Date, default: null },
    collectedAt: { type: Date, default: null },
    collectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    collectedByName: { type: String, trim: true, default: null },
    cancelReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Cancellation reason cannot exceed 300 characters'],
      default: null,
    },
    counterNote: {
      type: String,
      trim: true,
      maxlength: [300, 'Note cannot exceed 300 characters'],
      default: null,
    },
  },
  { timestamps: true }
);

storeOrderSchema.index({ status: 1, reservedUntil: 1 });
storeOrderSchema.index({ orderedBy: 1, status: 1 });

/**
 * Recomputes the total from the lines, so a client-supplied total is worth
 * nothing. Async-and-throw rather than callback style, because Mongoose 9 skips
 * the old form silently — and here that would leave the total whatever the
 * client sent.
 */
storeOrderSchema.pre('validate', async function derive() {
  if (!Array.isArray(this.lines) || this.lines.length === 0) {
    this.invalidate('lines', 'An order needs at least one line');
    return;
  }

  if (this.lines.length > 20) {
    this.invalidate('lines', 'An order cannot have more than 20 lines');
    return;
  }

  let total = 0;
  for (const line of this.lines) {
    line.lineTotal = line.unitPrice * line.quantity;
    total += line.lineTotal;
  }
  this.total = total;
});

storeOrderSchema.virtual('unitCount').get(function unitCount() {
  return this.lines.reduce((sum, line) => sum + line.quantity, 0);
});

storeOrderSchema.virtual('isHoldingStock').get(function isHoldingStock() {
  return HOLDING_STATUSES.includes(this.status);
});

storeOrderSchema.virtual('hasExpired').get(function hasExpired() {
  return (
    HOLDING_STATUSES.includes(this.status) &&
    this.reservedUntil &&
    this.reservedUntil.getTime() < Date.now()
  );
});

storeOrderSchema.methods.redactFor = function redactFor(viewer) {
  const plain = this.toObject({ virtuals: true });
  delete plain.__v;

  const isStaff = viewer && ['teacher', 'admin'].includes(viewer.role);
  if (isStaff) return plain;

  delete plain.counterNote;
  return plain;
};

storeOrderSchema.statics.ORDER_STATUSES = ORDER_STATUSES;
storeOrderSchema.statics.HOLDING_STATUSES = HOLDING_STATUSES;
storeOrderSchema.statics.PAYMENT_STATUSES = PAYMENT_STATUSES;

storeOrderSchema.set('toObject', { virtuals: true });
storeOrderSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('StoreOrder', storeOrderSchema);
