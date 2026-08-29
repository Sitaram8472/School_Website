const mongoose = require('mongoose');
const {
  AdmissionRound,
  SeatOffer,
  CATEGORIES,
  RESERVED_CATEGORIES,
  ROUND_STATUSES,
  OFFER_STATES,
  LIVE_HOLD_STATES,
  SCORE_COMPONENTS,
  DEFAULT_WEIGHTS,
  DEFAULT_VALIDITY_HOURS,
} = require('../models/AdmissionRound');
const Application = require('../models/Application');

/**
 * Admission seat allotment.
 *
 * The two handlers worth reading are `publishRound` and `releaseSeat`.
 *
 * `publishRound` turns a ranked list into offers exactly once — the unique
 * `(round, application)` index means a second call cannot produce a second
 * offer for a child, so a retried request is a no-op rather than a scandal.
 *
 * `releaseSeat` is the shared tail of declining, expiring and withdrawing. It
 * kills the hold and fills the seat in the same call, which is what stops a
 * released seat from sitting unallocated until somebody remembers it, and stops
 * two clerks from filling it twice.
 *
 * Every transition out of a live hold is a guarded `findOneAndUpdate`, never a
 * read-then-write, because two people working the same list on the same morning
 * is the normal case in an admissions office, not the edge case.
 */

const HOUR_MS = 3600000;

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
  if (error.name === 'ValidatorError' || error.name === 'CastError') {
    return error.message;
  }
  if (error.code === 11000) return 'That record already exists';
  return null;
}

function isAdmin(user) {
  return user && user.role === 'admin';
}

/** The fields an admin may set on a round. Everything derived is refused. */
function sanitiseRound(body) {
  return {
    academicYear: body.academicYear,
    gradeLevel: body.gradeLevel,
    roundNumber: body.roundNumber === undefined ? undefined : Number(body.roundNumber),
    totalSeats: body.totalSeats === undefined ? undefined : Number(body.totalSeats),
    quotas: Array.isArray(body.quotas)
      ? body.quotas.map((q) => ({ category: q.category, seats: Number(q.seats) }))
      : undefined,
    quotaSpillover: body.quotaSpillover,
    weights: body.weights
      ? {
          entrance: Number(body.weights.entrance),
          interaction: Number(body.weights.interaction),
          priorAcademic: Number(body.weights.priorAcademic),
        }
      : undefined,
    offerValidityHours:
      body.offerValidityHours === undefined ? undefined : Number(body.offerValidityHours),
  };
}

function sanitiseScores(body) {
  const scores = {};
  SCORE_COMPONENTS.forEach((key) => {
    if (body[key] !== undefined) scores[key] = Number(body[key]);
  });
  return scores;
}

/**
 * Quota seats cannot exceed the room. A round that reserves more seats than it
 * has is a round whose open list is silently empty.
 */
function quotaOverflowError(round) {
  const reserved = round.quotas.reduce((sum, q) => sum + (q.seats || 0), 0);
  if (reserved > round.totalSeats) {
    return `The quotas reserve ${reserved} seats out of ${round.totalSeats}`;
  }
  return null;
}

async function loadRound(id) {
  if (!isValidId(id)) return { status: 400, message: 'Invalid round id' };
  const round = await AdmissionRound.findById(id);
  if (!round) return { status: 404, message: 'Admission round not found' };
  return { round };
}

/** Everybody in a round, in stored order. */
function candidatesOf(roundId) {
  return SeatOffer.find({ round: roundId });
}

/**
 * Fill a seat that has just come free.
 *
 * Returns the promoted candidacy, or null when nobody is waiting for a seat of
 * that kind — which is a legitimate outcome and is reported as one rather than
 * being quietly turned into a general seat.
 */
async function fillSeat(round, seatKind, actor) {
  const waiting = await SeatOffer.find({ round: round._id, state: 'waitlisted' });
  const next = SeatOffer.nextForSeat(round, seatKind, waiting);
  if (!next) return null;

  const now = new Date();
  const promoted = await SeatOffer.findOneAndUpdate(
    { _id: next._id, state: 'waitlisted' },
    {
      $set: {
        state: 'offered',
        seatKind,
        offeredAt: now,
        expiresAt: new Date(now.getTime() + round.offerValidityHours * HOUR_MS),
        waitlistPosition: null,
        promotedFrom: seatKind,
        promotedAt: now,
      },
      $push: {
        history: {
          action: `promoted into a ${seatKind} seat`,
          by: actor ? actor._id : undefined,
          at: now,
        },
      },
    },
    { new: true }
  );

  return promoted;
}

/**
 * Kill a live hold and fill the seat it was holding, in one call.
 *
 * The guard on `state` is what makes this safe to call from two places at once:
 * the second caller finds nothing to update and does not promote a second
 * candidate into a seat that only came free once.
 */
async function releaseSeat(round, offerId, nextState, actor, note) {
  const now = new Date();
  const released = await SeatOffer.findOneAndUpdate(
    { _id: offerId, state: { $in: LIVE_HOLD_STATES } },
    {
      $set: { state: nextState, respondedAt: now, withdrawnReason: note },
      $push: {
        history: { action: nextState, by: actor ? actor._id : undefined, at: now, note },
      },
    },
    { new: true }
  );

  if (!released) return { released: null, promoted: null };

  const promoted = await fillSeat(round, released.seatKind || 'general', actor);
  return { released, promoted };
}

/** Waitlist positions, recomputed so "you are fourth" survives the next sweep. */
async function renumberWaitlist(roundId) {
  const waiting = await SeatOffer.find({ round: roundId, state: 'waitlisted' }).sort({ rank: 1 });
  await Promise.all(
    waiting.map((candidate, index) =>
      SeatOffer.updateOne({ _id: candidate._id }, { $set: { waitlistPosition: index + 1 } })
    )
  );
  return waiting.length;
}

/** The seat ledger, counted from the candidacies rather than stored anywhere. */
async function seatLedger(round) {
  const rows = await SeatOffer.aggregate([
    { $match: { round: round._id } },
    { $group: { _id: '$state', count: { $sum: 1 } } },
  ]);

  const byState = {};
  OFFER_STATES.forEach((state) => {
    byState[state] = 0;
  });
  rows.forEach((row) => {
    byState[row._id] = row.count;
  });

  const held = LIVE_HOLD_STATES.reduce((sum, state) => sum + byState[state], 0);
  return {
    byState,
    seats: round.totalSeats,
    held,
    free: Math.max(0, round.totalSeats - held),
  };
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/** GET /api/allotment/meta */
exports.getMeta = async (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      categories: CATEGORIES,
      reservedCategories: RESERVED_CATEGORIES,
      roundStatuses: ROUND_STATUSES,
      offerStates: OFFER_STATES,
      scoreComponents: SCORE_COMPONENTS,
      defaultWeights: DEFAULT_WEIGHTS,
      defaultValidityHours: DEFAULT_VALIDITY_HOURS,
    },
  });
};

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

/** POST /api/allotment/rounds */
exports.createRound = async (req, res) => {
  try {
    const round = new AdmissionRound({
      ...sanitiseRound(req.body),
      createdBy: req.user._id,
      status: 'draft',
    });

    const overflow = quotaOverflowError(round);
    if (overflow) return fail(res, 400, overflow);

    round.recordHistory('created', req.user._id);
    await round.save();

    return res.status(201).json({ success: true, message: 'Round created', data: round });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to create the round');
  }
};

/** GET /api/allotment/rounds */
exports.listRounds = async (req, res) => {
  try {
    const filter = {};
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;
    if (req.query.gradeLevel) filter.gradeLevel = req.query.gradeLevel;
    if (req.query.status && ROUND_STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }

    const rounds = await AdmissionRound.find(filter)
      .sort({ academicYear: -1, gradeLevel: 1, roundNumber: 1 })
      .limit(200);

    return res.status(200).json({ success: true, count: rounds.length, data: rounds });
  } catch (error) {
    return serverError(res, error, 'Failed to load rounds');
  }
};

/** GET /api/allotment/rounds/:id */
exports.getRound = async (req, res) => {
  try {
    const { round, status, message } = await loadRound(req.params.id);
    if (!round) return fail(res, status, message);

    const ledger = await seatLedger(round);
    return res.status(200).json({
      success: true,
      data: { round, ledger, breakdown: round.seatBreakdown },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the round');
  }
};

/** PATCH /api/allotment/rounds/:id */
exports.updateRound = async (req, res) => {
  try {
    const { round, status, message } = await loadRound(req.params.id);
    if (!round) return fail(res, status, message);

    if (!round.isEditable()) {
      return fail(res, 409, `A ${round.status} round cannot be edited`);
    }

    const updates = sanitiseRound(req.body);
    Object.entries(updates).forEach(([key, value]) => {
      if (value !== undefined) round.set(key, value);
    });

    const overflow = quotaOverflowError(round);
    if (overflow) return fail(res, 400, overflow);

    round.recordHistory('edited', req.user._id);
    await round.save();

    return res.status(200).json({ success: true, message: 'Round updated', data: round });
  } catch (error) {
    const msg = validationMessage(error);
    if (msg) return fail(res, 400, msg);
    return serverError(res, error, 'Failed to update the round');
  }
};

/** PATCH /api/allotment/rounds/:id/close */
exports.closeRound = async (req, res) => {
  try {
    const { round, status, message } = await loadRound(req.params.id);
    if (!round) return fail(res, status, message);

    if (round.status === 'closed') {
      return res.status(200).json({ success: true, message: 'Already closed', data: round });
    }

    round.status = 'closed';
    round.closedAt = new Date();
    round.recordHistory('closed', req.user._id, req.body.note);
    await round.save();

    // Everybody still waiting is told so, rather than left waiting forever.
    const closed = await SeatOffer.updateMany(
      { round: round._id, state: { $in: ['registered', 'waitlisted'] } },
      { $set: { state: 'not-selected', waitlistPosition: null } }
    );

    return res.status(200).json({
      success: true,
      message: `Round closed; ${closed.modifiedCount} candidates released`,
      data: round,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to close the round');
  }
};

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** POST /api/allotment/rounds/:id/candidates */
exports.addCandidate = async (req, res) => {
  try {
    const { round, status, message } = await loadRound(req.params.id);
    if (!round) return fail(res, status, message);

    if (!round.isEditable()) {
      return fail(res, 409, `Candidates cannot be added to a ${round.status} round`);
    }

    if (!isValidId(req.body.application)) return fail(res, 400, 'Invalid application id');

    const application = await Application.findById(req.body.application);
    if (!application) return fail(res, 404, 'Application not found');

    const candidate = new SeatOffer({
      round: round._id,
      application: application._id,
      guardian: isValidId(req.body.guardian) ? req.body.guardian : null,
      candidateName: application.studentName,
      dateOfBirth: application.dateOfBirth,
      category: CATEGORIES.includes(req.body.category) ? req.body.category : 'general',
      componentScores: sanitiseScores(req.body),
      state: 'registered',
    });

    candidate.applyComposite(round.weights);
    candidate.recordHistory('registered', req.user._id);
    await candidate.save();

    return res.status(201).json({ success: true, message: 'Candidate registered', data: candidate });
  } catch (error) {
    if (error.code === 11000) {
      return fail(res, 409, 'That application is already a candidate in this round');
    }
    const msg = validationMessage(error);
    if (msg) return fail(res, 400, msg);
    return serverError(res, error, 'Failed to register the candidate');
  }
};

/** PATCH /api/allotment/rounds/:id/candidates/:cid */
exports.updateCandidate = async (req, res) => {
  try {
    const { round, status, message } = await loadRound(req.params.id);
    if (!round) return fail(res, status, message);

    if (!round.acceptsScoreEdits()) {
      return fail(
        res,
        409,
        'Scores cannot be changed once the round is published; the list has already gone out'
      );
    }

    if (!isValidId(req.params.cid)) return fail(res, 400, 'Invalid candidate id');
    const candidate = await SeatOffer.findOne({ _id: req.params.cid, round: round._id });
    if (!candidate) return fail(res, 404, 'Candidate not found in this round');

    const scores = sanitiseScores(req.body);
    Object.entries(scores).forEach(([key, value]) => {
      candidate.componentScores[key] = value;
    });
    if (CATEGORIES.includes(req.body.category)) candidate.category = req.body.category;

    candidate.applyComposite(round.weights);
    candidate.recordHistory('scores updated', req.user._id);
    await candidate.save();

    // The published list and the stored scores no longer agree; say so.
    if (round.status === 'ranked') {
      round.status = 'draft';
      round.recordHistory('re-opened by a score change', req.user._id);
      await round.save();
    }

    return res.status(200).json({ success: true, message: 'Candidate updated', data: candidate });
  } catch (error) {
    const msg = validationMessage(error);
    if (msg) return fail(res, 400, msg);
    return serverError(res, error, 'Failed to update the candidate');
  }
};

/** POST /api/allotment/rounds/:id/rank */
exports.rankRound = async (req, res) => {
  try {
    const { round, status, message } = await loadRound(req.params.id);
    if (!round) return fail(res, status, message);

    if (round.status === 'closed') return fail(res, 409, 'A closed round cannot be re-ranked');

    const candidates = await candidatesOf(round._id);
    if (!candidates.length) return fail(res, 400, 'There are no candidates to rank');

    const ranked = SeatOffer.rankAll(candidates, round.weights);
    await Promise.all(
      ranked.map((candidate) =>
        SeatOffer.updateOne(
          { _id: candidate._id },
          { $set: { compositeScore: candidate.compositeScore, rank: candidate.rank } }
        )
      )
    );

    round.status = round.status === 'published' ? 'published' : 'ranked';
    round.rankedAt = new Date();
    round.recordHistory('ranked', req.user._id, `${ranked.length} candidates`);
    await round.save();

    return res.status(200).json({
      success: true,
      message: `${ranked.length} candidates ranked`,
      data: {
        round,
        merit: ranked.slice(0, 50).map((c) => ({
          id: c._id,
          rank: c.rank,
          candidateName: c.candidateName,
          category: c.category,
          compositeScore: c.compositeScore,
        })),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to rank the round');
  }
};

// ---------------------------------------------------------------------------
// Publication and the seat lifecycle
// ---------------------------------------------------------------------------

/**
 * POST /api/allotment/rounds/:id/publish
 *
 * Idempotent: a candidate already holding a seat is left alone, so a retried
 * publication issues no second offer and resets no expiry clock.
 */
exports.publishRound = async (req, res) => {
  try {
    const { round, status, message } = await loadRound(req.params.id);
    if (!round) return fail(res, status, message);

    if (round.status === 'draft') {
      return fail(res, 409, 'Rank the round before publishing it');
    }
    if (round.status === 'closed') return fail(res, 409, 'A closed round cannot be published');

    const candidates = await candidatesOf(round._id);
    const unranked = candidates.filter((c) => !c.rank);
    if (unranked.length) {
      return fail(res, 409, `${unranked.length} candidates have no rank; re-rank the round`);
    }

    candidates.sort((a, b) => a.rank - b.rank);
    const { offers, waitlist } = SeatOffer.buildAllotment(round, candidates);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + round.offerValidityHours * HOUR_MS);

    let issued = 0;
    for (const { candidate, seatKind } of offers) {
      // Only a candidate not already holding a seat is offered one.
      const updated = await SeatOffer.findOneAndUpdate(
        { _id: candidate._id, state: { $in: ['registered', 'waitlisted', 'not-selected'] } },
        {
          $set: {
            state: 'offered',
            seatKind,
            offeredAt: now,
            expiresAt,
            waitlistPosition: null,
          },
          $push: { history: { action: `offered a ${seatKind} seat`, by: req.user._id, at: now } },
        }
      );
      if (updated) issued += 1;
    }

    await Promise.all(
      waitlist.map((candidate) =>
        SeatOffer.updateOne(
          { _id: candidate._id, state: { $in: ['registered', 'not-selected'] } },
          { $set: { state: 'waitlisted', seatKind: null } }
        )
      )
    );

    const waiting = await renumberWaitlist(round._id);

    round.status = 'published';
    round.publishedAt = round.publishedAt || now;
    round.publishedBy = round.publishedBy || req.user._id;
    round.rankFingerprint = AdmissionRound.fingerprintOf(candidates);
    round.recordHistory('published', req.user._id, `${issued} offers issued`);
    await round.save();

    return res.status(200).json({
      success: true,
      message: `${issued} offers issued, ${waiting} candidates waitlisted`,
      data: { round, issued, waitlisted: waiting, ledger: await seatLedger(round) },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to publish the round');
  }
};

/** GET /api/allotment/rounds/:id/allotment */
exports.getAllotment = async (req, res) => {
  try {
    const { round, status, message } = await loadRound(req.params.id);
    if (!round) return fail(res, status, message);

    const candidates = await SeatOffer.find({ round: round._id }).sort({ rank: 1 });
    const fingerprint = AdmissionRound.fingerprintOf(candidates);

    return res.status(200).json({
      success: true,
      data: {
        round,
        ledger: await seatLedger(round),
        candidates,
        // A score edited after publication shows up here rather than in an audit.
        rankingChangedSincePublication:
          Boolean(round.rankFingerprint) && round.rankFingerprint !== fingerprint,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the allotment');
  }
};

/** GET /api/allotment/rounds/:id/waitlist */
exports.getWaitlist = async (req, res) => {
  try {
    const { round, status, message } = await loadRound(req.params.id);
    if (!round) return fail(res, status, message);

    const waiting = await SeatOffer.find({ round: round._id, state: 'waitlisted' }).sort({
      waitlistPosition: 1,
      rank: 1,
    });

    return res.status(200).json({ success: true, count: waiting.length, data: waiting });
  } catch (error) {
    return serverError(res, error, 'Failed to load the waitlist');
  }
};

/**
 * POST /api/allotment/rounds/:id/reconcile
 *
 * The sweep that makes the deadline real. Idempotent — running it twice in a
 * minute expires nothing the second time, because the guard on `state` finds
 * the offer already dead.
 */
exports.reconcileRound = async (req, res) => {
  try {
    const { round, status, message } = await loadRound(req.params.id);
    if (!round) return fail(res, status, message);

    const now = new Date();
    const due = await SeatOffer.find({
      round: round._id,
      state: 'offered',
      expiresAt: { $lte: now },
    });

    let expired = 0;
    let promoted = 0;
    for (const offer of due) {
      const outcome = await releaseSeat(round, offer._id, 'expired', req.user, 'offer lapsed');
      if (outcome.released) expired += 1;
      if (outcome.promoted) promoted += 1;
    }

    await renumberWaitlist(round._id);

    return res.status(200).json({
      success: true,
      message: `${expired} offers expired, ${promoted} candidates promoted`,
      data: { expired, promoted, ledger: await seatLedger(round) },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to reconcile the round');
  }
};

// ---------------------------------------------------------------------------
// A family's own offer
// ---------------------------------------------------------------------------

/** GET /api/allotment/offers/mine */
exports.getMyOffers = async (req, res) => {
  try {
    const offers = await SeatOffer.find({ guardian: req.user._id })
      .sort({ createdAt: -1 })
      .populate('round', 'academicYear gradeLevel roundNumber status offerValidityHours');

    const now = new Date();
    return res.status(200).json({
      success: true,
      count: offers.length,
      data: offers.map((offer) => ({
        ...offer.toObject(),
        hoursRemaining: offer.hoursRemaining(now),
        hasExpired: offer.hasExpired(now),
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load your offers');
  }
};

async function loadOfferFor(id, user) {
  if (!isValidId(id)) return { status: 400, message: 'Invalid offer id' };

  const offer = await SeatOffer.findById(id);
  if (!offer) return { status: 404, message: 'Offer not found' };

  if (!offer.isOwnedBy(user) && !isAdmin(user)) {
    return { status: 403, message: 'That offer belongs to another family' };
  }

  const round = await AdmissionRound.findById(offer.round);
  if (!round) return { status: 404, message: 'The round for that offer no longer exists' };

  return { offer, round };
}

/** PATCH /api/allotment/offers/:id/accept */
exports.acceptOffer = async (req, res) => {
  try {
    const { offer, round, status, message } = await loadOfferFor(req.params.id, req.user);
    if (!offer) return fail(res, status, message);

    if (offer.state === 'accepted') {
      return res.status(200).json({ success: true, message: 'Already accepted', data: offer });
    }
    if (offer.state !== 'offered') {
      return fail(res, 409, `That offer is ${offer.state} and cannot be accepted`);
    }

    const now = new Date();
    if (offer.hasExpired(now)) {
      // Say when it ran out. "Not allowed" is what makes people ring the office.
      return fail(
        res,
        409,
        `That offer expired on ${offer.expiresAt.toISOString().slice(0, 16).replace('T', ' ')}`
      );
    }

    const accepted = await SeatOffer.findOneAndUpdate(
      { _id: offer._id, state: 'offered', expiresAt: { $gt: now } },
      {
        $set: { state: 'accepted', respondedAt: now },
        $push: { history: { action: 'accepted', by: req.user._id, at: now } },
      },
      { new: true }
    );

    if (!accepted) return fail(res, 409, 'That offer was withdrawn or expired a moment ago');

    // One child holds one seat. The other live offers for this application die
    // here, and each one frees its own seat for the next candidate.
    const rivals = await SeatOffer.find({
      application: accepted.application,
      _id: { $ne: accepted._id },
      state: { $in: ['offered'] },
    });

    let cascaded = 0;
    for (const rival of rivals) {
      const rivalRound = await AdmissionRound.findById(rival.round);
      if (!rivalRound) continue;
      const outcome = await releaseSeat(
        rivalRound,
        rival._id,
        'declined',
        req.user,
        'the family accepted a seat in another round'
      );
      if (outcome.promoted) cascaded += 1;
    }

    return res.status(200).json({
      success: true,
      message:
        cascaded > 0
          ? `Seat accepted; ${cascaded} other seats released and refilled`
          : 'Seat accepted',
      data: { offer: accepted, ledger: await seatLedger(round) },
    });
  } catch (error) {
    if (error.code === 11000) {
      return fail(res, 409, 'This child has already accepted a seat this year');
    }
    return serverError(res, error, 'Failed to accept the offer');
  }
};

/** PATCH /api/allotment/offers/:id/decline */
exports.declineOffer = async (req, res) => {
  try {
    const { offer, round, status, message } = await loadOfferFor(req.params.id, req.user);
    if (!offer) return fail(res, status, message);

    if (['declined', 'expired'].includes(offer.state)) {
      return res.status(200).json({ success: true, message: 'Already released', data: offer });
    }
    if (!offer.isLiveHold()) {
      return fail(res, 409, `That offer is ${offer.state} and cannot be declined`);
    }

    const outcome = await releaseSeat(round, offer._id, 'declined', req.user, req.body.note);
    if (!outcome.released) return fail(res, 409, 'That offer changed a moment ago; reload it');

    await renumberWaitlist(round._id);

    return res.status(200).json({
      success: true,
      message: outcome.promoted
        ? `Seat declined and offered to ${outcome.promoted.candidateName}`
        : 'Seat declined; nobody is waiting for a seat of that kind',
      data: { offer: outcome.released, promoted: outcome.promoted },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to decline the offer');
  }
};

/** PATCH /api/allotment/offers/:id/withdraw */
exports.withdrawOffer = async (req, res) => {
  try {
    const { offer, round, status, message } = await loadOfferFor(req.params.id, req.user);
    if (!offer) return fail(res, status, message);

    if (!offer.isLiveHold()) {
      return fail(res, 409, `That candidacy is ${offer.state}; there is nothing to withdraw`);
    }

    const note = (req.body.note || '').trim();
    if (note.length < 8) {
      return fail(res, 400, 'Withdrawing a seat needs a reason on the record');
    }

    const outcome = await releaseSeat(round, offer._id, 'withdrawn', req.user, note);
    if (!outcome.released) return fail(res, 409, 'That offer changed a moment ago; reload it');

    await renumberWaitlist(round._id);

    return res.status(200).json({
      success: true,
      message: outcome.promoted
        ? `Withdrawn; the seat went to ${outcome.promoted.candidateName}`
        : 'Withdrawn',
      data: { offer: outcome.released, promoted: outcome.promoted },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to withdraw the offer');
  }
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** GET /api/allotment/stats */
exports.getStats = async (req, res) => {
  try {
    const [byState, byCategory] = await Promise.all([
      SeatOffer.aggregate([{ $group: { _id: '$state', count: { $sum: 1 } } }]),
      SeatOffer.aggregate([
        { $match: { state: { $in: LIVE_HOLD_STATES } } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
      ]),
    ]);

    const rounds = await AdmissionRound.find({ status: { $ne: 'closed' } }).sort({
      academicYear: -1,
      roundNumber: 1,
    });

    const now = new Date();
    const lapsing = await SeatOffer.countDocuments({
      state: 'offered',
      expiresAt: { $lte: new Date(now.getTime() + 24 * HOUR_MS) },
    });

    return res.status(200).json({
      success: true,
      data: {
        byState: byState.reduce((acc, row) => ({ ...acc, [row._id]: row.count }), {}),
        heldByCategory: byCategory.reduce((acc, row) => ({ ...acc, [row._id]: row.count }), {}),
        openRounds: rounds.length,
        offersLapsingWithin24Hours: lapsing,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load statistics');
  }
};

/** GET /api/allotment/rounds/:id/candidates */
exports.listCandidates = async (req, res) => {
  try {
    const { round, status, message } = await loadRound(req.params.id);
    if (!round) return fail(res, status, message);

    const filter = { round: round._id };
    if (req.query.state && OFFER_STATES.includes(req.query.state)) filter.state = req.query.state;
    if (req.query.category && CATEGORIES.includes(req.query.category)) {
      filter.category = req.query.category;
    }

    const candidates = await SeatOffer.find(filter).sort({ rank: 1, candidateName: 1 });
    return res.status(200).json({ success: true, count: candidates.length, data: candidates });
  } catch (error) {
    return serverError(res, error, 'Failed to load candidates');
  }
};
