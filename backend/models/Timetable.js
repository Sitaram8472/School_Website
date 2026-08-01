const mongoose = require('mongoose');

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const PERIOD_TYPES = ['lecture', 'lab', 'activity', 'break', 'exam'];

// "09:00", "14:30" — 24-hour, zero padded.
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * A validation failure the user can act on (a clash, a duplicate period). Tagged
 * so the controller can answer 400 for these and 500 for genuine bugs.
 */
const scheduleError = (message) => {
  const error = new Error(message);
  error.userFacing = true;
  return error;
};

/**
 * Minutes since midnight. Storing times as HH:mm strings keeps the model free
 * of timezones; comparing them as integers keeps overlap checks trivial.
 */
const toMinutes = (time) => {
  const [hours, minutes] = String(time).split(':').map(Number);
  return hours * 60 + minutes;
};

const periodSchema = new mongoose.Schema(
  {
    day: {
      type: String,
      required: [true, 'Day is required'],
      enum: {
        values: DAYS,
        message: 'Day must be a valid weekday',
      },
    },

    periodNumber: {
      type: Number,
      required: [true, 'Period number is required'],
      min: [1, 'Period number must be at least 1'],
      max: [15, 'A day cannot have more than 15 periods'],
    },

    subject: {
      type: String,
      required: [true, 'Subject is required'],
      trim: true,
      maxlength: [100, 'Subject cannot exceed 100 characters'],
    },

    teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // Denormalised so the timetable still reads correctly if a teacher account
    // is deactivated later.
    teacherName: {
      type: String,
      trim: true,
      maxlength: [100, 'Teacher name cannot exceed 100 characters'],
      default: '',
    },

    startTime: {
      type: String,
      required: [true, 'Start time is required'],
      match: [TIME_PATTERN, 'Start time must be in HH:mm 24-hour format'],
    },

    endTime: {
      type: String,
      required: [true, 'End time is required'],
      match: [TIME_PATTERN, 'End time must be in HH:mm 24-hour format'],
    },

    room: {
      type: String,
      trim: true,
      maxlength: [50, 'Room cannot exceed 50 characters'],
      default: '',
    },

    type: {
      type: String,
      enum: {
        values: PERIOD_TYPES,
        message: 'Invalid period type',
      },
      default: 'lecture',
    },
  },
  { _id: true }
);

periodSchema.pre('validate', function (next) {
  if (TIME_PATTERN.test(this.startTime || '') && TIME_PATTERN.test(this.endTime || '')) {
    if (toMinutes(this.endTime) <= toMinutes(this.startTime)) {
      return next(scheduleError(`Period ${this.periodNumber} on ${this.day} ends before it starts`));
    }
  }
  return next();
});

const timetableSchema = new mongoose.Schema(
  {
    className: {
      type: String,
      required: [true, 'Class name is required'],
      trim: true,
      maxlength: [50, 'Class name cannot exceed 50 characters'],
    },

    section: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: [5, 'Section cannot exceed 5 characters'],
      default: 'A',
    },

    academicYear: {
      type: String,
      required: [true, 'Academic year is required'],
      trim: true,
      match: [/^\d{4}-\d{2,4}$/, 'Academic year must look like 2025-26 or 2025-2026'],
    },

    effectiveFrom: {
      type: Date,
      default: Date.now,
    },

    isActive: {
      type: Boolean,
      default: false,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Creator is required'],
    },

    periods: {
      type: [periodSchema],
      default: [],
    },

    notes: {
      type: String,
      trim: true,
      maxlength: [1000, 'Notes cannot exceed 1000 characters'],
      default: '',
    },
  },
  { timestamps: true }
);

timetableSchema.index({ className: 1, section: 1, academicYear: 1 });
timetableSchema.index({ isActive: 1, className: 1 });
timetableSchema.index({ 'periods.teacher': 1 });

/**
 * A class cannot be in two places at once. Reject overlapping periods and
 * duplicate period numbers on the same day before anything is written.
 */
timetableSchema.pre('validate', function (next) {
  if (!Array.isArray(this.periods) || this.periods.length < 2) return next();

  const byDay = new Map();

  for (const period of this.periods) {
    if (!period.day || !TIME_PATTERN.test(period.startTime || '') || !TIME_PATTERN.test(period.endTime || '')) {
      // Field-level validators will report the specific problem.
      continue;
    }
    if (!byDay.has(period.day)) byDay.set(period.day, []);
    byDay.get(period.day).push(period);
  }

  for (const [day, periods] of byDay.entries()) {
    const seenNumbers = new Set();

    for (const period of periods) {
      if (seenNumbers.has(period.periodNumber)) {
        return next(scheduleError(`Duplicate period number ${period.periodNumber} on ${day}`));
      }
      seenNumbers.add(period.periodNumber);
    }

    const sorted = [...periods].sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));

    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1];
      const current = sorted[i];

      if (toMinutes(current.startTime) < toMinutes(previous.endTime)) {
        return next(
          scheduleError(
            `${day}: "${current.subject}" (${current.startTime}-${current.endTime}) overlaps ` +
              `"${previous.subject}" (${previous.startTime}-${previous.endTime})`
          )
        );
      }
    }
  }

  return next();
});

/**
 * Periods for one weekday, ordered by start time.
 */
timetableSchema.methods.periodsForDay = function (day) {
  return this.periods
    .filter((period) => period.day === day)
    .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
};

/**
 * The period running at a given moment, or null outside school hours. Used to
 * highlight "happening now" in the UI.
 */
timetableSchema.methods.currentPeriod = function (now = new Date()) {
  const day = DAYS[(now.getDay() + 6) % 7];
  const minutesNow = now.getHours() * 60 + now.getMinutes();

  return (
    this.periodsForDay(day).find(
      (period) => toMinutes(period.startTime) <= minutesNow && minutesNow < toMinutes(period.endTime)
    ) || null
  );
};

/**
 * Would adding this period clash with what is already scheduled? Exposed so the
 * single-period endpoint can answer without re-validating the whole document.
 */
timetableSchema.methods.findClash = function (candidate, ignorePeriodId = null) {
  if (!TIME_PATTERN.test(candidate.startTime || '') || !TIME_PATTERN.test(candidate.endTime || '')) {
    return null;
  }

  const start = toMinutes(candidate.startTime);
  const end = toMinutes(candidate.endTime);

  return (
    this.periods.find((period) => {
      if (period.day !== candidate.day) return false;
      if (ignorePeriodId && period._id.toString() === ignorePeriodId.toString()) return false;
      return start < toMinutes(period.endTime) && end > toMinutes(period.startTime);
    }) || null
  );
};

timetableSchema.statics.DAYS = DAYS;
timetableSchema.statics.PERIOD_TYPES = PERIOD_TYPES;
timetableSchema.statics.toMinutes = toMinutes;

module.exports = mongoose.model('Timetable', timetableSchema);
