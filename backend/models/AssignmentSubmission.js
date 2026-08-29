const mongoose = require('mongoose');

const SUBMISSION_STATUSES = ['submitted', 'late', 'graded', 'returned'];

const attachmentSchema = new mongoose.Schema(
  {
    fileName: { type: String, required: true },
    fileUrl: { type: String, required: true },
    fileType: { type: String },
    fileSize: { type: Number, min: [0, 'File size cannot be negative'] },
  },
  { _id: false }
);

const assignmentSubmissionSchema = new mongoose.Schema(
  {
    assignment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Assignment',
      required: [true, 'Assignment reference is required'],
    },

    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Student reference is required'],
    },

    studentName: {
      type: String,
      trim: true,
      maxlength: [100, 'Student name cannot exceed 100 characters'],
    },

    submissionText: {
      type: String,
      trim: true,
      maxlength: [20000, 'Submission text cannot exceed 20000 characters'],
      default: '',
    },

    attachments: {
      type: [attachmentSchema],
      default: [],
    },

    status: {
      type: String,
      enum: {
        values: SUBMISSION_STATUSES,
        message: 'Invalid submission status',
      },
      default: 'submitted',
    },

    submittedAt: {
      type: Date,
      default: Date.now,
    },

    // Number of times the student re-submitted before the deadline. Useful for
    // teachers who want to know whether a student iterated on their work.
    revisionCount: {
      type: Number,
      default: 0,
      min: [0, 'Revision count cannot be negative'],
    },

    grade: {
      type: Number,
      default: null,
      min: [0, 'Grade cannot be negative'],
    },

    feedback: {
      type: String,
      trim: true,
      maxlength: [2000, 'Feedback cannot exceed 2000 characters'],
      default: '',
    },

    gradedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    gradedAt: {
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

// A student has exactly one submission record per assignment; re-submitting
// updates the existing document rather than creating a second one.
assignmentSubmissionSchema.index({ assignment: 1, student: 1 }, { unique: true });
assignmentSubmissionSchema.index({ student: 1, status: 1 });
assignmentSubmissionSchema.index({ assignment: 1, status: 1 });

assignmentSubmissionSchema.virtual('isGraded').get(function () {
  return this.grade !== null && this.grade !== undefined;
});

assignmentSubmissionSchema.virtual('isLate').get(function () {
  return this.status === 'late';
});

/**
 * Apply a grade. Validation lives here so both the single-grade and any future
 * bulk-grade endpoint enforce the same bounds against the assignment's
 * `maxPoints`.
 */
assignmentSubmissionSchema.methods.applyGrade = function (grade, feedback, grader, maxPoints) {
  const numericGrade = Number(grade);

  if (Number.isNaN(numericGrade)) {
    throw new Error('Grade must be a number');
  }
  if (numericGrade < 0) {
    throw new Error('Grade cannot be negative');
  }
  if (typeof maxPoints === 'number' && numericGrade > maxPoints) {
    throw new Error(`Grade cannot exceed the maximum of ${maxPoints} points`);
  }

  this.grade = numericGrade;
  this.feedback = feedback || '';
  this.gradedBy = grader ? grader._id : null;
  this.gradedAt = new Date();
  this.status = 'graded';

  return this;
};

assignmentSubmissionSchema.statics.STATUSES = SUBMISSION_STATUSES;

module.exports = mongoose.model('AssignmentSubmission', assignmentSubmissionSchema);
