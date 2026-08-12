const mongoose = require('mongoose');
const Campaign = require('../models/Campaign');
const Pledge = require('../models/Pledge');

/**
 * Donations and fundraising.
 *
 * Three things here are the module.
 *
 * `recordPayment` is idempotent on `reference`. A repeat of the same reference
 * returns the existing payment and its original receipt serial, and moves no
 * total. The gateway that times out and is retried, the double-tapped button,
 * the same UTR entered by two people in the office — none of them can put the
 * campaign ₹5,000 over in a way that is only found by reconciling against the
 * bank in April.
 *
 * `campaignProgress` aggregates over the pledges per request. There is no
 * stored counter, because a counter drifts the first time anything is waived or
 * cancelled and it drifts silently.
 *
 * Receipt serials come from `Campaign.nextReceiptSerial`, which is an atomic
 * `$inc`. There is no second receipt book, so there cannot be a second
 * number 47.
 */

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

function ok(res, data, extra = {}) {
  return res.status(200).json({ success: true, data, ...extra });
}

function serverError(res, error, message) {
  console.error(`${message}:`, error);
  return res.status(500).json({
    success: false,
    message,
    error: error.message,
  });
}

function validationMessage(error) {
  if (!error) return null;
  if (error.name === 'ValidationError') {
    return Object.values(error.errors)
      .map((e) => e.message)
      .join(' ');
  }
  if (error.name === 'ValidatorError' || error.name === 'CastError') {
    return error.message;
  }
  if (error.code === 11000) {
    return 'That payment reference has already been recorded against this pledge';
  }
  return null;
}

function isAdmin(user) {
  return user && user.role === 'admin';
}

function isStaff(user) {
  return user && (user.role === 'teacher' || user.role === 'staff' || user.role === 'admin');
}

function parseDate(value, fieldLabel) {
  if (value === undefined || value === null || value === '') return { value: undefined };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { error: `${fieldLabel} is not a valid date` };
  return { value: date };
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** The Indian financial year containing `date`, as `2026-27`. */
function financialYearFor(date = new Date()) {
  const year = date.getFullYear();
  const startYear = date.getMonth() >= 3 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/**
 * A campaign's progress, aggregated over its pledges.
 *
 * Cancelled pledges are excluded from both figures. A lapsed one keeps the
 * money it actually received and contributes nothing further to the promise —
 * counting a lapsed promise as pledged is how a thermometer stays high after
 * the donor has walked away.
 */
async function campaignProgress(campaignId) {
  const rows = await Pledge.aggregate([
    { $match: { campaign: new mongoose.Types.ObjectId(String(campaignId)), status: { $ne: 'cancelled' } } },
    {
      $group: {
        _id: null,
        amountPledged: {
          $sum: { $cond: [{ $eq: ['$status', 'lapsed'] }, '$amountReceived', '$amount'] },
        },
        amountReceived: { $sum: '$amountReceived' },
        pledgeCount: { $sum: 1 },
        donors: { $addToSet: '$donorName' },
      },
    },
  ]);

  const row = rows[0] || {
    amountPledged: 0,
    amountReceived: 0,
    pledgeCount: 0,
    donors: [],
  };

  return {
    amountPledged: round2(row.amountPledged),
    amountReceived: round2(row.amountReceived),
    amountOutstanding: round2(row.amountPledged - row.amountReceived),
    pledgeCount: row.pledgeCount,
    donorCount: (row.donors || []).length,
  };
}

/** Progress with the goal-relative percentages the page draws two bars from. */
async function progressWithGoal(campaign) {
  const progress = await campaignProgress(campaign._id);
  const goal = Number(campaign.goalAmount) || 0;
  return {
    ...progress,
    receivedPercent: goal ? Math.round((progress.amountReceived / goal) * 1000) / 10 : 0,
    pledgedPercent: goal ? Math.round((progress.amountPledged / goal) * 1000) / 10 : 0,
  };
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/**
 * GET /api/giving/meta
 */
exports.getMeta = async (req, res) => {
  try {
    return ok(res, {
      categories: Campaign.CATEGORIES,
      campaignStatuses: Campaign.STATUSES,
      visibilities: Campaign.VISIBILITIES,
      schedules: Pledge.SCHEDULES,
      scheduleCounts: Pledge.SCHEDULE_COUNTS,
      donorTypes: Pledge.DONOR_TYPES,
      pledgeStatuses: Pledge.STATUSES,
      instalmentStatuses: Pledge.INSTALMENT_STATUSES,
      methods: Pledge.METHODS,
      financialYear: financialYearFor(),
    });
  } catch (error) {
    return serverError(res, error, 'Could not load giving reference data');
  }
};

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

/**
 * POST /api/giving/campaigns
 */
exports.createCampaign = async (req, res) => {
  try {
    const {
      title,
      purpose,
      category,
      goalAmount,
      currency,
      startsOn,
      endsOn,
      visibility,
      receiptPrefix,
    } = req.body;

    const starts = parseDate(startsOn, 'Start date');
    if (starts.error) return fail(res, 400, starts.error);
    const ends = parseDate(endsOn, 'End date');
    if (ends.error) return fail(res, 400, ends.error);

    const campaign = new Campaign({
      title,
      purpose,
      category,
      goalAmount,
      currency,
      startsOn: starts.value || new Date(),
      endsOn: ends.value,
      visibility,
      receiptPrefix,
      status: 'draft',
    });

    campaign.recordHistory({
      action: 'created',
      to: 'draft',
      by: req.user._id,
      note: `Goal ${campaign.goalAmount}`,
    });

    await campaign.save();

    return res.status(201).json({
      success: true,
      message: 'Appeal created as a draft',
      data: campaign.toRow(await progressWithGoal(campaign)),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not create the appeal');
  }
};

/**
 * PATCH /api/giving/campaigns/:id
 */
exports.updateCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid campaign id');

    const campaign = await Campaign.findById(id);
    if (!campaign) return fail(res, 404, 'Appeal not found');

    const changed = [];
    for (const field of ['title', 'purpose', 'category', 'goalAmount', 'visibility']) {
      if (req.body[field] === undefined) continue;
      campaign[field] = req.body[field];
      changed.push(field);
    }
    for (const [field, label] of [
      ['startsOn', 'Start date'],
      ['endsOn', 'End date'],
    ]) {
      if (req.body[field] === undefined) continue;
      const parsed = parseDate(req.body[field], label);
      if (parsed.error) return fail(res, 400, parsed.error);
      campaign[field] = parsed.value;
      changed.push(field);
    }

    if (!changed.length) return fail(res, 400, 'Nothing to update');

    // The prefix is part of every serial already issued. Changing it would make
    // two receipts with the same number look like different receipts.
    if (req.body.receiptPrefix !== undefined && campaign.receiptSequence > 0) {
      return fail(
        res,
        409,
        'Receipts have already been issued under this prefix, so it cannot change'
      );
    }

    campaign.recordHistory({
      action: 'updated',
      by: req.user._id,
      note: `Changed ${changed.join(', ')}`,
    });

    await campaign.save();
    return ok(res, campaign.toRow(await progressWithGoal(campaign)), {
      message: 'Appeal updated',
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not update the appeal');
  }
};

/**
 * PATCH /api/giving/campaigns/:id/status
 */
exports.setCampaignStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, note } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid campaign id');
    if (!Campaign.STATUSES.includes(status)) return fail(res, 400, 'Invalid status');

    const campaign = await Campaign.findById(id);
    if (!campaign) return fail(res, 404, 'Appeal not found');
    if (campaign.status === status) return fail(res, 400, `This appeal is already ${status}`);

    // Cancelling an appeal that has taken money is not a status change, it is a
    // refund conversation.
    if (status === 'cancelled') {
      const progress = await campaignProgress(campaign._id);
      if (progress.amountReceived > 0) {
        return fail(
          res,
          409,
          `${progress.amountReceived} has already been received against this appeal. Close it rather than cancelling it — the receipts issued are real.`
        );
      }
    }

    const previous = campaign.status;
    campaign.status = status;

    campaign.recordHistory({
      action: 'status-changed',
      from: previous,
      to: status,
      by: req.user._id,
      note,
    });

    await campaign.save();
    return ok(res, campaign.toRow(await progressWithGoal(campaign)), {
      message: `Appeal ${status}`,
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not change the appeal status');
  }
};

/**
 * GET /api/giving/campaigns
 */
exports.listCampaigns = async (req, res) => {
  try {
    const query = {};
    if (!isStaff(req.user)) {
      query.visibility = 'public';
      query.status = { $nin: ['draft', 'cancelled'] };
    }
    if (req.query.category && Campaign.CATEGORIES.includes(req.query.category)) {
      query.category = req.query.category;
    }

    const campaigns = await Campaign.find(query).sort({ startsOn: -1 }).limit(100);
    const now = new Date();

    const rows = [];
    for (const campaign of campaigns) {
      rows.push(campaign.toRow(await progressWithGoal(campaign), now));
    }

    return ok(res, rows, { count: rows.length });
  } catch (error) {
    return serverError(res, error, 'Could not load appeals');
  }
};

/**
 * GET /api/giving/campaigns/:id
 */
exports.getCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid campaign id');

    const campaign = await Campaign.findById(id);
    if (!campaign) return fail(res, 404, 'Appeal not found');

    if (!isStaff(req.user) && (campaign.visibility !== 'public' || campaign.status === 'draft')) {
      return fail(res, 404, 'Appeal not found');
    }

    return ok(res, campaign.toRow(await progressWithGoal(campaign)));
  } catch (error) {
    return serverError(res, error, 'Could not load the appeal');
  }
};

/**
 * GET /api/giving/campaigns/:id/leaderboard
 *
 * Anonymised by the same serializer as everywhere else. An anonymous donor's
 * amount still counts toward the appeal; their name does not appear.
 */
exports.getLeaderboard = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid campaign id');

    const campaign = await Campaign.findById(id);
    if (!campaign) return fail(res, 404, 'Appeal not found');

    const pledges = await Pledge.find({
      campaign: campaign._id,
      status: { $nin: ['cancelled'] },
      amountReceived: { $gt: 0 },
    })
      .sort({ amountReceived: -1 })
      .limit(50);

    const rows = pledges.map((pledge) => {
      const row = pledge.toRowFor(req.user);
      return {
        donorName: pledge.isAnonymous && !isAdmin(req.user) ? 'Anonymous' : row.donorName,
        donorType: pledge.donorType,
        amountReceived: pledge.amountReceived,
        isAnonymous: pledge.isAnonymous,
      };
    });

    return ok(res, rows, { count: rows.length });
  } catch (error) {
    return serverError(res, error, 'Could not load the leaderboard');
  }
};

// ---------------------------------------------------------------------------
// Pledges
// ---------------------------------------------------------------------------

/**
 * POST /api/giving/pledges
 *
 * The instalment schedule is generated server-side, so the donor sees ten
 * dates and ten amounts before committing rather than agreeing to a total.
 */
exports.createPledge = async (req, res) => {
  try {
    const {
      campaignId,
      amount,
      schedule,
      startsOn,
      donorName,
      donorEmail,
      donorType,
      isAnonymous,
      note,
    } = req.body;

    if (!isValidId(campaignId)) return fail(res, 400, 'Invalid campaign id');

    const campaign = await Campaign.findById(campaignId);
    if (!campaign) return fail(res, 404, 'Appeal not found');

    const blocked = campaign.pledgeBlockedReason();
    if (blocked) return fail(res, 409, blocked);

    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return fail(res, 400, 'Enter a pledge amount');

    const scheduleKey = Pledge.SCHEDULES.includes(schedule) ? schedule : 'one-off';

    const starts = parseDate(startsOn, 'Start date');
    if (starts.error) return fail(res, 400, starts.error);
    const start = starts.value || new Date();

    // An admin may record a pledge for an external donor; anybody else pledges
    // as themselves, read off the session rather than the body.
    const external = isAdmin(req.user) && donorName && !req.body.asSelf;

    const pledge = new Pledge({
      campaign: campaign._id,
      donor: external ? undefined : req.user._id,
      donorName: external ? donorName : req.user.name,
      donorEmail: external ? donorEmail : req.user.email,
      donorType: Pledge.DONOR_TYPES.includes(donorType) ? donorType : 'well-wisher',
      isAnonymous: Boolean(isAnonymous),
      amount: round2(value),
      schedule: scheduleKey,
      startsOn: start,
      instalments: Pledge.buildSchedule(round2(value), scheduleKey, start),
      note,
      status: 'pledged',
    });

    pledge.recordHistory({
      action: 'pledged',
      to: String(pledge.amount),
      by: req.user._id,
      note: `${scheduleKey}, ${pledge.instalments.length} instalment(s)`,
    });

    await pledge.save();

    return res.status(201).json({
      success: true,
      message: `Thank you. ${pledge.instalments.length} instalment${
        pledge.instalments.length === 1 ? '' : 's'
      } scheduled.`,
      data: pledge.toDetailFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not record the pledge');
  }
};

/**
 * GET /api/giving/pledges/mine
 */
exports.getMyPledges = async (req, res) => {
  try {
    const pledges = await Pledge.find({ donor: req.user._id })
      .populate('campaign', 'title slug category currency')
      .sort({ createdAt: -1 })
      .limit(100);

    const now = new Date();
    const rows = pledges.map((pledge) => ({
      ...pledge.toDetailFor(req.user, now),
      campaignTitle: pledge.campaign ? pledge.campaign.title : null,
    }));

    return ok(res, rows, {
      count: rows.length,
      totalGiven: round2(rows.reduce((sum, row) => sum + row.amountReceived, 0)),
      totalOutstanding: round2(rows.reduce((sum, row) => sum + row.amountOutstanding, 0)),
    });
  } catch (error) {
    return serverError(res, error, 'Could not load your giving');
  }
};

/**
 * GET /api/giving/pledges/overdue
 *
 * The chase list. Derived from `dueOn` on every read, which is why it exists at
 * all — nothing stores an `isOverdue` flag that would be wrong every midnight.
 */
exports.getOverduePledges = async (req, res) => {
  try {
    const now = new Date();

    const pledges = await Pledge.find({
      status: { $in: ['pledged', 'partially-fulfilled'] },
      instalments: {
        $elemMatch: { status: { $in: ['due', 'part-paid'] }, dueOn: { $lt: now } },
      },
    })
      .populate('campaign', 'title currency')
      .limit(300);

    const rows = pledges
      .map((pledge) => {
        const row = pledge.toRowFor(req.user, now);
        const overdue = pledge.overdueInstalments(now);
        return {
          ...row,
          campaignTitle: pledge.campaign ? pledge.campaign.title : null,
          oldestDueOn: overdue.length
            ? overdue.reduce(
                (oldest, { instalment }) =>
                  !oldest || instalment.dueOn < oldest ? instalment.dueOn : oldest,
                null
              )
            : null,
          daysOverdue: overdue.length
            ? Math.floor(
                (now -
                  overdue.reduce(
                    (oldest, { instalment }) =>
                      !oldest || instalment.dueOn < oldest ? instalment.dueOn : oldest,
                    null
                  )) /
                  86400000
              )
            : 0,
        };
      })
      .filter((row) => row.overdueCount > 0)
      .sort((a, b) => b.daysOverdue - a.daysOverdue);

    return ok(res, rows, {
      count: rows.length,
      totalOverdue: round2(rows.reduce((sum, row) => sum + row.overdueAmount, 0)),
    });
  } catch (error) {
    return serverError(res, error, 'Could not load the chase list');
  }
};

/**
 * GET /api/giving/pledges
 */
exports.listPledges = async (req, res) => {
  try {
    const { campaignId, status, donorType } = req.query;
    const query = {};

    if (campaignId && isValidId(campaignId)) query.campaign = campaignId;
    if (status && Pledge.STATUSES.includes(status)) query.status = status;
    if (donorType && Pledge.DONOR_TYPES.includes(donorType)) query.donorType = donorType;

    const pledges = await Pledge.find(query)
      .populate('campaign', 'title currency')
      .sort({ createdAt: -1 })
      .limit(300);

    const now = new Date();
    const rows = pledges.map((pledge) => ({
      ...pledge.toRowFor(req.user, now),
      campaignTitle: pledge.campaign ? pledge.campaign.title : null,
    }));

    return ok(res, rows, { count: rows.length });
  } catch (error) {
    return serverError(res, error, 'Could not load pledges');
  }
};

/**
 * GET /api/giving/pledges/:id
 */
exports.getPledge = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid pledge id');

    const pledge = await Pledge.findById(id).populate('campaign', 'title currency receiptPrefix');
    if (!pledge) return fail(res, 404, 'Pledge not found');

    if (!isAdmin(req.user) && !pledge.isOwnedBy(req.user)) {
      return fail(res, 403, 'This pledge is not yours to read');
    }

    return ok(res, {
      ...pledge.toDetailFor(req.user),
      campaignTitle: pledge.campaign ? pledge.campaign.title : null,
    });
  } catch (error) {
    return serverError(res, error, 'Could not load the pledge');
  }
};

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/**
 * POST /api/giving/pledges/:id/payments
 *
 * Idempotent on `reference`. The repeat is a 200 carrying the original payment
 * and its original serial, not a 409 — the caller retrying a timed-out request
 * wants to know the payment landed, and telling them it is a conflict sends
 * somebody to look for a problem that does not exist.
 */
exports.recordPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { reference, amount, method, receivedOn, instalmentIndex, note } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid pledge id');
    if (!reference || String(reference).trim().length < 3) {
      return fail(
        res,
        400,
        'A payment reference is required — it is what makes recording the same payment twice harmless'
      );
    }

    const pledge = await Pledge.findById(id);
    if (!pledge) return fail(res, 404, 'Pledge not found');

    // The idempotency check, before anything is written.
    const existing = pledge.paymentByReference(reference);
    if (existing) {
      return ok(res, pledge.toDetailFor(req.user), {
        message: `Reference ${existing.reference} was already recorded on ${new Date(
          existing.receivedOn
        )
          .toISOString()
          .slice(0, 10)}. Nothing has changed.`,
        idempotent: true,
        receiptSerial: existing.receiptSerial,
      });
    }

    if (pledge.status === 'cancelled') {
      return fail(res, 409, 'This pledge was cancelled');
    }

    const value = round2(amount);
    if (!Number.isFinite(value) || value <= 0) return fail(res, 400, 'Enter a payment amount');

    if (value > pledge.amountOutstanding + 0.01) {
      return fail(
        res,
        400,
        `That is more than the ${pledge.amountOutstanding} still outstanding on this pledge`
      );
    }

    const received = parseDate(receivedOn, 'Received date');
    if (received.error) return fail(res, 400, received.error);

    const preferred =
      instalmentIndex === undefined || instalmentIndex === null || instalmentIndex === ''
        ? undefined
        : Number(instalmentIndex);

    const applied = pledge.applyToInstalments(value, preferred);

    // The serial is issued only once the payment is going to be recorded, so a
    // rejected request does not burn a number and leave a gap in the book.
    const serial = await Campaign.nextReceiptSerial(
      pledge.campaign,
      financialYearFor(received.value || new Date())
    );

    pledge.payments.push({
      reference: String(reference).trim(),
      amount: value,
      method: Pledge.METHODS.includes(method) ? method : 'bank-transfer',
      receivedOn: received.value || new Date(),
      recordedBy: req.user._id,
      instalmentIndex: applied.touched[0],
      receiptSerial: serial,
      note,
    });

    pledge.recordHistory({
      action: 'payment',
      to: String(value),
      by: req.user._id,
      note: `${reference} · receipt ${serial}`,
    });

    await pledge.save();

    return res.status(201).json({
      success: true,
      message: `Payment recorded. Receipt ${serial}.`,
      receiptSerial: serial,
      unallocated: applied.unallocated,
      data: pledge.toDetailFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not record the payment');
  }
};

/**
 * GET /api/giving/pledges/:id/receipt/:serial
 */
exports.getReceipt = async (req, res) => {
  try {
    const { id, serial } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid pledge id');

    const pledge = await Pledge.findById(id).populate('campaign', 'title purpose currency');
    if (!pledge) return fail(res, 404, 'Pledge not found');

    if (!isAdmin(req.user) && !pledge.isOwnedBy(req.user)) {
      return fail(res, 403, 'This receipt is not yours to read');
    }

    const payment = (pledge.payments || []).find(
      (entry) => entry.receiptSerial === decodeURIComponent(serial)
    );
    if (!payment) return fail(res, 404, 'Receipt not found');

    return ok(res, {
      receiptSerial: payment.receiptSerial,
      // The donor's real name, even on an anonymous pledge. Anonymity is about
      // the public page; a receipt with "Anonymous" on it is not a receipt.
      donorName: pledge.donorName,
      donorEmail: pledge.donorEmail,
      campaignTitle: pledge.campaign ? pledge.campaign.title : null,
      purpose: pledge.campaign ? pledge.campaign.purpose : null,
      amount: payment.amount,
      currency: pledge.campaign ? pledge.campaign.currency : 'INR',
      method: payment.method,
      receivedOn: payment.receivedOn,
      reference: payment.reference,
    });
  } catch (error) {
    return serverError(res, error, 'Could not load the receipt');
  }
};

/**
 * PATCH /api/giving/pledges/:id/instalments/:idx/waive
 */
exports.waiveInstalment = async (req, res) => {
  try {
    const { id, idx } = req.params;
    const { reason } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid pledge id');
    if (!reason || String(reason).trim().length < 5) {
      return fail(res, 400, 'Say why this instalment is being waived — it stays on the record');
    }

    const pledge = await Pledge.findById(id);
    if (!pledge) return fail(res, 404, 'Pledge not found');

    const index = Number(idx);
    const instalment = pledge.instalments[index];
    if (!instalment) return fail(res, 404, 'Instalment not found');
    if (instalment.status === 'paid') return fail(res, 409, 'That instalment is already paid');
    if (instalment.status === 'waived') return fail(res, 409, 'That instalment is already waived');

    instalment.status = 'waived';
    instalment.waivedReason = reason;
    instalment.waivedBy = req.user._id;
    instalment.waivedAt = new Date();

    pledge.recordHistory({
      action: 'waived',
      to: String(instalment.amount),
      by: req.user._id,
      note: reason,
    });

    await pledge.save();
    return ok(res, pledge.toDetailFor(req.user), { message: 'Instalment waived' });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not waive the instalment');
  }
};

/**
 * PATCH /api/giving/pledges/:id/cancel
 *
 * A pledge that has received money lapses rather than cancelling. Deleting the
 * row deletes the receipt, and the receipt is the thing somebody claimed tax
 * relief on.
 */
exports.cancelPledge = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid pledge id');

    const pledge = await Pledge.findById(id);
    if (!pledge) return fail(res, 404, 'Pledge not found');

    if (!isAdmin(req.user) && !pledge.isOwnedBy(req.user)) {
      return fail(res, 403, 'This pledge is not yours to cancel');
    }
    if (pledge.status === 'cancelled' || pledge.status === 'lapsed') {
      return fail(res, 409, `This pledge is already ${pledge.status}`);
    }

    const previous = pledge.status;
    const lapsing = pledge.amountReceived > 0;

    pledge.status = lapsing ? 'lapsed' : 'cancelled';
    pledge.cancellationReason = reason;

    pledge.recordHistory({
      action: lapsing ? 'lapsed' : 'cancelled',
      from: previous,
      to: pledge.status,
      by: req.user._id,
      note: reason,
    });

    await pledge.save();

    return ok(res, pledge.toDetailFor(req.user), {
      message: lapsing
        ? `This pledge has lapsed. The ${pledge.amountReceived} already received stays on the record, along with its receipts.`
        : 'Pledge cancelled',
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not cancel the pledge');
  }
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * GET /api/giving/stats
 */
exports.getStats = async (req, res) => {
  try {
    const campaigns = await Campaign.find({}).limit(200);
    const now = new Date();

    let pledged = 0;
    let received = 0;
    const rows = [];

    for (const campaign of campaigns) {
      const progress = await progressWithGoal(campaign);
      pledged += progress.amountPledged;
      received += progress.amountReceived;
      rows.push({
        _id: campaign._id,
        title: campaign.title,
        category: campaign.category,
        status: campaign.status,
        goalAmount: campaign.goalAmount,
        ...progress,
      });
    }

    const overdue = await Pledge.find({
      status: { $in: ['pledged', 'partially-fulfilled'] },
      instalments: {
        $elemMatch: { status: { $in: ['due', 'part-paid'] }, dueOn: { $lt: now } },
      },
    }).countDocuments();

    return ok(res, {
      campaignCount: campaigns.length,
      // Kept apart at every level, including the summary. One number here is
      // how the school ends up planning against money that has not arrived.
      totalPledged: round2(pledged),
      totalReceived: round2(received),
      totalOutstanding: round2(pledged - received),
      overduePledges: overdue,
      campaigns: rows.sort((a, b) => b.amountReceived - a.amountReceived),
    });
  } catch (error) {
    return serverError(res, error, 'Could not compute giving statistics');
  }
};

exports.campaignProgress = campaignProgress;
exports.financialYearFor = financialYearFor;
