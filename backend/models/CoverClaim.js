const mongoose = require('mongoose');

/**
 * Payment claims for cover a teacher has actually taught.
 *
 * `StaffAbsence` gets the hard part right — a period is assigned to a named
 * person, `commitmentsFor` stops the double booking, and `completeCover`
 * records that the lesson happened. Then the record stops. Four periods of
 * cover in a week are four timestamps on subdocuments buried inside documents
 * keyed by date, and "how many minutes did she cover in August?" is a question
 * nobody asks because nobody can.
 *
 * The property this file holds is that **the monthly free-cover allowance is
 * consumed in claim order across the whole month**, which makes every claim's
 * payable amount depend on every other claim that person made that month. That
 * is exactly the arithmetic that goes wrong when it is stored per row, so it is
 * not stored per row — it is recomputed by aggregation.
 *
 * The one exception is a locked batch, and it is absolute: a locked month never
 * changes, because a figure that has already gone to the bank is not allowed to
 * move underneath it.
 */

const CLAIM_STATUSES = ['submitted', 'approved', 'rejected', 'paid', 'cancelled'];

// A claim in one of these consumes allowance and holds its period. A rejected
// or cancelled claim releases both.
const COUNTING_STATUSES = ['submitted', 'approved', 'paid'];

// ...and in one of these the money is committed, so it appears in a batch total.
const COMMITTED_STATUSES = ['approved', 'paid'];

/**
 * Rate bands, in whole currency units per hour.
 *
 * These live here rather than in a request body for the obvious reason: a rate
 * in a payload is a rate somebody can choose.
 */
const RATE_BANDS = {
  standard: 400,
  specialist: 550,
  examination: 650,
  residential: 800,
};

const BANDS = Object.keys(RATE_BANDS);

// Minutes of cover each member of staff is expected to give per month before
// anything becomes payable.
const DEFAULT_MONTHLY_ALLOWANCE_MINUTES = 180;

// How long after the lesson a claim may still be raised. Without a window the
// batch has to stay open indefinitely against the possibility of an eight-month
// old claim.
const CLAIM_WINDOW_DAYS = 45;

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const BATCH_STATUSES = ['open', 'locked', 'paid'];

const monthKeyOf = (dateKey) => (DATE_PATTERN.test(dateKey || '') ? dateKey.slice(0, 7) : '');

const daysBetween = (fromKey, toDate) => {
  if (!DATE_PATTERN.test(fromKey || '')) return 0;

  const [year, month, day] = fromKey.split('-').map(Number);
  const from = new Date(year, month - 1, day);
  const to = new Date(toDate);
  to.setHours(0, 0, 0, 0);

  return Math.round((to - from) / (24 * 60 * 60 * 1000));
};

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

const coverClaimSchema = new mongoose.Schema(
  {
    absence: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'StaffAbsence',
      required: [true, 'A claim must name the absence it covers'],
    },
    // The subdocument id of the period inside that absence.
    periodId: {
      type: mongoose.Schema.Types.ObjectId,
      required: [true, 'A claim must name the period it covers'],
    },
    periodLabel: { type: String, trim: true, maxlength: [30, 'Too long'], default: '' },

    date: {
      type: String,
      required: [true, 'A claim needs the date the lesson was taught'],
      match: [DATE_PATTERN, 'Date must be in YYYY-MM-DD format'],
    },

    /**
     * Derived from the lesson date, never from when the claim was filed.
     *
     * A period taught in August and claimed in September belongs to August, and
     * the batch it lands in is August's.
     */
    monthKey: {
      type: String,
      required: true,
      match: [MONTH_PATTERN, 'Month must be in YYYY-MM format'],
    },

    claimant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A claim must name who taught the lesson'],
    },
    claimantName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },
    absentStaffName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },
    className: { type: String, trim: true, maxlength: [40, 'Too long'], default: '' },
    subject: { type: String, trim: true, maxlength: [60, 'Too long'], default: '' },

    startTime: { type: String, trim: true, default: '' },
    endTime: { type: String, trim: true, default: '' },

    /**
     * Frozen at claim time from the period's own minutes.
     *
     * Copied rather than looked up so that editing the timetable afterwards
     * does not restate a claim somebody has already approved.
     */
    minutes: {
      type: Number,
      required: true,
      min: [1, 'A claim must be for a real lesson'],
      max: [600, 'That is not one period'],
    },

    band: {
      type: String,
      enum: { values: BANDS, message: 'Invalid rate band' },
      default: 'standard',
    },
    // Copied from the band table at claim time, so a later rate change does not
    // silently restate an approved claim.
    ratePerHour: { type: Number, required: true, min: 0 },

    /**
     * Both recomputed across the month on every write, never trusted as stored
     * state. They are persisted only so a paid claim keeps the figures it was
     * paid on after its batch is locked.
     */
    allowanceMinutesApplied: { type: Number, default: 0, min: 0 },
    payableMinutes: { type: Number, default: 0, min: 0 },
    grossAmount: { type: Number, default: 0, min: 0 },

    status: {
      type: String,
      enum: { values: CLAIM_STATUSES, message: 'Invalid claim status' },
      default: 'submitted',
    },

    submittedAt: { type: Date, default: Date.now },

    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },

    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    cancelledAt: { type: Date, default: null },

    batch: { type: mongoose.Schema.Types.ObjectId, ref: 'CoverPaymentBatch', default: null },
    paidAt: { type: Date, default: null },
    paymentReference: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },

    /**
     * Derived from `status`. It backs the unique partial index, because a
     * partialFilterExpression cannot express a negation and a rejected claim
     * has to release its period so the right one can be raised.
     */
    isCounting: { type: Boolean, default: true },

    note: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true }
);

// One live claim per cover period.
coverClaimSchema.index(
  { absence: 1, periodId: 1 },
  { unique: true, partialFilterExpression: { isCounting: true } }
);

// The month query, which is the one that matters: everything one person claimed
// in one month, in the order they claimed it.
coverClaimSchema.index({ claimant: 1, monthKey: 1, isCounting: 1, submittedAt: 1 });
coverClaimSchema.index({ monthKey: 1, status: 1 });
coverClaimSchema.index({ status: 1, submittedAt: 1 });

coverClaimSchema.pre('validate', function deriveMonth() {
  if (!this.monthKey && this.date) this.monthKey = monthKeyOf(this.date);

  if (this.monthKey && this.date && monthKeyOf(this.date) !== this.monthKey) {
    this.invalidate('monthKey', 'The month must be the month the lesson was taught');
  }

  if (!this.ratePerHour && this.band) this.ratePerHour = RATE_BANDS[this.band];
});

coverClaimSchema.pre('save', function guardClaim() {
  this.isCounting = COUNTING_STATUSES.includes(this.status);

  if (this.approvedBy && this.claimant && this.approvedBy.equals(this.claimant)) {
    throw new Error('A cover claim cannot be approved by the person who made it');
  }

  if (this.rejectedBy && this.claimant && this.rejectedBy.equals(this.claimant)) {
    throw new Error('A cover claim cannot be rejected by the person who made it');
  }

  // Once a claim has been decided, the facts it was decided on are fixed.
  if (!this.isNew && this.status !== 'submitted') {
    const frozen = ['minutes', 'date', 'monthKey', 'claimant', 'absence', 'periodId', 'band', 'ratePerHour'];
    const edited = frozen.find((field) => this.isModified(field));

    if (edited) {
      throw new Error(`"${edited}" cannot be changed once the claim has been decided`);
    }
  }
});

coverClaimSchema.methods.log = function log(action, actor, note = '') {
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
 * Spread one month's allowance across one person's claims, in claim order.
 *
 * This is the whole arithmetic of the module. It is a static over the rows
 * rather than a field on each of them, because rejecting the claim from the 3rd
 * releases allowance that the claim from the 11th then absorbs — and a stored
 * per-row figure would stay frozen at whatever it was when the row was written.
 *
 * Claims in a locked batch are handed back untouched: their figures are what
 * was paid, and paid figures do not move.
 */
coverClaimSchema.statics.applyAllowance = function applyAllowance(
  claims,
  allowanceMinutes = DEFAULT_MONTHLY_ALLOWANCE_MINUTES
) {
  let remaining = allowanceMinutes;

  return claims
    .slice()
    .sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt))
    .map((claim) => {
      if (!COUNTING_STATUSES.includes(claim.status)) {
        return { claim, allowanceMinutesApplied: 0, payableMinutes: 0, grossAmount: 0 };
      }

      // A locked month is finished with. Its allowance is still consumed —
      // otherwise the next month's figures would be wrong — but its rows keep
      // the numbers they were paid on.
      if (claim.status === 'paid') {
        remaining = Math.max(0, remaining - claim.allowanceMinutesApplied);
        return {
          claim,
          allowanceMinutesApplied: claim.allowanceMinutesApplied,
          payableMinutes: claim.payableMinutes,
          grossAmount: claim.grossAmount,
          locked: true,
        };
      }

      const absorbed = Math.min(remaining, claim.minutes);
      remaining -= absorbed;

      const payable = claim.minutes - absorbed;
      // Rounded once, here, at the end. Rounding per claim and then summing is
      // how a batch total stops matching its own rows.
      const gross = Math.round((payable / 60) * claim.ratePerHour);

      return {
        claim,
        allowanceMinutesApplied: absorbed,
        payableMinutes: payable,
        grossAmount: gross,
      };
    });
};

/**
 * Recompute and persist one person's month. Called after every write that could
 * have changed it, which is every write.
 */
coverClaimSchema.statics.recomputeMonth = async function recomputeMonth(
  claimant,
  monthKey,
  allowanceMinutes = DEFAULT_MONTHLY_ALLOWANCE_MINUTES
) {
  const claims = await this.find({ claimant, monthKey }).sort({ submittedAt: 1 });
  const applied = this.applyAllowance(claims, allowanceMinutes);

  await Promise.all(
    applied.map(async (row) => {
      if (row.locked) return;

      const changed =
        row.claim.allowanceMinutesApplied !== row.allowanceMinutesApplied ||
        row.claim.payableMinutes !== row.payableMinutes ||
        row.claim.grossAmount !== row.grossAmount;

      if (!changed) return;

      // A direct update, not a save: this runs after the claim's own save and
      // must not re-enter the guards that saved it.
      await this.updateOne(
        { _id: row.claim._id },
        {
          $set: {
            allowanceMinutesApplied: row.allowanceMinutesApplied,
            payableMinutes: row.payableMinutes,
            grossAmount: row.grossAmount,
          },
        }
      );
    })
  );

  const counting = applied.filter((row) => COUNTING_STATUSES.includes(row.claim.status));

  return {
    monthKey,
    allowanceMinutes,
    claimCount: counting.length,
    totalMinutes: counting.reduce((sum, row) => sum + row.claim.minutes, 0),
    allowanceUsed: counting.reduce((sum, row) => sum + row.allowanceMinutesApplied, 0),
    payableMinutes: counting.reduce((sum, row) => sum + row.payableMinutes, 0),
    grossAmount: counting.reduce((sum, row) => sum + row.grossAmount, 0),
    allowanceLeft: Math.max(
      0,
      allowanceMinutes - counting.reduce((sum, row) => sum + row.allowanceMinutesApplied, 0)
    ),
  };
};

coverClaimSchema.methods.approve = function approve(actor) {
  if (this.status !== 'submitted') {
    throw new Error(`Only a submitted claim can be approved; this one is ${this.status}`);
  }
  if (actor._id.equals(this.claimant)) {
    throw new Error('A cover claim cannot be approved by the person who made it');
  }

  this.status = 'approved';
  this.approvedBy = actor._id;
  this.approvedAt = new Date();

  return this.log('approved', actor);
};

coverClaimSchema.methods.reject = function reject(actor, reason) {
  if (this.status !== 'submitted' && this.status !== 'approved') {
    throw new Error(`A ${this.status} claim cannot be rejected`);
  }
  if (actor._id.equals(this.claimant)) {
    throw new Error('A cover claim cannot be rejected by the person who made it');
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('A rejection reason is required');
  }

  this.status = 'rejected';
  this.rejectedBy = actor._id;
  this.rejectedAt = new Date();
  this.rejectionReason = String(reason).trim();

  return this.log('rejected', actor, this.rejectionReason);
};

coverClaimSchema.methods.cancel = function cancel(actor) {
  if (this.status !== 'submitted') {
    throw new Error(`Only a submitted claim can be cancelled; this one is ${this.status}`);
  }
  if (!actor._id.equals(this.claimant) && actor.role !== 'admin') {
    throw new Error('Only the claimant or an admin may cancel a claim');
  }

  this.status = 'cancelled';
  this.cancelledAt = new Date();

  return this.log('cancelled', actor);
};

coverClaimSchema.statics.CLAIM_STATUSES = CLAIM_STATUSES;
coverClaimSchema.statics.COUNTING_STATUSES = COUNTING_STATUSES;
coverClaimSchema.statics.COMMITTED_STATUSES = COMMITTED_STATUSES;
coverClaimSchema.statics.RATE_BANDS = RATE_BANDS;
coverClaimSchema.statics.BANDS = BANDS;
coverClaimSchema.statics.DEFAULT_MONTHLY_ALLOWANCE_MINUTES = DEFAULT_MONTHLY_ALLOWANCE_MINUTES;
coverClaimSchema.statics.CLAIM_WINDOW_DAYS = CLAIM_WINDOW_DAYS;
coverClaimSchema.statics.monthKeyOf = monthKeyOf;
coverClaimSchema.statics.daysBetween = daysBetween;

/**
 * One month of claims, sealed.
 *
 * Locking and paying are two separate acts on purpose. Locking freezes the
 * arithmetic so the figures can be checked; paying records the reference. A
 * batch may be locked and then found to be wrong, and unlocking is refused only
 * once the money has actually gone.
 */
const coverPaymentBatchSchema = new mongoose.Schema(
  {
    monthKey: {
      type: String,
      required: true,
      unique: true,
      match: [MONTH_PATTERN, 'Month must be in YYYY-MM format'],
    },
    status: {
      type: String,
      enum: { values: BATCH_STATUSES, message: 'Invalid batch status' },
      default: 'open',
    },

    claimCount: { type: Number, default: 0, min: 0 },
    totalMinutes: { type: Number, default: 0, min: 0 },
    payableMinutes: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, default: 0, min: 0 },
    staffCount: { type: Number, default: 0, min: 0 },

    lockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lockedAt: { type: Date, default: null },

    paidAt: { type: Date, default: null },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    paymentReference: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },

    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true }
);

coverPaymentBatchSchema.methods.log = coverClaimSchema.methods.log;

coverPaymentBatchSchema.methods.lock = function lock(actor, totals) {
  if (this.status !== 'open') {
    throw new Error(`Only an open batch can be locked; this one is ${this.status}`);
  }

  this.status = 'locked';
  this.lockedBy = actor._id;
  this.lockedAt = new Date();
  Object.assign(this, totals);

  return this.log('locked', actor, `${totals.claimCount} claim(s), ${totals.totalAmount}`);
};

coverPaymentBatchSchema.methods.unlock = function unlock(actor) {
  // Checked before the status, so a paid batch is refused with the reason that
  // matters rather than with "this one is paid".
  if (this.paidAt) {
    throw new Error('This batch has been paid and cannot be unlocked');
  }
  if (this.status !== 'locked') {
    throw new Error(`Only a locked batch can be unlocked; this one is ${this.status}`);
  }

  this.status = 'open';
  this.lockedBy = null;
  this.lockedAt = null;

  return this.log('unlocked', actor);
};

coverPaymentBatchSchema.methods.markPaid = function markPaid(actor, reference) {
  if (this.status !== 'locked') {
    throw new Error('A batch must be locked before it is paid');
  }
  if (!reference || !String(reference).trim()) {
    throw new Error('A payment reference is required');
  }

  this.status = 'paid';
  this.paidAt = new Date();
  this.paidBy = actor._id;
  this.paymentReference = String(reference).trim();

  return this.log('paid', actor, this.paymentReference);
};

coverPaymentBatchSchema.statics.BATCH_STATUSES = BATCH_STATUSES;

const CoverClaim = mongoose.model('CoverClaim', coverClaimSchema);
const CoverPaymentBatch = mongoose.model('CoverPaymentBatch', coverPaymentBatchSchema);

module.exports = CoverClaim;
module.exports.CoverClaim = CoverClaim;
module.exports.CoverPaymentBatch = CoverPaymentBatch;
