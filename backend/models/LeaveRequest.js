const mongoose = require('mongoose');

const LEAVE_TYPES = ['sick', 'casual', 'emergency', 'event', 'other'];
const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'withdrawn'];

// A request may be back-dated by at most this many days, so a student can log a
// sudden illness the morning after without being able to rewrite last term.
const BACKDATE_GRACE_DAYS = 7;

// Which transitions the lifecycle permits. Kept as data rather than scattered
// `if` statements so adding a state later cannot silently open a hole.
const ALLOWED_TRANSITIONS = {
  pending: ['approved', 'rejected', 'withdrawn', 'cancelled'],
  approved: ['cancelled'],
  rejected: [],
  cancelled: [],
  withdrawn: [],
};

/**
 * A validation failure the student can act on. Tagged so the controller answers
 * 400 for these and 500 for genuine bugs.
 */
const leaveError = (message) => {
  const error = new Error(message);
  error.userFacing = true;
  return error;
};

const attachmentSchema = new mongoose.Schema(
  {
    fileName: { type: String, required: true },
    fileUrl: { type: String, required: true },
    fileType: { type: String },
    fileSize: { type: Number, min: [0, 'File size cannot be negative'] },
  },
  { _id: false }
);

const leaveRequestSchema = new mongoose.Schema(
  {
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

    className: {
      type: String,
      trim: true,
      maxlength: [50, 'Class name cannot exceed 50 characters'],
      default: '',
    },

    type: {
      type: String,
      enum: {
        values: LEAVE_TYPES,
        message: 'Invalid leave type',
      },
      required: [true, 'Leave type is required'],
    },

    reason: {
      type: String,
      required: [true, 'Reason is required'],
      trim: true,
      minlength: [10, 'Please give at least 10 characters of context'],
      maxlength: [1000, 'Reason cannot exceed 1000 characters'],
    },

    fromDate: {
      type: Date,
      required: [true, 'Start date is required'],
    },

    toDate: {
      type: Date,
      required: [true, 'End date is required'],
    },

    // Derived in the pre-validate hook — never accepted from the client.
    totalDays: {
      type: Number,
      default: 1,
      min: [0.5, 'A leave request must cover at least half a day'],
    },

    isHalfDay: {
      type: Boolean,
      default: false,
    },

    status: {
      type: String,
      enum: {
        values: LEAVE_STATUSES,
        message: 'Invalid leave status',
      },
      default: 'pending',
    },

    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    reviewerName: {
      type: String,
      trim: true,
      default: '',
    },

    reviewedAt: {
      type: Date,
      default: null,
    },

    reviewComment: {
      type: String,
      trim: true,
      maxlength: [500, 'Review comment cannot exceed 500 characters'],
      default: '',
    },

    contactDuringLeave: {
      type: String,
      trim: true,
      maxlength: [100, 'Contact cannot exceed 100 characters'],
      default: '',
    },

    attachments: {
      type: [attachmentSchema],
      default: [],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

leaveRequestSchema.index({ student: 1, status: 1 });
leaveRequestSchema.index({ status: 1, fromDate: 1 });
leaveRequestSchema.index({ className: 1, fromDate: 1 });

leaveRequestSchema.virtual('isPending').get(function () {
  return this.status === 'pending';
});

leaveRequestSchema.virtual('isDecided').get(function () {
  return this.status === 'approved' || this.status === 'rejected';
});

/**
 * Date sanity and the derived day count. A half-day request is always 0.5 days
 * and must sit inside a single date.
 */
leaveRequestSchema.pre('validate', function (next) {
  if (!this.fromDate || !this.toDate) return next();

  const from = new Date(this.fromDate);
  const to = new Date(this.toDate);
  from.setHours(0, 0, 0, 0);
  to.setHours(0, 0, 0, 0);

  if (to.getTime() < from.getTime()) {
    return next(leaveError('The end date cannot be before the start date'));
  }

  if (this.isNew) {
    const earliest = new Date();
    earliest.setHours(0, 0, 0, 0);
    earliest.setDate(earliest.getDate() - BACKDATE_GRACE_DAYS);

    if (from.getTime() < earliest.getTime()) {
      return next(
        leaveError(`Leave cannot be requested more than ${BACKDATE_GRACE_DAYS} days in the past`)
      );
    }
  }

  const msPerDay = 24 * 60 * 60 * 1000;
  const inclusiveDays = Math.round((to.getTime() - from.getTime()) / msPerDay) + 1;

  if (this.isHalfDay) {
    if (inclusiveDays > 1) {
      return next(leaveError('A half-day request must start and end on the same date'));
    }
    this.totalDays = 0.5;
  } else {
    this.totalDays = inclusiveDays;
  }

  return next();
});

/**
 * The single source of truth for the lifecycle. Both the controller and any
 * future automation ask this before writing a new status.
 */
leaveRequestSchema.methods.canTransition = function (nextStatus) {
  const allowed = ALLOWED_TRANSITIONS[this.status] || [];
  return allowed.includes(nextStatus);
};

/**
 * Apply a decision, recording who made it and when.
 */
leaveRequestSchema.methods.decide = function (nextStatus, reviewer, comment = '') {
  if (!this.canTransition(nextStatus)) {
    throw leaveError(`A ${this.status} request cannot be moved to ${nextStatus}`);
  }
  if (nextStatus === 'rejected' && !String(comment).trim()) {
    throw leaveError('A rejection needs a comment explaining why');
  }

  this.status = nextStatus;
  this.reviewedBy = reviewer ? reviewer._id : null;
  this.reviewerName = reviewer ? reviewer.name : '';
  this.reviewedAt = new Date();
  this.reviewComment = String(comment || '').trim();

  return this;
};

/**
 * Does this request's date range touch another's? Used to stop a student
 * double-booking the same days.
 */
leaveRequestSchema.methods.overlaps = function (other) {
  return this.fromDate <= other.toDate && this.toDate >= other.fromDate;
};

leaveRequestSchema.statics.TYPES = LEAVE_TYPES;
leaveRequestSchema.statics.STATUSES = LEAVE_STATUSES;
leaveRequestSchema.statics.BACKDATE_GRACE_DAYS = BACKDATE_GRACE_DAYS;

module.exports = mongoose.model('LeaveRequest', leaveRequestSchema);
