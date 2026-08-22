const mongoose = require('mongoose');

/**
 * A pledge, and the payments made against it.
 *
 * The notebook the school uses today records a promise of ₹50,000 over ten
 * months as ₹50,000. So the thermometer in reception shows money that has not
 * arrived, and shows it for ten months.
 *
 * Here `amount` is what was promised and `amountReceived` is the sum of the
 * payments, recomputed on every save. They are separate fields because they are
 * separate facts, and every surface that shows one shows the other.
 *
 * `payments[].reference` is unique per pledge, enforced by an index and checked
 * before the push. The gateway that times out and is retried, the double-tapped
 * button, the same UTR typed by two people in the office — all of them find the
 * existing payment and none of them moves a total. That is the ₹5,000
 * discrepancy removed at the point it is created rather than found in April.
 */

const SCHEDULES = ['one-off', 'monthly', 'quarterly', 'annual'];

const DONOR_TYPES = ['parent', 'alumnus', 'staff', 'corporate', 'trust', 'well-wisher'];

const STATUSES = ['pledged', 'partially-fulfilled', 'fulfilled', 'lapsed', 'cancelled'];

const INSTALMENT_STATUSES = ['due', 'part-paid', 'paid', 'waived'];

const METHODS = ['cash', 'cheque', 'bank-transfer', 'upi', 'card', 'in-kind'];

// How many instalments each schedule generates over a year.
const SCHEDULE_COUNTS = {
  'one-off': 1,
  monthly: 12,
  quarterly: 4,
  annual: 1,
};

const MAX_INSTALMENTS = 60;
const MAX_PAYMENTS = 200;

const instalmentSchema = new mongoose.Schema(
  {
    dueOn: { type: Date, required: [true, 'An instalment needs a date'] },
    amount: {
      type: Number,
      required: [true, 'An instalment needs an amount'],
      min: [0, 'An instalment cannot be negative'],
    },
    paidAmount: { type: Number, default: 0, min: [0, 'Paid amount cannot be negative'] },
    status: {
      type: String,
      enum: { values: INSTALMENT_STATUSES, message: 'Invalid instalment status' },
      default: 'due',
    },
    waivedReason: { type: String, trim: true, maxlength: [500, 'Too long'] },
    waivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    waivedAt: { type: Date },
  },
  { _id: true, timestamps: false }
);

const paymentSchema = new mongoose.Schema(
  {
    // The idempotency key. A UTR, a cheque number, a gateway transaction id —
    // whatever identifies this movement of money to somebody outside this app.
    reference: {
      type: String,
      required: [true, 'A payment reference is required'],
      trim: true,
      maxlength: [80, 'Reference cannot exceed 80 characters'],
    },
    amount: {
      type: Number,
      required: [true, 'A payment amount is required'],
      min: [0.01, 'A payment must be more than zero'],
    },
    method: {
      type: String,
      enum: { values: METHODS, message: 'Invalid payment method' },
      default: 'bank-transfer',
    },
    receivedOn: { type: Date, default: Date.now },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    instalmentIndex: { type: Number },
    // Issued by the server, never supplied.
    receiptSerial: { type: String, trim: true, maxlength: [60, 'Too long'] },
    note: { type: String, trim: true, maxlength: [500, 'Too long'] },
  },
  { _id: true, timestamps: false }
);

const historySchema = new mongoose.Schema(
  {
    action: { type: String, required: true, trim: true, maxlength: [40, 'Too long'] },
    from: { type: String, trim: true, maxlength: [80, 'Too long'] },
    to: { type: String, trim: true, maxlength: [80, 'Too long'] },
    note: { type: String, trim: true, maxlength: [500, 'Too long'] },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
  },
  { _id: true, timestamps: false }
);

const pledgeSchema = new mongoose.Schema(
  {
    campaign: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campaign',
      required: [true, 'A pledge must belong to a campaign'],
    },
    // Optional: an external donor has no account, but still gets a receipt.
    donor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    donorName: {
      type: String,
      required: [true, 'A donor name is required'],
      trim: true,
      maxlength: [120, 'Name cannot exceed 120 characters'],
    },
    donorEmail: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: [120, 'Email cannot exceed 120 characters'],
    },
    donorType: {
      type: String,
      enum: { values: DONOR_TYPES, message: 'Invalid donor type' },
      default: 'well-wisher',
    },
    // Hides the donor from every public surface. It does **not** remove them
    // from the record: the school still has to issue a receipt and an auditor
    // still has to be able to follow the money.
    isAnonymous: { type: Boolean, default: false },

    amount: {
      type: Number,
      required: [true, 'A pledge amount is required'],
      min: [1, 'A pledge must be more than zero'],
    },
    schedule: {
      type: String,
      enum: { values: SCHEDULES, message: 'Invalid schedule' },
      default: 'one-off',
    },
    startsOn: { type: Date, default: Date.now },

    instalments: {
      type: [instalmentSchema],
      default: [],
      validate: {
        validator: (v) => v.length <= MAX_INSTALMENTS,
        message: `A pledge cannot carry more than ${MAX_INSTALMENTS} instalments`,
      },
    },
    payments: {
      type: [paymentSchema],
      default: [],
      validate: {
        validator: (v) => v.length <= MAX_PAYMENTS,
        message: `A pledge cannot carry more than ${MAX_PAYMENTS} payments`,
      },
    },

    // Both derived in the pre-validate hook. Never accepted from a client.
    amountReceived: { type: Number, default: 0, min: 0 },
    amountOutstanding: { type: Number, default: 0, min: 0 },

    status: {
      type: String,
      enum: { values: STATUSES, message: 'Invalid status' },
      default: 'pledged',
    },
    cancellationReason: { type: String, trim: true, maxlength: [500, 'Too long'] },
    note: { type: String, trim: true, maxlength: [1000, 'Too long'] },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

pledgeSchema.index({ campaign: 1, status: 1 });
pledgeSchema.index({ donor: 1, createdAt: -1 });
pledgeSchema.index({ 'instalments.dueOn': 1, 'instalments.status': 1 });
// The idempotency guarantee. Sparse because a pledge with no payments has no
// reference to index, and partial so two pledges may legitimately carry the
// same external reference while one pledge may not.
pledgeSchema.index(
  { _id: 1, 'payments.reference': 1 },
  { unique: true, sparse: true, name: 'payment_reference_unique_per_pledge' }
);

pledgeSchema.pre('validate', function derive() {
  const received = (this.payments || []).reduce(
    (sum, payment) => sum + (Number(payment.amount) || 0),
    0
  );
  const waived = (this.instalments || [])
    .filter((instalment) => instalment.status === 'waived')
    .reduce((sum, instalment) => sum + (Number(instalment.amount) || 0), 0);

  this.amountReceived = Math.round(received * 100) / 100;
  // Waived money is not outstanding. Leaving it there produces a chase list
  // full of instalments somebody has already decided not to chase.
  this.amountOutstanding = Math.round(
    Math.max((Number(this.amount) || 0) - received - waived, 0) * 100
  ) / 100;

  if (!['cancelled', 'lapsed'].includes(this.status)) {
    if (this.amountOutstanding <= 0) {
      this.status = 'fulfilled';
    } else if (received > 0) {
      this.status = 'partially-fulfilled';
    } else {
      this.status = 'pledged';
    }
  }

  // The instalment schedule must add up to what was promised. A generator that
  // drops the rounding remainder is a pledge that can never be fulfilled.
  if ((this.instalments || []).length) {
    const total = this.instalments.reduce(
      (sum, instalment) => sum + (Number(instalment.amount) || 0),
      0
    );
    if (Math.abs(total - (Number(this.amount) || 0)) > 0.01) {
      this.invalidate(
        'instalments',
        `The instalments total ${total.toFixed(2)} but the pledge is ${Number(this.amount).toFixed(2)}`
      );
    }
  }
});

/**
 * Generate an instalment schedule.
 *
 * The last instalment absorbs the rounding remainder, so ten instalments of a
 * ₹50,000 pledge sum to ₹50,000 rather than ₹49,999.90 — and the pledge can
 * therefore actually be fulfilled.
 */
pledgeSchema.statics.buildSchedule = function buildSchedule(amount, schedule, startsOn) {
  const count = SCHEDULE_COUNTS[schedule] || 1;
  const start = startsOn instanceof Date ? new Date(startsOn.getTime()) : new Date(startsOn);
  if (Number.isNaN(start.getTime())) return [];

  const monthStep = { 'one-off': 0, monthly: 1, quarterly: 3, annual: 12 }[schedule] ?? 0;

  const per = Math.floor((Number(amount) * 100) / count) / 100;
  const instalments = [];

  for (let i = 0; i < count; i += 1) {
    const dueOn = new Date(start.getTime());
    if (monthStep) {
      const targetMonth = start.getUTCMonth() + monthStep * i;
      dueOn.setUTCMonth(targetMonth);
      // Clamp rather than roll over: 31 January plus one month is 28 February,
      // not 3 March, and a due date that quietly jumps a month is a chase list
      // that fires at the wrong time.
      if (dueOn.getUTCMonth() !== ((targetMonth % 12) + 12) % 12) {
        dueOn.setUTCDate(0);
      }
    }
    instalments.push({
      dueOn,
      amount: i === count - 1 ? Math.round((Number(amount) - per * (count - 1)) * 100) / 100 : per,
      paidAmount: 0,
      status: 'due',
    });
  }

  return instalments;
};

/** The payment carrying `reference`, or null. The idempotency lookup. */
pledgeSchema.methods.paymentByReference = function paymentByReference(reference) {
  const needle = String(reference || '').trim();
  if (!needle) return null;
  return (
    (this.payments || []).find(
      (payment) => String(payment.reference).trim() === needle
    ) || null
  );
};

/**
 * Apply `amount` across the instalments, earliest unpaid first.
 *
 * An overpayment cascades to the next instalment rather than being refused,
 * because in the real office the money has already arrived and refusing it
 * leaves the ledger disagreeing with the bank.
 */
pledgeSchema.methods.applyToInstalments = function applyToInstalments(amount, preferredIndex) {
  let remaining = Number(amount) || 0;
  const touched = [];

  const order = [];
  if (
    Number.isInteger(preferredIndex) &&
    preferredIndex >= 0 &&
    preferredIndex < this.instalments.length
  ) {
    order.push(preferredIndex);
  }
  this.instalments.forEach((instalment, index) => {
    if (!order.includes(index)) order.push(index);
  });

  for (const index of order) {
    if (remaining <= 0) break;
    const instalment = this.instalments[index];
    if (!instalment) continue;
    if (instalment.status === 'paid' || instalment.status === 'waived') continue;

    const owed = Math.max((Number(instalment.amount) || 0) - (Number(instalment.paidAmount) || 0), 0);
    if (owed <= 0) continue;

    const applied = Math.min(owed, remaining);
    instalment.paidAmount = Math.round(((Number(instalment.paidAmount) || 0) + applied) * 100) / 100;
    instalment.status = instalment.paidAmount >= (Number(instalment.amount) || 0) ? 'paid' : 'part-paid';
    remaining = Math.round((remaining - applied) * 100) / 100;
    touched.push(index);
  }

  return { touched, unallocated: Math.round(remaining * 100) / 100 };
};

/** Instalments past their date and not settled. The chase list, derived. */
pledgeSchema.methods.overdueInstalments = function overdueInstalments(now = new Date()) {
  return (this.instalments || [])
    .map((instalment, index) => ({ instalment, index }))
    .filter(
      ({ instalment }) =>
        instalment.status !== 'paid' &&
        instalment.status !== 'waived' &&
        instalment.dueOn &&
        instalment.dueOn < now
    );
};

pledgeSchema.methods.nextDue = function nextDue(now = new Date()) {
  const upcoming = (this.instalments || [])
    .filter(
      (instalment) =>
        instalment.status !== 'paid' && instalment.status !== 'waived' && instalment.dueOn >= now
    )
    .sort((a, b) => a.dueOn - b.dueOn);
  return upcoming[0] || null;
};

pledgeSchema.methods.isOwnedBy = function isOwnedBy(user) {
  if (!user || !this.donor) return false;
  return String(this.donor) === String(user._id);
};

pledgeSchema.methods.recordHistory = function recordHistory(entry) {
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
 * The read shape, with the anonymity applied.
 *
 * The hiding happens here, once. Doing it at each call site is how the donor's
 * name ends up on the one page nobody remembered to check.
 */
pledgeSchema.methods.toRowFor = function toRowFor(viewer, now = new Date()) {
  const isAdmin = Boolean(viewer && viewer.role === 'admin');
  const isOwner = this.isOwnedBy(viewer);
  const revealDonor = isAdmin || isOwner || !this.isAnonymous;

  const overdue = this.overdueInstalments(now);
  const next = this.nextDue(now);

  return {
    _id: this._id,
    campaign: this.campaign,
    donorName: revealDonor ? this.donorName : 'Anonymous',
    donorEmail: isAdmin || isOwner ? this.donorEmail : undefined,
    donor: isAdmin || isOwner ? this.donor : undefined,
    donorType: this.donorType,
    isAnonymous: this.isAnonymous,
    amount: this.amount,
    schedule: this.schedule,
    startsOn: this.startsOn,
    amountReceived: this.amountReceived,
    amountOutstanding: this.amountOutstanding,
    status: this.status,
    instalmentCount: (this.instalments || []).length,
    overdueCount: overdue.length,
    overdueAmount:
      Math.round(
        overdue.reduce(
          (sum, { instalment }) =>
            sum + Math.max((instalment.amount || 0) - (instalment.paidAmount || 0), 0),
          0
        ) * 100
      ) / 100,
    nextDueOn: next ? next.dueOn : null,
    nextDueAmount: next ? Math.max((next.amount || 0) - (next.paidAmount || 0), 0) : null,
    createdAt: this.createdAt,
  };
};

pledgeSchema.methods.toDetailFor = function toDetailFor(viewer, now = new Date()) {
  const isAdmin = Boolean(viewer && viewer.role === 'admin');
  const isOwner = this.isOwnedBy(viewer);

  return {
    ...this.toRowFor(viewer, now),
    instalments: (this.instalments || []).map((instalment, index) => ({
      index,
      _id: instalment._id,
      dueOn: instalment.dueOn,
      amount: instalment.amount,
      paidAmount: instalment.paidAmount,
      status: instalment.status,
      waivedReason: instalment.waivedReason,
      overdue:
        instalment.status !== 'paid' &&
        instalment.status !== 'waived' &&
        instalment.dueOn < now,
    })),
    // Payments carry receipt serials, so only the donor and an admin see them.
    payments:
      isAdmin || isOwner
        ? (this.payments || []).map((payment) => ({
            _id: payment._id,
            reference: payment.reference,
            amount: payment.amount,
            method: payment.method,
            receivedOn: payment.receivedOn,
            receiptSerial: payment.receiptSerial,
            note: payment.note,
          }))
        : [],
    history: isAdmin ? this.history : undefined,
    note: isAdmin || isOwner ? this.note : undefined,
  };
};

pledgeSchema.statics.SCHEDULES = SCHEDULES;
pledgeSchema.statics.DONOR_TYPES = DONOR_TYPES;
pledgeSchema.statics.STATUSES = STATUSES;
pledgeSchema.statics.INSTALMENT_STATUSES = INSTALMENT_STATUSES;
pledgeSchema.statics.METHODS = METHODS;
pledgeSchema.statics.SCHEDULE_COUNTS = SCHEDULE_COUNTS;
pledgeSchema.statics.MAX_INSTALMENTS = MAX_INSTALMENTS;

module.exports = mongoose.model('Pledge', pledgeSchema);
