const mongoose = require('mongoose');
const SeatingPlan = require('../models/SeatingPlan');
const Exam = require('../models/Exam');

/**
 * Exam hall seating and invigilation duty.
 *
 * The allocator itself lives in the model as pure functions; this file is
 * lifecycle, authorisation and the clash checks that need to look at other
 * documents.
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

/**
 * A detached array subdocument has no parent to record a failure against, so
 * Mongoose throws the ValidatorError out of validateSync() rather than
 * returning a ValidationError. Left uncaught that turns a bad roll number into
 * a 500.
 */
function validateSubdocument(doc) {
  try {
    return doc.validateSync() || null;
  } catch (error) {
    return error;
  }
}

function canManage(plan, user) {
  return String(plan.createdBy) === String(user._id) || user.role === 'admin';
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/**
 * POST /api/seating/plans
 */
exports.createPlan = async (req, res) => {
  try {
    const { exam, examTitle, examDate, startTime, endTime, hall, notes } = req.body;

    if (!hall || typeof hall !== 'object') {
      return fail(res, 400, 'A hall with a name, rows and columns is required.');
    }

    let linkedExam = null;
    if (exam) {
      if (!isValidId(exam)) return fail(res, 400, 'Invalid exam id.');
      linkedExam = await Exam.findById(exam).select('title creator');
      if (!linkedExam) return fail(res, 404, 'That exam does not exist.');
    }

    const plan = new SeatingPlan({
      exam: linkedExam ? linkedExam._id : null,
      examTitle: examTitle || (linkedExam && linkedExam.title),
      examDate,
      startTime,
      endTime,
      hall: {
        name: hall.name,
        rows: hall.rows,
        columns: hall.columns,
        blockedSeats: Array.isArray(hall.blockedSeats)
          ? hall.blockedSeats.map((label) => String(label).toUpperCase().trim())
          : [],
      },
      notes,
      createdBy: req.user._id,
      createdByName: req.user.name,
      // status, allocationSeed, candidates and invigilators are all
      // server-owned and deliberately not read from the body.
    });

    plan.recordAudit('plan:created', req.user, `${hall.name} ${hall.rows}x${hall.columns}`);
    await plan.save();

    return res.status(201).json({
      success: true,
      message: `Plan created with ${plan.capacity} usable seats.`,
      data: plan.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to create the seating plan');
  }
};

/**
 * GET /api/seating/plans
 */
exports.getPlans = async (req, res) => {
  try {
    const { date, status, hall } = req.query;
    const filter = {};
    if (date) filter.examDate = date;
    if (status) filter.status = status;
    if (hall) filter['hall.name'] = hall;

    const plans = await SeatingPlan.find(filter)
      .sort({ examDate: -1, startMinute: 1 })
      .limit(200);

    return res.status(200).json({
      success: true,
      count: plans.length,
      data: plans.map((plan) => plan.redactFor(req.user)),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch seating plans');
  }
};

/**
 * GET /api/seating/plans/:id
 */
exports.getPlan = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid plan id.');

    const plan = await SeatingPlan.findById(req.params.id);
    if (!plan) return fail(res, 404, 'Seating plan not found.');

    return res.status(200).json({ success: true, data: plan.redactFor(req.user) });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the seating plan');
  }
};

/**
 * POST /api/seating/plans/:id/candidates
 *
 * Bulk add. Seat fields are stripped from whatever arrives — a candidate does
 * not get to nominate their own seat, and the allocator is the only thing that
 * writes `seatLabel`.
 */
exports.addCandidates = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid plan id.');

    const { candidates } = req.body;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return fail(res, 400, 'candidates must be a non-empty array.');
    }

    const plan = await SeatingPlan.findById(req.params.id);
    if (!plan) return fail(res, 404, 'Seating plan not found.');
    if (!canManage(plan, req.user)) {
      return fail(res, 403, 'You can only edit plans you created.');
    }
    if (!plan.isEditable) {
      return fail(res, 409, `A ${plan.status} plan cannot take new candidates.`);
    }

    const existingRolls = new Set(
      plan.candidates.map((candidate) => candidate.rollNumber)
    );

    const added = [];
    const skipped = [];

    for (const entry of candidates) {
      const rollNumber = String(entry.rollNumber || '').trim().toUpperCase();
      if (!rollNumber) {
        skipped.push({ rollNumber: entry.rollNumber || '(blank)', reason: 'no roll number' });
        continue;
      }
      if (existingRolls.has(rollNumber)) {
        skipped.push({ rollNumber, reason: 'already on this plan' });
        continue;
      }

      const candidate = plan.candidates.create({
        student: entry.student && isValidId(entry.student) ? entry.student : null,
        studentName: entry.studentName,
        rollNumber,
        subjectCode: entry.subjectCode,
        className: entry.className,
        status: 'unallocated',
      });

      const invalid = validateSubdocument(candidate);
      if (invalid) {
        skipped.push({ rollNumber, reason: validationMessage(invalid) || 'invalid' });
        continue;
      }

      existingRolls.add(rollNumber);
      plan.candidates.push(candidate);
      added.push(rollNumber);
    }

    if (added.length === 0) {
      return fail(res, 400, 'No candidates could be added.', { skipped });
    }

    // Adding candidates invalidates any allocation that already ran.
    if (plan.status === 'allocated') {
      plan.moveTo('draft', req.user, 'candidate list changed');
      plan.candidates.forEach((candidate) => {
        candidate.seatLabel = null;
        candidate.row = null;
        candidate.column = null;
        candidate.status = 'unallocated';
      });
      plan.allocationSeed = null;
      plan.allocatedAt = null;
    }

    plan.recordAudit('candidates:added', req.user, `${added.length} added`);
    await plan.save();

    return res.status(201).json({
      success: true,
      message: `${added.length} candidate${added.length === 1 ? '' : 's'} added.`,
      skipped,
      data: plan.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to add candidates');
  }
};

/**
 * DELETE /api/seating/plans/:id/candidates/:candidateId
 */
exports.removeCandidate = async (req, res) => {
  try {
    const { id, candidateId } = req.params;
    if (!isValidId(id) || !isValidId(candidateId)) {
      return fail(res, 400, 'Invalid plan or candidate id.');
    }

    const plan = await SeatingPlan.findById(id);
    if (!plan) return fail(res, 404, 'Seating plan not found.');
    if (!canManage(plan, req.user)) {
      return fail(res, 403, 'You can only edit plans you created.');
    }
    if (!plan.isEditable) {
      return fail(res, 409, `A ${plan.status} plan cannot be edited.`);
    }

    const candidate = plan.candidates.id(candidateId);
    if (!candidate) return fail(res, 404, 'Candidate not found on this plan.');

    const { rollNumber } = candidate;
    candidate.deleteOne();

    if (plan.status === 'allocated') {
      plan.moveTo('draft', req.user, 'candidate list changed');
      plan.candidates.forEach((entry) => {
        entry.seatLabel = null;
        entry.row = null;
        entry.column = null;
        entry.status = 'unallocated';
      });
      plan.allocationSeed = null;
      plan.allocatedAt = null;
    }

    plan.recordAudit('candidate:removed', req.user, rollNumber);
    await plan.save();

    return res.status(200).json({
      success: true,
      message: `${rollNumber} removed.`,
      data: plan.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to remove the candidate');
  }
};

/**
 * POST /api/seating/plans/:id/allocate
 *
 * Runs the allocator and writes the seats back. A `seed` may be supplied to
 * reproduce an earlier plan exactly; otherwise one is derived from the plan id
 * so that re-running without a seed is still stable rather than being a fresh
 * coin toss every time.
 */
exports.allocate = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid plan id.');

    const plan = await SeatingPlan.findById(req.params.id);
    if (!plan) return fail(res, 404, 'Seating plan not found.');
    if (!canManage(plan, req.user)) {
      return fail(res, 403, 'You can only allocate plans you created.');
    }
    if (!plan.isEditable) {
      return fail(res, 409, `A ${plan.status} plan cannot be re-allocated.`);
    }
    if (plan.candidates.length === 0) {
      return fail(res, 400, 'Add candidates before allocating seats.');
    }

    const seed = Number.isInteger(req.body.seed)
      ? req.body.seed
      : plan.allocationSeed !== null
        ? plan.allocationSeed
        : // Stable per plan: the same plan re-allocated without a seed lands
          // in the same arrangement rather than shuffling under the printer.
          parseInt(String(plan._id).slice(-8), 16);

    let result;
    try {
      result = SeatingPlan.allocateSeats(
        plan.candidates.map((candidate) => ({
          id: String(candidate._id),
          rollNumber: candidate.rollNumber,
          subjectCode: candidate.subjectCode,
        })),
        plan.hall,
        seed
      );
    } catch (error) {
      if (error.code === 'HALL_TOO_SMALL') {
        // Nothing has been written — the plan is exactly as it was.
        return fail(res, 409, error.message, {
          candidates: plan.candidates.length,
          usableSeats: plan.capacity,
        });
      }
      throw error;
    }

    const seatById = new Map(
      result.placements.map((placement) => [placement.id, placement])
    );

    plan.candidates.forEach((candidate) => {
      const placement = seatById.get(String(candidate._id));
      if (!placement) return;
      candidate.seatLabel = placement.seatLabel;
      candidate.row = placement.row;
      candidate.column = placement.column;
      candidate.status = 'allocated';
    });

    plan.allocationSeed = seed;
    plan.allocatedAt = new Date();
    plan.adjacencyViolations = {
      horizontal: result.violations.horizontal,
      vertical: result.violations.vertical,
    };

    if (plan.status === 'draft') {
      plan.moveTo('allocated', req.user, `seed ${seed}`);
    } else {
      plan.recordAudit('plan:reallocated', req.user, `seed ${seed}`);
    }

    await plan.save();

    return res.status(200).json({
      success: true,
      message:
        result.violations.total === 0
          ? 'Allocated with no same-subject neighbours.'
          : `Allocated. ${result.violations.total} same-subject adjacencies could not be avoided in this hall.`,
      seed,
      violations: result.violations,
      data: plan.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to allocate seats');
  }
};

// ---------------------------------------------------------------------------
// Invigilation
// ---------------------------------------------------------------------------

/**
 * POST /api/seating/plans/:id/invigilators
 *
 * Three rules, all of which exist because somebody has been caught out by them
 * before: one chief per hall, no teacher in two halls at once, and never the
 * author of the paper being written in front of them.
 */
exports.assignInvigilator = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid plan id.');

    const { teacher, teacherName, role } = req.body;
    if (!isValidId(teacher)) return fail(res, 400, 'A valid teacher id is required.');

    const plan = await SeatingPlan.findById(req.params.id);
    if (!plan) return fail(res, 404, 'Seating plan not found.');
    if (!canManage(plan, req.user)) {
      return fail(res, 403, 'You can only staff plans you created.');
    }
    if (['locked', 'cancelled'].includes(plan.status)) {
      return fail(res, 409, `A ${plan.status} plan cannot be re-staffed.`);
    }
    if (plan.hasInvigilator(teacher)) {
      return fail(res, 409, 'That teacher is already on this plan.');
    }

    const wantedRole = SeatingPlan.INVIGILATOR_ROLES.includes(role) ? role : 'assistant';

    if (wantedRole === 'chief' && plan.chiefInvigilator()) {
      return fail(
        res,
        409,
        'This hall already has a chief invigilator. Two people in charge is nobody in charge.'
      );
    }

    // Setting your own paper and then invigilating it is the arrangement every
    // exam regulation exists to prevent.
    if (plan.exam) {
      const exam = await Exam.findById(plan.exam).select('creator');
      if (exam && String(exam.creator) === String(teacher)) {
        return fail(
          res,
          409,
          'The teacher who set this paper cannot invigilate it.'
        );
      }
    }

    // Overlap is checked in minutes across every other plan that day.
    const sameDay = await SeatingPlan.find({
      _id: { $ne: plan._id },
      examDate: plan.examDate,
      status: { $ne: 'cancelled' },
      'invigilators.teacher': teacher,
    }).select('startMinute endMinute startTime endTime hall.name');

    const clash = sameDay.find((other) => SeatingPlan.overlaps(other, plan));
    if (clash) {
      return fail(
        res,
        409,
        `That teacher is already invigilating ${clash.hall.name} at ${clash.startTime}-${clash.endTime}.`
      );
    }

    plan.invigilators.push({
      teacher,
      teacherName,
      role: wantedRole,
      assignedAt: new Date(),
      assignedBy: req.user._id,
    });

    plan.recordAudit('invigilator:assigned', req.user, `${teacherName || teacher} as ${wantedRole}`);
    await plan.save();

    return res.status(201).json({
      success: true,
      message: `Assigned as ${wantedRole}.`,
      data: plan.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to assign the invigilator');
  }
};

/**
 * DELETE /api/seating/plans/:id/invigilators/:invigilatorId
 */
exports.removeInvigilator = async (req, res) => {
  try {
    const { id, invigilatorId } = req.params;
    if (!isValidId(id) || !isValidId(invigilatorId)) {
      return fail(res, 400, 'Invalid plan or invigilator id.');
    }

    const plan = await SeatingPlan.findById(id);
    if (!plan) return fail(res, 404, 'Seating plan not found.');
    if (!canManage(plan, req.user)) {
      return fail(res, 403, 'You can only staff plans you created.');
    }
    if (['locked', 'cancelled'].includes(plan.status)) {
      return fail(res, 409, `A ${plan.status} plan cannot be re-staffed.`);
    }

    const entry = plan.invigilators.id(invigilatorId);
    if (!entry) return fail(res, 404, 'That invigilator is not on this plan.');

    const { teacherName, role } = entry;
    entry.deleteOne();

    plan.recordAudit('invigilator:removed', req.user, `${teacherName || invigilatorId} (${role})`);
    await plan.save();

    return res.status(200).json({
      success: true,
      message: 'Invigilator removed.',
      data: plan.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to remove the invigilator');
  }
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * PATCH /api/seating/plans/:id/publish
 */
exports.publishPlan = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid plan id.');

    const plan = await SeatingPlan.findById(req.params.id);
    if (!plan) return fail(res, 404, 'Seating plan not found.');
    if (!canManage(plan, req.user)) {
      return fail(res, 403, 'You can only publish plans you created.');
    }

    const unallocated = plan.candidates.filter((candidate) => !candidate.seatLabel);
    if (unallocated.length > 0) {
      return fail(
        res,
        409,
        `${unallocated.length} candidate(s) have no seat. Allocate before publishing.`
      );
    }
    if (!plan.chiefInvigilator()) {
      return fail(res, 409, 'Assign a chief invigilator before publishing.');
    }

    try {
      plan.moveTo('published', req.user);
    } catch (error) {
      if (error.code === 'ILLEGAL_TRANSITION') return fail(res, 409, error.message);
      throw error;
    }

    plan.publishedAt = new Date();
    await plan.save();

    return res.status(200).json({
      success: true,
      message: 'Plan published. Students can now look up their seat.',
      data: plan.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to publish the plan');
  }
};

/**
 * PATCH /api/seating/plans/:id/lock
 * A locked plan is what was actually used on the day, so nothing may change.
 */
exports.lockPlan = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid plan id.');

    const plan = await SeatingPlan.findById(req.params.id);
    if (!plan) return fail(res, 404, 'Seating plan not found.');
    if (!canManage(plan, req.user)) {
      return fail(res, 403, 'You can only lock plans you created.');
    }

    try {
      plan.moveTo('locked', req.user, req.body.detail || null);
    } catch (error) {
      if (error.code === 'ILLEGAL_TRANSITION') return fail(res, 409, error.message);
      throw error;
    }

    plan.lockedAt = new Date();
    await plan.save();

    return res.status(200).json({
      success: true,
      message: 'Plan locked. It is now the record of what happened.',
      data: plan.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to lock the plan');
  }
};

/**
 * PATCH /api/seating/plans/:id/cancel
 */
exports.cancelPlan = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid plan id.');

    const { reason } = req.body;
    if (!reason || !reason.trim()) {
      return fail(res, 400, 'A cancellation reason is required.');
    }

    const plan = await SeatingPlan.findById(req.params.id);
    if (!plan) return fail(res, 404, 'Seating plan not found.');
    if (!canManage(plan, req.user)) {
      return fail(res, 403, 'You can only cancel plans you created.');
    }

    try {
      plan.moveTo('cancelled', req.user, reason.trim());
    } catch (error) {
      if (error.code === 'ILLEGAL_TRANSITION') return fail(res, 409, error.message);
      throw error;
    }

    await plan.save();

    return res.status(200).json({
      success: true,
      message: 'Plan cancelled.',
      data: plan.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to cancel the plan');
  }
};

/**
 * PATCH /api/seating/plans/:id/attendance
 * Marks candidates present, absent or debarred on the day. Allowed on a
 * published plan and refused once locked.
 */
exports.recordAttendance = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid plan id.');

    const { rollNumber, status } = req.body;
    if (!['present', 'absent', 'debarred'].includes(status)) {
      return fail(res, 400, "status must be 'present', 'absent' or 'debarred'.");
    }

    const plan = await SeatingPlan.findById(req.params.id);
    if (!plan) return fail(res, 404, 'Seating plan not found.');
    if (!canManage(plan, req.user) && !plan.hasInvigilator(req.user._id)) {
      return fail(res, 403, 'Only the plan owner or an assigned invigilator can mark attendance.');
    }
    if (plan.status !== 'published') {
      return fail(res, 409, `Attendance can only be marked on a published plan (this one is ${plan.status}).`);
    }

    const candidate = plan.candidates.find(
      (entry) => entry.rollNumber === String(rollNumber || '').trim().toUpperCase()
    );
    if (!candidate) return fail(res, 404, 'That roll number is not on this plan.');

    candidate.status = status;
    plan.recordAudit('attendance:marked', req.user, `${candidate.rollNumber} ${status}`);
    await plan.save();

    return res.status(200).json({
      success: true,
      message: `${candidate.rollNumber} marked ${status}.`,
      data: plan.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to record attendance');
  }
};

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * GET /api/seating/my-seat
 *
 * A student sees their own seat and only once the plan is published. An
 * unpublished plan is a draft, and a plan that told every student where every
 * other student was sitting would defeat the point of drawing one up.
 */
exports.getMySeat = async (req, res) => {
  try {
    const plans = await SeatingPlan.find({
      status: 'published',
      'candidates.student': req.user._id,
    }).sort({ examDate: 1, startMinute: 1 });

    const seats = plans.map((plan) => {
      const own = plan.candidates.find(
        (candidate) => String(candidate.student) === String(req.user._id)
      );
      return {
        planId: plan._id,
        examTitle: plan.examTitle,
        examDate: plan.examDate,
        startTime: plan.startTime,
        endTime: plan.endTime,
        hallName: plan.hall.name,
        seatLabel: own ? own.seatLabel : null,
        rollNumber: own ? own.rollNumber : null,
        subjectCode: own ? own.subjectCode : null,
      };
    });

    return res.status(200).json({ success: true, count: seats.length, data: seats });
  } catch (error) {
    return serverError(res, error, 'Failed to look up your seat');
  }
};

/**
 * GET /api/seating/stats
 */
exports.getStats = async (req, res) => {
  try {
    const plans = await SeatingPlan.find({}).select(
      'status candidates hall adjacencyViolations invigilators'
    );

    const stats = {
      totalPlans: plans.length,
      draft: 0,
      allocated: 0,
      published: 0,
      locked: 0,
      cancelled: 0,
      totalCandidates: 0,
      seatedCandidates: 0,
      totalSeats: 0,
      unresolvedAdjacencies: 0,
      plansWithoutChief: 0,
    };

    plans.forEach((plan) => {
      stats[plan.status] += 1;
      if (plan.status === 'cancelled') return;

      stats.totalCandidates += plan.candidates.length;
      stats.seatedCandidates += plan.candidates.filter((c) => c.seatLabel).length;
      stats.totalSeats += plan.capacity;
      stats.unresolvedAdjacencies +=
        (plan.adjacencyViolations?.horizontal || 0) +
        (plan.adjacencyViolations?.vertical || 0);
      if (!plan.invigilators.some((entry) => entry.role === 'chief')) {
        stats.plansWithoutChief += 1;
      }
    });

    stats.hallUtilisation =
      stats.totalSeats > 0
        ? Math.round((stats.seatedCandidates / stats.totalSeats) * 100)
        : 0;

    return res.status(200).json({ success: true, stats });
  } catch (error) {
    return serverError(res, error, 'Failed to compute seating statistics');
  }
};
