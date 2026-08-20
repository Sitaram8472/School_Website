const mongoose = require('mongoose');
const RemarkAppeal = require('../models/RemarkAppeal');
const Submission = require('../models/Submission');
const Exam = require('../models/Exam');

/**
 * Exam re-evaluation appeals.
 *
 * Two handlers carry the feature.
 *
 * `createAppeal` enforces the window and the ownership check. Ownership is
 * read off `submission.student` rather than off a body field — the alternative
 * is the IDOR this repo already has an open issue about.
 *
 * `decideAppeal` is the one worth reading closely. It never assigns to the
 * submission's score as a bare edit: it recomputes the total from the
 * per-question decisions, refuses an incoherent outcome, appends the audit row
 * carrying the before and after, and only then writes through — in the same
 * request, so a changed mark and the record of why it changed cannot come
 * apart.
 */

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

function isAdmin(user) {
  return user && user.role === 'admin';
}

function isStaff(user) {
  return user && (user.role === 'teacher' || user.role === 'admin');
}

// ---------------------------------------------------------------------------
// Opening an appeal
// ---------------------------------------------------------------------------

/**
 * POST /api/appeals
 */
exports.createAppeal = async (req, res) => {
  try {
    const { submissionId, reason, narrative, disputedAnswers } = req.body;

    if (!isValidId(submissionId)) return fail(res, 400, 'Invalid submission id');

    const submission = await Submission.findById(submissionId);
    if (!submission) return fail(res, 404, 'Submission not found');

    // Read ownership off the stored document, never off the request body.
    if (String(submission.student) !== String(req.user._id)) {
      return fail(res, 403, 'You can only appeal your own submission');
    }

    const exam = await Exam.findById(submission.exam);
    if (!exam) return fail(res, 404, 'The exam for this submission no longer exists');

    // The window runs from the submission, which is when this codebase scores
    // and therefore when the result becomes available to the student.
    const windowClosesAt = RemarkAppeal.windowFor(submission.createdAt);
    if (!windowClosesAt) {
      return fail(res, 409, 'This submission has no usable result date');
    }
    if (Date.now() > windowClosesAt.getTime()) {
      return fail(
        res,
        403,
        `The appeal window for this exam closed on ${windowClosesAt.toISOString().slice(0, 10)}. ` +
          `Appeals must be opened within ${RemarkAppeal.APPEAL_WINDOW_DAYS} days of the result.`
      );
    }

    // One open appeal per submission, and no re-appealing a decided one.
    const existing = await RemarkAppeal.findOne({
      submission: submission._id,
      status: { $nin: ['withdrawn'] },
    });
    if (existing) {
      return fail(
        res,
        409,
        existing.isOpen()
          ? 'You already have an open appeal against this submission'
          : 'This submission has already been through a re-evaluation',
        { existingId: existing._id }
      );
    }

    // Build the disputed list from the exam's own questions, so a client cannot
    // invent a question or claim more than one is worth.
    const questionsById = new Map(
      (exam.questions || []).map((question) => [String(question._id), question])
    );

    if (!Array.isArray(disputedAnswers) || disputedAnswers.length === 0) {
      return fail(res, 400, 'Name at least one question you are disputing');
    }

    const seen = new Set();
    const built = [];

    for (const entry of disputedAnswers) {
      const key = String(entry.questionId);
      const question = questionsById.get(key);
      if (!question) {
        return fail(res, 400, 'A disputed question does not belong to this exam');
      }
      if (seen.has(key)) {
        return fail(res, 400, 'The same question was disputed twice');
      }
      seen.add(key);

      const maxMarks = question.points ?? 1;

      built.push({
        questionId: question._id,
        questionText: question.questionText,
        maxMarks,
        // Awarded marks come from the client's view of their own paper, but are
        // bounded by what the question is worth.
        awardedMarks: Math.min(Math.max(Number(entry.awardedMarks) || 0, 0), maxMarks),
        claimedMarks: Number(entry.claimedMarks),
        studentNote: entry.studentNote,
        decision: 'pending',
      });
    }

    const appeal = new RemarkAppeal({
      submission: submission._id,
      exam: exam._id,
      student: req.user._id,
      originalMarker: exam.creator,
      reason,
      narrative,
      disputedAnswers: built,
      status: 'submitted',
      windowClosesAt,
      originalTotal: submission.score || 0,
    });

    appeal.recordAudit({
      action: 'opened',
      to: 'submitted',
      by: req.user._id,
      note: `Disputing ${built.length} question(s)`,
    });

    await appeal.save();

    return res.status(201).json({
      success: true,
      message: 'Appeal submitted',
      data: appeal.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to open appeal');
  }
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * GET /api/appeals/mine
 */
exports.getMyAppeals = async (req, res) => {
  try {
    const appeals = await RemarkAppeal.find({ student: req.user._id })
      .populate('exam', 'title')
      .populate('reviewer', 'name')
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: appeals.length,
      data: appeals.map((appeal) => ({
        ...appeal.toRow(),
        exam: appeal.exam,
        reviewer: appeal.reviewer,
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load your appeals');
  }
};

/**
 * GET /api/appeals
 */
exports.listAppeals = async (req, res) => {
  try {
    const { status, exam, reviewer } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (exam) {
      if (!isValidId(exam)) return fail(res, 400, 'Invalid exam id');
      filter.exam = exam;
    }
    if (reviewer) {
      if (!isValidId(reviewer)) return fail(res, 400, 'Invalid reviewer id');
      filter.reviewer = reviewer;
    }

    const appeals = await RemarkAppeal.find(filter)
      .populate('student', 'name email')
      .populate('exam', 'title')
      .populate('reviewer', 'name')
      .populate('originalMarker', 'name')
      .sort({ createdAt: -1 })
      .limit(300);

    return res.status(200).json({
      success: true,
      count: appeals.length,
      data: appeals.map((appeal) => ({
        ...appeal.toRow(),
        student: appeal.student,
        exam: appeal.exam,
        reviewer: appeal.reviewer,
        originalMarker: appeal.originalMarker,
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load appeals');
  }
};

/**
 * GET /api/appeals/queue
 *
 * Unassigned and in-review, oldest first. The original marker's name travels
 * with each row so an ineligible assignment is obvious to a human before the
 * server has to refuse it.
 */
exports.getQueue = async (req, res) => {
  try {
    const appeals = await RemarkAppeal.find({
      status: { $in: RemarkAppeal.OPEN_STATUSES },
    })
      .populate('student', 'name email')
      .populate('exam', 'title')
      .populate('reviewer', 'name')
      .populate('originalMarker', 'name')
      .sort({ createdAt: 1 })
      .limit(300);

    const now = Date.now();

    return res.status(200).json({
      success: true,
      count: appeals.length,
      data: appeals.map((appeal) => ({
        ...appeal.toRow(),
        student: appeal.student,
        exam: appeal.exam,
        reviewer: appeal.reviewer,
        originalMarker: appeal.originalMarker,
        waitingDays: Math.floor((now - appeal.createdAt.getTime()) / 86400000),
        // Surfaced so the UI can grey out what this viewer may not take.
        eligibilityError: appeal.reviewerEligibilityError(req.user),
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the appeal queue');
  }
};

/**
 * GET /api/appeals/:id
 */
exports.getAppeal = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid appeal id');

    const appeal = await RemarkAppeal.findById(id)
      .populate('student', 'name email')
      .populate('exam', 'title')
      .populate('reviewer', 'name')
      .populate('originalMarker', 'name');
    if (!appeal) return fail(res, 404, 'Appeal not found');

    if (!appeal.isOwnedBy(req.user) && !isStaff(req.user)) {
      return fail(res, 403, 'This appeal belongs to another student');
    }

    return res.status(200).json({
      success: true,
      data: {
        ...appeal.toRow(),
        student: appeal.student,
        exam: appeal.exam,
        reviewer: appeal.reviewer,
        originalMarker: appeal.originalMarker,
        audit: appeal.audit,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load appeal');
  }
};

/**
 * GET /api/appeals/appealable
 *
 * The student's submissions still inside the window, with the days remaining.
 * The deadline is the single fact a student needs and it is the one an email
 * thread never carries.
 */
exports.getAppealable = async (req, res) => {
  try {
    const submissions = await Submission.find({ student: req.user._id })
      .populate('exam', 'title questions')
      .sort({ createdAt: -1 })
      .limit(100);

    const existing = await RemarkAppeal.find({
      student: req.user._id,
      status: { $nin: ['withdrawn'] },
    }).select('submission status');

    const appealedIds = new Set(existing.map((row) => String(row.submission)));
    const now = Date.now();

    const rows = submissions
      .map((submission) => {
        const closes = RemarkAppeal.windowFor(submission.createdAt);
        const daysRemaining = closes
          ? Math.ceil((closes.getTime() - now) / 86400000)
          : null;

        return {
          submissionId: submission._id,
          exam: submission.exam
            ? { _id: submission.exam._id, title: submission.exam.title }
            : null,
          questions: submission.exam?.questions || [],
          answers: submission.answers,
          score: submission.score,
          submittedAt: submission.createdAt,
          windowClosesAt: closes,
          daysRemaining,
          alreadyAppealed: appealedIds.has(String(submission._id)),
          canAppeal:
            !appealedIds.has(String(submission._id)) &&
            daysRemaining !== null &&
            daysRemaining > 0,
        };
      })
      .filter((row) => row.exam);

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows,
      windowDays: RemarkAppeal.APPEAL_WINDOW_DAYS,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load your submissions');
  }
};

// ---------------------------------------------------------------------------
// The student's own actions
// ---------------------------------------------------------------------------

/**
 * PATCH /api/appeals/:id/withdraw
 *
 * Available until a decision is recorded, and leaves the audit trail intact.
 */
exports.withdrawAppeal = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid appeal id');

    const appeal = await RemarkAppeal.findById(id);
    if (!appeal) return fail(res, 404, 'Appeal not found');

    if (!appeal.isOwnedBy(req.user)) {
      return fail(res, 403, 'This appeal belongs to another student');
    }
    if (appeal.isDecided()) {
      return fail(res, 409, 'A decided appeal cannot be withdrawn');
    }
    if (appeal.status === 'withdrawn') {
      return fail(res, 409, 'This appeal is already withdrawn');
    }

    const from = appeal.status;
    appeal.status = 'withdrawn';
    appeal.recordAudit({
      action: 'withdrawn',
      from,
      to: 'withdrawn',
      by: req.user._id,
      note: req.body.reason,
    });

    await appeal.save();

    return res.status(200).json({
      success: true,
      message: 'Appeal withdrawn',
      data: appeal.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to withdraw appeal');
  }
};

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/**
 * PATCH /api/appeals/:id/assign
 */
exports.assignReviewer = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid appeal id');

    const { reviewerId } = req.body;
    if (!isValidId(reviewerId)) return fail(res, 400, 'Invalid reviewer id');

    const appeal = await RemarkAppeal.findById(id);
    if (!appeal) return fail(res, 404, 'Appeal not found');
    if (!appeal.isOpen()) {
      return fail(res, 409, `A ${appeal.status} appeal cannot be reassigned`);
    }

    // The eligibility rule is about the candidate, so check it against them
    // rather than against the admin doing the assigning.
    const blocked = appeal.reviewerEligibilityError({ _id: reviewerId });
    if (blocked) return fail(res, 409, blocked);

    const from = appeal.reviewer ? String(appeal.reviewer) : null;
    appeal.reviewer = reviewerId;
    appeal.recordAudit({
      action: 'reviewer assigned',
      from,
      to: String(reviewerId),
      by: req.user._id,
    });

    await appeal.save();

    return res.status(200).json({
      success: true,
      message: 'Reviewer assigned',
      data: appeal.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to assign reviewer');
  }
};

/**
 * PATCH /api/appeals/:id/start
 *
 * A reviewer taking the appeal themselves. The same eligibility rule applies —
 * picking it up off the queue is not a way around it.
 */
exports.startReview = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid appeal id');

    const appeal = await RemarkAppeal.findById(id);
    if (!appeal) return fail(res, 404, 'Appeal not found');
    if (appeal.status !== 'submitted' && appeal.status !== 'under-review') {
      return fail(res, 409, `A ${appeal.status} appeal cannot be reviewed`);
    }

    const blocked = appeal.reviewerEligibilityError(req.user);
    if (blocked) return fail(res, 409, blocked);

    if (
      appeal.reviewer &&
      String(appeal.reviewer) !== String(req.user._id) &&
      !isAdmin(req.user)
    ) {
      return fail(res, 409, 'This appeal is assigned to another reviewer');
    }

    const from = appeal.status;
    appeal.status = 'under-review';
    appeal.reviewer = req.user._id;
    appeal.reviewStartedAt = appeal.reviewStartedAt || new Date();
    appeal.recordAudit({
      action: 'review started',
      from,
      to: 'under-review',
      by: req.user._id,
    });

    await appeal.save();

    return res.status(200).json({
      success: true,
      message: 'Review started',
      data: appeal.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to start review');
  }
};

/**
 * PATCH /api/appeals/:id/questions/:answerId
 *
 * One question's decision and revised mark. The bounds are enforced in the
 * model's pre-validate hook, so a revised mark outside [0, points] is rejected
 * here and would be rejected by any other caller too.
 */
exports.decideQuestion = async (req, res) => {
  try {
    const { id, answerId } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid appeal id');
    if (!isValidId(answerId)) return fail(res, 400, 'Invalid question id');

    const appeal = await RemarkAppeal.findById(id);
    if (!appeal) return fail(res, 404, 'Appeal not found');

    const blocked = appeal.reviewerEligibilityError(req.user);
    if (blocked) return fail(res, 409, blocked);

    if (appeal.status !== 'under-review') {
      return fail(res, 409, 'Start the review before deciding individual questions');
    }
    if (
      appeal.reviewer &&
      String(appeal.reviewer) !== String(req.user._id) &&
      !isAdmin(req.user)
    ) {
      return fail(res, 409, 'This appeal is assigned to another reviewer');
    }

    const answer = appeal.disputedAnswers.id(answerId);
    if (!answer) return fail(res, 404, 'That question is not part of this appeal');

    const { decision, revisedMarks, reviewerNote } = req.body;
    if (decision && !RemarkAppeal.QUESTION_DECISIONS.includes(decision)) {
      return fail(res, 400, 'Invalid decision');
    }

    const previous = Number.isFinite(answer.revisedMarks)
      ? answer.revisedMarks
      : answer.awardedMarks;

    if (revisedMarks !== undefined && revisedMarks !== null && revisedMarks !== '') {
      answer.revisedMarks = Number(revisedMarks);
    } else if (decision === 'rejected') {
      // Rejecting a question means the original mark stands.
      answer.revisedMarks = answer.awardedMarks;
    }

    if (decision) answer.decision = decision;
    if (reviewerNote !== undefined) answer.reviewerNote = reviewerNote;

    appeal.recordAudit({
      action: 'question decided',
      from: previous,
      to: answer.revisedMarks,
      by: req.user._id,
      note: answer.questionText
        ? `${answer.decision}: ${answer.questionText.slice(0, 60)}`
        : answer.decision,
    });

    await appeal.save();

    return res.status(200).json({
      success: true,
      message: 'Question decision recorded',
      data: appeal.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record question decision');
  }
};

/**
 * PATCH /api/appeals/:id/decide
 *
 * The write-through. The submission's score is only ever changed here, in the
 * same request that appends the audit row recording what it was and what it
 * became.
 */
exports.decideAppeal = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid appeal id');

    const appeal = await RemarkAppeal.findById(id);
    if (!appeal) return fail(res, 404, 'Appeal not found');

    const blocked = appeal.reviewerEligibilityError(req.user);
    if (blocked) return fail(res, 409, blocked);

    if (appeal.status !== 'under-review') {
      return fail(res, 409, 'Start the review before recording a decision');
    }
    if (
      appeal.reviewer &&
      String(appeal.reviewer) !== String(req.user._id) &&
      !isAdmin(req.user)
    ) {
      return fail(res, 409, 'This appeal is assigned to another reviewer');
    }

    const { outcome, decisionNote } = req.body;
    if (!RemarkAppeal.DECIDED_STATUSES.includes(outcome)) {
      return fail(
        res,
        400,
        `Outcome must be one of: ${RemarkAppeal.DECIDED_STATUSES.join(', ')}`
      );
    }

    // Every disputed question must have been looked at. A decision recorded
    // while questions are still pending is a decision that did not read them.
    const undecided = appeal.disputedAnswers.filter((a) => a.decision === 'pending');
    if (undecided.length) {
      return fail(
        res,
        409,
        `${undecided.length} disputed question(s) still have no decision`
      );
    }

    appeal.recomputeTotals();

    // An outcome of "accepted" with nothing changed is incoherent. If nothing
    // moved, the honest answer is "rejected", and saying so plainly is the
    // whole value of keeping this record.
    if (outcome !== 'rejected' && appeal.marksDelta === 0) {
      return fail(
        res,
        409,
        'No marks changed, so this outcome should be recorded as rejected'
      );
    }
    if (outcome === 'rejected' && appeal.marksDelta !== 0) {
      return fail(
        res,
        409,
        `Marks moved by ${appeal.marksDelta}, so this cannot be recorded as rejected`
      );
    }

    if (appeal.marksDelta !== 0 && !decisionNote) {
      return fail(res, 400, 'A decision note is required when marks change');
    }

    const submission = await Submission.findById(appeal.submission);
    if (!submission) {
      return fail(res, 404, 'The submission for this appeal no longer exists');
    }

    const previousScore = submission.score || 0;
    const newScore = appeal.revisedTotal ?? previousScore;

    const from = appeal.status;
    appeal.status = outcome;
    appeal.decidedAt = new Date();
    appeal.decisionNote = decisionNote;

    // The audit row is written before the submission is touched, and both are
    // saved in the same request. There is no path that changes a mark without
    // leaving this row behind.
    appeal.recordAudit({
      action: 'decided',
      from: `${from} / ${previousScore}`,
      to: `${outcome} / ${newScore}`,
      by: req.user._id,
      note: decisionNote,
    });

    await appeal.save();

    if (appeal.marksDelta !== 0) {
      submission.score = newScore;
      await submission.save();
    }

    return res.status(200).json({
      success: true,
      message:
        appeal.marksDelta === 0
          ? 'Appeal rejected; the original mark stands'
          : `Appeal ${outcome}; the mark moved from ${previousScore} to ${newScore}`,
      data: appeal.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record decision');
  }
};

/**
 * PATCH /api/appeals/:id/reopen
 *
 * The only way past a closed window, and itself audited. An admin extending a
 * specific appeal is a decision somebody can be asked about; a waiver flag on
 * the create path is not.
 */
exports.reopenAppeal = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid appeal id');

    const appeal = await RemarkAppeal.findById(id);
    if (!appeal) return fail(res, 404, 'Appeal not found');

    const reason = req.body.reason;
    if (!reason || String(reason).trim().length < 5) {
      return fail(res, 400, 'A reason of at least 5 characters is required');
    }

    if (appeal.isOpen()) {
      return fail(res, 409, 'This appeal is already open');
    }

    const from = appeal.status;
    const extraDays = Number(req.body.extendDays) || RemarkAppeal.APPEAL_WINDOW_DAYS;

    appeal.status = 'under-review';
    appeal.decidedAt = undefined;
    appeal.windowClosesAt = new Date(Date.now() + extraDays * 86400000);
    appeal.recordAudit({
      action: 'reopened',
      from,
      to: 'under-review',
      by: req.user._id,
      note: reason,
    });

    await appeal.save();

    return res.status(200).json({
      success: true,
      message: `Appeal reopened for ${extraDays} days`,
      data: appeal.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to reopen appeal');
  }
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * GET /api/appeals/stats
 */
exports.getStats = async (req, res) => {
  try {
    const appeals = await RemarkAppeal.find({}).select(
      'status marksDelta createdAt decidedAt reason'
    );

    const byStatus = {};
    for (const status of RemarkAppeal.STATUSES) byStatus[status] = 0;

    const byReason = {};
    const turnarounds = [];
    let upheld = 0;
    let decided = 0;
    let totalDelta = 0;

    for (const appeal of appeals) {
      byStatus[appeal.status] = (byStatus[appeal.status] || 0) + 1;
      byReason[appeal.reason] = (byReason[appeal.reason] || 0) + 1;

      if (RemarkAppeal.DECIDED_STATUSES.includes(appeal.status)) {
        decided += 1;
        totalDelta += appeal.marksDelta || 0;
        if (appeal.status !== 'rejected') upheld += 1;
        if (appeal.decidedAt && appeal.createdAt) {
          turnarounds.push(appeal.decidedAt.getTime() - appeal.createdAt.getTime());
        }
      }
    }

    // Median rather than mean: one appeal that sat for a term should not make
    // the average look like the typical experience.
    turnarounds.sort((a, b) => a - b);
    const medianMs = turnarounds.length
      ? turnarounds[Math.floor(turnarounds.length / 2)]
      : null;

    return res.status(200).json({
      success: true,
      data: {
        total: appeals.length,
        byStatus,
        byReason,
        open: appeals.filter((a) => RemarkAppeal.OPEN_STATUSES.includes(a.status))
          .length,
        decided,
        upheldRate: decided ? Math.round((upheld / decided) * 1000) / 10 : 0,
        medianTurnaroundDays:
          medianMs === null ? null : Math.round((medianMs / 86400000) * 10) / 10,
        totalMarksMoved: totalDelta,
        windowDays: RemarkAppeal.APPEAL_WINDOW_DAYS,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build appeal statistics');
  }
};

/**
 * GET /api/appeals/meta
 */
exports.getMeta = async (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      reasons: RemarkAppeal.REASONS,
      statuses: RemarkAppeal.STATUSES,
      decisions: RemarkAppeal.QUESTION_DECISIONS,
      decidedStatuses: RemarkAppeal.DECIDED_STATUSES,
      windowDays: RemarkAppeal.APPEAL_WINDOW_DAYS,
      maxDisputedAnswers: RemarkAppeal.MAX_DISPUTED_ANSWERS,
      isStaff: isStaff(req.user),
    },
  });
};
