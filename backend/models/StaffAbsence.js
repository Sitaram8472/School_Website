const mongoose = require('mongoose');

/**
 * Staff absences and the cover they leave behind.
 *
 * An absence carries its own periods rather than pointing at a timetable. That
 * is deliberate: cover is arranged on exactly the mornings when the timetable
 * is the thing that has broken, and a period that describes itself ("period 3,
 * 8B, Physics, lab 2") is still useful when nothing else is available. If a
 * timetable module lands later it can populate these periods instead of a human
 * typing them, and nothing else in this file has to change.
 *
 * Times are stored twice — as `HH:MM` for humans and as integer minutes for the
 * overlap arithmetic. Comparing time strings works right up until "09:00" meets
 * "9:00", and the failure is a substitute standing in two rooms.
 */

const ABSENCE_REASONS = [
  'sick',
  'personal',
  'official-duty',
  'training',
  'emergency',
  'other',
];

const ABSENCE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

const COVER_STATUSES = [
  'unassigned',
  'assigned',
  'declined',
  'completed',
  'not-required',
];

// A period in one of these states has a named person committed to it, so it
// counts against that person's availability.
const COMMITTED_COVER_STATUSES = ['assigned', 'completed'];

// An absence in one of these states still keeps its teacher out of the
// building, so they cannot be handed cover for it either.
const LIVE_ABSENCE_STATUSES = ['pending', 'approved'];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const MIN_PERIOD_MINUTES = 10;
const MAX_PERIOD_MINUTES = 240;
const MAX_PERIODS_PER_ABSENCE = 12;

/**
 * "14:35" -> 875. Returns null rather than NaN for anything that is not a valid
 * HH:MM string, so a caller can tell "not supplied" apart from midnight.
 */
function toMinutes(time) {
  if (typeof time !== 'string' || !TIME_PATTERN.test(time)) return null;
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return null;
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Today in the server's local zone, as the YYYY-MM-DD key the model stores. */
function todayKey(now = new Date()) {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

const coverPeriodSchema = new mongoose.Schema(
  {
    periodLabel: {
      type: String,
      required: [true, 'Period label is required'],
      trim: true,
      maxlength: [30, 'Period label cannot exceed 30 characters'],
    },
    startTime: {
      type: String,
      required: [true, 'Period start time is required'],
      match: [TIME_PATTERN, 'Start time must be in HH:MM format'],
    },
    endTime: {
      type: String,
      required: [true, 'Period end time is required'],
      match: [TIME_PATTERN, 'End time must be in HH:MM format'],
    },
    // Derived in the parent's pre-validate hook. Never accepted from a client.
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
    className: {
      type: String,
      required: [true, 'Class name is required'],
      trim: true,
      maxlength: [40, 'Class name cannot exceed 40 characters'],
    },
    subject: {
      type: String,
      required: [true, 'Subject is required'],
      trim: true,
      maxlength: [60, 'Subject cannot exceed 60 characters'],
    },
    room: {
      type: String,
      trim: true,
      maxlength: [40, 'Room cannot exceed 40 characters'],
      default: null,
    },
    // What the covering teacher should actually do with the class. A cover
    // period without one is a free period with an audience.
    lessonPlan: {
      type: String,
      trim: true,
      maxlength: [1500, 'Lesson plan cannot exceed 1500 characters'],
      default: null,
    },
    coverStatus: {
      type: String,
      enum: COVER_STATUSES,
      default: 'unassigned',
    },
    substitute: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    substituteName: {
      type: String,
      trim: true,
      default: null,
    },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    assignedAt: {
      type: Date,
      default: null,
    },
    declineReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Decline reason cannot exceed 300 characters'],
      default: null,
    },
    declinedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    // Why somebody decided this period needs nobody. Required by the
    // controller when `coverStatus` is set to `not-required`, because a period
    // that disappears from the board without a reason is the failure this
    // module exists to prevent.
    notRequiredReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Reason cannot exceed 300 characters'],
      default: null,
    },
  },
  { _id: true }
);

const staffAbsenceSchema = new mongoose.Schema(
  {
    staff: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'The absent staff member is required'],
      index: true,
    },
    staffName: {
      type: String,
      trim: true,
    },
    date: {
      type: String,
      required: [true, 'Date is required'],
      match: [DATE_PATTERN, 'Date must be in YYYY-MM-DD format'],
      index: true,
    },
    reason: {
      type: String,
      enum: ABSENCE_REASONS,
      default: 'sick',
    },
    details: {
      type: String,
      trim: true,
      maxlength: [500, 'Details cannot exceed 500 characters'],
      default: null,
    },
    status: {
      type: String,
      enum: ABSENCE_STATUSES,
      default: 'pending',
      index: true,
    },
    // Reported after the school day started — worth flagging on the board
    // because it is the case where cover has to be found in minutes.
    lateNotice: {
      type: Boolean,
      default: false,
    },
    reportedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
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
    cancelledAt: {
      type: Date,
      default: null,
    },
    periods: {
      type: [coverPeriodSchema],
      default: [],
    },
  },
  { timestamps: true }
);

// The board query — one date, everything on it, ordered by the staff member.
staffAbsenceSchema.index({ date: 1, status: 1 });
// "What am I covering?" and the availability check both hit this.
staffAbsenceSchema.index({ 'periods.substitute': 1, date: 1 });

/**
 * Derives the minute integers and rejects a period set that cannot be a real
 * day. Mongoose 9 has dropped callback-style middleware, so this is an async
 * function that throws rather than one calling `next(err)` — a hook written the
 * old way is skipped silently, and it would take the derivation of
 * `startMinute` with it, which would make every overlap test compare undefined
 * against undefined and pass.
 */
staffAbsenceSchema.pre('validate', async function derive() {
  if (!Array.isArray(this.periods) || this.periods.length === 0) {
    this.invalidate('periods', 'An absence must list at least one period to cover');
    return;
  }

  if (this.periods.length > MAX_PERIODS_PER_ABSENCE) {
    this.invalidate(
      'periods',
      `An absence cannot list more than ${MAX_PERIODS_PER_ABSENCE} periods`
    );
    return;
  }

  for (const period of this.periods) {
    period.startMinute = toMinutes(period.startTime);
    period.endMinute = toMinutes(period.endTime);

    if (period.startMinute === null || period.endMinute === null) {
      // The `match` validators report the real problem; bail out before the
      // arithmetic below runs on nulls.
      return;
    }

    const duration = period.endMinute - period.startMinute;
    if (duration < MIN_PERIOD_MINUTES) {
      this.invalidate(
        'periods',
        `A period must run for at least ${MIN_PERIOD_MINUTES} minutes (${period.periodLabel})`
      );
      return;
    }
    if (duration > MAX_PERIOD_MINUTES) {
      this.invalidate(
        'periods',
        `A period cannot run for more than ${MAX_PERIOD_MINUTES} minutes (${period.periodLabel})`
      );
      return;
    }
  }

  // Two periods of the same absence overlapping means the teacher was timetabled
  // in two rooms at once, which is a timetable bug being imported into the cover
  // board. Rejecting it here keeps the board honest.
  const sorted = [...this.periods].sort((a, b) => a.startMinute - b.startMinute);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].startMinute < sorted[i - 1].endMinute) {
      this.invalidate(
        'periods',
        `Periods ${sorted[i - 1].periodLabel} and ${sorted[i].periodLabel} overlap`
      );
      return;
    }
  }
});

staffAbsenceSchema.virtual('periodCount').get(function periodCount() {
  return this.periods.length;
});

staffAbsenceSchema.virtual('uncoveredCount').get(function uncoveredCount() {
  return this.periods.filter(
    (period) => period.coverStatus === 'unassigned' || period.coverStatus === 'declined'
  ).length;
});

staffAbsenceSchema.virtual('coveredCount').get(function coveredCount() {
  return this.periods.filter((period) =>
    COMMITTED_COVER_STATUSES.includes(period.coverStatus)
  ).length;
});

/**
 * True when every period has been dealt with one way or another. A period
 * marked `not-required` counts as dealt with, which is exactly why marking one
 * demands a reason.
 */
staffAbsenceSchema.virtual('fullyCovered').get(function fullyCovered() {
  return this.periods.every(
    (period) => period.coverStatus !== 'unassigned' && period.coverStatus !== 'declined'
  );
});

staffAbsenceSchema.virtual('isPast').get(function isPast() {
  return this.date < todayKey();
});

/**
 * Whether cover may still be arranged against this absence. The conditional
 * update in the controller is the authority — this exists so the UI can grey
 * out a button and so the handler can return the real reason instead of a bare
 * "could not assign".
 */
staffAbsenceSchema.methods.assignabilityError = function assignabilityError() {
  if (this.status === 'cancelled') return 'This absence has been cancelled.';
  if (this.status === 'rejected') return 'This absence was rejected.';
  if (this.isPast) return 'This absence is in the past.';
  return null;
};

staffAbsenceSchema.methods.findPeriod = function findPeriod(periodId) {
  return this.periods.id(periodId) || null;
};

/**
 * Every interval this absence commits `userId` to on its date, whether as the
 * absent teacher (they are not in the building) or as a named substitute.
 *
 * Returning both from one place is what makes the availability check a single
 * pass over one query result — an absence is just another interval on somebody's
 * day, and treating it as one is why "do not ask an absent teacher to cover"
 * costs no extra code.
 */
staffAbsenceSchema.methods.commitmentsFor = function commitmentsFor(userId) {
  const wanted = String(userId);
  const intervals = [];

  const absentThemself =
    String(this.staff) === wanted && LIVE_ABSENCE_STATUSES.includes(this.status);

  for (const period of this.periods) {
    if (absentThemself) {
      intervals.push({
        startMinute: period.startMinute,
        endMinute: period.endMinute,
        startTime: period.startTime,
        endTime: period.endTime,
        kind: 'absent',
        label: period.periodLabel,
      });
      continue;
    }

    if (
      period.substitute &&
      String(period.substitute) === wanted &&
      COMMITTED_COVER_STATUSES.includes(period.coverStatus)
    ) {
      intervals.push({
        startMinute: period.startMinute,
        endMinute: period.endMinute,
        startTime: period.startTime,
        endTime: period.endTime,
        kind: 'cover',
        label: period.periodLabel,
      });
    }
  }

  return intervals;
};

/**
 * Serialises the absence for a given viewer.
 *
 * Admins and the absent teacher see everything. A teacher who has been asked to
 * cover one period sees that period and the shape of the rest — they need to
 * know the absence is real and whose class they are taking, not why a colleague
 * is off sick. `details` on a `sick` absence is medical information; it does not
 * go to the staffroom.
 */
staffAbsenceSchema.methods.redactFor = function redactFor(viewer) {
  const plain = this.toObject({ virtuals: true });
  delete plain.__v;

  const viewerId = viewer && (viewer._id || viewer.id);
  const isOwner = viewerId && String(this.staff) === String(viewerId);
  const isAdmin = viewer && viewer.role === 'admin';

  if (isOwner || isAdmin) return plain;

  plain.details = null;
  plain.rejectionReason = null;
  plain.periods = (plain.periods || []).map((period) => {
    const mine =
      viewerId && period.substitute && String(period.substitute) === String(viewerId);
    if (mine) return period;
    return {
      ...period,
      lessonPlan: null,
      declineReason: null,
      notRequiredReason: null,
    };
  });

  return plain;
};

/**
 * Two [start, end) intervals overlap when each starts before the other ends.
 * Back-to-back periods (10:00-10:45 and 10:45-11:30) do not overlap, which is
 * the entire reason a school day works at all.
 */
staffAbsenceSchema.statics.overlaps = function overlaps(a, b) {
  return a.startMinute < b.endMinute && b.startMinute < a.endMinute;
};

staffAbsenceSchema.statics.toMinutes = toMinutes;
staffAbsenceSchema.statics.formatMinutes = formatMinutes;
staffAbsenceSchema.statics.todayKey = todayKey;
staffAbsenceSchema.statics.ABSENCE_REASONS = ABSENCE_REASONS;
staffAbsenceSchema.statics.ABSENCE_STATUSES = ABSENCE_STATUSES;
staffAbsenceSchema.statics.COVER_STATUSES = COVER_STATUSES;
staffAbsenceSchema.statics.COMMITTED_COVER_STATUSES = COMMITTED_COVER_STATUSES;
staffAbsenceSchema.statics.LIVE_ABSENCE_STATUSES = LIVE_ABSENCE_STATUSES;
staffAbsenceSchema.statics.MAX_PERIODS_PER_ABSENCE = MAX_PERIODS_PER_ABSENCE;

staffAbsenceSchema.set('toObject', { virtuals: true });
staffAbsenceSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('StaffAbsence', staffAbsenceSchema);
