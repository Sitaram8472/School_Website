const mongoose = require('mongoose');

/**
 * One family's application against one aid program.
 *
 * The score components are stored, not just the total. A family that appeals
 * deserves an answer more specific than "you scored 61", and the office can
 * only give one if the number that actually decided it is on the record.
 */

const APPLICATION_STATUSES = [
  'draft',
  'submitted',
  'under-review',
  'approved',
  'rejected',
  'waitlisted',
  'withdrawn',
];

// Statuses a reviewer may still act on.
const REVIEWABLE_STATUSES = ['submitted', 'under-review'];

const DOCUMENT_TYPES = ['income-proof', 'marksheet', 'id-proof', 'medical', 'other'];

const scoreSchema = new mongoose.Schema(
  {
    need: { type: Number, default: 0, min: 0, max: 100 },
    merit: { type: Number, default: 0, min: 0, max: 100 },
    attendance: { type: Number, default: 0, min: 0, max: 100 },
    total: { type: Number, default: 0, min: 0, max: 100 },
    computedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const documentSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: {
        values: DOCUMENT_TYPES,
        message: 'Invalid document type',
      },
      required: [true, 'Document type is required'],
    },
    label: {
      type: String,
      required: [true, 'Document label is required'],
      trim: true,
      maxlength: [120, 'Document label cannot exceed 120 characters'],
    },
    url: {
      type: String,
      trim: true,
      maxlength: [400, 'Document URL cannot exceed 400 characters'],
      default: '',
    },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const historySchema = new mongoose.Schema(
  {
    from: { type: String, default: '' },
    to: { type: String, required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '', trim: true, maxlength: 100 },
    note: { type: String, default: '', trim: true, maxlength: 500 },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const aidApplicationSchema = new mongoose.Schema(
  {
    program: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AidProgram',
      required: [true, 'Program is required'],
    },

    programName: {
      type: String,
      trim: true,
      maxlength: [120, 'Program name cannot exceed 120 characters'],
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

    academicYear: {
      type: String,
      trim: true,
      maxlength: [20, 'Academic year cannot exceed 20 characters'],
      default: '',
    },

    // ---- Declared circumstances ----
    householdIncome: {
      type: Number,
      required: [true, 'Annual household income is required'],
      min: [0, 'Household income cannot be negative'],
    },

    dependants: {
      type: Number,
      default: 0,
      min: [0, 'Dependants cannot be negative'],
      max: [20, 'Twenty dependants looks like a data-entry error'],
    },

    guardianOccupation: {
      type: String,
      trim: true,
      maxlength: [120, 'Occupation cannot exceed 120 characters'],
      default: '',
    },

    academicPercentage: {
      type: Number,
      required: [true, 'Last year\'s academic percentage is required'],
      min: [0, 'Academic percentage cannot be negative'],
      max: [100, 'Academic percentage cannot exceed 100'],
    },

    attendancePercentage: {
      type: Number,
      default: 0,
      min: [0, 'Attendance percentage cannot be negative'],
      max: [100, 'Attendance percentage cannot exceed 100'],
    },

    amountRequested: {
      type: Number,
      required: [true, 'A requested amount is required'],
      min: [1, 'The requested amount must be positive'],
    },

    statementOfNeed: {
      type: String,
      required: [true, 'A statement of need is required'],
      trim: true,
      minlength: [50, 'Please write at least 50 characters so the committee has something to read'],
      maxlength: [2000, 'Statement of need cannot exceed 2000 characters'],
    },

    documents: {
      type: [documentSchema],
      default: [],
    },

    // ---- Server-computed ----
    score: {
      type: scoreSchema,
      default: () => ({}),
    },

    status: {
      type: String,
      enum: {
        values: APPLICATION_STATUSES,
        message: 'Invalid application status',
      },
      default: 'draft',
    },

    submittedAt: { type: Date, default: null },

    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    reviewedByName: { type: String, default: '', trim: true, maxlength: 100 },
    reviewedAt: { type: Date, default: null },

    reviewNote: {
      type: String,
      trim: true,
      maxlength: [1000, 'Review note cannot exceed 1000 characters'],
      default: '',
    },

    amountAwarded: {
      type: Number,
      default: 0,
      min: [0, 'Awarded amount cannot be negative'],
    },

    history: {
      type: [historySchema],
      default: [],
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/**
 * One application per student per program.
 *
 * Resubmission is an edit of the draft, not a second application — without this
 * a family that presses Submit twice is two applications competing for the same
 * fund, and the committee reviews the same case twice.
 */
aidApplicationSchema.index({ program: 1, student: 1 }, { unique: true });
aidApplicationSchema.index({ status: 1, 'score.total': -1 });
aidApplicationSchema.index({ student: 1, createdAt: -1 });

aidApplicationSchema.virtual('isEditable').get(function () {
  return this.status === 'draft';
});

aidApplicationSchema.virtual('isDecided').get(function () {
  return ['approved', 'rejected', 'waitlisted', 'withdrawn'].includes(this.status);
});

/**
 * Record a state change. Every transition goes through here so the trail cannot
 * have gaps — an appeal against a decision nobody wrote down is unanswerable.
 */
aidApplicationSchema.methods.recordTransition = function (to, actor, note = '') {
  this.history.push({
    from: this.status,
    to,
    by: actor ? actor._id : null,
    byName: actor ? actor.name || '' : '',
    note,
    at: new Date(),
  });
  this.status = to;
  return this;
};

/**
 * The shape a family sees. The review note is included deliberately — a family
 * told only "rejected" has been given a result, not a reason.
 */
aidApplicationSchema.methods.viewFor = function (viewer) {
  const staff = viewer.role === 'admin' || viewer.role === 'staff';
  const base = this.toObject();

  if (!staff) {
    // The internal trail is for the committee; the family gets the decision and
    // the reasoning, not every intermediate status flip.
    delete base.history;
  }

  return base;
};

aidApplicationSchema.statics.APPLICATION_STATUSES = APPLICATION_STATUSES;
aidApplicationSchema.statics.REVIEWABLE_STATUSES = REVIEWABLE_STATUSES;
aidApplicationSchema.statics.DOCUMENT_TYPES = DOCUMENT_TYPES;

module.exports = mongoose.model('AidApplication', aidApplicationSchema);
