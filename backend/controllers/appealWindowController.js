const mongoose = require('mongoose');

const AppealWindow = require('../models/AppealWindow');
const RemarkAppeal = require('../models/RemarkAppeal');
const Exam = require('../models/Exam');
const Course = require('../models/Course');

/**
 * Appeal windows.
 *
 * Two handlers carry the feature.
 *
 * `createWindow` is where the anchor is established: the exam is loaded, the
 * results-publication moment is taken from the person publishing the results
 * rather than inferred from a submission timestamp, and the opening time is
 * refused if it precedes it. Everything downstream depends on that date being
 * a stated fact rather than a guess.
 *
 * `extendWindow` is the one worth reading closely. It is the only route that
 * moves a deadline a cohort has already been given, it refuses to move it
 * earlier, it requires a reason, and it writes the before-and-after into
 * `extensions[]` in the same save. A deadline that can move quietly is not a
 * deadline.
 */

const MAX_LIST = 200;

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

function serverError(res, error, message) {
  console.error(`${message}:`, error);
  return res.status(500).json({
    success: false,
    message,
    error: error.message,
  });
}

/**
 * Mongoose validation errors carry every failed path. Surfacing only the first
 * is how you get somebody fixing a form one field per submission.
 */
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
  return null;
}

/**
 * The unique partial index is the guard, not this message. It fires when two
 * people publish a window for the same exam at the same moment, which is
 * exactly the race the index exists for.
 */
function duplicateMessage(error) {
  if (error && error.code === 11000) {
    return 'This exam already has a live appeal window. Close or cancel it before creating another';
  }
  return null;
}

function isStaff(user) {
  return user && (user.role === 'teacher' || user.role === 'admin');
}

function parseDate(value, label) {
  if (value === undefined || value === null || value === '') {
    return { error: `${label} is required` };
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { error: `${label} is not a valid date` };
  }

  return { date };
}

/**
 * GET /api/appeals/windows/meta
 *
 * Everything the panel needs to render its selects without a second call, plus
 * the default that applies where no window exists — students should be able to
 * see that fourteen days is the fallback rather than infer it.
 */
exports.getMeta = async (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      statuses: AppealWindow.STATUSES,
      assessmentTypes: AppealWindow.ASSESSMENT_TYPES,
      states: ['draft', 'scheduled', 'open', 'expired', 'closed', 'cancelled'],
      minWindowHours: AppealWindow.MIN_WINDOW_HOURS,
      maxWindowDays: AppealWindow.MAX_WINDOW_DAYS,
      maxGraceHours: AppealWindow.MAX_GRACE_HOURS,
      defaultWindowDays: AppealWindow.DEFAULT_WINDOW_DAYS,
      isStaff: isStaff(req.user),
      canManage: isStaff(req.user),
      canClose: !!(req.user && req.user.role === 'admin'),
    },
  });
};

/**
 * GET /api/appeals/windows/calendar
 *
 * What is open now and what closes soon, for everybody who is signed in. This
 * is the read the whole feature exists for: before it, a student could learn
 * the *length* of the window from `/meta` and never its end date.
 */
exports.getCalendar = async (req, res) => {
  try {
    const now = new Date();
    const horizonDays = Math.min(Number(req.query.days) || 60, 365);
    const horizon = new Date(now.getTime() + horizonDays * 86400000);

    const windows = await AppealWindow.find({
      status: 'published',
      opensAt: { $lte: horizon },
      closesAt: { $gte: new Date(now.getTime() - 7 * 86400000) },
    })
      .sort({ closesAt: 1 })
      .limit(MAX_LIST);

    const rows = windows.map((w) => w.toRow(now));

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: {
        open: rows.filter((r) => r.state === 'open'),
        upcoming: rows.filter((r) => r.state === 'scheduled'),
        recentlyClosed: rows.filter((r) => r.state === 'expired'),
        defaultWindowDays: AppealWindow.DEFAULT_WINDOW_DAYS,
        generatedAt: now,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the appeal window calendar');
  }
};

/**
 * GET /api/appeals/windows/exam/:examId
 *
 * The deadline that actually governs one exam, published window or fallback.
 * The `source` field is deliberately in the response: a student told "you have
 * until the 14th" is entitled to know whether that came from a decision
 * somebody made or from the default nobody looked at.
 */
exports.getForExam = async (req, res) => {
  try {
    const { examId } = req.params;
    if (!isValidId(examId)) return fail(res, 400, 'Invalid exam id');

    const now = new Date();
    const resolved = await AppealWindow.effectiveWindowFor(examId, null, now);

    return res.status(200).json({
      success: true,
      data: {
        source: resolved.source,
        state: resolved.state,
        accepting: resolved.accepting,
        opensAt: resolved.opensAt,
        closesAt: resolved.closesAt,
        maxAppealsPerStudent: resolved.maxAppealsPerStudent,
        defaultWindowDays: AppealWindow.DEFAULT_WINDOW_DAYS,
        window: resolved.window ? resolved.window.toRow(now) : null,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to resolve the appeal window for this exam');
  }
};

/**
 * GET /api/appeals/windows
 *
 * The staff list. Filterable by status and state, because "what is open right
 * now" and "what is still a draft" are different jobs.
 */
exports.listWindows = async (req, res) => {
  try {
    const query = {};

    if (req.query.status) {
      if (!AppealWindow.STATUSES.includes(req.query.status)) {
        return fail(res, 400, 'Invalid status filter');
      }
      query.status = req.query.status;
    }

    if (req.query.academicYear) {
      query.academicYear = String(req.query.academicYear).trim();
    }

    if (req.query.course) {
      if (!isValidId(req.query.course)) return fail(res, 400, 'Invalid course id');
      query.course = req.query.course;
    }

    const windows = await AppealWindow.find(query)
      .sort({ closesAt: -1 })
      .limit(MAX_LIST);

    const now = new Date();
    let rows = windows.map((w) => w.toRow(now));

    if (req.query.state) {
      rows = rows.filter((row) => row.state === req.query.state);
    }

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load appeal windows');
  }
};

/**
 * GET /api/appeals/windows/exams
 *
 * Exams that could take a window, with the live one flagged. Saves the panel
 * from offering an exam that already has a window and then failing on the
 * unique index.
 */
exports.getCandidateExams = async (req, res) => {
  try {
    const exams = await Exam.find({})
      .select('title course isPublished createdAt')
      .populate('course', 'name')
      .sort({ createdAt: -1 })
      .limit(MAX_LIST);

    const live = await AppealWindow.find({ isLive: true }).select('exam status');
    const claimed = new Map(live.map((w) => [String(w.exam), w.status]));

    return res.status(200).json({
      success: true,
      count: exams.length,
      data: exams.map((exam) => ({
        _id: exam._id,
        title: exam.title,
        courseId: exam.course ? exam.course._id : null,
        courseName: exam.course ? exam.course.name : '',
        isPublished: exam.isPublished,
        createdAt: exam.createdAt,
        existingWindowStatus: claimed.get(String(exam._id)) || null,
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load exams');
  }
};

/**
 * GET /api/appeals/windows/:id
 */
exports.getWindow = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid window id');

    const window = await AppealWindow.findById(id)
      .populate('createdBy', 'name email')
      .populate('publishedBy', 'name')
      .populate('history.by', 'name');

    if (!window) return fail(res, 404, 'Appeal window not found');

    const now = new Date();

    // How many appeals have actually been raised under it. Computed rather
    // than counted into a field, so it cannot drift from the appeals it counts.
    const appealCount = await RemarkAppeal.countDocuments({ exam: window.exam });

    return res.status(200).json({
      success: true,
      data: {
        ...window.toRow(now),
        appealCount,
        extensions: window.extensions,
        history: window.history,
        createdBy: window.createdBy,
        publishedBy: window.publishedBy,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the appeal window');
  }
};

/**
 * POST /api/appeals/windows
 *
 * Creates a draft. Nothing is visible to a cohort until it is published, so
 * the dates can be worked out here without anybody being told a deadline that
 * then changes.
 */
exports.createWindow = async (req, res) => {
  try {
    const {
      exam: examId,
      resultsPublishedAt,
      opensAt,
      closesAt,
      graceHours,
      assessmentType,
      academicYear,
      maxAppealsPerStudent,
      instructions,
    } = req.body;

    if (!isValidId(examId)) return fail(res, 400, 'Invalid exam id');

    const exam = await Exam.findById(examId).populate('course', 'name');
    if (!exam) return fail(res, 404, 'Exam not found');

    const published = parseDate(resultsPublishedAt, 'The results publication date');
    if (published.error) return fail(res, 400, published.error);

    // Opening at the moment results are published is the sensible default and
    // the one that matches what the fixed fourteen-day rule was trying to do.
    const opens = opensAt
      ? parseDate(opensAt, 'The opening time')
      : { date: published.date };
    if (opens.error) return fail(res, 400, opens.error);

    const closes = closesAt
      ? parseDate(closesAt, 'The closing time')
      : {
          date: new Date(
            opens.date.getTime() + AppealWindow.DEFAULT_WINDOW_DAYS * 86400000
          ),
        };
    if (closes.error) return fail(res, 400, closes.error);

    const existing = await AppealWindow.liveFor(examId);
    if (existing) {
      return fail(
        res,
        409,
        `This exam already has a ${existing.status} appeal window. Close or cancel it before creating another`,
        { existingWindowId: existing._id }
      );
    }

    let courseId = exam.course ? exam.course._id : undefined;
    let courseName = exam.course ? exam.course.name : '';

    // An exam whose course reference did not populate still deserves a name on
    // the row, so the calendar does not render a blank column.
    if (courseId && !courseName) {
      const course = await Course.findById(courseId).select('name');
      courseName = course ? course.name : '';
    }

    const window = new AppealWindow({
      exam: exam._id,
      examTitle: exam.title || '',
      course: courseId,
      courseName,
      academicYear: (academicYear || '').trim(),
      assessmentType: assessmentType || 'other',
      resultsPublishedAt: published.date,
      opensAt: opens.date,
      closesAt: closes.date,
      graceHours: Number(graceHours) || 0,
      maxAppealsPerStudent: Number(maxAppealsPerStudent) || 1,
      instructions: (instructions || '').trim(),
      status: 'draft',
      createdBy: req.user._id,
    });

    window.log('created', req.user);
    await window.save();

    return res.status(201).json({
      success: true,
      message: 'Appeal window drafted',
      data: window.toRow(),
    });
  } catch (error) {
    const duplicate = duplicateMessage(error);
    if (duplicate) return fail(res, 409, duplicate);

    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 400, message);

    return serverError(res, error, 'Failed to create the appeal window');
  }
};

/**
 * PATCH /api/appeals/windows/:id
 *
 * Drafts only. Once published, the exam, the anchor and the opening time are
 * frozen in the model, and the closing time moves only through `/extend`.
 */
exports.updateWindow = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid window id');

    const window = await AppealWindow.findById(id);
    if (!window) return fail(res, 404, 'Appeal window not found');

    if (window.status !== 'draft') {
      return fail(
        res,
        409,
        `A ${window.status} window cannot be edited. Extend it to move the closing date, or cancel it`
      );
    }

    const { resultsPublishedAt, opensAt, closesAt } = req.body;

    if (resultsPublishedAt !== undefined) {
      const parsed = parseDate(resultsPublishedAt, 'The results publication date');
      if (parsed.error) return fail(res, 400, parsed.error);
      window.resultsPublishedAt = parsed.date;
    }

    if (opensAt !== undefined) {
      const parsed = parseDate(opensAt, 'The opening time');
      if (parsed.error) return fail(res, 400, parsed.error);
      window.opensAt = parsed.date;
    }

    if (closesAt !== undefined) {
      const parsed = parseDate(closesAt, 'The closing time');
      if (parsed.error) return fail(res, 400, parsed.error);
      window.closesAt = parsed.date;
    }

    if (req.body.graceHours !== undefined) {
      window.graceHours = Number(req.body.graceHours) || 0;
    }
    if (req.body.assessmentType !== undefined) {
      window.assessmentType = req.body.assessmentType;
    }
    if (req.body.academicYear !== undefined) {
      window.academicYear = String(req.body.academicYear).trim();
    }
    if (req.body.maxAppealsPerStudent !== undefined) {
      window.maxAppealsPerStudent = Number(req.body.maxAppealsPerStudent) || 1;
    }
    if (req.body.instructions !== undefined) {
      window.instructions = String(req.body.instructions).trim();
    }

    window.log('edited', req.user);
    await window.save();

    return res.status(200).json({
      success: true,
      message: 'Appeal window updated',
      data: window.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update the appeal window');
  }
};

/**
 * PATCH /api/appeals/windows/:id/publish
 */
exports.publishWindow = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid window id');

    const window = await AppealWindow.findById(id);
    if (!window) return fail(res, 404, 'Appeal window not found');

    window.publish(req.user);
    await window.save();

    return res.status(200).json({
      success: true,
      message: 'Appeal window published',
      data: window.toRow(),
    });
  } catch (error) {
    const duplicate = duplicateMessage(error);
    if (duplicate) return fail(res, 409, duplicate);

    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 409, message);

    return serverError(res, error, 'Failed to publish the appeal window');
  }
};

/**
 * PATCH /api/appeals/windows/:id/extend
 *
 * The route the whole model exists for. One person moves one date and the
 * whole cohort is covered — including the students who would never have
 * complained, which is precisely who the per-appeal `reopen` path misses.
 */
exports.extendWindow = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid window id');

    const { closesAt, days, reason } = req.body;

    if (!reason || !String(reason).trim()) {
      return fail(res, 400, 'An extension reason is required');
    }

    const window = await AppealWindow.findById(id);
    if (!window) return fail(res, 404, 'Appeal window not found');

    let target;
    if (closesAt !== undefined && closesAt !== null && closesAt !== '') {
      const parsed = parseDate(closesAt, 'The new closing date');
      if (parsed.error) return fail(res, 400, parsed.error);
      target = parsed.date;
    } else {
      const extraDays = Number(days);
      if (!Number.isFinite(extraDays) || extraDays <= 0) {
        return fail(res, 400, 'Give either a new closing date or a positive number of days');
      }
      target = new Date(window.closesAt.getTime() + extraDays * 86400000);
    }

    window.extend(req.user, target, reason);
    await window.save();

    return res.status(200).json({
      success: true,
      message: 'Appeal window extended',
      data: window.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 409, message);
    return serverError(res, error, 'Failed to extend the appeal window');
  }
};

/**
 * PATCH /api/appeals/windows/:id/close
 *
 * Ends a window that has run its course. Closing releases the per-exam
 * uniqueness so a fresh window can be published later — for a re-sit, say —
 * without the original being deleted.
 */
exports.closeWindow = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid window id');

    const window = await AppealWindow.findById(id);
    if (!window) return fail(res, 404, 'Appeal window not found');

    const now = new Date();
    if (window.isAcceptingAppeals(now) && !req.body.force) {
      return fail(
        res,
        409,
        'This window is still open to students. Re-send with force: true to end it early, or cancel it with a reason',
        { hoursRemaining: window.hoursRemaining(now) }
      );
    }

    window.close(req.user, (req.body.note || '').trim());
    await window.save();

    return res.status(200).json({
      success: true,
      message: 'Appeal window closed',
      data: window.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 409, message);
    return serverError(res, error, 'Failed to close the appeal window');
  }
};

/**
 * PATCH /api/appeals/windows/:id/cancel
 *
 * The only way a published window stops meaning what it said. It needs a
 * reason, and the reason stays on the record.
 */
exports.cancelWindow = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid window id');

    const { reason } = req.body;
    if (!reason || !String(reason).trim()) {
      return fail(res, 400, 'A cancellation reason is required');
    }

    const window = await AppealWindow.findById(id);
    if (!window) return fail(res, 404, 'Appeal window not found');

    window.cancel(req.user, reason);
    await window.save();

    return res.status(200).json({
      success: true,
      message: 'Appeal window cancelled',
      data: window.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 409, message);
    return serverError(res, error, 'Failed to cancel the appeal window');
  }
};
