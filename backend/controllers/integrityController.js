// backend/controllers/integrityController.js
const mongoose = require('mongoose');
const IntegrityCase = require('../models/IntegrityCase');
const Submission = require('../models/Submission');
const Exam = require('../models/Exam');
const User = require('../models/User');

/**
 * Academic-integrity cases against exam submissions.
 *
 * Three rules carry this file, and each of them exists because the current
 * arrangement — a red chip showing a tab-switch count — fails at it:
 *
 *   one live case per submission, enforced by a unique partial index rather
 *   than a read-then-write check;
 *
 *   the person who opened a case never decides it;
 *
 *   the score is changed once, with the previous value stored, and never by a
 *   later edit to the case.
 */

const handleError = (res, err, message = 'Server error') => {
  console.error('[integrity]', err);
  return res.status(500).json({ success: false, message, error: err.message });
};

const getPagination = (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
};

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const isReviewer = (user) => user && (user.role === 'teacher' || user.role === 'admin');

/**
 * What a student is allowed to see of their own case.
 *
 * Deliberately not the whole document: who inside the school opened it, and
 * the internal decision note, are not theirs. The allegation, the evidence
 * against them, the deadline and the outcome are.
 */
const studentView = (record) => ({
  _id: record._id,
  caseRef: record.caseRef,
  examTitle: record.examTitle,
  allegation: record.allegation,
  narrative: record.narrative,
  evidence: (record.evidence || []).map((item) => ({
    kind: item.kind,
    detail: item.detail,
    capturedAt: item.capturedAt,
  })),
  severityClaimed: record.severityClaimed,
  status: record.status,
  openedAt: record.openedAt,
  respondByDate: record.respondByDate,
  studentResponse: record.studentResponse,
  outcome: record.outcome,
  penaltyPercent: record.penaltyPercent,
  scoreBeforeOutcome: record.scoreBeforeOutcome,
  scoreAfterOutcome: record.scoreAfterOutcome,
  reviewedAt: record.reviewedAt,
  decidedWithoutResponse: record.decidedWithoutResponse,
});

// ---- REFERENCE DATA ----

/**
 * GET /api/submissions/integrity/meta
 */
exports.getIntegrityMeta = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        allegations: IntegrityCase.ALLEGATIONS,
        evidenceKinds: IntegrityCase.EVIDENCE_KINDS,
        severities: IntegrityCase.SEVERITIES,
        statuses: IntegrityCase.STATUSES,
        liveStatuses: IntegrityCase.LIVE_STATUSES,
        outcomes: IntegrityCase.OUTCOMES,
        scoreChangingOutcomes: IntegrityCase.SCORE_CHANGING_OUTCOMES,
        defaultResponseDays: IntegrityCase.DEFAULT_RESPONSE_DAYS,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load integrity reference data');
  }
};

// ---- OPENING ----

/**
 * POST /api/submissions/integrity
 *
 * A case is opened against a submission, never against a student in general,
 * and never automatically by a warning threshold. Three tab-switches on a
 * flaky connection should not accuse a child of anything.
 */
exports.openCase = async (req, res) => {
  try {
    const { submission, allegation, narrative, severityClaimed, respondByDays, evidence } = req.body;

    if (!isValidId(submission)) {
      return res.status(400).json({ success: false, message: 'A valid submission id is required.' });
    }
    if (!IntegrityCase.ALLEGATIONS.includes(allegation)) {
      return res.status(400).json({
        success: false,
        message: `Allegation must be one of: ${IntegrityCase.ALLEGATIONS.join(', ')}`,
      });
    }
    if (!narrative || String(narrative).trim().length < 20) {
      return res.status(400).json({
        success: false,
        message: 'Describe what was observed in at least 20 characters.',
      });
    }

    const record = await Submission.findById(submission);
    if (!record) {
      return res.status(404).json({ success: false, message: 'Submission not found.' });
    }
    if (!record.student) {
      return res.status(409).json({
        success: false,
        message: 'That submission has no student attached, so there is nobody to answer the case.',
      });
    }

    // Read the name separately rather than populating: a populate that finds
    // no matching user quietly yields null, and losing the student id is the
    // one thing this document cannot survive.
    const student = await User.findById(record.student).select('name');

    const exam = await Exam.findById(record.exam).select('title creator');
    if (!exam) {
      return res.status(404).json({ success: false, message: 'The exam for that submission is gone.' });
    }

    // A teacher may open a case on their own exam. An admin may open one on
    // any. Opening a case on somebody else's exam without being an admin is
    // not a thing that should be possible from this screen.
    if (req.user.role !== 'admin' && String(exam.creator) !== String(req.user._id)) {
      return res.status(403).json({
        success: false,
        message: 'Only the teacher who set this exam, or an admin, may open a case on it.',
      });
    }

    const days = Math.min(30, Math.max(1, parseInt(respondByDays, 10) || IntegrityCase.DEFAULT_RESPONSE_DAYS));

    const integrityCase = new IntegrityCase({
      submission: record._id,
      exam: exam._id,
      student: record.student,
      examTitle: exam.title,
      studentName: (student && student.name) || '',
      allegation,
      narrative: String(narrative).trim(),
      severityClaimed: IntegrityCase.SEVERITIES.includes(severityClaimed) ? severityClaimed : 'moderate',
      warningCountAtOpen: record.cheatWarnings || 0,
      openedBy: req.user._id,
      openedAt: new Date(),
      respondByDate: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
    });

    // The warning count is evidence, not a trigger — so it is recorded as one
    // piece of evidence among others rather than as the case itself.
    if (record.cheatWarnings > 0) {
      integrityCase.evidence.push({
        kind: 'warning-count',
        detail: `${record.cheatWarnings} anti-cheat warning(s) recorded during the sitting`,
        capturedAt: record.createdAt || new Date(),
        addedBy: req.user._id,
        addedByName: req.user.name || '',
      });
    }

    if (Array.isArray(evidence)) {
      for (const item of evidence) {
        try {
          integrityCase.addEvidence(req.user, item);
        } catch (err) {
          return res.status(400).json({ success: false, message: err.message });
        }
      }
    }

    integrityCase.log('opened', req.user, allegation);

    try {
      await integrityCase.save();
    } catch (err) {
      // The unique partial index is the guard. Two teachers opening a case on
      // the same submission at the same moment: one wins, and the other is
      // told where to put their evidence.
      if (err.code === 11000) {
        const existing = await IntegrityCase.findOne({ submission: record._id, isOpen: true });
        return res.status(409).json({
          success: false,
          message: 'A case is already open on this submission. Add your evidence to it instead.',
          data: existing ? { _id: existing._id, caseRef: existing.caseRef } : null,
        });
      }
      throw err;
    }

    return res.status(201).json({
      success: true,
      message: `Case ${integrityCase.caseRef} opened. The student has until ${integrityCase.respondByDate
        .toISOString()
        .slice(0, 10)} to reply.`,
      data: integrityCase,
    });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: err.message });
    }
    return handleError(res, err, 'Could not open the case');
  }
};

// ---- READING ----

/**
 * GET /api/submissions/integrity
 *
 * The queue, ordered by how close the response deadline is. The failure this
 * ordering fixes is cases going quietly stale while everyone waits for
 * somebody else to look at them.
 */
exports.getCases = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const { status, exam, student, live } = req.query;

    const filter = {};

    if (status && IntegrityCase.STATUSES.includes(status)) filter.status = status;
    if (live === 'true') filter.isOpen = true;
    if (exam && isValidId(exam)) filter.exam = exam;
    if (student && isValidId(student)) filter.student = student;

    const [cases, total] = await Promise.all([
      IntegrityCase.find(filter)
        .populate('openedBy', 'name role')
        .populate('reviewedBy', 'name role')
        .populate('student', 'name email')
        .sort({ isOpen: -1, respondByDate: 1 })
        .skip(skip)
        .limit(limit),
      IntegrityCase.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      count: cases.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      data: cases,
    });
  } catch (err) {
    return handleError(res, err, 'Could not load integrity cases');
  }
};

/**
 * GET /api/submissions/integrity/mine
 * Scoped by the token. A student sees their own cases and nothing else — not
 * the queue, not other students, not who opened it.
 */
exports.getMyCases = async (req, res) => {
  try {
    const cases = await IntegrityCase.find({ student: req.user._id })
      .sort({ openedAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: cases.length,
      data: cases.map(studentView),
    });
  } catch (err) {
    return handleError(res, err, 'Could not load your cases');
  }
};

/**
 * GET /api/submissions/integrity/:id
 */
exports.getCase = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid case id.' });
    }

    const record = await IntegrityCase.findById(id)
      .populate('openedBy', 'name role')
      .populate('reviewedBy', 'name role')
      .populate('student', 'name email');

    if (!record) {
      return res.status(404).json({ success: false, message: 'Case not found.' });
    }

    const owns = String(record.student?._id || record.student) === String(req.user._id);

    if (owns && !isReviewer(req.user)) {
      return res.status(200).json({ success: true, data: studentView(record) });
    }
    if (!isReviewer(req.user)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const submission = await Submission.findById(record.submission).select('score cheatWarnings');

    return res.status(200).json({
      success: true,
      data: {
        ...record.toObject(),
        currentScore: submission ? submission.score : null,
        // Shown in the decision form so the consequence is visible before it
        // is chosen, rather than discovered afterwards.
        projected: submission
          ? {
              'score-void': record.projectedScore(submission.score, 'score-void'),
              'partial-penalty-50': record.projectedScore(submission.score, 'partial-penalty', 50),
            }
          : null,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load the case');
  }
};

// ---- EVIDENCE AND REPLY ----

/**
 * POST /api/submissions/integrity/:id/evidence
 */
exports.addEvidence = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid case id.' });
    }

    const record = await IntegrityCase.findById(id);
    if (!record) {
      return res.status(404).json({ success: false, message: 'Case not found.' });
    }

    try {
      record.addEvidence(req.user, req.body);
    } catch (err) {
      return res.status(409).json({ success: false, message: err.message });
    }

    await record.save();

    return res.status(200).json({ success: true, message: 'Evidence added.', data: record });
  } catch (err) {
    return handleError(res, err, 'Could not add the evidence');
  }
};

/**
 * POST /api/submissions/integrity/:id/response
 *
 * The student's own words. This endpoint is the reason the module exists at
 * all: a malpractice decision taken without asking is the one that gets
 * overturned the moment somebody escalates it.
 */
exports.recordResponse = async (req, res) => {
  try {
    const { id } = req.params;
    const { text } = req.body;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid case id.' });
    }

    const record = await IntegrityCase.findById(id);
    if (!record) {
      return res.status(404).json({ success: false, message: 'Case not found.' });
    }

    try {
      record.recordResponse(req.user, text);
    } catch (err) {
      return res.status(403).json({ success: false, message: err.message });
    }

    await record.save();

    return res.status(200).json({
      success: true,
      message: record.studentResponse.wasLate
        ? 'Your reply has been recorded. It arrived after the deadline, which is noted on the case.'
        : 'Your reply has been recorded.',
      data: studentView(record),
    });
  } catch (err) {
    return handleError(res, err, 'Could not record your reply');
  }
};

// ---- DECIDING ----

/**
 * PATCH /api/submissions/integrity/:id/review
 *
 * The decision, and the single application of its consequence.
 *
 * The case is written with a guarded update that only matches while it is
 * still open and unapplied, so a double-click cannot deduct twice. The score
 * change is then made with the previous score in the filter, so a mark being
 * corrected elsewhere at the same moment is not silently overwritten — and if
 * that guard fails, the decision is rolled back rather than left half-applied.
 */
exports.reviewCase = async (req, res) => {
  try {
    const { id } = req.params;
    const { outcome, penaltyPercent, note } = req.body;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid case id.' });
    }

    const record = await IntegrityCase.findById(id);
    if (!record) {
      return res.status(404).json({ success: false, message: 'Case not found.' });
    }

    const submission = await Submission.findById(record.submission);
    if (!submission) {
      return res.status(404).json({ success: false, message: 'The submission is gone.' });
    }

    try {
      record.decide(req.user, { outcome, penaltyPercent, note });
    } catch (err) {
      return res.status(409).json({ success: false, message: err.message });
    }

    const changesScore = IntegrityCase.SCORE_CHANGING_OUTCOMES.includes(record.outcome);
    const scoreBefore = submission.score || 0;
    const scoreAfter = changesScore
      ? record.projectedScore(scoreBefore, record.outcome, record.penaltyPercent)
      : null;

    const decision = {
      status: record.status,
      outcome: record.outcome,
      penaltyPercent: record.penaltyPercent,
      decisionNote: record.decisionNote,
      reviewedBy: req.user._id,
      reviewedAt: record.reviewedAt,
      decidedWithoutResponse: record.decidedWithoutResponse,
      isOpen: false,
      outcomeAppliedAt: new Date(),
      scoreBeforeOutcome: changesScore ? scoreBefore : null,
      scoreAfterOutcome: changesScore ? scoreAfter : null,
    };

    const claimed = await IntegrityCase.findOneAndUpdate(
      { _id: record._id, isOpen: true, outcomeAppliedAt: null },
      {
        $set: decision,
        $push: {
          history: {
            action: 'decided',
            by: req.user._id,
            byName: req.user.name || '',
            at: new Date(),
            note: changesScore ? `${record.outcome}: ${scoreBefore} → ${scoreAfter}` : record.outcome,
          },
        },
      },
      { new: true }
    );

    if (!claimed) {
      return res.status(409).json({
        success: false,
        message: 'This case was decided by someone else a moment ago.',
      });
    }

    if (changesScore) {
      const updated = await Submission.findOneAndUpdate(
        { _id: submission._id, score: scoreBefore },
        { $set: { score: scoreAfter } },
        { new: true }
      );

      if (!updated) {
        // Roll the decision back rather than leave a case saying the score was
        // changed when it was not.
        await IntegrityCase.updateOne(
          { _id: claimed._id },
          {
            $set: {
              status: 'under-review',
              isOpen: true,
              outcome: null,
              penaltyPercent: null,
              reviewedBy: null,
              reviewedAt: null,
              outcomeAppliedAt: null,
              scoreBeforeOutcome: null,
              scoreAfterOutcome: null,
            },
            $push: {
              history: {
                action: 'decision-reverted',
                by: req.user._id,
                byName: req.user.name || '',
                at: new Date(),
                note: 'The score changed while the decision was being taken',
              },
            },
          }
        );

        return res.status(409).json({
          success: false,
          message:
            'The submission score changed while this decision was being taken. ' +
            'Nothing was applied — re-open the case and check the mark.',
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: changesScore
        ? `Case ${claimed.caseRef} upheld. Score ${scoreBefore} → ${scoreAfter}.`
        : `Case ${claimed.caseRef} ${claimed.status}.`,
      data: claimed,
    });
  } catch (err) {
    return handleError(res, err, 'Could not record the decision');
  }
};

/**
 * PATCH /api/submissions/integrity/:id/withdraw
 *
 * Recorded as a withdrawal rather than a dismissal, because "I was wrong to
 * raise this" and "it was raised and found unproven" are different facts about
 * a student and should not be stored as the same one.
 */
exports.withdrawCase = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid case id.' });
    }

    const record = await IntegrityCase.findById(id);
    if (!record) {
      return res.status(404).json({ success: false, message: 'Case not found.' });
    }

    try {
      record.withdraw(req.user, reason);
    } catch (err) {
      return res.status(409).json({ success: false, message: err.message });
    }

    await record.save();

    return res.status(200).json({ success: true, message: 'Case withdrawn.', data: record });
  } catch (err) {
    return handleError(res, err, 'Could not withdraw the case');
  }
};

// ---- REPORTING ----

/**
 * GET /api/submissions/integrity/stats
 * "How many malpractice cases did we have last term, and what happened to
 * them" — a question with no answer at all today.
 */
exports.getStats = async (req, res) => {
  try {
    const [byStatus, byAllegation, byOutcome, overdue] = await Promise.all([
      IntegrityCase.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
      IntegrityCase.aggregate([
        { $group: { _id: '$allegation', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      IntegrityCase.aggregate([
        { $match: { outcome: { $ne: null } } },
        { $group: { _id: '$outcome', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      // Cases whose response window has closed and which nobody has decided.
      // This is the number that says whether the process is actually running.
      IntegrityCase.countDocuments({ isOpen: true, respondByDate: { $lt: new Date() } }),
    ]);

    const decidedWithoutResponse = await IntegrityCase.countDocuments({
      decidedWithoutResponse: true,
    });

    return res.status(200).json({
      success: true,
      data: {
        byStatus,
        byAllegation,
        byOutcome,
        awaitingDecisionPastDeadline: overdue,
        decidedWithoutResponse,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not build the integrity statistics');
  }
};
