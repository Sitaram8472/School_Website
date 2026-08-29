// backend/controllers/timetableController.js
const mongoose = require('mongoose');
const Timetable = require('../models/Timetable');

const DAYS = Timetable.DAYS;

const handleError = (res, err, message = 'Server error') => {
  console.error('[timetables]', err);
  return res.status(500).json({ success: false, message, error: err.message });
};

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

// Schema validation failures and the clash errors the model tags with
// `userFacing` are the caller's problem; anything else is ours.
const isUserError = (err) => err.name === 'ValidationError' || err.userFacing === true;

const canManage = (user, timetable) => {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return timetable.createdBy.toString() === user._id.toString();
};

const todayName = (now = new Date()) => DAYS[(now.getDay() + 6) % 7];

/**
 * Normalise one period from the request body. Times are trimmed and the
 * teacher name is carried over so the grid still reads if the account goes.
 */
const normalisePeriod = (raw, fallbackTeacher) => ({
  day: raw.day,
  periodNumber: Number(raw.periodNumber),
  subject: String(raw.subject || '').trim(),
  teacher: raw.teacher && isValidId(raw.teacher) ? raw.teacher : fallbackTeacher?._id || null,
  teacherName: (raw.teacherName || fallbackTeacher?.name || '').trim(),
  startTime: String(raw.startTime || '').trim(),
  endTime: String(raw.endTime || '').trim(),
  room: (raw.room || '').trim(),
  type: raw.type || 'lecture',
});

// ---- CRUD ----

/**
 * POST /api/timetables
 * Create a timetable, optionally with its full set of periods. Created inactive
 * so a half-built grid is never served to students.
 */
exports.createTimetable = async (req, res) => {
  try {
    const { className, section, academicYear, effectiveFrom, periods, notes } = req.body;

    if (!className || !academicYear) {
      return res.status(400).json({
        success: false,
        message: 'Class name and academic year are required.',
      });
    }

    const timetable = new Timetable({
      className: String(className).trim(),
      section: section || 'A',
      academicYear: String(academicYear).trim(),
      effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
      notes: notes || '',
      createdBy: req.user._id,
      periods: Array.isArray(periods) ? periods.map((p) => normalisePeriod(p, req.user)) : [],
    });

    await timetable.save();

    return res.status(201).json({ success: true, message: 'Timetable created.', data: timetable });
  } catch (err) {
    if (isUserError(err)) {
      return res.status(400).json({ success: false, message: err.message });
    }
    return handleError(res, err, 'Failed to create timetable');
  }
};

/**
 * GET /api/timetables
 * Listing for staff, filterable by class, section, year and active flag.
 */
exports.getTimetables = async (req, res) => {
  try {
    const filter = {};

    if (req.query.className) filter.className = new RegExp(`^${req.query.className}$`, 'i');
    if (req.query.section) filter.section = String(req.query.section).toUpperCase();
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;
    if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';

    const timetables = await Timetable.find(filter)
      .populate('createdBy', 'name')
      .sort({ isActive: -1, className: 1, section: 1 });

    return res.json({ success: true, data: timetables });
  } catch (err) {
    return handleError(res, err, 'Failed to load timetables');
  }
};

/**
 * GET /api/timetables/:id
 */
exports.getTimetable = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid timetable id.' });
    }

    const timetable = await Timetable.findById(req.params.id).populate('periods.teacher', 'name email');
    if (!timetable) {
      return res.status(404).json({ success: false, message: 'Timetable not found.' });
    }

    return res.json({ success: true, data: timetable });
  } catch (err) {
    return handleError(res, err, 'Failed to load timetable');
  }
};

/**
 * PUT /api/timetables/:id
 * Replace the metadata and, when supplied, the entire period list. Sending the
 * whole list keeps the overlap check authoritative over the final state.
 */
exports.updateTimetable = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid timetable id.' });
    }

    const timetable = await Timetable.findById(req.params.id);
    if (!timetable) {
      return res.status(404).json({ success: false, message: 'Timetable not found.' });
    }
    if (!canManage(req.user, timetable)) {
      return res.status(403).json({ success: false, message: 'You can only edit timetables you created.' });
    }

    ['className', 'section', 'academicYear', 'notes'].forEach((field) => {
      if (req.body[field] !== undefined) timetable[field] = req.body[field];
    });

    if (req.body.effectiveFrom !== undefined) {
      const parsed = new Date(req.body.effectiveFrom);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ success: false, message: 'effectiveFrom is not a valid date.' });
      }
      timetable.effectiveFrom = parsed;
    }

    if (Array.isArray(req.body.periods)) {
      timetable.periods = req.body.periods.map((p) => normalisePeriod(p, req.user));
    }

    await timetable.save();

    return res.json({ success: true, message: 'Timetable updated.', data: timetable });
  } catch (err) {
    if (isUserError(err)) {
      return res.status(400).json({ success: false, message: err.message });
    }
    return handleError(res, err, 'Failed to update timetable');
  }
};

/**
 * DELETE /api/timetables/:id
 */
exports.deleteTimetable = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid timetable id.' });
    }

    const timetable = await Timetable.findById(req.params.id);
    if (!timetable) {
      return res.status(404).json({ success: false, message: 'Timetable not found.' });
    }
    if (!canManage(req.user, timetable)) {
      return res.status(403).json({ success: false, message: 'You can only delete timetables you created.' });
    }

    await timetable.deleteOne();

    return res.json({ success: true, message: 'Timetable deleted.' });
  } catch (err) {
    return handleError(res, err, 'Failed to delete timetable');
  }
};

// ---- PERIODS ----

/**
 * POST /api/timetables/:id/periods
 * Add one period. Clashes are reported with the specific conflicting period so
 * the teacher knows what to move.
 */
exports.addPeriod = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid timetable id.' });
    }

    const timetable = await Timetable.findById(req.params.id);
    if (!timetable) {
      return res.status(404).json({ success: false, message: 'Timetable not found.' });
    }
    if (!canManage(req.user, timetable)) {
      return res.status(403).json({ success: false, message: 'Not authorized to edit this timetable.' });
    }

    const candidate = normalisePeriod(req.body, req.user);

    if (!DAYS.includes(candidate.day)) {
      return res.status(400).json({ success: false, message: `Day must be one of: ${DAYS.join(', ')}` });
    }
    if (!candidate.subject) {
      return res.status(400).json({ success: false, message: 'Subject is required.' });
    }

    const clash = timetable.findClash(candidate);
    if (clash) {
      return res.status(400).json({
        success: false,
        message: `Clashes with "${clash.subject}" (${clash.startTime}-${clash.endTime}) on ${clash.day}.`,
      });
    }

    timetable.periods.push(candidate);
    await timetable.save();

    return res.status(201).json({ success: true, message: 'Period added.', data: timetable });
  } catch (err) {
    if (isUserError(err)) {
      return res.status(400).json({ success: false, message: err.message });
    }
    return handleError(res, err, 'Failed to add period');
  }
};

/**
 * PUT /api/timetables/:id/periods/:periodId
 */
exports.updatePeriod = async (req, res) => {
  try {
    if (!isValidId(req.params.id) || !isValidId(req.params.periodId)) {
      return res.status(400).json({ success: false, message: 'Invalid id.' });
    }

    const timetable = await Timetable.findById(req.params.id);
    if (!timetable) {
      return res.status(404).json({ success: false, message: 'Timetable not found.' });
    }
    if (!canManage(req.user, timetable)) {
      return res.status(403).json({ success: false, message: 'Not authorized to edit this timetable.' });
    }

    const period = timetable.periods.id(req.params.periodId);
    if (!period) {
      return res.status(404).json({ success: false, message: 'Period not found.' });
    }

    const candidate = {
      day: req.body.day || period.day,
      startTime: req.body.startTime || period.startTime,
      endTime: req.body.endTime || period.endTime,
    };

    const clash = timetable.findClash(candidate, period._id);
    if (clash) {
      return res.status(400).json({
        success: false,
        message: `Clashes with "${clash.subject}" (${clash.startTime}-${clash.endTime}) on ${clash.day}.`,
      });
    }

    ['day', 'periodNumber', 'subject', 'teacherName', 'startTime', 'endTime', 'room', 'type'].forEach(
      (field) => {
        if (req.body[field] !== undefined) period[field] = req.body[field];
      }
    );

    if (req.body.teacher !== undefined) {
      period.teacher = isValidId(req.body.teacher) ? req.body.teacher : null;
    }

    await timetable.save();

    return res.json({ success: true, message: 'Period updated.', data: timetable });
  } catch (err) {
    if (isUserError(err)) {
      return res.status(400).json({ success: false, message: err.message });
    }
    return handleError(res, err, 'Failed to update period');
  }
};

/**
 * DELETE /api/timetables/:id/periods/:periodId
 */
exports.removePeriod = async (req, res) => {
  try {
    if (!isValidId(req.params.id) || !isValidId(req.params.periodId)) {
      return res.status(400).json({ success: false, message: 'Invalid id.' });
    }

    const timetable = await Timetable.findById(req.params.id);
    if (!timetable) {
      return res.status(404).json({ success: false, message: 'Timetable not found.' });
    }
    if (!canManage(req.user, timetable)) {
      return res.status(403).json({ success: false, message: 'Not authorized to edit this timetable.' });
    }

    const period = timetable.periods.id(req.params.periodId);
    if (!period) {
      return res.status(404).json({ success: false, message: 'Period not found.' });
    }

    period.deleteOne();
    await timetable.save();

    return res.json({ success: true, message: 'Period removed.', data: timetable });
  } catch (err) {
    return handleError(res, err, 'Failed to remove period');
  }
};

// ---- PUBLISHING ----

/**
 * PATCH /api/timetables/:id/activate
 * Exactly one timetable is active per class + section + year, so activating one
 * deactivates whatever it replaces.
 */
exports.activateTimetable = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid timetable id.' });
    }

    const timetable = await Timetable.findById(req.params.id);
    if (!timetable) {
      return res.status(404).json({ success: false, message: 'Timetable not found.' });
    }
    if (!canManage(req.user, timetable)) {
      return res.status(403).json({ success: false, message: 'Not authorized to publish this timetable.' });
    }
    if (timetable.periods.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Add at least one period before publishing this timetable.',
      });
    }

    await Timetable.updateMany(
      {
        _id: { $ne: timetable._id },
        className: timetable.className,
        section: timetable.section,
        academicYear: timetable.academicYear,
      },
      { isActive: false }
    );

    timetable.isActive = true;
    await timetable.save();

    return res.json({ success: true, message: 'Timetable is now live.', data: timetable });
  } catch (err) {
    return handleError(res, err, 'Failed to activate timetable');
  }
};

/**
 * PATCH /api/timetables/:id/deactivate
 */
exports.deactivateTimetable = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid timetable id.' });
    }

    const timetable = await Timetable.findById(req.params.id);
    if (!timetable) {
      return res.status(404).json({ success: false, message: 'Timetable not found.' });
    }
    if (!canManage(req.user, timetable)) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    timetable.isActive = false;
    await timetable.save();

    return res.json({ success: true, message: 'Timetable deactivated.', data: timetable });
  } catch (err) {
    return handleError(res, err, 'Failed to deactivate timetable');
  }
};

// ---- RESOLVED VIEWS ----

/**
 * GET /api/timetables/me
 * Resolves what the caller should see: a student gets their class grid, a
 * teacher gets the periods they personally teach across every active class.
 */
exports.getMyTimetable = async (req, res) => {
  try {
    if (req.user.role === 'teacher' || req.user.role === 'admin') {
      const timetables = await Timetable.find({ isActive: true, 'periods.teacher': req.user._id });

      const periods = timetables.flatMap((timetable) =>
        timetable.periods
          .filter((period) => period.teacher && period.teacher.toString() === req.user._id.toString())
          .map((period) => ({
            ...period.toObject(),
            className: timetable.className,
            section: timetable.section,
          }))
      );

      return res.json({
        success: true,
        scope: 'teacher',
        data: { periods, timetableCount: timetables.length },
      });
    }

    const className = req.query.className || req.user.className;
    const filter = { isActive: true };
    if (className) filter.className = new RegExp(`^${className}$`, 'i');
    if (req.query.section) filter.section = String(req.query.section).toUpperCase();

    // Falls back to any active timetable when the student record carries no
    // class, so a freshly seeded account still sees something useful.
    const timetable = await Timetable.findOne(filter).sort({ effectiveFrom: -1 });

    if (!timetable) {
      return res.json({ success: true, scope: 'student', data: null, message: 'No active timetable found.' });
    }

    return res.json({
      success: true,
      scope: 'student',
      data: {
        _id: timetable._id,
        className: timetable.className,
        section: timetable.section,
        academicYear: timetable.academicYear,
        periods: timetable.periods,
        currentPeriod: timetable.currentPeriod(),
      },
    });
  } catch (err) {
    return handleError(res, err, 'Failed to resolve your timetable');
  }
};

/**
 * GET /api/timetables/today
 * Just today's periods, with the one in progress flagged — the shape the
 * dashboard widget wants.
 */
exports.getTodaySchedule = async (req, res) => {
  try {
    const day = req.query.day && DAYS.includes(req.query.day) ? req.query.day : todayName();
    const filter = { isActive: true };

    const className = req.query.className || req.user.className;
    if (className) filter.className = new RegExp(`^${className}$`, 'i');

    const timetable = await Timetable.findOne(filter).sort({ effectiveFrom: -1 });

    if (!timetable) {
      return res.json({ success: true, data: { day, periods: [], currentPeriodId: null } });
    }

    const current = timetable.currentPeriod();

    return res.json({
      success: true,
      data: {
        day,
        className: timetable.className,
        section: timetable.section,
        periods: timetable.periodsForDay(day),
        currentPeriodId: current ? current._id : null,
      },
    });
  } catch (err) {
    return handleError(res, err, "Failed to load today's schedule");
  }
};
