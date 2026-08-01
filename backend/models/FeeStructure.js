const mongoose = require('mongoose');

/**
 * A single billable line on a fee structure — "Tuition", "Transport",
 * "Laboratory" and so on. Optional components let a school bill transport only
 * to the students who use the bus.
 */
const feeComponentSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      required: [true, 'Component label is required'],
      trim: true,
      maxlength: [100, 'Component label cannot exceed 100 characters'],
    },
    amount: {
      type: Number,
      required: [true, 'Component amount is required'],
      min: [0, 'Component amount cannot be negative'],
    },
    mandatory: {
      type: Boolean,
      default: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: [300, 'Component description cannot exceed 300 characters'],
      default: '',
    },
  },
  { _id: false }
);

const feeStructureSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Fee structure name is required'],
      trim: true,
      minlength: [3, 'Name must be at least 3 characters'],
      maxlength: [150, 'Name cannot exceed 150 characters'],
    },

    academicYear: {
      type: String,
      required: [true, 'Academic year is required'],
      trim: true,
      match: [/^\d{4}-\d{2,4}$/, 'Academic year must look like 2025-26 or 2025-2026'],
    },

    className: {
      type: String,
      required: [true, 'Class name is required'],
      trim: true,
      maxlength: [50, 'Class name cannot exceed 50 characters'],
    },

    components: {
      type: [feeComponentSchema],
      validate: {
        validator: (components) => Array.isArray(components) && components.length > 0,
        message: 'A fee structure needs at least one component',
      },
    },

    // Always derived from `components` in the pre-validate hook below — the
    // client never gets to set the total it will be billed.
    totalAmount: {
      type: Number,
      default: 0,
      min: [0, 'Total amount cannot be negative'],
    },

    dueDate: {
      type: Date,
      required: [true, 'Due date is required'],
    },

    lateFeePerDay: {
      type: Number,
      default: 0,
      min: [0, 'Late fee cannot be negative'],
      max: [10000, 'Late fee per day is unreasonably high'],
    },

    // Cap so an invoice left unpaid for a year does not accrue an absurd fine.
    maxLateFee: {
      type: Number,
      default: 0,
      min: [0, 'Maximum late fee cannot be negative'],
    },

    currency: {
      type: String,
      default: 'INR',
      trim: true,
      uppercase: true,
      maxlength: [3, 'Currency must be a 3-letter code'],
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Creator is required'],
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

feeStructureSchema.index({ academicYear: 1, className: 1 });
feeStructureSchema.index({ isActive: 1 });

/**
 * The total is the sum of the components, recomputed on every save. Anything
 * the client sent in `totalAmount` is discarded.
 */
feeStructureSchema.pre('validate', function (next) {
  if (Array.isArray(this.components)) {
    this.totalAmount = this.components.reduce(
      (sum, component) => sum + (Number(component.amount) || 0),
      0
    );
  }
  next();
});

/**
 * Build the line items for an invoice generated from this structure. Optional
 * components can be excluded per student by label.
 */
feeStructureSchema.methods.buildLineItems = function (excludedLabels = []) {
  const excluded = new Set(excludedLabels.map((label) => String(label).toLowerCase()));

  return this.components
    .filter((component) => component.mandatory || !excluded.has(component.label.toLowerCase()))
    .map((component) => ({
      label: component.label,
      amount: component.amount,
    }));
};

module.exports = mongoose.model('FeeStructure', feeStructureSchema);
