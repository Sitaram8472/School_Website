const mongoose = require('mongoose');

/**
 * Parent-Teacher meeting slots.
 *
 * A teacher publishes a bounded window ("Tuesday 16:00-16:20, room 204, three
 * seats") and families book against it. The seat count lives in `bookedCount`
 * rather than being read off `bookings.length` on purpose: it lets the
 * controller enforce capacity in a single conditional update instead of a
 * read-compare-write, which is the difference between a booking system and a
 * spreadsheet with a submit button.
 */

// How late a family may still book, measured back from the slot start.
const DEFAULT_BOOKING_CUTOFF_MINUTES = 120;

// How late a family may still release their seat.
const DEFAULT_CANCELLATION_CUTOFF_MINUTES = 120;

const MIN_SLOT_MINUTES = 5;
const MAX_SLOT_MINUTES = 240;

const SLOT_STATUSES = ['open', 'full', 'closed', 'cancelled', 'completed'];

const BOOKING_STATUSES = [
  'booked',
  'cancelled-by-parent',
  'cancelled-by-teacher',
  'attended',
  'no-show',
];

// A booking in one of these states is holding a seat.
const ACTIVE_BOOKING_STATUSES = ['booked', 'attended', 'no-show'];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * "16:30" -> 990. Returns null for anything that is not a valid HH:MM string,
 * so callers can tell "not supplied" apart from midnight.
 */
function toMinutes(time) {
  if (typeof time !== 'string' || !TIME_PATTERN.test(time)) return null;
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Combines a YYYY-MM-DD date and an HH:MM time into a Date in the server's
 * local zone. The whole module works in one zone; a school runs on the clock
 * on the wall, not on UTC.
 */
function toDateTime(date, time) {
  const minutes = toMinutes(time);
  if (!DATE_PATTERN.test(date || '') || minutes === null) return null;
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day, Math.floor(minutes / 60), minutes % 60, 0, 0);
}

const bookingSchema = new mongoose.Schema(
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
    // Who will actually walk through the door. `User` has no `parent` role, so
    // the account belongs to the family and this records the human.
    guardianName: {
      type: String,
      required: [true, 'Guardian name is required'],
      trim: true,
      maxlength: [80, 'Guardian name cannot exceed 80 characters'],
    },
    studentName: {
      type: String,
      required: [true, 'Student name is required'],
      trim: true,
      maxlength: [80, 'Student name cannot exceed 80 characters'],
    },
    className: {
      type: String,
      trim: true,
      maxlength: [30, 'Class name cannot exceed 30 characters'],
    },
    contactNumber: {
      type: String,
      trim: true,
      maxlength: [20, 'Contact number cannot exceed 20 characters'],
    },
    agenda: {
      type: String,
      required: [true, 'Please say what you would like to discuss'],
      trim: true,
      minlength: [10, 'Agenda must be at least 10 characters'],
      maxlength: [500, 'Agenda cannot exceed 500 characters'],
    },
    status: {
      type: String,
      enum: BOOKING_STATUSES,
      default: 'booked',
    },
    bookedAt: {
      type: Date,
      default: Date.now,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancelReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Cancellation reason cannot exceed 300 characters'],
      default: null,
    },
    // Written by the teacher after the meeting. Visible to the family.
    outcomeNote: {
      type: String,
      trim: true,
      maxlength: [1000, 'Outcome note cannot exceed 1000 characters'],
      default: null,
    },
    outcomeRecordedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: true }
);

const meetingSlotSchema = new mongoose.Schema(
  {
    teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Teacher is required'],
      index: true,
    },
    teacherName: {
      type: String,
      trim: true,
    },
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      minlength: [3, 'Title must be at least 3 characters'],
      maxlength: [120, 'Title cannot exceed 120 characters'],
    },
    purpose: {
      type: String,
      enum: ['ptm', 'academic-concern', 'counselling', 'admission', 'general'],
      default: 'ptm',
    },
    mode: {
      type: String,
      enum: ['in-person', 'online'],
      default: 'in-person',
    },
    // Room number for in-person, meeting link for online.
    location: {
      type: String,
      required: [true, 'Location or meeting link is required'],
      trim: true,
      maxlength: [300, 'Location cannot exceed 300 characters'],
    },
    date: {
      type: String,
      required: [true, 'Date is required'],
      match: [DATE_PATTERN, 'Date must be in YYYY-MM-DD format'],
      index: true,
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
    // Derived from startTime/endTime so overlap checks are integer comparisons
    // rather than string comparisons, which quietly work until "09:00" meets
    // "9:00".
    startMinute: {
      type: Number,
      min: 0,
      max: 1439,
    },
    endMinute: {
      type: Number,
      min: 0,
      max: 1440,
    },
    capacity: {
      type: Number,
      required: true,
      min: [1, 'A slot must have at least one seat'],
      max: [20, 'A slot cannot have more than 20 seats'],
      default: 1,
    },
    // Server-owned. See the capacity guard in the controller.
    bookedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: SLOT_STATUSES,
      default: 'open',
      index: true,
    },
    bookingCutoffMinutes: {
      type: Number,
      default: DEFAULT_BOOKING_CUTOFF_MINUTES,
      min: [0, 'Booking cutoff cannot be negative'],
      max: [10080, 'Booking cutoff cannot exceed a week'],
    },
    cancellationCutoffMinutes: {
      type: Number,
      default: DEFAULT_CANCELLATION_CUTOFF_MINUTES,
      min: [0, 'Cancellation cutoff cannot be negative'],
      max: [10080, 'Cancellation cutoff cannot exceed a week'],
    },
    // Derived from the slot start and the cutoff. Never accepted from a client.
    bookingClosesAt: {
      type: Date,
    },
    notesForParents: {
      type: String,
      trim: true,
      maxlength: [500, 'Notes cannot exceed 500 characters'],
      default: null,
    },
    cancelReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Cancellation reason cannot exceed 300 characters'],
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    bookings: {
      type: [bookingSchema],
      default: [],
    },
  },
  { timestamps: true }
);

meetingSlotSchema.index({ teacher: 1, date: 1, startMinute: 1 });
meetingSlotSchema.index({ status: 1, date: 1 });
meetingSlotSchema.index({ 'bookings.requestedBy': 1 });

/**
 * Derives everything the client is not allowed to set. Mongoose 9 has dropped
 * callback-style middleware, so this is an async function that throws rather
 * than one that calls `next(err)` — a hook written the old way is silently
 * skipped, which would take the derivation of `bookingClosesAt` with it.
 */
meetingSlotSchema.pre('validate', async function derive() {
  this.startMinute = toMinutes(this.startTime);
  this.endMinute = toMinutes(this.endTime);

  if (this.startMinute === null || this.endMinute === null) {
    // The `match` validators will report the real problem; bail out so the
    // arithmetic below does not run on nulls.
    return;
  }

  const duration = this.endMinute - this.startMinute;
  if (duration < MIN_SLOT_MINUTES) {
    this.invalidate(
      'endTime',
      `A slot must run for at least ${MIN_SLOT_MINUTES} minutes`
    );
    return;
  }
  if (duration > MAX_SLOT_MINUTES) {
    this.invalidate(
      'endTime',
      `A slot cannot run for more than ${MAX_SLOT_MINUTES} minutes`
    );
    return;
  }

  const startsAt = toDateTime(this.date, this.startTime);
  if (!startsAt) return;

  if (this.isNew && startsAt.getTime() <= Date.now()) {
    this.invalidate('date', 'A slot cannot be published in the past');
    return;
  }

  this.bookingClosesAt = new Date(
    startsAt.getTime() - this.bookingCutoffMinutes * 60 * 1000
  );

  if (this.bookedCount > this.capacity) {
    this.invalidate('capacity', 'Capacity cannot be lower than the seats already booked');
  }
});

meetingSlotSchema.virtual('seatsLeft').get(function seatsLeft() {
  return Math.max(0, this.capacity - this.bookedCount);
});

meetingSlotSchema.virtual('startsAt').get(function startsAt() {
  return toDateTime(this.date, this.startTime);
});

meetingSlotSchema.virtual('endsAt').get(function endsAt() {
  return toDateTime(this.date, this.endTime);
});

meetingSlotSchema.virtual('hasStarted').get(function hasStarted() {
  const startsAt = toDateTime(this.date, this.startTime);
  return startsAt ? startsAt.getTime() <= Date.now() : false;
});

meetingSlotSchema.virtual('hasEnded').get(function hasEnded() {
  const endsAt = toDateTime(this.date, this.endTime);
  return endsAt ? endsAt.getTime() <= Date.now() : false;
});

/**
 * Whether a family could book this slot right now. The atomic guard in the
 * controller is still the authority — this exists so the UI can grey out a
 * button, and so `bookabilityError()` can explain why.
 */
meetingSlotSchema.virtual('isBookable').get(function isBookable() {
  return this.bookabilityError() === null;
});

meetingSlotSchema.methods.bookabilityError = function bookabilityError(now = new Date()) {
  if (this.status === 'cancelled') return 'This slot has been cancelled.';
  if (this.status === 'closed') return 'Booking for this slot is closed.';
  if (this.status === 'completed') return 'This slot has already taken place.';
  if (this.bookedCount >= this.capacity) return 'This slot is fully booked.';
  if (this.bookingClosesAt && now.getTime() > this.bookingClosesAt.getTime()) {
    return 'Booking for this slot has closed.';
  }
  const startsAt = toDateTime(this.date, this.startTime);
  if (startsAt && startsAt.getTime() <= now.getTime()) {
    return 'This slot has already started.';
  }
  return null;
};

/**
 * Whether a booking may still be released. After the cutoff the family has to
 * speak to the teacher — a seat given back ten minutes before the meeting is
 * a seat nobody else can take, so releasing it only costs the teacher a
 * no-show they could have known about.
 */
meetingSlotSchema.methods.cancellationError = function cancellationError(now = new Date()) {
  const startsAt = toDateTime(this.date, this.startTime);
  if (!startsAt) return null;
  const cutoff = startsAt.getTime() - this.cancellationCutoffMinutes * 60 * 1000;
  if (now.getTime() > cutoff) {
    return `Bookings can only be cancelled up to ${this.cancellationCutoffMinutes} minutes before the meeting. Please contact the teacher directly.`;
  }
  return null;
};

meetingSlotSchema.methods.activeBookings = function activeBookings() {
  return this.bookings.filter((booking) =>
    ACTIVE_BOOKING_STATUSES.includes(booking.status)
  );
};

meetingSlotSchema.methods.findBookingFor = function findBookingFor(userId) {
  const wanted = String(userId);
  return (
    this.bookings.find(
      (booking) =>
        String(booking.requestedBy) === wanted &&
        ACTIVE_BOOKING_STATUSES.includes(booking.status)
    ) || null
  );
};

/**
 * Serialises the slot for a given viewer.
 *
 * The teacher who owns the slot, and any admin, sees every booking. Everyone
 * else sees seat counts and their own booking — a family browsing Tuesday
 * afternoon has no business reading why the family in the 16:20 slot asked for
 * a meeting. This is done here, once, rather than by each handler remembering
 * to omit `bookings`.
 */
meetingSlotSchema.methods.redactFor = function redactFor(viewer) {
  const plain = this.toObject({ virtuals: true });
  delete plain.__v;

  const viewerId = viewer && (viewer._id || viewer.id);
  const isOwner = viewerId && String(this.teacher) === String(viewerId);
  const isAdmin = viewer && viewer.role === 'admin';

  if (isOwner || isAdmin) return plain;

  plain.bookings = (plain.bookings || []).filter(
    (booking) => viewerId && String(booking.requestedBy) === String(viewerId)
  );
  return plain;
};

/**
 * Two [start, end) windows on the same day overlap when each starts before the
 * other ends. Touching windows (16:00-16:20 and 16:20-16:40) do not overlap,
 * which is the whole point of back-to-back slots.
 */
meetingSlotSchema.statics.overlaps = function overlaps(a, b) {
  return a.startMinute < b.endMinute && b.startMinute < a.endMinute;
};

meetingSlotSchema.statics.toMinutes = toMinutes;
meetingSlotSchema.statics.toDateTime = toDateTime;
meetingSlotSchema.statics.SLOT_STATUSES = SLOT_STATUSES;
meetingSlotSchema.statics.BOOKING_STATUSES = BOOKING_STATUSES;
meetingSlotSchema.statics.ACTIVE_BOOKING_STATUSES = ACTIVE_BOOKING_STATUSES;

meetingSlotSchema.set('toObject', { virtuals: true });
meetingSlotSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('MeetingSlot', meetingSlotSchema);
