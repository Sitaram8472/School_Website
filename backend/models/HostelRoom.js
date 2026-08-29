const mongoose = require('mongoose');

const HOSTEL_TYPES = ['boys', 'girls'];
const ROOM_TYPES = ['single', 'double', 'triple', 'dormitory'];
const ROOM_STATUSES = ['available', 'full', 'maintenance', 'closed'];
const BED_STATUSES = ['vacant', 'occupied', 'blocked'];

// How many beds each room type is expected to hold. `dormitory` is open-ended
// because dorm sizes vary between blocks.
const DEFAULT_BED_COUNT = {
  single: 1,
  double: 2,
  triple: 3,
};

const hostelError = (message) => {
  const error = new Error(message);
  error.userFacing = true;
  return error;
};

const bedSchema = new mongoose.Schema(
  {
    bedNumber: {
      type: String,
      required: [true, 'Bed number is required'],
      trim: true,
      uppercase: true,
      maxlength: [10, 'Bed number cannot exceed 10 characters'],
    },

    status: {
      type: String,
      enum: {
        values: BED_STATUSES,
        message: 'Invalid bed status',
      },
      default: 'vacant',
    },

    // Set when the bed is occupied, cleared when it is freed. The RoomAllocation
    // collection remains the historical record — this is only "who is here now".
    occupant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    occupantName: {
      type: String,
      trim: true,
      default: '',
    },

    // Why a bed is unusable — a broken frame, a leak, held for a new admission.
    blockedReason: {
      type: String,
      trim: true,
      maxlength: [200, 'Blocked reason cannot exceed 200 characters'],
      default: '',
    },
  },
  { _id: true }
);

const hostelRoomSchema = new mongoose.Schema(
  {
    roomNumber: {
      type: String,
      required: [true, 'Room number is required'],
      trim: true,
      uppercase: true,
      maxlength: [12, 'Room number cannot exceed 12 characters'],
    },

    block: {
      type: String,
      required: [true, 'Block is required'],
      trim: true,
      uppercase: true,
      maxlength: [30, 'Block name cannot exceed 30 characters'],
    },

    floor: {
      type: Number,
      default: 0,
      min: [0, 'Floor cannot be negative'],
      max: [20, 'Floor cannot exceed 20'],
    },

    hostelType: {
      type: String,
      enum: {
        values: HOSTEL_TYPES,
        message: 'Invalid hostel type',
      },
      required: [true, 'Hostel type is required'],
    },

    roomType: {
      type: String,
      enum: {
        values: ROOM_TYPES,
        message: 'Invalid room type',
      },
      required: [true, 'Room type is required'],
    },

    capacity: {
      type: Number,
      required: [true, 'Capacity is required'],
      min: [1, 'Capacity must be at least 1'],
      max: [30, 'Capacity cannot exceed 30'],
    },

    // Derived in the pre-validate hook from `beds`. Never accepted from a body.
    occupiedBeds: {
      type: Number,
      default: 0,
      min: [0, 'Occupied beds cannot be negative'],
    },

    beds: {
      type: [bedSchema],
      default: [],
    },

    amenities: {
      type: [String],
      default: [],
    },

    monthlyRent: {
      type: Number,
      default: 0,
      min: [0, 'Rent cannot be negative'],
    },

    status: {
      type: String,
      enum: {
        values: ROOM_STATUSES,
        message: 'Invalid room status',
      },
      default: 'available',
    },

    wardenName: {
      type: String,
      trim: true,
      maxlength: [100, 'Warden name cannot exceed 100 characters'],
      default: '',
    },

    wardenPhone: {
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

// A room number is only unique within its block — "101" exists in every block.
hostelRoomSchema.index({ block: 1, roomNumber: 1 }, { unique: true });
hostelRoomSchema.index({ hostelType: 1, status: 1 });
hostelRoomSchema.index({ 'beds.occupant': 1 });

hostelRoomSchema.virtual('bedsAvailable').get(function () {
  return (this.beds || []).filter((bed) => bed.status === 'vacant').length;
});

hostelRoomSchema.virtual('blockedBeds').get(function () {
  return (this.beds || []).filter((bed) => bed.status === 'blocked').length;
});

hostelRoomSchema.virtual('occupancyRate').get(function () {
  const capacity = this.capacity || 0;
  if (!capacity) return 0;
  return Math.round(((this.occupiedBeds || 0) / capacity) * 100);
});

hostelRoomSchema.virtual('label').get(function () {
  return `${this.block}-${this.roomNumber}`;
});

/**
 * Fills the `beds` array out to `capacity` using A, B, C… labels. Called when a
 * room is created so callers never have to hand-write the bed list, and when
 * capacity grows.
 */
hostelRoomSchema.methods.ensureBeds = function () {
  const beds = this.beds || [];

  while (beds.length < this.capacity) {
    const letter = String.fromCharCode(65 + beds.length);
    beds.push({ bedNumber: letter, status: 'vacant', occupant: null });
  }

  this.beds = beds;
  this.markModified('beds');
  return this.beds;
};

hostelRoomSchema.methods.findBed = function (bedNumber) {
  if (!bedNumber) return null;
  const needle = String(bedNumber).trim().toUpperCase();
  return (this.beds || []).find((bed) => bed.bedNumber === needle) || null;
};

hostelRoomSchema.methods.findBedByOccupant = function (studentId) {
  if (!studentId) return null;
  return (
    (this.beds || []).find(
      (bed) => bed.occupant && String(bed.occupant) === String(studentId)
    ) || null
  );
};

hostelRoomSchema.methods.canAcceptOccupant = function () {
  if (this.status === 'maintenance' || this.status === 'closed') return false;
  return this.bedsAvailable > 0;
};

/**
 * Puts a student into a specific bed. Throwing rather than returning a flag so
 * a caller cannot accidentally ignore the failure and save a half-applied
 * change.
 */
hostelRoomSchema.methods.occupyBed = function (bedNumber, studentId, studentName = '') {
  if (this.status === 'maintenance') {
    throw hostelError(`Room ${this.label} is under maintenance and cannot take new boarders`);
  }
  if (this.status === 'closed') {
    throw hostelError(`Room ${this.label} is closed`);
  }

  const bed = this.findBed(bedNumber);
  if (!bed) {
    throw hostelError(`Room ${this.label} has no bed "${bedNumber}"`);
  }
  if (bed.status === 'occupied') {
    throw hostelError(`Bed ${this.label}/${bed.bedNumber} is already taken`);
  }
  if (bed.status === 'blocked') {
    throw hostelError(
      `Bed ${this.label}/${bed.bedNumber} is blocked${bed.blockedReason ? ` (${bed.blockedReason})` : ''}`
    );
  }

  bed.status = 'occupied';
  bed.occupant = studentId;
  bed.occupantName = studentName;
  bed.blockedReason = '';

  this.markModified('beds');
  return bed;
};

/**
 * Frees whichever bed the given student is in. Returns the bed so the caller
 * can report which one was released.
 */
hostelRoomSchema.methods.releaseBedFor = function (studentId) {
  const bed = this.findBedByOccupant(studentId);
  if (!bed) {
    throw hostelError(`That student does not occupy a bed in room ${this.label}`);
  }

  bed.status = 'vacant';
  bed.occupant = null;
  bed.occupantName = '';

  this.markModified('beds');
  return bed;
};

// `occupiedBeds` and `status` are always recomputed from `beds`, which is the
// single source of truth. Maintaining them at each call site is exactly how the
// spreadsheet this replaces drifted out of step.
hostelRoomSchema.pre('validate', async function () {
  if (this.capacity && (this.beds || []).length < this.capacity) {
    this.ensureBeds();
  }

  const beds = this.beds || [];

  if (beds.length > this.capacity) {
    const surplusOccupied = beds
      .slice(this.capacity)
      .filter((bed) => bed.status === 'occupied').length;

    if (surplusOccupied > 0) {
      throw hostelError(
        `Cannot shrink ${this.label} to ${this.capacity} beds — ${surplusOccupied} of the beds being removed are occupied`
      );
    }

    this.beds = beds.slice(0, this.capacity);
  }

  const duplicates = new Set(this.beds.map((bed) => bed.bedNumber));
  if (duplicates.size !== this.beds.length) {
    throw hostelError(`Room ${this.label} has two beds with the same number`);
  }

  this.occupiedBeds = this.beds.filter((bed) => bed.status === 'occupied').length;

  // Maintenance and closed are deliberate operational states set by a warden —
  // they are never overwritten by the derived available/full flip.
  if (this.status !== 'maintenance' && this.status !== 'closed') {
    const anyVacant = this.beds.some((bed) => bed.status === 'vacant');
    this.status = anyVacant ? 'available' : 'full';
  }
});

module.exports = mongoose.model('HostelRoom', hostelRoomSchema);
module.exports.HOSTEL_TYPES = HOSTEL_TYPES;
module.exports.ROOM_TYPES = ROOM_TYPES;
module.exports.ROOM_STATUSES = ROOM_STATUSES;
module.exports.BED_STATUSES = BED_STATUSES;
module.exports.DEFAULT_BED_COUNT = DEFAULT_BED_COUNT;
module.exports.hostelError = hostelError;
