const mongoose = require('mongoose');
const Inquiry = require('../models/Inquiry');
const InquiryCallback = require('../models/InquiryCallback');
const User = require('../models/User');

/**
 * The follow-up half of the enquiry form.
 *
 * `createInquiry` writes a row and returns. Nothing reads it back — there was
 * no GET route on `/api/inquiries` at all — so the read side is added here too,
 * because a follow-up queue built on records nobody can fetch is not usable.
 *
 * Everything in this file is staff-only and applies `protect` at the individual
 * route. `router.use(protect)` on that file would put authentication in front
 * of the public contact form and take the website down, which is the one thing
 * in this change that must not be got wrong.
 *
 * The SLA deadline is derived from the enquiry's own `createdAt` and frozen at
 * creation. Reassignment does not restart it.
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

function created(res, data) {
  return res.status(201).json({ success: true, data });
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
    return 'Somebody is already handling this enquiry. Only one callback can be open at a time.';
  }
  return null;
}

function isAdmin(user) {
  return user && user.role === 'admin';
}

/**
 * A callback as the queue renders it.
 *
 * `overdue` and `hoursRemaining` are derived on every read from `dueBy` and the
 * clock, and `firstResponseHours` is measured to the first attempt rather than
 * to closure.
 */
function callbackRow(callback, now = new Date()) {
  const overdue = callback.overdueState(now);

  return {
    _id: callback._id,
    inquiry: callback.inquiry,
    department: callback.department,
    contactName: callback.contactName,
    contactEmail: callback.contactEmail,
    phone: callback.phone,
    askedAt: callback.askedAt,
    dueBy: callback.dueBy,
    slaHours: callback.slaHours,
    assignedTo: callback.assignedTo,
    assignedAt: callback.assignedAt,
    scheduledFor: callback.scheduledFor,
    channel: callback.channel,
    status: callback.status,
    outcome: callback.outcome,
    duplicateOf: callback.duplicateOf,
    reopenedFrom: callback.reopenedFrom,
    closedAt: callback.closedAt,
    closeNote: callback.closeNote,
    isOpen: callback.isOpen,

    attempts: callback.attempts.map((attempt) => ({
      _id: attempt._id,
      at: attempt.at,
      byName: attempt.byName,
      channel: attempt.channel,
      outcome: attempt.outcome,
      note: attempt.note,
    })),
    attemptCount: callback.attempts.length,
    distinctAttemptDays: callback.distinctAttemptDays(),

    // Derived, every time.
    overdue: overdue.overdue,
    breached: overdue.breached,
    hoursRemaining: overdue.hoursRemaining,
    firstResponseHours: callback.firstResponseHours(),

    // Surfaced so the panel can disable the button *and* say why, rather than
    // offering an action the server will refuse.
    unreachableBlockedReason: callback.isOpen ? callback.unreachableBlockedReason() : null,

    history: callback.history,
    createdAt: callback.createdAt,
  };
}

/* ------------------------------------------------------------------------- *
 * The read side Inquiry never had
 * ------------------------------------------------------------------------- */

exports.getCallbackMeta = async (req, res) => {
  try {
    return ok(res, {
      statuses: InquiryCallback.STATUSES,
      channels: InquiryCallback.CHANNELS,
      attemptOutcomes: InquiryCallback.ATTEMPT_OUTCOMES,
      outcomes: InquiryCallback.OUTCOMES,
      departmentSlaHours: InquiryCallback.DEPARTMENT_SLA_HOURS,
      minAttemptsForUnreachable: InquiryCallback.MIN_ATTEMPTS_FOR_UNREACHABLE,
      minDistinctDaysForUnreachable: InquiryCallback.MIN_DISTINCT_DAYS_FOR_UNREACHABLE,
      workingDay: {
        start: InquiryCallback.WORKING_DAY_START,
        end: InquiryCallback.WORKING_DAY_END,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Could not load the callback options');
  }
};

/**
 * List enquiries, with whether anything has been done about each.
 *
 * `untouched` is the filter the whole read side exists for: the enquiries with
 * no callback at all, which until now were invisible and are the ones actually
 * being dropped.
 */
exports.listInquiries = async (req, res) => {
  try {
    const { department, state, page = 1, limit = 25 } = req.query;

    const filter = {};
    if (department) filter.department = department;

    const perPage = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * perPage;

    const [inquiries, total] = await Promise.all([
      Inquiry.find(filter).sort({ createdAt: -1 }).skip(skip).limit(perPage).lean(),
      Inquiry.countDocuments(filter),
    ]);

    const callbacks = await InquiryCallback.find({
      inquiry: { $in: inquiries.map((inquiry) => inquiry._id) },
    }).sort({ createdAt: -1 });

    const byInquiry = new Map();
    callbacks.forEach((callback) => {
      const key = String(callback.inquiry);
      if (!byInquiry.has(key)) byInquiry.set(key, []);
      byInquiry.get(key).push(callback);
    });

    const now = new Date();

    let rows = inquiries.map((inquiry) => {
      const related = byInquiry.get(String(inquiry._id)) || [];
      const open = related.find((callback) => callback.isOpen) || null;

      const { dueBy } = InquiryCallback.deadlineFor(inquiry.createdAt, inquiry.department);

      return {
        ...inquiry,
        callbacks: related.map((callback) => callbackRow(callback, now)),
        openCallback: open ? callbackRow(open, now) : null,
        // An enquiry with no callback is still on the clock. Showing the
        // deadline it would have had is the only way an untouched enquiry
        // appears as late rather than as absent.
        wouldBeDueBy: dueBy,
        untouched: related.length === 0,
        lateAndUntouched: related.length === 0 && dueBy < now,
      };
    });

    if (state === 'untouched') rows = rows.filter((row) => row.untouched);
    if (state === 'open') rows = rows.filter((row) => row.openCallback);
    if (state === 'overdue') {
      rows = rows.filter((row) => row.lateAndUntouched || row.openCallback?.overdue);
    }

    return ok(res, rows, { total, page: Number(page) || 1, limit: perPage });
  } catch (error) {
    return serverError(res, error, 'Could not load the enquiries');
  }
};

exports.getInquiry = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'That enquiry id is not valid');

    const inquiry = await Inquiry.findById(id).lean();
    if (!inquiry) return fail(res, 404, 'That enquiry does not exist');

    const callbacks = await InquiryCallback.find({ inquiry: id }).sort({ createdAt: -1 });
    const now = new Date();

    return ok(res, {
      ...inquiry,
      callbacks: callbacks.map((callback) => callbackRow(callback, now)),
    });
  } catch (error) {
    return serverError(res, error, 'Could not load that enquiry');
  }
};

/* ------------------------------------------------------------------------- *
 * Callbacks
 * ------------------------------------------------------------------------- */

exports.createCallback = async (req, res) => {
  try {
    const { inquiryId, phone, assignedTo, channel, scheduledFor, reopenedFrom } = req.body;

    if (!isValidId(inquiryId)) return fail(res, 400, 'That enquiry id is not valid');

    const inquiry = await Inquiry.findById(inquiryId);
    if (!inquiry) return fail(res, 404, 'That enquiry does not exist');

    // Measured from when the parent asked. Not from now.
    const { dueBy, slaHours } = InquiryCallback.deadlineFor(
      inquiry.createdAt,
      inquiry.department
    );

    const callback = new InquiryCallback({
      inquiry: inquiry._id,
      department: inquiry.department,
      contactName: inquiry.name,
      contactEmail: inquiry.email,
      phone: phone || '',
      askedAt: inquiry.createdAt,
      dueBy,
      slaHours,
      channel: channel || 'phone',
      reopenedFrom: reopenedFrom && isValidId(reopenedFrom) ? reopenedFrom : null,
    });

    callback.recordHistory({
      action: 'opened',
      to: 'open',
      note: reopenedFrom ? 'reopened' : '',
      by: req.user._id,
      byName: req.user.name,
    });

    if (assignedTo && isValidId(assignedTo)) {
      const assignee = await User.findById(assignedTo).select('name');
      if (assignee) callback.assignTo(assignee._id, assignee.name, req.user);
    }

    if (scheduledFor) callback.schedule(req.user, scheduledFor, channel);

    await callback.save();

    return created(res, callbackRow(callback));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 409, message);
    return fail(res, 400, error.message);
  }
};

exports.assignCallback = async (req, res) => {
  try {
    const { id } = req.params;
    const { assignedTo } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'That callback id is not valid');
    if (!isValidId(assignedTo)) return fail(res, 400, 'That member of staff id is not valid');

    const callback = await InquiryCallback.findById(id);
    if (!callback) return fail(res, 404, 'That callback does not exist');

    if (!callback.isOpen) return fail(res, 400, `A ${callback.status} callback cannot be reassigned`);

    const assignee = await User.findById(assignedTo).select('name role');
    if (!assignee) return fail(res, 404, 'That member of staff does not exist');

    const before = callback.dueBy.getTime();

    callback.assignTo(assignee._id, assignee.name, req.user);
    await callback.save();

    // Belt and braces on the one property most likely to regress: the clock
    // must not restart because the work moved desk.
    if (callback.dueBy.getTime() !== before) {
      return fail(res, 500, 'Reassignment must not change the deadline');
    }

    return ok(res, callbackRow(callback));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

exports.recordAttempt = async (req, res) => {
  try {
    const { id } = req.params;
    const { outcome, note, channel, at } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'That callback id is not valid');

    const callback = await InquiryCallback.findById(id);
    if (!callback) return fail(res, 404, 'That callback does not exist');

    callback.recordAttempt(req.user, { outcome, note, channel, at });
    await callback.save();

    return ok(res, callbackRow(callback));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

exports.scheduleCallback = async (req, res) => {
  try {
    const { id } = req.params;
    const { scheduledFor, channel } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'That callback id is not valid');

    const callback = await InquiryCallback.findById(id);
    if (!callback) return fail(res, 404, 'That callback does not exist');

    callback.schedule(req.user, scheduledFor, channel);
    await callback.save();

    return ok(res, callbackRow(callback));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

exports.closeCallback = async (req, res) => {
  try {
    const { id } = req.params;
    const { outcome, note, duplicateOf } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'That callback id is not valid');

    const callback = await InquiryCallback.findById(id);
    if (!callback) return fail(res, 404, 'That callback does not exist');

    if (duplicateOf && !isValidId(duplicateOf)) {
      return fail(res, 400, 'That duplicate callback id is not valid');
    }

    callback.close(req.user, { outcome, note, duplicateOf });
    await callback.save();

    return ok(res, callbackRow(callback));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

/**
 * Give up on reaching them — but only with the attempts to show for it.
 */
exports.markUnreachable = async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'That callback id is not valid');

    const callback = await InquiryCallback.findById(id);
    if (!callback) return fail(res, 404, 'That callback does not exist');

    callback.markUnreachable(req.user, note);
    await callback.save();

    return ok(res, callbackRow(callback));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

/**
 * They came back.
 *
 * A new callback carrying `reopenedFrom`, never a status flip on the old one,
 * so the first conversation keeps its own dates and its own outcome.
 */
exports.reopenCallback = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) return fail(res, 400, 'That callback id is not valid');

    const previous = await InquiryCallback.findById(id);
    if (!previous) return fail(res, 404, 'That callback does not exist');

    if (previous.isOpen) {
      return fail(res, 400, 'That callback is still open');
    }

    const inquiry = await Inquiry.findById(previous.inquiry);
    if (!inquiry) return fail(res, 404, 'The original enquiry no longer exists');

    // The new callback gets its own clock, starting now, because the parent
    // has asked again. Inheriting the original deadline would make it born
    // overdue for a conversation that has only just started.
    const now = new Date();
    const { dueBy, slaHours } = InquiryCallback.deadlineFor(now, inquiry.department);

    const callback = new InquiryCallback({
      inquiry: previous.inquiry,
      department: previous.department,
      contactName: previous.contactName,
      contactEmail: previous.contactEmail,
      phone: previous.phone,
      askedAt: now,
      dueBy,
      slaHours,
      channel: previous.channel,
      reopenedFrom: previous._id,
    });

    callback.recordHistory({
      action: 'reopened',
      from: previous.outcome || previous.status,
      to: 'open',
      by: req.user._id,
      byName: req.user.name,
    });

    await callback.save();

    return created(res, callbackRow(callback));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 409, message);
    return fail(res, 400, error.message);
  }
};

exports.listCallbacks = async (req, res) => {
  try {
    const { status, department, mine, overdue } = req.query;

    const filter = {};
    if (status && InquiryCallback.STATUSES.includes(status)) filter.status = status;
    if (department) filter.department = department;
    if (mine === 'true') filter.assignedTo = req.user._id;

    const callbacks = await InquiryCallback.find(filter).sort({ dueBy: 1 }).limit(300);

    const now = new Date();
    let rows = callbacks.map((callback) => callbackRow(callback, now));

    if (overdue === 'true') rows = rows.filter((row) => row.overdue);

    return ok(res, rows, { total: rows.length });
  } catch (error) {
    return serverError(res, error, 'Could not load the callback queue');
  }
};

exports.getCallback = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'That callback id is not valid');

    const callback = await InquiryCallback.findById(id);
    if (!callback) return fail(res, 404, 'That callback does not exist');

    return ok(res, callbackRow(callback));
  } catch (error) {
    return serverError(res, error, 'Could not load that callback');
  }
};

/**
 * How quickly the school actually responds.
 *
 * Measured to the first recorded attempt, and reported with the count of
 * enquiries nobody attempted at all — an average over only the ones somebody
 * got to is an average of the good ones.
 */
exports.getResponseStats = async (req, res) => {
  try {
    const { since } = req.query;

    const stats = await InquiryCallback.responseStats(since);

    // The enquiries with no callback at all never reach `responseStats`,
    // because there is no callback row to find them by. They are the ones most
    // worth counting, so they are counted here.
    const untouched = await Inquiry.aggregate([
      {
        $lookup: {
          from: 'inquirycallbacks',
          localField: '_id',
          foreignField: 'inquiry',
          as: 'callbacks',
        },
      },
      { $match: { callbacks: { $size: 0 } } },
      { $group: { _id: '$department', count: { $sum: 1 } } },
    ]);

    return ok(res, {
      byDepartment: stats,
      neverPickedUp: untouched.map((row) => ({ department: row._id, count: row.count })),
      measuredTo: 'first-attempt',
      note:
        'First-response time is measured to the first recorded attempt, not to closure. ' +
        'An enquiry closed as out-of-scope in thirty seconds is not good service.',
    });
  } catch (error) {
    return serverError(res, error, 'Could not build the response statistics');
  }
};
