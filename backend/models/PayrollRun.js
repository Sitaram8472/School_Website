const mongoose = require('mongoose');

/**
 * Staff payroll.
 *
 * Two schemas in one file: a run for one month, and a payslip inside it.
 *
 * The rule the module exists for is that **no money field is ever accepted from
 * a client**. `recompute()` is the only place gross, loss of pay, statutory
 * deductions and net are produced, so there is exactly one formula for each and
 * it lives here rather than in a cell somebody copied down wrong.
 *
 * Loss of pay is prorated on gross over the run's own working days, and the
 * working-day figure is copied onto the payslip when it is computed. A calendar
 * corrected in November must not retrospectively change a payslip somebody was
 * paid against in August.
 *
 * Locking is one-way. It issues the serials, freezes every figure and has no
 * inverse: a correction is a cancellation and a new run, both on the record.
 */

const RUN_STATUSES = ['draft', 'computed', 'locked', 'paid', 'cancelled'];

// Only a locked or paid run has payslips anybody outside the office may read.
// A draft figure is a working figure, and showing it to the person it concerns
// starts an argument about a number the office has not finished computing.
const PUBLISHED_STATUSES = ['locked', 'paid'];

const EDITABLE_STATUSES = ['draft', 'computed'];

const EARNING_CODES = [
  'basic',
  'hra',
  'da',
  'transport',
  'special',
  'arrears',
  'bonus',
];

const DEDUCTION_CODES = [
  'provident-fund',
  'professional-tax',
  'income-tax',
  'insurance',
  'loan-recovery',
  'other',
];

// Deductions the server works out for itself. Anything else is typed by the
// office, which is fine — these two are the ones that are always the same
// arithmetic and always get typed wrong for exactly one person.
const DERIVED_DEDUCTION_CODES = ['provident-fund', 'professional-tax'];

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const PROVIDENT_FUND_RATE = 0.12;

// Professional tax is a slab on monthly gross, not a rate.
const PROFESSIONAL_TAX_SLABS = [
  { upTo: 15000, amount: 0 },
  { upTo: 20000, amount: 150 },
  { upTo: Infinity, amount: 200 },
];

const MIN_WORKING_DAYS = 15;
const MAX_WORKING_DAYS = 31;

// Unpaid leave is counted in halves; a quarter day is not a thing anybody runs.
const LEAVE_STEP = 0.5;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Money is rounded to whole rupees, once, in one place. */
function money(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value);
}

function professionalTaxFor(gross) {
  const slab = PROFESSIONAL_TAX_SLABS.find((s) => gross <= s.upTo);
  return slab ? slab.amount : 0;
}

function periodLabel(period) {
  if (!PERIOD_PATTERN.test(period || '')) return period || '';
  const [year, month] = period.split('-').map(Number);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

const historySchema = new mongoose.Schema(
  {
    action: { type: String, required: true, trim: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
    note: { type: String, trim: true, maxlength: 400 },
  },
  { _id: false }
);

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const payrollRunSchema = new mongoose.Schema(
  {
    period: {
      type: String,
      required: [true, 'Period is required'],
      trim: true,
      match: [PERIOD_PATTERN, 'Period must look like 2026-08'],
    },

    payDate: { type: Date, required: [true, 'Pay date is required'] },

    workingDays: {
      type: Number,
      required: true,
      min: [MIN_WORKING_DAYS, 'A month with fewer than 15 working days is not a payroll month'],
      max: [MAX_WORKING_DAYS, 'A month has at most 31 days'],
    },

    notes: { type: String, trim: true, maxlength: 500 },

    status: { type: String, enum: RUN_STATUSES, default: 'draft', index: true },

    // Derived from `status` on every save; it exists so the one-run-per-period
    // index has an equality to filter on.
    isLive: { type: Boolean, default: true },

    // Every figure below is written by the recompute, never by a request.
    totals: {
      headcount: { type: Number, default: 0 },
      gross: { type: Number, default: 0 },
      lossOfPay: { type: Number, default: 0 },
      deductions: { type: Number, default: 0 },
      net: { type: Number, default: 0 },
    },

    // Serials come off this with $inc, so two clerks locking at the same moment
    // cannot both be handed 0007.
    serialCounter: { type: Number, default: 0 },

    computedAt: Date,
    lockedAt: Date,
    lockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    paidAt: Date,
    cancelledAt: Date,
    cancellationReason: { type: String, trim: true, maxlength: 400 },

    // A digest over every payslip's net at the moment of locking.
    fingerprint: { type: String, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

// One live run per month. A correction is a cancellation and a new run, not a
// second file that disagrees with the first.
//
// The filter is `isLive: true` rather than `status: { $ne: 'cancelled' }`
// because a partial index cannot express a negation — MongoDB refuses `$ne` at
// index creation. `isLive` is derived from the status on every save, so the two
// cannot drift apart.
payrollRunSchema.index(
  { period: 1 },
  { unique: true, partialFilterExpression: { isLive: true } }
);

payrollRunSchema.pre('save', function deriveIsLive() {
  this.isLive = this.status !== 'cancelled';
});

payrollRunSchema.virtual('periodLabel').get(function label() {
  return periodLabel(this.period);
});

payrollRunSchema.methods.isEditable = function isEditable() {
  return EDITABLE_STATUSES.includes(this.status);
};

payrollRunSchema.methods.isPublished = function isPublished() {
  return PUBLISHED_STATUSES.includes(this.status);
};

payrollRunSchema.methods.recordHistory = function recordHistory(action, by, note) {
  this.history.push({ action, by, note, at: new Date() });
  if (this.history.length > 200) this.history = this.history.slice(-200);
  return this;
};

payrollRunSchema.methods.applyTotals = function applyTotals(payslips) {
  this.totals = payslips.reduce(
    (acc, slip) => ({
      headcount: acc.headcount + 1,
      gross: acc.gross + slip.grossEarnings,
      lossOfPay: acc.lossOfPay + slip.lossOfPay,
      deductions: acc.deductions + slip.totalDeductions,
      net: acc.net + slip.netPay,
    }),
    { headcount: 0, gross: 0, lossOfPay: 0, deductions: 0, net: 0 }
  );
  return this.totals;
};

/** A digest over what was locked, so a later disagreement is detectable. */
payrollRunSchema.statics.fingerprintOf = function fingerprintOf(payslips) {
  const material = payslips
    .map((slip) => `${slip.staff}:${slip.netPay}`)
    .sort()
    .join('|');

  let hash = 5381;
  for (let i = 0; i < material.length; i += 1) {
    hash = ((hash << 5) + hash + material.charCodeAt(i)) | 0;
  }
  return `p${(hash >>> 0).toString(16)}:${payslips.length}`;
};

payrollRunSchema.set('toJSON', { virtuals: true });
payrollRunSchema.set('toObject', { virtuals: true });

// ---------------------------------------------------------------------------
// Payslip
// ---------------------------------------------------------------------------

const lineSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true },
    label: { type: String, trim: true, maxlength: 60 },
    amount: {
      type: Number,
      required: true,
      min: [0, 'A negative line is a line on the other side of the payslip'],
      max: [10000000, 'That figure is out by a factor of something'],
    },
  },
  { _id: false }
);

const payslipSchema = new mongoose.Schema(
  {
    run: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PayrollRun',
      required: true,
      index: true,
    },

    staff: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // Copied at computation. A person's designation changing in December must
    // not rewrite what their August payslip says.
    designationSnapshot: { type: String, trim: true, maxlength: 80 },

    serial: { type: String, default: null },

    earnings: {
      type: [lineSchema],
      default: [],
      validate: {
        validator: (list) => list.every((line) => EARNING_CODES.includes(line.code)),
        message: 'Unknown earning code',
      },
    },

    deductions: {
      type: [lineSchema],
      default: [],
      validate: {
        validator: (list) => list.every((line) => DEDUCTION_CODES.includes(line.code)),
        message: 'Unknown deduction code',
      },
    },

    // The single input behind loss of pay.
    unpaidLeaveDays: {
      type: Number,
      default: 0,
      min: [0, 'Unpaid leave cannot be negative'],
      max: [MAX_WORKING_DAYS, 'That is more unpaid days than the month has'],
      validate: {
        validator: (value) => Number.isFinite(value) && (value * 2) % 1 === 0,
        message: 'Unpaid leave is counted in half days',
      },
    },

    // An override exists because the default is right for almost everybody, and
    // the exception should have to say why rather than be typed silently.
    providentFundOverride: {
      amount: { type: Number, default: null, min: 0 },
      reason: { type: String, trim: true, maxlength: 200 },
    },

    // Derived, all of them.
    workingDaysSnapshot: { type: Number, default: 0 },
    grossEarnings: { type: Number, default: 0 },
    lossOfPay: { type: Number, default: 0 },
    totalDeductions: { type: Number, default: 0 },
    netPay: { type: Number, default: 0 },

    computedAt: Date,
    lockedAt: { type: Date, default: null },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

// One person appears once in a run. The duplicated spreadsheet row becomes
// impossible rather than unlikely.
payslipSchema.index({ run: 1, staff: 1 }, { unique: true });
payslipSchema.index({ staff: 1, createdAt: -1 });

payslipSchema.methods.earningFor = function earningFor(code) {
  const line = this.earnings.find((entry) => entry.code === code);
  return line ? line.amount : 0;
};

payslipSchema.methods.deductionFor = function deductionFor(code) {
  const line = this.deductions.find((entry) => entry.code === code);
  return line ? line.amount : 0;
};

function upsertLine(list, code, label, amount) {
  const existing = list.find((line) => line.code === code);
  if (existing) {
    existing.amount = amount;
    existing.label = existing.label || label;
    return;
  }
  list.push({ code, label, amount });
}

/**
 * The only place money is produced.
 *
 * Returns a plain description of what it did, so a caller can refuse the
 * payslip and say which two figures do not work rather than saving a negative
 * salary and letting the bank find out.
 */
payslipSchema.methods.recompute = function recompute(workingDays) {
  const days = Number(workingDays) || this.workingDaysSnapshot || MAX_WORKING_DAYS;
  this.workingDaysSnapshot = days;

  this.grossEarnings = money(
    this.earnings.reduce((sum, line) => sum + (Number(line.amount) || 0), 0)
  );

  // Prorated on gross, over this run's own working days, rounded once.
  this.lossOfPay = money((this.grossEarnings / days) * (Number(this.unpaidLeaveDays) || 0));

  const basic = this.earningFor('basic');
  const providentFund =
    this.providentFundOverride && this.providentFundOverride.amount !== null
      ? money(this.providentFundOverride.amount)
      : money(basic * PROVIDENT_FUND_RATE);

  upsertLine(this.deductions, 'provident-fund', 'Provident fund', providentFund);
  upsertLine(
    this.deductions,
    'professional-tax',
    'Professional tax',
    professionalTaxFor(this.grossEarnings)
  );

  this.totalDeductions = money(
    this.deductions.reduce((sum, line) => sum + (Number(line.amount) || 0), 0)
  );

  this.netPay = money(this.grossEarnings - this.lossOfPay - this.totalDeductions);
  this.computedAt = new Date();

  return {
    valid: this.netPay >= 0,
    grossEarnings: this.grossEarnings,
    lossOfPay: this.lossOfPay,
    totalDeductions: this.totalDeductions,
    netPay: this.netPay,
  };
};

/** The sentence to refuse with. It has to name both figures to be useful. */
payslipSchema.methods.shortfallMessage = function shortfallMessage() {
  const payable = this.grossEarnings - this.lossOfPay;
  return `Deductions of ${this.totalDeductions} exceed the ${payable} payable after loss of pay`;
};

payslipSchema.methods.isLocked = function isLocked() {
  return Boolean(this.lockedAt);
};

payslipSchema.methods.recordHistory = function recordHistory(action, by, note) {
  this.history.push({ action, by, note, at: new Date() });
  if (this.history.length > 60) this.history = this.history.slice(-60);
  return this;
};

/**
 * A locked payslip is finished.
 *
 * The one save allowed to touch a locked payslip is the save that locks it —
 * everything afterwards is refused here rather than politely disabled in a
 * form, because the form is not what a payslip needs protecting from.
 */
payslipSchema.pre('save', function refuseEditsAfterLock() {
  if (this.isNew) return;
  if (!this.lockedAt) return;
  if (this.isModified('lockedAt') || this.isModified('serial')) return;

  const changed = this.modifiedPaths().filter((path) => path !== 'updatedAt');
  if (changed.length) {
    throw new Error(
      `Payslip ${this.serial || this._id} is locked; cancel the run and issue a corrected one`
    );
  }
});

payslipSchema.set('toJSON', { virtuals: true });
payslipSchema.set('toObject', { virtuals: true });

const PayrollRun = mongoose.model('PayrollRun', payrollRunSchema);
const Payslip = mongoose.model('Payslip', payslipSchema);

module.exports = {
  PayrollRun,
  Payslip,
  RUN_STATUSES,
  PUBLISHED_STATUSES,
  EDITABLE_STATUSES,
  EARNING_CODES,
  DEDUCTION_CODES,
  DERIVED_DEDUCTION_CODES,
  PROVIDENT_FUND_RATE,
  PROFESSIONAL_TAX_SLABS,
  LEAVE_STEP,
  periodLabel,
  professionalTaxFor,
};
