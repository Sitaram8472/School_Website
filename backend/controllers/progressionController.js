// backend/controllers/progressionController.js
const mongoose = require('mongoose');
const User = require('../models/User');
const Course = require('../models/Course');
const Exam = require('../models/Exam');
const Submission = require('../models/Submission');
const Attendance = require('../models/Attendance');
const ProgressionDecision = require('../models/ProgressionDecision');
const { ProgressionRule, ProgressionCohort } = require('../models/ProgressionDecision');

/**
 * Year-end progression.
 *
 * `computeEvidence` is the function everything else hangs off. It aggregates
 * attendance out of the registers and subject results out of `Submission`
 * against `Exam`, and it is called on every read of an unpublished decision.
 * Nothing a client sends is used: a body offering an attendance percentage is
 * ignored, because the one number a school must never take on trust is the one
 * that decides whether a child repeats a year.
 *
 * `recommendation` is stored beside `decision` and never overwritten by it.
 * That separation is the whole design — see the model header.
 */

const handleError = (res, err, message = 'Server error') => {
  console.error('[progression]', err);
  return res.status(500).json({ success: false, message, error: err.message });
};

const fail = (res, status, message, extra = {}) =>
  res.status(status).json({ success: false, message, ...extra });

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const isStaff = (user) => user && ['teacher', 'admin'].includes(user.role);
const isAdmin = (user) => user && user.role === 'admin';

const asBadRequest = (err) =>
  err instanceof Error && !['MongoServerError', 'MongooseError', 'ValidationError'].includes(err.name);

const getPagination = (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(300, Math.max(1, parseInt(req.query.limit, 10) || 100));
  return { page, limit, skip: (page - 1) * limit };
};

const publicDecision = (decision) => ({
  _id: decision._id,
  student: decision.student,
  studentName: decision.studentName,
  academicYear: decision.academicYear,
  fromClass: decision.fromClass,
  toClass: decision.toClass,
  evidence: decision.evidence,
  recommendation: decision.recommendation,
  recommendationReasons: decision.recommendationReasons,
  decision: decision.decision,
  isOverride: decision.isOverride,
  overrideReason: decision.overrideReason,
  counterSignedByName: decision.counterSignedByName,
  counterSignedAt: decision.counterSignedAt,
  conditions: decision.conditions,
  decidedByName: decision.decidedByName,
  decidedAt: decision.decidedAt,
  status: decision.status,
  publishedAt: decision.publishedAt,
  withdrawalReason: decision.withdrawalReason,
  history: decision.history,
});

/**
 * Attendance, out of the registers, and results, out of the submissions.
 *
 * Both computed on demand and stamped with `computedAt`. Neither is stored
 * anywhere that could drift, and neither is accepted from a request.
 *
 * The attendance side matches on the register's free-text `studentName`,
 * because that is the only key `Attendance.records[]` has. It is a weak join
 * and it is the one that exists; where it finds nothing, `sessionsRecorded` is
 * zero, the evidence floor catches it, and the recommendation says so rather
 * than reporting 0% and recommending a retention.
 */
const computeEvidence = async (student, className) => {
  const registers = await Attendance.find({ className }).select('records');

  const wanted = String(student.name || '').trim().toLowerCase();
  let sessionsRecorded = 0;
  let sessionsPresent = 0;

  registers.forEach((register) => {
    register.records.forEach((record) => {
      if (String(record.studentName || '').trim().toLowerCase() !== wanted) return;
      sessionsRecorded += 1;
      if (record.status === 'Present') sessionsPresent += 1;
    });
  });

  const courses = await Course.find({ students: student._id }).select('name');
  const courseIds = courses.map((course) => course._id);
  const courseNames = new Map(courses.map((course) => [String(course._id), course.name]));

  const exams = await Exam.find({ course: { $in: courseIds } }).select('course questions title');
  const submissions = await Submission.find({
    student: student._id,
    exam: { $in: exams.map((exam) => exam._id) },
  }).select('exam score');

  const scoreByExam = new Map(submissions.map((row) => [String(row.exam), row.score || 0]));

  // Totals per subject, so a subject with three exams is one result rather
  // than three. A per-exam pass rate would let a strong mock hide a failed
  // final, which is not what "passed the subject" means.
  const bySubject = new Map();

  exams.forEach((exam) => {
    if (!scoreByExam.has(String(exam._id))) return;

    const possible = (exam.questions || []).reduce(
      (sum, question) => sum + (question.points || 1),
      0
    );
    if (!possible) return;

    const key = String(exam.course);
    const current = bySubject.get(key) || { scored: 0, possible: 0 };
    current.scored += scoreByExam.get(String(exam._id));
    current.possible += possible;
    bySubject.set(key, current);
  });

  return { sessionsRecorded, sessionsPresent, bySubject, courseNames };
};

/**
 * The evidence document, shaped against a rule's pass mark.
 *
 * Separated from the gathering above so the same raw totals can be read against
 * a different pass mark without another round of queries.
 */
const shapeEvidence = (raw, rule) => {
  const subjectsFailed = [];
  let subjectsPassed = 0;
  let scored = 0;
  let possible = 0;

  raw.bySubject.forEach((totals, courseId) => {
    const percent = (totals.scored / totals.possible) * 100;
    scored += totals.scored;
    possible += totals.possible;

    if (percent >= rule.passMarkPercent) {
      subjectsPassed += 1;
    } else {
      subjectsFailed.push(raw.courseNames.get(courseId) || 'Unnamed subject');
    }
  });

  return {
    sessionsRecorded: raw.sessionsRecorded,
    sessionsPresent: raw.sessionsPresent,
    attendancePercent: raw.sessionsRecorded
      ? Math.round((raw.sessionsPresent / raw.sessionsRecorded) * 1000) / 10
      : null,
    subjectsAssessed: raw.bySubject.size,
    subjectsPassed,
    subjectsFailed,
    averagePercent: possible ? Math.round((scored / possible) * 1000) / 10 : null,
    computedAt: new Date(),
  };
};

const ruleFor = (className, academicYear) =>
  ProgressionRule.findOne({ className, academicYear, isActive: true });

const cohortFor = (className, academicYear) =>
  ProgressionCohort.findOne({ className, academicYear });

/**
 * Recompute a decision's evidence and recommendation in place.
 *
 * Skipped once the cohort is published: the figures a family was told are the
 * figures that stand, and moving them afterwards is the thing publication
 * exists to prevent.
 */
const refresh = async (decision, rule) => {
  if (decision.status === 'published' || decision.status === 'withdrawn') return decision;

  const student = await User.findById(decision.student).select('name');
  if (!student) return decision;

  const raw = await computeEvidence(student, decision.fromClass);
  const evidence = shapeEvidence(raw, rule);
  const verdict = ProgressionDecision.recommend(evidence, rule);

  decision.evidence = evidence;
  decision.recommendation = verdict.recommendation;
  decision.recommendationReasons = verdict.reasons;

  return decision;
};

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

exports.getMeta = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        outcomes: ProgressionDecision.OUTCOMES,
        recommendations: ProgressionDecision.RECOMMENDATIONS,
        decisionStatuses: ProgressionDecision.DECISION_STATUSES,
        conditionStatuses: ProgressionDecision.CONDITION_STATUSES,
        cohortStatuses: ProgressionCohort.COHORT_STATUSES,
        minSessionsForEvidence: ProgressionDecision.MIN_SESSIONS_FOR_EVIDENCE,
        minSubjectsForEvidence: ProgressionDecision.MIN_SUBJECTS_FOR_EVIDENCE,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load progression reference data');
  }
};

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

exports.listRules = async (req, res) => {
  try {
    const filter = {};
    if (req.query.className) filter.className = req.query.className;
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;

    const rules = await ProgressionRule.find(filter).sort({ academicYear: -1, className: 1 });
    return res.status(200).json({ success: true, count: rules.length, data: rules });
  } catch (err) {
    return handleError(res, err, 'Could not list the rules');
  }
};

exports.createRule = async (req, res) => {
  try {
    const rule = new ProgressionRule({ ...req.body, createdBy: req.user._id });
    rule.history.push({ action: 'created', by: req.user._id, byName: req.user.name });
    await rule.save();

    return res.status(201).json({
      success: true,
      message: `Rule for ${rule.className} (${rule.academicYear}) created.`,
      data: rule,
    });
  } catch (err) {
    if (err.code === 11000) {
      return fail(res, 409, 'That class already has a rule for this year.');
    }
    if (err.name === 'ValidationError') {
      return fail(res, 400, Object.values(err.errors)[0].message);
    }
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, 'Could not create the rule');
  }
};

exports.updateRule = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid rule id.');

    const rule = await ProgressionRule.findById(id);
    if (!rule) return fail(res, 404, 'Rule not found.');

    const cohort = await cohortFor(rule.className, rule.academicYear);
    if (cohort && cohort.status === 'published') {
      return fail(
        res,
        409,
        `${rule.className} for ${rule.academicYear} has been published; its thresholds cannot move now.`
      );
    }

    const fields = [
      'minAttendancePercent',
      'minSubjectsPassed',
      'passMarkPercent',
      'maxConditionalSubjects',
      'promotesTo',
      'isActive',
    ];

    const changed = [];
    fields.forEach((field) => {
      if (req.body[field] === undefined) return;
      if (rule[field] === req.body[field]) return;
      rule[field] = req.body[field];
      changed.push(field);
    });

    if (!changed.length) return fail(res, 400, 'Nothing to change.');

    rule.history.push({
      action: 'updated',
      by: req.user._id,
      byName: req.user.name,
      note: changed.join(', '),
    });
    await rule.save();

    return res.status(200).json({
      success: true,
      message: 'Rule updated. Recommendations recompute against it on the next read.',
      data: rule,
    });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return fail(res, 400, Object.values(err.errors)[0].message);
    }
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, 'Could not update the rule');
  }
};

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

exports.getEvidence = async (req, res) => {
  try {
    const { studentId } = req.params;
    const { className, academicYear } = req.query;

    if (!isValidId(studentId)) return fail(res, 400, 'Invalid student id.');
    if (!className || !academicYear) {
      return fail(res, 400, 'className and academicYear are both required.');
    }

    const student = await User.findById(studentId).select('name role');
    if (!student) return fail(res, 404, 'That student does not exist.');

    const rule = await ruleFor(className, academicYear);
    if (!rule) {
      return fail(res, 404, `No progression rule is in force for ${className} in ${academicYear}.`);
    }

    const raw = await computeEvidence(student, className);
    const evidence = shapeEvidence(raw, rule);
    const verdict = ProgressionDecision.recommend(evidence, rule);

    return res.status(200).json({
      success: true,
      data: {
        student: student._id,
        studentName: student.name,
        className,
        academicYear,
        rule,
        evidence,
        recommendation: verdict.recommendation,
        reasons: verdict.reasons,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not compute the evidence');
  }
};

// ---------------------------------------------------------------------------
// Cohorts
// ---------------------------------------------------------------------------

exports.listCohorts = async (req, res) => {
  try {
    const cohorts = await ProgressionCohort.find({}).sort({ academicYear: -1, className: 1 });
    return res.status(200).json({ success: true, count: cohorts.length, data: cohorts });
  } catch (err) {
    return handleError(res, err, 'Could not list cohorts');
  }
};

/**
 * POST /cohorts/:className/:academicYear/generate
 *
 * Creates a draft decision per student, with the evidence and recommendation
 * already computed. Re-running refreshes the drafts rather than duplicating
 * them, so it can be run again after a register is corrected.
 */
exports.generateCohort = async (req, res) => {
  try {
    const { className, academicYear } = req.params;

    const rule = await ruleFor(className, academicYear);
    if (!rule) {
      return fail(res, 404, `No progression rule is in force for ${className} in ${academicYear}.`);
    }

    let cohort = await cohortFor(className, academicYear);
    if (cohort && cohort.status === 'published') {
      return fail(res, 409, `${className} for ${academicYear} has already been published.`);
    }

    const students = await User.find({ role: 'student' }).select('name').limit(500);

    let created = 0;
    let refreshed = 0;

    for (const student of students) {
      const raw = await computeEvidence(student, className);

      // A student with no registers and no results in this class is not in it.
      // Generating a decision for every student in the school is how a cohort
      // becomes noise.
      if (!raw.sessionsRecorded && !raw.bySubject.size) continue;

      const evidence = shapeEvidence(raw, rule);
      const verdict = ProgressionDecision.recommend(evidence, rule);

      const existing = await ProgressionDecision.findOne({
        student: student._id,
        academicYear,
        isHolding: true,
      });

      if (existing) {
        if (existing.status !== 'draft') {
          // A decision somebody has already taken is not overwritten by a
          // regeneration; its evidence is refreshed and its decision left alone.
          existing.evidence = evidence;
          existing.recommendation = verdict.recommendation;
          existing.recommendationReasons = verdict.reasons;
          await existing.save();
          refreshed += 1;
          continue;
        }

        existing.evidence = evidence;
        existing.recommendation = verdict.recommendation;
        existing.recommendationReasons = verdict.reasons;
        existing.fromClass = className;
        await existing.save();
        refreshed += 1;
        continue;
      }

      const decision = new ProgressionDecision({
        student: student._id,
        studentName: student.name,
        academicYear,
        fromClass: className,
        evidence,
        recommendation: verdict.recommendation,
        recommendationReasons: verdict.reasons,
      });

      decision.log('generated', req.user, verdict.recommendation);
      await decision.save();
      created += 1;
    }

    if (!cohort) {
      cohort = new ProgressionCohort({ className, academicYear });
    }
    cohort.studentCount = created + refreshed;
    cohort.log('generated', req.user, `${created} new, ${refreshed} refreshed`);
    await cohort.save();

    return res.status(200).json({
      success: true,
      message: `${created} decision(s) created and ${refreshed} refreshed for ${className}.`,
      data: cohort,
    });
  } catch (err) {
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, 'Could not generate the cohort');
  }
};

/**
 * GET /cohorts/:className/:academicYear
 *
 * The review screen: recommendation and decision as two adjacent columns, and
 * the divergences between them. That column pair is the whole review.
 */
exports.getCohort = async (req, res) => {
  try {
    const { className, academicYear } = req.params;

    const rule = await ruleFor(className, academicYear);
    const cohort = await cohortFor(className, academicYear);

    const decisions = await ProgressionDecision.find({
      fromClass: className,
      academicYear,
      status: { $ne: 'withdrawn' },
    }).sort({ studentName: 1 });

    // Refreshed on read while the cohort is open, so a corrected register moves
    // the recommendation without anybody re-running anything.
    if (rule && (!cohort || cohort.status !== 'published')) {
      for (const decision of decisions) {
        await refresh(decision, rule);
        if (decision.isModified()) await decision.save();
      }
    }

    const byRecommendation = {};
    const byDecision = {};
    let overrides = 0;
    let decided = 0;
    let awaitingCountersign = 0;

    decisions.forEach((row) => {
      byRecommendation[row.recommendation] = (byRecommendation[row.recommendation] || 0) + 1;
      if (row.decision) {
        decided += 1;
        byDecision[row.decision] = (byDecision[row.decision] || 0) + 1;
      }
      if (row.isOverride) {
        overrides += 1;
        if (!row.counterSignedAt) awaitingCountersign += 1;
      }
    });

    return res.status(200).json({
      success: true,
      data: {
        className,
        academicYear,
        rule,
        cohort,
        counts: {
          total: decisions.length,
          decided,
          undecided: decisions.length - decided,
          overrides,
          awaitingCountersign,
          byRecommendation,
          byDecision,
        },
        rows: decisions.map(publicDecision),
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load the cohort');
  }
};

/**
 * POST /cohorts/:className/:academicYear/publish
 *
 * One-way, and cohort-wide.
 *
 * Publishing individually as decisions are made is what lets one change after a
 * family has been told. Sealing the lot at once is the only version of this
 * that means anything.
 */
exports.publishCohort = async (req, res) => {
  try {
    const { className, academicYear } = req.params;

    const cohort = await cohortFor(className, academicYear);
    if (!cohort) return fail(res, 404, 'That cohort has not been generated.');
    if (cohort.status === 'published') {
      return fail(res, 409, 'That cohort has already been published.');
    }

    const decisions = await ProgressionDecision.find({
      fromClass: className,
      academicYear,
      status: { $in: ['draft', 'decided'] },
    });

    const undecided = decisions.filter((row) => !row.decision);
    if (undecided.length) {
      return fail(
        res,
        409,
        `${undecided.length} student(s) have no decision yet: ${undecided
          .slice(0, 5)
          .map((row) => row.studentName)
          .join(', ')}${undecided.length > 5 ? '…' : ''}`,
        { undecided: undecided.length }
      );
    }

    const unsigned = decisions.filter((row) => row.isOverride && !row.counterSignedAt);
    if (unsigned.length) {
      return fail(
        res,
        409,
        `${unsigned.length} override(s) are not countersigned: ${unsigned
          .map((row) => row.studentName)
          .join(', ')}. An override is two people or it is not an override.`,
        { unsigned: unsigned.length }
      );
    }

    const byRecommendation = {};
    const byDecision = {};
    let overrides = 0;

    for (const decision of decisions) {
      byRecommendation[decision.recommendation] =
        (byRecommendation[decision.recommendation] || 0) + 1;
      byDecision[decision.decision] = (byDecision[decision.decision] || 0) + 1;
      if (decision.isOverride) overrides += 1;

      decision.status = 'published';
      decision.publishedAt = new Date();
      decision.log('published', req.user);
      await decision.save();
    }

    cohort.publish(req.user, {
      studentCount: decisions.length,
      decidedCount: decisions.length,
      overrideCount: overrides,
      byRecommendation,
      byDecision,
    });
    await cohort.save();

    return res.status(200).json({
      success: true,
      message: `${className} (${academicYear}) published: ${decisions.length} decision(s), ${overrides} of them departing from the recommendation. Nothing in it can change now except settling a condition.`,
      data: cohort,
    });
  } catch (err) {
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, 'Could not publish the cohort');
  }
};

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

exports.listDecisions = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = {};

    if (req.query.status) filter.status = req.query.status;
    if (req.query.className) filter.fromClass = req.query.className;
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;
    if (req.query.overridesOnly === 'true') filter.isOverride = true;

    const [decisions, total] = await Promise.all([
      ProgressionDecision.find(filter).sort({ studentName: 1 }).skip(skip).limit(limit),
      ProgressionDecision.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      count: decisions.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      data: decisions.map(publicDecision),
    });
  } catch (err) {
    return handleError(res, err, 'Could not list decisions');
  }
};

/**
 * GET /mine
 *
 * Nothing at all until the cohort is published. Before that the decision does
 * not exist as far as the student is concerned, which is the only honest thing
 * to say while it is still being argued about.
 */
exports.getMine = async (req, res) => {
  try {
    const decisions = await ProgressionDecision.find({
      student: req.user._id,
      status: 'published',
    }).sort({ academicYear: -1 });

    return res.status(200).json({
      success: true,
      count: decisions.length,
      data: decisions.map((decision) => decision.forStudent()),
    });
  } catch (err) {
    return handleError(res, err, 'Could not load your progression');
  }
};

exports.getDecision = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid decision id.');

    const decision = await ProgressionDecision.findById(id);
    if (!decision) return fail(res, 404, 'Decision not found.');

    if (!isStaff(req.user)) {
      if (String(decision.student) !== String(req.user._id)) {
        return fail(res, 403, 'That decision is not about you.');
      }
      if (decision.status !== 'published') {
        return fail(res, 404, 'No decision has been published for you yet.');
      }
      return res.status(200).json({ success: true, data: decision.forStudent() });
    }

    const rule = await ruleFor(decision.fromClass, decision.academicYear);
    if (rule) {
      await refresh(decision, rule);
      if (decision.isModified()) await decision.save();
    }

    return res.status(200).json({ success: true, data: publicDecision(decision) });
  } catch (err) {
    return handleError(res, err, 'Could not load that decision');
  }
};

exports.decide = async (req, res) => {
  try {
    const { id } = req.params;
    const { outcome, reason = '' } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid decision id.');

    const decision = await ProgressionDecision.findById(id);
    if (!decision) return fail(res, 404, 'Decision not found.');

    const cohort = await cohortFor(decision.fromClass, decision.academicYear);
    if (cohort && cohort.status === 'published') {
      return fail(res, 409, 'That cohort has been published; the decision cannot be changed.');
    }

    const rule = await ruleFor(decision.fromClass, decision.academicYear);
    if (!rule) return fail(res, 404, 'No progression rule is in force for that class and year.');

    // Recomputed immediately before the decision, so nobody decides against a
    // recommendation that a corrected register has since moved.
    await refresh(decision, rule);

    decision.decide(req.user, outcome, { reason, promotesTo: rule.promotesTo });
    await decision.save();

    return res.status(200).json({
      success: true,
      message: decision.isOverride
        ? `Recorded as ${outcome}, against a recommendation of ${decision.recommendation}. It needs countersigning by somebody else before the cohort can be published.`
        : `Recorded as ${outcome}.`,
      data: publicDecision(decision),
    });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return fail(res, 400, Object.values(err.errors)[0].message);
    }
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, 'Could not record the decision');
  }
};

exports.countersign = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid decision id.');

    const decision = await ProgressionDecision.findById(id);
    if (!decision) return fail(res, 404, 'Decision not found.');

    decision.countersign(req.user);
    await decision.save();

    return res.status(200).json({
      success: true,
      message: 'Countersigned.',
      data: publicDecision(decision),
    });
  } catch (err) {
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, 'Could not countersign that decision');
  }
};

/**
 * PATCH /:id/withdraw
 *
 * The only way a published decision changes — visibly, leaving the original.
 * Silently editing a decision a family has already been told is the failure the
 * seal exists to prevent, so the withdrawal is a record of its own.
 */
exports.withdraw = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid decision id.');

    const decision = await ProgressionDecision.findById(id);
    if (!decision) return fail(res, 404, 'Decision not found.');

    decision.withdrawDecision(req.user, req.body.reason);
    await decision.save();

    return res.status(200).json({
      success: true,
      message:
        'Decision withdrawn. It stays on the record, and a replacement can now be created for this student.',
      data: publicDecision(decision),
    });
  } catch (err) {
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, 'Could not withdraw that decision');
  }
};

exports.addCondition = async (req, res) => {
  try {
    const { id } = req.params;
    const { subject, requirement, dueBy } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid decision id.');
    if (!subject || !requirement || !dueBy) {
      return fail(res, 400, 'A condition needs a subject, a requirement and a date.');
    }

    const decision = await ProgressionDecision.findById(id);
    if (!decision) return fail(res, 404, 'Decision not found.');

    const rule = await ruleFor(decision.fromClass, decision.academicYear);

    decision.addCondition(req.user, { subject, requirement, dueBy: new Date(dueBy) }, rule);
    await decision.save();

    return res.status(201).json({
      success: true,
      message: `Condition added: ${subject}.`,
      data: publicDecision(decision),
    });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return fail(res, 400, Object.values(err.errors)[0].message);
    }
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, 'Could not add the condition');
  }
};

/**
 * PATCH /:id/conditions/:index/settle
 *
 * Allowed after publication, and the only thing that is — because discharging a
 * condition later is the entire purpose of attaching one.
 */
exports.settleCondition = async (req, res) => {
  try {
    const { id, index } = req.params;
    const { status, note = '' } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid decision id.');

    const position = parseInt(index, 10);
    if (Number.isNaN(position) || position < 0) return fail(res, 400, 'Invalid condition index.');

    const decision = await ProgressionDecision.findById(id);
    if (!decision) return fail(res, 404, 'Decision not found.');

    decision.settleCondition(req.user, position, status, note);
    await decision.save();

    const outstanding = decision.conditions.filter((row) => row.status === 'open').length;

    return res.status(200).json({
      success: true,
      message: outstanding
        ? `Condition settled. ${outstanding} still open.`
        : 'Condition settled. Nothing is outstanding on this promotion.',
      data: publicDecision(decision),
      outstanding,
    });
  } catch (err) {
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, 'Could not settle the condition');
  }
};

exports.computeEvidence = computeEvidence;
exports.shapeEvidence = shapeEvidence;
exports.isAdmin = isAdmin;
