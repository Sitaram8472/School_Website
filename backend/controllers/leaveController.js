// backend/controllers/leaveController.js
const mongoose = require('mongoose');
const LeaveRequest = require('../models/LeaveRequest');

const handleError = (res, err, message = 'Server error') => {
  console.error('[leaves]', err);
  return res.status(500).json({ success: false, message, error: err.message });
};

const getPagination = (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
};

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const isReviewer = (user) => user && ['teacher', 'admin', 'staff'].includes(user.role);

const toAttachment = (file) => ({
  fileName: file.originalname,
  fileUrl: `/uploads/${file.filename}`,
  fileType: (file.originalname.split('.').pop() || '').toLowerCase(),
  fileSize: file.size,
});

const parseDay = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
};

// ---- STUDENT ----

/**
 * POST /api/leaves
 * Submit a request. `totalDays` is derived by the model, so a client cannot
 * claim a two-day absence is half a day.
 */
exports.createLeaveRequest = async (req, res) => {
  try {
    const { type, reason, fromDate, toDate, isHalfDay, className, contactDuringLeave } = req.body;

    if (!type || !LeaveRequest.TYPES.includes(type)) {
      return res.status(400).json({
        success: false,
        message: `Leave type must be one of: ${LeaveRequest.TYPES.join(', ')}`,
      });
    }
    if (!reason || reason.trim().length < 10) {
      return res.status(400).json({
        success: false,
        message: 'Give at least 10 characters explaining the reason.',
      });
    }

    const from = parseDay(fromDate);
    const to = parseDay(toDate);

    if (!from || !to) {
      return res.status(400).json({ success: false, message: 'Provide a valid start and end date.' });
    }
    if (to.getTime() < from.getTime()) {
      return res.status(400).json({
        success: false,
        message: 'The end date cannot be before the start date.',
      });
    }

    // A student cannot hold two live requests covering the same days.
    const clash = await LeaveRequest.findOne({
      student: req.user._id,
      status: { $in: ['pending', 'approved'] },
      fromDate: { $lte: to },
      toDate: { $gte: from },
    });

    if (clash) {
      return res.status(409).json({
        success: false,
        message: `You already have a ${clash.status} request covering those dates.`,
      });
    }

    const leaveRequest = await LeaveRequest.create({
      student: req.user._id,
      studentName: req.user.name,
      className: className || req.user.className || '',
      type,
      reason: reason.trim(),
      fromDate: from,
      toDate: to,
      isHalfDay: isHalfDay === true || isHalfDay === 'true',
      contactDuringLeave: contactDuringLeave || '',
      attachments: (req.files || []).map(toAttachment),
      status: 'pending',
    });

    return res.status(201).json({
      success: true,
      message: 'Leave request submitted for approval.',
      data: leaveRequest,
    });
  } catch (err) {
    if (err.name === 'ValidationError' || err.userFacing === true) {
      return res.status(400).json({ success: false, message: err.message });
    }
    return handleError(res, err, 'Failed to submit leave request');
  }
};

/**
 * GET /api/leaves/me
 * The caller's own requests plus a summary of days taken. No id parameter, so
 * a student cannot read anyone else's record.
 */
exports.getMyLeaveRequests = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = { student: req.user._id };

    if (req.query.status && LeaveRequest.STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (req.query.type && LeaveRequest.TYPES.includes(req.query.type)) {
      filter.type = req.query.type;
    }

    const [requests, total] = await Promise.all([
      LeaveRequest.find(filter)
        .populate('reviewedBy', 'name')
        .sort({ fromDate: -1 })
        .skip(skip)
        .limit(limit),
      LeaveRequest.countDocuments(filter),
    ]);

    const [summary] = await LeaveRequest.aggregate([
      { $match: { student: req.user._id } },
      {
        $group: {
          _id: null,
          approvedDays: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, '$totalDays', 0] } },
          pendingDays: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, '$totalDays', 0] } },
          rejectedCount: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
          requestCount: { $sum: 1 },
        },
      },
    ]);

    return res.json({
      success: true,
      data: requests,
      summary: {
        approvedDays: summary?.approvedDays || 0,
        pendingDays: summary?.pendingDays || 0,
        rejectedCount: summary?.rejectedCount || 0,
        requestCount: summary?.requestCount || 0,
      },
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return handleError(res, err, 'Failed to load your leave requests');
  }
};

/**
 * PATCH /api/leaves/:id/withdraw
 * A student takes back a request they no longer need. Only a pending request
 * can be withdrawn — the lifecycle guard lives on the model.
 */
exports.withdrawLeaveRequest = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid request id.' });
    }

    const leaveRequest = await LeaveRequest.findById(req.params.id);
    if (!leaveRequest) {
      return res.status(404).json({ success: false, message: 'Leave request not found.' });
    }
    if (leaveRequest.student.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You can only withdraw your own requests.' });
    }
    if (!leaveRequest.canTransition('withdrawn')) {
      return res.status(409).json({
        success: false,
        message: `A ${leaveRequest.status} request cannot be withdrawn.`,
      });
    }

    leaveRequest.status = 'withdrawn';
    await leaveRequest.save();

    return res.json({ success: true, message: 'Leave request withdrawn.', data: leaveRequest });
  } catch (err) {
    return handleError(res, err, 'Failed to withdraw leave request');
  }
};

/**
 * GET /api/leaves/:id
 * Readable by the student who filed it and by any reviewer.
 */
exports.getLeaveRequest = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid request id.' });
    }

    const leaveRequest = await LeaveRequest.findById(req.params.id)
      .populate('student', 'name email')
      .populate('reviewedBy', 'name');

    if (!leaveRequest) {
      return res.status(404).json({ success: false, message: 'Leave request not found.' });
    }

    const ownsRequest = leaveRequest.student._id.toString() === req.user._id.toString();
    if (!ownsRequest && !isReviewer(req.user)) {
      return res.status(403).json({ success: false, message: 'You can only view your own requests.' });
    }

    return res.json({ success: true, data: leaveRequest });
  } catch (err) {
    return handleError(res, err, 'Failed to load leave request');
  }
};

// ---- REVIEWER ----

/**
 * GET /api/leaves
 * The approval queue. Defaults to pending requests, oldest first, because that
 * is the order a teacher works through them.
 */
exports.getLeaveRequests = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = {};

    if (req.query.status) {
      if (!LeaveRequest.STATUSES.includes(req.query.status)) {
        return res.status(400).json({ success: false, message: 'Invalid status filter.' });
      }
      filter.status = req.query.status;
    } else {
      filter.status = 'pending';
    }

    if (req.query.type && LeaveRequest.TYPES.includes(req.query.type)) {
      filter.type = req.query.type;
    }
    if (req.query.className) {
      filter.className = new RegExp(`^${req.query.className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    }
    if (req.query.search) {
      filter.studentName = new RegExp(req.query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    const from = req.query.from ? parseDay(req.query.from) : null;
    const to = req.query.to ? parseDay(req.query.to) : null;
    if (from && to) {
      filter.fromDate = { $lte: to };
      filter.toDate = { $gte: from };
    }

    const [requests, total] = await Promise.all([
      LeaveRequest.find(filter)
        .populate('student', 'name email')
        .populate('reviewedBy', 'name')
        .sort({ status: 1, fromDate: 1 })
        .skip(skip)
        .limit(limit),
      LeaveRequest.countDocuments(filter),
    ]);

    const pendingCount = await LeaveRequest.countDocuments({ status: 'pending' });

    return res.json({
      success: true,
      data: requests,
      pendingCount,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return handleError(res, err, 'Failed to load leave requests');
  }
};

/**
 * PATCH /api/leaves/:id/decision
 * Approve or reject. Both go through the same endpoint so the audit fields are
 * always written together.
 */
exports.decideLeaveRequest = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid request id.' });
    }

    const { decision, comment } = req.body;
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({
        success: false,
        message: 'Decision must be either "approved" or "rejected".',
      });
    }

    const leaveRequest = await LeaveRequest.findById(req.params.id);
    if (!leaveRequest) {
      return res.status(404).json({ success: false, message: 'Leave request not found.' });
    }

    if (!leaveRequest.canTransition(decision)) {
      return res.status(409).json({
        success: false,
        message: `This request has already been ${leaveRequest.status}.`,
      });
    }

    try {
      leaveRequest.decide(decision, req.user, comment);
    } catch (validationError) {
      return res.status(400).json({ success: false, message: validationError.message });
    }

    await leaveRequest.save();

    return res.json({
      success: true,
      message: `Leave request ${decision}.`,
      data: leaveRequest,
    });
  } catch (err) {
    return handleError(res, err, 'Failed to record the decision');
  }
};

/**
 * PATCH /api/leaves/:id/cancel
 * An administrator revoking an already-approved leave, e.g. because an exam
 * was rescheduled onto those days.
 */
exports.cancelLeaveRequest = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid request id.' });
    }

    const { comment } = req.body;
    if (!comment || !comment.trim()) {
      return res.status(400).json({ success: false, message: 'A reason is required to cancel a leave.' });
    }

    const leaveRequest = await LeaveRequest.findById(req.params.id);
    if (!leaveRequest) {
      return res.status(404).json({ success: false, message: 'Leave request not found.' });
    }
    if (!leaveRequest.canTransition('cancelled')) {
      return res.status(409).json({
        success: false,
        message: `A ${leaveRequest.status} request cannot be cancelled.`,
      });
    }

    leaveRequest.decide('cancelled', req.user, comment);
    await leaveRequest.save();

    return res.json({ success: true, message: 'Leave cancelled.', data: leaveRequest });
  } catch (err) {
    return handleError(res, err, 'Failed to cancel leave request');
  }
};

/**
 * GET /api/leaves/summary/student/:studentId
 * How much leave one student has taken, split by type — the number a teacher
 * wants before approving yet another day off.
 */
exports.getStudentLeaveSummary = async (req, res) => {
  try {
    if (!isValidId(req.params.studentId)) {
      return res.status(400).json({ success: false, message: 'Invalid student id.' });
    }

    const studentId = new mongoose.Types.ObjectId(req.params.studentId);

    const byType = await LeaveRequest.aggregate([
      { $match: { student: studentId, status: 'approved' } },
      { $group: { _id: '$type', days: { $sum: '$totalDays' }, count: { $sum: 1 } } },
      { $sort: { days: -1 } },
    ]);

    const [totals] = await LeaveRequest.aggregate([
      { $match: { student: studentId } },
      {
        $group: {
          _id: null,
          totalRequests: { $sum: 1 },
          approvedDays: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, '$totalDays', 0] } },
          pendingRequests: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
          rejectedRequests: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
        },
      },
    ]);

    return res.json({
      success: true,
      data: {
        studentId: req.params.studentId,
        totalRequests: totals?.totalRequests || 0,
        approvedDays: totals?.approvedDays || 0,
        pendingRequests: totals?.pendingRequests || 0,
        rejectedRequests: totals?.rejectedRequests || 0,
        byType,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Failed to build the leave summary');
  }
};

/**
 * GET /api/leaves/calendar
 * Approved leave for a class over a date range — who is away on which day.
 */
exports.getLeaveCalendar = async (req, res) => {
  try {
    const from = parseDay(req.query.from) || parseDay(new Date());
    const to = parseDay(req.query.to) || new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);

    const filter = {
      status: 'approved',
      fromDate: { $lte: to },
      toDate: { $gte: from },
    };

    if (req.query.className) {
      filter.className = new RegExp(`^${req.query.className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    }

    const requests = await LeaveRequest.find(filter)
      .populate('student', 'name')
      .sort({ fromDate: 1 });

    return res.json({
      success: true,
      range: { from, to },
      data: requests.map((request) => ({
        _id: request._id,
        studentName: request.student?.name || request.studentName,
        className: request.className,
        type: request.type,
        fromDate: request.fromDate,
        toDate: request.toDate,
        totalDays: request.totalDays,
      })),
    });
  } catch (err) {
    return handleError(res, err, 'Failed to build the leave calendar');
  }
};
