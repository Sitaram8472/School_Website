const mongoose = require('mongoose');

const ASSIGNMENT_STATUSES = ['draft', 'published', 'closed', 'archived'];

const attachmentSchema = new mongoose.Schema(
  {
    fileName: { type: String, required: true },
    fileUrl: { type: String, required: true },
    fileType: { type: String },
    fileSize: { type: Number, min: [0, 'File size cannot be negative'] },
  },
  { _id: false }
);

const assignmentSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      minlength: [3, 'Title must be at least 3 characters'],
      maxlength: [200, 'Title cannot exceed 200 characters'],
    },

    description: {
      type: String,
      required: [true, 'Description is required'],
      trim: true,
      minlength: [10, 'Description must be at least 10 characters'],
      maxlength: [5000, 'Description cannot exceed 5000 characters'],
    },

    instructions: {
      type: String,
      trim: true,
      maxlength: [5000, 'Instructions cannot exceed 5000 characters'],
      default: '',
    },

    subject: {
      type: String,
      required: [true, 'Subject is required'],
      trim: true,
      maxlength: [100, 'Subject cannot exceed 100 characters'],
    },

    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      default: null,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Creator is required'],
    },

    teacherName: {
      type: String,
      trim: true,
      maxlength: [100, 'Teacher name cannot exceed 100 characters'],
    },

    targetClass: {
      type: String,
      trim: true,
      default: 'All Classes',
      maxlength: [50, 'Target class cannot exceed 50 characters'],
    },

    dueDate: {
      type: Date,
      required: [true, 'Due date is required'],
    },

    maxPoints: {
      type: Number,
      default: 100,
      min: [1, 'Maximum points must be at least 1'],
      max: [1000, 'Maximum points cannot exceed 1000'],
    },

    allowLateSubmission: {
      type: Boolean,
      default: true,
    },

    status: {
      type: String,
      enum: {
        values: ASSIGNMENT_STATUSES,
        message: 'Invalid assignment status',
      },
      default: 'draft',
    },

    publishedAt: {
      type: Date,
      default: null,
    },

    closedAt: {
      type: Date,
      default: null,
    },

    attachments: {
      type: [attachmentSchema],
      default: [],
    },

    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Frequently queried combinations.
assignmentSchema.index({ createdBy: 1, deletedAt: 1 });
assignmentSchema.index({ status: 1, dueDate: 1 });
assignmentSchema.index({ targetClass: 1, status: 1 });
assignmentSchema.index({ subject: 1 });

/**
 * True once the due date has passed. Draft and archived assignments are never
 * reported as overdue because students cannot act on them.
 */
assignmentSchema.virtual('isOverdue').get(function () {
  if (!this.dueDate || this.status === 'draft' || this.status === 'archived') {
    return false;
  }
  return this.dueDate.getTime() < Date.now();
});

/**
 * Whole days left until the deadline. Negative once the deadline has passed,
 * which lets the UI render "3 days overdue" without a second calculation.
 */
assignmentSchema.virtual('daysRemaining').get(function () {
  if (!this.dueDate) return null;
  const msPerDay = 24 * 60 * 60 * 1000;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const due = new Date(this.dueDate);
  due.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - startOfToday.getTime()) / msPerDay);
});

/**
 * Whether a submission is still accepted right now. Kept on the model so the
 * controller and any future scheduler agree on the rule.
 */
assignmentSchema.methods.acceptsSubmissions = function () {
  if (this.status !== 'published') return false;
  if (this.deletedAt) return false;
  if (this.dueDate.getTime() >= Date.now()) return true;
  return this.allowLateSubmission === true;
};

/**
 * Ownership check used by every mutating endpoint. Admins bypass ownership so
 * they can clean up after a teacher who has left.
 */
assignmentSchema.methods.isEditableBy = function (user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return this.createdBy.toString() === user._id.toString();
};

assignmentSchema.statics.STATUSES = ASSIGNMENT_STATUSES;

module.exports = mongoose.model('Assignment', assignmentSchema);
