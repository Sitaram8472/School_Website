const mongoose = require('mongoose');

const ROUTE_STATUSES = ['active', 'suspended', 'retired'];
const WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Times are stored as plain "HH:MM" strings rather than Dates. A stop's pickup
// time is a recurring wall-clock time, not an instant, so a Date would force us
// to invent a meaningless date part and would break the moment the server and
// the school sit in different timezones.
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * A validation failure the caller can fix by changing their input. Tagged so
 * the controller can answer 400 for these and 500 for genuine bugs.
 */
const transportError = (message) => {
  const error = new Error(message);
  error.userFacing = true;
  return error;
};

const stopSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Stop name is required'],
      trim: true,
      maxlength: [120, 'Stop name cannot exceed 120 characters'],
    },

    landmark: {
      type: String,
      trim: true,
      maxlength: [200, 'Landmark cannot exceed 200 characters'],
      default: '',
    },

    // Morning pickup and afternoon drop for this stop.
    pickupTime: {
      type: String,
      required: [true, 'Pickup time is required'],
      match: [TIME_PATTERN, 'Pickup time must be in HH:MM 24-hour format'],
    },

    dropTime: {
      type: String,
      required: [true, 'Drop time is required'],
      match: [TIME_PATTERN, 'Drop time must be in HH:MM 24-hour format'],
    },

    // Position along the route, 1-based. Kept explicit rather than relying on
    // array order so the UI can reorder stops without rewriting the array.
    sequence: {
      type: Number,
      required: [true, 'Stop sequence is required'],
      min: [1, 'Sequence starts at 1'],
    },

    latitude: {
      type: Number,
      min: [-90, 'Latitude must be between -90 and 90'],
      max: [90, 'Latitude must be between -90 and 90'],
      default: null,
    },

    longitude: {
      type: Number,
      min: [-180, 'Longitude must be between -180 and 180'],
      max: [180, 'Longitude must be between -180 and 180'],
      default: null,
    },
  },
  { _id: true }
);

const busRouteSchema = new mongoose.Schema(
  {
    routeCode: {
      type: String,
      required: [true, 'Route code is required'],
      unique: true,
      trim: true,
      uppercase: true,
      minlength: [2, 'Route code must be at least 2 characters'],
      maxlength: [16, 'Route code cannot exceed 16 characters'],
    },

    routeName: {
      type: String,
      required: [true, 'Route name is required'],
      trim: true,
      minlength: [3, 'Route name must be at least 3 characters'],
      maxlength: [120, 'Route name cannot exceed 120 characters'],
    },

    description: {
      type: String,
      trim: true,
      maxlength: [500, 'Description cannot exceed 500 characters'],
      default: '',
    },

    vehicle: {
      registrationNumber: {
        type: String,
        required: [true, 'Vehicle registration number is required'],
        trim: true,
        uppercase: true,
        maxlength: [20, 'Registration number cannot exceed 20 characters'],
      },
      model: {
        type: String,
        trim: true,
        maxlength: [80, 'Vehicle model cannot exceed 80 characters'],
        default: '',
      },
      capacity: {
        type: Number,
        required: [true, 'Vehicle capacity is required'],
        min: [1, 'Capacity must be at least 1'],
        max: [120, 'Capacity cannot exceed 120'],
      },
      lastServicedOn: {
        type: Date,
        default: null,
      },
    },

    driver: {
      name: {
        type: String,
        required: [true, 'Driver name is required'],
        trim: true,
        maxlength: [100, 'Driver name cannot exceed 100 characters'],
      },
      phone: {
        type: String,
        required: [true, 'Driver phone is required'],
        trim: true,
        match: [/^[0-9+\-\s]{7,20}$/, 'Please enter a valid phone number'],
      },
      licenseNumber: {
        type: String,
        trim: true,
        uppercase: true,
        maxlength: [30, 'License number cannot exceed 30 characters'],
        default: '',
      },
    },

    // Optional second adult on board. Many schools require one for primary
    // classes, so it is modelled but never mandatory.
    attendant: {
      name: {
        type: String,
        trim: true,
        maxlength: [100, 'Attendant name cannot exceed 100 characters'],
        default: '',
      },
      phone: {
        type: String,
        trim: true,
        default: '',
      },
    },

    stops: {
      type: [stopSchema],
      validate: {
        validator: (stops) => Array.isArray(stops) && stops.length >= 2,
        message: 'A route needs at least a boarding stop and the school stop',
      },
    },

    operatingDays: {
      type: [String],
      enum: {
        values: WEEK_DAYS,
        message: 'Invalid day of week',
      },
      default: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    },

    farePerMonth: {
      type: Number,
      default: 0,
      min: [0, 'Fare cannot be negative'],
    },

    status: {
      type: String,
      enum: {
        values: ROUTE_STATUSES,
        message: 'Invalid route status',
      },
      default: 'active',
    },

    // Denormalised counter kept in step with the TransportAssignment collection
    // by the controller. It is never accepted from a request body — the
    // controller recomputes it from the actual active assignments.
    seatsOccupied: {
      type: Number,
      default: 0,
      min: [0, 'Occupied seats cannot be negative'],
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    notes: {
      type: String,
      trim: true,
      maxlength: [1000, 'Notes cannot exceed 1000 characters'],
      default: '',
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

busRouteSchema.index({ status: 1 });
busRouteSchema.index({ 'stops.name': 1 });
busRouteSchema.index({ routeName: 1 });

busRouteSchema.virtual('seatsAvailable').get(function () {
  const capacity = this.vehicle?.capacity || 0;
  return Math.max(capacity - (this.seatsOccupied || 0), 0);
});

busRouteSchema.virtual('isFull').get(function () {
  const capacity = this.vehicle?.capacity || 0;
  return (this.seatsOccupied || 0) >= capacity;
});

busRouteSchema.virtual('occupancyRate').get(function () {
  const capacity = this.vehicle?.capacity || 0;
  if (!capacity) return 0;
  return Math.round(((this.seatsOccupied || 0) / capacity) * 100);
});

/**
 * The first and last stop of the ordered list — what the directory card shows
 * as "Sector 12 → School" without pulling the whole stop array into the UI.
 */
busRouteSchema.virtual('terminals').get(function () {
  const ordered = this.orderedStops();
  if (!ordered.length) return { first: null, last: null };
  return {
    first: ordered[0].name,
    last: ordered[ordered.length - 1].name,
  };
});

busRouteSchema.methods.orderedStops = function () {
  return [...(this.stops || [])].sort((a, b) => a.sequence - b.sequence);
};

/**
 * Case-insensitive stop lookup. Assignments reference stops by name because the
 * office thinks in stop names, so every write path funnels through here to
 * confirm the name actually exists on the route.
 */
busRouteSchema.methods.findStop = function (stopName) {
  if (!stopName) return null;
  const needle = String(stopName).trim().toLowerCase();
  return (this.stops || []).find((stop) => stop.name.trim().toLowerCase() === needle) || null;
};

busRouteSchema.methods.hasStop = function (stopName) {
  return Boolean(this.findStop(stopName));
};

/**
 * Sequences must be unique and contiguous from 1. Contiguity matters because
 * the timeline UI renders "stop 3 of 7" — a gap would silently mislabel every
 * stop after it.
 */
busRouteSchema.methods.assertStopsAreWellOrdered = function () {
  const sequences = (this.stops || []).map((stop) => stop.sequence);
  const unique = new Set(sequences);

  if (unique.size !== sequences.length) {
    throw transportError('Two stops share the same sequence number');
  }

  const sorted = [...sequences].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i] !== i + 1) {
      throw transportError('Stop sequences must run from 1 with no gaps');
    }
  }
};

/**
 * Renumbers stops from 1 in their current sorted order. Called after an insert
 * or a delete so callers never have to hand-maintain sequences.
 */
busRouteSchema.methods.resequenceStops = function () {
  this.orderedStops().forEach((stop, index) => {
    stop.sequence = index + 1;
  });
  this.markModified('stops');
};

busRouteSchema.methods.canAcceptRiders = function (count = 1) {
  if (this.status !== 'active') return false;
  const capacity = this.vehicle?.capacity || 0;
  return (this.seatsOccupied || 0) + count <= capacity;
};

// Mongoose 9 no longer passes a `next` callback to middleware — a hook is an
// async function and signals failure by throwing. Written the old way the hook
// silently does nothing, so these guards must stay in this shape.
busRouteSchema.pre('validate', async function () {
  if (this.stops && this.stops.length) {
    this.assertStopsAreWellOrdered();
  }

  const capacity = this.vehicle?.capacity || 0;
  if (this.seatsOccupied > capacity) {
    throw transportError(
      `Cannot set capacity to ${capacity} — ${this.seatsOccupied} seats are already taken`
    );
  }
});

module.exports = mongoose.model('BusRoute', busRouteSchema);
module.exports.ROUTE_STATUSES = ROUTE_STATUSES;
module.exports.WEEK_DAYS = WEEK_DAYS;
module.exports.transportError = transportError;
