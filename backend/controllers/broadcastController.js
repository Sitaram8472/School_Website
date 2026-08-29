const mongoose = require('mongoose');
const {
  Broadcast,
  BroadcastReceipt,
  SEVERITIES,
  CHANNELS,
  BROADCAST_STATUSES,
  RECEIPT_STATES,
  OUTSTANDING_STATES,
  AUDIENCE_ROLES,
  DEFAULT_ACKNOWLEDGE_WITHIN_MINUTES,
  DEFAULT_ESCALATE_AFTER_MINUTES,
  MINUTE_MS,
} = require('../models/Broadcast');
const User = require('../models/User');

/**
 * Emergency broadcasts.
 *
 * Two things here are not like the rest of the codebase, and both are
 * deliberate.
 *
 * `dispatch` is idempotent on `dispatchKey`. A retry — the coordinator tapping
 * send again on a bad connection — returns the broadcast that already exists
 * with `alreadyDispatched: true`, and the receipts are written with
 * `insertMany({ ordered: false })` against a unique index, so a dispatch that
 * failed halfway can be run again and completes the set exactly once.
 *
 * `countsFor` recomputes from the receipts every single time. Nothing here
 * increments a stored counter, because a counter is precisely the thing that
 * drifts during the twenty minutes when the number matters most.
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

function sanitiseBroadcast(body) {
  return {
    title: body.title,
    body: body.body,
    severity: SEVERITIES.includes(body.severity) ? body.severity : undefined,
    audience: body.audience
      ? {
          roles: Array.isArray(body.audience.roles)
            ? body.audience.roles.filter((role) => AUDIENCE_ROLES.includes(role))
            : [],
          users: Array.isArray(body.audience.users)
            ? body.audience.users.filter(isValidId)
            : [],
          activeOnly: body.audience.activeOnly !== false,
        }
      : undefined,
    channels: Array.isArray(body.channels)
      ? body.channels.filter((channel) => CHANNELS.includes(channel))
      : undefined,
    requiresAcknowledgement: body.requiresAcknowledgement,
    acknowledgeWithinMinutes:
      body.acknowledgeWithinMinutes === undefined
        ? undefined
        : Number(body.acknowledgeWithinMinutes),
    escalateAfterMinutes:
      body.escalateAfterMinutes === undefined ? undefined : Number(body.escalateAfterMinutes),
    escalationNote: body.escalationNote,
  };
}

/**
 * Who this goes to, resolved once, at dispatch.
 *
 * A parent who joins the school an hour later is not silently added to an alert
 * that went out before they existed, and a person who is both named
 * individually and covered by a role appears once.
 */
async function resolveAudience(broadcast) {
  const filters = [];

  if (broadcast.audience.roles.length) {
    filters.push({ role: { $in: broadcast.audience.roles } });
  }
  if (broadcast.audience.users.length) {
    filters.push({ _id: { $in: broadcast.audience.users } });
  }
  if (!filters.length) return [];

  const query = { $or: filters };
  if (broadcast.audience.activeOnly) query.isActive = { $ne: false };

  const recipients = await User.find(query).select('_id');
  return recipients.map((user) => user._id);
}

/** The counts, from the receipts, every time. */
async function countsFor(broadcastId) {
  const rows = await BroadcastReceipt.aggregate([
    { $match: { broadcast: new mongoose.Types.ObjectId(String(broadcastId)) } },
    { $group: { _id: '$state', count: { $sum: 1 } } },
  ]);

  const byState = {};
  RECEIPT_STATES.forEach((state) => {
    byState[state] = 0;
  });
  rows.forEach((row) => {
    byState[row._id] = row.count;
  });

  const recipients = Object.values(byState).reduce((sum, count) => sum + count, 0);
  const outstanding = OUTSTANDING_STATES.reduce((sum, state) => sum + byState[state], 0);

  return {
    byState,
    recipients,
    outstanding,
    acknowledged: recipients - outstanding,
    escalated: byState.escalated + byState['escalated-acknowledged'],
  };
}

async function loadBroadcast(id) {
  if (!isValidId(id)) return { status: 400, message: 'Invalid broadcast id' };
  const broadcast = await Broadcast.findById(id);
  if (!broadcast) return { status: 404, message: 'Broadcast not found' };
  return { broadcast };
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/** GET /api/broadcasts/meta */
exports.getMeta = async (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      severities: SEVERITIES,
      channels: CHANNELS,
      statuses: BROADCAST_STATUSES,
      receiptStates: RECEIPT_STATES,
      audienceRoles: AUDIENCE_ROLES,
      defaultAcknowledgeWithinMinutes: DEFAULT_ACKNOWLEDGE_WITHIN_MINUTES,
      defaultEscalateAfterMinutes: DEFAULT_ESCALATE_AFTER_MINUTES,
    },
  });
};

// ---------------------------------------------------------------------------
// Composing
// ---------------------------------------------------------------------------

/** POST /api/broadcasts */
exports.createBroadcast = async (req, res) => {
  try {
    const dispatchKey = (req.body.dispatchKey || '').trim();
    if (!dispatchKey) {
      return fail(res, 400, 'A dispatch key is required; it is what makes sending twice safe');
    }

    if (req.body.supersedes && !isValidId(req.body.supersedes)) {
      return fail(res, 400, 'Invalid id for the broadcast being corrected');
    }

    const broadcast = new Broadcast({
      ...sanitiseBroadcast(req.body),
      dispatchKey,
      supersedes: req.body.supersedes || null,
      status: 'draft',
      createdBy: req.user._id,
    });

    broadcast.recordHistory('drafted', req.user._id);
    await broadcast.save();

    return res.status(201).json({ success: true, message: 'Draft saved', data: broadcast });
  } catch (error) {
    if (error.code === 11000) {
      const existing = await Broadcast.findOne({ dispatchKey: req.body.dispatchKey });
      return res.status(200).json({
        success: true,
        message: 'A broadcast with that dispatch key already exists',
        data: existing,
        alreadyExists: true,
      });
    }
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to save the broadcast');
  }
};

/** GET /api/broadcasts */
exports.listBroadcasts = async (req, res) => {
  try {
    const filter = {};
    if (req.query.status && BROADCAST_STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (req.query.severity && SEVERITIES.includes(req.query.severity)) {
      filter.severity = req.query.severity;
    }

    const broadcasts = await Broadcast.find(filter).sort({ createdAt: -1 }).limit(120);

    const withCounts = [];
    for (const broadcast of broadcasts) {
      withCounts.push({
        ...broadcast.toObject(),
        counts: broadcast.isDispatched() ? await countsFor(broadcast._id) : null,
      });
    }

    return res.status(200).json({ success: true, count: withCounts.length, data: withCounts });
  } catch (error) {
    return serverError(res, error, 'Failed to load broadcasts');
  }
};

/** GET /api/broadcasts/:id */
exports.getBroadcast = async (req, res) => {
  try {
    const { broadcast, status, message } = await loadBroadcast(req.params.id);
    if (!broadcast) return fail(res, status, message);

    return res.status(200).json({
      success: true,
      data: {
        broadcast,
        counts: broadcast.isDispatched() ? await countsFor(broadcast._id) : null,
        intact: broadcast.isIntact(),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the broadcast');
  }
};

/** PATCH /api/broadcasts/:id */
exports.updateBroadcast = async (req, res) => {
  try {
    const { broadcast, status, message } = await loadBroadcast(req.params.id);
    if (!broadcast) return fail(res, status, message);

    if (!broadcast.isEditable()) {
      return fail(res, 409, 'A dispatched broadcast cannot be edited; issue a correction instead');
    }

    const updates = sanitiseBroadcast(req.body);
    Object.entries(updates).forEach(([key, value]) => {
      if (value !== undefined) broadcast.set(key, value);
    });

    broadcast.recordHistory('edited', req.user._id);
    await broadcast.save();

    return res.status(200).json({ success: true, message: 'Draft updated', data: broadcast });
  } catch (error) {
    const msg = validationMessage(error);
    if (msg) return fail(res, 400, msg);
    return serverError(res, error, 'Failed to update the broadcast');
  }
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * POST /api/broadcasts/:id/dispatch
 *
 * Safe to call twice. Safe to call twice in parallel. Safe to call again after
 * it failed halfway through writing the receipts.
 */
exports.dispatchBroadcast = async (req, res) => {
  try {
    const { broadcast, status, message } = await loadBroadcast(req.params.id);
    if (!broadcast) return fail(res, status, message);

    if (broadcast.status === 'cancelled') {
      return fail(res, 409, 'That broadcast was cancelled');
    }

    const recipients = await resolveAudience(broadcast);
    if (!recipients.length) {
      return fail(res, 400, 'That audience resolves to nobody; check the roles');
    }

    const alreadyDispatched = broadcast.isDispatched();
    const dispatchedAt = broadcast.dispatchedAt || new Date();
    const dueAt = new Date(dispatchedAt.getTime() + broadcast.acknowledgeWithinMinutes * MINUTE_MS);

    // The unique index does the work: whatever is already there stays, whatever
    // is missing is added, and nobody gets a second copy.
    const receipts = recipients.map((recipient) => ({
      broadcast: broadcast._id,
      recipient,
      state: 'pending',
      deliveredAt: dispatchedAt,
      dueAt,
    }));

    let inserted = 0;
    try {
      const written = await BroadcastReceipt.insertMany(receipts, { ordered: false });
      inserted = written.length;
    } catch (error) {
      if (error.code !== 11000 && !error.writeErrors) throw error;
      inserted = error.insertedDocs ? error.insertedDocs.length : 0;
    }

    if (!alreadyDispatched) {
      broadcast.status = 'dispatched';
      broadcast.dispatchedAt = dispatchedAt;
      broadcast.dispatchedBy = req.user._id;
      broadcast.bodyFingerprint = broadcast.computeFingerprint();
      broadcast.ref = `ALERT/${dispatchedAt.getFullYear()}-${String(
        dispatchedAt.getMonth() + 1
      ).padStart(2, '0')}/${String(
        (await Broadcast.countDocuments({ status: { $ne: 'draft' } })) + 1
      ).padStart(3, '0')}`;
      broadcast.recordHistory('dispatched', req.user._id, `${recipients.length} recipients`);
      await broadcast.save();
    }

    return res.status(200).json({
      success: true,
      alreadyDispatched,
      message: alreadyDispatched
        ? `Already dispatched; ${inserted} missing receipts written`
        : `Dispatched to ${recipients.length} people`,
      data: {
        broadcast,
        counts: await countsFor(broadcast._id),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to dispatch the broadcast');
  }
};

/** GET /api/broadcasts/:id/receipts */
exports.listReceipts = async (req, res) => {
  try {
    const { broadcast, status, message } = await loadBroadcast(req.params.id);
    if (!broadcast) return fail(res, status, message);

    const filter = { broadcast: broadcast._id };
    if (req.query.state && RECEIPT_STATES.includes(req.query.state)) filter.state = req.query.state;

    const receipts = await BroadcastReceipt.find(filter)
      .sort({ state: 1, deliveredAt: 1 })
      .populate('recipient', 'name email role')
      .limit(1000);

    return res.status(200).json({
      success: true,
      count: receipts.length,
      data: receipts,
      counts: await countsFor(broadcast._id),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the receipts');
  }
};

/**
 * POST /api/broadcasts/:id/reconcile
 *
 * Escalates every pending receipt that is past due, once each. Running it every
 * minute for an hour escalates each person exactly once, which is what makes it
 * safe to give to a frightened coordinator as a button.
 */
exports.reconcileBroadcast = async (req, res) => {
  try {
    const { broadcast, status, message } = await loadBroadcast(req.params.id);
    if (!broadcast) return fail(res, status, message);

    if (!broadcast.isDispatched()) {
      return fail(res, 409, 'That broadcast has not been dispatched');
    }

    const now = new Date();
    const cutoff = new Date(now.getTime() - broadcast.escalateAfterMinutes * MINUTE_MS);

    const outcome = await BroadcastReceipt.updateMany(
      { broadcast: broadcast._id, state: 'pending', deliveredAt: { $lte: cutoff } },
      { $set: { state: 'escalated', escalatedAt: now } }
    );

    const counts = await countsFor(broadcast._id);

    return res.status(200).json({
      success: true,
      message: outcome.modifiedCount
        ? `${outcome.modifiedCount} escalated; ${counts.outstanding} still outstanding`
        : `Nothing new to escalate; ${counts.outstanding} outstanding`,
      data: { escalated: outcome.modifiedCount, counts },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to reconcile the broadcast');
  }
};

/**
 * PATCH /api/broadcasts/:id/close
 *
 * Closing with people still outstanding is allowed and has to say so. The
 * outstanding figure is stored at closure, so an incident closed with forty
 * unacknowledged is on the record as an incident closed with forty
 * unacknowledged.
 */
exports.closeBroadcast = async (req, res) => {
  try {
    const { broadcast, status, message } = await loadBroadcast(req.params.id);
    if (!broadcast) return fail(res, status, message);

    if (broadcast.status === 'closed') {
      return res.status(200).json({ success: true, message: 'Already closed', data: broadcast });
    }
    if (!broadcast.isDispatched()) {
      return fail(res, 409, 'That broadcast has not been dispatched');
    }

    const counts = await countsFor(broadcast._id);
    const note = (req.body.note || '').trim();

    if (counts.outstanding > 0 && note.length < 10) {
      return fail(
        res,
        400,
        `${counts.outstanding} people have not acknowledged; closing needs a note saying why`
      );
    }

    broadcast.status = 'closed';
    broadcast.closedAt = new Date();
    broadcast.closureNote = note;
    broadcast.outstandingAtClose = counts.outstanding;
    broadcast.recordHistory('closed', req.user._id, note);
    await broadcast.save();

    return res.status(200).json({
      success: true,
      message: counts.outstanding
        ? `Closed with ${counts.outstanding} unacknowledged`
        : 'Closed; everybody acknowledged',
      data: broadcast,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to close the broadcast');
  }
};

/** PATCH /api/broadcasts/:id/cancel */
exports.cancelBroadcast = async (req, res) => {
  try {
    const { broadcast, status, message } = await loadBroadcast(req.params.id);
    if (!broadcast) return fail(res, status, message);

    if (broadcast.isDispatched()) {
      return fail(res, 409, 'It has already gone out; close it or issue a correction');
    }

    broadcast.status = 'cancelled';
    broadcast.cancelledAt = new Date();
    broadcast.recordHistory('cancelled', req.user._id, req.body.note);
    await broadcast.save();

    return res.status(200).json({ success: true, message: 'Draft cancelled', data: broadcast });
  } catch (error) {
    return serverError(res, error, 'Failed to cancel the broadcast');
  }
};

// ---------------------------------------------------------------------------
// A recipient's own alerts
// ---------------------------------------------------------------------------

/** GET /api/broadcasts/mine */
exports.getMyAlerts = async (req, res) => {
  try {
    const receipts = await BroadcastReceipt.find({ recipient: req.user._id })
      .sort({ deliveredAt: -1 })
      .limit(100)
      .populate(
        'broadcast',
        'ref title body severity channels dispatchedAt status requiresAcknowledgement supersedes closureNote'
      );

    const live = receipts.filter((receipt) => receipt.isOutstanding());

    return res.status(200).json({
      success: true,
      count: receipts.length,
      data: {
        outstanding: live,
        all: receipts,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load your alerts');
  }
};

/**
 * PATCH /api/broadcasts/receipts/:id/acknowledge
 *
 * Only the recipient, and doing it twice is a no-op rather than an error —
 * during an incident people press things twice.
 */
exports.acknowledgeReceipt = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid receipt id');

    const receipt = await BroadcastReceipt.findById(req.params.id);
    if (!receipt) return fail(res, 404, 'Receipt not found');

    if (String(receipt.recipient) !== String(req.user._id)) {
      return fail(res, 403, 'That alert was sent to somebody else');
    }

    if (receipt.isAcknowledged()) {
      return res.status(200).json({ success: true, message: 'Already acknowledged', data: receipt });
    }

    const now = new Date();
    const nextState = receipt.acknowledgedStateAt(now);

    const updated = await BroadcastReceipt.findOneAndUpdate(
      { _id: receipt._id, state: { $in: OUTSTANDING_STATES } },
      { $set: { state: nextState, acknowledgedAt: now, note: req.body.note } },
      { new: true }
    );

    return res.status(200).json({
      success: true,
      message:
        nextState === 'acknowledged'
          ? 'Acknowledged'
          : nextState === 'acknowledged-late'
            ? 'Acknowledged, after the window'
            : 'Acknowledged, after it had been escalated',
      data: updated || receipt,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to acknowledge the alert');
  }
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** GET /api/broadcasts/stats */
exports.getStats = async (req, res) => {
  try {
    const live = await Broadcast.find({ status: 'dispatched' }).sort({ dispatchedAt: -1 });

    const open = [];
    for (const broadcast of live) {
      open.push({
        id: broadcast._id,
        ref: broadcast.ref,
        title: broadcast.title,
        severity: broadcast.severity,
        dispatchedAt: broadcast.dispatchedAt,
        counts: await countsFor(broadcast._id),
      });
    }

    const bySeverity = await Broadcast.aggregate([
      { $match: { status: { $ne: 'draft' } } },
      { $group: { _id: '$severity', count: { $sum: 1 } } },
    ]);

    return res.status(200).json({
      success: true,
      data: {
        open,
        bySeverity: bySeverity.reduce((acc, row) => ({ ...acc, [row._id]: row.count }), {}),
        // The number worth putting on a wall: people who have been escalated
        // and still have not answered.
        escalatedUnanswered: await BroadcastReceipt.countDocuments({ state: 'escalated' }),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load broadcast statistics');
  }
};
