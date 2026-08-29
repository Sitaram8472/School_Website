// backend/controllers/trainingCohortController.js
const mongoose = require('mongoose');
const TrainingCohort = require('../models/TrainingCohort');
const User = require('../models/User');

/**
 * Scheduled runs of training courses, with seats.
 *
 * Everything that takes or frees a chair goes through a guarded atomic update
 * rather than through a read-modify-save on the document. `seatsTaken` is never
 * incremented by reading it and adding one: two people pressing enrol on the
 * twenty-fourth chair within the same tick is the exact failure this module
 * exists to prevent, and a check-then-write cannot prevent it.
 *
 * A null result from one of those updates is not an error. It means somebody
 * else took the seat, and the honest answer to that is a waitlist place, not a
 * 500.
 */

const handleError = (res, err, message = 'Server error') => {
  console.error('[training-cohorts]', err);
  return res.status(500).json({ success: false, message, error: err.message });
};

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const getPagination = (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  return { page, limit, skip: (page - 1) * limit };
};

const isAdmin = (user) => user && user.role === 'admin';

const isFacilitator = (cohort, user) =>
  isAdmin(user) || (cohort.facilitator && String(cohort.facilitator) === String(user._id));

const publicCohort = (cohort, viewer) => {
  const mine = viewer ? cohort.findEnrolment(viewer._id) : null;

  return {
    _id: cohort._id,
    title: cohort.title,
    code: cohort.code,
    provider: cohort.provider,
    description: cohort.description,
    type: cohort.type,
    competency: cohort.competency,
    academicYear: cohort.academicYear,
    startDate: cohort.startDate,
    endDate: cohort.endDate,
    startTime: cohort.startTime,
    endTime: cohort.endTime,
    venue: cohort.venue,
    mode: cohort.mode,
    creditHours: cohort.creditHours,
    isMandatory: cohort.isMandatory,
    mandatoryFor: cohort.mandatoryFor,
    seatCapacity: cohort.seatCapacity,
    seatsTaken: cohort.seatsTaken,
    seatsLeft: Math.max(0, cohort.seatCapacity - cohort.seatsTaken),
    waitlistCapacity: cohort.waitlistCapacity,
    enrolmentOpensOn: cohort.enrolmentOpensOn,
    enrolmentClosesOn: cohort.enrolmentClosesOn,
    withdrawalCutoffHours: cohort.withdrawalCutoffHours,
    status: cohort.status,
    facilitator: cohort.facilitator,
    facilitatorName: cohort.facilitatorName,
    cancelReason: cohort.cancelReason,
    tally: cohort.tally(),
    // Everything a button needs to know before it is pressed.
    enrolmentError: cohort.enrolmentError(),
    nextWaitlistPlace: cohort.nextWaitlistPlace(),
    lateWithdrawalNow: cohort.isLateWithdrawal(),
    myEnrolment: mine
      ? {
          state: mine.state,
          position: mine.state === 'waitlisted' ? mine.position : null,
          queuePlace:
            mine.state === 'waitlisted'
              ? cohort.waitlist().findIndex((row) => String(row.staff) === String(viewer._id)) + 1
              : null,
          joinedAt: mine.joinedAt,
          creditAwarded: mine.creditAwarded,
        }
      : null,
    createdAt: cohort.createdAt,
  };
};

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

exports.getCohortMeta = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        statuses: TrainingCohort.COHORT_STATUSES,
        enrolmentStates: TrainingCohort.ENROLMENT_STATES,
        types: TrainingCohort.TRAINING_TYPES,
        competencies: TrainingCohort.COMPETENCIES,
        modes: TrainingCohort.MODES,
        maxSeats: TrainingCohort.MAX_SEATS,
        defaultWithdrawalCutoffHours: TrainingCohort.DEFAULT_WITHDRAWAL_CUTOFF_HOURS,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load cohort reference data');
  }
};

// ---------------------------------------------------------------------------
// Running a cohort
// ---------------------------------------------------------------------------

exports.createCohort = async (req, res) => {
  try {
    const payload = { ...req.body };
    delete payload.seatsTaken;
    delete payload.enrolments;
    delete payload.positionCounter;

    if (Array.isArray(payload.mandatoryFor)) {
      payload.mandatoryFor = payload.mandatoryFor.map((tag) =>
        typeof tag === 'string' ? { tag } : tag
      );
    }

    const cohort = new TrainingCohort({
      ...payload,
      seatsTaken: 0,
      status: payload.status === 'open' ? 'open' : 'draft',
      createdBy: req.user._id,
      createdByName: req.user.name || '',
    });

    cohort.log('created', req.user, `${cohort.seatCapacity} seat(s)`);

    try {
      await cohort.save();
    } catch (saveErr) {
      if (saveErr.code === 11000) {
        return res
          .status(409)
          .json({ success: false, message: 'A cohort with that code already exists' });
      }
      if (saveErr.name === 'ValidationError') {
        return res.status(400).json({ success: false, message: saveErr.message });
      }
      throw saveErr;
    }

    return res.status(201).json({
      success: true,
      message: 'Cohort created',
      data: publicCohort(cohort, req.user),
    });
  } catch (err) {
    return handleError(res, err, 'Could not create the cohort');
  }
};

exports.updateCohort = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid cohort id' });
    }

    const cohort = await TrainingCohort.findById(id);
    if (!cohort) {
      return res.status(404).json({ success: false, message: 'Cohort not found' });
    }

    if (!TrainingCohort.PLANNING_STATUSES.includes(cohort.status)) {
      return res.status(400).json({
        success: false,
        message: `A ${cohort.status} cohort cannot be changed`,
      });
    }

    const editable = [
      'title', 'provider', 'description', 'venue', 'mode', 'startTime', 'endTime',
      'seatCapacity', 'waitlistCapacity', 'enrolmentOpensOn', 'enrolmentClosesOn',
      'withdrawalCutoffHours', 'facilitator', 'facilitatorName', 'isMandatory',
    ];

    editable.forEach((field) => {
      if (req.body[field] !== undefined) cohort[field] = req.body[field];
    });

    if (Array.isArray(req.body.mandatoryFor)) {
      cohort.mandatoryFor = req.body.mandatoryFor.map((tag) =>
        typeof tag === 'string' ? { tag } : tag
      );
    }

    cohort.log('updated', req.user);

    try {
      await cohort.save();
    } catch (saveErr) {
      if (saveErr.name === 'ValidationError') {
        return res.status(400).json({ success: false, message: saveErr.message });
      }
      throw saveErr;
    }

    return res.status(200).json({
      success: true,
      message: 'Cohort updated',
      data: publicCohort(cohort, req.user),
    });
  } catch (err) {
    return handleError(res, err, 'Could not update the cohort');
  }
};

exports.setStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid cohort id' });
    }
    if (!TrainingCohort.COHORT_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }
    if (status === 'cancelled') {
      return res
        .status(400)
        .json({ success: false, message: 'Use the cancel route, which requires a reason' });
    }

    const cohort = await TrainingCohort.findById(id);
    if (!cohort) {
      return res.status(404).json({ success: false, message: 'Cohort not found' });
    }

    if (cohort.status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'This cohort was cancelled' });
    }
    if (cohort.status === 'completed') {
      return res
        .status(400)
        .json({ success: false, message: 'A completed cohort cannot change status' });
    }

    const from = cohort.status;
    cohort.status = status;
    cohort.log('status', req.user, `${from} -> ${status}`);

    await cohort.save();

    return res.status(200).json({
      success: true,
      message: `Cohort is now ${status}`,
      data: publicCohort(cohort, req.user),
    });
  } catch (err) {
    return handleError(res, err, 'Could not change the status');
  }
};

exports.cancelCohort = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid cohort id' });
    }

    const { reason } = req.body;
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({
        success: false,
        message: 'A reason is required — people arranged their week around this',
      });
    }

    const cohort = await TrainingCohort.findById(id);
    if (!cohort) {
      return res.status(404).json({ success: false, message: 'Cohort not found' });
    }

    if (TrainingCohort.UNDER_WAY_STATUSES.includes(cohort.status)) {
      return res.status(400).json({
        success: false,
        message: `This cohort is ${cohort.status} and can no longer be cancelled`,
      });
    }

    cohort.status = 'cancelled';
    cohort.cancelReason = String(reason).trim();
    cohort.cancelledAt = new Date();
    cohort.log('cancelled', req.user, cohort.cancelReason);

    await cohort.save();

    return res.status(200).json({
      success: true,
      message: `Cancelled. ${cohort.tally().enrolled} enrolled and ${
        cohort.tally().waitlisted
      } waitlisted people were affected.`,
      data: publicCohort(cohort, req.user),
    });
  } catch (err) {
    return handleError(res, err, 'Could not cancel the cohort');
  }
};

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

/**
 * Take a seat, or join the queue.
 *
 * The seat is claimed with a guarded `findOneAndUpdate` whose filter carries
 * both the capacity and the identity: `seatsTaken` must still be below
 * `seatCapacity`, and this person must not already appear on the cohort. A null
 * result means one of those stopped being true between reading and writing,
 * which is the whole point of putting them in the filter.
 */
const seatOrQueue = async (cohortId, person, actor) => {
  const seated = await TrainingCohort.findOneAndUpdate(
    {
      _id: cohortId,
      status: 'open',
      $expr: { $lt: ['$seatsTaken', '$seatCapacity'] },
      'enrolments.staff': { $ne: person._id },
    },
    {
      $inc: { seatsTaken: 1 },
      $push: {
        enrolments: {
          staff: person._id,
          staffName: person.name || '',
          staffRole: person.role || '',
          department: person.department || '',
          state: 'enrolled',
          position: 0,
          joinedAt: new Date(),
          enrolledBy: actor._id,
        },
      },
    },
    { new: true }
  );

  if (seated) return { cohort: seated, state: 'enrolled' };

  // No seat. Take a queue place instead — from the counter, not from the array
  // length, because the array shrinks and the counter does not.
  const queued = await TrainingCohort.findOneAndUpdate(
    {
      _id: cohortId,
      status: { $in: ['open', 'full'] },
      'enrolments.staff': { $ne: person._id },
      $expr: { $lt: [{ $size: '$enrolments' }, { $add: ['$seatCapacity', '$waitlistCapacity'] }] },
    },
    { $inc: { positionCounter: 1 } },
    { new: true }
  );

  if (!queued) return { cohort: null, state: null };

  queued.enrolments.push({
    staff: person._id,
    staffName: person.name || '',
    staffRole: person.role || '',
    department: person.department || '',
    state: 'waitlisted',
    position: queued.positionCounter,
    joinedAt: new Date(),
    enrolledBy: actor._id,
  });

  await queued.save();

  return { cohort: queued, state: 'waitlisted' };
};

const doEnrol = async (req, res, person) => {
  const { id } = req.params;
  if (!isValidId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid cohort id' });
  }

  const cohort = await TrainingCohort.findById(id);
  if (!cohort) {
    return res.status(404).json({ success: false, message: 'Cohort not found' });
  }

  const blocked = cohort.enrolmentError();
  if (blocked) {
    return res.status(400).json({ success: false, message: blocked });
  }

  if (cohort.findEnrolment(person._id)) {
    return res.status(409).json({
      success: false,
      message: 'That person already has a place on this cohort',
      data: publicCohort(cohort, req.user),
    });
  }

  const { cohort: updated, state } = await seatOrQueue(cohort._id, person, req.user);

  if (!updated) {
    return res.status(409).json({
      success: false,
      message: 'The session and its waiting list are both full',
    });
  }

  // Keep the published status honest now the last chair has gone.
  if (updated.seatsTaken >= updated.seatCapacity && updated.status === 'open') {
    await TrainingCohort.updateOne(
      { _id: updated._id, status: 'open' },
      { $set: { status: 'full' } }
    );
  }

  const fresh = await TrainingCohort.findById(updated._id);
  fresh.log(
    state === 'enrolled' ? 'enrolled' : 'waitlisted',
    req.user,
    `${person.name || 'staff'}`
  );
  await fresh.save();

  const mine = fresh.findEnrolment(person._id);

  return res.status(201).json({
    success: true,
    message:
      state === 'enrolled'
        ? `Seat confirmed. ${Math.max(0, fresh.seatCapacity - fresh.seatsTaken)} left.`
        : `The session is full. Added to the waiting list at place ${
            fresh.waitlist().findIndex((row) => String(row.staff) === String(person._id)) + 1
          }.`,
    data: publicCohort(fresh, req.user),
    state: mine ? mine.state : null,
  });
};

exports.enrolSelf = async (req, res) => {
  try {
    return await doEnrol(req, res, req.user);
  } catch (err) {
    return handleError(res, err, 'Could not enrol you');
  }
};

exports.enrolOther = async (req, res) => {
  try {
    const { staffId } = req.params;
    if (!isValidId(staffId)) {
      return res.status(400).json({ success: false, message: 'Invalid staff id' });
    }

    const person = await User.findById(staffId);
    if (!person) {
      return res.status(404).json({ success: false, message: 'That person does not exist' });
    }

    return await doEnrol(req, res, person);
  } catch (err) {
    return handleError(res, err, 'Could not enrol that person');
  }
};

/**
 * Leave the cohort.
 *
 * A seated withdrawal frees a chair, so the counter comes down with a guard
 * that refuses to take it below zero. Inside the cutoff the withdrawal is
 * recorded as late, which is the difference between dropping out three weeks
 * before and dropping out two hours before a catered session.
 */
exports.withdraw = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid cohort id' });
    }

    const targetId = req.body.staffId && isAdmin(req.user) ? req.body.staffId : req.user._id;

    const cohort = await TrainingCohort.findById(id);
    if (!cohort) {
      return res.status(404).json({ success: false, message: 'Cohort not found' });
    }

    if (TrainingCohort.UNDER_WAY_STATUSES.includes(cohort.status)) {
      return res
        .status(400)
        .json({ success: false, message: 'This session has already run' });
    }

    const mine = cohort.findEnrolment(targetId);
    if (!mine) {
      return res
        .status(404)
        .json({ success: false, message: 'There is no place to give up on this cohort' });
    }

    const wasSeated = TrainingCohort.SEATED_STATES.includes(mine.state);
    const late = wasSeated && cohort.isLateWithdrawal();

    if (wasSeated) {
      const freed = await TrainingCohort.findOneAndUpdate(
        { _id: cohort._id, seatsTaken: { $gt: 0 } },
        { $inc: { seatsTaken: -1 } },
        { new: true }
      );

      if (!freed) {
        return res.status(409).json({
          success: false,
          message: 'The seat count is already at zero; reload and try again',
        });
      }
    }

    const fresh = await TrainingCohort.findById(cohort._id);
    const row = fresh.findEnrolment(targetId);

    row.state = 'withdrawn';
    row.withdrawnAt = new Date();
    row.withdrawReason = req.body.reason || '';
    row.lateWithdrawal = late;

    // A freed chair is not held open; it goes straight back on sale.
    if (fresh.status === 'full' && fresh.seatsTaken < fresh.seatCapacity) {
      fresh.status = 'open';
    }

    fresh.log('withdrawn', req.user, late ? 'inside the cutoff' : '');
    await fresh.save();

    return res.status(200).json({
      success: true,
      message: late
        ? 'Withdrawn. This was inside the cutoff, so it is recorded as a no-show.'
        : 'Withdrawn.',
      data: publicCohort(fresh, req.user),
    });
  } catch (err) {
    return handleError(res, err, 'Could not withdraw');
  }
};

/**
 * Move the longest-waiting person into a free chair.
 *
 * The seat is claimed with the same guarded update as a fresh enrolment, so a
 * promotion racing a walk-in cannot both win.
 */
exports.promote = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid cohort id' });
    }

    const cohort = await TrainingCohort.findById(id);
    if (!cohort) {
      return res.status(404).json({ success: false, message: 'Cohort not found' });
    }

    const queue = cohort.waitlist();
    if (queue.length === 0) {
      return res.status(400).json({ success: false, message: 'Nobody is waiting' });
    }

    if (cohort.seatsTaken >= cohort.seatCapacity) {
      return res.status(400).json({ success: false, message: 'There is no free seat' });
    }

    const next = queue[0];

    const claimed = await TrainingCohort.findOneAndUpdate(
      {
        _id: cohort._id,
        $expr: { $lt: ['$seatsTaken', '$seatCapacity'] },
        enrolments: { $elemMatch: { staff: next.staff, state: 'waitlisted' } },
      },
      {
        $inc: { seatsTaken: 1 },
        $set: {
          'enrolments.$[row].state': 'enrolled',
          'enrolments.$[row].promotedAt': new Date(),
        },
      },
      {
        new: true,
        arrayFilters: [{ 'row.staff': next.staff, 'row.state': 'waitlisted' }],
      }
    );

    if (!claimed) {
      return res.status(409).json({
        success: false,
        message: 'That seat went to somebody else; reload and try again',
      });
    }

    if (claimed.seatsTaken >= claimed.seatCapacity && claimed.status === 'open') {
      await TrainingCohort.updateOne({ _id: claimed._id }, { $set: { status: 'full' } });
    }

    const fresh = await TrainingCohort.findById(claimed._id);
    fresh.log('promoted', req.user, next.staffName);
    await fresh.save();

    return res.status(200).json({
      success: true,
      message: `${next.staffName || 'The next person waiting'} has been given the seat.`,
      data: publicCohort(fresh, req.user),
    });
  } catch (err) {
    return handleError(res, err, 'Could not promote from the waiting list');
  }
};

/**
 * Mark somebody present or absent, and award the credit.
 *
 * Credit is the cohort's own `creditHours`, applied here and nowhere else. A
 * completed cohort's register is frozen, so it cannot be quietly amended once
 * the hours have been counted.
 */
exports.markAttendance = async (req, res) => {
  try {
    const { id, staffId } = req.params;
    if (!isValidId(id) || !isValidId(staffId)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }

    const cohort = await TrainingCohort.findById(id);
    if (!cohort) {
      return res.status(404).json({ success: false, message: 'Cohort not found' });
    }

    if (!isFacilitator(cohort, req.user)) {
      return res.status(403).json({
        success: false,
        message: 'Only the facilitator or an admin may mark this register',
      });
    }

    if (cohort.status === 'completed') {
      return res.status(400).json({
        success: false,
        message: 'This register is closed; the credit has already been counted',
      });
    }

    if (!cohort.hasStarted) {
      return res
        .status(400)
        .json({ success: false, message: 'This session has not started yet' });
    }

    const row = cohort.enrolments.find(
      (entry) => String(entry.staff) === String(staffId) && entry.state !== 'withdrawn'
    );

    if (!row) {
      return res
        .status(404)
        .json({ success: false, message: 'That person does not hold a place on this cohort' });
    }

    if (row.state === 'waitlisted') {
      return res.status(400).json({
        success: false,
        message: 'That person is on the waiting list, not the register',
      });
    }

    const present = req.body.present !== false;

    row.state = present ? 'attended' : 'no-show';
    row.attendanceMarkedAt = new Date();
    row.attendanceMarkedBy = req.user._id;
    // Credit follows attendance, never enrolment. The figure the school reports
    // is then the number of hours people were actually in the room.
    row.creditAwarded = present ? cohort.creditHours : 0;

    cohort.log(present ? 'attended' : 'no-show', req.user, row.staffName);
    await cohort.save();

    return res.status(200).json({
      success: true,
      message: present
        ? `${row.staffName || 'Marked present'} — ${cohort.creditHours} credit hour(s) awarded.`
        : `${row.staffName || 'Marked absent'} — no credit awarded.`,
      data: publicCohort(cohort, req.user),
    });
  } catch (err) {
    return handleError(res, err, 'Could not mark attendance');
  }
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

exports.getCohorts = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = {};

    // A draft is the organiser's working copy.
    if (!isAdmin(req.user)) filter.status = { $ne: 'draft' };

    if (req.query.status && TrainingCohort.COHORT_STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (req.query.competency) filter.competency = req.query.competency;
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;
    if (req.query.mandatory === 'true') filter.isMandatory = true;

    const [cohorts, total] = await Promise.all([
      TrainingCohort.find(filter).sort({ startDate: 1 }).skip(skip).limit(limit),
      TrainingCohort.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      count: cohorts.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      data: cohorts.map((cohort) => publicCohort(cohort, req.user)),
    });
  } catch (err) {
    return handleError(res, err, 'Could not load cohorts');
  }
};

exports.getMyCohorts = async (req, res) => {
  try {
    const cohorts = await TrainingCohort.find({
      'enrolments.staff': req.user._id,
    }).sort({ startDate: -1 });

    return res.status(200).json({
      success: true,
      count: cohorts.length,
      data: cohorts.map((cohort) => publicCohort(cohort, req.user)),
    });
  } catch (err) {
    return handleError(res, err, 'Could not load your cohorts');
  }
};

exports.getCalendar = async (req, res) => {
  try {
    const from = req.query.from || new Date().toISOString().slice(0, 10);

    const cohorts = await TrainingCohort.find({
      startDate: { $gte: from },
      status: { $in: ['open', 'full', 'closed', 'running'] },
    })
      .sort({ startDate: 1 })
      .limit(100);

    return res.status(200).json({
      success: true,
      count: cohorts.length,
      data: cohorts.map((cohort) => ({
        _id: cohort._id,
        title: cohort.title,
        competency: cohort.competency,
        startDate: cohort.startDate,
        startTime: cohort.startTime,
        venue: cohort.venue,
        mode: cohort.mode,
        isMandatory: cohort.isMandatory,
        seatsLeft: Math.max(0, cohort.seatCapacity - cohort.seatsTaken),
        status: cohort.status,
      })),
    });
  } catch (err) {
    return handleError(res, err, 'Could not load the training calendar');
  }
};

exports.getCohort = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid cohort id' });
    }

    const cohort = await TrainingCohort.findById(id);
    if (!cohort) {
      return res.status(404).json({ success: false, message: 'Cohort not found' });
    }

    if (cohort.status === 'draft' && !isAdmin(req.user)) {
      return res.status(404).json({ success: false, message: 'Cohort not found' });
    }

    return res.status(200).json({ success: true, data: publicCohort(cohort, req.user) });
  } catch (err) {
    return handleError(res, err, 'Could not load the cohort');
  }
};

exports.getRegister = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid cohort id' });
    }

    const cohort = await TrainingCohort.findById(id);
    if (!cohort) {
      return res.status(404).json({ success: false, message: 'Cohort not found' });
    }

    if (!isFacilitator(cohort, req.user)) {
      return res
        .status(403)
        .json({ success: false, message: 'Only the facilitator or an admin may see the register' });
    }

    return res.status(200).json({
      success: true,
      data: {
        cohort: publicCohort(cohort, req.user),
        register: cohort.register(),
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load the register');
  }
};

/**
 * Everybody who has to be on this and is not.
 *
 * The report that makes mandatory training mean something. Without it,
 * `isMandatory` is a flag nobody can act on.
 */
exports.getMandatoryGap = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid cohort id' });
    }

    const cohort = await TrainingCohort.findById(id);
    if (!cohort) {
      return res.status(404).json({ success: false, message: 'Cohort not found' });
    }

    if (!cohort.isMandatory) {
      return res.status(400).json({
        success: false,
        message: 'This cohort is not mandatory, so there is no gap to report',
      });
    }

    const tags = cohort.mandatoryFor.map((row) => row.tag).filter(Boolean);
    const roleTags = tags.filter((tag) =>
      ['teacher', 'staff', 'admin'].includes(String(tag).toLowerCase())
    );

    const required = await User.find(
      roleTags.length > 0
        ? { role: { $in: roleTags.map((tag) => String(tag).toLowerCase()) } }
        : { role: { $in: ['teacher', 'staff', 'admin'] } }
    ).select('name email role');

    const covered = new Set(
      cohort.enrolments
        .filter((row) => row.state !== 'withdrawn')
        .map((row) => String(row.staff))
    );

    const missing = required.filter((person) => !covered.has(String(person._id)));

    return res.status(200).json({
      success: true,
      data: {
        cohortTitle: cohort.title,
        tags,
        requiredCount: required.length,
        enrolledCount: covered.size,
        missingCount: missing.length,
        seatsLeft: Math.max(0, cohort.seatCapacity - cohort.seatsTaken),
        // Said out loud, because a mandatory session with fewer chairs than
        // people is a fact somebody needs before the day.
        seatsShort: Math.max(0, missing.length - Math.max(0, cohort.seatCapacity - cohort.seatsTaken)),
        missing: missing.map((person) => ({
          _id: person._id,
          name: person.name,
          email: person.email,
          role: person.role,
        })),
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not build the mandatory gap report');
  }
};
