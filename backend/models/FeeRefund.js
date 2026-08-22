const mongoose = require('mongoose');

/**
 * Money going back out of the fee ledger.
 *
 * `FeeInvoice` already models money coming in and refuses to take more than is
 * owed. This is the mirror of that guard: the school can never give back more
 * than it actually took in, and the ceiling that enforces it is derived from
 * the refunds themselves rather than stored on the invoice where it would drift.
 *
 * A refund in `requested` or `approved` already *holds* part of that ceiling.
 * That is deliberate — two members of staff must not both be able to raise a
 * refund for the same eight thousand rupees while the first one is still
 * sitting in someone's approval queue.
 */

const REFUND_STATUSES = ['requested', 'approved', 'settled', 'rejected', 'cancelled'];

// Statuses that still hold part of the refundable ceiling. Rejection and
// cancellation release it; everything else keeps it spoken for.
const ENCUMBERING_STATUSES = ['requested', 'approved', 'settled'];

const REFUND_REASONS = [
  'overpayment',
  'duplicate-payment',
  'service-not-availed',
  'withdrawal',
  'billing-error',
  'scholarship-adjustment',
  'other',
];

const REFUND_METHODS = [
  'bank-transfer',
  'cheque',
  'upi',
  'cash',
  'credit-to-next-term',
];

const historyEntrySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: [40, 'History action cannot exceed 40 characters'],
    },
    by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    byName: {
      type: String,
      trim: true,
      maxlength: [100, 'History actor name cannot exceed 100 characters'],
      default: '',
    },
    at: {
      type: Date,
      default: Date.now,
    },
    note: {
      type: String,
      trim: true,
      maxlength: [300, 'History note cannot exceed 300 characters'],
      default: '',
    },
  },
  { _id: false }
);

const feeRefundSchema = new mongoose.Schema(
  {
    invoice: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FeeInvoice',
      required: [true, 'The invoice being refunded is required'],
    },

    // Denormalised the way FeeInvoice already denormalises the student, so a
    // refund queue renders without a join per row.
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Student is required'],
    },

    studentName: {
      type: String,
      trim: true,
      maxlength: [100, 'Student name cannot exceed 100 characters'],
      default: '',
    },

    invoiceNumber: {
      type: String,
      trim: true,
      maxlength: [50, 'Invoice number cannot exceed 50 characters'],
      default: '',
    },

    academicYear: {
      type: String,
      trim: true,
      default: '',
    },

    className: {
      type: String,
      trim: true,
      maxlength: [50, 'Class name cannot exceed 50 characters'],
      default: '',
    },

    amount: {
      type: Number,
      required: [true, 'Refund amount is required'],
      min: [1, 'Refund amount must be greater than zero'],
    },

    currency: {
      type: String,
      default: 'INR',
      uppercase: true,
      trim: true,
    },

    reason: {
      type: String,
      enum: {
        values: REFUND_REASONS,
        message: 'Invalid refund reason',
      },
      required: [true, 'Refund reason is required'],
    },

    // Free text. Required when the reason is `other`, because "other" with no
    // explanation is the row nobody can account for at audit.
    narrative: {
      type: String,
      trim: true,
      maxlength: [500, 'Narrative cannot exceed 500 characters'],
      default: '',
    },

    method: {
      type: String,
      enum: {
        values: REFUND_METHODS,
        message: 'Invalid refund method',
      },
      required: [true, 'Refund method is required'],
    },

    status: {
      type: String,
      enum: {
        values: REFUND_STATUSES,
        message: 'Invalid refund status',
      },
      default: 'requested',
    },

    // The idempotency key. A resubmitted request — the screen timed out and
    // staff pressed the button again — must not become a second refund.
    requestKey: {
      type: String,
      required: [true, 'A request key is required'],
      trim: true,
      maxlength: [80, 'Request key cannot exceed 80 characters'],
    },

    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'The staff member raising the refund is required'],
    },

    requestedAt: {
      type: Date,
      default: Date.now,
    },

    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    approvedAt: {
      type: Date,
      default: null,
    },

    approvalNote: {
      type: String,
      trim: true,
      maxlength: [300, 'Approval note cannot exceed 300 characters'],
      default: '',
    },

    rejectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    rejectedAt: {
      type: Date,
      default: null,
    },

    rejectionReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Rejection reason cannot exceed 300 characters'],
      default: '',
    },

    settledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    settledAt: {
      type: Date,
      default: null,
    },

    settlementReference: {
      type: String,
      trim: true,
      maxlength: [120, 'Settlement reference cannot exceed 120 characters'],
      default: '',
    },

    // Issued at settlement and never before. A number handed to a parent for
    // something that might still be rejected is worse than no number.
    creditNoteNumber: {
      type: String,
      trim: true,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    // Derived from `status`. It exists because a unique partial index cannot
    // express a negation — MongoDB rejects `$ne` inside a
    // partialFilterExpression — so the boolean is what the index filters on.
    isEncumbering: {
      type: Boolean,
      default: true,
    },

    history: {
      type: [historyEntrySchema],
      default: [],
    },
  },
  { timestamps: true }
);

// The idempotency guard. Unique at the database rather than checked in the
// controller, because the duplicate this exists to stop is two near-identical
// requests arriving milliseconds apart.
feeRefundSchema.index({ requestKey: 1 }, { unique: true });

// Credit-note numbers are only present on settled refunds, so the uniqueness
// has to be partial or every unsettled refund would collide on null.
feeRefundSchema.index(
  { creditNoteNumber: 1 },
  { unique: true, partialFilterExpression: { creditNoteNumber: { $type: 'string' } } }
);

// The ceiling query: every refund on one invoice that still holds headroom.
feeRefundSchema.index({ invoice: 1, isEncumbering: 1 });
feeRefundSchema.index({ status: 1, requestedAt: -1 });
feeRefundSchema.index({ student: 1, requestedAt: -1 });

/**
 * Keep `isEncumbering` in step with `status` on every write, and refuse the
 * edits that would make an already-decided refund a different refund.
 */
feeRefundSchema.pre('save', function () {
  this.isEncumbering = ENCUMBERING_STATUSES.includes(this.status);

  if (this.reason === 'other' && !this.narrative) {
    throw new Error('A narrative is required when the reason is "other"');
  }

  // Once a refund has left `requested`, the numbers on it are the numbers a
  // decision was taken against. Correcting them means raising a new refund.
  if (!this.isNew && this.status !== 'requested') {
    const frozen = ['amount', 'invoice', 'student', 'reason'];
    const edited = frozen.find((field) => this.isModified(field));

    if (edited) {
      throw new Error(
        `"${edited}" cannot be changed once the refund has left the requested state`
      );
    }
  }

  if (this.approvedBy && this.requestedBy && this.approvedBy.equals(this.requestedBy)) {
    throw new Error('A refund cannot be approved by the person who requested it');
  }

  if (this.rejectedBy && this.requestedBy && this.rejectedBy.equals(this.requestedBy)) {
    throw new Error('A refund cannot be rejected by the person who requested it');
  }
});

/**
 * Append one line to the audit trail. Every state change goes through here so
 * the trail cannot be half-kept.
 */
feeRefundSchema.methods.log = function (action, actor, note = '') {
  this.history.push({
    action,
    by: actor ? actor._id : undefined,
    byName: (actor && actor.name) || '',
    at: new Date(),
    note,
  });

  return this;
};

feeRefundSchema.methods.approve = function (actor, note = '') {
  if (this.status !== 'requested') {
    throw new Error(`Only a requested refund can be approved; this one is ${this.status}`);
  }
  if (actor._id.equals(this.requestedBy)) {
    throw new Error('A refund cannot be approved by the person who requested it');
  }

  this.status = 'approved';
  this.approvedBy = actor._id;
  this.approvedAt = new Date();
  this.approvalNote = note || '';

  return this.log('approved', actor, note);
};

feeRefundSchema.methods.reject = function (actor, reason) {
  if (this.status !== 'requested' && this.status !== 'approved') {
    throw new Error(`A ${this.status} refund cannot be rejected`);
  }
  if (actor._id.equals(this.requestedBy)) {
    throw new Error('A refund cannot be rejected by the person who requested it');
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('A rejection reason is required');
  }

  this.status = 'rejected';
  this.rejectedBy = actor._id;
  this.rejectedAt = new Date();
  this.rejectionReason = String(reason).trim();

  return this.log('rejected', actor, this.rejectionReason);
};

feeRefundSchema.methods.cancel = function (actor) {
  if (this.status !== 'requested') {
    throw new Error(`Only a requested refund can be cancelled; this one is ${this.status}`);
  }
  if (!actor._id.equals(this.requestedBy) && actor.role !== 'admin') {
    throw new Error('Only the requester or an admin may cancel a refund');
  }

  this.status = 'cancelled';
  this.cancelledAt = new Date();

  return this.log('cancelled', actor);
};

feeRefundSchema.methods.markSettled = function (actor, creditNoteNumber, reference = '') {
  if (this.status !== 'approved') {
    throw new Error(`Only an approved refund can be settled; this one is ${this.status}`);
  }

  this.status = 'settled';
  this.settledBy = actor._id;
  this.settledAt = new Date();
  this.settlementReference = reference || '';
  this.creditNoteNumber = creditNoteNumber;

  return this.log('settled', actor, creditNoteNumber);
};

/**
 * Everything already spoken for on one invoice.
 *
 * This is the whole safety property of the module, so it is an aggregation over
 * the refunds rather than a counter on the invoice — a counter is the thing
 * that ends up disagreeing with the rows it is supposed to summarise.
 */
feeRefundSchema.statics.encumberedTotal = async function (invoiceId) {
  const [row] = await this.aggregate([
    { $match: { invoice: new mongoose.Types.ObjectId(String(invoiceId)), isEncumbering: true } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);

  return row ? row.total : 0;
};

/**
 * What is left to give back: paid in, less everything already spoken for.
 * Never negative, even if historical data manages to go over.
 */
feeRefundSchema.statics.refundableFor = async function (invoice) {
  const encumbered = await this.encumberedTotal(invoice._id);
  const paid = invoice.amountPaid || 0;

  return {
    amountPaid: paid,
    alreadyRefunded: encumbered,
    refundable: Math.max(0, paid - encumbered),
  };
};

feeRefundSchema.statics.STATUSES = REFUND_STATUSES;
feeRefundSchema.statics.REASONS = REFUND_REASONS;
feeRefundSchema.statics.METHODS = REFUND_METHODS;
feeRefundSchema.statics.ENCUMBERING_STATUSES = ENCUMBERING_STATUSES;

/**
 * Serial issuer for credit-note numbers.
 *
 * `FeeInvoice` derives its invoice number from the document id, which is fine
 * for an internal reference. A credit note is handed to a parent and quoted
 * back at the office, so it needs to be short, sequential and gap-free — which
 * means a counter, bumped atomically so two settlements racing get two numbers
 * rather than the same one twice.
 */
const creditNoteCounterSchema = new mongoose.Schema(
  {
    _id: { type: String },
    seq: { type: Number, default: 0 },
  },
  { _id: false }
);

creditNoteCounterSchema.statics.next = async function (academicYear) {
  const scope = (academicYear || '').replace(/\s+/g, '') || 'GENERAL';

  const counter = await this.findOneAndUpdate(
    { _id: `CN-${scope}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  return `CN/${scope}/${String(counter.seq).padStart(4, '0')}`;
};

const FeeRefund = mongoose.model('FeeRefund', feeRefundSchema);
const CreditNoteCounter = mongoose.model('CreditNoteCounter', creditNoteCounterSchema);

module.exports = FeeRefund;
module.exports.FeeRefund = FeeRefund;
module.exports.CreditNoteCounter = CreditNoteCounter;
