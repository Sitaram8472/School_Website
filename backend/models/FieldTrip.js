const mongoose = require('mongoose');

/**
 * Field trips and excursions.
 *
 * The rule the whole model is shaped around: a participant record cannot exist
 * without the consent that authorised it. Consent is a required subdocument of
 * the participant, in the same write, so there is no state in which a child is
 * on the list and the paperwork is "coming tomorrow" — that state is the reason
 * paper consent slips fail.
 *
 * `confirmedCount` is a server-owned counter rather than `participants.length`
 * for the same reason `MeetingSlot.bookedCount` is: it lets capacity be
 * enforced by one conditional update instead of a read-compare-write, which is
 * the difference between a booking system and a form that submits.
 */

const TRIP_PURPOSES = [
  'academic',
  'cultural',
  'sports',
  'community-service',
  'recreational',
];

const TRIP_STATUSES = ['draft', 'open', 'closed', 'cancelled', 'completed'];

const TRANSPORT_MODES = ['coach', 'school-bus', 'train', 'walking', 'other'];

const PARTICIPANT_STATUSES = [
  'confirmed',
  'withdrawn',
  'attended',
  'absent',
];

// A participant in one of these states is holding a seat.
const ACTIVE_PARTICIPANT_STATUSES = ['confirmed', 'attended', 'absent'];

const PAYMENT_STATUSES = ['not-required', 'pending', 'paid', 'waived', 'refunded'];

/**
 * The consent statement is versioned. Recording that somebody consented is
 * close to useless without recording what they were shown — a statement that
 * changes next term would otherwise rewrite what every past guardian agreed to.
 */
const CONSENT_STATEMENT_VERSION = '2026-01';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function todayKey(now = new Date()) {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/** YYYY-MM-DD plus HH:MM as a Date in the server's local zone. */
function toDateTime(date, time) {
  if (!DATE_PATTERN.test(date || '')) return null;
  const [year, month, day] = date.split('-').map(Number);
  if (!TIME_PATTERN.test(time || '')) {
    return new Date(year, month - 1, day, 0, 0, 0, 0);
  }
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

const consentSchema = new mongoose.Schema(
  {
    // The account that submitted the consent. Not necessarily the guardian —
    // hence the typed name below.
    givenBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Consent must record who gave it'],
    },
    // What the guardian typed to sign. A checkbox records that a click
    // happened; a typed name records who agreed.
    guardianTypedName: {
      type: String,
      required: [true, 'The guardian must type their name to consent'],
      trim: true,
      minlength: [3, 'Typed name must be at least 3 characters'],
      maxlength: [80, 'Typed name cannot exceed 80 characters'],
    },
    statementVersion: {
      type: String,
      required: true,
      default: CONSENT_STATEMENT_VERSION,
    },
    givenAt: {
      type: Date,
      default: Date.now,
    },
    // Explicit and separate: a guardian may consent to the trip and refuse
    // permission for first aid to be administered, and the escort needs to know.
    medicalTreatmentConsent: {
      type: Boolean,
      default: true,
    },
    photographyConsent: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false }
);

const participantSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    studentName: {
      type: String,
      required: [true, 'Student name is required'],
      trim: true,
      maxlength: [80, 'Student name cannot exceed 80 characters'],
    },
    className: {
      type: String,
      required: [true, 'Class is required'],
      trim: true,
      maxlength: [40, 'Class cannot exceed 40 characters'],
    },
    registeredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    guardianName: {
      type: String,
      required: [true, 'Guardian name is required'],
      trim: true,
      maxlength: [80, 'Guardian name cannot exceed 80 characters'],
    },
    guardianContact: {
      type: String,
      required: [true, 'A contact number is required'],
      trim: true,
      maxlength: [20, 'Contact number cannot exceed 20 characters'],
    },
    emergencyContactNumber: {
      type: String,
      trim: true,
      maxlength: [20, 'Emergency number cannot exceed 20 characters'],
      default: null,
    },
    // These two travel with the trip. They are the reason the manifest exists.
    medicalNotes: {
      type: String,
      trim: true,
      maxlength: [1000, 'Medical notes cannot exceed 1000 characters'],
      default: null,
    },
    dietaryNotes: {
      type: String,
      trim: true,
      maxlength: [500, 'Dietary notes cannot exceed 500 characters'],
      default: null,
    },
    consent: {
      type: consentSchema,
      required: [true, 'A participant cannot be added without consent'],
    },
    status: {
      type: String,
      enum: PARTICIPANT_STATUSES,
      default: 'confirmed',
    },
    paymentStatus: {
      type: String,
      enum: PAYMENT_STATUSES,
      default: 'pending',
    },
    paymentNote: {
      type: String,
      trim: true,
      maxlength: [200, 'Payment note cannot exceed 200 characters'],
      default: null,
    },
    registeredAt: {
      type: Date,
      default: Date.now,
    },
    withdrawnAt: {
      type: Date,
      default: null,
    },
    withdrawReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Withdrawal reason cannot exceed 300 characters'],
      default: null,
    },
    attendanceMarkedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: true }
);

const fieldTripSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      minlength: [3, 'Title must be at least 3 characters'],
      maxlength: [140, 'Title cannot exceed 140 characters'],
    },
    destination: {
      type: String,
      required: [true, 'Destination is required'],
      trim: true,
      maxlength: [200, 'Destination cannot exceed 200 characters'],
    },
    purpose: {
      type: String,
      enum: TRIP_PURPOSES,
      default: 'academic',
    },
    description: {
      type: String,
      trim: true,
      maxlength: [2000, 'Description cannot exceed 2000 characters'],
      default: null,
    },
    departureDate: {
      type: String,
      required: [true, 'Departure date is required'],
      match: [DATE_PATTERN, 'Departure date must be in YYYY-MM-DD format'],
      index: true,
    },
    returnDate: {
      type: String,
      required: [true, 'Return date is required'],
      match: [DATE_PATTERN, 'Return date must be in YYYY-MM-DD format'],
    },
    departureTime: {
      type: String,
      required: [true, 'Departure time is required'],
      match: [TIME_PATTERN, 'Departure time must be in HH:MM format'],
    },
    returnTime: {
      type: String,
      required: [true, 'Return time is required'],
      match: [TIME_PATTERN, 'Return time must be in HH:MM format'],
    },
    meetingPoint: {
      type: String,
      required: [true, 'A meeting point is required'],
      trim: true,
      maxlength: [200, 'Meeting point cannot exceed 200 characters'],
    },
    transportMode: {
      type: String,
      enum: TRANSPORT_MODES,
      default: 'coach',
    },
    costPerStudent: {
      type: Number,
      default: 0,
      min: [0, 'Cost cannot be negative'],
      max: [1000000, 'Cost looks wrong'],
    },
    capacity: {
      type: Number,
      required: [true, 'Capacity is required'],
      min: [1, 'A trip needs at least one seat'],
      max: [500, 'A trip cannot carry more than 500 students'],
    },
    // Server-owned. See the capacity guard in the controller.
    confirmedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    eligibleClasses: {
      type: [String],
      default: [],
    },
    organiser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    organiserName: {
      type: String,
      trim: true,
    },
    // Staff travelling with the group. They can read the manifest; nobody else
    // outside the office can.
    staffEscorts: {
      type: [
        {
          staff: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          name: { type: String, trim: true },
          phone: { type: String, trim: true },
        },
      ],
      default: [],
    },
    emergencyContact: {
      type: String,
      required: [true, 'An emergency contact for the trip is required'],
      trim: true,
      maxlength: [120, 'Emergency contact cannot exceed 120 characters'],
    },
    // Registration closes here. After it, a seat is spent whether or not the
    // child travels, because the coach has been booked.
    consentDeadline: {
      type: String,
      required: [true, 'A consent deadline is required'],
      match: [DATE_PATTERN, 'Consent deadline must be in YYYY-MM-DD format'],
    },
    status: {
      type: String,
      enum: TRIP_STATUSES,
      default: 'draft',
      index: true,
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
    participants: {
      type: [participantSchema],
      default: [],
    },
  },
  { timestamps: true }
);

fieldTripSchema.index({ status: 1, departureDate: 1 });
fieldTripSchema.index({ 'participants.registeredBy': 1 });
fieldTripSchema.index({ 'participants.student': 1 });

/**
 * Validates the dates and keeps the counter honest.
 *
 * Written as an async function that throws rather than one calling `next(err)`:
 * Mongoose 9 dropped callback-style middleware and silently skips a hook
 * written the old way, which here would let a trip return before it departs.
 */
fieldTripSchema.pre('validate', async function derive() {
  if (!DATE_PATTERN.test(this.departureDate || '') || !DATE_PATTERN.test(this.returnDate || '')) {
    return;
  }

  if (this.returnDate < this.departureDate) {
    this.invalidate('returnDate', 'A trip cannot return before it departs');
    return;
  }

  if (
    this.returnDate === this.departureDate &&
    TIME_PATTERN.test(this.returnTime || '') &&
    TIME_PATTERN.test(this.departureTime || '') &&
    this.returnTime <= this.departureTime
  ) {
    this.invalidate('returnTime', 'A same-day trip must return after it departs');
    return;
  }

  if (DATE_PATTERN.test(this.consentDeadline || '') && this.consentDeadline > this.departureDate) {
    this.invalidate('consentDeadline', 'Consent must close on or before the departure date');
    return;
  }

  if (this.isNew && this.departureDate < todayKey()) {
    this.invalidate('departureDate', 'A trip cannot be created in the past');
    return;
  }

  if (this.confirmedCount > this.capacity) {
    this.invalidate('capacity', 'Capacity cannot be lower than the seats already taken');
  }
});

fieldTripSchema.virtual('seatsLeft').get(function seatsLeft() {
  return Math.max(0, this.capacity - this.confirmedCount);
});

fieldTripSchema.virtual('departsAt').get(function departsAt() {
  return toDateTime(this.departureDate, this.departureTime);
});

fieldTripSchema.virtual('returnsAt').get(function returnsAt() {
  return toDateTime(this.returnDate, this.returnTime);
});

fieldTripSchema.virtual('consentClosed').get(function consentClosed() {
  return this.consentDeadline < todayKey();
});

fieldTripSchema.virtual('hasDeparted').get(function hasDeparted() {
  const departsAt = toDateTime(this.departureDate, this.departureTime);
  return departsAt ? departsAt.getTime() <= Date.now() : false;
});

fieldTripSchema.virtual('isOpen').get(function isOpen() {
  return this.registrationError() === null;
});

/**
 * Why a family cannot register right now, in words. The atomic guard in the
 * controller is the authority; this is the error message and the greyed-out
 * button, not the check.
 */
fieldTripSchema.methods.registrationError = function registrationError(now = new Date()) {
  if (this.status === 'draft') return 'This trip has not been published yet.';
  if (this.status === 'cancelled') return 'This trip has been cancelled.';
  if (this.status === 'closed') return 'Registration for this trip has closed.';
  if (this.status === 'completed') return 'This trip has already taken place.';
  if (this.confirmedCount >= this.capacity) return 'This trip is full.';
  if (this.consentDeadline < todayKey(now)) {
    return 'The consent deadline for this trip has passed.';
  }
  const departsAt = toDateTime(this.departureDate, this.departureTime);
  if (departsAt && departsAt.getTime() <= now.getTime()) {
    return 'This trip has already departed.';
  }
  return null;
};

/**
 * Whether a seat may still be handed back. After the consent deadline the coach
 * is booked and the seat is spent — saying so plainly is more honest than
 * quietly refusing.
 */
fieldTripSchema.methods.withdrawalError = function withdrawalError(now = new Date()) {
  if (this.status === 'cancelled') return 'This trip has been cancelled.';
  if (this.consentDeadline < todayKey(now)) {
    return 'The consent deadline has passed, so the seat can no longer be released. Speak to the organiser.';
  }
  return null;
};

fieldTripSchema.methods.activeParticipants = function activeParticipants() {
  return this.participants.filter((participant) =>
    ACTIVE_PARTICIPANT_STATUSES.includes(participant.status)
  );
};

fieldTripSchema.methods.findRegistrationBy = function findRegistrationBy(userId) {
  const wanted = String(userId);
  return (
    this.participants.find(
      (participant) =>
        String(participant.registeredBy) === wanted &&
        ACTIVE_PARTICIPANT_STATUSES.includes(participant.status)
    ) || null
  );
};

fieldTripSchema.methods.isEscort = function isEscort(userId) {
  const wanted = String(userId);
  if (String(this.organiser) === wanted) return true;
  return this.staffEscorts.some(
    (escort) => escort.staff && String(escort.staff) === wanted
  );
};

/**
 * Serialises the trip for a given viewer.
 *
 * Organisers, escorts and admins see the full participant list. Everyone else
 * sees seat counts and their own registrations — a family browsing trips has no
 * business reading another child's medical notes, and a class list carrying
 * allergies is not something to hand to every signed-in account.
 *
 * Done here, once, rather than by each handler remembering to strip it.
 */
fieldTripSchema.methods.redactFor = function redactFor(viewer) {
  const plain = this.toObject({ virtuals: true });
  delete plain.__v;

  const viewerId = viewer && (viewer._id || viewer.id);
  const isAdmin = viewer && viewer.role === 'admin';

  if (isAdmin || (viewerId && this.isEscort(viewerId))) return plain;

  plain.participants = (plain.participants || []).filter(
    (participant) =>
      viewerId && String(participant.registeredBy) === String(viewerId)
  );
  return plain;
};

fieldTripSchema.statics.todayKey = todayKey;
fieldTripSchema.statics.toDateTime = toDateTime;
fieldTripSchema.statics.TRIP_PURPOSES = TRIP_PURPOSES;
fieldTripSchema.statics.TRIP_STATUSES = TRIP_STATUSES;
fieldTripSchema.statics.TRANSPORT_MODES = TRANSPORT_MODES;
fieldTripSchema.statics.PARTICIPANT_STATUSES = PARTICIPANT_STATUSES;
fieldTripSchema.statics.ACTIVE_PARTICIPANT_STATUSES = ACTIVE_PARTICIPANT_STATUSES;
fieldTripSchema.statics.PAYMENT_STATUSES = PAYMENT_STATUSES;
fieldTripSchema.statics.CONSENT_STATEMENT_VERSION = CONSENT_STATEMENT_VERSION;

fieldTripSchema.set('toObject', { virtuals: true });
fieldTripSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('FieldTrip', fieldTripSchema);
