const mongoose = require('mongoose');

const LOAN_STATUSES = ['issued', 'returned', 'overdue', 'lost'];

// Library policy. Kept here so the controller, the model and any future
// scheduler read the same numbers.
const LOAN_PERIOD_DAYS = 14;
const MAX_RENEWALS = 2;
const MAX_CONCURRENT_LOANS = 3;
const FINE_PER_DAY = 2;

const bookLoanSchema = new mongoose.Schema(
  {
    book: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Book',
      required: [true, 'Book is required'],
    },

    // Denormalised so a loan history stays readable if a book is removed from
    // the catalogue.
    bookTitle: {
      type: String,
      trim: true,
      maxlength: [250, 'Book title cannot exceed 250 characters'],
    },

    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Borrower is required'],
    },

    studentName: {
      type: String,
      trim: true,
      maxlength: [100, 'Student name cannot exceed 100 characters'],
    },

    issuedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'The librarian issuing the book is required'],
    },

    issuedAt: {
      type: Date,
      default: Date.now,
    },

    dueDate: {
      type: Date,
      required: [true, 'Due date is required'],
    },

    returnedAt: {
      type: Date,
      default: null,
    },

    returnedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    status: {
      type: String,
      enum: {
        values: LOAN_STATUSES,
        message: 'Invalid loan status',
      },
      default: 'issued',
    },

    renewalCount: {
      type: Number,
      default: 0,
      min: [0, 'Renewal count cannot be negative'],
      max: [MAX_RENEWALS, `A loan cannot be renewed more than ${MAX_RENEWALS} times`],
    },

    fineAmount: {
      type: Number,
      default: 0,
      min: [0, 'Fine cannot be negative'],
    },

    finePaid: {
      type: Boolean,
      default: false,
    },

    notes: {
      type: String,
      trim: true,
      maxlength: [500, 'Notes cannot exceed 500 characters'],
      default: '',
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

bookLoanSchema.index({ student: 1, status: 1 });
bookLoanSchema.index({ book: 1, status: 1 });
bookLoanSchema.index({ status: 1, dueDate: 1 });

bookLoanSchema.virtual('isActive').get(function () {
  return this.status === 'issued' || this.status === 'overdue';
});

/**
 * Whole days past the due date. Zero while the loan is still within term.
 */
bookLoanSchema.methods.daysOverdue = function (now = new Date()) {
  const reference = this.returnedAt || now;
  const msPerDay = 24 * 60 * 60 * 1000;
  const days = Math.floor((reference.getTime() - this.dueDate.getTime()) / msPerDay);
  return Math.max(0, days);
};

bookLoanSchema.methods.isOverdue = function (now = new Date()) {
  if (this.status === 'returned' || this.status === 'lost') return false;
  return this.dueDate.getTime() < now.getTime();
};

/**
 * Fine owed at the configured per-day rate. Returns 0 for a loan returned on
 * time, so the caller can assign the result unconditionally.
 */
bookLoanSchema.methods.calculateFine = function (finePerDay = FINE_PER_DAY, now = new Date()) {
  return this.daysOverdue(now) * finePerDay;
};

/**
 * Extend the loan. Refuses once the cap is reached or the loan is already
 * overdue — an overdue book has to come back before it can go out again.
 */
bookLoanSchema.methods.renew = function (extraDays = LOAN_PERIOD_DAYS, now = new Date()) {
  if (this.status !== 'issued') {
    throw new Error('Only an active loan can be renewed');
  }
  if (this.isOverdue(now)) {
    throw new Error('This loan is overdue — return the book before renewing');
  }
  if (this.renewalCount >= MAX_RENEWALS) {
    throw new Error(`A loan cannot be renewed more than ${MAX_RENEWALS} times`);
  }

  this.dueDate = new Date(this.dueDate.getTime() + extraDays * 24 * 60 * 60 * 1000);
  this.renewalCount += 1;

  return this;
};

/**
 * Close the loan and settle any fine.
 */
bookLoanSchema.methods.close = function (librarian, finePerDay = FINE_PER_DAY, now = new Date()) {
  if (this.status === 'returned') {
    throw new Error('This book has already been returned');
  }

  this.returnedAt = now;
  this.returnedTo = librarian ? librarian._id : null;
  this.fineAmount = this.calculateFine(finePerDay, now);
  this.status = 'returned';

  return this;
};

bookLoanSchema.statics.STATUSES = LOAN_STATUSES;
bookLoanSchema.statics.LOAN_PERIOD_DAYS = LOAN_PERIOD_DAYS;
bookLoanSchema.statics.MAX_RENEWALS = MAX_RENEWALS;
bookLoanSchema.statics.MAX_CONCURRENT_LOANS = MAX_CONCURRENT_LOANS;
bookLoanSchema.statics.FINE_PER_DAY = FINE_PER_DAY;

module.exports = mongoose.model('BookLoan', bookLoanSchema);
