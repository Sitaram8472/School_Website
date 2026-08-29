const mongoose = require('mongoose');
const PaperReview = require('../models/PaperReview');
const Exam = require('../models/Exam');

/**
 * Question-paper moderation.
 *
 * Two handlers carry the module.
 *
 * `submitReview` freezes a version: it recomputes the fingerprint from the live
 * exam, bumps `paperVersion`, and re-runs every derived check. What the
 * moderator then reads is a specific artefact, not "the paper".
 *
 * `getClearance` is the one the exam module should ask before publishing.
 * It refuses an unapproved paper, an approved paper that has since been edited,
 * and an approved paper still under embargo — each with a reason that says what
 * to do next.
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

/**
 * Load a review together with the exam it describes.
 *
 * They always travel together: every derived value on a review — blueprint,
 * checks, integrity — is a function of the exam, so a handler holding one
 * without the other can only report stale figures.
 */
async function loadReviewAndExam(id) {
  if (!isValidId(id)) return { status: 400, message: 'Invalid review id' };

  const review = await PaperReview.findById(id);
  if (!review) return { status: 404, message: 'Review not found' };

  const exam = await Exam.findById(review.exam);
  if (!exam) {
    return { status: 409, message: 'The exam this review describes has been deleted' };
  }

  return { review, exam };
}

/**
 * Who may look at a review at all. The author, the moderator and admins — and
 * nobody else, because a paper under moderation is an unpublished exam.
 */
function mayRead(review, user) {
  return review.isAuthoredBy(user) || review.isModeratedBy(user) || isAdmin(user);
}

/** The view a caller is entitled to, blind moderation honoured in one place. */
function viewFor(review, exam, user) {
  if (review.isAuthoredBy(user) && !isAdmin(user)) {
    return review.toAuthorView(exam);
  }
  const base = review.toObject();
  base.blueprint = review.buildBlueprint(exam);
  base.checks = review.runChecks(exam);
  base.integrity = review.integrityAgainst(exam);
  return base;
}

/** The per-question classification, taken from a client but bounded. */
function sanitiseQuestionMeta(raw, questionCount) {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .map((meta) => ({
      index: Number(meta.index),
      cognitiveLevel: meta.cognitiveLevel || undefined,
      topic: meta.topic,
      isOutOfSyllabus: Boolean(meta.isOutOfSyllabus),
    }))
    .filter(
      (meta) =>
        Number.isInteger(meta.index) && meta.index >= 0 && meta.index < questionCount
    );
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/**
 * GET /api/paper-moderation/meta
 */
exports.getMeta = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        assessmentTypes: PaperReview.ASSESSMENT_TYPES,
        statuses: PaperReview.REVIEW_STATUSES,
        cognitiveLevels: PaperReview.COGNITIVE_LEVELS,
        findingCategories: PaperReview.FINDING_CATEGORIES,
        findingSeverities: PaperReview.FINDING_SEVERITIES,
        checkSeverities: PaperReview.CHECK_SEVERITIES,
        defaultCognitiveTarget: PaperReview.DEFAULT_COGNITIVE_TARGET,
        topicConcentrationLimit: PaperReview.TOPIC_CONCENTRATION_LIMIT,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load moderation reference data');
  }
};

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

/**
 * POST /api/paper-moderation/reviews
 *
 * A review is opened against an exam, by the person who wrote it. Opening a
 * second live review for the same paper is refused — two moderators working
 * from different findings on one artefact is worse than none.
 */
exports.createReview = async (req, res) => {
  try {
    const { exam: examId, assessmentType } = req.body;
    if (!isValidId(examId)) return fail(res, 400, 'Invalid exam id');

    const exam = await Exam.findById(examId);
    if (!exam) return fail(res, 404, 'Exam not found');

    if (String(exam.creator) !== String(req.user._id) && !isAdmin(req.user)) {
      return fail(res, 403, 'Only the exam author or an admin can send a paper to moderation');
    }

    if (exam.isPublished) {
      return fail(
        res,
        409,
        'That exam is already published — moderation happens before publication, not after'
      );
    }

    const live = await PaperReview.findOne({
      exam: examId,
      status: { $nin: PaperReview.TERMINAL_STATUSES },
    });
    if (live) {
      return fail(res, 409, 'This paper already has a review in progress', {
        reviewId: live._id,
      });
    }

    const review = new PaperReview({
      exam: exam._id,
      examTitle: exam.title,
      course: exam.course,
      academicYear: req.body.academicYear,
      assessmentType,
      author: exam.creator,
      declaredTotalMarks:
        req.body.declaredTotalMarks === undefined
          ? null
          : Number(req.body.declaredTotalMarks),
      questionMeta: sanitiseQuestionMeta(req.body.questionMeta, exam.questions.length),
      dueBy: req.body.dueBy || null,
      embargoUntil: req.body.embargoUntil ? new Date(req.body.embargoUntil) : null,
      isBlind: Boolean(req.body.isBlind),
      status: 'draft',
    });

    if (req.body.cognitiveTarget && typeof req.body.cognitiveTarget === 'object') {
      review.cognitiveTarget = new Map(Object.entries(req.body.cognitiveTarget));
    }

    review.recordHistory('opened', req.user._id);
    await review.save();

    return res.status(201).json({
      success: true,
      message: 'Review opened. Submit it to freeze a version for moderation.',
      data: viewFor(review, exam, req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to open that review');
  }
};

/**
 * PATCH /api/paper-moderation/reviews/:id
 *
 * The author's classification of the paper. The questions themselves live on
 * the exam and are edited there — this only records what each one is testing.
 */
exports.updateReview = async (req, res) => {
  try {
    const result = await loadReviewAndExam(req.params.id);
    if (result.status) return fail(res, result.status, result.message);

    const { review, exam } = result;
    if (!review.isAuthoredBy(req.user) && !isAdmin(req.user)) {
      return fail(res, 403, 'Only the author can classify this paper');
    }
    if (['approved', ...PaperReview.TERMINAL_STATUSES].includes(review.status)) {
      return fail(res, 409, `A ${review.status} review can no longer be edited`);
    }

    if (req.body.assessmentType) review.assessmentType = req.body.assessmentType;
    if (req.body.academicYear) review.academicYear = req.body.academicYear;
    if (req.body.declaredTotalMarks !== undefined) {
      review.declaredTotalMarks =
        req.body.declaredTotalMarks === null ? null : Number(req.body.declaredTotalMarks);
    }
    if (req.body.dueBy !== undefined) review.dueBy = req.body.dueBy;
    if (req.body.embargoUntil !== undefined) {
      review.embargoUntil = req.body.embargoUntil ? new Date(req.body.embargoUntil) : null;
    }

    const meta = sanitiseQuestionMeta(req.body.questionMeta, exam.questions.length);
    if (meta) review.questionMeta = meta;

    if (req.body.cognitiveTarget && typeof req.body.cognitiveTarget === 'object') {
      review.cognitiveTarget = new Map(Object.entries(req.body.cognitiveTarget));
    }

    review.recordHistory('classified', req.user._id);
    await review.save();

    return res.status(200).json({
      success: true,
      message: 'Classification saved',
      data: viewFor(review, exam, req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update that review');
  }
};

/**
 * PATCH /api/paper-moderation/reviews/:id/submit
 *
 * Freeze a version.
 *
 * The fingerprint is taken here, the checks are re-run here, and the version
 * number moves. Everything the moderator subsequently says is said about this
 * version, and the trail records that version 2 was approved and version 1 was
 * not.
 */
exports.submitReview = async (req, res) => {
  try {
    const result = await loadReviewAndExam(req.params.id);
    if (result.status) return fail(res, result.status, result.message);

    const { review, exam } = result;
    if (!review.isAuthoredBy(req.user) && !isAdmin(req.user)) {
      return fail(res, 403, 'Only the author can submit this paper');
    }
    if (PaperReview.TERMINAL_STATUSES.includes(review.status)) {
      return fail(res, 409, `A ${review.status} review cannot be resubmitted`);
    }
    if (PaperReview.MODERATOR_STATUSES.includes(review.status)) {
      return fail(res, 409, 'This version is already with the moderator');
    }

    const isResubmission = review.status === 'changes-requested';
    if (isResubmission) review.paperVersion += 1;

    review.paperFingerprint = PaperReview.fingerprintExam(exam);
    review.checks = review.runChecks(exam);
    review.status = 'submitted';
    review.submittedAt = new Date();

    // A resubmission answers the previous version's findings. Anything still
    // unresolved is carried, so the moderator sees what was not fixed rather
    // than a clean slate.
    if (isResubmission) {
      review.verdict.decision = null;
      review.verdict.decidedBy = null;
      review.verdict.decidedAt = null;
      review.verdict.note = null;
    }

    const blockers = review.blockersIn(review.checks);
    review.recordHistory(
      isResubmission ? 'resubmitted' : 'submitted',
      req.user._id,
      `${blockers.length} blocking check(s) at submission`
    );

    await review.save();

    return res.status(200).json({
      success: true,
      message: `Version ${review.paperVersion} submitted${
        blockers.length ? ` with ${blockers.length} blocking check(s)` : ''
      }`,
      data: viewFor(review, exam, req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to submit that paper');
  }
};

/**
 * GET /api/paper-moderation/reviews/mine
 */
exports.getMyReviews = async (req, res) => {
  try {
    const reviews = await PaperReview.find({ author: req.user._id })
      .populate('moderator', 'name email')
      .sort({ updatedAt: -1 });

    const rows = [];
    for (const review of reviews) {
      const exam = await Exam.findById(review.exam);
      rows.push({
        ...(exam ? viewFor(review, exam, req.user) : review.toObject()),
        examMissing: !exam,
      });
    }

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    return serverError(res, error, 'Failed to load your papers');
  }
};

/**
 * GET /api/paper-moderation/reviews/assigned
 */
exports.getAssignedReviews = async (req, res) => {
  try {
    const reviews = await PaperReview.find({
      moderator: req.user._id,
      status: { $in: PaperReview.MODERATOR_STATUSES },
    })
      .populate('author', 'name email')
      .sort({ submittedAt: 1 });

    const rows = [];
    for (const review of reviews) {
      const exam = await Exam.findById(review.exam);
      if (!exam) continue;
      rows.push({
        ...viewFor(review, exam, req.user),
        author: review.author,
        questions: exam.questions,
        timeLimit: exam.timeLimit,
      });
    }

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    return serverError(res, error, 'Failed to load the papers assigned to you');
  }
};

/**
 * GET /api/paper-moderation/reviews/queue
 *
 * Submitted and unassigned. The list somebody has to act on before a paper can
 * be read by anybody at all.
 */
exports.getQueue = async (req, res) => {
  try {
    const reviews = await PaperReview.find({ status: 'submitted', moderator: null })
      .populate('author', 'name email')
      .sort({ submittedAt: 1 });

    const rows = [];
    for (const review of reviews) {
      const exam = await Exam.findById(review.exam);
      if (!exam) continue;
      const checks = review.runChecks(exam);
      rows.push({
        _id: review._id,
        examTitle: review.examTitle,
        assessmentType: review.assessmentType,
        author: review.author,
        paperVersion: review.paperVersion,
        submittedAt: review.submittedAt,
        dueBy: review.dueBy,
        blueprint: review.buildBlueprint(exam),
        blockerCount: review.blockersIn(checks).length,
        checkCount: checks.length,
      });
    }

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    return serverError(res, error, 'Failed to load the moderation queue');
  }
};

/**
 * GET /api/paper-moderation/reviews
 */
exports.listReviews = async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.assessmentType) filter.assessmentType = req.query.assessmentType;
    if (req.query.author && isValidId(req.query.author)) filter.author = req.query.author;

    const reviews = await PaperReview.find(filter)
      .populate('author', 'name email')
      .populate('moderator', 'name email')
      .sort({ updatedAt: -1 })
      .limit(Math.min(Number(req.query.limit) || 100, 300));

    return res.status(200).json({
      success: true,
      count: reviews.length,
      data: reviews,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load reviews');
  }
};

/**
 * GET /api/paper-moderation/reviews/:id
 */
exports.getReview = async (req, res) => {
  try {
    const result = await loadReviewAndExam(req.params.id);
    if (result.status) return fail(res, result.status, result.message);

    const { review, exam } = result;
    if (!mayRead(review, req.user)) {
      return fail(res, 403, 'This paper is not yours to read');
    }

    await review.populate('author', 'name email');
    if (review.moderator) await review.populate('moderator', 'name email');

    const view = viewFor(review, exam, req.user);

    // The moderator needs the questions; so does the author, who can read them
    // on the exam anyway. Nobody else reaches this handler.
    view.questions = exam.questions;
    view.timeLimit = exam.timeLimit;
    view.examIsPublished = exam.isPublished;

    return res.status(200).json({ success: true, data: view });
  } catch (error) {
    return serverError(res, error, 'Failed to load that review');
  }
};

/**
 * GET /api/paper-moderation/reviews/:id/blueprint
 */
exports.getBlueprint = async (req, res) => {
  try {
    const result = await loadReviewAndExam(req.params.id);
    if (result.status) return fail(res, result.status, result.message);

    const { review, exam } = result;
    if (!mayRead(review, req.user)) {
      return fail(res, 403, 'This paper is not yours to read');
    }

    return res.status(200).json({
      success: true,
      data: {
        blueprint: review.buildBlueprint(exam),
        checks: review.runChecks(exam),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build that blueprint');
  }
};

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/**
 * PATCH /api/paper-moderation/reviews/:id/assign
 */
exports.assignModerator = async (req, res) => {
  try {
    const result = await loadReviewAndExam(req.params.id);
    if (result.status) return fail(res, result.status, result.message);

    const { review, exam } = result;
    const { moderator } = req.body;
    if (!isValidId(moderator)) return fail(res, 400, 'Invalid moderator id');

    const problem = review.assignabilityErrorFor(
      { _id: moderator },
      { examCreator: exam.creator }
    );
    if (problem) return fail(res, 409, problem);

    review.moderator = moderator;
    review.assignedBy = req.user._id;
    review.assignedAt = new Date();
    review.status = 'under-review';
    if (req.body.isBlind !== undefined) review.isBlind = Boolean(req.body.isBlind);

    review.recordHistory('assigned', req.user._id, req.body.note);
    await review.save();

    return res.status(200).json({
      success: true,
      message: 'Moderator assigned',
      data: viewFor(review, exam, req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to assign a moderator');
  }
};

/**
 * PATCH /api/paper-moderation/reviews/:id/claim
 *
 * A teacher taking a paper off the queue themselves. Same refusals as an
 * assignment — the author cannot claim their own paper, and the check is in the
 * model rather than in this handler.
 */
exports.claimReview = async (req, res) => {
  try {
    const result = await loadReviewAndExam(req.params.id);
    if (result.status) return fail(res, result.status, result.message);

    const { review, exam } = result;
    if (review.moderator) {
      return fail(res, 409, 'Somebody is already moderating this paper');
    }

    const problem = review.assignabilityErrorFor(req.user, { examCreator: exam.creator });
    if (problem) return fail(res, 409, problem);

    review.moderator = req.user._id;
    review.assignedBy = req.user._id;
    review.assignedAt = new Date();
    review.status = 'under-review';

    review.recordHistory('claimed', req.user._id);
    await review.save();

    return res.status(200).json({
      success: true,
      message: 'You are moderating this paper',
      data: viewFor(review, exam, req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to claim that paper');
  }
};

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * POST /api/paper-moderation/reviews/:id/findings
 */
exports.addFinding = async (req, res) => {
  try {
    const result = await loadReviewAndExam(req.params.id);
    if (result.status) return fail(res, result.status, result.message);

    const { review, exam } = result;
    if (!review.isModeratedBy(req.user)) {
      return fail(res, 403, 'Only the assigned moderator can raise findings');
    }
    if (!PaperReview.MODERATOR_STATUSES.includes(review.status)) {
      return fail(res, 409, `A ${review.status} review is not open for findings`);
    }

    const index =
      req.body.questionIndex === undefined || req.body.questionIndex === null
        ? null
        : Number(req.body.questionIndex);

    if (index !== null && (!Number.isInteger(index) || !exam.questions[index])) {
      return fail(res, 400, 'That question is not on this paper');
    }

    review.findings.push({
      questionIndex: index,
      questionExcerpt:
        index === null
          ? null
          : String(exam.questions[index].questionText || '').slice(0, 200),
      category: req.body.category,
      severity: req.body.severity,
      comment: req.body.comment,
      raisedBy: req.user._id,
      paperVersion: review.paperVersion,
    });

    review.recordHistory('finding-raised', req.user._id, req.body.category);
    await review.save();

    return res.status(201).json({
      success: true,
      message: 'Finding recorded',
      data: viewFor(review, exam, req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record that finding');
  }
};

/**
 * PATCH /api/paper-moderation/reviews/:id/findings/:findingId/resolve
 *
 * The author says what they did about it. "Did they fix it" becomes a state
 * rather than a memory of an email thread.
 */
exports.resolveFinding = async (req, res) => {
  try {
    const result = await loadReviewAndExam(req.params.id);
    if (result.status) return fail(res, result.status, result.message);

    const { review, exam } = result;
    if (!review.isAuthoredBy(req.user) && !isAdmin(req.user)) {
      return fail(res, 403, 'Only the author can resolve a finding');
    }
    if (!req.body.resolutionNote || !String(req.body.resolutionNote).trim()) {
      return fail(res, 400, 'Say what was done about it');
    }

    const finding = review.findings.id(req.params.findingId);
    if (!finding) return fail(res, 404, 'Finding not found');
    if (finding.resolvedAt) return fail(res, 409, 'That finding is already resolved');

    finding.resolvedAt = new Date();
    finding.resolvedBy = req.user._id;
    finding.resolutionNote = req.body.resolutionNote;

    review.recordHistory('finding-resolved', req.user._id, req.body.resolutionNote);
    await review.save();

    return res.status(200).json({
      success: true,
      message: 'Marked as resolved',
      data: viewFor(review, exam, req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to resolve that finding');
  }
};

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * PATCH /api/paper-moderation/reviews/:id/request-changes
 */
exports.requestChanges = async (req, res) => {
  try {
    const result = await loadReviewAndExam(req.params.id);
    if (result.status) return fail(res, result.status, result.message);

    const { review, exam } = result;
    if (!review.isModeratedBy(req.user)) {
      return fail(res, 403, 'Only the assigned moderator can send this back');
    }
    if (!PaperReview.MODERATOR_STATUSES.includes(review.status)) {
      return fail(res, 409, `A ${review.status} review cannot be sent back`);
    }
    if (review.findings.length === 0) {
      return fail(res, 409, 'Raise at least one finding before asking for changes');
    }

    review.status = 'changes-requested';
    review.recordHistory('changes-requested', req.user._id, req.body.note);
    await review.save();

    return res.status(200).json({
      success: true,
      message: 'Sent back to the author',
      data: viewFor(review, exam, req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to send that paper back');
  }
};

/**
 * PATCH /api/paper-moderation/reviews/:id/approve
 *
 * The approval stores the fingerprint it approved. That single field is what
 * makes every later "has this changed?" answerable.
 */
exports.approveReview = async (req, res) => {
  try {
    const result = await loadReviewAndExam(req.params.id);
    if (result.status) return fail(res, result.status, result.message);

    const { review, exam } = result;
    if (!review.isModeratedBy(req.user)) {
      return fail(res, 403, 'Only the assigned moderator can approve this paper');
    }

    const checks = review.runChecks(exam);
    const problem = review.verdictabilityError(checks);
    if (problem) return fail(res, 409, problem);

    const fingerprint = PaperReview.fingerprintExam(exam);

    // The paper may have moved since it was submitted. Approving what is in
    // front of the moderator now, and recording that, is honest; approving a
    // version that no longer exists is not.
    if (fingerprint !== review.paperFingerprint) {
      review.paperVersion += 1;
      review.paperFingerprint = fingerprint;
      review.recordHistory(
        'version-bumped',
        req.user._id,
        'The paper changed between submission and approval'
      );
    }

    review.checks = checks;
    review.status = 'approved';
    review.verdict.decision = 'approved';
    review.verdict.decidedBy = req.user._id;
    review.verdict.decidedAt = new Date();
    review.verdict.note = req.body.note || null;
    review.verdict.approvedFingerprint = fingerprint;
    review.verdict.approvedVersion = review.paperVersion;

    review.recordHistory('approved', req.user._id, req.body.note);
    await review.save();

    return res.status(200).json({
      success: true,
      message: `Version ${review.paperVersion} approved`,
      data: viewFor(review, exam, req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to approve that paper');
  }
};

/**
 * PATCH /api/paper-moderation/reviews/:id/reject
 */
exports.rejectReview = async (req, res) => {
  try {
    const result = await loadReviewAndExam(req.params.id);
    if (result.status) return fail(res, result.status, result.message);

    const { review, exam } = result;
    if (!review.isModeratedBy(req.user)) {
      return fail(res, 403, 'Only the assigned moderator can reject this paper');
    }
    if (!req.body.note || !String(req.body.note).trim()) {
      return fail(res, 400, 'A rejection needs a reason');
    }
    if (!PaperReview.MODERATOR_STATUSES.includes(review.status)) {
      return fail(res, 409, `A ${review.status} review cannot be rejected`);
    }

    review.status = 'rejected';
    review.verdict.decision = 'rejected';
    review.verdict.decidedBy = req.user._id;
    review.verdict.decidedAt = new Date();
    review.verdict.note = req.body.note;

    review.recordHistory('rejected', req.user._id, req.body.note);
    await review.save();

    return res.status(200).json({
      success: true,
      message: 'Paper rejected',
      data: viewFor(review, exam, req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to reject that paper');
  }
};

/**
 * PATCH /api/paper-moderation/reviews/:id/withdraw
 *
 * A withdrawn review does not vanish. A paper that was pulled out of moderation
 * is itself a fact worth keeping.
 */
exports.withdrawReview = async (req, res) => {
  try {
    const result = await loadReviewAndExam(req.params.id);
    if (result.status) return fail(res, result.status, result.message);

    const { review, exam } = result;
    if (!review.isAuthoredBy(req.user) && !isAdmin(req.user)) {
      return fail(res, 403, 'Only the author or an admin can withdraw this paper');
    }
    if (PaperReview.TERMINAL_STATUSES.includes(review.status)) {
      return fail(res, 409, `This review is already ${review.status}`);
    }
    if (!req.body.reason || !String(req.body.reason).trim()) {
      return fail(res, 400, 'Say why the paper is being withdrawn');
    }

    review.status = 'withdrawn';
    review.recordHistory('withdrawn', req.user._id, req.body.reason);
    await review.save();

    return res.status(200).json({
      success: true,
      message: 'Withdrawn from moderation',
      data: viewFor(review, exam, req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to withdraw that paper');
  }
};

// ---------------------------------------------------------------------------
// Clearance
// ---------------------------------------------------------------------------

/**
 * GET /api/paper-moderation/exams/:examId/clearance
 *
 * May this paper be published? The endpoint the exam module should ask, and the
 * reason the fingerprint is stored at all.
 */
exports.getClearance = async (req, res) => {
  try {
    const { examId } = req.params;
    if (!isValidId(examId)) return fail(res, 400, 'Invalid exam id');

    const exam = await Exam.findById(examId);
    if (!exam) return fail(res, 404, 'Exam not found');

    if (String(exam.creator) !== String(req.user._id) && !isAdmin(req.user)) {
      return fail(res, 403, 'That exam is not yours');
    }

    const review = await PaperReview.findOne({ exam: examId }).sort({ paperVersion: -1 });
    if (!review) {
      return res.status(200).json({
        success: true,
        data: {
          cleared: false,
          reason: 'This paper has never been moderated',
          state: 'unmoderated',
        },
      });
    }

    const clearance = review.clearanceFor(exam);

    // An approved paper that has since been edited is superseded. Writing the
    // status down here rather than only reporting it means the queue and the
    // author's own list agree with the banner.
    if (
      review.status === 'approved' &&
      clearance.state === 'changed' &&
      review.status !== 'superseded'
    ) {
      review.status = 'superseded';
      review.recordHistory(
        'superseded',
        req.user._id,
        `Version ${review.verdict.approvedVersion} was approved; the paper has changed since`
      );
      await review.save();
    }

    return res.status(200).json({
      success: true,
      data: {
        ...clearance,
        reviewId: review._id,
        paperVersion: review.paperVersion,
        approvedVersion: review.verdict.approvedVersion,
        status: review.status,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to check clearance for that exam');
  }
};

/**
 * GET /api/paper-moderation/stats
 */
exports.getStats = async (req, res) => {
  try {
    const reviews = await PaperReview.find({});

    const byStatus = {};
    const byAssessmentType = {};
    let blockerTotal = 0;
    let findingTotal = 0;
    let resolvedTotal = 0;
    let superseded = 0;

    for (const review of reviews) {
      byStatus[review.status] = (byStatus[review.status] || 0) + 1;
      byAssessmentType[review.assessmentType] =
        (byAssessmentType[review.assessmentType] || 0) + 1;
      blockerTotal += (review.checks || []).filter((c) => c.severity === 'blocker').length;
      findingTotal += review.findings.length;
      resolvedTotal += review.findings.filter((f) => f.resolvedAt).length;
      if (review.status === 'superseded') superseded += 1;
    }

    const approved = byStatus.approved || 0;
    const decided = approved + (byStatus.rejected || 0);

    return res.status(200).json({
      success: true,
      data: {
        reviewCount: reviews.length,
        byStatus,
        byAssessmentType,
        awaitingModerator:
          (byStatus.submitted || 0) + (byStatus['under-review'] || 0),
        withAuthor: byStatus['changes-requested'] || 0,
        blockersCaught: blockerTotal,
        findingsRaised: findingTotal,
        findingsResolved: resolvedTotal,
        supersededApprovals: superseded,
        approvalRate: decided ? Math.round((approved / decided) * 100) : null,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build moderation statistics');
  }
};
