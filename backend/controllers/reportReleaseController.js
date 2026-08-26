const mongoose = require('mongoose');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Submission = require('../models/Submission');
const ReportRelease = require('../models/ReportRelease');

/**
 * Controlled publication of report cards.
 *
 * `generateReportCard` renders a PDF on demand from whatever is in the database
 * at that instant. This module adds the thing that was missing around it: a
 * decision, with a date and a name on it, about when that PDF may be handed
 * over.
 *
 * Three properties carry the whole feature.
 *
 * **Visibility is decided at read time.** `ReportRelease.visibilityFor` checks
 * live-ness, `releaseAt <= now` and the per-student hold on every request.
 * There is no scheduler here, and a scheduled release that depends on a job
 * having run either leaks early or never happens.
 *
 * **A hold is per student, and needs a category and a reason.** Marks
 * incomplete after illness, a grade under appeal, an unresolved integrity case
 * — the ordinary cases all need one report held while the other thirty go out.
 *
 * **Release is one-way.** A correction is a revision that supersedes, so the
 * grade a family was shown in March still exists in March.
 *
 * ## On the existing route
 *
 * This file deliberately does not touch `reportController.js`, which has open
 * changes against it; rewriting it here would put this work in conflict with
 * somebody else's. The gate is therefore exported as
 * `ReportRelease.visibilityFor(...)` and used by the new student-facing route
 * below. Adopting it inside `generateReportCard` is a three-line follow-up once
 * that other change lands, and it is worth doing as its own commit rather than
 * smuggled into this one.
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
    return 'A live report run already exists for that class and term. Revise it rather than preparing a second one.';
  }
  return null;
}

function isAdmin(user) {
  return user && user.role === 'admin';
}

function isTeacher(user) {
  return user && (user.role === 'teacher' || user.role === 'admin');
}

/**
 * A release as staff see it.
 *
 * Hold reasons are included here because this view is teacher/admin only; the
 * student-facing route returns the category at most.
 */
function releaseRow(release, now = new Date()) {
  return {
    _id: release._id,
    academicYear: release.academicYear,
    term: release.term,
    className: release.className,
    sections: release.sections,
    revision: release.revision,
    supersedes: release.supersedes,
    supersededBy: release.supersededBy,
    revisionReason: release.revisionReason,
    status: release.status,
    preparedAt: release.preparedAt,
    preparedBy: release.preparedBy,
    releaseAt: release.releaseAt,
    releasedAt: release.releasedAt,
    releasedBy: release.releasedBy,
    withdrawnAt: release.withdrawnAt,
    withdrawalReason: release.withdrawalReason,
    isLive: release.isLive,

    // Derived every time.
    showing: release.isShowingAt(now),
    pending: Boolean(release.releaseAt && release.releaseAt > now && release.status === 'released'),

    holds: release.holdSummary(),

    entries: release.entries.map((entry) => ({
      _id: entry._id,
      student: entry.student,
      studentName: entry.studentName,
      held: entry.held,
      holdCategory: entry.holdCategory,
      holdReason: entry.holdReason,
      heldAt: entry.heldAt,
      releasedIndividuallyAt: entry.releasedIndividuallyAt,
      snapshotHash: entry.snapshotHash,
    })),

    history: release.history,
  };
}

/**
 * Who is in this class.
 *
 * Built from `Attendance`, which is the only place `className` exists in this
 * schema. Attendance stores `studentName` rather than a reference — a
 * pre-existing weakness that `generateReportCard` already relies on — so the
 * names are resolved to real `User` documents here and the release stores those
 * references. The ambiguity is dealt with once, at preparation, rather than
 * inherited by every downstream read.
 *
 * Names that do not resolve are returned separately instead of being dropped: a
 * student silently missing from a report run is the failure this whole module
 * exists to prevent.
 */
async function rollForClass(className) {
  const sheets = await Attendance.find({ className }).select('records.studentName').lean();

  const names = new Set();
  sheets.forEach((sheet) => {
    (sheet.records || []).forEach((record) => {
      if (record.studentName) names.add(record.studentName.trim());
    });
  });

  if (!names.size) return { students: [], unresolved: [] };

  const students = await User.find({
    name: { $in: [...names] },
    role: 'student',
  }).select('name');

  const resolved = new Set(students.map((student) => student.name));

  return {
    students,
    unresolved: [...names].filter((name) => !resolved.has(name)),
  };
}

/**
 * The digest of what a report was computed from.
 *
 * Marks and attendance, the same two sources `generateReportCard` uses. Hashed
 * rather than stored, because the question it answers is "is the document you
 * are holding the one we issued?" and that needs a fingerprint, not a copy.
 */
async function snapshotForStudent(studentId, studentName) {
  const [submissions, attendances] = await Promise.all([
    Submission.find({ student: studentId }).select('exam score marks totalMarks').lean(),
    Attendance.find({ 'records.studentName': studentName }).select('records date').lean(),
  ]);

  const components = submissions.map((submission) => ({
    key: `submission:${submission._id}`,
    value: submission.score ?? submission.marks ?? '',
  }));

  let present = 0;
  let total = 0;
  attendances.forEach((sheet) => {
    const record = (sheet.records || []).find((r) => r.studentName === studentName);
    if (!record) return;
    total += 1;
    if (record.status === 'Present') present += 1;
  });

  components.push({ key: 'attendance:present', value: present });
  components.push({ key: 'attendance:total', value: total });

  return ReportRelease.snapshotOf(components);
}

/* ------------------------------------------------------------------------- *
 * Handlers
 * ------------------------------------------------------------------------- */

exports.getReleaseMeta = async (req, res) => {
  try {
    return ok(res, {
      statuses: ReportRelease.STATUSES,
      liveStatuses: ReportRelease.LIVE_STATUSES,
      holdCategories: ReportRelease.HOLD_CATEGORIES,
    });
  } catch (error) {
    return serverError(res, error, 'Could not load the release options');
  }
};

exports.getRoll = async (req, res) => {
  try {
    const { className } = req.query;
    if (!className) return fail(res, 400, 'A class is required');

    const roll = await rollForClass(className);

    return ok(res, {
      className,
      students: roll.students.map((student) => ({ _id: student._id, name: student.name })),
      unresolved: roll.unresolved,
      note: roll.unresolved.length
        ? 'These names appear on the attendance sheets but do not match a student account. ' +
          'They are listed rather than dropped, because a student silently missing from a ' +
          'report run is the failure this exists to prevent.'
        : '',
    });
  } catch (error) {
    return serverError(res, error, 'Could not work out the class roll');
  }
};

/**
 * Assemble a report run.
 *
 * The entry list is built from the roll rather than from whoever happens to
 * have marks — a student with no marks is a student whose report should be
 * *held*, not one who silently does not exist.
 */
exports.prepareRelease = async (req, res) => {
  try {
    const { academicYear, term, className, sections, studentIds } = req.body;

    if (!academicYear || !term || !className) {
      return fail(res, 400, 'An academic year, a term and a class are required');
    }

    let students;

    if (Array.isArray(studentIds) && studentIds.length) {
      if (studentIds.some((id) => !isValidId(id))) {
        return fail(res, 400, 'One of those student ids is not valid');
      }
      students = await User.find({ _id: { $in: studentIds }, role: 'student' }).select('name');
    } else {
      const roll = await rollForClass(className);
      students = roll.students;
    }

    if (!students.length) {
      return fail(
        res,
        400,
        `No students were found for ${className}. A report run with nobody on it would release ` +
          'nothing and look as though it had worked.'
      );
    }

    const release = new ReportRelease({
      academicYear,
      term,
      className,
      sections: Array.isArray(sections) ? sections : [],
      preparedBy: req.user._id,
      preparedAt: new Date(),
      status: 'preparing',
    });

    // Snapshots are taken now, at preparation, because that is the state the
    // reports were assembled from.
    const takenAt = new Date();

    release.entries = await Promise.all(
      students.map(async (student) => ({
        student: student._id,
        studentName: student.name,
        snapshotHash: await snapshotForStudent(student._id, student.name),
        snapshotTakenAt: takenAt,
      }))
    );

    release.recordHistory({
      action: 'prepared',
      to: 'preparing',
      note: `${release.entries.length} students`,
      by: req.user._id,
      byName: req.user.name,
    });

    await release.save();

    return created(res, releaseRow(release));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 409, message);
    return fail(res, 400, error.message);
  }
};

exports.holdEntry = async (req, res) => {
  try {
    const { id, studentId } = req.params;
    const { category, reason } = req.body;

    if (!isValidId(id) || !isValidId(studentId)) {
      return fail(res, 400, 'That id is not valid');
    }

    const release = await ReportRelease.findById(id);
    if (!release) return fail(res, 404, 'That report run does not exist');

    release.hold(studentId, req.user, { category, reason });
    await release.save();

    return ok(res, releaseRow(release));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

exports.liftHold = async (req, res) => {
  try {
    const { id, studentId } = req.params;
    const { note } = req.body;

    if (!isValidId(id) || !isValidId(studentId)) {
      return fail(res, 400, 'That id is not valid');
    }

    const release = await ReportRelease.findById(id);
    if (!release) return fail(res, 404, 'That report run does not exist');

    release.liftHold(studentId, req.user, note);
    await release.save();

    return ok(res, releaseRow(release));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

/**
 * Send it out.
 *
 * Admin only. The person who assembled the reports is not the person who
 * decides they go out.
 */
exports.releaseRun = async (req, res) => {
  try {
    const { id } = req.params;
    const { releaseAt } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'That report run id is not valid');

    const release = await ReportRelease.findById(id);
    if (!release) return fail(res, 404, 'That report run does not exist');

    // A revision has to stand the previous run down first. There are no
    // transactions available here, so the order is chosen deliberately: if the
    // second write fails, the class has no live release and the reports are
    // hidden. That is the safe direction — for a report card, not shown is
    // better than two versions disagreeing about a grade.
    if (release.supersedes) {
      const previous = await ReportRelease.findById(release.supersedes);
      if (previous && previous.isLive) {
        previous.markSuperseded(release, req.user);
        await previous.save();
      }
    }

    release.release(req.user, { releaseAt });
    await release.save();

    return ok(res, releaseRow(release));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 409, message);
    return fail(res, 400, error.message);
  }
};

exports.withdrawRun = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'That report run id is not valid');

    const release = await ReportRelease.findById(id);
    if (!release) return fail(res, 404, 'That report run does not exist');

    release.withdraw(req.user, reason);
    await release.save();

    return ok(res, releaseRow(release));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

/**
 * Correct a released run.
 *
 * A new run at `revision + 1`, pointing at the old one. The old one keeps its
 * `releasedAt` and its entries, so the grade a family was shown still exists.
 */
exports.reviseRun = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'That report run id is not valid');
    if (!reason || !String(reason).trim()) {
      return fail(res, 400, 'A revision needs a reason — it is what a family will be told');
    }

    const previous = await ReportRelease.findById(id);
    if (!previous) return fail(res, 404, 'That report run does not exist');

    if (previous.status !== 'released' && previous.status !== 'withdrawn') {
      return fail(
        res,
        400,
        `A ${previous.status} report run does not need revising — edit it before it goes out.`
      );
    }

    const students = await User.find({
      _id: { $in: previous.entries.map((entry) => entry.student) },
    }).select('name');

    const takenAt = new Date();

    const revision = new ReportRelease({
      academicYear: previous.academicYear,
      term: previous.term,
      className: previous.className,
      sections: previous.sections,
      revision: previous.revision + 1,
      supersedes: previous._id,
      revisionReason: String(reason).trim(),
      preparedBy: req.user._id,
      preparedAt: takenAt,
      status: 'preparing',
      entries: await Promise.all(
        students.map(async (student) => {
          const before = previous.entryFor(student._id);
          return {
            student: student._id,
            studentName: student.name,
            // Holds carry forward. A student held for an unresolved integrity
            // case in revision 1 is still held in revision 2 unless somebody
            // decides otherwise.
            held: before ? before.held : false,
            holdCategory: before ? before.holdCategory : '',
            holdReason: before ? before.holdReason : '',
            heldBy: before ? before.heldBy : null,
            heldAt: before ? before.heldAt : null,
            snapshotHash: await snapshotForStudent(student._id, student.name),
            snapshotTakenAt: takenAt,
          };
        })
      ),
    });

    revision.recordHistory({
      action: 'revision-prepared',
      from: `revision ${previous.revision}`,
      to: `revision ${revision.revision}`,
      note: revision.revisionReason,
      by: req.user._id,
      byName: req.user.name,
    });

    await revision.save();

    return created(res, releaseRow(revision));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 409, message);
    return fail(res, 400, error.message);
  }
};

exports.listReleases = async (req, res) => {
  try {
    const { academicYear, term, className, status } = req.query;

    const filter = {};
    if (academicYear) filter.academicYear = academicYear;
    if (term) filter.term = term;
    if (className) filter.className = className;
    if (status && ReportRelease.STATUSES.includes(status)) filter.status = status;

    const releases = await ReportRelease.find(filter)
      .sort({ preparedAt: -1 })
      .limit(100);

    const now = new Date();

    return ok(
      res,
      releases.map((release) => releaseRow(release, now))
    );
  } catch (error) {
    return serverError(res, error, 'Could not load the report runs');
  }
};

exports.getRelease = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'That report run id is not valid');

    const release = await ReportRelease.findById(id);
    if (!release) return fail(res, 404, 'That report run does not exist');

    return ok(res, releaseRow(release));
  } catch (error) {
    return serverError(res, error, 'Could not load that report run');
  }
};

/**
 * The student-facing answer, and the only gated read path this PR adds.
 *
 * A student sees whether their own report is available and, if not, a reason
 * they can act on — never the class list, never another student's hold, and
 * never the hold *reason*, which may name an integrity case or fee arrears.
 */
exports.getMyReleaseStatus = async (req, res) => {
  try {
    const { academicYear, term } = req.query;

    const studentId =
      req.user.role === 'student' ? req.user._id : req.query.studentId || req.user._id;

    if (req.user.role !== 'student' && !isTeacher(req.user)) {
      return fail(res, 403, 'Not permitted');
    }

    if (!isValidId(studentId)) return fail(res, 400, 'That student id is not valid');

    const visibility = await ReportRelease.visibilityFor(studentId, { academicYear, term });

    return ok(res, visibility);
  } catch (error) {
    return serverError(res, error, 'Could not work out whether that report is available');
  }
};

exports.rollForClass = rollForClass;
exports.snapshotForStudent = snapshotForStudent;
exports.isAdmin = isAdmin;
