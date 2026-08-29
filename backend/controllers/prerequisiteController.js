// backend/controllers/prerequisiteController.js
const mongoose = require('mongoose');
const Course = require('../models/Course');
const Exam = require('../models/Exam');
const Submission = require('../models/Submission');
const CoursePrerequisite = require('../models/CoursePrerequisite');
const { PrerequisiteWaiver } = require('../models/CoursePrerequisite');

/**
 * Course prerequisites and the eligibility they imply.
 *
 * Nothing here stores whether a student is eligible. Eligibility is derived
 * from the submissions already in the database every time it is asked for,
 * because a stored eligibility flag is wrong the moment a result is entered.
 *
 * The evidence comes back with the verdict for the same reason: a student told
 * "you are not eligible" will ask why, and the answer has to be on the screen
 * rather than in a second query somebody has to know to run.
 */

const handleError = (res, err, message = 'Server error') => {
  console.error('[prerequisites]', err);
  return res.status(500).json({ success: false, message, error: err.message });
};

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const isStaff = (user) => user && (user.role === 'admin' || user.role === 'staff');

/**
 * The denominator for a percentage.
 *
 * `submitExam` only awards points for MCQs — a ShortAnswer question is stored
 * but never auto-graded. Counting those questions in the total would deflate
 * every percentage by however much of the paper was written rather than
 * chosen, so the total is the MCQ points, and only falls back to the whole
 * paper when there are no MCQs at all to measure against.
 */
const gradableTotal = (exam) => {
  const questions = exam.questions || [];

  const mcqTotal = questions
    .filter((question) => question.type === 'MCQ')
    .reduce((sum, question) => sum + (question.points || 1), 0);

  if (mcqTotal > 0) return mcqTotal;

  return questions.reduce((sum, question) => sum + (question.points || 1), 0);
};

// ---- REFERENCE DATA ----

/**
 * GET /api/courses/prerequisites/meta
 */
exports.getPrerequisiteMeta = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        kinds: CoursePrerequisite.KINDS,
        maxDepth: CoursePrerequisite.MAX_GRAPH_DEPTH,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load prerequisite reference data');
  }
};

// ---- WRITING RULES ----

/**
 * POST /api/courses/prerequisites
 *
 * The cycle check is the reason this endpoint is not a plain create. Refusing
 * the edge here is the difference between a curriculum mistake and two courses
 * that are permanently un-enrollable.
 */
exports.createPrerequisite = async (req, res) => {
  try {
    const { course, requires, kind, minimumPercent, isMandatory, rationale, effectiveFrom } = req.body;

    if (!isValidId(course) || !isValidId(requires)) {
      return res.status(400).json({ success: false, message: 'Two valid course ids are required.' });
    }
    if (String(course) === String(requires)) {
      return res.status(400).json({
        success: false,
        message: 'A course cannot be a prerequisite of itself.',
      });
    }
    if (kind && !CoursePrerequisite.KINDS.includes(kind)) {
      return res.status(400).json({
        success: false,
        message: `Kind must be one of: ${CoursePrerequisite.KINDS.join(', ')}`,
      });
    }

    const [subject, required] = await Promise.all([
      Course.findById(course).select('name'),
      Course.findById(requires).select('name'),
    ]);

    if (!subject || !required) {
      return res.status(404).json({ success: false, message: 'One of the courses does not exist.' });
    }

    const existing = await CoursePrerequisite.findOne({ course, requires, isActive: true });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: `${subject.name} already requires ${required.name}.`,
        data: existing,
      });
    }

    const cycle = await CoursePrerequisite.findCycle(course, requires);
    if (cycle) {
      const names = await Course.find({ _id: { $in: cycle } }).select('name').lean();
      const nameById = names.reduce((map, row) => ({ ...map, [String(row._id)]: row.name }), {});

      return res.status(409).json({
        success: false,
        message:
          'That rule would create a circular prerequisite: ' +
          cycle.map((id) => nameById[id] || 'unknown course').join(' → '),
        data: { cycle, path: cycle.map((id) => nameById[id] || 'unknown course') },
      });
    }

    const rule = new CoursePrerequisite({
      course,
      requires,
      kind: kind || 'completion',
      minimumPercent: Number(minimumPercent) || 0,
      isMandatory: isMandatory !== false,
      rationale: String(rationale || '').trim(),
      effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
      createdBy: req.user._id,
    });

    rule.log('created', req.user, `${subject.name} requires ${required.name}`);

    await rule.save();

    return res.status(201).json({
      success: true,
      message: `${subject.name} now requires ${required.name}.`,
      data: rule,
    });
  } catch (err) {
    if (err.name === 'ValidationError' || err.message.includes('prerequisite')) {
      return res.status(400).json({ success: false, message: err.message });
    }
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'That rule already exists.' });
    }
    return handleError(res, err, 'Could not create the prerequisite');
  }
};

/**
 * GET /api/courses/prerequisites
 */
exports.getPrerequisites = async (req, res) => {
  try {
    const { course, requires, includeRetired } = req.query;
    const filter = {};

    if (course && isValidId(course)) filter.course = course;
    if (requires && isValidId(requires)) filter.requires = requires;
    if (includeRetired !== 'true') filter.isActive = true;

    const rules = await CoursePrerequisite.find(filter)
      .populate('course', 'name')
      .populate('requires', 'name')
      .populate('createdBy', 'name role')
      .sort({ createdAt: -1 });

    return res.status(200).json({ success: true, count: rules.length, data: rules });
  } catch (err) {
    return handleError(res, err, 'Could not load prerequisites');
  }
};

/**
 * GET /api/courses/prerequisites/:courseId/chain
 *
 * Both directions at once: what this course depends on, and what depends on it.
 * The second half is the question a curriculum lead actually asks before
 * changing anything.
 */
exports.getChain = async (req, res) => {
  try {
    const { courseId } = req.params;

    if (!isValidId(courseId)) {
      return res.status(400).json({ success: false, message: 'Invalid course id.' });
    }

    const course = await Course.findById(courseId).select('name');
    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }

    const [chain, dependents] = await Promise.all([
      CoursePrerequisite.chainFor(courseId),
      CoursePrerequisite.dependentsOf(courseId),
    ]);

    const ids = [...chain, ...dependents].map((entry) => entry.course);
    const courses = await Course.find({ _id: { $in: ids } }).select('name').lean();
    const nameById = courses.reduce((map, row) => ({ ...map, [String(row._id)]: row.name }), {});

    const decorate = (entries) =>
      entries.map((entry) => ({
        course: entry.course,
        name: nameById[entry.course] || 'Unknown course',
        depth: entry.depth,
      }));

    return res.status(200).json({
      success: true,
      data: {
        course: { _id: course._id, name: course.name },
        requires: decorate(chain),
        requiredBy: decorate(dependents),
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not build the prerequisite chain');
  }
};

/**
 * PATCH /api/courses/prerequisites/:id
 * Only the softer fields. Changing which courses an edge joins would be a
 * different edge, and would need the cycle check again — so it is not allowed.
 */
exports.updatePrerequisite = async (req, res) => {
  try {
    const { id } = req.params;
    const { kind, minimumPercent, isMandatory, rationale } = req.body;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid rule id.' });
    }

    const rule = await CoursePrerequisite.findById(id);
    if (!rule) {
      return res.status(404).json({ success: false, message: 'Prerequisite not found.' });
    }
    if (!rule.isActive) {
      return res.status(409).json({ success: false, message: 'A retired rule cannot be edited.' });
    }

    if (kind !== undefined) rule.kind = kind;
    if (minimumPercent !== undefined) rule.minimumPercent = Number(minimumPercent) || 0;
    if (isMandatory !== undefined) rule.isMandatory = Boolean(isMandatory);
    if (rationale !== undefined) rule.rationale = String(rationale).trim();

    rule.log('updated', req.user);

    await rule.save();

    return res.status(200).json({ success: true, message: 'Prerequisite updated.', data: rule });
  } catch (err) {
    if (err.name === 'ValidationError' || err.message.includes('prerequisite')) {
      return res.status(400).json({ success: false, message: err.message });
    }
    return handleError(res, err, 'Could not update the prerequisite');
  }
};

/**
 * PATCH /api/courses/prerequisites/:id/retire
 * Retiring rather than deleting, so last year's admissions stay explicable.
 */
exports.retirePrerequisite = async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid rule id.' });
    }

    const rule = await CoursePrerequisite.findById(id);
    if (!rule) {
      return res.status(404).json({ success: false, message: 'Prerequisite not found.' });
    }

    try {
      rule.retire(req.user, String(note || '').trim());
    } catch (err) {
      return res.status(409).json({ success: false, message: err.message });
    }

    await rule.save();

    return res.status(200).json({
      success: true,
      message: 'Prerequisite retired. It no longer constrains new enrolments.',
      data: rule,
    });
  } catch (err) {
    return handleError(res, err, 'Could not retire the prerequisite');
  }
};

// ---- EVALUATION ----

/**
 * Work out, rule by rule, whether one student satisfies one course's
 * prerequisites — and return the evidence alongside each verdict.
 */
const evaluateFor = async (courseId, studentId) => {
  const rules = await CoursePrerequisite.find({ course: courseId, isActive: true })
    .populate('requires', 'name students')
    .lean();

  if (!rules.length) {
    return { met: [], unmet: [], warnings: [], eligible: true };
  }

  const requiredCourseIds = rules.map((rule) => rule.requires._id);

  // One query for every exam belonging to any required course, and one for
  // every submission this student has against them. Two round trips whatever
  // the size of the chain.
  const exams = await Exam.find({ course: { $in: requiredCourseIds } })
    .select('course questions title')
    .lean();

  const examIds = exams.map((exam) => exam._id);

  const submissions = await Submission.find({
    student: studentId,
    exam: { $in: examIds },
  })
    .select('exam score createdAt')
    .lean();

  const examById = exams.reduce((map, exam) => ({ ...map, [String(exam._id)]: exam }), {});

  // Best percentage per required course, with the exam it came from, so the
  // verdict can cite it.
  const bestByCourse = {};

  for (const submission of submissions) {
    const exam = examById[String(submission.exam)];
    if (!exam) continue;

    const total = gradableTotal(exam);
    const percent = total > 0 ? Math.round(((submission.score || 0) / total) * 100) : 0;
    const key = String(exam.course);

    if (!bestByCourse[key] || percent > bestByCourse[key].percent) {
      bestByCourse[key] = {
        percent,
        score: submission.score || 0,
        total,
        examTitle: exam.title,
        examId: exam._id,
        takenAt: submission.createdAt,
      };
    }
  }

  const met = [];
  const unmet = [];
  const warnings = [];

  for (const rule of rules) {
    const requiredId = String(rule.requires._id);
    const best = bestByCourse[requiredId];

    const base = {
      rule: rule._id,
      requires: rule.requires._id,
      requiresName: rule.requires.name,
      kind: rule.kind,
      minimumPercent: rule.minimumPercent,
      isMandatory: rule.isMandatory,
      rationale: rule.rationale,
    };

    let satisfied = false;
    let evidence = null;

    if (rule.kind === 'concurrent') {
      // Enrolled now, or already has a result — either counts as taking it.
      const enrolled = (rule.requires.students || []).some(
        (id) => String(id) === String(studentId)
      );
      satisfied = enrolled || Boolean(best);
      evidence = enrolled
        ? { kind: 'enrolment', detail: `Currently enrolled in ${rule.requires.name}` }
        : best
          ? { kind: 'result', detail: `${best.percent}% in ${best.examTitle}`, ...best }
          : null;
    } else if (rule.kind === 'minimum-score') {
      satisfied = Boolean(best) && best.percent >= rule.minimumPercent;
      evidence = best
        ? {
            kind: 'result',
            detail: `${best.percent}% (${best.score}/${best.total}) in ${best.examTitle}`,
            ...best,
          }
        : null;
    } else {
      // `completion` — sat an exam for the required course at all.
      satisfied = Boolean(best);
      evidence = best
        ? { kind: 'result', detail: `Sat ${best.examTitle}`, ...best }
        : null;
    }

    const entry = { ...base, evidence };

    if (satisfied) {
      met.push(entry);
    } else if (rule.isMandatory) {
      unmet.push(entry);
    } else {
      // Advisory rules never block. They come back as a warning so enrolling
      // anyway is a decision somebody took rather than a thing that happened.
      warnings.push(entry);
    }
  }

  return { met, unmet, warnings, eligible: unmet.length === 0 };
};

/**
 * POST /api/courses/prerequisites/:courseId/evaluate
 * A student may evaluate themselves; staff may evaluate anyone.
 */
exports.evaluate = async (req, res) => {
  try {
    const { courseId } = req.params;
    const studentId = req.body.student || req.user._id;

    if (!isValidId(courseId) || !isValidId(studentId)) {
      return res.status(400).json({ success: false, message: 'A valid course and student are required.' });
    }

    const self = String(studentId) === String(req.user._id);
    if (!self && !isStaff(req.user) && req.user.role !== 'teacher') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const course = await Course.findById(courseId).select('name');
    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }

    const result = await evaluateFor(courseId, studentId);
    const waiver = await PrerequisiteWaiver.findOne({
      student: studentId,
      course: courseId,
      isLive: true,
    }).populate('grantedBy', 'name role');

    const cover = waiver && result.unmet.length ? waiver.coverage(result.unmet) : null;

    return res.status(200).json({
      success: true,
      data: {
        course: { _id: course._id, name: course.name },
        student: studentId,
        ...result,
        waiver: waiver
          ? {
              _id: waiver._id,
              grantedBy: waiver.grantedBy,
              grantedAt: waiver.grantedAt,
              expiresAt: waiver.expiresAt,
              justification: waiver.justification,
              usable: cover ? cover.usable : true,
              reason: cover ? cover.reason : '',
            }
          : null,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not evaluate the prerequisites');
  }
};

/**
 * GET /api/courses/prerequisites/mine
 * Every course the caller is not yet eligible for, so a student can see what
 * they need before enrolment week rather than during it.
 */
exports.getMyEligibility = async (req, res) => {
  try {
    const courseIds = await CoursePrerequisite.distinct('course', { isActive: true });

    const courses = await Course.find({ _id: { $in: courseIds } }).select('name').lean();

    const rows = [];

    for (const course of courses) {
      const result = await evaluateFor(course._id, req.user._id);
      rows.push({
        course: { _id: course._id, name: course.name },
        eligible: result.eligible,
        unmet: result.unmet,
        warnings: result.warnings,
        metCount: result.met.length,
      });
    }

    rows.sort((a, b) => Number(a.eligible) - Number(b.eligible));

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (err) {
    return handleError(res, err, 'Could not work out your eligibility');
  }
};

// ---- ENROLMENT ----

/**
 * POST /api/courses/prerequisites/:courseId/enrol
 *
 * The only enrolment path that checks anything. `Course.students` can still be
 * pushed to directly elsewhere; this is the door with the rule on it, and the
 * only way past a mandatory gap is a waiver that already exists and actually
 * covers that gap.
 */
exports.enrolWithCheck = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { student, acknowledgeWarnings } = req.body;

    if (!isValidId(courseId) || !isValidId(student)) {
      return res.status(400).json({ success: false, message: 'A valid course and student are required.' });
    }

    const course = await Course.findById(courseId);
    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found.' });
    }

    const already = (course.students || []).some((id) => String(id) === String(student));
    if (already) {
      return res.status(200).json({
        success: true,
        alreadyEnrolled: true,
        message: 'That student is already enrolled.',
      });
    }

    const result = await evaluateFor(courseId, student);

    if (result.unmet.length) {
      const waiver = await PrerequisiteWaiver.findOne({ student, course: courseId, isLive: true });
      const cover = waiver ? waiver.coverage(result.unmet) : null;

      if (!cover || !cover.usable) {
        return res.status(409).json({
          success: false,
          message: waiver
            ? `Enrolment blocked: ${cover.reason}.`
            : 'Enrolment blocked: unmet prerequisites.',
          data: {
            unmet: cover ? cover.uncovered : result.unmet,
            warnings: result.warnings,
            waiver: waiver ? { _id: waiver._id, expiresAt: waiver.expiresAt } : null,
          },
        });
      }
    }

    if (result.warnings.length && !acknowledgeWarnings) {
      return res.status(409).json({
        success: false,
        needsAcknowledgement: true,
        message: 'This course has advisory prerequisites the student has not met.',
        data: { warnings: result.warnings },
      });
    }

    course.students.push(student);
    await course.save();

    return res.status(200).json({
      success: true,
      message: 'Enrolled.',
      data: {
        course: course._id,
        student,
        warningsAcknowledged: result.warnings.map((warning) => warning.requiresName),
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not enrol the student');
  }
};

// ---- WAIVERS ----

/**
 * POST /api/courses/prerequisites/waivers
 *
 * The gaps are snapshotted here rather than recomputed later, which is what
 * stops a waiver granted for one missing course quietly covering a different
 * rule added next term.
 */
exports.createWaiver = async (req, res) => {
  try {
    const { student, course, justification, expiresAt } = req.body;

    if (!isValidId(student) || !isValidId(course)) {
      return res.status(400).json({ success: false, message: 'A valid student and course are required.' });
    }
    if (!justification || String(justification).trim().length < 15) {
      return res.status(400).json({
        success: false,
        message: 'A waiver needs a justification of at least 15 characters.',
      });
    }
    if (String(student) === String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'You cannot waive your own prerequisites.' });
    }

    const result = await evaluateFor(course, student);

    if (!result.unmet.length) {
      return res.status(409).json({
        success: false,
        message: 'That student already meets every mandatory prerequisite; no waiver is needed.',
      });
    }

    const waiver = new PrerequisiteWaiver({
      student,
      course,
      unmetAtWaiver: result.unmet.map((gap) => ({
        requires: gap.requires,
        requiresName: gap.requiresName,
        kind: gap.kind,
        minimumPercent: gap.minimumPercent,
      })),
      justification: String(justification).trim(),
      grantedBy: req.user._id,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    });

    try {
      await waiver.save();
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({
          success: false,
          message: 'A live waiver already exists for that student and course.',
        });
      }
      throw err;
    }

    return res.status(201).json({
      success: true,
      message: `Waiver granted for ${result.unmet.length} prerequisite(s).`,
      data: waiver,
    });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: err.message });
    }
    return handleError(res, err, 'Could not grant the waiver');
  }
};

/**
 * GET /api/courses/prerequisites/waivers
 */
exports.getWaivers = async (req, res) => {
  try {
    const { course, student, includeRevoked } = req.query;
    const filter = {};

    if (course && isValidId(course)) filter.course = course;
    if (student && isValidId(student)) filter.student = student;
    if (includeRevoked !== 'true') filter.isLive = true;

    const waivers = await PrerequisiteWaiver.find(filter)
      .populate('student', 'name email')
      .populate('course', 'name')
      .populate('grantedBy', 'name role')
      .sort({ grantedAt: -1 });

    // Expiry is evaluated here rather than stored, so a waiver that lapsed
    // overnight reads as lapsed without anything having to run.
    const decorated = waivers.map((waiver) => ({
      ...waiver.toObject(),
      expired: Boolean(waiver.expiresAt && waiver.expiresAt.getTime() < Date.now()),
    }));

    return res.status(200).json({ success: true, count: decorated.length, data: decorated });
  } catch (err) {
    return handleError(res, err, 'Could not load waivers');
  }
};

/**
 * PATCH /api/courses/prerequisites/waivers/:id/revoke
 */
exports.revokeWaiver = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid waiver id.' });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ success: false, message: 'A revocation reason is required.' });
    }

    const waiver = await PrerequisiteWaiver.findById(id);
    if (!waiver) {
      return res.status(404).json({ success: false, message: 'Waiver not found.' });
    }
    if (!waiver.isLive) {
      return res.status(409).json({ success: false, message: 'That waiver is already revoked.' });
    }

    waiver.revokedBy = req.user._id;
    waiver.revokedAt = new Date();
    waiver.revocationReason = String(reason).trim();

    await waiver.save();

    return res.status(200).json({ success: true, message: 'Waiver revoked.', data: waiver });
  } catch (err) {
    return handleError(res, err, 'Could not revoke the waiver');
  }
};
