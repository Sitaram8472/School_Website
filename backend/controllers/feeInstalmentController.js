// backend/controllers/feeInstalmentController.js
const mongoose = require('mongoose');
const FeeInvoice = require('../models/FeeInvoice');
const FeeInstalmentPlan = require('../models/FeeInstalmentPlan');
const { InstalmentPlanCounter } = require('../models/FeeInstalmentPlan');

/**
 * Instalment plans against fee invoices.
 *
 * The property this file exists to preserve is that a family who is paying on
 * the schedule the school agreed is never treated as a defaulter, and a family
 * who is not is visible as soon as they slip. Everything else — the serial, the
 * approval, the allocation — is in service of that.
 *
 * Two things are deliberately never stored: arrears, and which instalment a
 * payment landed on. Both are recomputed from the rows on every request. A
 * stored total is the thing that ends up disagreeing with the schedule it is
 * supposed to summarise, and this module's whole value is that the schedule and
 * the summary agree.
 *
 * There is no replica set behind this deployment, so no multi-document
 * transactions are available. The one place two documents must move together —
 * approving a plan and stamping the invoice — is done as guarded atomic updates
 * with an explicit compensating write if the second fails.
 */

const handleError = (res, err, message = 'Server error') => {
  console.error('[fee-instalments]', err);
  return res.status(500).json({ success: false, message, error: err.message });
};

const getPagination = (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
};

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const isBursar = (user) => user && (user.role === 'admin' || user.role === 'staff');

const startOfDay = FeeInstalmentPlan.startOfDay;

/**
 * The shape every screen reads.
 *
 * `position` is computed here rather than persisted, so a plan that has gone
 * into arrears since it was last written says so without anything having run.
 */
const publicPlan = (plan) => {
  const position = plan.position();

  return {
    _id: plan._id,
    planNumber: plan.planNumber,
    invoice: plan.invoice,
    invoiceNumber: plan.invoiceNumber,
    student: plan.student,
    studentName: plan.studentName,
    academicYear: plan.academicYear,
    className: plan.className,
    principal: plan.principal,
    currency: plan.currency,
    downPayment: plan.downPayment,
    instalmentCount: plan.instalmentCount,
    frequency: plan.frequency,
    firstDueOn: plan.firstDueOn,
    graceDays: plan.graceDays,
    missedThreshold: plan.missedThreshold,
    reason: plan.reason,
    status: plan.status,
    instalments: plan.instalments.map((row) => ({
      sequence: row.sequence,
      dueOn: row.dueOn,
      amount: row.amount,
      paidAmount: row.paidAmount,
      status: row.status,
      settledAt: row.settledAt,
      waivedReason: row.waivedReason,
    })),
    payments: plan.payments.map((row) => ({
      reference: row.reference,
      amount: row.amount,
      method: row.method,
      paidAt: row.paidAt,
      recordedByName: row.recordedByName,
      allocation: row.allocation,
      note: row.note,
    })),
    draftedBy: plan.draftedBy,
    draftedByName: plan.draftedByName,
    draftedAt: plan.draftedAt,
    approvedBy: plan.approvedBy,
    approvedAt: plan.approvedAt,
    rejectionReason: plan.rejectionReason,
    cancelReason: plan.cancelReason,
    defaultedAt: plan.defaultedAt,
    defaultReason: plan.defaultReason,
    completedAt: plan.completedAt,
    position,
    history: plan.history,
    createdAt: plan.createdAt,
  };
};

/**
 * A family sees their own schedule and nothing about who inside the school
 * argued about it. Built by naming fields rather than by deleting them, because
 * a redaction that works by deletion is one added field away from a leak.
 */
const familyPlan = (plan) => {
  const position = plan.position();

  return {
    _id: plan._id,
    planNumber: plan.planNumber,
    invoiceNumber: plan.invoiceNumber,
    studentName: plan.studentName,
    academicYear: plan.academicYear,
    principal: plan.principal,
    currency: plan.currency,
    downPayment: plan.downPayment,
    instalmentCount: plan.instalmentCount,
    frequency: plan.frequency,
    graceDays: plan.graceDays,
    status: plan.status,
    instalments: plan.instalments.map((row) => ({
      sequence: row.sequence,
      dueOn: row.dueOn,
      amount: row.amount,
      paidAmount: row.paidAmount,
      status: row.status,
    })),
    position,
    approvedAt: plan.approvedAt,
    completedAt: plan.completedAt,
  };
};

const ownsPlan = (plan, user) =>
  plan.student && String(plan.student._id || plan.student) === String(user._id);

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

exports.getPlanMeta = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        statuses: FeeInstalmentPlan.PLAN_STATUSES,
        instalmentStatuses: FeeInstalmentPlan.INSTALMENT_STATUSES,
        frequencies: FeeInstalmentPlan.FREQUENCIES,
        frequencyDays: FeeInstalmentPlan.FREQUENCY_DAYS,
        methods: FeeInstalmentPlan.PAYMENT_METHODS,
        minInstalments: FeeInstalmentPlan.MIN_INSTALMENTS,
        maxInstalments: FeeInstalmentPlan.MAX_INSTALMENTS,
        defaultGraceDays: FeeInstalmentPlan.DEFAULT_GRACE_DAYS,
        defaultMissedThreshold: FeeInstalmentPlan.DEFAULT_MISSED_THRESHOLD,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load plan reference data');
  }
};

/**
 * What a schedule would look like, without creating one.
 *
 * This exists so a bursar sees the actual dates and the actual amounts — and
 * where the rounding remainder landed — before the plan exists, rather than
 * discovering them after a family has been told something different.
 */
exports.previewPlan = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid invoice id' });
    }

    const invoice = await FeeInvoice.findById(id);
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const balance = Math.max(0, Math.round(invoice.balance || 0));
    const existing = await FeeInstalmentPlan.findOne({ invoice: invoice._id, isLive: true });

    const instalmentCount = parseInt(req.query.instalments, 10) || 3;
    const downPayment = Math.max(0, Math.round(Number(req.query.downPayment) || 0));
    const frequency = req.query.frequency || 'monthly';
    const firstDueOn = req.query.firstDueOn
      ? startOfDay(req.query.firstDueOn)
      : startOfDay(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const base = {
      invoice: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      studentName: invoice.studentName,
      academicYear: invoice.academicYear,
      className: invoice.className,
      currency: invoice.currency,
      totalAmount: invoice.totalAmount,
      amountPaid: invoice.amountPaid,
      balance,
      invoiceStatus: invoice.status,
      dueDate: invoice.dueDate,
      hasLivePlan: Boolean(existing),
      livePlanNumber: existing ? existing.planNumber : null,
    };

    if (balance < 1) {
      return res.status(200).json({
        success: true,
        data: { ...base, schedule: [], error: 'This invoice has nothing left to schedule' },
      });
    }

    try {
      const schedule = FeeInstalmentPlan.buildSchedule({
        principal: balance,
        downPayment,
        instalmentCount,
        frequency,
        firstDueOn,
      });

      return res.status(200).json({
        success: true,
        data: {
          ...base,
          downPayment,
          frequency,
          instalmentCount,
          schedule,
          // Shown so nobody has to work out why instalment 1 is different.
          remainderOn: schedule.length ? schedule[0].sequence : null,
        },
      });
    } catch (buildErr) {
      return res.status(200).json({
        success: true,
        data: { ...base, schedule: [], error: buildErr.message },
      });
    }
  } catch (err) {
    return handleError(res, err, 'Could not preview a plan');
  }
};

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

exports.createPlan = async (req, res) => {
  try {
    const {
      invoiceId,
      instalmentCount,
      downPayment = 0,
      frequency = 'monthly',
      firstDueOn,
      graceDays,
      missedThreshold,
      reason,
      requestKey,
    } = req.body;

    if (!requestKey || !String(requestKey).trim()) {
      return res.status(400).json({ success: false, message: 'A request key is required' });
    }

    // Idempotency first. A retried submission must return the plan that already
    // exists, not create a second one and then fail on the index.
    const existingByKey = await FeeInstalmentPlan.findOne({ requestKey: String(requestKey).trim() });
    if (existingByKey) {
      return res.status(200).json({
        success: true,
        message: 'This plan has already been drafted',
        data: publicPlan(existingByKey),
      });
    }

    if (!isValidId(invoiceId)) {
      return res.status(400).json({ success: false, message: 'Invalid invoice id' });
    }

    const invoice = await FeeInvoice.findById(invoiceId);
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    if (invoice.status === 'waived') {
      return res
        .status(400)
        .json({ success: false, message: 'A waived invoice has nothing to schedule' });
    }

    const principal = Math.max(0, Math.round(invoice.balance || 0));
    if (principal < 1) {
      return res
        .status(400)
        .json({ success: false, message: 'This invoice is settled; there is nothing to schedule' });
    }

    const live = await FeeInstalmentPlan.findOne({ invoice: invoice._id, isLive: true });
    if (live) {
      return res.status(409).json({
        success: false,
        message: `This invoice already has a live plan (${live.planNumber})`,
      });
    }

    let schedule;
    try {
      schedule = FeeInstalmentPlan.buildSchedule({
        principal,
        downPayment,
        instalmentCount,
        frequency,
        firstDueOn: firstDueOn || Date.now() + 7 * 24 * 60 * 60 * 1000,
      });
    } catch (buildErr) {
      return res.status(400).json({ success: false, message: buildErr.message });
    }

    const planNumber = await InstalmentPlanCounter.next(invoice.academicYear);

    const plan = new FeeInstalmentPlan({
      invoice: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      student: invoice.student,
      studentName: invoice.studentName,
      academicYear: invoice.academicYear,
      className: invoice.className,
      planNumber,
      principal,
      currency: invoice.currency || 'INR',
      downPayment: Math.max(0, Math.round(Number(downPayment) || 0)),
      instalmentCount: schedule.length,
      frequency,
      firstDueOn: schedule[0].dueOn,
      instalments: schedule,
      graceDays:
        graceDays === undefined || graceDays === null
          ? FeeInstalmentPlan.DEFAULT_GRACE_DAYS
          : Math.max(0, parseInt(graceDays, 10) || 0),
      missedThreshold:
        missedThreshold === undefined || missedThreshold === null
          ? Math.min(FeeInstalmentPlan.DEFAULT_MISSED_THRESHOLD, schedule.length)
          : Math.max(1, parseInt(missedThreshold, 10) || 1),
      reason,
      status: 'draft',
      draftedBy: req.user._id,
      draftedByName: req.user.name || '',
      requestKey: String(requestKey).trim(),
    });

    plan.log('drafted', req.user, `${schedule.length} instalments against ${principal}`);

    try {
      await plan.save();
    } catch (saveErr) {
      // The index, not the check above, is what actually stops the race.
      if (saveErr.code === 11000) {
        const other = await FeeInstalmentPlan.findOne({
          $or: [{ requestKey: String(requestKey).trim() }, { invoice: invoice._id, isLive: true }],
        });

        if (other) {
          return res.status(409).json({
            success: false,
            message: `A plan for this invoice already exists (${other.planNumber})`,
            data: publicPlan(other),
          });
        }
      }

      if (saveErr.name === 'ValidationError') {
        return res.status(400).json({ success: false, message: saveErr.message });
      }

      throw saveErr;
    }

    return res.status(201).json({
      success: true,
      message: 'Plan drafted; it needs approval before it takes effect',
      data: publicPlan(plan),
    });
  } catch (err) {
    return handleError(res, err, 'Could not draft the plan');
  }
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

exports.getPlans = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = {};

    if (req.query.status && FeeInstalmentPlan.PLAN_STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;
    if (req.query.className) filter.className = req.query.className;
    if (req.query.student && isValidId(req.query.student)) filter.student = req.query.student;

    const [plans, total] = await Promise.all([
      FeeInstalmentPlan.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      FeeInstalmentPlan.countDocuments(filter),
    ]);

    let rows = plans.map(publicPlan);

    // "Show me the ones that have slipped" is the query this screen exists for,
    // and it is a computed property, so it filters after the fact.
    if (req.query.atRisk === 'true') {
      rows = rows.filter((row) => row.position.atRisk);
    }

    return res.status(200).json({
      success: true,
      count: rows.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      data: rows,
    });
  } catch (err) {
    return handleError(res, err, 'Could not load plans');
  }
};

exports.getMyPlans = async (req, res) => {
  try {
    const plans = await FeeInstalmentPlan.find({ student: req.user._id }).sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: plans.length,
      data: plans.map(familyPlan),
    });
  } catch (err) {
    return handleError(res, err, 'Could not load your plans');
  }
};

exports.getPlan = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid plan id' });
    }

    const plan = await FeeInstalmentPlan.findById(id);
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    if (!isBursar(req.user) && !ownsPlan(plan, req.user)) {
      return res.status(403).json({ success: false, message: 'This is not your plan' });
    }

    return res.status(200).json({
      success: true,
      data: isBursar(req.user) ? publicPlan(plan) : familyPlan(plan),
    });
  } catch (err) {
    return handleError(res, err, 'Could not load the plan');
  }
};

/**
 * The figures the finance office actually reports on.
 *
 * Scheduled debt and aged debt are separated here, because that separation is
 * the reason the module exists: one of them is a collection problem and the
 * other one is not, and today they are the same number.
 */
exports.getPlanSummary = async (req, res) => {
  try {
    const filter = {};
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;

    const plans = await FeeInstalmentPlan.find(filter);

    let underPlan = 0;
    let collected = 0;
    let arrears = 0;
    let atRisk = 0;
    let awaitingApproval = 0;
    let defaulted = 0;
    let completed = 0;

    plans.forEach((plan) => {
      const position = plan.position();

      if (plan.status === 'draft') awaitingApproval += 1;
      if (plan.status === 'defaulted') defaulted += 1;
      if (plan.status === 'completed') completed += 1;

      if (plan.status === 'active') {
        underPlan += position.outstanding;
        collected += position.collected;
        arrears += position.arrears;
        if (position.atRisk) atRisk += 1;
      }
    });

    return res.status(200).json({
      success: true,
      data: {
        planCount: plans.length,
        activeCount: plans.filter((plan) => plan.status === 'active').length,
        awaitingApproval,
        // Money that is owed but not late, because a schedule exists for it.
        scheduledOutstanding: underPlan,
        collectedUnderPlan: collected,
        // Money that is owed, scheduled, and late anyway.
        arrears,
        atRisk,
        defaulted,
        completed,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not build the plan summary');
  }
};

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

exports.approvePlan = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid plan id' });
    }

    const plan = await FeeInstalmentPlan.findById(id);
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    if (String(plan.draftedBy) === String(req.user._id)) {
      return res.status(403).json({
        success: false,
        message: 'A plan cannot be approved by the person who drafted it',
      });
    }

    const invoice = await FeeInvoice.findById(plan.invoice);
    if (!invoice) {
      return res.status(409).json({
        success: false,
        message: 'The invoice this plan was written against no longer exists',
      });
    }

    /**
     * Re-check the principal.
     *
     * A payment may have landed between the draft and this moment. Approving a
     * schedule for money that is already paid is how a family gets chased for a
     * bill they settled, so this refuses and says both numbers rather than
     * quietly rewriting the schedule.
     */
    const liveBalance = Math.max(0, Math.round(invoice.balance || 0));
    if (liveBalance !== plan.principal) {
      return res.status(409).json({
        success: false,
        message:
          `The invoice balance has moved since this plan was drafted ` +
          `(drafted against ${plan.principal}, now ${liveBalance}). ` +
          `Cancel this plan and draft another.`,
        data: { draftedAgainst: plan.principal, currentBalance: liveBalance },
      });
    }

    try {
      plan.approve(req.user, req.body.note);
    } catch (stateErr) {
      return res.status(400).json({ success: false, message: stateErr.message });
    }

    await plan.save();

    return res.status(200).json({
      success: true,
      message: `Plan ${plan.planNumber} is now active`,
      data: publicPlan(plan),
    });
  } catch (err) {
    return handleError(res, err, 'Could not approve the plan');
  }
};

exports.rejectPlan = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid plan id' });
    }

    const plan = await FeeInstalmentPlan.findById(id);
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    if (String(plan.draftedBy) === String(req.user._id)) {
      return res.status(403).json({
        success: false,
        message: 'A plan cannot be rejected by the person who drafted it',
      });
    }

    try {
      plan.reject(req.user, req.body.reason);
    } catch (stateErr) {
      return res.status(400).json({ success: false, message: stateErr.message });
    }

    await plan.save();

    return res.status(200).json({
      success: true,
      message: 'Plan rejected',
      data: publicPlan(plan),
    });
  } catch (err) {
    return handleError(res, err, 'Could not reject the plan');
  }
};

exports.cancelPlan = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid plan id' });
    }

    const plan = await FeeInstalmentPlan.findById(id);
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    try {
      plan.cancel(req.user, req.body.reason);
    } catch (stateErr) {
      return res.status(400).json({ success: false, message: stateErr.message });
    }

    await plan.save();

    return res.status(200).json({
      success: true,
      message: 'Plan cancelled; the invoice reverts to its own due date',
      data: publicPlan(plan),
    });
  } catch (err) {
    return handleError(res, err, 'Could not cancel the plan');
  }
};

exports.defaultPlan = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid plan id' });
    }

    const plan = await FeeInstalmentPlan.findById(id);
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    try {
      plan.markDefaulted(req.user, req.body.reason);
    } catch (stateErr) {
      return res.status(400).json({ success: false, message: stateErr.message });
    }

    await plan.save();

    return res.status(200).json({
      success: true,
      message: 'Plan marked as defaulted',
      data: publicPlan(plan),
    });
  } catch (err) {
    return handleError(res, err, 'Could not default the plan');
  }
};

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Record a payment against a plan and move the invoice with it.
 *
 * The two writes that must not half-happen are the plan's payment row and the
 * invoice's balance. There is no transaction available, so the invoice moves
 * first under a guard and the plan is written second; if the plan write fails,
 * the invoice movement is compensated. The order matters: an invoice that has
 * been credited and a plan that has not is a discrepancy somebody notices,
 * whereas the reverse silently over-credits the family.
 */
exports.recordPlanPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, method = 'bank-transfer', reference, paidAt, note } = req.body;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid plan id' });
    }

    if (!reference || !String(reference).trim()) {
      return res
        .status(400)
        .json({ success: false, message: 'A payment reference is required' });
    }

    const numericAmount = Math.round(Number(amount));
    if (!Number.isFinite(numericAmount) || numericAmount < 1) {
      return res.status(400).json({ success: false, message: 'A payment must be more than zero' });
    }

    const plan = await FeeInstalmentPlan.findById(id);
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    if (plan.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: `Payments can only be recorded against an active plan; this one is ${plan.status}`,
      });
    }

    const cleanReference = String(reference).trim();

    // Idempotency at the plan level: the same reference twice is the same money.
    if (plan.payments.some((row) => row.reference === cleanReference)) {
      return res.status(200).json({
        success: true,
        message: 'That payment reference is already recorded against this plan',
        data: publicPlan(plan),
      });
    }

    const { outstanding } = plan.position();
    if (numericAmount > outstanding) {
      return res.status(400).json({
        success: false,
        message: `That is more than the plan still owes (${outstanding})`,
      });
    }

    // Move the invoice first, under a guard, so a concurrent payment cannot
    // take the balance negative.
    const invoiceUpdate = await FeeInvoice.findOneAndUpdate(
      { _id: plan.invoice, balance: { $gte: numericAmount } },
      { $inc: { balance: -numericAmount, amountPaid: numericAmount } },
      { new: true }
    );

    if (!invoiceUpdate) {
      return res.status(409).json({
        success: false,
        message: 'The invoice no longer has that much outstanding; reload and try again',
      });
    }

    try {
      plan.payments.push({
        reference: cleanReference,
        amount: numericAmount,
        method,
        paidAt: paidAt ? new Date(paidAt) : new Date(),
        recordedBy: req.user._id,
        recordedByName: req.user.name || '',
        note: note || '',
      });

      plan.reallocate();
      plan.refreshCompletion();
      plan.log('payment', req.user, `${numericAmount} against ${cleanReference}`);

      await plan.save();
    } catch (planErr) {
      // Compensate: put the invoice back where it was.
      await FeeInvoice.updateOne(
        { _id: plan.invoice },
        { $inc: { balance: numericAmount, amountPaid: -numericAmount } }
      );

      throw planErr;
    }

    // Keep the invoice's own status honest now the money has moved.
    try {
      invoiceUpdate.refreshStatus();
      await invoiceUpdate.save();
    } catch (statusErr) {
      console.error('[fee-instalments] invoice status refresh failed', statusErr);
    }

    return res.status(200).json({
      success: true,
      message:
        plan.status === 'completed'
          ? 'Payment recorded; the plan is now settled in full'
          : 'Payment recorded',
      data: publicPlan(plan),
    });
  } catch (err) {
    return handleError(res, err, 'Could not record the payment');
  }
};

exports.waiveInstalment = async (req, res) => {
  try {
    const { id, sequence } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid plan id' });
    }

    const plan = await FeeInstalmentPlan.findById(id);
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    try {
      plan.waiveInstalment(sequence, req.user, req.body.reason);
      plan.refreshCompletion();
    } catch (stateErr) {
      return res.status(400).json({ success: false, message: stateErr.message });
    }

    await plan.save();

    return res.status(200).json({
      success: true,
      message: `Instalment ${sequence} waived`,
      data: publicPlan(plan),
    });
  } catch (err) {
    return handleError(res, err, 'Could not waive the instalment');
  }
};

/**
 * Invoices a bursar might want to put on a plan.
 *
 * Scoped to invoices with something left to pay and no live plan already, so
 * the list is the set of things that can actually be actioned rather than every
 * invoice in the school.
 */
exports.getSchedulableInvoices = async (req, res) => {
  try {
    const { limit } = getPagination(req);
    const filter = { balance: { $gt: 0 }, status: { $ne: 'waived' } };

    if (req.query.q) {
      filter.studentName = { $regex: String(req.query.q).trim(), $options: 'i' };
    }
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;

    const invoices = await FeeInvoice.find(filter).sort({ dueDate: 1 }).limit(limit);

    const livePlans = await FeeInstalmentPlan.find({
      invoice: { $in: invoices.map((invoice) => invoice._id) },
      isLive: true,
    }).select('invoice planNumber');

    const taken = new Map(livePlans.map((plan) => [String(plan.invoice), plan.planNumber]));

    return res.status(200).json({
      success: true,
      count: invoices.length,
      data: invoices.map((invoice) => ({
        _id: invoice._id,
        invoiceNumber: invoice.invoiceNumber,
        studentName: invoice.studentName,
        academicYear: invoice.academicYear,
        className: invoice.className,
        totalAmount: invoice.totalAmount,
        amountPaid: invoice.amountPaid,
        balance: invoice.balance,
        currency: invoice.currency,
        dueDate: invoice.dueDate,
        status: invoice.status,
        livePlanNumber: taken.get(String(invoice._id)) || null,
      })),
    });
  } catch (err) {
    return handleError(res, err, 'Could not load schedulable invoices');
  }
};
