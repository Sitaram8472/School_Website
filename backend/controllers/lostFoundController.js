const mongoose = require('mongoose');
const LostFoundItem = require('../models/LostFoundItem');

/**
 * Lost and found register.
 *
 * Registration and search are ordinary. The parts worth reading are
 * `approveClaim` — which delegates the single-approved-claim rule to the model
 * so a later route cannot approve around it — and the way every response goes
 * through `redactFor` so the register never publishes the answer to its own
 * test.
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
    return Object.values(error.errors).map((e) => e.message).join(' ');
  }
  if (error.name === 'ValidatorError' || error.name === 'CastError') {
    return error.message;
  }
  return null;
}

/**
 * A detached array subdocument throws its ValidatorError rather than returning
 * a ValidationError — uncaught, a too-short proof description becomes a 500.
 */
function validateSubdocument(doc) {
  try {
    return doc.validateSync() || null;
  } catch (error) {
    return error;
  }
}

function isStaff(user) {
  return ['teacher', 'staff', 'admin'].includes(user.role);
}

// ---------------------------------------------------------------------------
// Registering
// ---------------------------------------------------------------------------

/**
 * POST /api/lost-found
 *
 * Handles both directions: an item handed in (`found`) and a report that
 * something is missing (`lost`).
 */
exports.registerItem = async (req, res) => {
  try {
    const {
      kind,
      title,
      description,
      category,
      colour,
      brand,
      distinguishingMarks,
      location,
      occurredOn,
      storageLocation,
      isHighValue,
    } = req.body;

    const staff = isStaff(req.user);

    const item = new LostFoundItem({
      kind,
      title,
      description,
      category,
      colour,
      brand,
      // Only staff record the marks a claim is tested against. A student
      // handing something in describes it in `description`; letting them write
      // this field would let a would-be claimant plant their own answer.
      distinguishingMarks: staff ? distinguishingMarks : null,
      location,
      occurredOn,
      reportedBy: req.user._id,
      reportedByName: req.user.name,
      storageLocation: staff ? storageLocation : null,
      custodian: staff ? req.user._id : null,
      // Raises the evidence bar, so it is a staff decision.
      isHighValue: staff ? Boolean(isHighValue) : false,
      status: staff && kind === 'found' ? 'stored' : 'registered',
      // ticketId and retentionUntil are server-owned.
    });

    // Validate before burning a ticket number, so a rejected form does not
    // leave a hole in the numbering.
    const invalid = item.validateSync();
    if (invalid) return fail(res, 400, validationMessage(invalid));

    item.ticketId = await LostFoundItem.nextTicketId();
    item.recordAudit(`item:${kind}-registered`, req.user, item.category);
    await item.save();

    return res.status(201).json({
      success: true,
      message: `Registered as ${item.ticketId}.`,
      data: item.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to register the item');
  }
};

/**
 * GET /api/lost-found
 * The searchable register.
 */
exports.searchRegister = async (req, res) => {
  try {
    const { kind, category, status, search, mine } = req.query;

    const filter = {};
    if (kind) filter.kind = kind;
    if (category) filter.category = category;
    if (status) filter.status = status;
    else if (!isStaff(req.user)) {
      // A student browsing does not need to scroll past six months of disposed
      // gloves.
      filter.status = { $in: ['registered', 'stored', 'claim-pending', 'matched'] };
    }
    if (mine === 'true') filter.reportedBy = req.user._id;

    if (search) {
      const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(safe, 'i');
      filter.$or = [
        { ticketId: pattern },
        { title: pattern },
        { description: pattern },
        { colour: pattern },
        { brand: pattern },
        { location: pattern },
        // Deliberately NOT distinguishingMarks — a searchable secret is not a
        // secret. Matching on it would let a claimant confirm a guess without
        // ever filing a claim.
      ];
    }

    const items = await LostFoundItem.find(filter)
      .sort({ occurredOn: -1 })
      .limit(200);

    return res.status(200).json({
      success: true,
      count: items.length,
      data: items.map((item) => item.redactFor(req.user)),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to search the register');
  }
};

/**
 * GET /api/lost-found/:id
 */
exports.getItem = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid item id.');

    const item = await LostFoundItem.findById(req.params.id);
    if (!item) return fail(res, 404, 'Item not found.');

    return res.status(200).json({ success: true, data: item.redactFor(req.user) });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the item');
  }
};

/**
 * GET /api/lost-found/:id/matches
 *
 * Likely counterparts, scored. Advisory: it sorts the desk's work, it does not
 * approve anything.
 */
exports.getSuggestedMatches = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid item id.');

    const item = await LostFoundItem.findById(req.params.id);
    if (!item) return fail(res, 404, 'Item not found.');

    const opposite = item.kind === 'found' ? 'lost' : 'found';
    const candidates = await LostFoundItem.find({
      kind: opposite,
      status: { $in: ['registered', 'stored', 'claim-pending'] },
    }).limit(300);

    const scored = candidates
      .map((candidate) => {
        const [lostReport, foundItem] =
          item.kind === 'lost' ? [item, candidate] : [candidate, item];
        return {
          score: LostFoundItem.matchScore(lostReport, foundItem),
          item: candidate.redactFor(req.user),
        };
      })
      .filter((entry) => entry.score >= 30)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    return res.status(200).json({ success: true, count: scored.length, data: scored });
  } catch (error) {
    return serverError(res, error, 'Failed to compute matches');
  }
};

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/**
 * POST /api/lost-found/:id/claims
 */
exports.submitClaim = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid item id.');

    const { proofDescription, answeredMarks, className, contact } = req.body;

    const item = await LostFoundItem.findById(req.params.id);
    if (!item) return fail(res, 404, 'Item not found.');

    if (item.kind !== 'found') {
      return fail(res, 400, 'You can only claim an item that has been handed in.');
    }
    if (item.isClosed) {
      return fail(res, 409, `This item is ${item.status} and can no longer be claimed.`);
    }
    if (item.approvedClaim) {
      return fail(res, 409, 'A claim has already been approved for this item.');
    }
    if (item.openClaimFor(req.user._id)) {
      return fail(res, 409, 'You already have an open claim on this item.');
    }

    // High-value items get a second, specific question. Restating the public
    // listing back at the desk is not evidence.
    if (item.isHighValue && !(answeredMarks || '').trim()) {
      return fail(
        res,
        400,
        'This item needs more detail: describe any marks, damage or contents that are not in the listing.'
      );
    }

    const claim = item.claims.create({
      claimant: req.user._id,
      claimantName: req.user.name,
      className,
      contact,
      proofDescription,
      answeredMarks: answeredMarks || null,
      status: 'pending',
      at: new Date(),
    });

    const invalid = validateSubdocument(claim);
    if (invalid) {
      return fail(res, 400, validationMessage(invalid) || 'That claim is not valid.');
    }

    item.claims.push(claim);

    if (item.canTransition('claim-pending')) {
      item.moveTo('claim-pending', req.user, `claim by ${req.user.name}`);
    } else {
      item.recordAudit('claim:submitted', req.user, req.user.name);
    }

    await item.save();

    return res.status(201).json({
      success: true,
      message: 'Claim submitted. The office will compare it against what we hold.',
      data: item.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to submit the claim');
  }
};

/**
 * GET /api/lost-found/:id/claims  (staff)
 * Every claim on an item, with the marks alongside, for adjudication.
 */
exports.getClaims = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid item id.');

    const item = await LostFoundItem.findById(req.params.id);
    if (!item) return fail(res, 404, 'Item not found.');

    return res.status(200).json({
      success: true,
      count: item.claims.length,
      distinguishingMarks: item.distinguishingMarks,
      data: item.claims,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the claims');
  }
};

/**
 * PATCH /api/lost-found/:id/claims/:claimId/approve
 *
 * Approving one claim rejects the others in the same operation. The rule lives
 * in the model; this handler only turns its errors into status codes.
 */
exports.approveClaim = async (req, res) => {
  try {
    const { id, claimId } = req.params;
    if (!isValidId(id) || !isValidId(claimId)) {
      return fail(res, 400, 'Invalid item or claim id.');
    }

    const item = await LostFoundItem.findById(id);
    if (!item) return fail(res, 404, 'Item not found.');
    if (item.isClosed) {
      return fail(res, 409, `This item is ${item.status}.`);
    }

    let result;
    try {
      result = item.approveClaim(claimId, req.user, req.body.note);
    } catch (error) {
      if (['ALREADY_APPROVED', 'CLAIM_NOT_PENDING'].includes(error.code)) {
        return fail(res, 409, error.message);
      }
      if (error.code === 'CLAIM_NOT_FOUND') return fail(res, 404, error.message);
      throw error;
    }

    if (item.canTransition('matched')) {
      item.moveTo('matched', req.user, result.claim.claimantName || null);
    }

    await item.save();

    return res.status(200).json({
      success: true,
      message:
        result.displaced > 0
          ? `Claim approved; ${result.displaced} other claim(s) rejected.`
          : 'Claim approved.',
      data: item.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to approve the claim');
  }
};

/**
 * PATCH /api/lost-found/:id/claims/:claimId/reject
 */
exports.rejectClaim = async (req, res) => {
  try {
    const { id, claimId } = req.params;
    const { reason } = req.body;

    if (!isValidId(id) || !isValidId(claimId)) {
      return fail(res, 400, 'Invalid item or claim id.');
    }
    if (!reason || !reason.trim()) {
      return fail(res, 400, 'A reason is required.');
    }

    const item = await LostFoundItem.findById(id);
    if (!item) return fail(res, 404, 'Item not found.');

    const claim = item.claims.id(claimId);
    if (!claim) return fail(res, 404, 'That claim is not on this item.');
    if (claim.status !== 'pending') {
      return fail(res, 409, `That claim is already ${claim.status}.`);
    }

    claim.status = 'rejected';
    claim.reviewedBy = req.user._id;
    claim.reviewedByName = req.user.name;
    claim.reviewNote = reason.trim();
    claim.reviewedAt = new Date();

    item.recordAudit('claim:rejected', req.user, claim.claimantName || null);

    // Nothing left pending and nothing approved — the item goes back on the
    // shelf rather than sitting in `claim-pending` forever.
    if (item.pendingClaims.length === 0 && !item.approvedClaim && item.canTransition('stored')) {
      item.moveTo('stored', req.user, 'all claims rejected');
    }

    await item.save();

    return res.status(200).json({
      success: true,
      message: 'Claim rejected.',
      data: item.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to reject the claim');
  }
};

/**
 * PATCH /api/lost-found/:id/claims/:claimId/withdraw
 */
exports.withdrawClaim = async (req, res) => {
  try {
    const { id, claimId } = req.params;
    if (!isValidId(id) || !isValidId(claimId)) {
      return fail(res, 400, 'Invalid item or claim id.');
    }

    const item = await LostFoundItem.findById(id);
    if (!item) return fail(res, 404, 'Item not found.');

    const claim = item.claims.id(claimId);
    if (!claim) return fail(res, 404, 'That claim is not on this item.');
    if (String(claim.claimant) !== String(req.user._id)) {
      return fail(res, 403, 'You can only withdraw your own claim.');
    }
    if (claim.status !== 'pending') {
      return fail(res, 409, `That claim is already ${claim.status}.`);
    }

    claim.status = 'withdrawn';
    claim.reviewedAt = new Date();
    item.recordAudit('claim:withdrawn', req.user, null);

    if (item.pendingClaims.length === 0 && !item.approvedClaim && item.canTransition('stored')) {
      item.moveTo('stored', req.user, 'no claims outstanding');
    }

    await item.save();

    return res.status(200).json({
      success: true,
      message: 'Claim withdrawn.',
      data: item.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to withdraw the claim');
  }
};

// ---------------------------------------------------------------------------
// Custody
// ---------------------------------------------------------------------------

/**
 * PATCH /api/lost-found/:id/handover
 */
exports.recordHandover = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid item id.');

    const { to, signatureNote } = req.body;
    if (!isValidId(to)) return fail(res, 400, 'A valid recipient id is required.');

    const item = await LostFoundItem.findById(req.params.id);
    if (!item) return fail(res, 404, 'Item not found.');

    try {
      item.recordHandover(to, req.user, signatureNote);
    } catch (error) {
      if (
        ['NOT_MATCHED', 'NO_APPROVED_CLAIM', 'WRONG_RECIPIENT', 'ILLEGAL_TRANSITION'].includes(
          error.code
        )
      ) {
        return fail(res, 409, error.message);
      }
      throw error;
    }

    await item.save();

    return res.status(200).json({
      success: true,
      message: `Handed over to ${item.handover.toName || 'the claimant'}.`,
      data: item.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to record the handover');
  }
};

/**
 * PATCH /api/lost-found/:id/store
 * Records where the item physically is.
 */
exports.storeItem = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid item id.');

    const item = await LostFoundItem.findById(req.params.id);
    if (!item) return fail(res, 404, 'Item not found.');

    const { storageLocation, distinguishingMarks, isHighValue } = req.body;

    if (storageLocation !== undefined) item.storageLocation = storageLocation;
    if (distinguishingMarks !== undefined) item.distinguishingMarks = distinguishingMarks;
    if (isHighValue !== undefined) item.isHighValue = Boolean(isHighValue);
    if (!item.custodian) item.custodian = req.user._id;

    if (item.status === 'registered' && item.canTransition('stored')) {
      item.moveTo('stored', req.user, storageLocation || null);
    } else {
      item.recordAudit('item:updated', req.user, storageLocation || null);
    }

    await item.save();

    return res.status(200).json({
      success: true,
      message: 'Item updated.',
      data: item.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update the item');
  }
};

/**
 * PATCH /api/lost-found/:id/dispose
 *
 * Refused while a claim is pending — somebody has a live claim on the thing
 * being thrown away.
 */
exports.disposeItem = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid item id.');

    const { note } = req.body;

    const item = await LostFoundItem.findById(req.params.id);
    if (!item) return fail(res, 404, 'Item not found.');

    if (item.pendingClaims.length > 0) {
      return fail(
        res,
        409,
        `There ${item.pendingClaims.length === 1 ? 'is a claim' : 'are claims'} outstanding on this item. Decide them first.`
      );
    }

    try {
      item.moveTo('disposed', req.user, note || null);
    } catch (error) {
      if (error.code === 'ILLEGAL_TRANSITION') return fail(res, 409, error.message);
      throw error;
    }

    item.disposedAt = new Date();
    item.disposalNote = note || null;
    await item.save();

    return res.status(200).json({
      success: true,
      message: 'Item marked disposed.',
      data: item.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to dispose of the item');
  }
};

/**
 * POST /api/lost-found/retention-sweep
 *
 * Flags everything past its retention window as `expired` so the desk has a
 * list to work from. It does not dispose of anything — a sweep that threw
 * items away on a timer would eventually throw away somebody's passport.
 */
exports.runRetentionSweep = async (req, res) => {
  try {
    const due = await LostFoundItem.find({
      kind: 'found',
      status: 'stored',
      retentionUntil: { $lt: new Date() },
    });

    const expired = [];
    for (const item of due) {
      if (item.pendingClaims.length > 0) continue;
      if (!item.canTransition('expired')) continue;
      item.moveTo('expired', req.user, 'retention period elapsed');
      await item.save();
      expired.push(item.ticketId);
    }

    return res.status(200).json({
      success: true,
      message: `${expired.length} item(s) past their retention period.`,
      expired,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to run the retention sweep');
  }
};

/**
 * GET /api/lost-found/stats
 */
exports.getStats = async (req, res) => {
  try {
    const items = await LostFoundItem.find({}).select(
      'kind category status claims retentionUntil'
    );

    const stats = {
      total: items.length,
      found: 0,
      lost: 0,
      inStorage: 0,
      awaitingDecision: 0,
      handedOver: 0,
      disposed: 0,
      pastRetention: 0,
      openClaims: 0,
      byCategory: {},
    };

    items.forEach((item) => {
      if (item.kind === 'found') stats.found += 1;
      else stats.lost += 1;

      if (['stored', 'registered'].includes(item.status)) stats.inStorage += 1;
      if (item.status === 'claim-pending') stats.awaitingDecision += 1;
      if (item.status === 'handed-over') stats.handedOver += 1;
      if (item.status === 'disposed') stats.disposed += 1;
      if (item.isPastRetention && !item.isClosed) stats.pastRetention += 1;

      stats.openClaims += item.claims.filter((claim) => claim.status === 'pending').length;
      stats.byCategory[item.category] = (stats.byCategory[item.category] || 0) + 1;
    });

    const reunited = stats.handedOver;
    const closed = stats.handedOver + stats.disposed;
    stats.reunificationRate = closed > 0 ? Math.round((reunited / closed) * 100) : null;

    return res.status(200).json({ success: true, stats });
  } catch (error) {
    return serverError(res, error, 'Failed to compute register statistics');
  }
};
