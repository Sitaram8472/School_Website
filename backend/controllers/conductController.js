const mongoose = require('mongoose');
const ConductEntry = require('../models/ConductEntry');

/**
 * Student conduct ledger.
 *
 * Note what is absent from this file: an update handler. The ledger is
 * append-only, so there is no way to change an entry's points, category or
 * description after it is recorded. A wrong entry is overturned or expunged,
 * and both leave the original visible with its new status.
 */

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

function serverError(res, error, message) {
  console.error(`${message}:`, error);
  return res.status(500).json({ success: false, message, error: error.message });
}

function validationMessage(error) {
  if (!error) return null;
  if (error.name === 'ValidationError') {
    return Object.values(error.errors).map((e) => e.message).join(' ');
  }
  if (error.name === 'ValidatorError' || error.name === 'CastError') {
    return error.message;
  }
  return null;
}

function isStaff(user) {
  return ['teacher', 'staff', 'admin'].includes(user.role);
}

/**
 * Expunged entries are excluded from every listing except an admin's. They are
 * still on file — see `ConductEntry.expunge` — but an expunged entry appearing
 * in a class list would defeat the point of expunging it.
 */
function visibilityFilter(user) {
  return user.role === 'admin' ? {} : { status: { $ne: 'expunged' } };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * GET /api/conduct/catalogue
 *
 * The points bands, so the form can bound its own input rather than letting a
 * teacher type a number the server will then reject.
 */
exports.getCatalogue = async (req, res) => {
  try {
    const catalogue = Object.entries(ConductEntry.CATEGORY_CATALOGUE).map(
      ([value, entry]) => ({
        value,
        label: entry.label,
        type: entry.type,
        min: entry.min,
        max: entry.max,
        expiresAfterDays: entry.expiresAfterDays,
      })
    );

    return res.status(200).json({
      success: true,
      data: catalogue,
      tiers: ConductEntry.INTERVENTION_TIERS,
      appealWindowDays: ConductEntry.APPEAL_WINDOW_DAYS,
      rollingWindowDays: ConductEntry.ROLLING_WINDOW_DAYS,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the conduct catalogue');
  }
};

/**
 * POST /api/conduct
 */
exports.recordEntry = async (req, res) => {
  try {
    const {
      student,
      studentName,
      className,
      type,
      category,
      points,
      description,
      occurredOn,
      location,
    } = req.body;

    if (!isValidId(student)) return fail(res, 400, 'A valid student id is required.');

    const entry = new ConductEntry({
      student,
      studentName,
      className,
      type,
      category,
      points,
      description,
      occurredOn: occurredOn || new Date(),
      location,
      recordedBy: req.user._id,
      recordedByName: req.user.name,
      // status, expiresOn, entryId and the whole appeal block are server-owned.
    });

    // Validate before burning a sequence number, so a rejected form does not
    // leave a hole in the entry numbering.
    const invalid = entry.validateSync();
    if (invalid) return fail(res, 400, validationMessage(invalid));

    entry.entryId = await ConductEntry.nextEntryId();
    entry.recordAudit('entry:recorded', req.user, `${type} ${points} (${category})`);
    await entry.save();

    // Recording a demerit is the moment somebody should find out the student
    // has crossed a threshold — that is the whole reason the thresholds exist.
    const ledger = await ConductEntry.find({
      student,
      status: { $ne: 'expunged' },
    }).select('type points status occurredOn expiresOn');

    const intervention = ConductEntry.evaluateInterventions(ledger);

    return res.status(201).json({
      success: true,
      message: `Recorded as ${entry.entryId}.`,
      data: entry.redactFor(req.user),
      balance: ConductEntry.computeBalance(ledger),
      intervention,
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record the entry');
  }
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * GET /api/conduct/me
 */
exports.getMyLedger = async (req, res) => {
  try {
    const entries = await ConductEntry.find({
      student: req.user._id,
      status: { $ne: 'expunged' },
    }).sort({ occurredOn: -1 });

    return res.status(200).json({
      success: true,
      count: entries.length,
      data: entries.map((entry) => entry.redactFor(req.user)),
      balance: ConductEntry.computeBalance(entries),
      // The student sees their own intervention state. Finding out from a
      // letter home that you crossed a line six weeks ago helps nobody.
      intervention: ConductEntry.evaluateInterventions(entries),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch your conduct record');
  }
};

/**
 * GET /api/conduct/student/:studentId
 */
exports.getStudentLedger = async (req, res) => {
  try {
    const { studentId } = req.params;
    if (!isValidId(studentId)) return fail(res, 400, 'Invalid student id.');

    const entries = await ConductEntry.find({
      student: studentId,
      ...visibilityFilter(req.user),
    }).sort({ occurredOn: -1 });

    return res.status(200).json({
      success: true,
      count: entries.length,
      data: entries.map((entry) => entry.redactFor(req.user)),
      balance: ConductEntry.computeBalance(entries),
      intervention: ConductEntry.evaluateInterventions(entries),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the conduct record');
  }
};

/**
 * GET /api/conduct/class/:className
 *
 * The class ledger, grouped by student with each balance and intervention
 * state computed. This is the view that makes six small incidents across six
 * teachers visible as a pattern.
 */
exports.getClassLedger = async (req, res) => {
  try {
    const { className } = req.params;

    const entries = await ConductEntry.find({
      className,
      ...visibilityFilter(req.user),
    }).sort({ occurredOn: -1 });

    const byStudent = new Map();
    entries.forEach((entry) => {
      const key = String(entry.student);
      if (!byStudent.has(key)) {
        byStudent.set(key, { student: key, studentName: entry.studentName, entries: [] });
      }
      byStudent.get(key).entries.push(entry);
    });

    const students = Array.from(byStudent.values())
      .map((record) => ({
        student: record.student,
        studentName: record.studentName,
        balance: ConductEntry.computeBalance(record.entries),
        intervention: ConductEntry.evaluateInterventions(record.entries),
        entries: record.entries.map((entry) => entry.redactFor(req.user)),
      }))
      // Whoever most needs attention first.
      .sort((a, b) => a.balance.net - b.balance.net);

    return res.status(200).json({
      success: true,
      count: students.length,
      data: students,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the class ledger');
  }
};

/**
 * GET /api/conduct/appeals
 * Everything waiting on a decision.
 */
exports.getOpenAppeals = async (req, res) => {
  try {
    const entries = await ConductEntry.find({ status: 'appealed' }).sort({
      'appeal.submittedAt': 1,
    });

    return res.status(200).json({
      success: true,
      count: entries.length,
      data: entries.map((entry) => ({
        ...entry.redactFor(req.user),
        // An appeal this user may not decide is still worth showing, greyed
        // out, so it is clear it is being handled rather than ignored.
        canDecide:
          String(entry.recordedBy) !== String(req.user._id) || req.user.role === 'admin',
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch open appeals');
  }
};

/**
 * GET /api/conduct/leaderboard
 *
 * Merit only. A public ranking that counted demerits would be a pillory, and
 * publishing one is a very different decision from keeping a conduct record.
 */
exports.getLeaderboard = async (req, res) => {
  try {
    const { className } = req.query;

    const filter = {
      type: 'merit',
      status: { $in: ConductEntry.COUNTING_STATUSES },
    };
    if (className) filter.className = className;

    const entries = await ConductEntry.find(filter).select(
      'student studentName className points'
    );

    const totals = new Map();
    entries.forEach((entry) => {
      const key = String(entry.student);
      if (!totals.has(key)) {
        totals.set(key, {
          student: key,
          studentName: entry.studentName,
          className: entry.className,
          meritPoints: 0,
          awards: 0,
        });
      }
      const record = totals.get(key);
      record.meritPoints += entry.points;
      record.awards += 1;
    });

    const ranked = Array.from(totals.values())
      .sort((a, b) => b.meritPoints - a.meritPoints)
      .slice(0, 25);

    return res.status(200).json({ success: true, count: ranked.length, data: ranked });
  } catch (error) {
    return serverError(res, error, 'Failed to build the leaderboard');
  }
};

// ---------------------------------------------------------------------------
// Appeals
// ---------------------------------------------------------------------------

/**
 * POST /api/conduct/:id/appeal
 */
exports.submitAppeal = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid entry id.');

    const entry = await ConductEntry.findById(req.params.id);
    if (!entry) return fail(res, 404, 'Entry not found.');

    try {
      entry.submitAppeal(req.user, req.body.statement);
    } catch (error) {
      if (error.code === 'NOT_YOUR_ENTRY') return fail(res, 403, error.message);
      if (error.code === 'APPEAL_TOO_SHORT') return fail(res, 400, error.message);
      if (error.code === 'APPEAL_REFUSED') return fail(res, 409, error.message);
      throw error;
    }

    await entry.save();

    return res.status(200).json({
      success: true,
      message: 'Appeal submitted. It will be decided by another teacher.',
      data: entry.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to submit the appeal');
  }
};

/**
 * PATCH /api/conduct/:id/appeal
 */
exports.decideAppeal = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid entry id.');

    const { decision, note } = req.body;

    const entry = await ConductEntry.findById(req.params.id);
    if (!entry) return fail(res, 404, 'Entry not found.');

    try {
      entry.decideAppeal(req.user, decision, note);
    } catch (error) {
      if (error.code === 'SELF_REVIEW') return fail(res, 403, error.message);
      if (error.code === 'BAD_DECISION') return fail(res, 400, error.message);
      if (error.code === 'NO_OPEN_APPEAL') return fail(res, 409, error.message);
      throw error;
    }

    await entry.save();

    return res.status(200).json({
      success: true,
      message:
        decision === 'overturned'
          ? 'Appeal allowed. The entry stays on file but no longer counts.'
          : 'Appeal dismissed. The entry stands.',
      data: entry.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to decide the appeal');
  }
};

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------

/**
 * PATCH /api/conduct/:id/expunge
 */
exports.expungeEntry = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid entry id.');

    const entry = await ConductEntry.findById(req.params.id);
    if (!entry) return fail(res, 404, 'Entry not found.');

    try {
      entry.expunge(req.user, req.body.reason);
    } catch (error) {
      if (error.code === 'NOT_ADMIN') return fail(res, 403, error.message);
      if (error.code === 'REASON_REQUIRED') return fail(res, 400, error.message);
      if (error.code === 'ALREADY_EXPUNGED') return fail(res, 409, error.message);
      throw error;
    }

    await entry.save();

    return res.status(200).json({
      success: true,
      message: 'Entry expunged. It remains on file but no longer counts or appears.',
      data: entry.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to expunge the entry');
  }
};

/**
 * PATCH /api/conduct/:id/notified
 * Records that the family has been told. Not a status change — it is
 * orthogonal to whether the entry counts.
 */
exports.markParentNotified = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid entry id.');

    const entry = await ConductEntry.findById(req.params.id);
    if (!entry) return fail(res, 404, 'Entry not found.');

    if (entry.parentNotified) {
      return fail(res, 409, 'The family has already been recorded as notified.');
    }

    entry.parentNotified = true;
    entry.parentNotifiedAt = new Date();
    entry.recordAudit('parent:notified', req.user, req.body.note || null);
    await entry.save();

    return res.status(200).json({
      success: true,
      message: 'Recorded as notified.',
      data: entry.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to record the notification');
  }
};

/**
 * GET /api/conduct/stats
 */
exports.getStats = async (req, res) => {
  try {
    const entries = await ConductEntry.find({}).select(
      'type category status points occurredOn expiresOn student'
    );

    const stats = {
      total: entries.length,
      merits: 0,
      demerits: 0,
      meritPoints: 0,
      demeritPoints: 0,
      openAppeals: 0,
      overturned: 0,
      expunged: 0,
      expired: 0,
      byCategory: {},
      studentsAtOrAboveWarning: 0,
    };

    const byStudent = new Map();

    entries.forEach((entry) => {
      if (entry.status === 'appealed') stats.openAppeals += 1;
      if (entry.status === 'overturned') stats.overturned += 1;
      if (entry.status === 'expunged') stats.expunged += 1;
      if (entry.isExpired) stats.expired += 1;

      stats.byCategory[entry.category] = (stats.byCategory[entry.category] || 0) + 1;

      if (entry.type === 'merit') {
        stats.merits += 1;
        if (ConductEntry.counts(entry)) stats.meritPoints += entry.points;
      } else {
        stats.demerits += 1;
        if (ConductEntry.counts(entry)) stats.demeritPoints += entry.points;
      }

      if (entry.status === 'expunged') return;
      const key = String(entry.student);
      if (!byStudent.has(key)) byStudent.set(key, []);
      byStudent.get(key).push(entry);
    });

    byStudent.forEach((studentEntries) => {
      const intervention = ConductEntry.evaluateInterventions(studentEntries);
      if (intervention.tier !== 'none') stats.studentsAtOrAboveWarning += 1;
    });

    stats.netPoints = stats.meritPoints - stats.demeritPoints;
    // A ledger that is 95% demerits is measuring something other than conduct.
    stats.meritShare =
      stats.merits + stats.demerits > 0
        ? Math.round((stats.merits / (stats.merits + stats.demerits)) * 100)
        : null;

    return res.status(200).json({ success: true, stats });
  } catch (error) {
    return serverError(res, error, 'Failed to compute conduct statistics');
  }
};
