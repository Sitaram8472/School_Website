const mongoose = require('mongoose');

/**
 * An alumnus's profile, and the mentorship requests current students have made
 * against it.
 *
 * Two things drive the shape of this schema:
 *
 *  - Nothing is visible until staff have verified it. Putting an unverified
 *    stranger's contact details in front of a current student is the failure
 *    mode this module exists to avoid, so `verificationStatus` is enforced in
 *    the query rather than in the UI.
 *  - Contact details are released by an accepted mentorship, not by browsing.
 *    An alumni directory that hands out everyone's email is how you get alumni
 *    to stop registering.
 */

const VERIFICATION_STATUSES = ['pending', 'verified', 'rejected'];
const REQUEST_STATUSES = ['pending', 'accepted', 'declined', 'completed', 'withdrawn'];

// Requests that occupy one of a mentor's seats.
const SEAT_HOLDING_STATUSES = ['accepted'];

const MENTORSHIP_AREAS = [
  'career-guidance',
  'higher-studies',
  'entrance-exams',
  'internships',
  'entrepreneurship',
  'research',
  'sports',
  'arts',
];

const mentorshipRequestSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'The requesting student is required'],
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

    area: {
      type: String,
      enum: {
        values: MENTORSHIP_AREAS,
        message: 'Invalid mentorship area',
      },
      required: [true, 'Please say what you would like guidance on'],
    },

    message: {
      type: String,
      required: [true, 'A short message is required'],
      trim: true,
      minlength: [20, 'Please write at least 20 characters so the mentor knows what you need'],
      maxlength: [800, 'Message cannot exceed 800 characters'],
    },

    status: {
      type: String,
      enum: {
        values: REQUEST_STATUSES,
        message: 'Invalid request status',
      },
      default: 'pending',
    },

    responseMessage: {
      type: String,
      trim: true,
      maxlength: [800, 'Response cannot exceed 800 characters'],
      default: '',
    },

    requestedAt: {
      type: Date,
      default: Date.now,
    },

    respondedAt: {
      type: Date,
      default: null,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    outcomeNote: {
      type: String,
      trim: true,
      maxlength: [800, 'Outcome note cannot exceed 800 characters'],
      default: '',
    },
  },
  { _id: true }
);

const alumniProfileSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User is required'],
      unique: true,
    },

    fullName: {
      type: String,
      required: [true, 'Full name is required'],
      trim: true,
      maxlength: [100, 'Full name cannot exceed 100 characters'],
    },

    graduationYear: {
      type: Number,
      required: [true, 'Graduation year is required'],
      min: [1950, 'Graduation year looks wrong before 1950'],
      validate: {
        validator(value) {
          // A graduation year in the future is a typo, not a plan.
          return value <= new Date().getFullYear();
        },
        message: 'Graduation year cannot be in the future',
      },
    },

    graduatingClass: {
      type: String,
      trim: true,
      maxlength: [50, 'Class cannot exceed 50 characters'],
      default: '',
    },

    currentRole: {
      type: String,
      trim: true,
      maxlength: [100, 'Role cannot exceed 100 characters'],
      default: '',
    },

    organisation: {
      type: String,
      trim: true,
      maxlength: [120, 'Organisation cannot exceed 120 characters'],
      default: '',
    },

    industry: {
      type: String,
      trim: true,
      maxlength: [80, 'Industry cannot exceed 80 characters'],
      default: '',
    },

    city: {
      type: String,
      trim: true,
      maxlength: [80, 'City cannot exceed 80 characters'],
      default: '',
    },

    country: {
      type: String,
      trim: true,
      maxlength: [80, 'Country cannot exceed 80 characters'],
      default: 'India',
    },

    bio: {
      type: String,
      trim: true,
      maxlength: [1000, 'Bio cannot exceed 1000 characters'],
      default: '',
    },

    // ---- Contact details: redacted unless the viewer has earned them ----
    contactEmail: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: [120, 'Email cannot exceed 120 characters'],
      default: '',
    },

    contactPhone: {
      type: String,
      trim: true,
      maxlength: [20, 'Phone cannot exceed 20 characters'],
      default: '',
    },

    linkedinUrl: {
      type: String,
      trim: true,
      maxlength: [200, 'LinkedIn URL cannot exceed 200 characters'],
      default: '',
      validate: {
        validator(value) {
          return !value || /^https?:\/\/(www\.)?linkedin\.com\//i.test(value);
        },
        message: 'LinkedIn URL must point at linkedin.com',
      },
    },

    // ---- Verification: server-owned ----
    verificationStatus: {
      type: String,
      enum: {
        values: VERIFICATION_STATUSES,
        message: 'Invalid verification status',
      },
      default: 'pending',
    },

    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    verifiedAt: {
      type: Date,
      default: null,
    },

    rejectionReason: {
      type: String,
      trim: true,
      maxlength: [400, 'Rejection reason cannot exceed 400 characters'],
      default: '',
    },

    // ---- Mentorship ----
    willingToMentor: {
      type: Boolean,
      default: false,
    },

    mentorCapacity: {
      type: Number,
      default: 2,
      min: [0, 'Mentor capacity cannot be negative'],
      max: [20, 'Twenty mentees is not a realistic commitment'],
    },

    /**
     * Server-owned counter of accepted, not-yet-completed mentorships.
     *
     * It exists so the capacity check fits inside the filter of a single
     * conditional update. Counting `mentorships` in application code would move
     * the check outside the write, which is exactly the race it is there to
     * prevent.
     */
    activeMenteeCount: {
      type: Number,
      default: 0,
      min: [0, 'Active mentee count cannot be negative'],
    },

    mentorshipAreas: {
      type: [String],
      default: [],
      validate: {
        validator(values) {
          return Array.isArray(values) && values.every((value) => MENTORSHIP_AREAS.includes(value));
        },
        message: `Mentorship areas must be drawn from: ${MENTORSHIP_AREAS.join(', ')}`,
      },
    },

    mentorships: {
      type: [mentorshipRequestSchema],
      default: [],
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

alumniProfileSchema.index({ verificationStatus: 1, graduationYear: -1 });
alumniProfileSchema.index({ verificationStatus: 1, willingToMentor: 1 });
alumniProfileSchema.index({ industry: 1 });
alumniProfileSchema.index({ 'mentorships.student': 1, 'mentorships.status': 1 });

alumniProfileSchema.virtual('seatsLeft').get(function () {
  return Math.max(0, this.mentorCapacity - this.activeMenteeCount);
});

alumniProfileSchema.virtual('isAcceptingMentees').get(function () {
  return (
    this.verificationStatus === 'verified' &&
    this.willingToMentor &&
    this.activeMenteeCount < this.mentorCapacity
  );
});

/**
 * Why this alumnus cannot take a new mentee right now, or null when they can.
 */
alumniProfileSchema.methods.mentorshipError = function () {
  if (this.verificationStatus !== 'verified') {
    return 'This profile has not been verified yet.';
  }
  if (!this.willingToMentor) {
    return 'This alumnus is not offering mentorship at the moment.';
  }
  if (this.activeMenteeCount >= this.mentorCapacity) {
    return 'This alumnus has taken on as many mentees as they can.';
  }
  return null;
};

alumniProfileSchema.methods.findRequestFrom = function (studentId) {
  return (
    this.mentorships.find(
      (request) =>
        String(request.student) === String(studentId) &&
        ['pending', 'accepted'].includes(request.status)
    ) || null
  );
};

alumniProfileSchema.methods.isOwnedBy = function (user) {
  return String(this.user) === String(user._id);
};

/**
 * The shape this profile takes for a given viewer.
 *
 * Contact details are released to the owner, to staff, and to a student whose
 * mentorship request has been *accepted* — not merely made. Everyone else gets
 * the profile without them.
 *
 * Other students' requests are stripped for the same reason: a directory that
 * shows who else asked for help with what is a directory nobody uses honestly.
 */
alumniProfileSchema.methods.redactFor = function (viewer) {
  const staff = viewer.role === 'admin' || viewer.role === 'staff';
  const owner = this.isOwnedBy(viewer);

  const accepted = this.mentorships.some(
    (request) => String(request.student) === String(viewer._id) && request.status === 'accepted'
  );

  const maySeeContact = staff || owner || accepted;

  const base = {
    _id: this._id,
    user: this.user,
    fullName: this.fullName,
    graduationYear: this.graduationYear,
    graduatingClass: this.graduatingClass,
    currentRole: this.currentRole,
    organisation: this.organisation,
    industry: this.industry,
    city: this.city,
    country: this.country,
    bio: this.bio,
    verificationStatus: this.verificationStatus,
    willingToMentor: this.willingToMentor,
    mentorCapacity: this.mentorCapacity,
    activeMenteeCount: this.activeMenteeCount,
    seatsLeft: Math.max(0, this.mentorCapacity - this.activeMenteeCount),
    mentorshipAreas: this.mentorshipAreas,
    isAcceptingMentees:
      this.verificationStatus === 'verified' &&
      this.willingToMentor &&
      this.activeMenteeCount < this.mentorCapacity,
    contactUnlocked: maySeeContact,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };

  if (maySeeContact) {
    base.contactEmail = this.contactEmail;
    base.contactPhone = this.contactPhone;
    base.linkedinUrl = this.linkedinUrl;
  }

  if (staff || owner) {
    base.mentorships = this.mentorships;
    base.verifiedAt = this.verifiedAt;
    base.rejectionReason = this.rejectionReason;
  } else {
    base.mentorships = this.mentorships.filter(
      (request) => String(request.student) === String(viewer._id)
    );
  }

  return base;
};

alumniProfileSchema.statics.VERIFICATION_STATUSES = VERIFICATION_STATUSES;
alumniProfileSchema.statics.REQUEST_STATUSES = REQUEST_STATUSES;
alumniProfileSchema.statics.SEAT_HOLDING_STATUSES = SEAT_HOLDING_STATUSES;
alumniProfileSchema.statics.MENTORSHIP_AREAS = MENTORSHIP_AREAS;

module.exports = mongoose.model('AlumniProfile', alumniProfileSchema);
