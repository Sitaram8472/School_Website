const mongoose = require('mongoose');
const Pledge = require('../models/Pledge');
const Campaign = require('../models/Campaign');
const { MatchingGiftProgramme, MatchingGiftClaim } = require('../models/MatchingGift');

/**
 * Employer matching gifts.
 *
 * Three things here are the module.
 *
 * A claim is raised against a *payment that arrived*, found through
 * `Pledge.paymentByReference`. If that lookup returns nothing there is no gift,
 * and `giftAmount` is copied from the ledger rather than accepted from the
 * request body — a claim whose stated gift disagrees with the pledge is
 * unanswerable the moment the employer queries it.
 *
 * `MatchingGiftClaim.claimableFor` derives the ceiling on every request from
 * the claims themselves, and `recordReceipt` derives it *again* before the money
 * is booked. An employer's budget can be consumed by other claims while this one
 * sits with their payroll department, and finding that out at reconciliation is
 * finding it out too late.
 *
 * Matched money is reported beside donated money and never inside it.
 * `campaignMatchSummary` returns `matchedReceived` and `matchPending` as
 * separate figures, and the leaderboard is left alone entirely, so a donor is
 * credited with their gift and not with their employer's.
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

function created(res, data, extra = {}) {
  return res.status(201).json({ success: true, data, ...extra });
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
  if (error.name === 'ValidatorError' || error.name === 'CastError') {
    return error.message;
  }
  if (error.code === 11000) {
    if (String(error.message).includes('one_claim_per_gift')) {
      return 'That gift has already been claimed for matching';
    }
    if (String(error.message).includes('receipt_reference_unique')) {
      return 'That receipt reference has already been recorded against another claim';
    }
    if (String(error.message).includes('slug')) {
      return 'A matching programme already exists for that employer';
    }
    return 'That record already exists';
  }
  return null;
}

function isAdmin(user) {
  return user && user.role === 'admin';
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function parseDate(value, fieldLabel) {
  if (value === undefined || value === null || value === '') return { value: undefined };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { error: `${fieldLabel} is not a valid date` };
  return { value: date };
}

function formatDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/**
 * A claim as one row of a queue.
 *
 * The decline note and the payroll id are omitted for anyone who is not an
 * admin or the donor: the first can name an employer's internal policy and the
 * second is an employment identifier.
 */
function claimRow(claim, viewer) {
  const privileged = isAdmin(viewer) || claim.isOwnedBy(viewer);

  const row = {
    _id: claim._id,
    programme: claim.programme,
    employerName: claim.employerName,
    pledge: claim.pledge,
    paymentReference: claim.paymentReference,
    campaign: claim.campaign,
    donorName: claim.donorName,
    giftAmount: claim.giftAmount,
    giftReceivedOn: claim.giftReceivedOn,
    claimedAmount: claim.claimedAmount,
    currency: claim.currency,
    status: claim.status,
    submittedAt: claim.submittedAt,
    verifiedAt: claim.verifiedAt,
    receivedAt: claim.receivedAt,
    declinedAt: claim.declinedAt,
    declineReason: claim.declineReason,
    withdrawnAt: claim.withdrawnAt,
    createdAt: claim.createdAt,
    isEncumbering: claim.isEncumbering,
  };

  if (privileged) {
    row.payrollId = claim.payrollId;
    row.declineNote = claim.declineNote;
    row.verificationNote = claim.verificationNote;
    row.receiptReference = claim.receiptReference;
  }

  return row;
}

function claimDetail(claim, viewer) {
  return {
    ...claimRow(claim, viewer),
    donor: claim.donor,
    submittedBy: claim.submittedBy,
    verifiedBy: claim.verifiedBy,
    declinedBy: claim.declinedBy,
    receivedBy: claim.receivedBy,
    withdrawalNote: claim.withdrawalNote,
    history: isAdmin(viewer) || claim.isOwnedBy(viewer) ? claim.history : undefined,
  };
}

/**
 * Find the gift a claim is being raised against.
 *
 * Returns the pledge and the payment, or a reason the pair does not identify a
 * gift. The reason is a sentence rather than a code because it is shown to
 * whoever is filling the form in.
 */
async function resolveGift(pledgeId, paymentReference) {
  if (!isValidId(pledgeId)) {
    return { error: 'That pledge id is not valid' };
  }

  const pledge = await Pledge.findById(pledgeId);
  if (!pledge) {
    return { error: 'That pledge does not exist' };
  }

  const payment = pledge.paymentByReference(paymentReference);
  if (!payment) {
    return {
      error:
        'No payment with that reference has been recorded against this pledge. ' +
        'A matching claim can only be raised against money that has actually arrived.',
    };
  }

  return { pledge, payment };
}

/* ------------------------------------------------------------------------- *
 * Programmes
 * ------------------------------------------------------------------------- */

exports.getMatchingMeta = async (req, res) => {
  try {
    return ok(res, {
      claimStatuses: MatchingGiftClaim.STATUSES,
      declineReasons: MatchingGiftClaim.DECLINE_REASONS,
      encumberingStatuses: MatchingGiftClaim.ENCUMBERING_STATUSES,
      programmeStatuses: MatchingGiftProgramme.STATUSES,
    });
  } catch (error) {
    return serverError(res, error, 'Could not load matching gift metadata');
  }
};

exports.createProgramme = async (req, res) => {
  try {
    const {
      employerName,
      contactName,
      contactEmail,
      matchRatio,
      perDonorAnnualCap,
      programmeBudget,
      claimWindowDays,
      startsOn,
      endsOn,
      requiresPayrollId,
      requiresReceiptCopy,
      notes,
    } = req.body;

    const start = parseDate(startsOn, 'Start date');
    if (start.error) return fail(res, 400, start.error);

    const end = parseDate(endsOn, 'End date');
    if (end.error) return fail(res, 400, end.error);

    const programme = new MatchingGiftProgramme({
      employerName,
      contactName,
      contactEmail,
      matchRatio,
      perDonorAnnualCap,
      programmeBudget:
        programmeBudget === undefined || programmeBudget === null || programmeBudget === ''
          ? null
          : programmeBudget,
      claimWindowDays,
      startsOn: start.value || new Date(),
      endsOn: end.value || null,
      requiresPayrollId: Boolean(requiresPayrollId),
      requiresReceiptCopy: requiresReceiptCopy === undefined ? true : Boolean(requiresReceiptCopy),
      notes,
    });

    programme.recordHistory({
      action: 'created',
      by: req.user._id,
      byName: req.user.name,
    });

    await programme.save();

    return created(res, programme);
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not create the matching programme');
  }
};

exports.updateProgramme = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'That programme id is not valid');

    const programme = await MatchingGiftProgramme.findById(id);
    if (!programme) return fail(res, 404, 'That matching programme does not exist');

    const editable = [
      'contactName',
      'contactEmail',
      'perDonorAnnualCap',
      'programmeBudget',
      'claimWindowDays',
      'endsOn',
      'requiresPayrollId',
      'requiresReceiptCopy',
      'notes',
    ];

    // `matchRatio` is deliberately not editable. Claims already lodged were
    // computed against the old ratio, and changing it under them would leave
    // the school asking an employer for a figure its own arithmetic no longer
    // reproduces. A changed ratio is a new programme.
    if (req.body.matchRatio !== undefined && Number(req.body.matchRatio) !== programme.matchRatio) {
      return fail(
        res,
        400,
        'The match ratio cannot be changed on a live programme, because claims have ' +
          'already been calculated against it. Close this programme and open another.'
      );
    }

    editable.forEach((field) => {
      if (req.body[field] !== undefined) {
        programme[field] = req.body[field] === '' ? null : req.body[field];
      }
    });

    programme.recordHistory({
      action: 'updated',
      by: req.user._id,
      byName: req.user.name,
    });

    await programme.save();

    return ok(res, programme);
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not update the matching programme');
  }
};

exports.setProgrammeStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, note } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'That programme id is not valid');
    if (!MatchingGiftProgramme.STATUSES.includes(status)) {
      return fail(res, 400, 'Invalid programme status');
    }

    const programme = await MatchingGiftProgramme.findById(id);
    if (!programme) return fail(res, 404, 'That matching programme does not exist');

    const from = programme.status;
    if (from === status) return ok(res, programme);

    programme.status = status;
    programme.recordHistory({
      action: 'status-changed',
      from,
      to: status,
      note,
      by: req.user._id,
      byName: req.user.name,
    });

    await programme.save();

    return ok(res, programme);
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not change the programme status');
  }
};

exports.listProgrammes = async (req, res) => {
  try {
    const { status, q } = req.query;

    const filter = {};
    if (status && MatchingGiftProgramme.STATUSES.includes(status)) filter.status = status;
    if (q) filter.employerName = { $regex: String(q).trim(), $options: 'i' };

    // A non-admin is choosing an employer from a list, so only the programmes
    // they could actually claim under are worth showing.
    if (!isAdmin(req.user)) filter.status = 'active';

    const programmes = await MatchingGiftProgramme.find(filter)
      .sort({ employerName: 1 })
      .limit(200)
      .lean();

    if (!isAdmin(req.user)) {
      return ok(
        res,
        programmes.map((programme) => ({
          _id: programme._id,
          employerName: programme.employerName,
          slug: programme.slug,
          matchRatio: programme.matchRatio,
          perDonorAnnualCap: programme.perDonorAnnualCap,
          claimWindowDays: programme.claimWindowDays,
          requiresPayrollId: programme.requiresPayrollId,
          requiresReceiptCopy: programme.requiresReceiptCopy,
        }))
      );
    }

    // The remaining budget is the number an admin is actually deciding on, so
    // it is resolved per programme rather than left to the panel to work out.
    const withRemaining = await Promise.all(
      programmes.map(async (programme) => {
        const encumbered = await MatchingGiftClaim.encumberedForProgramme(programme._id);
        return {
          ...programme,
          programmeEncumbered: round2(encumbered),
          programmeRemaining:
            programme.programmeBudget === null || programme.programmeBudget === undefined
              ? null
              : round2(Math.max(0, programme.programmeBudget - encumbered)),
        };
      })
    );

    return ok(res, withRemaining);
  } catch (error) {
    return serverError(res, error, 'Could not load the matching programmes');
  }
};

/* ------------------------------------------------------------------------- *
 * The ceiling
 * ------------------------------------------------------------------------- */

/**
 * What this gift could still be matched for, before an amount is typed.
 *
 * The panel calls this as the form opens. Showing the ceiling first, with the
 * limit that bound it named, is the difference between a form that guides and a
 * form that rejects.
 */
exports.getClaimable = async (req, res) => {
  try {
    const { pledgeId, reference, programmeId } = req.query;

    if (!isValidId(programmeId)) return fail(res, 400, 'That programme id is not valid');

    const programme = await MatchingGiftProgramme.findById(programmeId);
    if (!programme) return fail(res, 404, 'That matching programme does not exist');

    const gift = await resolveGift(pledgeId, reference);
    if (gift.error) return fail(res, 400, gift.error);

    const { pledge, payment } = gift;

    if (!isAdmin(req.user) && !pledge.isOwnedBy(req.user)) {
      return fail(res, 403, 'You can only raise a matching claim against your own gift');
    }

    const blocked = programme.blockedReason();
    const closesOn = MatchingGiftClaim.claimWindowClosesOn(
      payment.receivedOn,
      programme.claimWindowDays
    );

    const ceiling = await MatchingGiftClaim.claimableFor({
      programme,
      giftAmount: payment.amount,
      giftReceivedOn: payment.receivedOn,
      donorId: pledge.donor,
    });

    const existing = await MatchingGiftClaim.findOne({
      pledge: pledge._id,
      paymentReference: payment.reference,
    }).lean();

    return ok(res, {
      ...ceiling,
      giftAmount: payment.amount,
      giftReceivedOn: payment.receivedOn,
      donorName: pledge.donorName,
      employerName: programme.employerName,
      claimWindowClosesOn: closesOn,
      claimWindowOpen: closesOn >= new Date(),
      programmeBlockedReason: blocked,
      alreadyClaimed: existing ? { _id: existing._id, status: existing.status } : null,
    });
  } catch (error) {
    return serverError(res, error, 'Could not work out the claimable amount');
  }
};

/* ------------------------------------------------------------------------- *
 * Claims
 * ------------------------------------------------------------------------- */

exports.createClaim = async (req, res) => {
  try {
    const { programmeId, pledgeId, reference, claimedAmount, payrollId, submit } = req.body;

    if (!isValidId(programmeId)) return fail(res, 400, 'That programme id is not valid');

    const programme = await MatchingGiftProgramme.findById(programmeId);
    if (!programme) return fail(res, 404, 'That matching programme does not exist');

    const blocked = programme.blockedReason();
    if (blocked) return fail(res, 400, blocked);

    const gift = await resolveGift(pledgeId, reference);
    if (gift.error) return fail(res, 400, gift.error);

    const { pledge, payment } = gift;

    if (!isAdmin(req.user) && !pledge.isOwnedBy(req.user)) {
      return fail(res, 403, 'You can only raise a matching claim against your own gift');
    }

    // The claim window is measured from the day the money arrived, because that
    // is the day the employer counts from.
    const closesOn = MatchingGiftClaim.claimWindowClosesOn(
      payment.receivedOn,
      programme.claimWindowDays
    );

    if (closesOn < new Date()) {
      return fail(
        res,
        400,
        `${programme.employerName} accepts matching claims for ${programme.claimWindowDays} days ` +
          `after the gift. This gift arrived on ${formatDay(payment.receivedOn)}, so the window ` +
          `closed on ${formatDay(closesOn)}.`
      );
    }

    if (programme.requiresPayrollId && !String(payrollId || '').trim()) {
      return fail(res, 400, `${programme.employerName} requires the donor's payroll id`);
    }

    const ceiling = await MatchingGiftClaim.claimableFor({
      programme,
      giftAmount: payment.amount,
      giftReceivedOn: payment.receivedOn,
      donorId: pledge.donor,
    });

    if (ceiling.claimable <= 0) {
      return fail(
        res,
        400,
        ceiling.boundBy === 'donor-cap'
          ? `This donor has already used their ${programme.employerName} annual cap`
          : `${programme.employerName} has no matching budget left`
      );
    }

    const requested =
      claimedAmount === undefined || claimedAmount === null || claimedAmount === ''
        ? ceiling.claimable
        : round2(claimedAmount);

    if (!(requested > 0)) return fail(res, 400, 'A claimed amount must be greater than zero');

    if (requested > ceiling.claimable) {
      return fail(res, 400, `The most that can be claimed against this gift is ${ceiling.claimable}`, {
        ceiling,
      });
    }

    const claim = new MatchingGiftClaim({
      programme: programme._id,
      employerName: programme.employerName,
      pledge: pledge._id,
      paymentReference: payment.reference,
      campaign: pledge.campaign,
      donor: pledge.donor,
      donorName: pledge.donorName,
      giftAmount: payment.amount,
      giftReceivedOn: payment.receivedOn,
      claimedAmount: requested,
      payrollId: String(payrollId || '').trim(),
      status: 'draft',
    });

    claim.recordHistory({
      action: 'created',
      to: 'draft',
      by: req.user._id,
      byName: req.user.name,
    });

    // Submitting on creation is the common path, and making it two requests
    // leaves drafts nobody ever finishes.
    if (submit) claim.submit(req.user);

    await claim.save();

    return created(res, claimDetail(claim, req.user), { ceiling });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not create the matching claim');
  }
};

exports.submitClaim = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'That claim id is not valid');

    const claim = await MatchingGiftClaim.findById(id);
    if (!claim) return fail(res, 404, 'That matching claim does not exist');

    if (!isAdmin(req.user) && !claim.isOwnedBy(req.user)) {
      return fail(res, 403, 'You can only submit your own matching claim');
    }

    claim.submit(req.user);
    await claim.save();

    return ok(res, claimDetail(claim, req.user));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

exports.verifyClaim = async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'That claim id is not valid');

    const claim = await MatchingGiftClaim.findById(id);
    if (!claim) return fail(res, 404, 'That matching claim does not exist');

    claim.verify(req.user, note);
    await claim.save();

    return ok(res, claimDetail(claim, req.user));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

exports.declineClaim = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, note } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'That claim id is not valid');

    const claim = await MatchingGiftClaim.findById(id);
    if (!claim) return fail(res, 404, 'That matching claim does not exist');

    claim.decline(req.user, reason, note);
    await claim.save();

    return ok(res, claimDetail(claim, req.user));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

exports.withdrawClaim = async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'That claim id is not valid');

    const claim = await MatchingGiftClaim.findById(id);
    if (!claim) return fail(res, 404, 'That matching claim does not exist');

    if (!isAdmin(req.user) && !claim.isOwnedBy(req.user)) {
      return fail(res, 403, 'You can only withdraw your own matching claim');
    }

    claim.withdraw(req.user, note);
    await claim.save();

    return ok(res, claimDetail(claim, req.user));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

/**
 * The employer has paid.
 *
 * Idempotent on `receiptReference`, and the ceiling is derived a second time
 * here rather than trusted from when the claim was raised. Between submission
 * and payment, other claims may have consumed the programme's budget, and
 * booking money the employer will not actually send is the error that survives
 * until somebody reconciles a bank statement.
 */
exports.recordReceipt = async (req, res) => {
  try {
    const { id } = req.params;
    const { receiptReference } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'That claim id is not valid');
    if (!String(receiptReference || '').trim()) {
      return fail(res, 400, 'A receipt reference is required');
    }

    const claim = await MatchingGiftClaim.findById(id);
    if (!claim) return fail(res, 404, 'That matching claim does not exist');

    // The retry path. A repeat of the same reference returns the claim as it
    // already stands and moves no total.
    if (
      claim.status === 'received' &&
      claim.receiptReference === String(receiptReference).trim()
    ) {
      return ok(res, claimDetail(claim, req.user), { idempotent: true });
    }

    const programme = await MatchingGiftProgramme.findById(claim.programme);
    if (!programme) return fail(res, 404, 'That matching programme no longer exists');

    // Excluding this claim, because its own encumbrance is not competition for
    // the budget it is about to spend.
    const ceiling = await MatchingGiftClaim.claimableFor({
      programme,
      giftAmount: claim.giftAmount,
      giftReceivedOn: claim.giftReceivedOn,
      donorId: claim.donor,
      excludeClaimId: claim._id,
    });

    if (claim.claimedAmount > ceiling.claimable) {
      return fail(
        res,
        409,
        `This claim was raised for ${claim.claimedAmount} but only ${ceiling.claimable} is still ` +
          `available under the ${programme.employerName} programme. Other claims have been ` +
          'settled since it was submitted.',
        { ceiling }
      );
    }

    claim.markReceived(req.user, receiptReference);
    await claim.save();

    return ok(res, claimDetail(claim, req.user));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

exports.listClaims = async (req, res) => {
  try {
    const { status, programmeId, campaignId, page = 1, limit = 25 } = req.query;

    const filter = {};
    if (status && MatchingGiftClaim.STATUSES.includes(status)) filter.status = status;
    if (programmeId && isValidId(programmeId)) filter.programme = programmeId;
    if (campaignId && isValidId(campaignId)) filter.campaign = campaignId;

    const perPage = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * perPage;

    const [claims, total] = await Promise.all([
      MatchingGiftClaim.find(filter).sort({ createdAt: -1 }).skip(skip).limit(perPage),
      MatchingGiftClaim.countDocuments(filter),
    ]);

    return ok(
      res,
      claims.map((claim) => claimRow(claim, req.user)),
      { total, page: Number(page) || 1, limit: perPage }
    );
  } catch (error) {
    return serverError(res, error, 'Could not load the matching claims');
  }
};

exports.getMyClaims = async (req, res) => {
  try {
    const claims = await MatchingGiftClaim.find({ donor: req.user._id })
      .sort({ createdAt: -1 })
      .limit(100);

    return ok(
      res,
      claims.map((claim) => claimRow(claim, req.user))
    );
  } catch (error) {
    return serverError(res, error, 'Could not load your matching claims');
  }
};

exports.getClaim = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'That claim id is not valid');

    const claim = await MatchingGiftClaim.findById(id);
    if (!claim) return fail(res, 404, 'That matching claim does not exist');

    if (!isAdmin(req.user) && !claim.isOwnedBy(req.user)) {
      return fail(res, 403, 'You can only view your own matching claims');
    }

    return ok(res, claimDetail(claim, req.user));
  } catch (error) {
    return serverError(res, error, 'Could not load that matching claim');
  }
};

/**
 * What matching is worth to one campaign.
 *
 * Three numbers, never summed into one, and never added to the campaign's own
 * `amountReceived`. Money in the bank, money an employer has been asked for and
 * money an employer refused are three different degrees of certainty, and the
 * whole reason this module exists is that the school currently reports them as
 * the same figure.
 */
exports.getCampaignMatching = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'That campaign id is not valid');

    const campaign = await Campaign.findById(id).lean();
    if (!campaign) return fail(res, 404, 'That campaign does not exist');

    const summary = await MatchingGiftClaim.campaignMatchSummary(id);

    return ok(res, {
      campaign: { _id: campaign._id, title: campaign.title, goalAmount: campaign.goalAmount },
      ...summary,
    });
  } catch (error) {
    return serverError(res, error, 'Could not load the matching summary for that campaign');
  }
};
