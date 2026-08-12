const mongoose = require('mongoose');

/**
 * Physical asset register.
 *
 * The school owns a few hundred things that move — projectors, laptop
 * trolleys, microscopes, instruments — and tracks none of them. Custody is
 * oral, so the trail ends at whoever anybody happens to remember, and the
 * "signed out" and "signed back in" columns of the paper notebook are the same
 * column, which is how one projector ends up out to two people at once.
 *
 * Two things here are structural rather than procedural.
 *
 * `custody` is an append-only chain in which **at most one row may be open** —
 * open meaning `returnedAt` is unset. `openCustody()` finds it, `issueTo()`
 * refuses when one exists, and `transferTo()` closes the current row and opens
 * the next inside a single save. There is no path through this model that
 * leaves an asset in two hands, and no path that loses a hop.
 *
 * `netBookValue()` is straight-line depreciation computed on read. It is not a
 * field, so there is nothing to recompute in August and nothing to go stale in
 * September.
 */

const CATEGORIES = [
  'it-equipment',
  'lab-equipment',
  'furniture',
  'sports',
  'music',
  'library',
  'av',
  'kitchen',
  'maintenance',
  'vehicle',
  'other',
];

const CONDITIONS = ['new', 'good', 'fair', 'poor', 'unserviceable'];

const STATUSES = [
  'in-store',
  'assigned',
  'in-maintenance',
  'retired',
  'lost',
  'written-off',
];

// An asset in one of these states is still part of the working stock.
const ACTIVE_STATUSES = ['in-store', 'assigned', 'in-maintenance'];

// An asset in one of these has left the register and cannot be issued again.
const CLOSED_STATUSES = ['retired', 'lost', 'written-off'];

const FAULT_SEVERITIES = ['minor', 'moderate', 'major', 'critical'];
const FAULT_STATUSES = ['reported', 'triaged', 'with-vendor', 'resolved', 'unrepairable'];

const DISPOSAL_METHODS = ['sold', 'donated', 'recycled', 'scrapped', 'returned-to-supplier'];

// Sensible straight-line lives, used when nobody supplies one. A projector and
// a filing cabinet do not depreciate at the same rate and pretending they do is
// how the insurance schedule ends up wrong.
const DEFAULT_LIFE_YEARS = {
  'it-equipment': 4,
  'lab-equipment': 8,
  furniture: 10,
  sports: 5,
  music: 10,
  library: 7,
  av: 6,
  kitchen: 8,
  maintenance: 8,
  vehicle: 8,
  other: 5,
};

const MAX_CUSTODY_ROWS = 500;

const custodySchema = new mongoose.Schema(
  {
    holder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A custody row must name its holder'],
    },
    // Snapshotted so a leaver's name does not vanish from the chain when their
    // account is removed. The chain is the evidence; it has to stand alone.
    holderName: {
      type: String,
      trim: true,
      maxlength: [120, 'Holder name cannot exceed 120 characters'],
    },
    location: {
      type: String,
      trim: true,
      maxlength: [120, 'Location cannot exceed 120 characters'],
    },
    purpose: {
      type: String,
      trim: true,
      maxlength: [300, 'Purpose cannot exceed 300 characters'],
    },
    issuedAt: {
      type: Date,
      default: Date.now,
    },
    issuedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    dueBack: {
      type: Date,
    },
    returnedAt: {
      type: Date,
    },
    returnedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    // Condition at both ends of the loan. The difference between them is the
    // only evidence that damage happened on somebody's watch, and it can only
    // be captured at the moment of return.
    conditionOut: {
      type: String,
      enum: { values: CONDITIONS, message: 'Invalid condition' },
    },
    conditionIn: {
      type: String,
      enum: { values: CONDITIONS, message: 'Invalid condition' },
    },
    note: {
      type: String,
      trim: true,
      maxlength: [500, 'Note cannot exceed 500 characters'],
    },
  },
  { _id: true, timestamps: false }
);

const maintenanceSchema = new mongoose.Schema(
  {
    reportedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    reportedAt: {
      type: Date,
      default: Date.now,
    },
    // Which custody row the asset was on when the fault appeared. This is what
    // turns "it was already broken" into something checkable.
    custodyRef: {
      type: mongoose.Schema.Types.ObjectId,
    },
    fault: {
      type: String,
      required: [true, 'Describe the fault'],
      trim: true,
      minlength: [5, 'Please describe the fault in a little more detail'],
      maxlength: [1000, 'Fault description cannot exceed 1000 characters'],
    },
    severity: {
      type: String,
      enum: { values: FAULT_SEVERITIES, message: 'Invalid severity' },
      default: 'moderate',
    },
    status: {
      type: String,
      enum: { values: FAULT_STATUSES, message: 'Invalid maintenance status' },
      default: 'reported',
    },
    vendor: {
      type: String,
      trim: true,
      maxlength: [120, 'Vendor cannot exceed 120 characters'],
    },
    cost: {
      type: Number,
      min: [0, 'Repair cost cannot be negative'],
    },
    resolvedAt: {
      type: Date,
    },
    resolution: {
      type: String,
      trim: true,
      maxlength: [1000, 'Resolution cannot exceed 1000 characters'],
    },
  },
  { _id: true, timestamps: false }
);

const historySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: [40, 'Action cannot exceed 40 characters'],
    },
    from: { type: String, trim: true, maxlength: [120, 'From cannot exceed 120 characters'] },
    to: { type: String, trim: true, maxlength: [120, 'To cannot exceed 120 characters'] },
    note: { type: String, trim: true, maxlength: [500, 'Note cannot exceed 500 characters'] },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
  },
  { _id: true, timestamps: false }
);

const assetSchema = new mongoose.Schema(
  {
    assetTag: {
      type: String,
      required: [true, 'An asset tag is required'],
      unique: true,
      trim: true,
      uppercase: true,
      minlength: [3, 'An asset tag must be at least 3 characters'],
      maxlength: [30, 'An asset tag cannot exceed 30 characters'],
      match: [/^[A-Z0-9][A-Z0-9/-]*$/, 'Use letters, digits, hyphens and slashes only'],
    },
    name: {
      type: String,
      required: [true, 'A name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [120, 'Name cannot exceed 120 characters'],
    },
    category: {
      type: String,
      required: [true, 'A category is required'],
      enum: { values: CATEGORIES, message: 'Invalid category' },
    },
    description: {
      type: String,
      trim: true,
      maxlength: [1000, 'Description cannot exceed 1000 characters'],
    },
    serialNumber: {
      type: String,
      trim: true,
      maxlength: [80, 'Serial number cannot exceed 80 characters'],
    },
    manufacturer: {
      type: String,
      trim: true,
      maxlength: [80, 'Manufacturer cannot exceed 80 characters'],
    },
    model: {
      type: String,
      trim: true,
      maxlength: [80, 'Model cannot exceed 80 characters'],
    },

    purchaseDate: {
      type: Date,
      required: [true, 'A purchase date is required'],
    },
    purchaseCost: {
      type: Number,
      required: [true, 'A purchase cost is required'],
      min: [0, 'Purchase cost cannot be negative'],
    },
    usefulLifeYears: {
      type: Number,
      min: [1, 'Useful life must be at least a year'],
      max: [50, 'Useful life cannot exceed 50 years'],
    },
    salvageValue: {
      type: Number,
      default: 0,
      min: [0, 'Salvage value cannot be negative'],
    },
    fundingSource: {
      type: String,
      trim: true,
      maxlength: [120, 'Funding source cannot exceed 120 characters'],
    },
    warrantyExpiresOn: {
      type: Date,
    },

    condition: {
      type: String,
      enum: { values: CONDITIONS, message: 'Invalid condition' },
      default: 'good',
    },
    status: {
      type: String,
      enum: { values: STATUSES, message: 'Invalid status' },
      default: 'in-store',
    },
    homeLocation: {
      type: String,
      trim: true,
      maxlength: [120, 'Home location cannot exceed 120 characters'],
    },

    custody: {
      type: [custodySchema],
      default: [],
      validate: {
        validator: (v) => v.length <= MAX_CUSTODY_ROWS,
        message: `An asset cannot carry more than ${MAX_CUSTODY_ROWS} custody rows`,
      },
    },
    maintenance: {
      type: [maintenanceSchema],
      default: [],
    },

    disposal: {
      method: {
        type: String,
        enum: { values: DISPOSAL_METHODS, message: 'Invalid disposal method' },
      },
      date: { type: Date },
      proceeds: { type: Number, min: [0, 'Proceeds cannot be negative'] },
      authorisedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      reason: { type: String, trim: true, maxlength: [500, 'Reason cannot exceed 500 characters'] },
    },

    history: {
      type: [historySchema],
      default: [],
    },
  },
  { timestamps: true }
);

assetSchema.index({ category: 1, status: 1 });
assetSchema.index({ status: 1, updatedAt: -1 });
// The two queries the register exists to answer: what am I holding, and what
// is late back. Both hang off the open custody row.
assetSchema.index({ 'custody.holder': 1, 'custody.returnedAt': 1 });
assetSchema.index({ 'custody.dueBack': 1, 'custody.returnedAt': 1 });
assetSchema.index({ 'maintenance.status': 1 });

assetSchema.pre('validate', function derive() {
  if (!this.usefulLifeYears) {
    this.usefulLifeYears = DEFAULT_LIFE_YEARS[this.category] || 5;
  }

  // Salvage above cost makes the depreciation curve run upward, which is not a
  // thing. Caught here rather than left to produce a nonsense book value.
  if (
    Number.isFinite(this.purchaseCost) &&
    Number.isFinite(this.salvageValue) &&
    this.salvageValue > this.purchaseCost
  ) {
    this.invalidate('salvageValue', 'Salvage value cannot exceed the purchase cost');
  }

  if (this.purchaseDate && this.purchaseDate.getTime() > Date.now()) {
    this.invalidate('purchaseDate', 'An asset cannot have been bought in the future');
  }

  // The status is derived from the custody chain rather than set alongside it,
  // so the two can never disagree. The closed statuses are left alone: a lost
  // asset with a stale open row must keep saying it is lost.
  if (!CLOSED_STATUSES.includes(this.status)) {
    const open = this.openCustody();
    if (open) {
      this.status = 'assigned';
    } else if (this.status === 'assigned') {
      this.status = 'in-store';
    }
  }
});

/**
 * The one open custody row, or null. "Open" means it has not been returned.
 *
 * Everything else in this model is built on this being at most one row, which
 * `issueTo` and `transferTo` are jointly responsible for keeping true.
 */
assetSchema.methods.openCustody = function openCustody() {
  for (let i = this.custody.length - 1; i >= 0; i -= 1) {
    if (!this.custody[i].returnedAt) return this.custody[i];
  }
  return null;
};

assetSchema.methods.isOut = function isOut() {
  return Boolean(this.openCustody());
};

assetSchema.methods.isClosed = function isClosed() {
  return CLOSED_STATUSES.includes(this.status);
};

/** Whether `user` is the person currently holding this asset. */
assetSchema.methods.isHeldBy = function isHeldBy(user) {
  if (!user) return false;
  const open = this.openCustody();
  return Boolean(open && String(open.holder) === String(user._id));
};

/**
 * Why this asset may not be issued, or null when it may.
 *
 * The first branch is the whole point of the module. It is a refusal and not a
 * warning, because a warning is a thing people click through at half past
 * three on a Friday.
 */
assetSchema.methods.issueBlockedReason = function issueBlockedReason() {
  if (this.isClosed()) {
    return `This asset is ${this.status.replace(/-/g, ' ')} and cannot be issued`;
  }
  if (this.status === 'in-maintenance') {
    return 'This asset is in maintenance. Resolve the fault before issuing it again';
  }
  if (this.condition === 'unserviceable') {
    return 'This asset is marked unserviceable and cannot be issued';
  }
  const open = this.openCustody();
  if (open) {
    return `This asset is already out to ${open.holderName || 'another holder'}${
      open.issuedAt ? ` since ${open.issuedAt.toISOString().slice(0, 10)}` : ''
    }. Return it first.`;
  }
  return null;
};

/**
 * Open a custody row. Callers must have checked `issueBlockedReason` first;
 * this asserts it again rather than trusting them, because the invariant is
 * the feature.
 */
assetSchema.methods.issueTo = function issueTo(entry) {
  const blocked = this.issueBlockedReason();
  if (blocked) throw new Error(blocked);

  this.custody.push({
    holder: entry.holder,
    holderName: entry.holderName,
    location: entry.location,
    purpose: entry.purpose,
    issuedAt: new Date(),
    issuedBy: entry.issuedBy,
    dueBack: entry.dueBack,
    conditionOut: entry.conditionOut || this.condition,
    note: entry.note,
  });

  this.status = 'assigned';
  return this.custody[this.custody.length - 1];
};

/**
 * Close the open custody row.
 *
 * The returned condition, where given, becomes the asset's condition: the
 * register should describe the thing as it came back rather than as it went
 * out.
 */
assetSchema.methods.returnFrom = function returnFrom(entry) {
  const open = this.openCustody();
  if (!open) throw new Error('This asset is not currently out');

  open.returnedAt = new Date();
  open.returnedTo = entry.returnedTo;
  open.conditionIn = entry.conditionIn || open.conditionOut || this.condition;
  if (entry.note) {
    open.note = open.note ? `${open.note} | ${entry.note}` : entry.note;
  }

  if (entry.conditionIn) this.condition = entry.conditionIn;
  this.status = 'in-store';
  return open;
};

/**
 * Hand the asset straight from one holder to the next.
 *
 * Close and open happen here, in one call, on one document, saved once. Doing
 * it as a return request followed by an issue request is what produces the
 * gap in the chain when the second request never arrives.
 */
assetSchema.methods.transferTo = function transferTo(entry) {
  const open = this.openCustody();
  if (!open) throw new Error('This asset is not currently out, so there is nothing to transfer');
  if (String(open.holder) === String(entry.holder)) {
    throw new Error('This asset is already held by that person');
  }
  if (this.isClosed()) {
    throw new Error(`This asset is ${this.status.replace(/-/g, ' ')} and cannot be transferred`);
  }

  const handoverCondition = entry.conditionIn || open.conditionOut || this.condition;

  open.returnedAt = new Date();
  open.returnedTo = entry.transferredBy;
  open.conditionIn = handoverCondition;
  if (entry.note) {
    open.note = open.note ? `${open.note} | ${entry.note}` : entry.note;
  }
  this.condition = handoverCondition;

  this.custody.push({
    holder: entry.holder,
    holderName: entry.holderName,
    location: entry.location || open.location,
    purpose: entry.purpose || open.purpose,
    issuedAt: new Date(),
    issuedBy: entry.transferredBy,
    dueBack: entry.dueBack,
    conditionOut: handoverCondition,
    note: entry.note,
  });

  this.status = 'assigned';
  return this.custody[this.custody.length - 1];
};

/**
 * Whole calendar months between two dates, floored.
 *
 * Depreciation runs on months rather than on elapsed milliseconds because a
 * 365.25-day year is an approximation, and an approximation makes an asset
 * bought exactly four years ago worth ₹10,030.80 rather than its ₹10,000
 * salvage value. That is a wrong number in a report, and it is wrong in the
 * kind of small way nobody ever tracks down.
 */
function monthsBetween(from, to) {
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  // The month is not complete until the day-of-month comes round again.
  if (to.getDate() < from.getDate()) months -= 1;
  return months;
}

/**
 * Straight-line net book value at `asOf`.
 *
 * Computed, never stored. Floored at the salvage value, which is what
 * straight-line depreciation actually means and what a spreadsheet dragged
 * down one column too far gets wrong.
 */
assetSchema.methods.netBookValue = function netBookValue(asOf = new Date()) {
  const cost = Number(this.purchaseCost) || 0;
  const salvage = Math.min(Number(this.salvageValue) || 0, cost);
  const life = Number(this.usefulLifeYears) || 5;

  if (!this.purchaseDate) return cost;
  if (this.status === 'written-off') return 0;

  const elapsedMonths = monthsBetween(this.purchaseDate, asOf);
  const lifeMonths = life * 12;

  if (elapsedMonths <= 0) return cost;
  if (elapsedMonths >= lifeMonths) return salvage;

  const depreciable = cost - salvage;
  const value = cost - depreciable * (elapsedMonths / lifeMonths);
  return Math.round(Math.max(value, salvage) * 100) / 100;
};

/** Age since purchase in years, to one decimal. */
assetSchema.methods.ageYears = function ageYears(asOf = new Date()) {
  if (!this.purchaseDate) return null;
  const months = Math.max(monthsBetween(this.purchaseDate, asOf), 0);
  return Math.round((months / 12) * 10) / 10;
};

/** Days overdue on the open custody row; 0 when it is not late or not out. */
assetSchema.methods.daysOverdue = function daysOverdue(asOf = new Date()) {
  const open = this.openCustody();
  if (!open || !open.dueBack) return 0;
  const diff = asOf.getTime() - open.dueBack.getTime();
  if (diff <= 0) return 0;
  return Math.floor(diff / 86400000);
};

assetSchema.methods.openFaults = function openFaults() {
  return (this.maintenance || []).filter(
    (fault) => fault.status !== 'resolved' && fault.status !== 'unrepairable'
  );
};

/** How many times this asset has been in for repair. The retire-it signal. */
assetSchema.methods.repairCount = function repairCount() {
  return (this.maintenance || []).length;
};

assetSchema.methods.totalRepairCost = function totalRepairCost() {
  return (this.maintenance || []).reduce((sum, fault) => sum + (Number(fault.cost) || 0), 0);
};

assetSchema.methods.recordHistory = function recordHistory(entry) {
  this.history.push({
    action: entry.action,
    from: entry.from === undefined || entry.from === null ? undefined : String(entry.from),
    to: entry.to === undefined || entry.to === null ? undefined : String(entry.to),
    note: entry.note,
    by: entry.by,
    at: new Date(),
  });
};

/**
 * The read shape. Every derived number is computed here, so no caller has to
 * remember to and no two callers can disagree.
 */
assetSchema.methods.toRow = function toRow(asOf = new Date()) {
  const open = this.openCustody();
  return {
    _id: this._id,
    assetTag: this.assetTag,
    name: this.name,
    category: this.category,
    description: this.description,
    serialNumber: this.serialNumber,
    manufacturer: this.manufacturer,
    model: this.model,
    purchaseDate: this.purchaseDate,
    purchaseCost: this.purchaseCost,
    usefulLifeYears: this.usefulLifeYears,
    salvageValue: this.salvageValue,
    fundingSource: this.fundingSource,
    warrantyExpiresOn: this.warrantyExpiresOn,
    warrantyActive: this.warrantyExpiresOn
      ? this.warrantyExpiresOn.getTime() > asOf.getTime()
      : null,
    condition: this.condition,
    status: this.status,
    homeLocation: this.homeLocation,
    isOut: Boolean(open),
    currentHolder: open
      ? {
          holder: open.holder,
          holderName: open.holderName,
          location: open.location,
          purpose: open.purpose,
          issuedAt: open.issuedAt,
          dueBack: open.dueBack,
          conditionOut: open.conditionOut,
        }
      : null,
    daysOverdue: this.daysOverdue(asOf),
    netBookValue: this.netBookValue(asOf),
    ageYears: this.ageYears(asOf),
    openFaultCount: this.openFaults().length,
    repairCount: this.repairCount(),
    totalRepairCost: this.totalRepairCost(),
    disposal: this.disposal && this.disposal.method ? this.disposal : null,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

/** The full record, for the detail drawer. */
assetSchema.methods.toDetail = function toDetail(asOf = new Date()) {
  return {
    ...this.toRow(asOf),
    custody: this.custody,
    maintenance: this.maintenance,
    history: this.history,
  };
};

assetSchema.statics.CATEGORIES = CATEGORIES;
assetSchema.statics.CONDITIONS = CONDITIONS;
assetSchema.statics.STATUSES = STATUSES;
assetSchema.statics.ACTIVE_STATUSES = ACTIVE_STATUSES;
assetSchema.statics.CLOSED_STATUSES = CLOSED_STATUSES;
assetSchema.statics.FAULT_SEVERITIES = FAULT_SEVERITIES;
assetSchema.statics.FAULT_STATUSES = FAULT_STATUSES;
assetSchema.statics.DISPOSAL_METHODS = DISPOSAL_METHODS;
assetSchema.statics.DEFAULT_LIFE_YEARS = DEFAULT_LIFE_YEARS;

module.exports = mongoose.model('Asset', assetSchema);
