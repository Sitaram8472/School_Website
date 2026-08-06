const mongoose = require('mongoose');

const MEMBERSHIP_STATUSES = ['pending', 'active', 'rejected', 'left'];
const MEMBER_ROLES = ['member', 'secretary', 'captain'];

const membershipError = (message) => {
  const error = new Error(message);
  error.userFacing = true;
  return error;
};

const clubMembershipSchema = new mongoose.Schema(
  {
    club: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Club',
      required: [true, 'Club is required'],
    },

    clubName: {
      type: String,
      trim: true,
      default: '',
    },

    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Student is required'],
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

    role: {
      type: String,
      enum: {
        values: MEMBER_ROLES,
        message: 'Invalid member role',
      },
      default: 'member',
    },

    status: {
      type: String,
      enum: {
        values: MEMBERSHIP_STATUSES,
        message: 'Invalid membership status',
      },
      default: 'active',
    },

    motivation: {
      type: String,
      trim: true,
      maxlength: [500, 'Motivation cannot exceed 500 characters'],
      default: '',
    },

    joinedAt: {
      type: Date,
      default: Date.now,
    },

    leftAt: {
      type: Date,
      default: null,
    },

    leaveReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Leave reason cannot exceed 300 characters'],
      default: '',
    },

    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    decidedAt: {
      type: Date,
      default: null,
    },

    decisionNote: {
      type: String,
      trim: true,
      maxlength: [300, 'Decision note cannot exceed 300 characters'],
      default: '',
    },

    attendanceCount: {
      type: Number,
      default: 0,
      min: [0, 'Attendance count cannot be negative'],
    },

    sessionsMissed: {
      type: Number,
      default: 0,
      min: [0, 'Missed session count cannot be negative'],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// A student joins a club once. Rows are kept when someone leaves, so this is a
// plain compound unique index rather than a partial one — rejoining reuses the
// existing row instead of creating a second.
clubMembershipSchema.index({ club: 1, student: 1 }, { unique: true });
clubMembershipSchema.index({ student: 1, status: 1 });
clubMembershipSchema.index({ club: 1, status: 1 });

clubMembershipSchema.virtual('attendanceRate').get(function () {
  const total = (this.attendanceCount || 0) + (this.sessionsMissed || 0);
  if (!total) return null;
  return Math.round(((this.attendanceCount || 0) / total) * 100);
});

clubMembershipSchema.virtual('isLive').get(function () {
  return this.status === 'active';
});

/**
 * Which transitions the lifecycle permits, kept as data rather than scattered
 * `if` statements so adding a state later cannot quietly open a hole.
 */
const ALLOWED_TRANSITIONS = {
  pending: ['active', 'rejected', 'left'],
  active: ['left'],
  rejected: ['pending'],
  left: ['pending', 'active'],
};

clubMembershipSchema.statics.canTransition = function (from, to) {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
};

clubMembershipSchema.methods.transitionTo = function (next, actorId = null, note = '') {
  if (this.status === next) {
    throw membershipError(`This membership is already ${next}`);
  }

  if (!(ALLOWED_TRANSITIONS[this.status] || []).includes(next)) {
    throw membershipError(`Cannot move a membership from ${this.status} to ${next}`);
  }

  this.status = next;

  if (next === 'active') {
    this.joinedAt = this.joinedAt || new Date();
    this.leftAt = null;
    this.leaveReason = '';
  }

  if (next === 'left') {
    this.leftAt = new Date();
    this.leaveReason = note;
  }

  if (['active', 'rejected'].includes(next) && actorId) {
    this.decidedBy = actorId;
    this.decidedAt = new Date();
    this.decisionNote = note;
  }

  return this;
};

clubMembershipSchema.pre('validate', async function () {
  if (this.leftAt && this.joinedAt && this.leftAt < this.joinedAt) {
    throw membershipError('The leave date cannot fall before the join date');
  }
});

module.exports = mongoose.model('ClubMembership', clubMembershipSchema);
module.exports.MEMBERSHIP_STATUSES = MEMBERSHIP_STATUSES;
module.exports.MEMBER_ROLES = MEMBER_ROLES;
module.exports.ALLOWED_TRANSITIONS = ALLOWED_TRANSITIONS;
module.exports.membershipError = membershipError;
