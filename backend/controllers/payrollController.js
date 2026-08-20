const mongoose = require('mongoose');
const {
  PayrollRun,
  Payslip,
  RUN_STATUSES,
  EARNING_CODES,
  DEDUCTION_CODES,
  DERIVED_DEDUCTION_CODES,
  PROVIDENT_FUND_RATE,
  PROFESSIONAL_TAX_SLABS,
  periodLabel,
} = require('../models/PayrollRun');
const User = require('../models/User');

/**
 * Payroll.
 *
 * The handler worth reading is `lockRun`. It recomputes everything, refuses the
 * whole run if any payslip does not work, issues the serials with a single
 * `$inc` per payslip so two clerks locking at once cannot collide, and stores a
 * fingerprint over the nets. After that there is no way back: `paid` and
 * `cancelled` are the only moves, and neither changes a figure.
 *
 * Everywhere else the rule is the same one: gross, loss of pay, provident fund,
 * professional tax and net are recomputed from the lines on every write, so a
 * `netPay` in a request body is not so much rejected as never read.
 */

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

function serverError(res, error, message) {
  console.error(`${message}:`, error);
  return res.status(500).json({ success: false, message, error: error.message });
}

function validationMessage(error) {
  if (!error) return null;
  if (error.name === 'ValidationError') {
    return Object.values(error.errors)
      .map((e) => e.message)
      .join(' ');
  }
  if (error.name === 'ValidatorError' || error.name === 'CastError') return error.message;
  return null;
}

function isAdmin(user) {
  return user && user.role === 'admin';
}

/** The fields an admin may set on a run. Totals and serials are not among them. */
function sanitiseRun(body) {
  return {
    period: body.period,
    payDate: body.payDate,
    workingDays: body.workingDays === undefined ? undefined : Number(body.workingDays),
    notes: body.notes,
  };
}

/**
 * Lines arrive as `{ code, amount }` pairs. Unknown codes are dropped here
 * rather than at the schema, so a typo in one line does not fail the request
 * with a message about the whole array.
 */
function sanitiseLines(list, allowedCodes) {
  if (!Array.isArray(list)) return undefined;
  return list
    .filter((line) => line && allowedCodes.includes(line.code))
    .map((line) => ({
      code: line.code,
      label: line.label,
      amount: Math.max(0, Number(line.amount) || 0),
    }));
}

/**
 * The office types the earnings. It does not type provident fund or
 * professional tax — those come back from `recompute()` — so any attempt to
 * supply them is dropped before the payslip sees them.
 */
function sanitiseDeductions(list) {
  const cleaned = sanitiseLines(list, DEDUCTION_CODES);
  if (!cleaned) return undefined;
  return cleaned.filter((line) => !DERIVED_DEDUCTION_CODES.includes(line.code));
}

async function loadRun(id) {
  if (!isValidId(id)) return { status: 400, message: 'Invalid run id' };
  const run = await PayrollRun.findById(id);
  if (!run) return { status: 404, message: 'Payroll run not found' };
  return { run };
}

/**
 * Recompute every payslip in a run and hand back the ones that do not work.
 *
 * Called by the recompute endpoint and again by the lock, because a lock that
 * trusts an earlier computation is a lock that freezes a stale figure.
 */
async function recomputeRun(run) {
  const payslips = await Payslip.find({ run: run._id });
  const invalid = [];

  for (const slip of payslips) {
    const outcome = slip.recompute(run.workingDays);
    if (!outcome.valid) {
      invalid.push({ payslip: slip, message: slip.shortfallMessage() });
      continue;
    }
    if (!slip.isLocked()) await slip.save();
  }

  run.applyTotals(payslips.filter((slip) => slip.netPay >= 0));
  run.computedAt = new Date();

  return { payslips, invalid };
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/** GET /api/payroll/meta */
exports.getMeta = async (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      runStatuses: RUN_STATUSES,
      earningCodes: EARNING_CODES,
      deductionCodes: DEDUCTION_CODES,
      derivedDeductionCodes: DERIVED_DEDUCTION_CODES,
      providentFundRate: PROVIDENT_FUND_RATE,
      professionalTaxSlabs: PROFESSIONAL_TAX_SLABS.map((slab) => ({
        upTo: slab.upTo === Infinity ? null : slab.upTo,
        amount: slab.amount,
      })),
    },
  });
};

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** POST /api/payroll/runs */
exports.createRun = async (req, res) => {
  try {
    const run = new PayrollRun({
      ...sanitiseRun(req.body),
      status: 'draft',
      createdBy: req.user._id,
    });

    run.recordHistory('created', req.user._id);
    await run.save();

    return res.status(201).json({
      success: true,
      message: `${periodLabel(run.period)} payroll opened`,
      data: run,
    });
  } catch (error) {
    if (error.code === 11000) {
      return fail(
        res,
        409,
        `${periodLabel(req.body.period)} already has a live payroll run; cancel it before opening another`
      );
    }
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to open the payroll run');
  }
};

/** GET /api/payroll/runs */
exports.listRuns = async (req, res) => {
  try {
    const filter = {};
    if (req.query.status && RUN_STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (req.query.period) filter.period = req.query.period;

    const runs = await PayrollRun.find(filter).sort({ period: -1 }).limit(120);
    return res.status(200).json({ success: true, count: runs.length, data: runs });
  } catch (error) {
    return serverError(res, error, 'Failed to load payroll runs');
  }
};

/** GET /api/payroll/runs/:id */
exports.getRun = async (req, res) => {
  try {
    const { run, status, message } = await loadRun(req.params.id);
    if (!run) return fail(res, status, message);

    const payslips = await Payslip.find({ run: run._id })
      .sort({ serial: 1, createdAt: 1 })
      .populate('staff', 'name email role');

    return res.status(200).json({ success: true, data: { run, payslips } });
  } catch (error) {
    return serverError(res, error, 'Failed to load the payroll run');
  }
};

/** PATCH /api/payroll/runs/:id */
exports.updateRun = async (req, res) => {
  try {
    const { run, status, message } = await loadRun(req.params.id);
    if (!run) return fail(res, status, message);

    if (!run.isEditable()) return fail(res, 409, `A ${run.status} run cannot be edited`);

    const updates = sanitiseRun(req.body);
    Object.entries(updates).forEach(([key, value]) => {
      if (value !== undefined) run.set(key, value);
    });

    run.recordHistory('edited', req.user._id);
    await run.save();

    // Working days feed the proration, so every payslip is stale now.
    await recomputeRun(run);
    await run.save();

    return res.status(200).json({ success: true, message: 'Run updated', data: run });
  } catch (error) {
    const msg = validationMessage(error);
    if (msg) return fail(res, 400, msg);
    return serverError(res, error, 'Failed to update the run');
  }
};

/** POST /api/payroll/runs/:id/recompute */
exports.recomputeRunHandler = async (req, res) => {
  try {
    const { run, status, message } = await loadRun(req.params.id);
    if (!run) return fail(res, status, message);

    if (run.status === 'cancelled') return fail(res, 409, 'A cancelled run cannot be recomputed');
    if (run.isPublished()) return fail(res, 409, 'A locked run is final');

    const { payslips, invalid } = await recomputeRun(run);
    run.status = 'computed';
    run.recordHistory('recomputed', req.user._id, `${payslips.length} payslips`);
    await run.save();

    return res.status(200).json({
      success: true,
      message: invalid.length
        ? `${payslips.length} payslips computed, ${invalid.length} do not balance`
        : `${payslips.length} payslips computed`,
      data: {
        run,
        invalid: invalid.map((entry) => ({
          payslip: entry.payslip._id,
          staff: entry.payslip.staff,
          message: entry.message,
        })),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to recompute the run');
  }
};

/**
 * PATCH /api/payroll/runs/:id/lock
 *
 * One-way. Everything is recomputed first, because a lock that trusts an
 * earlier computation freezes whatever was stale about it.
 */
exports.lockRun = async (req, res) => {
  try {
    const { run, status, message } = await loadRun(req.params.id);
    if (!run) return fail(res, status, message);

    if (run.status === 'locked' || run.status === 'paid') {
      return res.status(200).json({ success: true, message: 'Already locked', data: run });
    }
    if (run.status === 'cancelled') return fail(res, 409, 'A cancelled run cannot be locked');

    const { payslips, invalid } = await recomputeRun(run);

    if (!payslips.length) return fail(res, 400, 'There are no payslips in this run');
    if (invalid.length) {
      return fail(res, 409, `${invalid.length} payslips do not balance; fix them before locking`, {
        invalid: invalid.map((entry) => ({ payslip: entry.payslip._id, message: entry.message })),
      });
    }

    const lockedAt = new Date();
    for (const slip of payslips) {
      if (slip.serial) continue;
      // $inc rather than count + 1: two clerks locking at the same moment get
      // 0007 and 0008, not 0007 twice.
      const counted = await PayrollRun.findByIdAndUpdate(
        run._id,
        { $inc: { serialCounter: 1 } },
        { new: true }
      );
      slip.serial = `PAY/${run.period}/${String(counted.serialCounter).padStart(4, '0')}`;
      slip.lockedAt = lockedAt;
      slip.recordHistory('locked', req.user._id);
      await slip.save();
    }

    run.status = 'locked';
    run.lockedAt = lockedAt;
    run.lockedBy = req.user._id;
    run.fingerprint = PayrollRun.fingerprintOf(payslips);
    run.recordHistory('locked', req.user._id, `${payslips.length} payslips`);
    await run.save();

    return res.status(200).json({
      success: true,
      message: `${payslips.length} payslips locked and serialled; net ${run.totals.net}`,
      data: run,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to lock the run');
  }
};

/** PATCH /api/payroll/runs/:id/mark-paid */
exports.markRunPaid = async (req, res) => {
  try {
    const { run, status, message } = await loadRun(req.params.id);
    if (!run) return fail(res, status, message);

    if (run.status === 'paid') {
      return res.status(200).json({ success: true, message: 'Already marked paid', data: run });
    }
    if (run.status !== 'locked') {
      return fail(res, 409, 'Only a locked run can be marked paid');
    }

    run.status = 'paid';
    run.paidAt = new Date();
    run.recordHistory('marked paid', req.user._id, req.body.note);
    await run.save();

    return res.status(200).json({ success: true, message: 'Run marked paid', data: run });
  } catch (error) {
    return serverError(res, error, 'Failed to mark the run paid');
  }
};

/**
 * PATCH /api/payroll/runs/:id/cancel
 *
 * Cancelling keeps every payslip and every serial. Deleting payroll history is
 * how a school ends up unable to answer a provident-fund query from four years
 * ago.
 */
exports.cancelRun = async (req, res) => {
  try {
    const { run, status, message } = await loadRun(req.params.id);
    if (!run) return fail(res, status, message);

    if (run.status === 'cancelled') {
      return res.status(200).json({ success: true, message: 'Already cancelled', data: run });
    }

    const reason = (req.body.reason || '').trim();
    if (reason.length < 8) return fail(res, 400, 'Cancelling a payroll run needs a reason');

    run.status = 'cancelled';
    run.cancelledAt = new Date();
    run.cancellationReason = reason;
    run.recordHistory('cancelled', req.user._id, reason);
    await run.save();

    return res.status(200).json({
      success: true,
      message: 'Run cancelled; its payslips are kept',
      data: run,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to cancel the run');
  }
};

// ---------------------------------------------------------------------------
// Payslips
// ---------------------------------------------------------------------------

/** POST /api/payroll/runs/:id/payslips */
exports.addPayslip = async (req, res) => {
  try {
    const { run, status, message } = await loadRun(req.params.id);
    if (!run) return fail(res, status, message);

    if (!run.isEditable()) {
      return fail(res, 409, `Payslips cannot be added to a ${run.status} run`);
    }

    if (!isValidId(req.body.staff)) return fail(res, 400, 'Invalid staff id');
    const staff = await User.findById(req.body.staff).select('name role');
    if (!staff) return fail(res, 404, 'That member of staff does not exist');
    if (staff.role === 'student') {
      return fail(res, 400, 'Students are not on the payroll');
    }

    const payslip = new Payslip({
      run: run._id,
      staff: staff._id,
      designationSnapshot: req.body.designation || staff.role,
      earnings: sanitiseLines(req.body.earnings, EARNING_CODES) || [],
      deductions: sanitiseDeductions(req.body.deductions) || [],
      unpaidLeaveDays: Number(req.body.unpaidLeaveDays) || 0,
      providentFundOverride: {
        amount:
          req.body.providentFundOverride?.amount === undefined
            ? null
            : Number(req.body.providentFundOverride.amount),
        reason: req.body.providentFundOverride?.reason,
      },
    });

    const outcome = payslip.recompute(run.workingDays);
    if (!outcome.valid) return fail(res, 400, payslip.shortfallMessage());

    payslip.recordHistory('created', req.user._id);
    await payslip.save();

    await recomputeRun(run);
    await run.save();

    return res.status(201).json({ success: true, message: 'Payslip added', data: payslip });
  } catch (error) {
    if (error.code === 11000) {
      return fail(res, 409, 'That member of staff already has a payslip in this run');
    }
    const msg = validationMessage(error);
    if (msg) return fail(res, 400, msg);
    return serverError(res, error, 'Failed to add the payslip');
  }
};

/** PATCH /api/payroll/runs/:id/payslips/:pid */
exports.updatePayslip = async (req, res) => {
  try {
    const { run, status, message } = await loadRun(req.params.id);
    if (!run) return fail(res, status, message);

    if (!run.isEditable()) return fail(res, 409, `A ${run.status} run is final`);
    if (!isValidId(req.params.pid)) return fail(res, 400, 'Invalid payslip id');

    const payslip = await Payslip.findOne({ _id: req.params.pid, run: run._id });
    if (!payslip) return fail(res, 404, 'Payslip not found in this run');
    if (payslip.isLocked()) return fail(res, 409, 'That payslip is locked');

    const earnings = sanitiseLines(req.body.earnings, EARNING_CODES);
    if (earnings) payslip.earnings = earnings;

    const deductions = sanitiseDeductions(req.body.deductions);
    if (deductions) {
      // Keep whatever the recompute owns; replace only what the office types.
      const derived = payslip.deductions.filter((line) =>
        DERIVED_DEDUCTION_CODES.includes(line.code)
      );
      payslip.deductions = [...deductions, ...derived];
    }

    if (req.body.unpaidLeaveDays !== undefined) {
      payslip.unpaidLeaveDays = Number(req.body.unpaidLeaveDays);
    }
    if (req.body.designation !== undefined) {
      payslip.designationSnapshot = req.body.designation;
    }
    if (req.body.providentFundOverride !== undefined) {
      const override = req.body.providentFundOverride || {};
      const amount = override.amount === null || override.amount === undefined
        ? null
        : Number(override.amount);
      if (amount !== null && !(override.reason || '').trim()) {
        return fail(res, 400, 'Overriding the provident fund needs a reason on the payslip');
      }
      payslip.providentFundOverride = { amount, reason: override.reason };
    }

    const outcome = payslip.recompute(run.workingDays);
    if (!outcome.valid) return fail(res, 400, payslip.shortfallMessage());

    payslip.recordHistory('edited', req.user._id);
    await payslip.save();

    await recomputeRun(run);
    await run.save();

    return res.status(200).json({ success: true, message: 'Payslip updated', data: payslip });
  } catch (error) {
    const msg = validationMessage(error);
    if (msg) return fail(res, 400, msg);
    return serverError(res, error, 'Failed to update the payslip');
  }
};

/** DELETE /api/payroll/runs/:id/payslips/:pid */
exports.removePayslip = async (req, res) => {
  try {
    const { run, status, message } = await loadRun(req.params.id);
    if (!run) return fail(res, status, message);

    if (!run.isEditable()) return fail(res, 409, `A ${run.status} run is final`);
    if (!isValidId(req.params.pid)) return fail(res, 400, 'Invalid payslip id');

    const payslip = await Payslip.findOne({ _id: req.params.pid, run: run._id });
    if (!payslip) return fail(res, 404, 'Payslip not found in this run');
    if (payslip.isLocked()) return fail(res, 409, 'A locked payslip cannot be removed');

    await payslip.deleteOne();
    await recomputeRun(run);
    await run.save();

    return res.status(200).json({ success: true, message: 'Payslip removed' });
  } catch (error) {
    return serverError(res, error, 'Failed to remove the payslip');
  }
};

/**
 * GET /api/payroll/payslips/mine
 *
 * Locked and paid runs only. A draft payslip is a working figure.
 */
exports.getMyPayslips = async (req, res) => {
  try {
    const publishedRuns = await PayrollRun.find({ status: { $in: ['locked', 'paid'] } })
      .select('_id period payDate status')
      .sort({ period: -1 })
      .limit(36);

    const runIds = publishedRuns.map((run) => run._id);
    const payslips = await Payslip.find({ staff: req.user._id, run: { $in: runIds } }).sort({
      createdAt: -1,
    });

    const runsById = new Map(publishedRuns.map((run) => [String(run._id), run]));

    return res.status(200).json({
      success: true,
      count: payslips.length,
      data: payslips.map((slip) => ({
        ...slip.toObject(),
        run: runsById.get(String(slip.run)),
        periodLabel: periodLabel(runsById.get(String(slip.run))?.period),
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load your payslips');
  }
};

/** GET /api/payroll/payslips/:id */
exports.getPayslip = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid payslip id');

    const payslip = await Payslip.findById(req.params.id).populate('staff', 'name email role');
    if (!payslip) return fail(res, 404, 'Payslip not found');

    const owns = String(payslip.staff?._id || payslip.staff) === String(req.user._id);
    if (!owns && !isAdmin(req.user)) {
      return fail(res, 403, 'That payslip belongs to another member of staff');
    }

    const run = await PayrollRun.findById(payslip.run);
    if (owns && !isAdmin(req.user) && !run.isPublished()) {
      return fail(res, 403, 'That payroll run has not been finalised yet');
    }

    return res.status(200).json({
      success: true,
      data: { payslip, run, periodLabel: periodLabel(run?.period) },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the payslip');
  }
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** GET /api/payroll/stats */
exports.getStats = async (req, res) => {
  try {
    const [byStatus, lastLocked] = await Promise.all([
      PayrollRun.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      PayrollRun.findOne({ status: { $in: ['locked', 'paid'] } }).sort({ period: -1 }),
    ]);

    const openRun = await PayrollRun.findOne({ status: { $in: ['draft', 'computed'] } }).sort({
      period: -1,
    });

    return res.status(200).json({
      success: true,
      data: {
        byStatus: byStatus.reduce((acc, row) => ({ ...acc, [row._id]: row.count }), {}),
        openRun: openRun
          ? { id: openRun._id, period: openRun.period, totals: openRun.totals }
          : null,
        lastLocked: lastLocked
          ? {
              id: lastLocked._id,
              period: lastLocked.period,
              totals: lastLocked.totals,
              lockedAt: lastLocked.lockedAt,
            }
          : null,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load payroll statistics');
  }
};
