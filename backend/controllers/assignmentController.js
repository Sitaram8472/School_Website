// backend/controllers/assignmentController.js
const mongoose = require('mongoose');
const Assignment = require('../models/Assignment');
const AssignmentSubmission = require('../models/AssignmentSubmission');

// Reusable error handler, matching the convention in teacherController.js
const handleError = (res, err, message = 'Server error') => {
  console.error('[assignments]', err);
  return res.status(500).json({ success: false, message, error: err.message });
};

const getPagination = (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
  return { page, limit, skip: (page - 1) * limit };
};

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

/**
 * Mongoose virtuals are not carried onto `.lean()` results, so the two derived
 * deadline fields are recomputed here for list endpoints (which use `.lean()`
 * for speed). Kept in one place so the rule cannot drift from the model.
 */
const withDeadlineInfo = (assignment) => {
  const msPerDay = 24 * 60 * 60 * 1000;
  const due = assignment.dueDate ? new Date(assignment.dueDate) : null;

  if (!due) {
    return { ...assignment, isOverdue: false, daysRemaining: null };
  }

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const dueDay = new Date(due);
  dueDay.setHours(0, 0, 0, 0);

  return {
    ...assignment,
    isOverdue:
      assignment.status !== 'draft' && assignment.status !== 'archived' && due.getTime() < Date.now(),
    daysRemaining: Math.round((dueDay.getTime() - startOfToday.getTime()) / msPerDay),
  };
};

// Turn an uploaded multer file into the attachment sub-document shape.
const toAttachment = (file) => ({
  fileName: file.originalname,
  fileUrl: `/uploads/${file.filename}`,
  fileType: (file.originalname.split('.').pop() || '').toLowerCase(),
  fileSize: file.size,
});

/**
 * A student sees an assignment when it is published and either targeted at
 * everyone or at their own class. `targetClass` is a free-text field today, so
 * the match is case-insensitive to survive "Class 10" vs "class 10".
 */
const studentVisibilityFilter = (req) => {
  const filter = { status: 'published', deletedAt: null };
  const studentClass = req.query.className || req.user.className;

  if (studentClass) {
    filter.$or = [
      { targetClass: 'All Classes' },
      { targetClass: 'All' },
      { targetClass: new RegExp(`^${studentClass.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    ];
  }

  return filter;
};

// ---- TEACHER: AUTHORING ----

/**
 * POST /api/assignments
 * Create an assignment. Defaults to `draft` so a half-written assignment is
 * never visible to students.
 */
exports.createAssignment = async (req, res) => {
  try {
    const {
      title,
      description,
      instructions,
      subject,
      course,
      targetClass,
      dueDate,
      maxPoints,
      allowLateSubmission,
      status,
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: 'Title is required.' });
    }
    if (!description || !description.trim()) {
      return res.status(400).json({ success: false, message: 'Description is required.' });
    }
    if (!subject || !subject.trim()) {
      return res.status(400).json({ success: false, message: 'Subject is required.' });
    }
    if (!dueDate) {
      return res.status(400).json({ success: false, message: 'Due date is required.' });
    }

    const parsedDue = new Date(dueDate);
    if (Number.isNaN(parsedDue.getTime())) {
      return res.status(400).json({ success: false, message: 'Due date is not a valid date.' });
    }

    const requestedStatus = status === 'published' ? 'published' : 'draft';

    // Only block past deadlines when the teacher publishes immediately; a draft
    // may legitimately be back-dated while it is being prepared.
    if (requestedStatus === 'published' && parsedDue.getTime() < Date.now()) {
      return res.status(400).json({
        success: false,
        message: 'Cannot publish an assignment whose due date is already in the past.',
      });
    }

    if (course && !isValidId(course)) {
      return res.status(400).json({ success: false, message: 'Invalid course id.' });
    }

    const assignment = await Assignment.create({
      title: title.trim(),
      description: description.trim(),
      instructions: instructions ? instructions.trim() : '',
      subject: subject.trim(),
      course: course || null,
      targetClass: targetClass || 'All Classes',
      dueDate: parsedDue,
      maxPoints: maxPoints ? Number(maxPoints) : 100,
      allowLateSubmission: allowLateSubmission !== false,
      status: requestedStatus,
      publishedAt: requestedStatus === 'published' ? new Date() : null,
      createdBy: req.user._id,
      teacherName: req.user.name,
      attachments: (req.files || []).map(toAttachment),
    });

    return res.status(201).json({
      success: true,
      message: requestedStatus === 'published' ? 'Assignment published.' : 'Assignment saved as draft.',
      data: assignment,
    });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: err.message });
    }
    return handleError(res, err, 'Failed to create assignment');
  }
};

/**
 * GET /api/assignments/mine
 * Every assignment the calling teacher owns, with a live submission count so
 * the dashboard does not need an extra request per row.
 */
exports.getMyAssignments = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = { createdBy: req.user._id, deletedAt: null };

    if (req.query.status && Assignment.STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (req.query.subject) {
      filter.subject = new RegExp(req.query.subject, 'i');
    }
    if (req.query.search) {
      filter.title = new RegExp(req.query.search, 'i');
    }

    const [assignments, total] = await Promise.all([
      Assignment.find(filter).sort({ dueDate: 1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Assignment.countDocuments(filter),
    ]);

    const ids = assignments.map((a) => a._id);
    const counts = await AssignmentSubmission.aggregate([
      { $match: { assignment: { $in: ids } } },
      {
        $group: {
          _id: '$assignment',
          submissionCount: { $sum: 1 },
          gradedCount: { $sum: { $cond: [{ $eq: ['$status', 'graded'] }, 1, 0] } },
        },
      },
    ]);

    const countMap = new Map(counts.map((c) => [c._id.toString(), c]));
    const enriched = assignments.map((a) => ({
      ...withDeadlineInfo(a),
      submissionCount: countMap.get(a._id.toString())?.submissionCount || 0,
      gradedCount: countMap.get(a._id.toString())?.gradedCount || 0,
    }));

    return res.json({
      success: true,
      data: enriched,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return handleError(res, err, 'Failed to load assignments');
  }
};

/**
 * PUT /api/assignments/:id
 * Update an assignment the caller owns. Status transitions go through the
 * dedicated publish/close endpoints so the timestamps stay consistent.
 */
exports.updateAssignment = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid assignment id.' });
    }

    const assignment = await Assignment.findOne({ _id: req.params.id, deletedAt: null });
    if (!assignment) {
      return res.status(404).json({ success: false, message: 'Assignment not found.' });
    }
    if (!assignment.isEditableBy(req.user)) {
      return res.status(403).json({ success: false, message: 'You can only edit your own assignments.' });
    }

    const editable = [
      'title',
      'description',
      'instructions',
      'subject',
      'targetClass',
      'maxPoints',
      'allowLateSubmission',
    ];

    editable.forEach((field) => {
      if (req.body[field] !== undefined) {
        assignment[field] = req.body[field];
      }
    });

    if (req.body.dueDate !== undefined) {
      const parsedDue = new Date(req.body.dueDate);
      if (Number.isNaN(parsedDue.getTime())) {
        return res.status(400).json({ success: false, message: 'Due date is not a valid date.' });
      }
      assignment.dueDate = parsedDue;
    }

    if (req.files && req.files.length > 0) {
      assignment.attachments.push(...req.files.map(toAttachment));
    }

    await assignment.save();

    return res.json({ success: true, message: 'Assignment updated.', data: assignment });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: err.message });
    }
    return handleError(res, err, 'Failed to update assignment');
  }
};

/**
 * PATCH /api/assignments/:id/status
 * Single entry point for publish / close / archive so the accompanying
 * timestamp is always written.
 */
exports.changeStatus = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid assignment id.' });
    }

    const { status } = req.body;
    const allowed = ['published', 'closed', 'archived', 'draft'];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Status must be one of: ${allowed.join(', ')}`,
      });
    }

    const assignment = await Assignment.findOne({ _id: req.params.id, deletedAt: null });
    if (!assignment) {
      return res.status(404).json({ success: false, message: 'Assignment not found.' });
    }
    if (!assignment.isEditableBy(req.user)) {
      return res.status(403).json({ success: false, message: 'You can only change your own assignments.' });
    }

    if (status === 'published') {
      if (assignment.dueDate.getTime() < Date.now()) {
        return res.status(400).json({
          success: false,
          message: 'Update the due date before publishing — it is already in the past.',
        });
      }
      assignment.publishedAt = assignment.publishedAt || new Date();
      assignment.closedAt = null;
    }

    if (status === 'closed') {
      assignment.closedAt = new Date();
    }

    assignment.status = status;
    await assignment.save();

    return res.json({ success: true, message: `Assignment ${status}.`, data: assignment });
  } catch (err) {
    return handleError(res, err, 'Failed to change assignment status');
  }
};

/**
 * DELETE /api/assignments/:id
 * Soft delete, matching how notices and resources are removed elsewhere in the
 * project so submissions are never orphaned.
 */
exports.deleteAssignment = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid assignment id.' });
    }

    const assignment = await Assignment.findOne({ _id: req.params.id, deletedAt: null });
    if (!assignment) {
      return res.status(404).json({ success: false, message: 'Assignment not found.' });
    }
    if (!assignment.isEditableBy(req.user)) {
      return res.status(403).json({ success: false, message: 'You can only delete your own assignments.' });
    }

    assignment.deletedAt = new Date();
    await assignment.save();

    return res.json({ success: true, message: 'Assignment deleted.' });
  } catch (err) {
    return handleError(res, err, 'Failed to delete assignment');
  }
};

// ---- STUDENT: DISCOVERY & SUBMISSION ----

/**
 * GET /api/assignments
 * Published assignments visible to the caller, each annotated with that
 * student's own submission so the UI can render state in one pass.
 */
exports.getAssignmentsForStudent = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = studentVisibilityFilter(req);

    if (req.query.subject && req.query.subject !== 'All') {
      filter.subject = new RegExp(`^${req.query.subject}$`, 'i');
    }
    if (req.query.search) {
      filter.title = new RegExp(req.query.search, 'i');
    }

    const [assignments, total] = await Promise.all([
      Assignment.find(filter).sort({ dueDate: 1 }).skip(skip).limit(limit).lean(),
      Assignment.countDocuments(filter),
    ]);

    const submissions = await AssignmentSubmission.find({
      assignment: { $in: assignments.map((a) => a._id) },
      student: req.user._id,
    }).lean();

    const submissionMap = new Map(submissions.map((s) => [s.assignment.toString(), s]));

    const data = assignments.map((assignment) => {
      const mine = submissionMap.get(assignment._id.toString()) || null;
      return {
        ...withDeadlineInfo(assignment),
        mySubmission: mine,
        submissionStatus: mine ? mine.status : 'not-submitted',
      };
    });

    return res.json({
      success: true,
      data,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return handleError(res, err, 'Failed to load assignments');
  }
};

/**
 * POST /api/assignments/:id/submit
 * Create or update the caller's submission. Re-submitting before the deadline
 * overwrites the previous attempt and bumps `revisionCount`.
 */
exports.submitAssignment = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid assignment id.' });
    }

    const assignment = await Assignment.findOne({ _id: req.params.id, deletedAt: null });
    if (!assignment) {
      return res.status(404).json({ success: false, message: 'Assignment not found.' });
    }

    if (assignment.status !== 'published') {
      return res.status(400).json({
        success: false,
        message: 'This assignment is not open for submissions.',
      });
    }

    const isLate = assignment.dueDate.getTime() < Date.now();
    if (isLate && !assignment.allowLateSubmission) {
      return res.status(400).json({
        success: false,
        message: 'The deadline has passed and this assignment does not accept late submissions.',
      });
    }

    const submissionText = (req.body.submissionText || '').trim();
    const attachments = (req.files || []).map(toAttachment);

    if (!submissionText && attachments.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Provide submission text or attach at least one file.',
      });
    }

    let submission = await AssignmentSubmission.findOne({
      assignment: assignment._id,
      student: req.user._id,
    });

    if (submission) {
      if (submission.status === 'graded' || submission.status === 'returned') {
        return res.status(409).json({
          success: false,
          message: 'This submission has already been graded and can no longer be changed.',
        });
      }

      submission.submissionText = submissionText;
      if (attachments.length > 0) {
        submission.attachments = attachments;
      }
      submission.status = isLate ? 'late' : 'submitted';
      submission.submittedAt = new Date();
      submission.revisionCount += 1;
      await submission.save();

      return res.json({ success: true, message: 'Submission updated.', data: submission });
    }

    submission = await AssignmentSubmission.create({
      assignment: assignment._id,
      student: req.user._id,
      studentName: req.user.name,
      submissionText,
      attachments,
      status: isLate ? 'late' : 'submitted',
      submittedAt: new Date(),
    });

    return res.status(201).json({ success: true, message: 'Assignment submitted.', data: submission });
  } catch (err) {
    // The unique index is the last line of defence against a double submit
    // fired by an impatient double-click.
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'You have already submitted this assignment.',
      });
    }
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: err.message });
    }
    return handleError(res, err, 'Failed to submit assignment');
  }
};

/**
 * GET /api/assignments/my-submissions
 * The caller's own submission history. A student can never read anyone else's.
 */
exports.getMySubmissions = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = { student: req.user._id };

    if (req.query.status && AssignmentSubmission.STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }

    const [submissions, total] = await Promise.all([
      AssignmentSubmission.find(filter)
        .populate('assignment', 'title subject dueDate maxPoints status')
        .sort({ submittedAt: -1 })
        .skip(skip)
        .limit(limit),
      AssignmentSubmission.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: submissions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return handleError(res, err, 'Failed to load submissions');
  }
};

// ---- TEACHER: REVIEW & GRADING ----

/**
 * GET /api/assignments/:id/submissions
 * All submissions for one assignment, restricted to its owner.
 */
exports.getSubmissionsForAssignment = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid assignment id.' });
    }

    const assignment = await Assignment.findOne({ _id: req.params.id, deletedAt: null });
    if (!assignment) {
      return res.status(404).json({ success: false, message: 'Assignment not found.' });
    }
    if (!assignment.isEditableBy(req.user)) {
      return res.status(403).json({
        success: false,
        message: 'You can only view submissions for your own assignments.',
      });
    }

    const submissions = await AssignmentSubmission.find({ assignment: assignment._id })
      .populate('student', 'name email')
      .sort({ submittedAt: -1 });

    return res.json({
      success: true,
      data: submissions,
      assignment: {
        _id: assignment._id,
        title: assignment.title,
        maxPoints: assignment.maxPoints,
        dueDate: assignment.dueDate,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Failed to load submissions');
  }
};

/**
 * PATCH /api/assignments/submissions/:submissionId/grade
 * Grade one submission. Bounds are enforced by the model so any future bulk
 * endpoint inherits the same rules.
 */
exports.gradeSubmission = async (req, res) => {
  try {
    if (!isValidId(req.params.submissionId)) {
      return res.status(400).json({ success: false, message: 'Invalid submission id.' });
    }

    const submission = await AssignmentSubmission.findById(req.params.submissionId);
    if (!submission) {
      return res.status(404).json({ success: false, message: 'Submission not found.' });
    }

    const assignment = await Assignment.findById(submission.assignment);
    if (!assignment) {
      return res.status(404).json({ success: false, message: 'Parent assignment not found.' });
    }
    if (!assignment.isEditableBy(req.user)) {
      return res.status(403).json({
        success: false,
        message: 'You can only grade submissions for your own assignments.',
      });
    }

    const { grade, feedback } = req.body;
    if (grade === undefined || grade === null || grade === '') {
      return res.status(400).json({ success: false, message: 'Grade is required.' });
    }

    try {
      submission.applyGrade(grade, feedback, req.user, assignment.maxPoints);
    } catch (validationError) {
      return res.status(400).json({ success: false, message: validationError.message });
    }

    await submission.save();

    return res.json({ success: true, message: 'Submission graded.', data: submission });
  } catch (err) {
    return handleError(res, err, 'Failed to grade submission');
  }
};

/**
 * GET /api/assignments/:id/stats
 * Aggregate view of one assignment: how many submitted, how many were late,
 * how many are graded, and the average score.
 */
exports.getAssignmentStats = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid assignment id.' });
    }

    const assignment = await Assignment.findOne({ _id: req.params.id, deletedAt: null });
    if (!assignment) {
      return res.status(404).json({ success: false, message: 'Assignment not found.' });
    }
    if (!assignment.isEditableBy(req.user)) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    const [summary] = await AssignmentSubmission.aggregate([
      { $match: { assignment: assignment._id } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          late: { $sum: { $cond: [{ $eq: ['$status', 'late'] }, 1, 0] } },
          graded: { $sum: { $cond: [{ $eq: ['$status', 'graded'] }, 1, 0] } },
          averageGrade: { $avg: '$grade' },
          highestGrade: { $max: '$grade' },
          lowestGrade: { $min: '$grade' },
        },
      },
    ]);

    return res.json({
      success: true,
      data: {
        assignmentId: assignment._id,
        title: assignment.title,
        maxPoints: assignment.maxPoints,
        totalSubmissions: summary?.total || 0,
        lateSubmissions: summary?.late || 0,
        gradedSubmissions: summary?.graded || 0,
        pendingGrading: (summary?.total || 0) - (summary?.graded || 0),
        averageGrade: summary?.averageGrade ? Number(summary.averageGrade.toFixed(2)) : null,
        highestGrade: summary?.highestGrade ?? null,
        lowestGrade: summary?.lowestGrade ?? null,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Failed to load assignment statistics');
  }
};
