const mongoose = require('mongoose');

const INVOICE_STATUSES = ['pending', 'partial', 'paid', 'overdue', 'waived'];
const PAYMENT_METHODS = ['cash', 'cheque', 'bank-transfer', 'upi', 'card', 'online'];

const lineItemSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      required: [true, 'Line item label is required'],
      trim: true,
      maxlength: [100, 'Line item label cannot exceed 100 characters'],
    },
    amount: {
      type: Number,
      required: [true, 'Line item amount is required'],
      min: [0, 'Line item amount cannot be negative'],
    },
  },
  { _id: false }
);

const paymentSchema = new mongoose.Schema(
  {
    amount: {
      type: Number,
      required: [true, 'Payment amount is required'],
      min: [1, 'Payment amount must be greater than zero'],
    },
    method: {
      type: String,
      enum: {
        values: PAYMENT_METHODS,
        message: 'Invalid payment method',
      },
      required: [true, 'Payment method is required'],
    },
    reference: {
      type: String,
      trim: true,
      maxlength: [100, 'Reference cannot exceed 100 characters'],
      default: '',
    },
    paidAt: {
      type: Date,
      default: Date.now,
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'The staff member recording the payment is required'],
    },
    note: {
      type: String,
      trim: true,
      maxlength: [300, 'Note cannot exceed 300 characters'],
      default: '',
    },
  },
  { timestamps: true }
);

const feeInvoiceSchema = new mongoose.Schema(
  {
    // Human-friendly identifier printed on the receipt.
    invoiceNumber: {
      type: String,
      unique: true,
      trim: true,
    },

    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Student is required'],
    },

    studentName: {
      type: String,
      trim: true,
      maxlength: [100, 'Student name cannot exceed 100 characters'],
    },

    feeStructure: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FeeStructure',
      required: [true, 'Fee structure is required'],
    },

    academicYear: {
      type: String,
      required: [true, 'Academic year is required'],
      trim: true,
    },

    className: {
      type: String,
      trim: true,
      maxlength: [50, 'Class name cannot exceed 50 characters'],
    },

    lineItems: {
      type: [lineItemSchema],
      default: [],
    },

    totalAmount: {
      type: Number,
      required: [true, 'Total amount is required'],
      min: [0, 'Total amount cannot be negative'],
    },

    amountPaid: {
      type: Number,
      default: 0,
      min: [0, 'Amount paid cannot be negative'],
    },

    balance: {
      type: Number,
      default: 0,
      min: [0, 'Balance cannot be negative'],
    },

    lateFee: {
      type: Number,
      default: 0,
      min: [0, 'Late fee cannot be negative'],
    },

    dueDate: {
      type: Date,
      required: [true, 'Due date is required'],
    },

    status: {
      type: String,
      enum: {
        values: INVOICE_STATUSES,
        message: 'Invalid invoice status',
      },
      default: 'pending',
    },

    payments: {
      type: [paymentSchema],
      default: [],
    },

    waivedReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Waiver reason cannot exceed 300 characters'],
      default: '',
    },

    currency: {
      type: String,
      default: 'INR',
      uppercase: true,
      trim: true,
    },
  },
  { timestamps: true }
);

// One invoice per student per structure — the guard against a bulk generation
// run being fired twice.
feeInvoiceSchema.index({ student: 1, feeStructure: 1 }, { unique: true });
feeInvoiceSchema.index({ status: 1, dueDate: 1 });
feeInvoiceSchema.index({ academicYear: 1, className: 1 });

/**
 * Generate a readable invoice number once, on first save. Uses the document id
 * suffix so it stays unique without a counter collection.
 */
feeInvoiceSchema.pre('validate', function (next) {
  if (!this.invoiceNumber) {
    const year = (this.academicYear || '').replace(/\D/g, '').slice(0, 4) || 'XXXX';
    this.invoiceNumber = `INV-${year}-${this._id.toString().slice(-8).toUpperCase()}`;
  }

  if (this.isNew && (this.balance === undefined || this.balance === null)) {
    this.balance = this.totalAmount;
  }

  next();
});

/**
 * Late fee accrued so far, in whole days past the due date, capped by the
 * structure's `maxLateFee` when one is configured.
 */
feeInvoiceSchema.methods.computeLateFee = function (lateFeePerDay = 0, maxLateFee = 0) {
  if (!lateFeePerDay || this.status === 'paid' || this.status === 'waived') return 0;

  const msPerDay = 24 * 60 * 60 * 1000;
  const daysLate = Math.floor((Date.now() - this.dueDate.getTime()) / msPerDay);
  if (daysLate <= 0) return 0;

  const accrued = daysLate * lateFeePerDay;
  return maxLateFee > 0 ? Math.min(accrued, maxLateFee) : accrued;
};

/**
 * Recompute `balance` and `status` from `amountPaid`. Called after every
 * mutation so the two can never drift apart.
 */
feeInvoiceSchema.methods.refreshStatus = function () {
  const payable = this.totalAmount + (this.lateFee || 0);
  this.balance = Math.max(0, payable - this.amountPaid);

  if (this.status === 'waived') return this;

  if (this.balance === 0) {
    this.status = 'paid';
  } else if (this.amountPaid > 0) {
    this.status = 'partial';
  } else if (this.dueDate.getTime() < Date.now()) {
    this.status = 'overdue';
  } else {
    this.status = 'pending';
  }

  return this;
};

/**
 * Append a payment. Rejects overpayment outright rather than silently clamping,
 * because a wrong amount is almost always a data-entry mistake worth surfacing.
 */
feeInvoiceSchema.methods.recordPayment = function ({ amount, method, reference, note, recordedBy, paidAt }) {
  const numericAmount = Number(amount);

  if (Number.isNaN(numericAmount) || numericAmount <= 0) {
    throw new Error('Payment amount must be a positive number');
  }
  if (this.status === 'paid') {
    throw new Error('This invoice is already fully paid');
  }
  if (this.status === 'waived') {
    throw new Error('This invoice has been waived and cannot take payments');
  }

  const payable = this.totalAmount + (this.lateFee || 0);
  const outstanding = payable - this.amountPaid;

  if (numericAmount > outstanding) {
    throw new Error(
      `Payment of ${numericAmount} exceeds the outstanding balance of ${outstanding}`
    );
  }
  if (!PAYMENT_METHODS.includes(method)) {
    throw new Error(`Payment method must be one of: ${PAYMENT_METHODS.join(', ')}`);
  }

  this.payments.push({
    amount: numericAmount,
    method,
    reference: reference || '',
    note: note || '',
    recordedBy: recordedBy._id,
    paidAt: paidAt ? new Date(paidAt) : new Date(),
  });

  this.amountPaid += numericAmount;
  this.refreshStatus();

  return this;
};

feeInvoiceSchema.statics.STATUSES = INVOICE_STATUSES;
feeInvoiceSchema.statics.PAYMENT_METHODS = PAYMENT_METHODS;

module.exports = mongoose.model('FeeInvoice', feeInvoiceSchema);
