const mongoose = require('mongoose');
const SyllabusPlan = require('../models/SyllabusPlan');

/**
 * Syllabus coverage.
 *
 * Nothing in this file computes a percentage. Coverage and expected coverage
 * are methods on the model, derived from stored sessions and stored dates, so
 * every endpoint that reports progress reports the same number.
 *
 * The handler worth reading closely is `logSession`, which is where the
 * bounds on a lesson log live, and `completeUnit`, which is the one refusal
 * that stops the plan degenerating back into a checklist of ticks.
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
 * Load a plan and check the caller may act on it. Returns either the plan or a
 * `{ status, message }` refusal, so every handler applies the same rule rather
 * than each remembering to.
 */
async function loadPlanFor(id, user, { write = false } = {}) {
  if (!isValidId(id)) return { status: 400, message: 'Invalid plan id' };

  const plan = await SyllabusPlan.findById(id);
  if (!plan) return { status: 404, message: 'Syllabus plan not found' };

  if (!plan.isOwnedBy(user)) {
    return {
      status: 403,
      message: 'This plan belongs to another teacher',
    };
  }

  if (write) {
    const blocked = plan.writabilityError();
    if (blocked) return { status: 409, message: blocked };
  }

  return { plan };
}

/** The plan fields a client may set. Everything else is server-owned. */
function sanitisePlan(body) {
  return {
    className: body.className,
    subject: body.subject,
    academicYear: body.academicYear,
    termStartDate: body.termStartDate,
    termEndDate: body.termEndDate,
  };
}

/**
 * The unit fields a client may set. `periodsTaught`, `orderIndex` and
 * `completedOn` are all derived and are deliberately absent.
 */
function sanitiseUnit(body) {
  return {
    title: body.title,
    description: body.description,
    plannedPeriods: body.plannedPeriods,
    plannedStartDate: body.plannedStartDate,
    plannedEndDate: body.plannedEndDate,
  };
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/**
 * POST /api/syllabus/plans
 *
 * A teacher creates their own plan. An admin may create one on somebody's
 * behalf by naming the teacher.
 */
exports.createPlan = async (req, res) => {
  try {
    let teacher = req.user._id;
    if (req.body.teacher && String(req.body.teacher) !== String(req.user._id)) {
      if (!isAdmin(req.user)) {
        return fail(res, 403, 'Only an admin can create a plan for another teacher');
      }
      if (!isValidId(req.body.teacher)) return fail(res, 400, 'Invalid teacher id');
      teacher = req.body.teacher;
    }

    const plan = new SyllabusPlan({
      ...sanitisePlan(req.body),
      teacher,
      units: [],
    });

    // Units may arrive with the plan. They are appended through the same
    // sanitiser as a later insert, so the two paths cannot diverge.
    if (Array.isArray(req.body.units)) {
      req.body.units.forEach((unit, index) => {
        plan.units.push({ ...sanitiseUnit(unit), orderIndex: index });
      });
    }

    plan.recordRevision('Plan created', req.user._id);
    await plan.save();

    return res.status(201).json({
      success: true,
      message: 'Syllabus plan created',
      data: plan.toDetail(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to create syllabus plan');
  }
};

/**
 * GET /api/syllabus/plans/mine
 */
exports.getMyPlans = async (req, res) => {
  try {
    const filter = { teacher: req.user._id };
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;
    if (req.query.status) filter.status = req.query.status;

    const plans = await SyllabusPlan.find(filter).sort({ updatedAt: -1 });

    return res.status(200).json({
      success: true,
      count: plans.length,
      data: plans.map((plan) => plan.toSummary()),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load your syllabus plans');
  }
};

/**
 * GET /api/syllabus/plans
 *
 * Admin-wide listing. `health` is a derived value so it cannot be a query
 * filter; it is applied after the fold, which is fine at school scale.
 */
exports.listPlans = async (req, res) => {
  try {
    const { className, subject, academicYear, status, teacher, health } = req.query;

    const filter = {};
    if (className) filter.className = className;
    if (subject) filter.subject = subject;
    if (academicYear) filter.academicYear = academicYear;
    if (status) filter.status = status;
    if (teacher) {
      if (!isValidId(teacher)) return fail(res, 400, 'Invalid teacher id');
      filter.teacher = teacher;
    }

    const plans = await SyllabusPlan.find(filter)
      .populate('teacher', 'name email')
      .sort({ className: 1, subject: 1 })
      .limit(500);

    let rows = plans.map((plan) => ({
      ...plan.toSummary(),
      teacher: plan.teacher,
    }));

    if (health) rows = rows.filter((row) => row.progress.health === health);

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load syllabus plans');
  }
};

/**
 * GET /api/syllabus/plans/:id
 */
exports.getPlan = async (req, res) => {
  try {
    const loaded = await loadPlanFor(req.params.id, req.user);
    if (!loaded.plan) return fail(res, loaded.status, loaded.message);

    await loaded.plan.populate('teacher', 'name email');

    return res.status(200).json({
      success: true,
      data: {
        ...loaded.plan.toDetail(),
        teacher: loaded.plan.teacher,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load syllabus plan');
  }
};

/**
 * PATCH /api/syllabus/plans/:id
 */
exports.updatePlan = async (req, res) => {
  try {
    const loaded = await loadPlanFor(req.params.id, req.user, { write: true });
    if (!loaded.plan) return fail(res, loaded.status, loaded.message);

    const plan = loaded.plan;
    const updates = sanitisePlan(req.body);
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) plan[key] = value;
    }

    plan.recordRevision('Plan details updated', req.user._id);
    await plan.save();

    return res.status(200).json({
      success: true,
      message: 'Plan updated',
      data: plan.toDetail(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update syllabus plan');
  }
};

/**
 * PATCH /api/syllabus/plans/:id/activate
 */
exports.activatePlan = async (req, res) => {
  try {
    const loaded = await loadPlanFor(req.params.id, req.user, { write: true });
    if (!loaded.plan) return fail(res, loaded.status, loaded.message);

    const plan = loaded.plan;
    if (plan.status === 'active') {
      return fail(res, 409, 'This plan is already active');
    }
    if (!plan.units.length) {
      return fail(res, 409, 'A plan needs at least one unit before it can be activated');
    }

    plan.status = 'active';
    plan.recordRevision('Plan activated', req.user._id);
    await plan.save();

    return res.status(200).json({
      success: true,
      message: 'Plan activated',
      data: plan.toDetail(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to activate syllabus plan');
  }
};

/**
 * PATCH /api/syllabus/plans/:id/archive
 */
exports.archivePlan = async (req, res) => {
  try {
    const loaded = await loadPlanFor(req.params.id, req.user);
    if (!loaded.plan) return fail(res, loaded.status, loaded.message);

    const plan = loaded.plan;
    if (plan.status === 'archived') {
      return fail(res, 409, 'This plan is already archived');
    }

    plan.status = 'archived';
    plan.archivedAt = new Date();
    plan.recordRevision('Plan archived', req.user._id);
    await plan.save();

    return res.status(200).json({
      success: true,
      message: 'Plan archived',
      data: plan.toSummary(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to archive syllabus plan');
  }
};

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/**
 * POST /api/syllabus/plans/:id/units
 */
exports.addUnit = async (req, res) => {
  try {
    const loaded = await loadPlanFor(req.params.id, req.user, { write: true });
    if (!loaded.plan) return fail(res, loaded.status, loaded.message);

    const plan = loaded.plan;
    plan.units.push({
      ...sanitiseUnit(req.body),
      orderIndex: plan.units.length,
    });

    plan.recordRevision(`Unit added: ${req.body.title || 'untitled'}`, req.user._id);
    await plan.save();

    return res.status(201).json({
      success: true,
      message: 'Unit added',
      data: plan.toDetail(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to add unit');
  }
};

/**
 * PATCH /api/syllabus/plans/:id/units/:unitId
 */
exports.updateUnit = async (req, res) => {
  try {
    const loaded = await loadPlanFor(req.params.id, req.user, { write: true });
    if (!loaded.plan) return fail(res, loaded.status, loaded.message);

    const plan = loaded.plan;
    const unit = plan.findUnit(req.params.unitId);
    if (!unit) return fail(res, 404, 'Unit not found');

    const updates = sanitiseUnit(req.body);
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) unit[key] = value;
    }

    plan.recordRevision(`Unit updated: ${unit.title}`, req.user._id);
    await plan.save();

    return res.status(200).json({
      success: true,
      message: 'Unit updated',
      data: plan.toDetail(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update unit');
  }
};

/**
 * PATCH /api/syllabus/plans/:id/units/:unitId/reorder
 *
 * Takes a target position. The model re-normalises the whole list on save, so
 * this only has to nudge the unit to either side of its new neighbour.
 */
exports.reorderUnit = async (req, res) => {
  try {
    const loaded = await loadPlanFor(req.params.id, req.user, { write: true });
    if (!loaded.plan) return fail(res, loaded.status, loaded.message);

    const plan = loaded.plan;
    const unit = plan.findUnit(req.params.unitId);
    if (!unit) return fail(res, 404, 'Unit not found');

    const position = Number(req.body.position);
    if (!Number.isInteger(position) || position < 0 || position >= plan.units.length) {
      return fail(
        res,
        400,
        `Position must be a whole number between 0 and ${plan.units.length - 1}`
      );
    }

    // Half-step either side of the target, then let the pre-validate hook sort
    // and renumber. Simpler than splicing, and it cannot leave a gap.
    unit.orderIndex = position > unit.orderIndex ? position + 0.5 : position - 0.5;

    plan.recordRevision(`Unit reordered: ${unit.title}`, req.user._id);
    await plan.save();

    return res.status(200).json({
      success: true,
      message: 'Unit reordered',
      data: plan.toDetail(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to reorder unit');
  }
};

/**
 * PATCH /api/syllabus/plans/:id/units/:unitId/complete
 *
 * The refusal this feature exists for: a unit cannot be ticked off without any
 * lessons logged against it. Without this rule the plan is the Word document
 * it was meant to replace.
 */
exports.completeUnit = async (req, res) => {
  try {
    const loaded = await loadPlanFor(req.params.id, req.user, { write: true });
    if (!loaded.plan) return fail(res, loaded.status, loaded.message);

    const plan = loaded.plan;
    const unit = plan.findUnit(req.params.unitId);
    if (!unit) return fail(res, 404, 'Unit not found');

    if (unit.status === 'completed') {
      return fail(res, 409, 'This unit is already complete');
    }
    if (!unit.sessions.length) {
      return fail(
        res,
        409,
        'This unit has no lessons logged against it. Log the lessons taught before completing it.'
      );
    }

    unit.status = 'completed';
    unit.completedOn = SyllabusPlan.todayKey();
    unit.completionNote = req.body.note;

    plan.recordRevision(`Unit completed: ${unit.title}`, req.user._id);
    await plan.save();

    return res.status(200).json({
      success: true,
      message: 'Unit marked complete',
      data: plan.toDetail(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to complete unit');
  }
};

/**
 * PATCH /api/syllabus/plans/:id/units/:unitId/defer
 *
 * A deferred unit stays in the plan and stays in the denominator.
 */
exports.deferUnit = async (req, res) => {
  try {
    const loaded = await loadPlanFor(req.params.id, req.user, { write: true });
    if (!loaded.plan) return fail(res, loaded.status, loaded.message);

    const plan = loaded.plan;
    const unit = plan.findUnit(req.params.unitId);
    if (!unit) return fail(res, 404, 'Unit not found');

    if (unit.status === 'completed') {
      return fail(res, 409, 'A completed unit cannot be deferred');
    }
    if (!req.body.reason) {
      return fail(res, 400, 'A reason is required when deferring a unit');
    }

    unit.status = 'deferred';
    unit.deferralReason = req.body.reason;

    plan.recordRevision(`Unit deferred: ${unit.title}`, req.user._id);
    await plan.save();

    return res.status(200).json({
      success: true,
      message: 'Unit deferred',
      data: plan.toDetail(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to defer unit');
  }
};

/**
 * DELETE /api/syllabus/plans/:id/units/:unitId
 *
 * Refused once anything has been taught against it — deleting a unit with a
 * lesson log destroys the record of lessons that happened.
 */
exports.removeUnit = async (req, res) => {
  try {
    const loaded = await loadPlanFor(req.params.id, req.user, { write: true });
    if (!loaded.plan) return fail(res, loaded.status, loaded.message);

    const plan = loaded.plan;
    const unit = plan.findUnit(req.params.unitId);
    if (!unit) return fail(res, 404, 'Unit not found');

    if (unit.sessions.length) {
      return fail(
        res,
        409,
        'This unit has lessons logged against it. Defer it instead of deleting it.'
      );
    }

    const title = unit.title;
    unit.deleteOne();

    plan.recordRevision(`Unit removed: ${title}`, req.user._id);
    await plan.save();

    return res.status(200).json({
      success: true,
      message: 'Unit removed',
      data: plan.toDetail(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to remove unit');
  }
};

// ---------------------------------------------------------------------------
// Lesson log
// ---------------------------------------------------------------------------

/**
 * POST /api/syllabus/plans/:id/units/:unitId/sessions
 *
 * The bounds here are the ones that keep coverage honest: nothing in the
 * future, nothing against a deferred unit, and a per-day ceiling across the
 * whole plan so a mis-typed period count cannot silently inflate the total.
 */
exports.logSession = async (req, res) => {
  try {
    const loaded = await loadPlanFor(req.params.id, req.user, { write: true });
    if (!loaded.plan) return fail(res, loaded.status, loaded.message);

    const plan = loaded.plan;
    const unit = plan.findUnit(req.params.unitId);
    if (!unit) return fail(res, 404, 'Unit not found');

    if (unit.status === 'deferred') {
      return fail(
        res,
        409,
        'This unit is deferred. Reinstate it before logging lessons against it.'
      );
    }

    const { date, periods, topic, note } = req.body;
    const today = SyllabusPlan.todayKey();

    if (!date) return fail(res, 400, 'A lesson date is required');
    if (date > today) {
      return fail(res, 400, 'A lesson cannot be logged for a future date');
    }
    if (date < plan.termStartDate || date > plan.termEndDate) {
      return fail(
        res,
        400,
        `That date falls outside the term (${plan.termStartDate} to ${plan.termEndDate})`
      );
    }

    const requested = Number(periods);
    if (!Number.isInteger(requested) || requested < 1) {
      return fail(res, 400, 'Periods must be a whole number of at least one');
    }

    // Everything already logged on this date, across every unit in the plan.
    const alreadyToday = plan.units.reduce(
      (total, u) =>
        total +
        (u.sessions || [])
          .filter((s) => s.date === date)
          .reduce((sum, s) => sum + (s.periods || 0), 0),
      0
    );
    if (alreadyToday + requested > SyllabusPlan.MAX_PERIODS_PER_SESSION) {
      return fail(
        res,
        409,
        `That would put ${alreadyToday + requested} periods of ${plan.subject} on ${date}. ` +
          `The daily ceiling is ${SyllabusPlan.MAX_PERIODS_PER_SESSION}.`
      );
    }

    unit.sessions.push({
      date,
      periods: requested,
      topic,
      note,
      loggedBy: req.user._id,
      loggedAt: new Date(),
    });

    // Logging against a not-started unit is what starts it. Making the teacher
    // press "start" first would just be a step to forget.
    if (unit.status === 'not-started') unit.status = 'in-progress';

    await plan.save();

    return res.status(201).json({
      success: true,
      message: 'Lesson logged',
      data: plan.toDetail(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to log lesson');
  }
};

/**
 * DELETE /api/syllabus/plans/:id/units/:unitId/sessions/:sessionId
 */
exports.removeSession = async (req, res) => {
  try {
    const loaded = await loadPlanFor(req.params.id, req.user, { write: true });
    if (!loaded.plan) return fail(res, loaded.status, loaded.message);

    const plan = loaded.plan;
    const unit = plan.findUnit(req.params.unitId);
    if (!unit) return fail(res, 404, 'Unit not found');

    if (!isValidId(req.params.sessionId)) return fail(res, 400, 'Invalid session id');
    const session = unit.sessions.id(req.params.sessionId);
    if (!session) return fail(res, 404, 'Lesson log not found');

    // Removing the last logged lesson from a completed unit would leave it
    // completed with nothing taught, which the model refuses on save. Reopen
    // it here so the refusal is a clear message rather than a validation dump.
    if (unit.status === 'completed' && unit.sessions.length === 1) {
      unit.status = 'in-progress';
      unit.completedOn = undefined;
    }

    session.deleteOne();
    await plan.save();

    return res.status(200).json({
      success: true,
      message: 'Lesson log removed',
      data: plan.toDetail(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to remove lesson log');
  }
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * GET /api/syllabus/overview
 *
 * Every active plan in the school, worst lag first. This list is the January
 * department meeting, available in October.
 */
exports.getOverview = async (req, res) => {
  try {
    const filter = { status: 'active' };
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;

    const plans = await SyllabusPlan.find(filter).populate('teacher', 'name email');

    const rows = plans
      .map((plan) => ({
        ...plan.toSummary(),
        teacher: plan.teacher,
      }))
      .sort((a, b) => b.progress.lagPercent - a.progress.lagPercent);

    const behind = rows.filter((row) =>
      ['behind', 'slipping'].includes(row.progress.health)
    );

    return res.status(200).json({
      success: true,
      data: {
        plans: rows,
        total: rows.length,
        needingAttention: behind.length,
        thresholds: SyllabusPlan.HEALTH_THRESHOLDS,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build the coverage overview');
  }
};

/**
 * GET /api/syllabus/stats
 */
exports.getStats = async (req, res) => {
  try {
    const plans = await SyllabusPlan.find({}).select(
      'status className subject academicYear units'
    );

    const byStatus = {};
    for (const status of SyllabusPlan.PLAN_STATUSES) byStatus[status] = 0;

    const byHealth = {
      ahead: 0,
      'on-track': 0,
      slipping: 0,
      behind: 0,
      empty: 0,
    };

    let totalPlanned = 0;
    let totalTaught = 0;
    let overrunningUnits = 0;

    for (const plan of plans) {
      byStatus[plan.status] = (byStatus[plan.status] || 0) + 1;
      if (plan.status !== 'active') continue;

      const progress = plan.progress();
      byHealth[progress.health] = (byHealth[progress.health] || 0) + 1;
      totalPlanned += progress.plannedPeriods;
      totalTaught += progress.periodsTaught;
      overrunningUnits += progress.unitsOverrunning;
    }

    return res.status(200).json({
      success: true,
      data: {
        total: plans.length,
        byStatus,
        byHealth,
        totalPlannedPeriods: totalPlanned,
        totalPeriodsTaught: totalTaught,
        schoolCoveragePercent: totalPlanned
          ? Math.round((totalTaught / totalPlanned) * 1000) / 10
          : 0,
        overrunningUnits,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build syllabus statistics');
  }
};
