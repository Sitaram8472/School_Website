// backend/controllers/coverClaimController.js
const mongoose = require('mongoose');
const StaffAbsence = require('../models/StaffAbsence');
const CoverClaim = require('../models/CoverClaim');
const { CoverPaymentBatch } = require('../models/CoverClaim');

/**
 * Payment claims for cover teaching.
 *
 * Every route that can change a month's arithmetic calls `recomputeMonth`
 * afterwards, because the allowance is consumed in claim order and rejecting a
 * claim from the 3rd releases minutes the claim from the 11th then absorbs. The
 * alternative — trusting the figure written when the row was created — produces
 * a batch total that does not add up to its own rows, which is the failure this
 * module is supposed to prevent rather than introduce.
 *
 * A locked month is refused everywhere, and the refusal names the lock date. A
 * figure that has gone to the bank does not move.
 */

const handleError = (res, err, message = 'Server error') => {
  console.error('[cover-claims]', err);
  return res.status(500).json({ success: false, message, error: err.message });
};

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const getPagination = (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
};

const isAdmin = (user) => user && user.role === 'admin';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const currentMonthKey = () => new Date().toISOString().slice(0, 7);

/**
 * Is this month sealed? Returns the batch when it is, null when it is not.
 */
const lockedBatchFor = async (monthKey) => {
  const batch = await CoverPaymentBatch.findOne({ monthKey });
  if (!batch) return null;
  return batch.status === 'open' ? null : batch;
};

const publicClaim = (claim) => ({
  _id: claim._id,
  absence: claim.absence,
  periodId: claim.periodId,
  periodLabel: claim.periodLabel,
  date: claim.date,
  monthKey: claim.monthKey,
  claimant: claim.claimant,
  claimantName: claim.claimantName,
  absentStaffName: claim.absentStaffName,
  className: claim.className,
  subject: claim.subject,
  startTime: claim.startTime,
  endTime: claim.endTime,
  minutes: claim.minutes,
  band: claim.band,
  ratePerHour: claim.ratePerHour,
  allowanceMinutesApplied: claim.allowanceMinutesApplied,
  payableMinutes: claim.payableMinutes,
  grossAmount: claim.grossAmount,
  status: claim.status,
  submittedAt: claim.submittedAt,
  approvedAt: claim.approvedAt,
  approvedBy: claim.approvedBy,
  rejectionReason: claim.rejectionReason,
  paidAt: claim.paidAt,
  paymentReference: claim.paymentReference,
  note: claim.note,
  history: claim.history,
});

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

exports.getClaimMeta = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        statuses: CoverClaim.CLAIM_STATUSES,
        countingStatuses: CoverClaim.COUNTING_STATUSES,
        bands: CoverClaim.BANDS,
        rateBands: CoverClaim.RATE_BANDS,
        monthlyAllowanceMinutes: CoverClaim.DEFAULT_MONTHLY_ALLOWANCE_MINUTES,
        claimWindowDays: CoverClaim.CLAIM_WINDOW_DAYS,
        batchStatuses: CoverPaymentBatch.BATCH_STATUSES,
        currentMonth: currentMonthKey(),
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load claim reference data');
  }
};

/**
 * Periods this person taught and has not claimed for.
 *
 * The list of things that can actually be actioned, rather than every absence
 * in the school. A period already claimed is excluded; one whose claim was
 * rejected reappears, because the point of rejecting is that a correct claim
 * gets raised.
 */
exports.getClaimable = async (req, res) => {
  try {
    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - CoverClaim.CLAIM_WINDOW_DAYS);
    const fromKey = windowStart.toISOString().slice(0, 10);

    const absences = await StaffAbsence.find({
      date: { $gte: fromKey },
      'periods.substitute': req.user._id,
    }).sort({ date: -1 });

    const claims = await CoverClaim.find({
      claimant: req.user._id,
      isCounting: true,
    }).select('absence periodId');

    const claimed = new Set(claims.map((claim) => `${claim.absence}:${claim.periodId}`));
    const rows = [];

    absences.forEach((absence) => {
      absence.periods.forEach((period) => {
        if (String(period.substitute) !== String(req.user._id)) return;
        if (period.coverStatus !== 'completed') return;
        if (claimed.has(`${absence._id}:${period._id}`)) return;

        rows.push({
          absence: absence._id,
          periodId: period._id,
          periodLabel: period.periodLabel,
          date: absence.date,
          monthKey: CoverClaim.monthKeyOf(absence.date),
          absentStaffName: absence.staffName,
          className: period.className,
          subject: period.subject,
          startTime: period.startTime,
          endTime: period.endTime,
          minutes: Math.max(0, (period.endMinute || 0) - (period.startMinute || 0)),
          daysSince: CoverClaim.daysBetween(absence.date, new Date()),
        });
      });
    });

    const months = [...new Set(rows.map((row) => row.monthKey))];
    const batches = await CoverPaymentBatch.find({ monthKey: { $in: months } });
    const sealed = new Map(
      batches.filter((batch) => batch.status !== 'open').map((batch) => [batch.monthKey, batch])
    );

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows.map((row) => ({
        ...row,
        // Say it on the row rather than only on the rejection.
        monthLocked: sealed.has(row.monthKey),
      })),
    });
  } catch (err) {
    return handleError(res, err, 'Could not work out what you can claim for');
  }
};

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

exports.createClaim = async (req, res) => {
  try {
    const { absenceId, periodId, band = 'standard', note = '' } = req.body;

    if (!isValidId(absenceId) || !isValidId(periodId)) {
      return res.status(400).json({ success: false, message: 'Invalid absence or period id' });
    }

    const absence = await StaffAbsence.findById(absenceId);
    if (!absence) {
      return res.status(404).json({ success: false, message: 'Absence not found' });
    }

    const period = absence.periods.id(periodId);
    if (!period) {
      return res.status(404).json({ success: false, message: 'Period not found on that absence' });
    }

    /**
     * Two facts read from the absence, never from the body: that this person
     * taught the lesson, and that the lesson was actually taught.
     */
    if (String(period.substitute) !== String(req.user._id)) {
      return res.status(403).json({
        success: false,
        message: 'That period was covered by somebody else',
      });
    }

    if (period.coverStatus !== 'completed') {
      return res.status(400).json({
        success: false,
        message: `That period is marked "${period.coverStatus}". Only completed cover can be claimed.`,
      });
    }

    const daysSince = CoverClaim.daysBetween(absence.date, new Date());
    if (daysSince > CoverClaim.CLAIM_WINDOW_DAYS) {
      return res.status(400).json({
        success: false,
        message: `That lesson was ${daysSince} days ago; claims close after ${CoverClaim.CLAIM_WINDOW_DAYS} days.`,
      });
    }

    const monthKey = CoverClaim.monthKeyOf(absence.date);
    const locked = await lockedBatchFor(monthKey);

    if (locked) {
      return res.status(409).json({
        success: false,
        message:
          `${monthKey} was locked on ${new Date(locked.lockedAt).toDateString()} and cannot take ` +
          `new claims. Raise this with the office as an exception.`,
      });
    }

    const minutes = Math.max(0, (period.endMinute || 0) - (period.startMinute || 0));
    if (minutes < 1) {
      return res
        .status(400)
        .json({ success: false, message: 'That period has no length recorded' });
    }

    const claim = new CoverClaim({
      absence: absence._id,
      periodId: period._id,
      periodLabel: period.periodLabel,
      date: absence.date,
      monthKey,
      claimant: req.user._id,
      claimantName: req.user.name || '',
      absentStaffName: absence.staffName,
      className: period.className,
      subject: period.subject,
      startTime: period.startTime,
      endTime: period.endTime,
      minutes,
      band: CoverClaim.BANDS.includes(band) ? band : 'standard',
      ratePerHour: CoverClaim.RATE_BANDS[CoverClaim.BANDS.includes(band) ? band : 'standard'],
      status: 'submitted',
      note,
    });

    claim.log('submitted', req.user, `${minutes} minutes`);

    try {
      await claim.save();
    } catch (saveErr) {
      if (saveErr.code === 11000) {
        const other = await CoverClaim.findOne({
          absence: absence._id,
          periodId: period._id,
          isCounting: true,
        });
        return res.status(409).json({
          success: false,
          message: 'There is already a claim for that period',
          data: other ? publicClaim(other) : null,
        });
      }
      if (saveErr.name === 'ValidationError') {
        return res.status(400).json({ success: false, message: saveErr.message });
      }
      throw saveErr;
    }

    const month = await CoverClaim.recomputeMonth(req.user._id, monthKey);
    const saved = await CoverClaim.findById(claim._id);

    return res.status(201).json({
      success: true,
      message:
        saved.payableMinutes === 0
          ? `Claim recorded. All ${minutes} minutes came out of your monthly allowance, so nothing is payable.`
          : `Claim recorded. ${saved.payableMinutes} of ${minutes} minutes are payable.`,
      data: publicClaim(saved),
      month,
    });
  } catch (err) {
    return handleError(res, err, 'Could not raise the claim');
  }
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

exports.getMyClaims = async (req, res) => {
  try {
    const monthKey = MONTH_PATTERN.test(req.query.month || '') ? req.query.month : null;
    const filter = { claimant: req.user._id };
    if (monthKey) filter.monthKey = monthKey;

    const claims = await CoverClaim.find(filter).sort({ date: -1, submittedAt: -1 });

    return res.status(200).json({
      success: true,
      count: claims.length,
      data: claims.map(publicClaim),
    });
  } catch (err) {
    return handleError(res, err, 'Could not load your claims');
  }
};

exports.getMyMonthSummary = async (req, res) => {
  try {
    const monthKey = MONTH_PATTERN.test(req.query.month || '') ? req.query.month : currentMonthKey();

    const claims = await CoverClaim.find({ claimant: req.user._id, monthKey }).sort({
      submittedAt: 1,
    });

    const applied = CoverClaim.applyAllowance(claims);
    const counting = applied.filter((row) =>
      CoverClaim.COUNTING_STATUSES.includes(row.claim.status)
    );

    const allowanceUsed = counting.reduce((sum, row) => sum + row.allowanceMinutesApplied, 0);
    const batch = await CoverPaymentBatch.findOne({ monthKey });

    return res.status(200).json({
      success: true,
      data: {
        monthKey,
        allowanceMinutes: CoverClaim.DEFAULT_MONTHLY_ALLOWANCE_MINUTES,
        allowanceUsed,
        // The figure worth showing before the button, because "I claimed for
        // four periods and got paid for one" is otherwise a complaint rather
        // than an understood rule.
        allowanceLeft: Math.max(0, CoverClaim.DEFAULT_MONTHLY_ALLOWANCE_MINUTES - allowanceUsed),
        claimCount: counting.length,
        totalMinutes: counting.reduce((sum, row) => sum + row.claim.minutes, 0),
        payableMinutes: counting.reduce((sum, row) => sum + row.payableMinutes, 0),
        grossAmount: counting.reduce((sum, row) => sum + row.grossAmount, 0),
        batchStatus: batch ? batch.status : 'open',
        lockedAt: batch ? batch.lockedAt : null,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not summarise your month');
  }
};

exports.getClaims = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = {};

    if (MONTH_PATTERN.test(req.query.month || '')) filter.monthKey = req.query.month;
    if (req.query.status && CoverClaim.CLAIM_STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (req.query.claimant && isValidId(req.query.claimant)) filter.claimant = req.query.claimant;

    const [claims, total] = await Promise.all([
      CoverClaim.find(filter).sort({ date: -1, submittedAt: -1 }).skip(skip).limit(limit),
      CoverClaim.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      count: claims.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      data: claims.map(publicClaim),
    });
  } catch (err) {
    return handleError(res, err, 'Could not load claims');
  }
};

exports.getClaim = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid claim id' });
    }

    const claim = await CoverClaim.findById(id);
    if (!claim) {
      return res.status(404).json({ success: false, message: 'Claim not found' });
    }

    if (!isAdmin(req.user) && String(claim.claimant) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'This is not your claim' });
    }

    return res.status(200).json({ success: true, data: publicClaim(claim) });
  } catch (err) {
    return handleError(res, err, 'Could not load the claim');
  }
};

/**
 * Who is carrying the cover load.
 *
 * Unclaimed cover is included on purpose. The teacher who never bothers to
 * claim is exactly the person this report exists to find, and a report built
 * only from claims would show them as doing nothing.
 */
exports.getLoadReport = async (req, res) => {
  try {
    const monthKey = MONTH_PATTERN.test(req.query.month || '') ? req.query.month : currentMonthKey();

    const absences = await StaffAbsence.find({ date: { $regex: `^${monthKey}` } });
    const claims = await CoverClaim.find({ monthKey, isCounting: true });

    const claimedKeys = new Set(claims.map((claim) => `${claim.absence}:${claim.periodId}`));
    const byStaff = new Map();

    const bucket = (id, name) => {
      const key = String(id);
      if (!byStaff.has(key)) {
        byStaff.set(key, {
          staff: key,
          name,
          periodsCovered: 0,
          minutesCovered: 0,
          periodsClaimed: 0,
          minutesClaimed: 0,
          payableMinutes: 0,
          grossAmount: 0,
        });
      }
      return byStaff.get(key);
    };

    absences.forEach((absence) => {
      absence.periods.forEach((period) => {
        if (period.coverStatus !== 'completed' || !period.substitute) return;

        const row = bucket(period.substitute, period.substituteName || 'Unnamed');
        row.periodsCovered += 1;
        row.minutesCovered += Math.max(0, (period.endMinute || 0) - (period.startMinute || 0));

        if (claimedKeys.has(`${absence._id}:${period._id}`)) row.periodsClaimed += 1;
      });
    });

    claims.forEach((claim) => {
      const row = bucket(claim.claimant, claim.claimantName);
      row.minutesClaimed += claim.minutes;
      row.payableMinutes += claim.payableMinutes;
      row.grossAmount += claim.grossAmount;
    });

    const rows = [...byStaff.values()].map((row) => ({
      ...row,
      periodsUnclaimed: Math.max(0, row.periodsCovered - row.periodsClaimed),
      minutesUnclaimed: Math.max(0, row.minutesCovered - row.minutesClaimed),
    }));

    rows.sort((a, b) => b.minutesCovered - a.minutesCovered);

    return res.status(200).json({
      success: true,
      data: {
        monthKey,
        rows,
        totals: {
          staff: rows.length,
          minutesCovered: rows.reduce((sum, row) => sum + row.minutesCovered, 0),
          minutesUnclaimed: rows.reduce((sum, row) => sum + row.minutesUnclaimed, 0),
          grossAmount: rows.reduce((sum, row) => sum + row.grossAmount, 0),
        },
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not build the load report');
  }
};

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

const decide = async (req, res, verb) => {
  const { id } = req.params;
  if (!isValidId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid claim id' });
  }

  const claim = await CoverClaim.findById(id);
  if (!claim) {
    return res.status(404).json({ success: false, message: 'Claim not found' });
  }

  const locked = await lockedBatchFor(claim.monthKey);
  if (locked) {
    return res.status(409).json({
      success: false,
      message: `${claim.monthKey} was locked on ${new Date(locked.lockedAt).toDateString()}; its claims cannot change.`,
    });
  }

  if (verb !== 'cancel' && String(claim.claimant) === String(req.user._id)) {
    return res.status(403).json({
      success: false,
      message: `A cover claim cannot be ${verb}d by the person who made it`,
    });
  }

  try {
    if (verb === 'approve') claim.approve(req.user);
    if (verb === 'reject') claim.reject(req.user, req.body.reason);
    if (verb === 'cancel') claim.cancel(req.user);
  } catch (stateErr) {
    return res.status(400).json({ success: false, message: stateErr.message });
  }

  await claim.save();

  // The month has to be redone: a rejected claim gives its allowance back to
  // whoever claimed next.
  const month = await CoverClaim.recomputeMonth(claim.claimant, claim.monthKey);
  const saved = await CoverClaim.findById(claim._id);

  return res.status(200).json({
    success: true,
    message: `Claim ${verb}d`,
    data: publicClaim(saved),
    month,
  });
};

exports.approveClaim = async (req, res) => {
  try {
    return await decide(req, res, 'approve');
  } catch (err) {
    return handleError(res, err, 'Could not approve the claim');
  }
};

exports.rejectClaim = async (req, res) => {
  try {
    return await decide(req, res, 'reject');
  } catch (err) {
    return handleError(res, err, 'Could not reject the claim');
  }
};

exports.cancelClaim = async (req, res) => {
  try {
    return await decide(req, res, 'cancel');
  } catch (err) {
    return handleError(res, err, 'Could not cancel the claim');
  }
};

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

exports.getBatches = async (req, res) => {
  try {
    const batches = await CoverPaymentBatch.find({}).sort({ monthKey: -1 }).limit(24);

    return res.status(200).json({
      success: true,
      count: batches.length,
      data: batches,
    });
  } catch (err) {
    return handleError(res, err, 'Could not load payment batches');
  }
};

/**
 * Seal one month.
 *
 * Every claimant's month is recomputed one last time before the totals are
 * taken, so the batch total is the sum of the rows it contains rather than the
 * sum of whatever those rows happened to say earlier.
 */
exports.lockBatch = async (req, res) => {
  try {
    const { monthKey } = req.params;
    if (!MONTH_PATTERN.test(monthKey)) {
      return res.status(400).json({ success: false, message: 'Month must be YYYY-MM' });
    }

    if (monthKey >= currentMonthKey()) {
      return res.status(400).json({
        success: false,
        message: 'A month cannot be locked before it has finished',
      });
    }

    const claimants = await CoverClaim.distinct('claimant', { monthKey });
    await Promise.all(
      claimants.map((claimant) => CoverClaim.recomputeMonth(claimant, monthKey))
    );

    const claims = await CoverClaim.find({
      monthKey,
      status: { $in: CoverClaim.COMMITTED_STATUSES },
    });

    const pending = await CoverClaim.countDocuments({ monthKey, status: 'submitted' });
    if (pending > 0 && req.body.force !== true) {
      return res.status(409).json({
        success: false,
        message: `${pending} claim(s) for ${monthKey} are still awaiting approval. Decide them, or lock with force to leave them out.`,
      });
    }

    const totals = {
      claimCount: claims.length,
      totalMinutes: claims.reduce((sum, claim) => sum + claim.minutes, 0),
      payableMinutes: claims.reduce((sum, claim) => sum + claim.payableMinutes, 0),
      totalAmount: claims.reduce((sum, claim) => sum + claim.grossAmount, 0),
      staffCount: new Set(claims.map((claim) => String(claim.claimant))).size,
    };

    let batch = await CoverPaymentBatch.findOne({ monthKey });
    if (!batch) batch = new CoverPaymentBatch({ monthKey });

    try {
      batch.lock(req.user, totals);
    } catch (stateErr) {
      return res.status(400).json({ success: false, message: stateErr.message });
    }

    await batch.save();

    return res.status(200).json({
      success: true,
      message: `${monthKey} locked: ${totals.claimCount} claim(s), ${totals.totalAmount}`,
      data: batch,
    });
  } catch (err) {
    return handleError(res, err, 'Could not lock the batch');
  }
};

exports.unlockBatch = async (req, res) => {
  try {
    const { monthKey } = req.params;
    const batch = await CoverPaymentBatch.findOne({ monthKey });

    if (!batch) {
      return res.status(404).json({ success: false, message: 'No batch for that month' });
    }

    try {
      batch.unlock(req.user);
    } catch (stateErr) {
      return res.status(400).json({ success: false, message: stateErr.message });
    }

    await batch.save();

    return res.status(200).json({ success: true, message: `${monthKey} reopened`, data: batch });
  } catch (err) {
    return handleError(res, err, 'Could not unlock the batch');
  }
};

exports.payBatch = async (req, res) => {
  try {
    const { monthKey } = req.params;
    const batch = await CoverPaymentBatch.findOne({ monthKey });

    if (!batch) {
      return res.status(404).json({ success: false, message: 'No batch for that month' });
    }

    try {
      batch.markPaid(req.user, req.body.reference);
    } catch (stateErr) {
      return res.status(400).json({ success: false, message: stateErr.message });
    }

    await batch.save();

    // Stamp the rows so a paid claim keeps the figures it was paid on.
    await CoverClaim.updateMany(
      { monthKey, status: 'approved' },
      {
        $set: {
          status: 'paid',
          batch: batch._id,
          paidAt: batch.paidAt,
          paymentReference: batch.paymentReference,
          isCounting: true,
        },
      }
    );

    return res.status(200).json({
      success: true,
      message: `${monthKey} marked paid against ${batch.paymentReference}`,
      data: batch,
    });
  } catch (err) {
    return handleError(res, err, 'Could not pay the batch');
  }
};
