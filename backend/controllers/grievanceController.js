const mongoose = require('mongoose');

const Grievance = require('../models/Grievance');
const User = require('../models/User');

const HANDLER_ROLES = ['teacher', 'staff', 'admin'];

const fail = (res, error, fallbackStatus = 400) => {
  if (error && error.name === 'ValidationError') {
    const messages = Object.values(error.errors).map((e) => e.message);
    return res.status(400).json({ success: false, message: messages.join(', ') });
  }

  if (error && error.code === 11000) {
    return res.status(409).json({ success: false, message: 'That ticket already exists' });
  }

  if (error && error.userFacing) {
    return res
      .status(error.statusCode || fallbackStatus)
      .json({ success: false, message: error.message });
  }

  console.error('[Grievance]', error);
  return res.status(500).json({ success: false, message: 'Something went wrong on our side' });
};

const makeError = (message, statusCode) => {
  const error = new Error(message);
  error.userFacing = true;
  error.statusCode = statusCode;
  return error;
};

const badRequest = (message) => makeError(message, 400);
const forbidden = (message) => makeError(message, 403);
const notFound = (message) => makeError(message, 404);
const conflict = (message) => makeError(message, 409);

const isHandler = (user) => HANDLER_ROLES.includes(user?.role);
const viewerId = (req) => String(req.user.id || req.user._id);

const assertObjectId = (value, label = 'id') => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw badRequest(`Invalid ${label}`);
  }
  return value;
};

/**
 * A reporter may read their own ticket; the committee may read any. Note this
 * checks the *link*, not the displayed name — an anonymous ticket is still
 * owned by its reporter, they just are not named on it.
 */
const assertMayView = (req, grievance) => {
  if (isHandler(req.user)) return;
  if (String(grievance.raisedBy) === viewerId(req)) return;

  throw forbidden('You can only view your own tickets');
};

// ---------------------------------------------------------------------------
// Raising and reading
// ---------------------------------------------------------------------------

exports.raiseGrievance = async (req, res) => {
  try {
    const { category, subject, description, priority, isAnonymous, className } = req.body;

    const reporter = await User.findById(viewerId(req)).select('name role');
    if (!reporter) throw notFound('Reporter not found');

    // The ticket id is generated here, never taken from the body. On the rare
    // race where two tickets claim the same number the unique index rejects the
    // second and we simply take the next one.
    let grievance;
    let attempt = 0;

    while (attempt < 5) {
      attempt += 1;

      const ticketId = await Grievance.nextTicketId();

      grievance = new Grievance({
        ticketId,
        category,
        subject,
        description,
        priority: priority || 'medium',
        isAnonymous: Boolean(isAnonymous),
        raisedBy: reporter._id,
        raisedByName: reporter.name,
        className: className || '',
        status: 'open',
      });

      grievance.appendAudit('raised', isAnonymous ? { name: 'Anonymous' } : reporter, {
        toStatus: 'open',
      });

      try {
        await grievance.save();
        break;
      } catch (error) {
        const isDuplicateTicketId = error.code === 11000 && attempt < 5;
        if (!isDuplicateTicketId) throw error;
      }
    }

    return res.status(201).json({
      success: true,
      message: `Your ticket ${grievance.ticketId} has been raised`,
      data: grievance.redactFor(req.user),
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getMyGrievances = async (req, res) => {
  try {
    const grievances = await Grievance.find({ raisedBy: viewerId(req) })
      .sort({ createdAt: -1 })
      .limit(100);

    const data = grievances.map((g) => g.redactFor(req.user));

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
      summary: {
        total: grievances.length,
        open: grievances.filter((g) => g.isOpen).length,
        resolved: grievances.filter((g) => g.status === 'resolved').length,
        closed: grievances.filter((g) => g.status === 'closed').length,
      },
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getGrievance = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'ticket id');

    const grievance = await Grievance.findById(req.params.id)
      .populate('assignedTo', 'name email')
      .populate('resolvedBy', 'name');

    if (!grievance) throw notFound('Ticket not found');

    assertMayView(req, grievance);

    return res.status(200).json({ success: true, data: grievance.redactFor(req.user) });
  } catch (error) {
    return fail(res, error);
  }
};

/**
 * The committee queue. Defaults to open tickets sorted by how close they are to
 * breaching their SLA, which is the order the work should actually be done in.
 */
exports.getGrievanceQueue = async (req, res) => {
  try {
    const { status, category, priority, overdue, assignedToMe, limit = 100, page = 1 } = req.query;

    const filter = {};

    if (status) {
      filter.status = status;
    } else {
      filter.status = { $nin: ['closed', 'rejected'] };
    }

    if (category) filter.category = category;
    if (priority) filter.priority = priority;
    if (assignedToMe === 'true') filter.assignedTo = viewerId(req);

    if (overdue === 'true') {
      filter.dueBy = { $lt: new Date() };
      filter.status = { $nin: ['resolved', 'closed', 'rejected'] };
    }

    const perPage = Math.min(Number(limit) || 100, 200);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * perPage;

    const grievances = await Grievance.find(filter)
      .sort({ dueBy: 1, createdAt: 1 })
      .skip(skip)
      .limit(perPage)
      .populate('assignedTo', 'name');

    const total = await Grievance.countDocuments(filter);

    return res.status(200).json({
      success: true,
      count: grievances.length,
      total,
      data: grievances.map((g) => g.redactFor(req.user)),
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ---------------------------------------------------------------------------
// Handling
// ---------------------------------------------------------------------------

exports.acknowledgeGrievance = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'ticket id');

    const grievance = await Grievance.findById(req.params.id);
    if (!grievance) throw notFound('Ticket not found');

    grievance.moveTo('acknowledged', req.user, req.body.note || '');
    await grievance.save();

    return res.status(200).json({ success: true, data: grievance.redactFor(req.user) });
  } catch (error) {
    return fail(res, error);
  }
};

exports.assignGrievance = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'ticket id');
    assertObjectId(req.body.assigneeId, 'assignee id');

    const grievance = await Grievance.findById(req.params.id);
    if (!grievance) throw notFound('Ticket not found');

    const assignee = await User.findById(req.body.assigneeId).select('name role');
    if (!assignee) throw notFound('Assignee not found');

    if (!HANDLER_ROLES.includes(assignee.role)) {
      throw badRequest('A ticket can only be assigned to a teacher, staff member or admin');
    }

    grievance.assignedTo = assignee._id;
    grievance.assignedToName = assignee.name;
    grievance.assignedAt = new Date();

    grievance.appendAudit('assigned', req.user, { note: `Assigned to ${assignee.name}` });

    // Picking the ticket up is what "in progress" means, so assignment moves it
    // there when it is still sitting untouched.
    if (['open', 'acknowledged'].includes(grievance.status)) {
      grievance.moveTo('in-progress', req.user, `Assigned to ${assignee.name}`);
    }

    await grievance.save();

    return res.status(200).json({ success: true, data: grievance.redactFor(req.user) });
  } catch (error) {
    return fail(res, error);
  }
};

exports.addComment = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'ticket id');

    const { body, isInternal } = req.body;
    if (!body || !String(body).trim()) {
      throw badRequest('A comment cannot be empty');
    }

    const grievance = await Grievance.findById(req.params.id);
    if (!grievance) throw notFound('Ticket not found');

    assertMayView(req, grievance);

    // Only someone handling the ticket can leave an internal note; a reporter
    // marking their own comment internal would be meaningless.
    const internal = Boolean(isInternal) && isHandler(req.user);

    // An anonymous reporter stays anonymous in their own follow-ups.
    const anonymousReporter =
      grievance.isAnonymous && String(grievance.raisedBy) === viewerId(req);

    grievance.comments.push({
      author: viewerId(req),
      authorName: anonymousReporter ? 'Anonymous' : req.user.name || '',
      body: String(body).trim(),
      isInternal: internal,
    });

    grievance.markModified('comments');
    await grievance.save();

    return res.status(201).json({ success: true, data: grievance.redactFor(req.user) });
  } catch (error) {
    return fail(res, error);
  }
};

exports.escalateGrievance = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'ticket id');

    const grievance = await Grievance.findById(req.params.id);
    if (!grievance) throw notFound('Ticket not found');

    grievance.escalate(req.user, req.body.note || 'Escalated by the redressal committee');
    await grievance.save();

    return res.status(200).json({
      success: true,
      message: `Escalated to level ${grievance.escalationLevel}`,
      data: grievance.redactFor(req.user),
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.resolveGrievance = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'ticket id');

    const { resolution } = req.body;
    if (!resolution || !String(resolution).trim()) {
      throw badRequest('Say what was done — a resolution note is required');
    }

    const grievance = await Grievance.findById(req.params.id);
    if (!grievance) throw notFound('Ticket not found');

    grievance.resolution = String(resolution).trim();
    grievance.resolvedAt = new Date();
    grievance.resolvedBy = viewerId(req);

    grievance.moveTo('resolved', req.user, 'Resolved');
    await grievance.save();

    return res.status(200).json({ success: true, data: grievance.redactFor(req.user) });
  } catch (error) {
    return fail(res, error);
  }
};

exports.rejectGrievance = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'ticket id');

    const { reason } = req.body;
    if (!reason || !String(reason).trim()) {
      throw badRequest('Rejecting a ticket requires a reason the reporter can read');
    }

    const grievance = await Grievance.findById(req.params.id);
    if (!grievance) throw notFound('Ticket not found');

    grievance.comments.push({
      author: viewerId(req),
      authorName: req.user.name || '',
      body: String(reason).trim(),
      isInternal: false,
    });

    grievance.moveTo('rejected', req.user, String(reason).trim());
    await grievance.save();

    return res.status(200).json({ success: true, data: grievance.redactFor(req.user) });
  } catch (error) {
    return fail(res, error);
  }
};

exports.closeGrievance = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'ticket id');

    const grievance = await Grievance.findById(req.params.id);
    if (!grievance) throw notFound('Ticket not found');

    grievance.moveTo('closed', req.user, req.body.note || 'Closed');
    await grievance.save();

    return res.status(200).json({ success: true, data: grievance.redactFor(req.user) });
  } catch (error) {
    return fail(res, error);
  }
};

// ---------------------------------------------------------------------------
// Reporter actions
// ---------------------------------------------------------------------------

exports.reopenGrievance = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'ticket id');

    const grievance = await Grievance.findById(req.params.id);
    if (!grievance) throw notFound('Ticket not found');

    if (!grievance.canBeReopenedBy(viewerId(req))) {
      throw conflict(
        'This ticket cannot be reopened — it is either closed, not yours, or past the reopen window'
      );
    }

    grievance.reopenCount += 1;
    grievance.resolvedAt = null;

    grievance.moveTo('in-progress', req.user, req.body.reason || 'Reopened by the reporter');
    await grievance.save();

    return res.status(200).json({ success: true, data: grievance.redactFor(req.user) });
  } catch (error) {
    return fail(res, error);
  }
};

exports.rateResolution = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'ticket id');

    const rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw badRequest('Give a rating from 1 to 5');
    }

    const grievance = await Grievance.findById(req.params.id);
    if (!grievance) throw notFound('Ticket not found');

    // Only the person who raised it can say whether it was handled well.
    if (String(grievance.raisedBy) !== viewerId(req)) {
      throw forbidden('Only the reporter can rate this resolution');
    }

    if (!['resolved', 'closed'].includes(grievance.status)) {
      throw conflict('You can only rate a ticket once it has been resolved');
    }

    grievance.satisfactionRating = rating;
    grievance.appendAudit('rated', req.user, { note: `Rated ${rating}/5` });

    await grievance.save();

    return res.status(200).json({ success: true, data: grievance.redactFor(req.user) });
  } catch (error) {
    return fail(res, error);
  }
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

exports.getGrievanceStats = async (req, res) => {
  try {
    const all = await Grievance.find({}).select(
      'category status priority dueBy createdAt resolvedAt satisfactionRating escalationLevel'
    );

    const byCategory = new Map();
    all.forEach((g) => {
      const entry = byCategory.get(g.category) || { category: g.category, total: 0, open: 0 };
      entry.total += 1;
      if (g.isOpen) entry.open += 1;
      byCategory.set(g.category, entry);
    });

    const resolved = all.filter((g) => g.resolvedAt);
    const averageResolutionHours = resolved.length
      ? Math.round(
          resolved.reduce((sum, g) => sum + (g.resolutionHours || 0), 0) / resolved.length
        )
      : null;

    const rated = all.filter((g) => g.satisfactionRating !== null);
    const averageRating = rated.length
      ? Number(
          (rated.reduce((sum, g) => sum + g.satisfactionRating, 0) / rated.length).toFixed(1)
        )
      : null;

    return res.status(200).json({
      success: true,
      data: {
        total: all.length,
        open: all.filter((g) => g.isOpen).length,
        overdue: all.filter((g) => g.isOverdue).length,
        escalated: all.filter((g) => g.escalationLevel > 0).length,
        resolved: all.filter((g) => g.status === 'resolved').length,
        closed: all.filter((g) => g.status === 'closed').length,
        anonymousShare: all.length
          ? Math.round((all.filter((g) => g.isAnonymous).length / all.length) * 100)
          : 0,
        averageResolutionHours,
        averageRating,
        byCategory: [...byCategory.values()].sort((a, b) => b.total - a.total),
      },
    });
  } catch (error) {
    return fail(res, error);
  }
};

/**
 * Sweeps for tickets that have blown their SLA and escalates them. Intended to
 * be driven by a scheduler, but exposed so the committee can run it on demand —
 * an escalation that only happens when someone remembers is not an escalation.
 */
exports.escalateOverdue = async (req, res) => {
  try {
    const overdue = await Grievance.find({
      dueBy: { $lt: new Date() },
      status: { $nin: ['resolved', 'closed', 'rejected', 'escalated'] },
    });

    const escalated = [];

    for (const grievance of overdue) {
      try {
        grievance.escalate(req.user, 'Escalated automatically — SLA breached');
        await grievance.save();
        escalated.push(grievance.ticketId);
      } catch (error) {
        console.error(`[Grievance] could not escalate ${grievance.ticketId}:`, error.message);
      }
    }

    return res.status(200).json({
      success: true,
      message: escalated.length
        ? `Escalated ${escalated.length} overdue ticket(s)`
        : 'No tickets are past their SLA',
      data: escalated,
    });
  } catch (error) {
    return fail(res, error);
  }
};
