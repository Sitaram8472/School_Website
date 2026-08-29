// backend/controllers/attendanceAmendmentController.js
const mongoose = require('mongoose');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const AttendanceAmendment = require('../models/AttendanceAmendment');
const { RegisterCertification } = require('../models/AttendanceAmendment');

/**
 * Corrections to a register that has already been taken.
 *
 * The handler worth reading closely is `applyAmendment`. Everything else here
 * is a form, a list or a state transition.
 *
 * Two facts are read from the register itself and never accepted from a body:
 * that the row exists, and what it currently says. A request that disagrees
 * with the register is a request from a stale view, and it is refused on those
 * grounds rather than allowed to overwrite whatever is actually there.
 */

const handleError = (res, err, message = 'Server error') => {
  console.error('[attendance-amendments]', err);
  return res.status(500).json({ success: false, message, error: err.message });
};

const fail = (res, status, message, extra = {}) =>
  res.status(status).json({ success: false, message, ...extra });

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const isAdmin = (user) => user && user.role === 'admin';

const asBadRequest = (err) =>
  err instanceof Error && !['MongoServerError', 'MongooseError', 'ValidationError'].includes(err.name);

const getPagination = (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
};

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const publicAmendment = (amendment) => ({
  _id: amendment._id,
  attendance: amendment.attendance,
  className: amendment.className,
  date: amendment.date,
  monthKey: amendment.monthKey,
  studentName: amendment.studentName,
  student: amendment.student,
  studentResolved: amendment.studentResolved,
  studentAmbiguous: amendment.studentAmbiguous,
  originalStatus: amendment.originalStatus,
  requestedStatus: amendment.requestedStatus,
  reasonCode: amendment.reasonCode,
  reasonNote: amendment.reasonNote,
  evidenceReference: amendment.evidenceReference,
  evidenceSeenByName: amendment.evidenceSeenByName,
  evidenceSeenAt: amendment.evidenceSeenAt,
  status: amendment.status,
  requestedByName: amendment.requestedByName,
  requestedByRole: amendment.requestedByRole,
  submittedAt: amendment.submittedAt,
  daysLate: amendment.daysLate,
  lateRequest: amendment.lateRequest,
  approvedByName: amendment.approvedByName,
  approvedAt: amendment.approvedAt,
  rejectionReason: amendment.rejectionReason,
  appliedAt: amendment.appliedAt,
  supersededBy: amendment.supersededBy,
  history: amendment.history,
});

/**
 * Is this class-month sealed? Returns the certification when it is, null when
 * it is not.
 */
const sealFor = async (className, monthKey) => {
  const certification = await RegisterCertification.findOne({ className, monthKey });
  if (!certification) return null;
  return certification.status === 'certified' ? certification : null;
};

/**
 * Resolve a register row's name to a student, or admit that it cannot be done.
 *
 * `Attendance.records[]` holds a free-text name and nothing else. Where exactly
 * one student matches, the link is worth having; where none or several do,
 * guessing which child was absent is worse than saying the register cannot
 * tell, so the amendment records the ambiguity instead.
 */
const resolveStudent = async (studentName) => {
  const trimmed = String(studentName || '').trim();
  if (!trimmed) return { student: null, resolved: false, ambiguous: false };

  const matches = await User.find({
    role: 'student',
    name: new RegExp(`^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
  })
    .select('_id')
    .limit(3);

  if (matches.length === 1) return { student: matches[0]._id, resolved: true, ambiguous: false };
  return { student: null, resolved: false, ambiguous: matches.length > 1 };
};

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

exports.getMeta = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        statuses: AttendanceAmendment.AMENDMENT_STATUSES,
        holdingStatuses: AttendanceAmendment.HOLDING_STATUSES,
        marks: AttendanceAmendment.MARKS,
        reasonCodes: AttendanceAmendment.REASON_CODES,
        authorisedReasons: AttendanceAmendment.AUTHORISED_REASONS,
        amendmentWindowDays: AttendanceAmendment.AMENDMENT_WINDOW_DAYS,
        certificationStatuses: RegisterCertification.CERTIFICATION_STATUSES,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load amendment reference data');
  }
};

// ---------------------------------------------------------------------------
// Raising an amendment
// ---------------------------------------------------------------------------

exports.createAmendment = async (req, res) => {
  try {
    const {
      attendanceId,
      studentName,
      requestedStatus,
      reasonCode,
      reasonNote = '',
      evidenceReference = '',
    } = req.body;

    if (!isValidId(attendanceId)) return fail(res, 400, 'Invalid register id.');

    const register = await Attendance.findById(attendanceId);
    if (!register) return fail(res, 404, 'Register not found.');

    const wanted = String(studentName || '').trim().toLowerCase();
    const record = register.records.find(
      (row) => String(row.studentName || '').trim().toLowerCase() === wanted
    );

    if (!record) {
      return fail(res, 404, `${studentName} is not on that register.`);
    }

    // Read off the register, never from the body.
    const originalStatus = record.status;

    if (originalStatus === requestedStatus) {
      return fail(res, 400, `That register already says ${originalStatus}.`);
    }
    if (!AttendanceAmendment.MARKS.includes(requestedStatus)) {
      return fail(res, 400, 'requestedStatus must be Present or Absent.');
    }
    if (!AttendanceAmendment.REASON_CODES.includes(reasonCode)) {
      return fail(res, 400, 'An amendment needs a valid reason code.');
    }

    const monthKey = AttendanceAmendment.monthKeyOf(register.date);
    const sealed = await sealFor(register.className, monthKey);
    if (sealed) {
      return fail(
        res,
        409,
        `${register.className} for ${monthKey} was certified on ${sealed.certifiedAt
          .toISOString()
          .slice(0, 10)} and cannot be amended.`
      );
    }

    const resolved = await resolveStudent(record.studentName);
    const daysLate = AttendanceAmendment.daysSince(register.date);

    const amendment = new AttendanceAmendment({
      attendance: register._id,
      className: register.className,
      date: register.date,
      monthKey,
      studentName: record.studentName,
      student: resolved.student,
      studentResolved: resolved.resolved,
      studentAmbiguous: resolved.ambiguous,
      originalStatus,
      requestedStatus,
      reasonCode,
      reasonNote,
      evidenceReference,
      requestedBy: req.user._id,
      requestedByName: req.user.name,
      requestedByRole: req.user.role,
      daysLate,
      lateRequest: daysLate > AttendanceAmendment.AMENDMENT_WINDOW_DAYS,
    });

    amendment.log('raised', req.user, `${originalStatus} to ${requestedStatus} (${reasonCode})`);
    await amendment.save();

    return res.status(201).json({
      success: true,
      message: amendment.lateRequest
        ? `Amendment raised. The register is ${daysLate} days old, so an administrator has to approve it.`
        : 'Amendment raised.',
      data: publicAmendment(amendment),
    });
  } catch (err) {
    if (err.code === 11000) {
      return fail(
        res,
        409,
        'There is already a live amendment for that student on that register.'
      );
    }
    if (err.name === 'ValidationError') {
      return fail(res, 400, Object.values(err.errors)[0].message);
    }
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, 'Could not raise the amendment');
  }
};

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

exports.listAmendments = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = {};

    if (req.query.status) filter.status = req.query.status;
    if (req.query.className) filter.className = req.query.className;
    if (req.query.monthKey) filter.monthKey = req.query.monthKey;
    if (req.query.studentName) filter.studentName = req.query.studentName;

    // A teacher sees what they raised and what they are being asked to
    // approve; an admin sees the lot.
    if (!isAdmin(req.user) && req.query.scope !== 'all') {
      filter.$or = [{ requestedBy: req.user._id }, { status: 'submitted' }];
    }

    const [amendments, total] = await Promise.all([
      AttendanceAmendment.find(filter).sort({ submittedAt: -1 }).skip(skip).limit(limit),
      AttendanceAmendment.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      count: amendments.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      data: amendments.map(publicAmendment),
    });
  } catch (err) {
    return handleError(res, err, 'Could not list amendments');
  }
};

exports.getMyAmendments = async (req, res) => {
  try {
    const amendments = await AttendanceAmendment.find({ requestedBy: req.user._id })
      .sort({ submittedAt: -1 })
      .limit(100);

    return res.status(200).json({
      success: true,
      count: amendments.length,
      data: amendments.map(publicAmendment),
    });
  } catch (err) {
    return handleError(res, err, 'Could not load your amendments');
  }
};

/**
 * GET /pending
 *
 * The approval queue, with the effect of each amendment computed alongside it.
 *
 * "Does this take her under 90%" is the question the decision actually turns
 * on, and answering it after approval is answering it too late.
 */
exports.getPending = async (req, res) => {
  try {
    const amendments = await AttendanceAmendment.find({ status: 'submitted' })
      .sort({ submittedAt: 1 })
      .limit(100);

    const rows = [];

    for (const amendment of amendments) {
      const registers = await Attendance.find({ className: amendment.className }).select(
        'records date'
      );

      const before = AttendanceAmendment.percentageFor(registers, amendment.studentName);

      // The same arithmetic with this one mark flipped. Computed rather than
      // guessed at, because a percentage moved by one session in forty is not
      // something anybody estimates correctly in their head.
      const delta = amendment.requestedStatus === 'Present' ? 1 : -1;
      const presentAfter = before.present + delta;
      const after = {
        ...before,
        present: presentAfter,
        absent: before.sessions - presentAfter,
        percent: before.sessions
          ? Math.round((presentAfter / before.sessions) * 1000) / 10
          : null,
      };

      rows.push({
        ...publicAmendment(amendment),
        attendanceBefore: before,
        attendanceAfter: after,
      });
    }

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (err) {
    return handleError(res, err, 'Could not build the approval queue');
  }
};

/**
 * GET /student?className&studentName
 *
 * One student's attendance, computed from the registers on every call. Nothing
 * is stored, so an applied amendment moves it for free.
 */
exports.getStudentAttendance = async (req, res) => {
  try {
    const { className, studentName } = req.query;

    if (!className || !studentName) {
      return fail(res, 400, 'className and studentName are both required.');
    }

    const registers = await Attendance.find({ className }).select('records date').sort({ date: 1 });
    const summary = AttendanceAmendment.percentageFor(registers, studentName);

    const amendments = await AttendanceAmendment.find({
      className,
      studentName,
      status: 'applied',
    }).sort({ appliedAt: -1 });

    return res.status(200).json({
      success: true,
      data: {
        className,
        studentName,
        ...summary,
        // The record of every correction that produced the figure above. A
        // percentage without its amendment history is a number somebody has to
        // take on trust.
        amendments: amendments.map(publicAmendment),
      },
    });
  } catch (err) {
    return handleError(res, err, "Could not compute that student's attendance");
  }
};

exports.getSummary = async (req, res) => {
  try {
    const monthKey = MONTH_PATTERN.test(req.query.monthKey || '') ? req.query.monthKey : null;
    const filter = monthKey ? { monthKey } : {};

    const amendments = await AttendanceAmendment.find(filter);

    const byStatus = {};
    const byReason = {};
    let late = 0;
    let authorised = 0;

    amendments.forEach((amendment) => {
      byStatus[amendment.status] = (byStatus[amendment.status] || 0) + 1;
      byReason[amendment.reasonCode] = (byReason[amendment.reasonCode] || 0) + 1;
      if (amendment.lateRequest) late += 1;
      if (AttendanceAmendment.AUTHORISED_REASONS.includes(amendment.reasonCode)) authorised += 1;
    });

    return res.status(200).json({
      success: true,
      data: {
        monthKey,
        total: amendments.length,
        byStatus,
        byReason,
        lateRequests: late,
        authorisedAbsences: authorised,
        // Clerical errors are the interesting number: a class producing a lot
        // of them has a register-taking problem, not an attendance problem.
        clericalErrors: byReason['clerical-error'] || 0,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not build the summary');
  }
};

exports.getAmendment = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid amendment id.');

    const amendment = await AttendanceAmendment.findById(id);
    if (!amendment) return fail(res, 404, 'Amendment not found.');

    if (!isAdmin(req.user) && String(amendment.requestedBy) !== String(req.user._id)) {
      // A teacher may still see one they are being asked to decide on.
      if (amendment.status !== 'submitted') {
        return fail(res, 403, 'That amendment is not yours.');
      }
    }

    return res.status(200).json({ success: true, data: publicAmendment(amendment) });
  } catch (err) {
    return handleError(res, err, 'Could not load that amendment');
  }
};

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

const transition = (verb, apply) => async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid amendment id.');

    const amendment = await AttendanceAmendment.findById(id);
    if (!amendment) return fail(res, 404, 'Amendment not found.');

    const sealed = await sealFor(amendment.className, amendment.monthKey);
    if (sealed) {
      return fail(
        res,
        409,
        `${amendment.className} for ${amendment.monthKey} was certified on ${sealed.certifiedAt
          .toISOString()
          .slice(0, 10)} and cannot be amended.`
      );
    }

    await apply(amendment, req);
    await amendment.save();

    return res.status(200).json({
      success: true,
      message: `Amendment ${verb}.`,
      data: publicAmendment(amendment),
    });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return fail(res, 400, Object.values(err.errors)[0].message);
    }
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, `Could not ${verb} the amendment`);
  }
};

exports.recordEvidence = transition('evidence recorded', (amendment, req) =>
  amendment.recordEvidence(req.user, req.body.evidenceReference)
);

exports.approveAmendment = transition('approved', (amendment, req) =>
  amendment.approve(req.user)
);

exports.rejectAmendment = transition('rejected', (amendment, req) =>
  amendment.reject(req.user, req.body.reason)
);

exports.withdrawAmendment = transition('withdrawn', (amendment, req) =>
  amendment.withdraw(req.user)
);

/**
 * PATCH /:id/apply
 *
 * The whole point of the module.
 *
 * A single guarded `findOneAndUpdate` filtered on the row still holding
 * `originalStatus`. If it matches nothing the register has moved underneath —
 * another amendment landed first, or somebody edited the document elsewhere —
 * and the amendment is refused rather than re-applied over whatever is there
 * now.
 *
 * Without the guard, two amendments raised from two stale views both apply and
 * the second silently reverses the first. The filter makes that impossible
 * rather than unlikely.
 */
exports.applyAmendment = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid amendment id.');

    const amendment = await AttendanceAmendment.findById(id);
    if (!amendment) return fail(res, 404, 'Amendment not found.');

    if (amendment.status !== 'approved') {
      return fail(
        res,
        409,
        `Only an approved amendment can be applied; this one is ${amendment.status}.`
      );
    }

    const sealed = await sealFor(amendment.className, amendment.monthKey);
    if (sealed) {
      return fail(
        res,
        409,
        `${amendment.className} for ${amendment.monthKey} was certified on ${sealed.certifiedAt
          .toISOString()
          .slice(0, 10)}; the figures have gone out and the register cannot move under them.`
      );
    }

    const updated = await Attendance.findOneAndUpdate(
      {
        _id: amendment.attendance,
        records: {
          $elemMatch: {
            studentName: amendment.studentName,
            status: amendment.originalStatus,
          },
        },
      },
      { $set: { 'records.$[target].status': amendment.requestedStatus } },
      {
        new: true,
        arrayFilters: [
          { 'target.studentName': amendment.studentName, 'target.status': amendment.originalStatus },
        ],
      }
    );

    if (!updated) {
      return fail(
        res,
        409,
        `The register no longer says ${amendment.originalStatus} for ${amendment.studentName}. Somebody changed it in between; raise a fresh amendment against what it says now.`
      );
    }

    amendment.markApplied(req.user);
    await amendment.save();

    const registers = await Attendance.find({ className: amendment.className }).select('records');
    const summary = AttendanceAmendment.percentageFor(registers, amendment.studentName);

    return res.status(200).json({
      success: true,
      message: `${amendment.studentName} is now marked ${amendment.requestedStatus} for ${amendment.date}.`,
      data: { amendment: publicAmendment(amendment), attendance: summary },
    });
  } catch (err) {
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, 'Could not apply the amendment');
  }
};

// ---------------------------------------------------------------------------
// Certification
// ---------------------------------------------------------------------------

exports.listCertifications = async (req, res) => {
  try {
    const filter = {};
    if (req.query.className) filter.className = req.query.className;
    if (MONTH_PATTERN.test(req.query.monthKey || '')) filter.monthKey = req.query.monthKey;

    const certifications = await RegisterCertification.find(filter)
      .sort({ monthKey: -1, className: 1 })
      .limit(200);

    return res.status(200).json({
      success: true,
      count: certifications.length,
      data: certifications,
    });
  } catch (err) {
    return handleError(res, err, 'Could not list certifications');
  }
};

/**
 * POST /certifications
 *
 * Seals one class-month and stores the counts it sealed.
 *
 * Storing the counts is the part that matters. After certification the register
 * can still be reopened by somebody with a reason, and without a snapshot there
 * would be no way to say what the figure was when it went out.
 */
exports.certify = async (req, res) => {
  try {
    const { className, monthKey } = req.body;

    if (!className) return fail(res, 400, 'className is required.');
    if (!MONTH_PATTERN.test(monthKey || '')) return fail(res, 400, 'monthKey must be YYYY-MM.');

    const open = await AttendanceAmendment.countDocuments({
      className,
      monthKey,
      status: { $in: AttendanceAmendment.HOLDING_STATUSES },
    });

    if (open > 0 && req.body.force !== true) {
      return fail(
        res,
        409,
        `${open} amendment(s) for ${className} in ${monthKey} are still open. Settle them, or certify with force to close them out.`,
        { openAmendments: open }
      );
    }

    /**
     * Forcing does not leave the open amendments open.
     *
     * They cannot be applied into a certified month, so leaving them
     * `submitted` produces a queue that never clears and a teacher waiting for
     * a decision that cannot come. They are marked `superseded` — not rejected,
     * because nobody judged them; the register simply moved on without them.
     */
    let supersededCount = 0;
    if (open > 0) {
      const stranded = await AttendanceAmendment.find({
        className,
        monthKey,
        status: { $in: AttendanceAmendment.HOLDING_STATUSES },
      });

      for (const amendment of stranded) {
        amendment.supersede(req.user, `${className} ${monthKey} certified`);
        await amendment.save();
        supersededCount += 1;
      }
    }

    const registers = await Attendance.find({
      className,
      date: new RegExp(`^${monthKey}-`),
    }).select('records date');

    let recordCount = 0;
    let presentCount = 0;

    registers.forEach((register) => {
      register.records.forEach((record) => {
        recordCount += 1;
        if (record.status === 'Present') presentCount += 1;
      });
    });

    const existing = await RegisterCertification.findOne({ className, monthKey });
    const certification = existing || new RegisterCertification({ className, monthKey });

    if (existing && existing.status === 'certified') {
      return fail(res, 409, `${className} for ${monthKey} is already certified.`);
    }

    certification.status = 'certified';
    certification.sessionCount = registers.length;
    certification.recordCount = recordCount;
    certification.presentCount = presentCount;
    certification.absentCount = recordCount - presentCount;
    certification.percent = recordCount
      ? Math.round((presentCount / recordCount) * 1000) / 10
      : 0;
    certification.certifiedBy = req.user._id;
    certification.certifiedByName = req.user.name;
    certification.certifiedAt = new Date();
    certification.reopenedBy = null;
    certification.reopenedAt = null;

    certification.log(
      'certified',
      req.user,
      `${registers.length} session(s), ${certification.percent}%`
    );
    await certification.save();

    return res.status(201).json({
      success: true,
      message: supersededCount
        ? `${className} for ${monthKey} is certified at ${certification.percent}%. ${supersededCount} open amendment(s) were closed as superseded.`
        : `${className} for ${monthKey} is certified at ${certification.percent}%. No amendment can be applied into it now.`,
      data: certification,
      supersededCount,
    });
  } catch (err) {
    if (err.code === 11000) {
      return fail(res, 409, 'That class-month already has a certification.');
    }
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, 'Could not certify that month');
  }
};

exports.reopenCertification = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid certification id.');

    const certification = await RegisterCertification.findById(id);
    if (!certification) return fail(res, 404, 'Certification not found.');

    certification.reopen(req.user, req.body.reason);
    await certification.save();

    return res.status(200).json({
      success: true,
      message: `${certification.className} for ${certification.monthKey} is open again. The certified figure of ${certification.percent}% is kept on the record.`,
      data: certification,
    });
  } catch (err) {
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, 'Could not reopen that certification');
  }
};

exports.resolveStudent = resolveStudent;
exports.sealFor = sealFor;
