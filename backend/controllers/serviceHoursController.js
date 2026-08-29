const mongoose = require('mongoose');
const ServiceLog = require('../models/ServiceLog');

/**
 * Community service hours.
 *
 * The handler worth reading closely is `verifyEntry`: it is the only control
 * this feature has, it refuses self-verification by two separate routes, and it
 * is idempotent so that a double-clicked button cannot rewrite an audit trail.
 *
 * Everything that reports a total reads `ServiceLog.buildProgress`, so no two
 * endpoints can disagree about how many hours a student has.
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

function isStaff(user) {
  return user && (user.role === 'teacher' || user.role === 'admin');
}

/**
 * The fields a student may set. `status`, `verifiedBy`, `verifiedAt` and the
 * history are all server-owned — a client that could send `status: 'verified'`
 * would be signing its own slip.
 */
function sanitiseEntry(body) {
  return {
    academicYear: body.academicYear,
    activityTitle: body.activityTitle,
    organisation: body.organisation,
    category: body.category,
    date: body.date,
    hours: body.hours === undefined ? undefined : Number(body.hours),
    description: body.description,
    supervisorName: body.supervisorName,
    supervisorContact: body.supervisorContact,
    supervisorUser: body.supervisorUser,
    evidenceUrl: body.evidenceUrl,
  };
}

// ---------------------------------------------------------------------------
// Logging service
// ---------------------------------------------------------------------------

/**
 * POST /api/service-hours/entries
 *
 * The two guards here are the daily ceiling and the duplicate check. Both catch
 * data entry errors rather than dishonesty, which is what they are mostly for:
 * two eight-hour entries on one Saturday is a mis-click every time.
 */
exports.createEntry = async (req, res) => {
  try {
    const payload = sanitiseEntry(req.body);

    const entry = new ServiceLog({
      ...payload,
      student: req.user._id,
      status: 'pending',
    });

    await entry.validate();

    // Everything else this student has logged on the same day.
    const sameDay = await ServiceLog.find({
      student: req.user._id,
      date: entry.date,
      status: { $in: ['pending', 'verified'] },
    }).select('hours organisation activityTitle');

    const dayTotal = sameDay.reduce((total, row) => total + row.hours, 0);
    if (dayTotal + entry.hours > ServiceLog.MAX_HOURS_PER_DAY) {
      return fail(
        res,
        409,
        `That would put ${dayTotal + entry.hours} hours on ${entry.date}. ` +
          `The daily ceiling is ${ServiceLog.MAX_HOURS_PER_DAY} hours.`
      );
    }

    // Same student, same day, same organisation, same hours: that is a double
    // submit, not a second activity.
    const duplicate = sameDay.find(
      (row) =>
        row.organisation.trim().toLowerCase() ===
          entry.organisation.trim().toLowerCase() && row.hours === entry.hours
    );
    if (duplicate) {
      return fail(
        res,
        409,
        'You have already logged an identical entry for that organisation on that date',
        { existingId: duplicate._id }
      );
    }

    entry.recordHistory('submitted', req.user._id);
    await entry.save();

    return res.status(201).json({
      success: true,
      message: 'Service hours submitted for verification',
      data: entry.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to log service hours');
  }
};

/**
 * GET /api/service-hours/entries/mine
 */
exports.getMyEntries = async (req, res) => {
  try {
    const filter = { student: req.user._id };
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;
    if (req.query.status) filter.status = req.query.status;

    const entries = await ServiceLog.find(filter)
      .populate('verifiedBy', 'name')
      .sort({ date: -1, createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: entries.length,
      data: entries.map((entry) => ({
        ...entry.toRow(),
        verifiedBy: entry.verifiedBy,
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load your service hours');
  }
};

/**
 * GET /api/service-hours/entries
 */
exports.listEntries = async (req, res) => {
  try {
    const { status, student, academicYear, category } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (academicYear) filter.academicYear = academicYear;
    if (category) filter.category = category;
    if (student) {
      if (!isValidId(student)) return fail(res, 400, 'Invalid student id');
      filter.student = student;
    }

    const entries = await ServiceLog.find(filter)
      .populate('student', 'name email')
      .populate('verifiedBy', 'name')
      .sort({ createdAt: -1 })
      .limit(500);

    return res.status(200).json({
      success: true,
      count: entries.length,
      data: entries.map((entry) => ({
        ...entry.toRow(),
        student: entry.student,
        verifiedBy: entry.verifiedBy,
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load service hours');
  }
};

/**
 * GET /api/service-hours/pending
 *
 * The verification queue, oldest first. The supervisor's contact travels with
 * the row so that checking is a phone call rather than a research project.
 */
exports.getPendingQueue = async (req, res) => {
  try {
    const entries = await ServiceLog.find({ status: 'pending' })
      .populate('student', 'name email')
      .sort({ createdAt: 1 })
      .limit(300);

    const now = Date.now();
    const rows = entries.map((entry) => ({
      ...entry.toRow(),
      student: entry.student,
      waitingDays: Math.floor((now - entry.createdAt.getTime()) / 86400000),
      // Surfaced so a verifier can see, before clicking, that this one is not
      // theirs to sign off.
      verifiabilityError: entry.verifiabilityErrorFor(req.user),
    }));

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the verification queue');
  }
};

/**
 * GET /api/service-hours/entries/:id
 */
exports.getEntry = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid entry id');

    const entry = await ServiceLog.findById(id)
      .populate('student', 'name email')
      .populate('verifiedBy', 'name');
    if (!entry) return fail(res, 404, 'Entry not found');

    // A student reads their own; staff read anybody's.
    if (!entry.isOwnedBy(req.user) && !isStaff(req.user)) {
      return fail(res, 403, 'This entry belongs to another student');
    }

    return res.status(200).json({
      success: true,
      data: {
        ...entry.toRow(),
        student: entry.student,
        verifiedBy: entry.verifiedBy,
        history: entry.history,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load entry');
  }
};

/**
 * PATCH /api/service-hours/entries/:id
 *
 * Refused once verified. Editing hours after sign-off makes the verification
 * meaningless, so the correction path is reject-and-resubmit.
 */
exports.updateEntry = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid entry id');

    const entry = await ServiceLog.findById(id);
    if (!entry) return fail(res, 404, 'Entry not found');

    if (!entry.isOwnedBy(req.user)) {
      return fail(res, 403, 'This entry belongs to another student');
    }
    if (!entry.isEditable()) {
      return fail(
        res,
        409,
        `A ${entry.status} entry cannot be edited. Ask a member of staff to reject it if it is wrong.`
      );
    }

    const updates = sanitiseEntry(req.body);
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) entry[key] = value;
    }

    // An edited entry goes back into the queue. A rejected one that has been
    // fixed is a resubmission, not a still-rejected entry.
    entry.status = 'pending';
    entry.rejectionReason = undefined;
    entry.recordHistory('edited', req.user._id);

    await entry.save();

    return res.status(200).json({
      success: true,
      message: 'Entry updated and resubmitted for verification',
      data: entry.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update entry');
  }
};

/**
 * PATCH /api/service-hours/entries/:id/withdraw
 *
 * Withdrawal is a status, not a delete: the row stays in the ledger.
 */
exports.withdrawEntry = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid entry id');

    const entry = await ServiceLog.findById(id);
    if (!entry) return fail(res, 404, 'Entry not found');

    if (!entry.isOwnedBy(req.user)) {
      return fail(res, 403, 'This entry belongs to another student');
    }
    if (entry.status === 'verified') {
      return fail(res, 409, 'A verified entry cannot be withdrawn');
    }
    if (entry.status === 'withdrawn') {
      return fail(res, 409, 'This entry is already withdrawn');
    }

    entry.status = 'withdrawn';
    entry.recordHistory('withdrawn', req.user._id, req.body.reason);
    await entry.save();

    return res.status(200).json({
      success: true,
      message: 'Entry withdrawn',
      data: entry.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to withdraw entry');
  }
};

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * PATCH /api/service-hours/entries/:id/verify
 *
 * The rule the feature exists for. Two refusals — the student themselves, and
 * the person named as supervisor — and neither is overridable.
 *
 * Idempotent on purpose: verifying an already-verified entry returns the
 * unchanged entry rather than stamping a fresh `verifiedAt` and appending
 * another history row. Double-clicking a button should not rewrite an audit
 * trail.
 */
exports.verifyEntry = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid entry id');

    const entry = await ServiceLog.findById(id);
    if (!entry) return fail(res, 404, 'Entry not found');

    if (entry.status === 'verified') {
      return res.status(200).json({
        success: true,
        message: 'This entry was already verified',
        data: entry.toRow(),
      });
    }

    const blocked = entry.verifiabilityErrorFor(req.user);
    if (blocked) return fail(res, 409, blocked);

    entry.status = 'verified';
    entry.verifiedBy = req.user._id;
    entry.verifiedAt = new Date();
    entry.rejectionReason = undefined;
    entry.recordHistory('verified', req.user._id, req.body.note);

    await entry.save();

    return res.status(200).json({
      success: true,
      message: `${entry.hours} hours verified`,
      data: entry.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to verify entry');
  }
};

/**
 * PATCH /api/service-hours/entries/:id/reject
 *
 * A reason is required. "Rejected" with no reason is the thing that makes a
 * student give up rather than fix it.
 */
exports.rejectEntry = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid entry id');

    const entry = await ServiceLog.findById(id);
    if (!entry) return fail(res, 404, 'Entry not found');

    const reason = req.body.reason;
    if (!reason || String(reason).trim().length < 5) {
      return fail(res, 400, 'A reason of at least 5 characters is required');
    }

    // The same eligibility rule applies: somebody cannot reject their own.
    const blocked = entry.verifiabilityErrorFor(req.user);
    if (blocked) return fail(res, 409, blocked);

    if (entry.status === 'rejected') {
      return fail(res, 409, 'This entry is already rejected');
    }

    entry.status = 'rejected';
    entry.rejectionReason = reason;
    entry.verifiedBy = undefined;
    entry.verifiedAt = undefined;
    entry.recordHistory('rejected', req.user._id, reason);

    await entry.save();

    return res.status(200).json({
      success: true,
      message: 'Entry rejected',
      data: entry.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to reject entry');
  }
};

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

async function progressFor(studentId, academicYear) {
  const filter = { student: studentId };
  if (academicYear) filter.academicYear = academicYear;

  const entries = await ServiceLog.find(filter).select(
    'hours status category academicYear'
  );

  return ServiceLog.buildProgress(entries);
}

/**
 * GET /api/service-hours/progress/mine
 */
exports.getMyProgress = async (req, res) => {
  try {
    const progress = await progressFor(req.user._id, req.query.academicYear);

    return res.status(200).json({
      success: true,
      data: progress,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build your progress');
  }
};

/**
 * GET /api/service-hours/progress/:studentId
 */
exports.getStudentProgress = async (req, res) => {
  try {
    const { studentId } = req.params;
    if (!isValidId(studentId)) return fail(res, 400, 'Invalid student id');

    const progress = await progressFor(studentId, req.query.academicYear);

    return res.status(200).json({
      success: true,
      data: progress,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build progress');
  }
};

/**
 * GET /api/service-hours/stats
 */
exports.getStats = async (req, res) => {
  try {
    const filter = {};
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;

    const entries = await ServiceLog.find(filter).select(
      'hours status category createdAt verifiedAt'
    );

    const byStatus = {};
    for (const status of ServiceLog.STATUSES) byStatus[status] = 0;

    const byCategory = {};
    let verifiedHours = 0;
    let pendingHours = 0;
    let turnaroundTotal = 0;
    let turnaroundCount = 0;

    for (const entry of entries) {
      byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;
      byCategory[entry.category] = (byCategory[entry.category] || 0) + entry.hours;

      if (entry.status === 'verified') {
        verifiedHours += entry.hours;
        if (entry.verifiedAt && entry.createdAt) {
          turnaroundTotal += entry.verifiedAt.getTime() - entry.createdAt.getTime();
          turnaroundCount += 1;
        }
      } else if (entry.status === 'pending') {
        pendingHours += entry.hours;
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        total: entries.length,
        byStatus,
        byCategory,
        verifiedHours: Math.round(verifiedHours * 10) / 10,
        pendingHours: Math.round(pendingHours * 10) / 10,
        averageVerificationDays: turnaroundCount
          ? Math.round((turnaroundTotal / turnaroundCount / 86400000) * 10) / 10
          : null,
        requirement: ServiceLog.DEFAULT_ANNUAL_REQUIREMENT,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build service statistics');
  }
};

/**
 * GET /api/service-hours/meta
 *
 * The enums and the limits, so the form does not keep its own copy and drift.
 */
exports.getMeta = async (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      categories: ServiceLog.CATEGORIES,
      statuses: ServiceLog.STATUSES,
      minHours: ServiceLog.MIN_HOURS,
      maxHoursPerEntry: ServiceLog.MAX_HOURS_PER_ENTRY,
      maxHoursPerDay: ServiceLog.MAX_HOURS_PER_DAY,
      annualRequirement: ServiceLog.DEFAULT_ANNUAL_REQUIREMENT,
      canVerify: isStaff(req.user),
    },
  });
};
