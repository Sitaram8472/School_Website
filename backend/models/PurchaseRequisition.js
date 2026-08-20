const mongoose = require('mongoose');

/**
 * Procurement — budget lines, requisitions, quotes, orders and receipts.
 *
 * Three schemas in one file, because the invariant that matters spans all
 * three: **an approval takes the money out of the available balance
 * immediately, and every path out of the requisition puts it back exactly
 * once.**
 *
 * `available` is a virtual — `allocated − committed − spent` — and never a
 * stored figure, because the whole reason a school overspends is that the
 * middle term does not exist anywhere. `committed` is moved only by the
 * requisition lifecycle, and `encumbrance.state` is a four-state machine so a
 * rejection, a cancellation or a receipt can each be retried without releasing
 * the same money twice.
 *
 * Serials come off `ProcurementCounter` with `$inc`, so two people ordering on
 * the same morning get 012 and 013 rather than 012 twice — which is exactly what
 * the handwritten register cannot promise.
 */

const REQUISITION_STATUSES = [
  'draft',
  'submitted',
  'quoting',
  'approved',
  'ordered',
  'partially-received',
  'received',
  'closed',
  'rejected',
  'cancelled',
];

// Statuses in which the raiser may still change what they asked for. Once the
// money is committed the items are frozen, or the encumbrance stops describing
// what was approved.
const EDITABLE_STATUSES = ['draft'];

// Statuses that are holding budget.
const ENCUMBERED_STATUSES = ['approved', 'ordered', 'partially-received', 'received'];

const ENCUMBRANCE_STATES = ['none', 'held', 'released', 'converted'];

const UNITS = ['each', 'box', 'pack', 'ream', 'kg', 'litre', 'metre', 'set', 'service'];

const FY_PATTERN = /^\d{4}-\d{2}$/;

// Above this, the school's own rule asks for three quotations. Below it, one is
// enough — a ream of paper does not need a tender.
const THREE_QUOTE_THRESHOLD = 25000;
const MIN_QUOTES_ABOVE_THRESHOLD = 3;

// Choosing other than the lowest quote is often right. Saying why is the part
// that makes it distinguishable from not having looked.
const MIN_JUSTIFICATION_LENGTH = 15;

const MAX_ITEMS = 60;

/** Money is whole rupees, rounded once. */
function money(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value);
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
// Serial counter
// ---------------------------------------------------------------------------

const procurementCounterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: Number, default: 0 },
});

/**
 * The next number in a sequence, atomically.
 *
 * `count + 1` is the version of this that hands two people the same purchase
 * order number, which is the failure the register in the office already has.
 */
procurementCounterSchema.statics.next = async function next(key) {
  const counter = await this.findOneAndUpdate(
    { key },
    { $inc: { value: 1 } },
    { new: true, upsert: true }
  );
  return counter.value;
};

// ---------------------------------------------------------------------------
// Budget line
// ---------------------------------------------------------------------------

const budgetLineSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, 'A budget code is required'],
      trim: true,
      uppercase: true,
      maxlength: [20, 'Budget codes are short'],
    },

    financialYear: {
      type: String,
      required: true,
      trim: true,
      match: [FY_PATTERN, 'Financial year must look like 2026-27'],
    },

    department: { type: String, required: true, trim: true, maxlength: 60 },
    title: { type: String, required: true, trim: true, maxlength: 120 },

    allocated: {
      type: Number,
      required: true,
      min: [0, 'An allocation cannot be negative'],
    },

    // Both are moved only by the requisition lifecycle.
    committed: { type: Number, default: 0, min: 0 },
    spent: { type: Number, default: 0, min: 0 },

    isActive: { type: Boolean, default: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

budgetLineSchema.index({ code: 1, financialYear: 1 }, { unique: true });

budgetLineSchema.virtual('available').get(function available() {
  return money(this.allocated - this.committed - this.spent);
});

budgetLineSchema.virtual('utilisation').get(function utilisation() {
  if (!this.allocated) return 0;
  return Math.round(((this.committed + this.spent) / this.allocated) * 100);
});

budgetLineSchema.methods.recordHistory = function recordHistory(action, by, note) {
  this.history.push({ action, by, note, at: new Date() });
  if (this.history.length > 200) this.history = this.history.slice(-200);
  return this;
};

budgetLineSchema.set('toJSON', { virtuals: true });
budgetLineSchema.set('toObject', { virtuals: true });

// ---------------------------------------------------------------------------
// Requisition
// ---------------------------------------------------------------------------

const itemSchema = new mongoose.Schema(
  {
    description: { type: String, required: true, trim: true, maxlength: 160 },
    quantity: {
      type: Number,
      required: true,
      min: [1, 'Order at least one'],
      max: [100000, 'That is a quantity with an extra zero'],
    },
    unit: { type: String, enum: UNITS, default: 'each' },
    estimatedUnitCost: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const quoteSchema = new mongoose.Schema({
  vendorName: { type: String, required: true, trim: true, maxlength: 120 },
  vendorContact: { type: String, trim: true, maxlength: 120 },
  amount: { type: Number, required: true, min: 0 },
  receivedOn: { type: Date, default: Date.now },
  validUntil: Date,
  note: { type: String, trim: true, maxlength: 300 },
  isSelected: { type: Boolean, default: false },
});

const receiptLineSchema = new mongoose.Schema(
  {
    itemIndex: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const receiptSchema = new mongoose.Schema({
  receivedOn: { type: Date, default: Date.now },
  receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lines: { type: [receiptLineSchema], default: [] },
  note: { type: String, trim: true, maxlength: 300 },
});

const purchaseRequisitionSchema = new mongoose.Schema(
  {
    ref: { type: String, unique: true, sparse: true },

    raisedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    department: { type: String, required: true, trim: true, maxlength: 60 },

    budgetLine: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BudgetLine',
      required: true,
      index: true,
    },

    justification: {
      type: String,
      required: [true, 'Say what this is for'],
      trim: true,
      minlength: [10, 'A justification of three words is not a justification'],
      maxlength: 800,
    },

    neededBy: Date,

    items: {
      type: [itemSchema],
      validate: {
        validator: (list) => list.length > 0 && list.length <= MAX_ITEMS,
        message: 'A requisition needs between one and 60 lines',
      },
    },

    status: { type: String, enum: REQUISITION_STATUSES, default: 'draft', index: true },

    quotes: { type: [quoteSchema], default: [] },
    selectionJustification: { type: String, trim: true, maxlength: 500 },

    poNumber: { type: String, default: null },
    orderedAt: Date,

    receipts: { type: [receiptSchema], default: [] },

    encumbrance: {
      amount: { type: Number, default: 0, min: 0 },
      state: { type: String, enum: ENCUMBRANCE_STATES, default: 'none' },
      heldAt: Date,
      settledAt: Date,
    },

    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    decisionNote: { type: String, trim: true, maxlength: 500 },
    closedAt: Date,
    invoicedAmount: { type: Number, default: null, min: 0 },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

purchaseRequisitionSchema.index({ status: 1, createdAt: -1 });

purchaseRequisitionSchema.virtual('estimatedValue').get(function estimatedValue() {
  return money(
    this.items.reduce((sum, item) => sum + item.quantity * item.estimatedUnitCost, 0)
  );
});

purchaseRequisitionSchema.virtual('needsThreeQuotes').get(function needsThreeQuotes() {
  return this.estimatedValue >= THREE_QUOTE_THRESHOLD;
});

purchaseRequisitionSchema.virtual('selectedQuote').get(function selectedQuote() {
  return this.quotes.find((quote) => quote.isSelected) || null;
});

purchaseRequisitionSchema.virtual('lowestQuote').get(function lowestQuote() {
  if (!this.quotes.length) return null;
  return this.quotes.reduce((lowest, quote) => (quote.amount < lowest.amount ? quote : lowest));
});

purchaseRequisitionSchema.methods.isEditable = function isEditable() {
  return EDITABLE_STATUSES.includes(this.status);
};

purchaseRequisitionSchema.methods.isEncumbered = function isEncumbered() {
  return this.encumbrance.state === 'held';
};

purchaseRequisitionSchema.methods.isOwnedBy = function isOwnedBy(user) {
  return Boolean(user) && String(this.raisedBy) === String(user._id);
};

purchaseRequisitionSchema.methods.recordHistory = function recordHistory(action, by, note) {
  this.history.push({ action, by, note, at: new Date() });
  if (this.history.length > 200) this.history = this.history.slice(-200);
  return this;
};

/**
 * Why this requisition cannot be approved yet, in a sentence somebody can act
 * on — the three-quote rule names how many are on file, and the lowest-quote
 * rule names both amounts and the difference.
 */
purchaseRequisitionSchema.methods.approvalBlocker = function approvalBlocker() {
  if (!this.quotes.length) return 'No quotations have been recorded';

  if (this.needsThreeQuotes && this.quotes.length < MIN_QUOTES_ABOVE_THRESHOLD) {
    return `Purchases over ${THREE_QUOTE_THRESHOLD} need ${MIN_QUOTES_ABOVE_THRESHOLD} quotations; ${this.quotes.length} on file`;
  }

  const selected = this.selectedQuote;
  if (!selected) return 'No quotation has been selected';

  const lowest = this.lowestQuote;
  if (selected.amount > lowest.amount) {
    const justification = (this.selectionJustification || '').trim();
    if (justification.length < MIN_JUSTIFICATION_LENGTH) {
      return `${selected.vendorName} at ${selected.amount} is ${selected.amount - lowest.amount} above ${lowest.vendorName} at ${lowest.amount}; record why before approving`;
    }
  }

  return null;
};

/** How much of each line has arrived, across every receipt. */
purchaseRequisitionSchema.methods.receivedByItem = function receivedByItem() {
  const totals = this.items.map(() => 0);
  this.receipts.forEach((receipt) => {
    receipt.lines.forEach((line) => {
      if (line.itemIndex >= 0 && line.itemIndex < totals.length) {
        totals[line.itemIndex] += line.quantity;
      }
    });
  });
  return totals;
};

purchaseRequisitionSchema.methods.outstandingByItem = function outstandingByItem() {
  const received = this.receivedByItem();
  return this.items.map((item, index) => ({
    itemIndex: index,
    description: item.description,
    ordered: item.quantity,
    received: received[index],
    outstanding: Math.max(0, item.quantity - received[index]),
  }));
};

purchaseRequisitionSchema.methods.isFullyReceived = function isFullyReceived() {
  return this.outstandingByItem().every((line) => line.outstanding === 0);
};

/**
 * Whether a receipt would take any line past what was ordered.
 *
 * A short delivery is first-class — it leaves the requisition partially
 * received with the outstanding lines listed. An over-delivery is refused, and
 * the refusal names the item and both figures, because "invalid quantity" tells
 * the storekeeper nothing.
 */
purchaseRequisitionSchema.methods.overReceiptError = function overReceiptError(lines) {
  const received = this.receivedByItem();

  for (const line of lines) {
    const item = this.items[line.itemIndex];
    if (!item) return `There is no line ${line.itemIndex + 1} on this order`;

    const already = received[line.itemIndex];
    const outstanding = item.quantity - already;
    if (line.quantity > outstanding) {
      return `${item.description}: ${already} of ${item.quantity} already received, so ${line.quantity} more is ${line.quantity - outstanding} over`;
    }
  }

  return null;
};

purchaseRequisitionSchema.set('toJSON', { virtuals: true });
purchaseRequisitionSchema.set('toObject', { virtuals: true });

const ProcurementCounter = mongoose.model('ProcurementCounter', procurementCounterSchema);
const BudgetLine = mongoose.model('BudgetLine', budgetLineSchema);
const PurchaseRequisition = mongoose.model('PurchaseRequisition', purchaseRequisitionSchema);

module.exports = {
  ProcurementCounter,
  BudgetLine,
  PurchaseRequisition,
  REQUISITION_STATUSES,
  ENCUMBERED_STATUSES,
  ENCUMBRANCE_STATES,
  UNITS,
  THREE_QUOTE_THRESHOLD,
  MIN_QUOTES_ABOVE_THRESHOLD,
  MIN_JUSTIFICATION_LENGTH,
  money,
};
