const mongoose = require('mongoose');

/**
 * Bookable shared spaces — the auditorium, the labs, the sports hall.
 *
 * Bookings are embedded rather than living in their own collection, and that is
 * the design decision the whole module rests on. With the bookings inside the
 * facility document, "this room is free at that time" becomes a filter on a
 * single `findOneAndUpdate`:
 *
 *   bookings: { $not: { $elemMatch: { date, status: active,
 *                                     startMinute: { $lt: end },
 *                                     endMinute:   { $gt: start } } } }
 *
 * which makes the double booking impossible rather than unlikely, on a plain
 * `mongod` with no replica set and no transaction. A separate collection would
 * need either a transaction or a unique index over a discretised time grid, and
 * the grid forces every booking onto fixed boundaries.
 *
 * Times are stored as HH:MM strings and as integer minutes. The integers are
 * what the overlap filter compares; string comparison of times works until
 * "09:00" meets "9:00".
 */

const FACILITY_CATEGORIES = [
  'auditorium',
  'laboratory',
  'sports',
  'classroom',
  'library',
  'seminar',
  'other',
];

const FACILITY_STATUSES = ['active', 'maintenance', 'retired'];

const BOOKING_STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'completed'];

// A booking in one of these states is holding the room. A pending request holds
// it too: approving a request whose slot was taken while it sat in the queue is
// worse than making somebody wait.
const ACTIVE_BOOKING_STATUSES = ['pending', 'approved'];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toMinutes(time) {
  if (typeof time !== 'string' || !TIME_PATTERN.test(time)) return null;
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return null;
  const clamped = Math.max(0, Math.min(1440, minutes));
  const hh = String(Math.floor(clamped / 60)).padStart(2, '0');
  const mm = String(clamped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function todayKey(now = new Date()) {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/** Days between two YYYY-MM-DD keys, positive when `to` is later. */
function daysBetween(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const a = Date.UTC(fy, fm - 1, fd);
  const b = Date.UTC(ty, tm - 1, td);
  return Math.round((b - a) / 86400000);
}

const facilityBookingSchema = new mongoose.Schema(
  {
    reference: {
      type: String,
      required: true,
      trim: true,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    requesterName: {
      type: String,
      trim: true,
    },
    title: {
      type: String,
      required: [true, 'Say what the room is for'],
      trim: true,
      minlength: [3, 'Title must be at least 3 characters'],
      maxlength: [120, 'Title cannot exceed 120 characters'],
    },
    purpose: {
      type: String,
      trim: true,
      maxlength: [400, 'Purpose cannot exceed 400 characters'],
      default: null,
    },
    date: {
      type: String,
      required: [true, 'Date is required'],
      match: [DATE_PATTERN, 'Date must be in YYYY-MM-DD format'],
    },
    startTime: {
      type: String,
      required: [true, 'Start time is required'],
      match: [TIME_PATTERN, 'Start time must be in HH:MM format'],
    },
    endTime: {
      type: String,
      required: [true, 'End time is required'],
      match: [TIME_PATTERN, 'End time must be in HH:MM format'],
    },
    // The interval the database actually protects. Set by the controller from
    // the requested times widened by the facility's buffer, so setup and
    // clear-down are part of the guarded window rather than a note somebody is
    // supposed to read.
    startMinute: {
      type: Number,
      required: true,
      min: 0,
      max: 1440,
    },
    endMinute: {
      type: Number,
      required: true,
      min: 0,
      max: 1440,
    },
    // The times the requester actually asked for, before the buffer. Shown to
    // humans; never used in the overlap filter.
    requestedStartMinute: {
      type: Number,
      min: 0,
      max: 1439,
    },
    requestedEndMinute: {
      type: Number,
      min: 0,
      max: 1440,
    },
    expectedAttendance: {
      type: Number,
      min: [1, 'Expected attendance must be at least one person'],
      default: 1,
    },
    status: {
      type: String,
      enum: BOOKING_STATUSES,
      default: 'pending',
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
    rejectionReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Rejection reason cannot exceed 300 characters'],
      default: null,
    },
    cancelReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Cancellation reason cannot exceed 300 characters'],
      default: null,
    },
    setupNotes: {
      type: String,
      trim: true,
      maxlength: [500, 'Setup notes cannot exceed 500 characters'],
      default: null,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const facilitySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [120, 'Name cannot exceed 120 characters'],
    },
    code: {
      type: String,
      required: [true, 'A short code is required'],
      trim: true,
      uppercase: true,
      unique: true,
      maxlength: [20, 'Code cannot exceed 20 characters'],
    },
    category: {
      type: String,
      enum: FACILITY_CATEGORIES,
      default: 'classroom',
      index: true,
    },
    building: {
      type: String,
      trim: true,
      maxlength: [80, 'Building cannot exceed 80 characters'],
      default: null,
    },
    floor: {
      type: String,
      trim: true,
      maxlength: [30, 'Floor cannot exceed 30 characters'],
      default: null,
    },
    capacity: {
      type: Number,
      required: [true, 'Capacity is required'],
      min: [1, 'Capacity must be at least one'],
      max: [5000, 'Capacity looks wrong'],
    },
    amenities: {
      type: [String],
      default: [],
    },
    openingTime: {
      type: String,
      default: '07:00',
      match: [TIME_PATTERN, 'Opening time must be in HH:MM format'],
    },
    closingTime: {
      type: String,
      default: '19:00',
      match: [TIME_PATTERN, 'Closing time must be in HH:MM format'],
    },
    openingMinute: { type: Number, min: 0, max: 1439 },
    closingMinute: { type: Number, min: 0, max: 1440 },
    // Setup and clear-down time reserved on each side of every booking.
    bufferMinutes: {
      type: Number,
      default: 0,
      min: [0, 'Buffer cannot be negative'],
      max: [120, 'Buffer cannot exceed two hours'],
    },
    requiresApproval: {
      type: Boolean,
      default: false,
    },
    minBookingMinutes: {
      type: Number,
      default: 30,
      min: [5, 'Minimum booking cannot be under 5 minutes'],
      max: [480, 'Minimum booking cannot exceed 8 hours'],
    },
    maxBookingMinutes: {
      type: Number,
      default: 240,
      min: [5, 'Maximum booking cannot be under 5 minutes'],
      max: [720, 'Maximum booking cannot exceed 12 hours'],
    },
    maxAdvanceDays: {
      type: Number,
      default: 90,
      min: [1, 'Bookings must be possible at least one day ahead'],
      max: [730, 'Two years ahead is not a booking, it is a plan'],
    },
    status: {
      type: String,
      enum: FACILITY_STATUSES,
      default: 'active',
      index: true,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [1000, 'Notes cannot exceed 1000 characters'],
      default: null,
    },
    bookings: {
      type: [facilityBookingSchema],
      default: [],
    },
  },
  { timestamps: true }
);

facilitySchema.index({ status: 1, category: 1 });
facilitySchema.index({ 'bookings.date': 1, 'bookings.status': 1 });
facilitySchema.index({ 'bookings.requestedBy': 1 });

/**
 * Derives the opening-hour integers and checks the facility's own settings hang
 * together.
 *
 * An async function that throws, not a callback-style hook: Mongoose 9 skips
 * the old form silently, and here that would leave `openingMinute` undefined,
 * which would make every "inside opening hours" comparison quietly pass.
 */
facilitySchema.pre('validate', async function derive() {
  this.openingMinute = toMinutes(this.openingTime);
  this.closingMinute = toMinutes(this.closingTime);

  if (this.openingMinute === null || this.closingMinute === null) {
    // The `match` validators report the real problem.
    return;
  }

  if (this.closingMinute <= this.openingMinute) {
    this.invalidate('closingTime', 'A facility must close after it opens');
    return;
  }

  if (this.maxBookingMinutes < this.minBookingMinutes) {
    this.invalidate(
      'maxBookingMinutes',
      'The maximum booking length cannot be shorter than the minimum'
    );
    return;
  }

  if (this.minBookingMinutes > this.closingMinute - this.openingMinute) {
    this.invalidate(
      'minBookingMinutes',
      'The minimum booking is longer than the facility is open'
    );
  }
});

facilitySchema.virtual('openMinutesPerDay').get(function openMinutesPerDay() {
  return Math.max(0, (this.closingMinute || 0) - (this.openingMinute || 0));
});

facilitySchema.virtual('activeBookingCount').get(function activeBookingCount() {
  return this.bookings.filter((booking) =>
    ACTIVE_BOOKING_STATUSES.includes(booking.status)
  ).length;
});

/**
 * Why a request for this window cannot be made, in words.
 *
 * This checks everything except the clash — opening hours, length, how far
 * ahead, the facility being open for business. The clash is not checked here on
 * purpose: it is the conditional update's job, and duplicating it in a
 * read-then-check helper is how a codebase ends up trusting the copy.
 */
facilitySchema.methods.requestError = function requestError(request, now = new Date()) {
  const { date, startMinute, endMinute } = request;

  if (this.status === 'retired') return 'This facility is no longer bookable.';
  if (this.status === 'maintenance') {
    return 'This facility is closed for maintenance.';
  }

  if (!DATE_PATTERN.test(date || '')) return 'Give a date in YYYY-MM-DD format.';
  if (startMinute === null || endMinute === null) {
    return 'Give a start and end time in HH:MM format.';
  }
  if (endMinute <= startMinute) return 'The end time must be after the start time.';

  const today = todayKey(now);
  if (date < today) return 'That date has passed.';

  const ahead = daysBetween(today, date);
  if (ahead > this.maxAdvanceDays) {
    return `${this.name} can only be booked ${this.maxAdvanceDays} days ahead.`;
  }

  const length = endMinute - startMinute;
  if (length < this.minBookingMinutes) {
    return `The shortest booking for ${this.name} is ${this.minBookingMinutes} minutes.`;
  }
  if (length > this.maxBookingMinutes) {
    return `The longest booking for ${this.name} is ${this.maxBookingMinutes} minutes.`;
  }

  if (startMinute < this.openingMinute || endMinute > this.closingMinute) {
    return `${this.name} is open from ${this.openingTime} to ${this.closingTime}.`;
  }

  return null;
};

/**
 * The interval the database will guard for a requested window: the request
 * widened by the buffer on each side, clamped to the day.
 */
facilitySchema.methods.guardedWindow = function guardedWindow(startMinute, endMinute) {
  return {
    startMinute: Math.max(0, startMinute - this.bufferMinutes),
    endMinute: Math.min(1440, endMinute + this.bufferMinutes),
  };
};

facilitySchema.methods.bookingsOn = function bookingsOn(date) {
  return this.bookings
    .filter(
      (booking) =>
        booking.date === date && ACTIVE_BOOKING_STATUSES.includes(booking.status)
    )
    .sort((a, b) => a.startMinute - b.startMinute);
};

/**
 * The gaps left on a date, as [start, end) windows in minutes.
 *
 * Derived from the guarded intervals, so a gap this returns is genuinely
 * bookable rather than one that will be refused by the buffer a moment later.
 */
facilitySchema.methods.freeWindowsOn = function freeWindowsOn(date) {
  const taken = this.bookingsOn(date);
  const windows = [];

  let cursor = this.openingMinute;
  for (const booking of taken) {
    if (booking.startMinute > cursor) {
      windows.push({ startMinute: cursor, endMinute: Math.min(booking.startMinute, this.closingMinute) });
    }
    cursor = Math.max(cursor, booking.endMinute);
    if (cursor >= this.closingMinute) break;
  }
  if (cursor < this.closingMinute) {
    windows.push({ startMinute: cursor, endMinute: this.closingMinute });
  }

  return windows
    .filter((window) => window.endMinute - window.startMinute >= this.minBookingMinutes)
    .map((window) => ({
      ...window,
      startTime: formatMinutes(window.startMinute),
      endTime: formatMinutes(window.endMinute),
      minutes: window.endMinute - window.startMinute,
    }));
};

/**
 * Serialises the facility for a viewer.
 *
 * Everyone signed in can see that a room is taken and by which department —
 * that is the point of a shared calendar. What a booking is *for* in detail,
 * and who to chase about it, stays with the requester and staff.
 */
facilitySchema.methods.redactFor = function redactFor(viewer) {
  const plain = this.toObject({ virtuals: true });
  delete plain.__v;

  const viewerId = viewer && (viewer._id || viewer.id);
  const isStaff = viewer && ['teacher', 'admin'].includes(viewer.role);
  if (isStaff) return plain;

  plain.bookings = (plain.bookings || []).map((booking) => {
    if (viewerId && String(booking.requestedBy) === String(viewerId)) return booking;
    return {
      _id: booking._id,
      date: booking.date,
      startTime: booking.startTime,
      endTime: booking.endTime,
      startMinute: booking.startMinute,
      endMinute: booking.endMinute,
      status: booking.status,
      title: 'Reserved',
    };
  });
  return plain;
};

facilitySchema.statics.toMinutes = toMinutes;
facilitySchema.statics.formatMinutes = formatMinutes;
facilitySchema.statics.todayKey = todayKey;
facilitySchema.statics.daysBetween = daysBetween;
facilitySchema.statics.FACILITY_CATEGORIES = FACILITY_CATEGORIES;
facilitySchema.statics.FACILITY_STATUSES = FACILITY_STATUSES;
facilitySchema.statics.BOOKING_STATUSES = BOOKING_STATUSES;
facilitySchema.statics.ACTIVE_BOOKING_STATUSES = ACTIVE_BOOKING_STATUSES;

facilitySchema.set('toObject', { virtuals: true });
facilitySchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Facility', facilitySchema);
