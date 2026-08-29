const mongoose = require('mongoose');

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown'];
const SEVERITIES = ['mild', 'moderate', 'severe'];

const healthError = (message) => {
  const error = new Error(message);
  error.userFacing = true;
  return error;
};

const allergySchema = new mongoose.Schema(
  {
    allergen: {
      type: String,
      required: [true, 'Allergen is required'],
      trim: true,
      maxlength: [100, 'Allergen cannot exceed 100 characters'],
    },
    severity: {
      type: String,
      enum: {
        values: SEVERITIES,
        message: 'Invalid severity',
      },
      default: 'mild',
    },
    reaction: {
      type: String,
      trim: true,
      maxlength: [300, 'Reaction cannot exceed 300 characters'],
      default: '',
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [300, 'Notes cannot exceed 300 characters'],
      default: '',
    },
  },
  { _id: true }
);

const conditionSchema = new mongoose.Schema(
  {
    condition: {
      type: String,
      required: [true, 'Condition is required'],
      trim: true,
      maxlength: [120, 'Condition cannot exceed 120 characters'],
    },
    diagnosedOn: {
      type: Date,
      default: null,
    },
    medication: {
      type: String,
      trim: true,
      maxlength: [200, 'Medication cannot exceed 200 characters'],
      default: '',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [300, 'Notes cannot exceed 300 characters'],
      default: '',
    },
  },
  { _id: true }
);

const vaccinationSchema = new mongoose.Schema(
  {
    vaccine: {
      type: String,
      required: [true, 'Vaccine name is required'],
      trim: true,
      maxlength: [120, 'Vaccine name cannot exceed 120 characters'],
    },
    doseNumber: {
      type: Number,
      default: 1,
      min: [1, 'Dose number starts at 1'],
      max: [20, 'Dose number cannot exceed 20'],
    },
    administeredOn: {
      type: Date,
      required: [true, 'Administered date is required'],
    },
    nextDueOn: {
      type: Date,
      default: null,
    },
    provider: {
      type: String,
      trim: true,
      maxlength: [150, 'Provider cannot exceed 150 characters'],
      default: '',
    },
  },
  { _id: true }
);

const emergencyContactSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Contact name is required'],
      trim: true,
      maxlength: [100, 'Contact name cannot exceed 100 characters'],
    },
    relation: {
      type: String,
      required: [true, 'Relation is required'],
      trim: true,
      maxlength: [50, 'Relation cannot exceed 50 characters'],
    },
    phone: {
      type: String,
      required: [true, 'Contact phone is required'],
      trim: true,
      match: [/^[0-9+\-\s]{7,20}$/, 'Please enter a valid phone number'],
    },
    isPrimary: {
      type: Boolean,
      default: false,
    },
  },
  { _id: true }
);

const healthProfileSchema = new mongoose.Schema(
  {
    // One profile per student. The unique index is what makes the upsert in the
    // controller safe against two simultaneous creates.
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Student is required'],
      unique: true,
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

    bloodGroup: {
      type: String,
      enum: {
        values: BLOOD_GROUPS,
        message: 'Invalid blood group',
      },
      default: 'unknown',
    },

    dateOfBirth: {
      type: Date,
      default: null,
    },

    heightCm: {
      type: Number,
      default: null,
      min: [30, 'Height looks too low to be real'],
      max: [260, 'Height looks too high to be real'],
    },

    weightKg: {
      type: Number,
      default: null,
      min: [2, 'Weight looks too low to be real'],
      max: [300, 'Weight looks too high to be real'],
    },

    allergies: {
      type: [allergySchema],
      default: [],
    },

    chronicConditions: {
      type: [conditionSchema],
      default: [],
    },

    vaccinations: {
      type: [vaccinationSchema],
      default: [],
    },

    emergencyContacts: {
      type: [emergencyContactSchema],
      default: [],
    },

    physician: {
      name: {
        type: String,
        trim: true,
        maxlength: [100, 'Physician name cannot exceed 100 characters'],
        default: '',
      },
      phone: {
        type: String,
        trim: true,
        default: '',
      },
      hospital: {
        type: String,
        trim: true,
        maxlength: [150, 'Hospital name cannot exceed 150 characters'],
        default: '',
      },
    },

    insurancePolicyNumber: {
      type: String,
      trim: true,
      maxlength: [60, 'Policy number cannot exceed 60 characters'],
      default: '',
    },

    dietaryRestrictions: {
      type: [String],
      default: [],
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
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

healthProfileSchema.index({ className: 1 });
healthProfileSchema.index({ 'allergies.severity': 1 });

healthProfileSchema.virtual('age').get(function () {
  if (!this.dateOfBirth) return null;

  const now = new Date();
  let age = now.getFullYear() - this.dateOfBirth.getFullYear();

  // Not yet had this year's birthday.
  const monthDelta = now.getMonth() - this.dateOfBirth.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < this.dateOfBirth.getDate())) {
    age -= 1;
  }

  return age >= 0 ? age : null;
});

healthProfileSchema.virtual('bmi').get(function () {
  if (!this.heightCm || !this.weightKg) return null;
  const metres = this.heightCm / 100;
  return Number((this.weightKg / (metres * metres)).toFixed(1));
});

/**
 * Everything the nurse must see before treating this student, in one array.
 * Surfacing it as a virtual means the "critical alerts" strip cannot fall out
 * of step with the underlying allergy and condition lists.
 */
healthProfileSchema.virtual('criticalAlerts').get(function () {
  const alerts = [];

  (this.allergies || [])
    .filter((allergy) => allergy.severity === 'severe')
    .forEach((allergy) => {
      alerts.push({
        kind: 'allergy',
        label: allergy.allergen,
        detail: allergy.reaction || 'Severe allergic reaction',
        severity: 'severe',
      });
    });

  (this.chronicConditions || [])
    .filter((condition) => condition.isActive)
    .forEach((condition) => {
      alerts.push({
        kind: 'condition',
        label: condition.condition,
        detail: condition.medication ? `On ${condition.medication}` : 'Ongoing condition',
        severity: 'moderate',
      });
    });

  return alerts;
});

healthProfileSchema.virtual('primaryContact').get(function () {
  return (this.emergencyContacts || []).find((contact) => contact.isPrimary) || null;
});

/**
 * Vaccinations whose next dose has come due, so the infirmary can chase them
 * rather than discovering the gap at an inspection.
 */
healthProfileSchema.methods.overdueVaccinations = function (asOf = new Date()) {
  return (this.vaccinations || []).filter(
    (shot) => shot.nextDueOn && shot.nextDueOn <= asOf
  );
};

healthProfileSchema.pre('validate', async function () {
  const contacts = this.emergencyContacts || [];
  const primaries = contacts.filter((contact) => contact.isPrimary);

  if (primaries.length > 1) {
    throw healthError('Only one emergency contact can be marked primary');
  }

  // With exactly one contact and nobody flagged, the intent is obvious — pick
  // it rather than making the office tick a box.
  if (!primaries.length && contacts.length === 1) {
    contacts[0].isPrimary = true;
    this.markModified('emergencyContacts');
  }

  if (this.dateOfBirth && this.dateOfBirth > new Date()) {
    throw healthError('Date of birth cannot be in the future');
  }

  const badShot = (this.vaccinations || []).find(
    (shot) => shot.nextDueOn && shot.administeredOn && shot.nextDueOn < shot.administeredOn
  );
  if (badShot) {
    throw healthError(`"${badShot.vaccine}" has a next-due date before the date it was given`);
  }
});

module.exports = mongoose.model('HealthProfile', healthProfileSchema);
module.exports.BLOOD_GROUPS = BLOOD_GROUPS;
module.exports.SEVERITIES = SEVERITIES;
module.exports.healthError = healthError;
