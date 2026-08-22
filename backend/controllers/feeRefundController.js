// backend/controllers/feeRefundController.js
const mongoose = require('mongoose');
const FeeInvoice = require('../models/FeeInvoice');
const FeeRefund = require('../models/FeeRefund');
const { CreditNoteCounter } = require('../models/FeeRefund');
const User = require('../models/User');

/**
 * Refunds against fee invoices.
 *
 * The single property this file exists to preserve is that the sum of every
 * refund that has not been rejected or cancelled never exceeds what the parent
 * actually paid. That ceiling is recomputed from the refund rows on every
 * request and re-checked at settlement, because the interesting gap is between
 * a member of staff opening the screen and pressing the button on it.
 *
 * There is no replica set behind this deployment, so there are no multi-document
 * transactions available. The two writes that must not half-happen — claiming
 * the refund and moving the money on the invoice — are done as guarded atomic
 * updates with an explicit compensating write if the second one fails.
 */

const handleError = (res, err, message = 'Server error') => {
  console.error('[fee-refunds]', err);
  return res.status(500).json({ success: false, message, error: err.message });
};

const getPagination = (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
};

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const isBursar = (user) => user && (user.role === 'admin' || user.role === 'staff');

// A refund is only ever quoted in whole currency units. Half a rupee in a
// ledger is a rounding argument waiting to happen.
const toAmount = (value) => {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return null;
  return Math.round(numeric);
};

const publicRefund = (refund) => ({
  _id: refund._id,
  invoice: refund.invoice,
  invoiceNumber: refund.invoiceNumber,
  student: refund.student,
  studentName: refund.studentName,
  academicYear: refund.academicYear,
  className: refund.className,
  amount: refund.amount,
  currency: refund.currency,
  reason: refund.reason,
  narrative: refund.narrative,
  method: refund.method,
  status: refund.status,
  requestedAt: refund.requestedAt,
  requestedBy: refund.requestedBy,
  approvedAt: refund.approvedAt,
  approvedBy: refund.approvedBy,
  approvalNote: refund.approvalNote,
  rejectedAt: refund.rejectedAt,
  rejectionReason: refund.rejectionReason,
  settledAt: refund.settledAt,
  settlementReference: refund.settlementReference,
  creditNoteNumber: refund.creditNoteNumber,
  history: refund.history,
  createdAt: refund.createdAt,
});

// ---- REFERENCE DATA ----

/**
 * GET /api/fees/refunds/meta
 * The enumerations, so the form does not hard-code a second copy of them that
 * drifts from the model's.
 */
exports.getRefundMeta = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        statuses: FeeRefund.STATUSES,
        reasons: FeeRefund.REASONS,
        methods: FeeRefund.METHODS,
        encumberingStatuses: FeeRefund.ENCUMBERING_STATUSES,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load refund reference data');
  }
};

// ---- THE CEILING ----

/**
 * GET /api/fees/invoices/:id/refundable
 *
 * Deliberately its own endpoint rather than a field on the invoice. The figure
 * changes when any refund anywhere in the queue changes state, so it has to be
 * asked for at the moment it is needed rather than cached on the invoice.
 */
exports.getRefundable = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid invoice id.' });
    }

    const invoice = await FeeInvoice.findById(id);
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found.' });
    }

    const ceiling = await FeeRefund.refundableFor(invoice);

    const holds = await FeeRefund.find({ invoice: invoice._id, isEncumbering: true })
      .select('amount status requestedAt creditNoteNumber')
      .sort({ requestedAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: {
        invoice: {
          _id: invoice._id,
          invoiceNumber: invoice.invoiceNumber,
          studentName: invoice.studentName,
          totalAmount: invoice.totalAmount,
          amountPaid: invoice.amountPaid,
          status: invoice.status,
          currency: invoice.currency,
        },
        ...ceiling,
        // Shown next to the ceiling so a bursar can see *why* it is smaller
        // than the amount paid, rather than assuming the figure is wrong.
        holds,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not compute the refundable amount');
  }
};

// ---- REQUESTING ----

/**
 * POST /api/fees/refunds
 *
 * Idempotent on `requestKey`. A resubmitted request returns the refund that
 * already exists rather than creating a second one, and says so, so the UI can
 * tell the difference between "saved" and "saved again".
 */
exports.requestRefund = async (req, res) => {
  try {
    const { invoiceId, amount, reason, narrative, method, requestKey } = req.body;

    if (!invoiceId || !isValidId(invoiceId)) {
      return res.status(400).json({ success: false, message: 'A valid invoice id is required.' });
    }
    if (!requestKey || !String(requestKey).trim()) {
      return res.status(400).json({
        success: false,
        message: 'A request key is required so a retried submission cannot refund twice.',
      });
    }
    if (!FeeRefund.REASONS.includes(reason)) {
      return res.status(400).json({
        success: false,
        message: `Reason must be one of: ${FeeRefund.REASONS.join(', ')}`,
      });
    }
    if (!FeeRefund.METHODS.includes(method)) {
      return res.status(400).json({
        success: false,
        message: `Method must be one of: ${FeeRefund.METHODS.join(', ')}`,
      });
    }
    if (reason === 'other' && !String(narrative || '').trim()) {
      return res.status(400).json({
        success: false,
        message: 'Describe the reason when choosing "other".',
      });
    }

    const key = String(requestKey).trim();

    // The idempotent read. Doing it before the work keeps the common retry
    // cheap; the unique index below is what actually makes it safe.
    const existing = await FeeRefund.findOne({ requestKey: key });
    if (existing) {
      return res.status(200).json({
        success: true,
        alreadyRequested: true,
        message: 'This refund was already raised.',
        data: publicRefund(existing),
      });
    }

    const value = toAmount(amount);
    if (value === null || value <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Refund amount must be a positive whole number.',
      });
    }

    const invoice = await FeeInvoice.findById(invoiceId);
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found.' });
    }

    if (!invoice.amountPaid) {
      return res.status(409).json({
        success: false,
        message: 'Nothing has been paid against this invoice, so nothing can be refunded.',
      });
    }

    const ceiling = await FeeRefund.refundableFor(invoice);

    if (value > ceiling.refundable) {
      return res.status(409).json({
        success: false,
        message:
          `A refund of ${value} exceeds the refundable balance of ${ceiling.refundable}. ` +
          `${ceiling.amountPaid} was paid and ${ceiling.alreadyRefunded} is already refunded or awaiting approval.`,
        data: ceiling,
      });
    }

    const refund = new FeeRefund({
      invoice: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      student: invoice.student,
      studentName: invoice.studentName,
      academicYear: invoice.academicYear,
      className: invoice.className,
      amount: value,
      currency: invoice.currency || 'INR',
      reason,
      narrative: String(narrative || '').trim(),
      method,
      requestKey: key,
      requestedBy: req.user._id,
      requestedAt: new Date(),
    });

    refund.log('requested', req.user, `${value} ${refund.currency}`);

    try {
      await refund.save();
    } catch (err) {
      // The unique index on `requestKey` is the real idempotency guard — two
      // clicks a few milliseconds apart both get past the read above.
      if (err.code === 11000) {
        const raced = await FeeRefund.findOne({ requestKey: key });
        return res.status(200).json({
          success: true,
          alreadyRequested: true,
          message: 'This refund was already raised.',
          data: raced ? publicRefund(raced) : null,
        });
      }
      throw err;
    }

    return res.status(201).json({
      success: true,
      message: 'Refund raised and awaiting approval.',
      data: publicRefund(refund),
    });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: err.message });
    }
    return handleError(res, err, 'Could not raise the refund');
  }
};

// ---- READING ----

/**
 * GET /api/fees/refunds
 * The staff queue. Filterable by status, student and academic year.
 */
exports.getRefunds = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const { status, student, academicYear, invoice, q } = req.query;

    const filter = {};

    if (status && FeeRefund.STATUSES.includes(status)) filter.status = status;
    if (student && isValidId(student)) filter.student = student;
    if (invoice && isValidId(invoice)) filter.invoice = invoice;
    if (academicYear) filter.academicYear = academicYear;
    if (q) {
      const pattern = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ studentName: pattern }, { invoiceNumber: pattern }, { creditNoteNumber: pattern }];
    }

    const [refunds, total] = await Promise.all([
      FeeRefund.find(filter)
        .populate('requestedBy', 'name email role')
        .populate('approvedBy', 'name email role')
        .populate('settledBy', 'name email role')
        .sort({ requestedAt: -1 })
        .skip(skip)
        .limit(limit),
      FeeRefund.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      count: refunds.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      data: refunds,
    });
  } catch (err) {
    return handleError(res, err, 'Could not load refunds');
  }
};

/**
 * GET /api/fees/refunds/mine
 * Scoped by the token, never by a query parameter.
 */
exports.getMyRefunds = async (req, res) => {
  try {
    const refunds = await FeeRefund.find({ student: req.user._id })
      .sort({ requestedAt: -1 })
      .lean();

    // A student is shown the state and the credit note, not who inside the
    // office approved it.
    const visible = refunds.map((refund) => ({
      _id: refund._id,
      invoiceNumber: refund.invoiceNumber,
      amount: refund.amount,
      currency: refund.currency,
      reason: refund.reason,
      method: refund.method,
      status: refund.status,
      requestedAt: refund.requestedAt,
      settledAt: refund.settledAt,
      creditNoteNumber: refund.creditNoteNumber,
      rejectionReason: refund.rejectionReason,
    }));

    return res.status(200).json({ success: true, count: visible.length, data: visible });
  } catch (err) {
    return handleError(res, err, 'Could not load your refunds');
  }
};

/**
 * GET /api/fees/refunds/:id
 * Ownership is decided here rather than in the router, so a student can open
 * their own refund while staff can open anyone's.
 */
exports.getRefund = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid refund id.' });
    }

    const refund = await FeeRefund.findById(id)
      .populate('requestedBy', 'name email role')
      .populate('approvedBy', 'name email role')
      .populate('settledBy', 'name email role');

    if (!refund) {
      return res.status(404).json({ success: false, message: 'Refund not found.' });
    }

    const owns = refund.student && refund.student.equals(req.user._id);
    if (!owns && !isBursar(req.user)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    return res.status(200).json({ success: true, data: refund });
  } catch (err) {
    return handleError(res, err, 'Could not load the refund');
  }
};

// ---- DECIDING ----

/**
 * PATCH /api/fees/refunds/:id/approve
 *
 * The two-person rule lives here and again in the model. A single-person office
 * can still work — an admin may approve a request raised by staff — but the
 * same human cannot do both halves.
 */
exports.approveRefund = async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid refund id.' });
    }

    const refund = await FeeRefund.findById(id);
    if (!refund) {
      return res.status(404).json({ success: false, message: 'Refund not found.' });
    }

    try {
      refund.approve(req.user, String(note || '').trim());
    } catch (err) {
      return res.status(409).json({ success: false, message: err.message });
    }

    await refund.save();

    return res.status(200).json({
      success: true,
      message: 'Refund approved. It can now be settled.',
      data: publicRefund(refund),
    });
  } catch (err) {
    return handleError(res, err, 'Could not approve the refund');
  }
};

/**
 * PATCH /api/fees/refunds/:id/reject
 * Rejecting releases the headroom the request was holding.
 */
exports.rejectRefund = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid refund id.' });
    }

    const refund = await FeeRefund.findById(id);
    if (!refund) {
      return res.status(404).json({ success: false, message: 'Refund not found.' });
    }

    try {
      refund.reject(req.user, reason);
    } catch (err) {
      return res.status(409).json({ success: false, message: err.message });
    }

    await refund.save();

    return res.status(200).json({
      success: true,
      message: 'Refund rejected. The refundable balance has been released.',
      data: publicRefund(refund),
    });
  } catch (err) {
    return handleError(res, err, 'Could not reject the refund');
  }
};

/**
 * PATCH /api/fees/refunds/:id/cancel
 * The requester withdrawing their own request before anyone has acted on it.
 */
exports.cancelRefund = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid refund id.' });
    }

    const refund = await FeeRefund.findById(id);
    if (!refund) {
      return res.status(404).json({ success: false, message: 'Refund not found.' });
    }

    try {
      refund.cancel(req.user);
    } catch (err) {
      return res.status(409).json({ success: false, message: err.message });
    }

    await refund.save();

    return res.status(200).json({
      success: true,
      message: 'Refund cancelled.',
      data: publicRefund(refund),
    });
  } catch (err) {
    return handleError(res, err, 'Could not cancel the refund');
  }
};

// ---- SETTLING ----

/**
 * PATCH /api/fees/refunds/:id/settle
 *
 * The only write in the module that moves money. Three things happen and none
 * of them may happen twice:
 *
 *   1. the refund is claimed, with a guarded update that only matches while it
 *      is still `approved`, so a double-click loses the second time;
 *   2. the invoice's `amountPaid` is decremented, guarded on it still being
 *      large enough, so a payment reversal landing at the same moment cannot
 *      push it negative;
 *   3. a credit-note serial is issued.
 *
 * If (2) fails the claim in (1) is put back, because a settled refund that
 * never moved the invoice is the worst of the possible outcomes.
 */
exports.settleRefund = async (req, res) => {
  try {
    const { id } = req.params;
    const { settlementReference } = req.body;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid refund id.' });
    }

    const refund = await FeeRefund.findById(id);
    if (!refund) {
      return res.status(404).json({ success: false, message: 'Refund not found.' });
    }
    if (refund.status !== 'approved') {
      return res.status(409).json({
        success: false,
        message: `Only an approved refund can be settled; this one is ${refund.status}.`,
      });
    }

    const creditNoteNumber = await CreditNoteCounter.next(refund.academicYear);

    // (1) Claim. `status: 'approved'` in the filter is the guard: a second
    // request arriving concurrently matches nothing and gets the 409 below.
    const claimed = await FeeRefund.findOneAndUpdate(
      { _id: refund._id, status: 'approved' },
      {
        $set: {
          status: 'settled',
          isEncumbering: true,
          settledBy: req.user._id,
          settledAt: new Date(),
          settlementReference: String(settlementReference || '').trim(),
          creditNoteNumber,
        },
        $push: {
          history: {
            action: 'settled',
            by: req.user._id,
            byName: req.user.name || '',
            at: new Date(),
            note: creditNoteNumber,
          },
        },
      },
      { new: true }
    );

    if (!claimed) {
      return res.status(409).json({
        success: false,
        message: 'This refund was settled by someone else a moment ago.',
      });
    }

    // (2) Move the money. The `$gte` guard is what stops the invoice going
    // negative if a payment is reversed elsewhere at the same instant.
    const invoice = await FeeInvoice.findOneAndUpdate(
      { _id: claimed.invoice, amountPaid: { $gte: claimed.amount } },
      { $inc: { amountPaid: -claimed.amount } },
      { new: true }
    );

    if (!invoice) {
      // Compensate: put the refund back where it was.
      await FeeRefund.updateOne(
        { _id: claimed._id },
        {
          $set: {
            status: 'approved',
            settledBy: null,
            settledAt: null,
            settlementReference: '',
            creditNoteNumber: null,
          },
          $push: {
            history: {
              action: 'settle-reverted',
              by: req.user._id,
              byName: req.user.name || '',
              at: new Date(),
              note: 'Invoice no longer had enough recorded payment',
            },
          },
        }
      );

      return res.status(409).json({
        success: false,
        message:
          'The invoice no longer has enough recorded payment to cover this refund. ' +
          'Nothing was moved; re-check the invoice and raise it again.',
      });
    }

    // The invoice's own derivation, reused rather than reimplemented, so a
    // fully refunded invoice honestly falls back to pending.
    invoice.refreshStatus();
    await invoice.save();

    return res.status(200).json({
      success: true,
      message: `Refund settled. Credit note ${creditNoteNumber} issued.`,
      data: {
        refund: publicRefund(claimed),
        invoice: {
          _id: invoice._id,
          invoiceNumber: invoice.invoiceNumber,
          amountPaid: invoice.amountPaid,
          balance: invoice.balance,
          status: invoice.status,
        },
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not settle the refund');
  }
};

// ---- REPORTING ----

/**
 * GET /api/fees/refunds/summary
 * What the finance office is asked for at the end of a term: how much went
 * back out, under what heading, and how much is still sitting in the queue.
 */
exports.getRefundSummary = async (req, res) => {
  try {
    const { academicYear } = req.query;
    const match = academicYear ? { academicYear } : {};

    const [byStatus, byReason, pendingApproval] = await Promise.all([
      FeeRefund.aggregate([
        { $match: match },
        { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
        { $sort: { _id: 1 } },
      ]),
      FeeRefund.aggregate([
        { $match: { ...match, status: 'settled' } },
        { $group: { _id: '$reason', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
        { $sort: { amount: -1 } },
      ]),
      FeeRefund.countDocuments({ ...match, status: 'requested' }),
    ]);

    const settled = byStatus.find((row) => row._id === 'settled');
    const encumbered = byStatus
      .filter((row) => FeeRefund.ENCUMBERING_STATUSES.includes(row._id) && row._id !== 'settled')
      .reduce((sum, row) => sum + row.amount, 0);

    return res.status(200).json({
      success: true,
      data: {
        academicYear: academicYear || 'all',
        totalRefunded: settled ? settled.amount : 0,
        refundCount: settled ? settled.count : 0,
        // Money the school has effectively already promised back but not yet
        // paid. Reported separately because it is not an expense yet and
        // adding it to the settled figure would overstate the term.
        committedNotYetPaid: encumbered,
        awaitingApproval: pendingApproval,
        byStatus,
        byReason,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not build the refund summary');
  }
};

/**
 * GET /api/fees/refunds/staff
 * The people who can appear as requester or approver, so the panel can label
 * history rows without a lookup per row.
 */
exports.getRefundStaff = async (req, res) => {
  try {
    const staff = await User.find({ role: { $in: ['admin', 'staff'] } })
      .select('name email role')
      .sort({ name: 1 })
      .lean();

    return res.status(200).json({ success: true, count: staff.length, data: staff });
  } catch (err) {
    return handleError(res, err, 'Could not load finance staff');
  }
};
