const mongoose = require('mongoose');

const OUTCOMES = ['returned-to-class', 'rested-in-infirmary', 'sent-home', 'referred-to-hospital'];

// Outcomes that mean the child left the school's care. A parent must have been
// told before one of these is recorded.
const OUTCOMES_REQUIRING_NOTIFICATION = ['sent-home', 'referred-to-hospital'];

const visitError = (message) => {
  const error = new Error(message);
  error.userFacing = true;
  return error;
};

const medicationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Medication name is required'],
      trim: true,
      maxlength: [120, 'Medication name cannot exceed 120 characters'],
    },
    dosage: {
      type: String,
      trim: true,
      maxlength: [80, 'Dosage cannot exceed 80 characters'],
      default: '',
    },
    administeredAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const infirmaryVisitSchema = new mongoose.Schema(
  {
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

    visitedAt: {
      type: Date,
      required: [true, 'Visit time is required'],
      default: Date.now,
    },

    complaint: {
      type: String,
      required: [true, 'A complaint is required'],
      trim: true,
      minlength: [3, 'Please describe the complaint'],
      maxlength: [500, 'Complaint cannot exceed 500 characters'],
    },

    symptoms: {
      type: [String],
      default: [],
    },

    // Bounds are deliberately wide enough to cover genuine emergencies but
    // narrow enough to catch a Fahrenheit reading typed into a Celsius field.
    temperatureCelsius: {
      type: Number,
      default: null,
      min: [30, 'A temperature below 30°C is not plausible — is this a Fahrenheit reading?'],
      max: [45, 'A temperature above 45°C is not plausible — is this a Fahrenheit reading?'],
    },

    bloodPressure: {
      type: String,
      trim: true,
      match: [/^\d{2,3}\/\d{2,3}$/, 'Blood pressure should look like 120/80'],
      default: undefined,
    },

    pulseBpm: {
      type: Number,
      default: null,
      min: [20, 'Pulse looks too low to be real'],
      max: [250, 'Pulse looks too high to be real'],
    },

    treatmentGiven: {
      type: String,
      trim: true,
      maxlength: [1000, 'Treatment notes cannot exceed 1000 characters'],
      default: '',
    },

    medicationsAdministered: {
      type: [medicationSchema],
      default: [],
    },

    outcome: {
      type: String,
      enum: {
        values: OUTCOMES,
        message: 'Invalid visit outcome',
      },
      required: [true, 'An outcome is required'],
      default: 'returned-to-class',
    },

    restDurationMinutes: {
      type: Number,
      default: 0,
      min: [0, 'Rest duration cannot be negative'],
      max: [600, 'Rest duration cannot exceed 10 hours'],
    },

    parentNotified: {
      type: Boolean,
      default: false,
    },

    notifiedAt: {
      type: Date,
      default: null,
    },

    notifiedVia: {
      type: String,
      trim: true,
      maxlength: [50, 'Notification channel cannot exceed 50 characters'],
      default: '',
    },

    followUpRequired: {
      type: Boolean,
      default: false,
    },

    followUpOn: {
      type: Date,
      default: null,
    },

    followUpCompleted: {
      type: Boolean,
      default: false,
    },

    // Always taken from the authenticated user — the controller strips any
    // value sent in the body.
    attendedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'The attending staff member is required'],
    },

    attendedByName: {
      type: String,
      trim: true,
      default: '',
    },

    notes: {
      type: String,
      trim: true,
      maxlength: [1000, 'Notes cannot exceed 1000 characters'],
      default: '',
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

infirmaryVisitSchema.index({ student: 1, visitedAt: -1 });
infirmaryVisitSchema.index({ outcome: 1, visitedAt: -1 });
infirmaryVisitSchema.index({ followUpRequired: 1, followUpOn: 1 });

infirmaryVisitSchema.virtual('isSerious').get(function () {
  return OUTCOMES_REQUIRING_NOTIFICATION.includes(this.outcome);
});

infirmaryVisitSchema.virtual('followUpOverdue').get(function () {
  if (!this.followUpRequired || this.followUpCompleted) return false;
  if (!this.followUpOn) return false;
  return this.followUpOn < new Date();
});

infirmaryVisitSchema.methods.markParentNotified = function (via = 'phone') {
  this.parentNotified = true;
  this.notifiedAt = new Date();
  this.notifiedVia = via;
  return this;
};

infirmaryVisitSchema.pre('validate', async function () {
  if (this.visitedAt && this.visitedAt > new Date(Date.now() + 60 * 1000)) {
    throw visitError('A visit cannot be recorded in the future');
  }

  // A child sent home or to hospital without the parent being told is the one
  // failure mode this log exists to prevent.
  if (OUTCOMES_REQUIRING_NOTIFICATION.includes(this.outcome) && !this.parentNotified) {
    throw visitError(
      `Outcome "${this.outcome}" requires the parent to have been notified before it can be saved`
    );
  }

  if (this.parentNotified && !this.notifiedAt) {
    this.notifiedAt = new Date();
  }

  if (this.followUpRequired && !this.followUpOn) {
    throw visitError('A follow-up needs a date');
  }
});

module.exports = mongoose.model('InfirmaryVisit', infirmaryVisitSchema);
module.exports.OUTCOMES = OUTCOMES;
module.exports.OUTCOMES_REQUIRING_NOTIFICATION = OUTCOMES_REQUIRING_NOTIFICATION;
module.exports.visitError = visitError;
