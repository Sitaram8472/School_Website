const mongoose = require('mongoose');

const CLUB_CATEGORIES = [
  'sports',
  'arts',
  'music',
  'technology',
  'literary',
  'social-service',
  'science',
  'other',
];

const CLUB_STATUSES = ['open', 'closed', 'archived'];
const SESSION_STATUSES = ['scheduled', 'held', 'cancelled'];

const clubError = (message) => {
  const error = new Error(message);
  error.userFacing = true;
  return error;
};

/**
 * URL-safe identifier derived from the name. Generated rather than accepted so
 * two clubs cannot claim the same slug by racing each other to it.
 */
const slugify = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

const attendeeSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    studentName: {
      type: String,
      trim: true,
      default: '',
    },
    present: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false }
);

// Sessions live inside the club rather than in their own collection: they are
// always read in the context of their club, they are bounded in number, and
// embedding keeps "upcoming sessions for my clubs" to a single round trip.
const sessionSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Session title is required'],
      trim: true,
      maxlength: [150, 'Session title cannot exceed 150 characters'],
    },
    scheduledFor: {
      type: Date,
      required: [true, 'Session date is required'],
    },
    durationMinutes: {
      type: Number,
      default: 60,
      min: [10, 'A session must run at least 10 minutes'],
      max: [480, 'A session cannot run longer than 8 hours'],
    },
    venue: {
      type: String,
      trim: true,
      maxlength: [120, 'Venue cannot exceed 120 characters'],
      default: '',
    },
    agenda: {
      type: String,
      trim: true,
      maxlength: [1000, 'Agenda cannot exceed 1000 characters'],
      default: '',
    },
    status: {
      type: String,
      enum: {
        values: SESSION_STATUSES,
        message: 'Invalid session status',
      },
      default: 'scheduled',
    },
    attendees: {
      type: [attendeeSchema],
      default: [],
    },
    attendanceTakenAt: {
      type: Date,
      default: null,
    },
  },
  { _id: true, timestamps: true }
);

const achievementSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Achievement title is required'],
      trim: true,
      maxlength: [200, 'Achievement title cannot exceed 200 characters'],
    },
    awardedOn: {
      type: Date,
      default: Date.now,
    },
    description: {
      type: String,
      trim: true,
      maxlength: [500, 'Description cannot exceed 500 characters'],
      default: '',
    },
  },
  { _id: true }
);

const clubSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Club name is required'],
      unique: true,
      trim: true,
      minlength: [3, 'Club name must be at least 3 characters'],
      maxlength: [100, 'Club name cannot exceed 100 characters'],
    },

    slug: {
      type: String,
      unique: true,
      trim: true,
      lowercase: true,
    },

    category: {
      type: String,
      enum: {
        values: CLUB_CATEGORIES,
        message: 'Invalid club category',
      },
      required: [true, 'Category is required'],
    },

    description: {
      type: String,
      required: [true, 'Description is required'],
      trim: true,
      minlength: [10, 'Please describe the club in at least 10 characters'],
      maxlength: [1500, 'Description cannot exceed 1500 characters'],
    },

    coverImage: {
      type: String,
      trim: true,
      default: '',
    },

    meetingDay: {
      type: String,
      trim: true,
      maxlength: [30, 'Meeting day cannot exceed 30 characters'],
      default: '',
    },

    meetingTime: {
      type: String,
      trim: true,
      match: [/^([01]\d|2[0-3]):([0-5]\d)$/, 'Meeting time must be in HH:MM 24-hour format'],
      default: undefined,
    },

    venue: {
      type: String,
      trim: true,
      maxlength: [120, 'Venue cannot exceed 120 characters'],
      default: '',
    },

    coordinator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A coordinator is required'],
    },

    coordinatorName: {
      type: String,
      trim: true,
      default: '',
    },

    capacity: {
      type: Number,
      required: [true, 'Capacity is required'],
      min: [1, 'Capacity must be at least 1'],
      max: [500, 'Capacity cannot exceed 500'],
    },

    // Derived from active memberships by the controller — never from a body.
    memberCount: {
      type: Number,
      default: 0,
      min: [0, 'Member count cannot be negative'],
    },

    // Empty means every class may join.
    eligibleClasses: {
      type: [String],
      default: [],
    },

    requiresApproval: {
      type: Boolean,
      default: false,
    },

    status: {
      type: String,
      enum: {
        values: CLUB_STATUSES,
        message: 'Invalid club status',
      },
      default: 'open',
    },

    sessions: {
      type: [sessionSchema],
      default: [],
    },

    achievements: {
      type: [achievementSchema],
      default: [],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

clubSchema.index({ category: 1, status: 1 });
clubSchema.index({ coordinator: 1 });

clubSchema.virtual('seatsAvailable').get(function () {
  return Math.max((this.capacity || 0) - (this.memberCount || 0), 0);
});

clubSchema.virtual('isFull').get(function () {
  return (this.memberCount || 0) >= (this.capacity || 0);
});

clubSchema.virtual('fillRate').get(function () {
  if (!this.capacity) return 0;
  return Math.round(((this.memberCount || 0) / this.capacity) * 100);
});

clubSchema.virtual('upcomingSessions').get(function () {
  const now = new Date();
  return (this.sessions || [])
    .filter((session) => session.status === 'scheduled' && session.scheduledFor >= now)
    .sort((a, b) => a.scheduledFor - b.scheduledFor);
});

clubSchema.virtual('nextSession').get(function () {
  return this.upcomingSessions[0] || null;
});

/**
 * An empty `eligibleClasses` means the club is open to everyone. Comparison is
 * case-insensitive because "8-B" and "8-b" are the same class to a human.
 */
clubSchema.methods.acceptsClass = function (className) {
  const eligible = this.eligibleClasses || [];
  if (!eligible.length) return true;
  if (!className) return false;

  const needle = String(className).trim().toLowerCase();
  return eligible.some((entry) => String(entry).trim().toLowerCase() === needle);
};

clubSchema.methods.canAcceptMembers = function () {
  if (this.status !== 'open') return false;
  return !this.isFull;
};

/**
 * Guards the one thing a coordinator can get wrong by accident: scheduling a
 * session for a date that has already passed.
 */
clubSchema.methods.addSession = function ({ title, scheduledFor, durationMinutes, venue, agenda }) {
  const when = new Date(scheduledFor);

  if (Number.isNaN(when.getTime())) {
    throw clubError('That session date is not a valid date');
  }
  if (when < new Date()) {
    throw clubError('A session cannot be scheduled in the past');
  }

  this.sessions.push({
    title,
    scheduledFor: when,
    durationMinutes: durationMinutes || 60,
    venue: venue || this.venue,
    agenda: agenda || '',
    status: 'scheduled',
  });

  this.markModified('sessions');
  return this.sessions[this.sessions.length - 1];
};

clubSchema.methods.findSession = function (sessionId) {
  return (this.sessions || []).id(sessionId) || null;
};

clubSchema.pre('validate', async function () {
  if (this.name) {
    this.slug = slugify(this.name);
    if (!this.slug) {
      throw clubError('That club name does not produce a usable web address');
    }
  }

  if (this.memberCount > this.capacity) {
    throw clubError(
      `Cannot set capacity to ${this.capacity} — the club already has ${this.memberCount} members`
    );
  }
});

module.exports = mongoose.model('Club', clubSchema);
module.exports.CLUB_CATEGORIES = CLUB_CATEGORIES;
module.exports.CLUB_STATUSES = CLUB_STATUSES;
module.exports.SESSION_STATUSES = SESSION_STATUSES;
module.exports.slugify = slugify;
module.exports.clubError = clubError;
