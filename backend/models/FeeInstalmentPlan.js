const mongoose = require('mongoose');

/**
 * An agreed schedule for paying one invoice in parts.
 *
 * `FeeInvoice` has one due date and one balance, so a family either pays or
 * they do not. The state in between — "we agreed four payments of twelve
 * thousand" — had nowhere to live, and was being recorded either as an overdue
 * invoice (which marks the family as a defaulter for doing what the school
 * asked) or as a waiver (which destroys the record that the money was owed).
 *
 * Two properties hold this file together:
 *
 *   1. the instalments sum to the principal exactly, and
 *   2. one invoice has at most one live plan.
 *
 * The first is arithmetic and lives in a validate hook. The second is a race
 * between two bursars on two telephones, so it lives in a unique partial index
 * rather than in a controller check.
 */

const PLAN_STATUSES = ['draft', 'active', 'completed', 'defaulted', 'cancelled'];

// A plan in one of these states occupies its invoice — the invoice may not be
// given a second schedule while one of them is outstanding.
const LIVE_PLAN_STATUSES = ['draft', 'active'];

// ...and in one of these it is still collecting money, so its arrears are worth
// computing and its instalments are worth chasing.
const COLLECTING_STATUSES = ['active'];

const INSTALMENT_STATUSES = ['due', 'part-paid', 'paid', 'waived'];

const FREQUENCIES = ['weekly', 'fortnightly', 'monthly', 'term'];

// How many days each frequency advances the schedule. `term` is the school's
// three-instalments-a-year case and is quarterly in everything but name.
const FREQUENCY_DAYS = {
  weekly: 7,
  fortnightly: 14,
  monthly: 30,
  term: 90,
};

const PAYMENT_METHODS = ['cash', 'cheque', 'bank-transfer', 'upi', 'card', 'online'];

const MIN_INSTALMENTS = 2;
const MAX_INSTALMENTS = 24;

// How long after an instalment's due date the family is still considered to be
// paying on time. Configurable per plan; this is what an unspecified plan gets.
const DEFAULT_GRACE_DAYS = 5;
const MAX_GRACE_DAYS = 30;

// How many instalments may be past due, past grace and unpaid before the plan
// reports itself at risk.
const DEFAULT_MISSED_THRESHOLD = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDay = (value) => {
  const date = value ? new Date(value) : new Date();
  date.setHours(0, 0, 0, 0);
  return date;
};

const addDays = (date, days) => new Date(startOfDay(date).getTime() + days * DAY_MS);

/**
 * Whole currency units only. Half a rupee in a schedule is a rounding argument
 * with a parent, and the school always loses it.
 */
const toWholeAmount = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric);
};

const instalmentSchema = new mongoose.Schema(
  {
    // 1-based, and stable. Waiving instalment 3 does not renumber 4 and 5 —
    // the family has been told which payment is which.
    sequence: {
      type: Number,
      required: true,
      min: [1, 'Instalment numbering starts at 1'],
    },
    dueOn: {
      type: Date,
      required: [true, 'Every instalment needs a due date'],
    },
    amount: {
      type: Number,
      required: [true, 'Every instalment needs an amount'],
      min: [0, 'An instalment cannot be negative'],
    },
    paidAmount: {
      type: Number,
      default: 0,
      min: [0, 'Paid amount cannot be negative'],
    },
    status: {
      type: String,
      enum: { values: INSTALMENT_STATUSES, message: 'Invalid instalment status' },
      default: 'due',
    },
    settledAt: { type: Date, default: null },
    waivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    waivedAt: { type: Date, default: null },
    waivedReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Waiver reason cannot exceed 300 characters'],
      default: '',
    },
  },
  { _id: false }
);

const planPaymentSchema = new mongoose.Schema(
  {
    // Whatever identifies this movement of money outside this application — a
    // UTR, a cheque number, a receipt serial. Unique within the plan, so a
    // double-submitted payment form does not credit the family twice.
    reference: {
      type: String,
      required: [true, 'A payment reference is required'],
      trim: true,
      maxlength: [80, 'Reference cannot exceed 80 characters'],
    },
    amount: {
      type: Number,
      required: [true, 'A payment amount is required'],
      min: [1, 'A payment must be more than zero'],
    },
    method: {
      type: String,
      enum: { values: PAYMENT_METHODS, message: 'Invalid payment method' },
      default: 'bank-transfer',
    },
    paidAt: { type: Date, default: Date.now },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    recordedByName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },
    // Which instalments this payment landed on, worked out by the allocator.
    // Kept for the receipt; never read back as the source of truth.
    allocation: {
      type: [
        {
          _id: false,
          sequence: { type: Number },
          amount: { type: Number },
        },
      ],
      default: [],
    },
    note: { type: String, trim: true, maxlength: [300, 'Too long'], default: '' },
  },
  { _id: false }
);

const historyEntrySchema = new mongoose.Schema(
  {
    action: { type: String, required: true, trim: true, maxlength: [40, 'Too long'] },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },
    at: { type: Date, default: Date.now },
    note: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },
  },
  { _id: false }
);

const feeInstalmentPlanSchema = new mongoose.Schema(
  {
    invoice: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FeeInvoice',
      required: [true, 'A plan must belong to an invoice'],
    },
    invoiceNumber: { type: String, trim: true, default: '' },

    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A plan must name the student it is for'],
    },
    studentName: { type: String, trim: true, maxlength: [120, 'Too long'], default: '' },
    academicYear: { type: String, trim: true, maxlength: [20, 'Too long'], default: '' },
    className: { type: String, trim: true, maxlength: [40, 'Too long'], default: '' },

    // The serial the family quotes back at the office. Issued by the server at
    // draft time from an atomically incremented counter.
    planNumber: {
      type: String,
      trim: true,
      maxlength: [40, 'Plan number cannot exceed 40 characters'],
    },

    /**
     * The invoice balance this schedule was written against, frozen at draft.
     *
     * It is deliberately a copy rather than a lookup. Between drafting a plan
     * and approving it, a payment may land on the invoice; approval re-reads
     * the live balance and refuses if it has moved, instead of silently
     * rewriting the schedule under the person approving it.
     */
    principal: {
      type: Number,
      required: [true, 'A plan needs a principal'],
      min: [1, 'A plan for nothing is not a plan'],
    },
    currency: { type: String, default: 'INR', trim: true, uppercase: true, maxlength: 3 },

    downPayment: {
      type: Number,
      default: 0,
      min: [0, 'A down payment cannot be negative'],
    },
    instalmentCount: {
      type: Number,
      required: true,
      min: [MIN_INSTALMENTS, `A plan needs at least ${MIN_INSTALMENTS} instalments`],
      max: [MAX_INSTALMENTS, `A plan cannot exceed ${MAX_INSTALMENTS} instalments`],
    },
    frequency: {
      type: String,
      enum: { values: FREQUENCIES, message: 'Invalid frequency' },
      default: 'monthly',
    },
    firstDueOn: {
      type: Date,
      required: [true, 'A plan needs a first due date'],
    },

    instalments: { type: [instalmentSchema], default: [] },
    payments: { type: [planPaymentSchema], default: [] },

    graceDays: {
      type: Number,
      default: DEFAULT_GRACE_DAYS,
      min: [0, 'Grace cannot be negative'],
      max: [MAX_GRACE_DAYS, `Grace cannot exceed ${MAX_GRACE_DAYS} days`],
    },
    missedThreshold: {
      type: Number,
      default: DEFAULT_MISSED_THRESHOLD,
      min: [1, 'At least one missed instalment must matter'],
      max: [MAX_INSTALMENTS, 'Threshold cannot exceed the instalment count'],
    },

    reason: {
      type: String,
      required: [true, 'Say why the family needs a schedule'],
      trim: true,
      minlength: [10, 'Please give a little more detail'],
      maxlength: [1000, 'Reason cannot exceed 1000 characters'],
    },

    status: {
      type: String,
      enum: { values: PLAN_STATUSES, message: 'Invalid plan status' },
      default: 'draft',
    },

    draftedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A plan must record who drafted it'],
    },
    draftedByName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },
    draftedAt: { type: Date, default: Date.now },

    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    approvalNote: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    defaultedAt: { type: Date, default: null },
    defaultedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    defaultReason: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    completedAt: { type: Date, default: null },

    /**
     * Derived from `status`. It exists because a unique partial index cannot
     * express a negation — MongoDB rejects `$ne` inside a
     * partialFilterExpression — so the negation becomes a stored boolean.
     */
    isLive: { type: Boolean, default: true },

    // The idempotency key. Minted by the client when the form opens, so
    // pressing "create" twice sends the same one.
    requestKey: {
      type: String,
      required: [true, 'A request key is required'],
      trim: true,
      maxlength: [80, 'Request key cannot exceed 80 characters'],
    },

    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true }
);

// One live plan per invoice. At the database, because the duplicate this stops
// is two members of staff agreeing two schedules within the same second.
feeInstalmentPlanSchema.index(
  { invoice: 1 },
  { unique: true, partialFilterExpression: { isLive: true } }
);

feeInstalmentPlanSchema.index({ requestKey: 1 }, { unique: true });

feeInstalmentPlanSchema.index(
  { planNumber: 1 },
  { unique: true, partialFilterExpression: { planNumber: { $type: 'string' } } }
);

feeInstalmentPlanSchema.index({ status: 1, 'instalments.dueOn': 1 });
feeInstalmentPlanSchema.index({ student: 1, createdAt: -1 });
feeInstalmentPlanSchema.index({ academicYear: 1, status: 1 });

/**
 * Build a schedule that sums to the principal exactly.
 *
 * The rounding remainder goes on the **first** instalment, not the last. Putting
 * it on the last is the intuitive choice and the wrong one: the final payment is
 * the one a family queries, and a schedule ending in ₹12,000.33 reads as a
 * mistake even when it is not.
 */
feeInstalmentPlanSchema.statics.buildSchedule = function buildSchedule({
  principal,
  downPayment = 0,
  instalmentCount,
  frequency = 'monthly',
  firstDueOn,
}) {
  const total = toWholeAmount(principal);
  const down = toWholeAmount(downPayment) || 0;
  const count = Number(instalmentCount);

  if (total === null || total < 1) throw new Error('A plan needs a positive principal');
  if (down < 0) throw new Error('A down payment cannot be negative');
  if (down >= total) throw new Error('A down payment cannot cover the whole balance');
  if (!Number.isInteger(count) || count < MIN_INSTALMENTS || count > MAX_INSTALMENTS) {
    throw new Error(`Instalments must be a whole number between ${MIN_INSTALMENTS} and ${MAX_INSTALMENTS}`);
  }
  if (!FREQUENCY_DAYS[frequency]) throw new Error('Invalid frequency');

  const scheduled = total - down;
  const base = Math.floor(scheduled / count);

  if (base < 1) {
    throw new Error('That many instalments would each be less than one rupee');
  }

  const remainder = scheduled - base * count;
  const step = FREQUENCY_DAYS[frequency];
  const start = startOfDay(firstDueOn);

  return Array.from({ length: count }, (unused, index) => ({
    sequence: index + 1,
    dueOn: addDays(start, index * step),
    amount: index === 0 ? base + remainder : base,
    paidAmount: 0,
    status: 'due',
  }));
};

/**
 * The arithmetic that must always close, checked before anything is written.
 */
feeInstalmentPlanSchema.pre('validate', function validateSchedule() {
  if (!Array.isArray(this.instalments) || this.instalments.length === 0) {
    this.invalidate('instalments', 'A plan needs a schedule');
    return;
  }

  if (this.instalments.length !== this.instalmentCount) {
    this.invalidate(
      'instalments',
      `The schedule has ${this.instalments.length} instalments but the plan says ${this.instalmentCount}`
    );
  }

  const scheduled = this.instalments.reduce((sum, row) => sum + (row.amount || 0), 0);
  const covered = scheduled + (this.downPayment || 0);

  if (covered !== this.principal) {
    this.invalidate(
      'instalments',
      `The schedule covers ${covered} but the principal is ${this.principal}`
    );
  }

  const sequences = this.instalments.map((row) => row.sequence);
  if (new Set(sequences).size !== sequences.length) {
    this.invalidate('instalments', 'Instalment numbers must be unique');
  }

  for (let i = 1; i < this.instalments.length; i += 1) {
    if (this.instalments[i].dueOn <= this.instalments[i - 1].dueOn) {
      this.invalidate('instalments', 'Instalment dates must increase');
      break;
    }
  }

  if (this.missedThreshold > this.instalmentCount) {
    this.invalidate('missedThreshold', 'The threshold cannot exceed the instalment count');
  }
});

/**
 * Keep `isLive` in step with `status`, and refuse the edits that would make an
 * already-approved plan a different plan.
 */
feeInstalmentPlanSchema.pre('save', function guardPlan() {
  this.isLive = LIVE_PLAN_STATUSES.includes(this.status);

  if (this.approvedBy && this.draftedBy && this.approvedBy.equals(this.draftedBy)) {
    throw new Error('A plan cannot be approved by the person who drafted it');
  }

  if (this.rejectedBy && this.draftedBy && this.rejectedBy.equals(this.draftedBy)) {
    throw new Error('A plan cannot be rejected by the person who drafted it');
  }

  // Once a family has agreed a schedule, the schedule is what they agreed to.
  // Correcting it means cancelling the plan and drafting another, so that the
  // one they agreed to still exists.
  if (!this.isNew && this.status !== 'draft') {
    const frozen = ['principal', 'invoice', 'student', 'downPayment', 'instalmentCount'];
    const edited = frozen.find((field) => this.isModified(field));

    if (edited) {
      throw new Error(`"${edited}" cannot be changed once the plan has left draft`);
    }
  }
});

feeInstalmentPlanSchema.methods.log = function log(action, actor, note = '') {
  this.history.push({
    action,
    by: actor ? actor._id : undefined,
    byName: (actor && actor.name) || '',
    at: new Date(),
    note,
  });

  return this;
};

/**
 * Spread every recorded payment over the schedule, earliest instalment first.
 *
 * Allocation is recomputed from the payment rows rather than stored as a
 * pointer, because a pointer is the thing that ends up disagreeing with the
 * rows it is supposed to summarise. A waived instalment absorbs nothing.
 */
feeInstalmentPlanSchema.methods.reallocate = function reallocate() {
  this.instalments.forEach((row) => {
    if (row.status !== 'waived') {
      row.paidAmount = 0;
      row.status = 'due';
      row.settledAt = null;
    }
  });

  const ordered = [...this.instalments]
    .filter((row) => row.status !== 'waived')
    .sort((a, b) => a.sequence - b.sequence);

  this.payments
    .slice()
    .sort((a, b) => new Date(a.paidAt) - new Date(b.paidAt))
    .forEach((payment) => {
      let left = payment.amount;
      const allocation = [];

      for (const row of ordered) {
        if (left <= 0) break;

        const owing = row.amount - row.paidAmount;
        if (owing <= 0) continue;

        const applied = Math.min(owing, left);
        row.paidAmount += applied;
        left -= applied;
        allocation.push({ sequence: row.sequence, amount: applied });
      }

      payment.allocation = allocation;
    });

  ordered.forEach((row) => {
    if (row.paidAmount >= row.amount) {
      row.status = 'paid';
      row.settledAt = row.settledAt || new Date();
    } else if (row.paidAmount > 0) {
      row.status = 'part-paid';
    }
  });

  return this;
};

/**
 * Everything a screen needs to say about where this plan stands, worked out
 * fresh. None of it is stored: an arrears field is a field that drifts.
 */
feeInstalmentPlanSchema.methods.position = function position(today = new Date()) {
  const cutoff = startOfDay(today);
  const grace = this.graceDays || 0;

  let scheduled = 0;
  let collected = 0;
  let waived = 0;
  let dueToDate = 0;
  let paidTowardsDue = 0;
  let missedCount = 0;
  let nextDue = null;

  this.instalments
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .forEach((row) => {
      if (row.status === 'waived') {
        waived += row.amount;
        return;
      }

      scheduled += row.amount;
      collected += row.paidAmount;

      const graceEnd = addDays(row.dueOn, grace);

      if (row.dueOn <= cutoff) {
        dueToDate += row.amount;
        paidTowardsDue += Math.min(row.paidAmount, row.amount);
      }

      if (graceEnd < cutoff && row.paidAmount < row.amount) {
        missedCount += 1;
      }

      if (!nextDue && row.status !== 'paid') {
        nextDue = row;
      }
    });

  const arrears = Math.max(0, dueToDate - paidTowardsDue);
  const outstanding = Math.max(0, scheduled - collected);

  return {
    scheduled,
    collected,
    waived,
    outstanding,
    arrears,
    missedCount,
    atRisk: this.status === 'active' && missedCount >= this.missedThreshold,
    settled: outstanding === 0,
    nextDue: nextDue
      ? {
          sequence: nextDue.sequence,
          dueOn: nextDue.dueOn,
          amount: nextDue.amount,
          paidAmount: nextDue.paidAmount,
          daysAway: Math.round((startOfDay(nextDue.dueOn) - cutoff) / DAY_MS),
        }
      : null,
    percentPaid: scheduled ? Math.round((collected / scheduled) * 100) : 100,
  };
};

feeInstalmentPlanSchema.methods.approve = function approve(actor, note = '') {
  if (this.status !== 'draft') {
    throw new Error(`Only a draft plan can be approved; this one is ${this.status}`);
  }
  if (actor._id.equals(this.draftedBy)) {
    throw new Error('A plan cannot be approved by the person who drafted it');
  }

  this.status = 'active';
  this.approvedBy = actor._id;
  this.approvedAt = new Date();
  this.approvalNote = note || '';

  return this.log('approved', actor, note);
};

feeInstalmentPlanSchema.methods.reject = function reject(actor, reason) {
  if (this.status !== 'draft') {
    throw new Error(`Only a draft plan can be rejected; this one is ${this.status}`);
  }
  if (actor._id.equals(this.draftedBy)) {
    throw new Error('A plan cannot be rejected by the person who drafted it');
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('A rejection reason is required');
  }

  this.status = 'cancelled';
  this.rejectedBy = actor._id;
  this.rejectedAt = new Date();
  this.rejectionReason = String(reason).trim();

  return this.log('rejected', actor, this.rejectionReason);
};

feeInstalmentPlanSchema.methods.cancel = function cancel(actor, reason) {
  if (!LIVE_PLAN_STATUSES.includes(this.status)) {
    throw new Error(`A ${this.status} plan cannot be cancelled`);
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('A cancellation reason is required');
  }

  this.status = 'cancelled';
  this.cancelledBy = actor._id;
  this.cancelledAt = new Date();
  this.cancelReason = String(reason).trim();

  return this.log('cancelled', actor, this.cancelReason);
};

feeInstalmentPlanSchema.methods.markDefaulted = function markDefaulted(actor, reason) {
  if (this.status !== 'active') {
    throw new Error(`Only an active plan can be defaulted; this one is ${this.status}`);
  }

  const { missedCount } = this.position();
  if (missedCount < this.missedThreshold) {
    throw new Error(
      `This plan has ${missedCount} missed instalment(s); the threshold is ${this.missedThreshold}`
    );
  }

  this.status = 'defaulted';
  this.defaultedBy = actor._id;
  this.defaultedAt = new Date();
  this.defaultReason = (reason && String(reason).trim()) || `${missedCount} instalments missed`;

  return this.log('defaulted', actor, this.defaultReason);
};

/**
 * Waiving one instalment does not reduce the principal.
 *
 * The amount moves onto the instalments that are still outstanding, spread
 * evenly with the remainder on the earliest of them. If there are none left to
 * carry it, the plan ends short — and the history says which of the two
 * happened, because they are very different facts.
 */
feeInstalmentPlanSchema.methods.waiveInstalment = function waiveInstalment(sequence, actor, reason) {
  if (this.status !== 'active') {
    throw new Error(`Instalments can only be waived on an active plan; this one is ${this.status}`);
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('A waiver reason is required');
  }

  const target = this.instalments.find((row) => row.sequence === Number(sequence));
  if (!target) throw new Error(`There is no instalment ${sequence} on this plan`);
  if (target.status === 'waived') throw new Error('That instalment is already waived');
  if (target.status === 'paid') throw new Error('A paid instalment cannot be waived');

  const carried = target.amount - target.paidAmount;

  target.status = 'waived';
  target.waivedBy = actor._id;
  target.waivedAt = new Date();
  target.waivedReason = String(reason).trim();

  const remaining = this.instalments.filter(
    (row) => row.status !== 'waived' && row.sequence > target.sequence
  );

  if (remaining.length > 0 && carried > 0) {
    const each = Math.floor(carried / remaining.length);
    const remainder = carried - each * remaining.length;

    remaining.forEach((row, index) => {
      row.amount += each + (index === 0 ? remainder : 0);
    });

    this.log(
      'instalment-waived',
      actor,
      `Instalment ${sequence} waived; ${carried} carried onto ${remaining.length} later instalment(s)`
    );
  } else {
    // Nothing left to carry it onto, so the plan genuinely collects less than
    // the principal. Say so rather than letting the sums quietly stop closing.
    this.principal -= carried;
    this.log(
      'instalment-waived',
      actor,
      `Instalment ${sequence} waived; ${carried} written off, principal reduced`
    );
  }

  this.reallocate();

  return this;
};

feeInstalmentPlanSchema.methods.refreshCompletion = function refreshCompletion() {
  if (this.status !== 'active') return this;

  const { settled } = this.position();

  if (settled) {
    this.status = 'completed';
    this.completedAt = new Date();
    this.history.push({ action: 'completed', at: new Date(), note: 'Final instalment settled' });
  }

  return this;
};

feeInstalmentPlanSchema.statics.PLAN_STATUSES = PLAN_STATUSES;
feeInstalmentPlanSchema.statics.LIVE_PLAN_STATUSES = LIVE_PLAN_STATUSES;
feeInstalmentPlanSchema.statics.COLLECTING_STATUSES = COLLECTING_STATUSES;
feeInstalmentPlanSchema.statics.INSTALMENT_STATUSES = INSTALMENT_STATUSES;
feeInstalmentPlanSchema.statics.FREQUENCIES = FREQUENCIES;
feeInstalmentPlanSchema.statics.FREQUENCY_DAYS = FREQUENCY_DAYS;
feeInstalmentPlanSchema.statics.PAYMENT_METHODS = PAYMENT_METHODS;
feeInstalmentPlanSchema.statics.MIN_INSTALMENTS = MIN_INSTALMENTS;
feeInstalmentPlanSchema.statics.MAX_INSTALMENTS = MAX_INSTALMENTS;
feeInstalmentPlanSchema.statics.DEFAULT_GRACE_DAYS = DEFAULT_GRACE_DAYS;
feeInstalmentPlanSchema.statics.DEFAULT_MISSED_THRESHOLD = DEFAULT_MISSED_THRESHOLD;
feeInstalmentPlanSchema.statics.toWholeAmount = toWholeAmount;
feeInstalmentPlanSchema.statics.startOfDay = startOfDay;

/**
 * Serial issuer for plan numbers.
 *
 * A plan number is quoted back over the telephone, so it wants to be short and
 * sequential rather than derived from an object id. Bumped atomically so two
 * drafts racing get two numbers instead of the same one twice.
 */
const instalmentPlanCounterSchema = new mongoose.Schema(
  {
    _id: { type: String },
    seq: { type: Number, default: 0 },
  },
  { _id: false }
);

instalmentPlanCounterSchema.statics.next = async function next(academicYear) {
  const scope = (academicYear || '').replace(/\s+/g, '') || 'GENERAL';

  const counter = await this.findOneAndUpdate(
    { _id: `IP-${scope}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  return `IP/${scope}/${String(counter.seq).padStart(4, '0')}`;
};

const FeeInstalmentPlan = mongoose.model('FeeInstalmentPlan', feeInstalmentPlanSchema);
const InstalmentPlanCounter = mongoose.model(
  'InstalmentPlanCounter',
  instalmentPlanCounterSchema
);

module.exports = FeeInstalmentPlan;
module.exports.FeeInstalmentPlan = FeeInstalmentPlan;
module.exports.InstalmentPlanCounter = InstalmentPlanCounter;
