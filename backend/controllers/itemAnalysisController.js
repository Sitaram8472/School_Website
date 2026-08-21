// backend/controllers/itemAnalysisController.js
const mongoose = require('mongoose');
const Exam = require('../models/Exam');
const Submission = require('../models/Submission');
const ItemAnalysis = require('../models/ItemAnalysis');

/**
 * Item analysis: how the paper did, rather than how the students did.
 *
 * Everything here is computed from submissions already in the database. The
 * one number the module exists for is discrimination — a question the top of
 * the class gets wrong more often than the bottom is almost always miskeyed,
 * and in a score column it looks entirely ordinary.
 *
 * Below the minimum cohort nothing is computed at all. That is a statistical
 * rule and a privacy one, and it is enforced here rather than left to whoever
 * reads the table.
 */

const handleError = (res, err, message = 'Server error') => {
  console.error('[item-analysis]', err);
  return res.status(500).json({ success: false, message, error: err.message });
};

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const round = (value, places = 3) => {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** Population standard deviation. */
const standardDeviation = (values) => {
  if (values.length === 0) return 0;

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;

  return Math.sqrt(variance);
};

const median = (values) => {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

/**
 * Only the exam's creator, or an admin, may see how their paper performed.
 * Follows the same ownership rule `examController` already applies.
 */
const mayAnalyse = (user, exam) =>
  user.role === 'admin' || String(exam.creator) === String(user._id);

/**
 * The whole computation, kept in one place so the endpoint that runs it and
 * any future scheduled version cannot drift apart.
 */
const computeAnalysis = (exam, submissions, minimumCohort) => {
  const questions = exam.questions || [];
  const cohortSize = submissions.length;

  const base = {
    exam: exam._id,
    course: exam.course || null,
    title: exam.title,
    paperFingerprint: ItemAnalysis.fingerprint(exam),
    cohortSize,
    minimumCohort,
  };

  if (cohortSize < minimumCohort) {
    return {
      ...base,
      suppressed: true,
      suppressionReason:
        `${cohortSize} submission(s) is below the minimum of ${minimumCohort}. ` +
        'Per-question figures are not computed: the sample cannot carry them, and with a ' +
        'cohort this small they would identify individual students.',
      items: [],
    };
  }

  if (questions.length === 0) {
    return {
      ...base,
      suppressed: true,
      suppressionReason: 'The paper has no questions to analyse.',
      items: [],
    };
  }

  // ---- mark every submission against the key ------------------------------

  // marks[s][q] is 1, 0 or null (not attempted), and totals[s] is the number
  // of points that submission earned under this marking.
  const marks = [];
  const totals = [];

  for (const submission of submissions) {
    const answerFor = (submission.answers || []).reduce(
      (map, answer) => ({ ...map, [String(answer.questionId)]: answer.providedAnswer }),
      {}
    );

    const row = [];
    let total = 0;

    for (const question of questions) {
      const provided = answerFor[String(question._id)];
      const attempted = provided !== undefined && provided !== null && String(provided).trim() !== '';

      if (!attempted) {
        row.push(null);
        continue;
      }

      const correct = ItemAnalysis.isCorrect(question, provided);
      row.push(correct ? 1 : 0);
      if (correct) total += question.points || 1;
    }

    marks.push(row);
    totals.push(total);
  }

  const maxPoints = questions.reduce((sum, question) => sum + (question.points || 1), 0);
  const percents = totals.map((total) => (maxPoints > 0 ? (total / maxPoints) * 100 : 0));

  // ---- the upper and lower groups -----------------------------------------

  // Ranked by total, then split. The group size has a floor of one and is
  // capped at half the cohort, so a class of twelve does not produce two
  // "groups" that overlap in the middle.
  //
  // Ties are broken by position so the same data always produces the same
  // groups. Where many totals are equal the boundary is genuinely arbitrary —
  // that is a property of the upper-lower index, not of this implementation,
  // and it is why `pointBiserial` is reported alongside: it uses the whole
  // cohort and does not depend on where a tie falls.
  const ranked = totals
    .map((total, index) => ({ index, total }))
    .sort((a, b) => b.total - a.total || a.index - b.index);

  const rawGroupSize = Math.round(cohortSize * ItemAnalysis.GROUP_FRACTION);
  const groupSize = Math.max(1, Math.min(rawGroupSize, Math.floor(cohortSize / 2)));

  const upper = ranked.slice(0, groupSize).map((entry) => entry.index);
  const lower = ranked.slice(cohortSize - groupSize).map((entry) => entry.index);

  // Membership is asked once per submission per question, so it is a set
  // rather than a repeated scan of the group arrays.
  const upperSet = new Set(upper);
  const lowerSet = new Set(lower);

  const totalsSd = standardDeviation(totals);

  // ---- per question --------------------------------------------------------

  const items = questions.map((question, questionIndex) => {
    const column = marks.map((row) => row[questionIndex]);

    const attempted = column.filter((value) => value !== null).length;
    const correct = column.filter((value) => value === 1).length;
    const facility = attempted > 0 ? correct / attempted : 0;

    const groupFacility = (group) => {
      const values = group.map((index) => column[index]).filter((value) => value !== null);
      if (values.length === 0) return 0;
      return values.filter((value) => value === 1).length / values.length;
    };

    const discrimination = groupFacility(upper) - groupFacility(lower);

    // Point-biserial: how the whole cohort's totals separate on this item.
    // Unattempted counts as not-correct here, because the correlation needs
    // every submission on one side or the other.
    let pointBiserial = null;

    if (totalsSd > 0) {
      const gotIt = [];
      const missedIt = [];

      column.forEach((value, index) => {
        if (value === 1) gotIt.push(totals[index]);
        else missedIt.push(totals[index]);
      });

      if (gotIt.length > 0 && missedIt.length > 0) {
        const meanRight = gotIt.reduce((sum, value) => sum + value, 0) / gotIt.length;
        const meanWrong = missedIt.reduce((sum, value) => sum + value, 0) / missedIt.length;
        const p = gotIt.length / cohortSize;

        pointBiserial = ((meanRight - meanWrong) / totalsSd) * Math.sqrt(p * (1 - p));
      }
    }

    // ---- distractors ------------------------------------------------------

    const distractors = [];

    if (question.type === 'MCQ' && (question.options || []).length) {
      const chosen = question.options.reduce((map, option) => ({ ...map, [option]: 0 }), {});
      const chosenUpper = { ...chosen };
      const chosenLower = { ...chosen };

      submissions.forEach((submission, submissionIndex) => {
        const answer = (submission.answers || []).find(
          (entry) => String(entry.questionId) === String(question._id)
        );
        if (!answer) return;

        const given = String(answer.providedAnswer || '').trim();
        if (!(given in chosen)) return;

        chosen[given] += 1;
        if (upperSet.has(submissionIndex)) chosenUpper[given] += 1;
        if (lowerSet.has(submissionIndex)) chosenLower[given] += 1;
      });

      for (const option of question.options) {
        distractors.push({
          option,
          isKey: option === question.correctAnswer,
          chosenBy: chosen[option],
          chosenByUpperGroup: chosenUpper[option],
          chosenByLowerGroup: chosenLower[option],
        });
      }
    }

    // ---- flags ------------------------------------------------------------

    const flags = [];

    if (facility >= ItemAnalysis.EASY_ABOVE) flags.push('too-easy');
    if (facility <= ItemAnalysis.HARD_BELOW) flags.push('too-hard');
    if (Math.abs(discrimination) < ItemAnalysis.FLAT_DISCRIMINATION) {
      flags.push('non-discriminating');
    }
    if (discrimination < 0) flags.push('negative-discrimination');

    // The point of the module. Strong students getting it wrong more often
    // than weak ones has one common cause, and it is worth naming rather than
    // leaving a teacher to interpret a minus sign.
    if (discrimination <= ItemAnalysis.MISKEY_DISCRIMINATION) flags.push('suspected-miskey');

    if (distractors.some((entry) => !entry.isKey && entry.chosenBy === 0)) {
      flags.push('dead-distractor');
    }
    if (
      distractors.some(
        (entry) => !entry.isKey && entry.chosenByUpperGroup > entry.chosenByLowerGroup
      )
    ) {
      // A wrong option that appeals to the strongest students is either a
      // second defensible answer or a genuinely subtle trap. Both are worth a
      // look; neither is visible in a score list.
      flags.push('ambiguous-distractor');
    }

    return {
      questionId: question._id,
      questionText: question.questionText,
      type: question.type,
      points: question.points || 1,
      attempted,
      correct,
      facility: round(facility),
      discrimination: round(discrimination),
      pointBiserial: round(pointBiserial),
      distractors,
      flags,
    };
  });

  // ---- KR-20 ---------------------------------------------------------------

  // Refused rather than emitted as NaN or 0 when it is meaningless: fewer than
  // two items, or a cohort where every total is identical.
  let reliabilityKr20 = null;

  if (questions.length >= 2 && totalsSd > 0) {
    const k = questions.length;
    const varianceTotal = totalsSd ** 2;

    const sumPq = items.reduce((sum, item) => {
      const p = item.facility || 0;
      return sum + p * (1 - p);
    }, 0);

    reliabilityKr20 = (k / (k - 1)) * (1 - sumPq / varianceTotal);
  }

  return {
    ...base,
    suppressed: false,
    suppressionReason: '',
    maxPoints,
    meanScore: round(totals.reduce((sum, value) => sum + value, 0) / cohortSize, 2),
    meanPercent: round(percents.reduce((sum, value) => sum + value, 0) / cohortSize, 1),
    medianPercent: round(median(percents), 1),
    standardDeviation: round(totalsSd, 2),
    // Reduced rather than spread into Math.min/Math.max: a whole year group's
    // submissions is more arguments than a call frame should take.
    minPercent: round(percents.reduce((low, value) => (value < low ? value : low), percents[0]), 1),
    maxPercent: round(percents.reduce((high, value) => (value > high ? value : high), percents[0]), 1),
    reliabilityKr20: round(reliabilityKr20),
    upperGroupSize: groupSize,
    lowerGroupSize: groupSize,
    items,
  };
};

// ---- REFERENCE DATA ----

/**
 * GET /api/exams/item-analysis/meta
 */
exports.getAnalysisMeta = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        flags: ItemAnalysis.ITEM_FLAGS,
        defaultMinimumCohort: ItemAnalysis.DEFAULT_MINIMUM_COHORT,
        absoluteMinimumCohort: ItemAnalysis.ABSOLUTE_MINIMUM_COHORT,
        groupFraction: ItemAnalysis.GROUP_FRACTION,
        thresholds: {
          easyAbove: ItemAnalysis.EASY_ABOVE,
          hardBelow: ItemAnalysis.HARD_BELOW,
          flatDiscrimination: ItemAnalysis.FLAT_DISCRIMINATION,
          miskeyDiscrimination: ItemAnalysis.MISKEY_DISCRIMINATION,
        },
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load analysis reference data');
  }
};

// ---- RUNNING ----

/**
 * POST /api/exams/:examId/item-analysis
 * Re-running creates a new snapshot and links the previous one, rather than
 * overwriting it.
 */
exports.runAnalysis = async (req, res) => {
  try {
    const { examId } = req.params;

    if (!isValidId(examId)) {
      return res.status(400).json({ success: false, message: 'Invalid exam id.' });
    }

    const exam = await Exam.findById(examId);
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam not found.' });
    }
    if (!mayAnalyse(req.user, exam)) {
      return res.status(403).json({
        success: false,
        message: 'Only the teacher who set this exam, or an admin, may analyse it.',
      });
    }

    const requested = parseInt(req.body.minimumCohort, 10);
    const minimumCohort = Number.isNaN(requested)
      ? ItemAnalysis.DEFAULT_MINIMUM_COHORT
      : Math.max(ItemAnalysis.ABSOLUTE_MINIMUM_COHORT, requested);

    const submissions = await Submission.find({ exam: exam._id }).select('answers score').lean();

    const computed = computeAnalysis(exam, submissions, minimumCohort);

    const analysis = new ItemAnalysis({ ...computed, analysedBy: req.user._id, analysedAt: new Date() });

    await analysis.save();

    // Link the previous snapshot forward. Done after the new one exists so a
    // failure here cannot leave the old one pointing at nothing.
    const previous = await ItemAnalysis.findOne({
      exam: exam._id,
      _id: { $ne: analysis._id },
      supersededBy: null,
    }).sort({ analysedAt: -1 });

    if (previous) {
      await ItemAnalysis.updateOne({ _id: previous._id }, { $set: { supersededBy: analysis._id } });
    }

    return res.status(201).json({
      success: true,
      message: analysis.suppressed
        ? analysis.suppressionReason
        : `Analysed ${analysis.cohortSize} submissions across ${analysis.items.length} questions.`,
      data: { ...analysis.toObject(), isCurrent: true },
    });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: err.message });
    }
    return handleError(res, err, 'Could not run the analysis');
  }
};

// ---- READING ----

/**
 * GET /api/exams/:examId/item-analysis
 * The most recent snapshot, with an honest answer about whether it still
 * describes the paper as it stands.
 */
exports.getLatestAnalysis = async (req, res) => {
  try {
    const { examId } = req.params;

    if (!isValidId(examId)) {
      return res.status(400).json({ success: false, message: 'Invalid exam id.' });
    }

    const exam = await Exam.findById(examId);
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam not found.' });
    }
    if (!mayAnalyse(req.user, exam)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const analysis = await ItemAnalysis.findOne({ exam: exam._id })
      .populate('analysedBy', 'name role')
      .sort({ analysedAt: -1 });

    if (!analysis) {
      return res.status(200).json({ success: true, data: null, message: 'No analysis has been run yet.' });
    }

    const isCurrent = analysis.isCurrentFor(exam);

    return res.status(200).json({
      success: true,
      data: {
        ...analysis.toObject(),
        isCurrent,
        // A stale snapshot is kept and labelled rather than deleted: it is the
        // evidence of the mistake that prompted the edit.
        staleReason: isCurrent
          ? ''
          : 'The exam has been edited since this analysis was run, so the figures describe an older version of the paper.',
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load the analysis');
  }
};

/**
 * GET /api/exams/:examId/item-analysis/history
 */
exports.getAnalysisHistory = async (req, res) => {
  try {
    const { examId } = req.params;

    if (!isValidId(examId)) {
      return res.status(400).json({ success: false, message: 'Invalid exam id.' });
    }

    const exam = await Exam.findById(examId);
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam not found.' });
    }
    if (!mayAnalyse(req.user, exam)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const analyses = await ItemAnalysis.find({ exam: exam._id })
      .select('cohortSize analysedAt analysedBy meanPercent reliabilityKr20 suppressed supersededBy paperFingerprint')
      .populate('analysedBy', 'name role')
      .sort({ analysedAt: -1 })
      .lean();

    const current = ItemAnalysis.fingerprint(exam);

    return res.status(200).json({
      success: true,
      count: analyses.length,
      data: analyses.map((analysis) => ({
        ...analysis,
        isCurrent: analysis.paperFingerprint === current,
      })),
    });
  } catch (err) {
    return handleError(res, err, 'Could not load the analysis history');
  }
};

/**
 * GET /api/exams/item-analysis/:id
 */
exports.getAnalysis = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid analysis id.' });
    }

    const analysis = await ItemAnalysis.findById(id).populate('analysedBy', 'name role');
    if (!analysis) {
      return res.status(404).json({ success: false, message: 'Analysis not found.' });
    }

    const exam = await Exam.findById(analysis.exam);
    if (exam && !mayAnalyse(req.user, exam)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    return res.status(200).json({
      success: true,
      data: { ...analysis.toObject(), isCurrent: exam ? analysis.isCurrentFor(exam) : false },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load the analysis');
  }
};

/**
 * POST /api/exams/item-analysis/:id/notes
 * Append-only, against one question.
 */
exports.addNote = async (req, res) => {
  try {
    const { id } = req.params;
    const { questionId, text } = req.body;

    if (!isValidId(id) || !isValidId(questionId)) {
      return res.status(400).json({ success: false, message: 'A valid analysis and question are required.' });
    }

    const analysis = await ItemAnalysis.findById(id);
    if (!analysis) {
      return res.status(404).json({ success: false, message: 'Analysis not found.' });
    }

    const exam = await Exam.findById(analysis.exam);
    if (exam && !mayAnalyse(req.user, exam)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    try {
      analysis.addNote(req.user, questionId, text);
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }

    await analysis.save();

    return res.status(200).json({ success: true, message: 'Note added.', data: analysis.notes });
  } catch (err) {
    return handleError(res, err, 'Could not add the note');
  }
};

/**
 * GET /api/exams/item-analysis/flagged
 *
 * Every current snapshot that carries a suspected miskey, across the school.
 * A miskey costs the whole class marks, so it is worth an admin being able to
 * find them without opening each exam in turn.
 */
exports.getFlagged = async (req, res) => {
  try {
    const analyses = await ItemAnalysis.find({
      suppressed: false,
      supersededBy: null,
      'items.flags': 'suspected-miskey',
    })
      .populate('analysedBy', 'name role')
      .sort({ analysedAt: -1 })
      .limit(50)
      .lean();

    const rows = analyses.map((analysis) => ({
      _id: analysis._id,
      exam: analysis.exam,
      title: analysis.title,
      cohortSize: analysis.cohortSize,
      analysedAt: analysis.analysedAt,
      analysedBy: analysis.analysedBy,
      suspect: analysis.items
        .filter((item) => item.flags.includes('suspected-miskey'))
        .map((item) => ({
          questionId: item.questionId,
          questionText: item.questionText,
          facility: item.facility,
          discrimination: item.discrimination,
        })),
    }));

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (err) {
    return handleError(res, err, 'Could not load the flagged items');
  }
};
