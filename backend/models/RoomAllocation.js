const mongoose = require('mongoose');

const ALLOCATION_STATUSES = ['active', 'vacated', 'transferred'];

const allocationError = (message) => {
  const error = new Error(message);
  error.userFacing = true;
  return error;
};

const roomAllocationSchema = new mongoose.Schema(
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
      default: '',
    },

    className: {
      type: String,
      trim: true,
      maxlength: [50, 'Class name cannot exceed 50 characters'],
      default: '',
    },

    room: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'HostelRoom',
      required: [true, 'Room is required'],
    },

    // Denormalised so the history list reads without populating a room that may
    // since have been renumbered or closed.
    roomLabel: {
      type: String,
      trim: true,
      default: '',
    },

    bedNumber: {
      type: String,
      required: [true, 'Bed number is required'],
      trim: true,
      uppercase: true,
      maxlength: [10, 'Bed number cannot exceed 10 characters'],
    },

    allocatedFrom: {
      type: Date,
      required: [true, 'Allocation start date is required'],
      default: Date.now,
    },

    allocatedTo: {
      type: Date,
      default: null,
    },

    status: {
      type: String,
      enum: {
        values: ALLOCATION_STATUSES,
        message: 'Invalid allocation status',
      },
      default: 'active',
    },

    allocatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    vacatedAt: {
      type: Date,
      default: null,
    },

    vacateReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Vacate reason cannot exceed 300 characters'],
      default: '',
    },

    // Where the transfer went, so the history reads as a chain rather than a
    // set of disconnected rows.
    transferredTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RoomAllocation',
      default: null,
    },

    guardianName: {
      type: String,
      trim: true,
      maxlength: [100, 'Guardian name cannot exceed 100 characters'],
      default: '',
    },

    guardianPhone: {
      type: String,
      trim: true,
      default: '',
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

// One live allocation per student, enforced by the database so two concurrent
// allocations cannot both pass an application-level check.
roomAllocationSchema.index(
  { student: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } }
);

roomAllocationSchema.index({ room: 1, status: 1 });
roomAllocationSchema.index({ status: 1, allocatedFrom: -1 });

roomAllocationSchema.virtual('nightsStayed').get(function () {
  const end = this.allocatedTo || this.vacatedAt || new Date();
  const start = this.allocatedFrom;
  if (!start) return 0;

  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.max(Math.round((end - start) / msPerDay), 0);
});

roomAllocationSchema.virtual('isLive').get(function () {
  return this.status === 'active';
});

/**
 * Closes an allocation. `transferred` and `vacated` differ only in intent, so
 * they share one path and the caller states which it is.
 */
roomAllocationSchema.methods.close = function (status, reason = '') {
  if (!['vacated', 'transferred'].includes(status)) {
    throw allocationError(`Cannot close an allocation as "${status}"`);
  }
  if (this.status !== 'active') {
    throw allocationError(`This allocation is already ${this.status}`);
  }

  this.status = status;
  this.vacatedAt = new Date();
  this.allocatedTo = this.allocatedTo || new Date();
  this.vacateReason = reason;

  return this;
};

roomAllocationSchema.pre('validate', async function () {
  if (this.allocatedTo && this.allocatedFrom && this.allocatedTo < this.allocatedFrom) {
    throw allocationError('The end date cannot fall before the allocation start date');
  }
});

module.exports = mongoose.model('RoomAllocation', roomAllocationSchema);
module.exports.ALLOCATION_STATUSES = ALLOCATION_STATUSES;
module.exports.allocationError = allocationError;
