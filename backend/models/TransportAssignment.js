const mongoose = require('mongoose');

const ASSIGNMENT_STATUSES = ['active', 'cancelled', 'completed'];
const DIRECTIONS = ['both', 'pickup-only', 'drop-only'];

const assignmentError = (message) => {
  const error = new Error(message);
  error.userFacing = true;
  return error;
};

const transportAssignmentSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Student is required'],
    },

    // Denormalised so the route roster renders without a populate on every row.
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

    route: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BusRoute',
      required: [true, 'Route is required'],
    },

    routeCode: {
      type: String,
      trim: true,
      uppercase: true,
      default: '',
    },

    // Stops are referenced by name. The controller validates that both names
    // exist on the chosen route before saving, so a typo can never produce an
    // assignment to a stop the bus does not visit.
    pickupStop: {
      type: String,
      required: [true, 'Pickup stop is required'],
      trim: true,
      maxlength: [120, 'Stop name cannot exceed 120 characters'],
    },

    dropStop: {
      type: String,
      required: [true, 'Drop stop is required'],
      trim: true,
      maxlength: [120, 'Stop name cannot exceed 120 characters'],
    },

    direction: {
      type: String,
      enum: {
        values: DIRECTIONS,
        message: 'Invalid travel direction',
      },
      default: 'both',
    },

    startDate: {
      type: Date,
      required: [true, 'Start date is required'],
      default: Date.now,
    },

    endDate: {
      type: Date,
      default: null,
    },

    status: {
      type: String,
      enum: {
        values: ASSIGNMENT_STATUSES,
        message: 'Invalid assignment status',
      },
      default: 'active',
    },

    monthlyFare: {
      type: Number,
      default: 0,
      min: [0, 'Fare cannot be negative'],
    },

    emergencyContact: {
      name: {
        type: String,
        trim: true,
        maxlength: [100, 'Contact name cannot exceed 100 characters'],
        default: '',
      },
      phone: {
        type: String,
        trim: true,
        default: '',
      },
      relation: {
        type: String,
        trim: true,
        maxlength: [50, 'Relation cannot exceed 50 characters'],
        default: '',
      },
    },

    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    cancelReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Cancel reason cannot exceed 300 characters'],
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

// A student may have any number of historical assignments but only one live
// one. A partial index enforces that at the database level, so two concurrent
// requests cannot both slip past an application-level check.
transportAssignmentSchema.index(
  { student: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } }
);

transportAssignmentSchema.index({ route: 1, status: 1 });
transportAssignmentSchema.index({ status: 1, startDate: -1 });

transportAssignmentSchema.virtual('isLive').get(function () {
  if (this.status !== 'active') return false;
  if (this.endDate && this.endDate < new Date()) return false;
  return true;
});

transportAssignmentSchema.methods.cancel = function (reason = '', actorId = null) {
  if (this.status !== 'active') {
    throw assignmentError(`Only an active assignment can be cancelled (this one is ${this.status})`);
  }

  this.status = 'cancelled';
  this.cancelledAt = new Date();
  this.cancelReason = reason;
  this.endDate = this.endDate || new Date();
  if (actorId) this.assignedBy = this.assignedBy || actorId;

  return this;
};

// Mongoose 9 middleware is async-and-throw; there is no `next` callback. A hook
// written in the callback style is silently skipped, taking these guards with
// it, so the shape here is deliberate.
transportAssignmentSchema.pre('validate', async function () {
  if (this.endDate && this.startDate && this.endDate < this.startDate) {
    throw assignmentError('End date cannot fall before the start date');
  }

  if (
    this.pickupStop &&
    this.dropStop &&
    this.direction === 'both' &&
    this.pickupStop.trim().toLowerCase() === this.dropStop.trim().toLowerCase()
  ) {
    throw assignmentError('Pickup and drop stops cannot be the same stop');
  }
});

module.exports = mongoose.model('TransportAssignment', transportAssignmentSchema);
module.exports.ASSIGNMENT_STATUSES = ASSIGNMENT_STATUSES;
module.exports.DIRECTIONS = DIRECTIONS;
module.exports.assignmentError = assignmentError;
