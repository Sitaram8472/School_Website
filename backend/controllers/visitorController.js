const mongoose = require('mongoose');
const VisitorPass = require('../models/VisitorPass');
const User = require('../models/User');

/**
 * Gate: visitor passes and student gate passes.
 *
 * The three functions worth reading are `checkIn`, `checkOut` and `reconcile`.
 * Between them they are the difference between a register that can answer "who
 * is on campus right now" and one that only looks like it can.
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
  return user.role === 'admin' || user.role === 'staff';
}

/**
 * A pass the caller is allowed to look at: staff see everything, a teacher sees
 * visits they are hosting.
 */
function mayView(pass, user) {
  if (isStaff(user)) return true;
  return String(pass.host) === String(user._id);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * POST /api/visitors/passes
 *
 * Registers a visitor arriving, or a student due to be collected. Both start
 * `expected` and need an approval before anybody moves.
 */
exports.createPass = async (req, res) => {
  try {
    const {
      passType,
      visitorName,
      visitorPhone,
      visitorEmail,
      organisation,
      idProofType,
      idNumber,
      vehicleNumber,
      accompanyingCount,
      hostId,
      studentId,
      guardianName,
      guardianRelation,
      purpose,
      purposeNote,
      expectedDurationMinutes,
    } = req.body;

    if (!VisitorPass.PASS_TYPES.includes(passType)) {
      return fail(res, 400, `passType must be one of: ${VisitorPass.PASS_TYPES.join(', ')}`);
    }

    const pass = new VisitorPass({
      passType,
      purpose,
      purposeNote,
      expectedDurationMinutes,
      vehicleNumber,
      accompanyingCount,
      status: 'expected',
      approvalStatus: 'pending',
    });

    if (passType === 'visitor') {
      if (!visitorName || !String(visitorName).trim()) {
        return fail(res, 400, 'A visitor name is required.');
      }
      if (!isValidId(hostId)) {
        return fail(res, 400, 'A valid hostId is required — somebody has to be expecting them.');
      }

      const host = await User.findById(hostId).select('name role');
      if (!host) return fail(res, 404, 'The named host does not exist.');
      if (host.role === 'student') {
        return fail(res, 400, 'A student cannot host a visitor.');
      }

      pass.visitorName = visitorName;
      pass.visitorPhone = visitorPhone;
      pass.visitorEmail = visitorEmail;
      pass.organisation = organisation;
      pass.idProofType = idProofType;
      pass.host = host._id;
      pass.hostName = host.name;

      // The full ID never lands in the document — only its masked tail and the
      // keyed hash the uniqueness index is built on.
      if (idNumber) {
        pass.idNumberMasked = VisitorPass.maskId(idNumber);
        pass.subjectKey = VisitorPass.makeSubjectKey(idNumber);
      }
    } else {
      if (!isValidId(studentId)) {
        return fail(res, 400, 'A valid studentId is required for a gate pass.');
      }
      if (!guardianName || !String(guardianName).trim()) {
        return fail(res, 400, 'The name of the person collecting the student is required.');
      }

      const student = await User.findById(studentId).select('name role className');
      if (!student) return fail(res, 404, 'Student not found.');
      if (student.role !== 'student') {
        return fail(res, 400, 'A gate pass is for a student leaving campus.');
      }

      pass.student = student._id;
      pass.studentName = student.name;
      pass.className = student.className || '';
      pass.guardianName = guardianName;
      pass.guardianRelation = guardianRelation;
      pass.subjectKey = VisitorPass.makeSubjectKey(String(student._id));
    }

    pass.recordMovement('registered', req.user, purposeNote || '');
    await pass.save();

    return res.status(201).json({
      success: true,
      message:
        passType === 'gate-pass'
          ? `Gate pass ${pass.badgeNumber} raised. It needs staff approval before the student may leave.`
          : `Pass ${pass.badgeNumber} raised. ${pass.hostName} has to approve the visit.`,
      data: pass.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    if (error.code === 11000) {
      return fail(
        res,
        409,
        'That person already has an open pass on campus. Check them out before raising another.'
      );
    }
    return serverError(res, error, 'Failed to register the pass');
  }
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * GET /api/visitors/passes
 */
exports.getPasses = async (req, res) => {
  try {
    const { passType, status, approvalStatus, purpose, search, overstayedOnly, date } = req.query;

    const filter = {};
    if (passType) filter.passType = passType;
    if (status) filter.status = status;
    if (approvalStatus) filter.approvalStatus = approvalStatus;
    if (purpose) filter.purpose = purpose;

    if (search) {
      const term = { $regex: String(search).trim(), $options: 'i' };
      filter.$or = [
        { visitorName: term },
        { studentName: term },
        { guardianName: term },
        { badgeNumber: term },
        { organisation: term },
      ];
    }

    if (date) {
      const start = new Date(`${date}T00:00:00.000Z`);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      filter.createdAt = { $gte: start, $lt: end };
    }

    let passes = await VisitorPass.find(filter).sort({ createdAt: -1 }).limit(400);

    // Overstay is derived from the clock, so it cannot be a query filter without
    // duplicating the rule in two places. Filtering after the read keeps one
    // definition of what "overstayed" means.
    if (overstayedOnly === 'true') {
      passes = passes.filter((pass) => pass.isOverstayed);
    }

    return res.status(200).json({
      success: true,
      count: passes.length,
      data: passes.map((pass) => pass.redactFor(req.user)),
      vocabulary: {
        purposes: VisitorPass.VISIT_PURPOSES,
        idProofTypes: VisitorPass.ID_PROOF_TYPES,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch passes');
  }
};

/**
 * GET /api/visitors/passes/on-campus
 *
 * The evacuation list. One indexed lookup, always current, which is the entire
 * reason this module was worth building — the paper register cannot answer this
 * question at the moment anybody needs it answered.
 */
exports.getOnCampus = async (req, res) => {
  try {
    const passes = await VisitorPass.find({ status: 'checked-in' }).sort({ checkInAt: 1 });

    const headcount = passes.reduce(
      (total, pass) => total + 1 + (pass.accompanyingCount || 0),
      0
    );

    return res.status(200).json({
      success: true,
      count: passes.length,
      headcount,
      overstayed: passes.filter((pass) => pass.isOverstayed).length,
      data: passes.map((pass) => ({
        ...pass.redactFor(req.user),
        durationMinutes: pass.durationMinutes,
        isOverstayed: pass.isOverstayed,
        minutesOverstayed: pass.minutesOverstayed,
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the on-campus roll');
  }
};

/**
 * GET /api/visitors/passes/:id
 */
exports.getPass = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid pass id.');

    const pass = await VisitorPass.findById(req.params.id);
    if (!pass) return fail(res, 404, 'Pass not found.');
    if (!mayView(pass, req.user)) {
      return fail(res, 403, 'You can only view visits you are hosting.');
    }

    return res.status(200).json({
      success: true,
      data: {
        ...pass.redactFor(req.user),
        durationMinutes: pass.durationMinutes,
        isOverstayed: pass.isOverstayed,
      },
      unavailableReason: pass.checkInError(),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the pass');
  }
};

/**
 * GET /api/visitors/my-approvals
 * What a teacher is being asked to approve. Nothing else.
 */
exports.getMyApprovals = async (req, res) => {
  try {
    const passes = await VisitorPass.find({
      host: req.user._id,
      approvalStatus: 'pending',
      status: { $in: ['expected', 'checked-in'] },
    }).sort({ createdAt: 1 });

    return res.status(200).json({
      success: true,
      count: passes.length,
      data: passes.map((pass) => pass.redactFor(req.user)),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch your pending approvals');
  }
};

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

/**
 * PATCH /api/visitors/passes/:id/approve
 *
 * For a visitor pass, only the named host or an admin. For a gate pass, any
 * member of staff — this is the check that a child is released to somebody who
 * is supposed to have them, and it is the reason the module has an approval
 * step at all.
 */
exports.approvePass = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid pass id.');

    const { decision, note } = req.body;
    if (!['approved', 'rejected'].includes(decision)) {
      return fail(res, 400, "decision must be 'approved' or 'rejected'.");
    }
    if (decision === 'rejected' && (!note || !String(note).trim())) {
      return fail(res, 400, 'A reason is required when refusing a pass.');
    }

    const pass = await VisitorPass.findById(req.params.id);
    if (!pass) return fail(res, 404, 'Pass not found.');

    const isHost = String(pass.host) === String(req.user._id);
    const permitted =
      pass.passType === 'gate-pass' ? isStaff(req.user) : isHost || req.user.role === 'admin';

    if (!permitted) {
      return fail(
        res,
        403,
        pass.passType === 'gate-pass'
          ? 'Only school staff can authorise a student leaving campus.'
          : 'Only the host can approve their own visitor.'
      );
    }

    if (pass.approvalStatus !== 'pending') {
      return fail(res, 409, `This pass was already ${pass.approvalStatus}.`);
    }
    if (['cancelled', 'checked-out', 'auto-closed'].includes(pass.status)) {
      return fail(res, 409, `This pass is ${pass.status}.`);
    }

    const updated = await VisitorPass.findOneAndUpdate(
      { _id: pass._id, approvalStatus: 'pending' },
      {
        $set: {
          approvalStatus: decision,
          approvedBy: req.user._id,
          approvedByName: req.user.name || '',
          approvedAt: new Date(),
          approvalNote: note ? String(note).trim() : '',
        },
        $push: {
          movements: {
            action: decision === 'approved' ? 'approved' : 'refused',
            by: req.user._id,
            byName: req.user.name || '',
            note: note ? String(note).trim() : '',
            at: new Date(),
          },
        },
      },
      { new: true }
    );

    if (!updated) return fail(res, 409, 'This pass was decided while you were looking at it.');

    return res.status(200).json({
      success: true,
      message: decision === 'approved' ? 'Approved.' : 'Refused.',
      data: updated.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to record the approval');
  }
};

/**
 * PATCH /api/visitors/passes/:id/check-in
 *
 * The guard on duplicates is the unique partial index on `subjectKey`, not the
 * check above it: two gate terminals scanning the same person at the same
 * moment would both read "not currently in" and both write. The index rejects
 * the loser with a duplicate-key error, which is translated below into
 * something the person at the desk can act on.
 */
exports.checkIn = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid pass id.');

    const pass = await VisitorPass.findById(req.params.id);
    if (!pass) return fail(res, 404, 'Pass not found.');

    const blocked = pass.checkInError();
    if (blocked) return fail(res, 409, blocked);

    const now = new Date();

    const updated = await VisitorPass.findOneAndUpdate(
      {
        _id: pass._id,
        status: 'expected',
        approvalStatus: 'approved',
      },
      {
        $set: {
          status: 'checked-in',
          checkInAt: now,
          checkedInBy: req.user._id,
          securityNotes: req.body.securityNotes || pass.securityNotes,
        },
        $push: {
          movements: {
            action: 'checked-in',
            by: req.user._id,
            byName: req.user.name || '',
            note: req.body.securityNotes || '',
            at: now,
          },
        },
      },
      { new: true }
    );

    if (!updated) {
      const current = await VisitorPass.findById(pass._id);
      return fail(
        res,
        409,
        current ? current.checkInError() || 'This pass changed while checking in.' : 'Pass not found.'
      );
    }

    return res.status(200).json({
      success: true,
      message: `${updated.visitorName || updated.studentName} checked in on badge ${updated.badgeNumber}.`,
      data: updated.redactFor(req.user),
    });
  } catch (error) {
    if (error.code === 11000) {
      return fail(
        res,
        409,
        'That person already has an open pass on campus. Close the existing one first.'
      );
    }
    return serverError(res, error, 'Failed to check the pass in');
  }
};

/**
 * PATCH /api/visitors/passes/:id/check-out
 *
 * Filtered on the pass still being `checked-in`, so a double-tap on the gate
 * tablet matches nothing the second time and returns 409 rather than
 * overwriting `checkOutAt` and corrupting the recorded duration. A pass that
 * was never checked in cannot be checked out at all — otherwise the register
 * accumulates departures for arrivals that never happened.
 *
 * `subjectKey` is cleared in the same write. The uniqueness index is partial on
 * `status: 'checked-in'`, so this is belt and braces rather than strictly
 * required, but it means a closed pass carries no residual identifier.
 */
exports.checkOut = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid pass id.');

    const pass = await VisitorPass.findById(req.params.id);
    if (!pass) return fail(res, 404, 'Pass not found.');

    if (pass.status === 'expected') {
      return fail(res, 409, 'This pass was never checked in, so there is nothing to close.');
    }
    if (pass.status !== 'checked-in') {
      return fail(res, 409, `This pass is already ${pass.status}.`);
    }

    const now = new Date();

    const updated = await VisitorPass.findOneAndUpdate(
      { _id: pass._id, status: 'checked-in' },
      {
        $set: {
          status: 'checked-out',
          checkOutAt: now,
          checkedOutBy: req.user._id,
          subjectKey: null,
        },
        $push: {
          movements: {
            action: 'checked-out',
            by: req.user._id,
            byName: req.user.name || '',
            note: req.body.note || '',
            at: now,
          },
        },
      },
      { new: true }
    );

    if (!updated) return fail(res, 409, 'This pass was already closed.');

    return res.status(200).json({
      success: true,
      message: `Checked out after ${updated.durationMinutes} minute(s).`,
      data: updated.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to check the pass out');
  }
};

/**
 * PATCH /api/visitors/passes/:id/cancel
 * For a visit that is not going to happen. A pass that is already on campus has
 * to be checked out instead — cancelling it would remove a person from the roll
 * who is still inside the building.
 */
exports.cancelPass = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid pass id.');

    const pass = await VisitorPass.findById(req.params.id);
    if (!pass) return fail(res, 404, 'Pass not found.');

    if (pass.status === 'checked-in') {
      return fail(
        res,
        409,
        'This person is on campus. Check them out rather than cancelling the pass.'
      );
    }
    if (pass.status !== 'expected') {
      return fail(res, 409, `This pass is already ${pass.status}.`);
    }

    pass.recordMovement('cancelled', req.user, req.body.reason || '');
    pass.status = 'cancelled';
    pass.subjectKey = null;
    await pass.save();

    return res.status(200).json({
      success: true,
      message: 'Pass cancelled.',
      data: pass.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to cancel the pass');
  }
};

/**
 * POST /api/visitors/passes/reconcile
 *
 * End of day: close passes that are still open well past their expected
 * departure, and mark them `auto-closed` rather than `checked-out`.
 *
 * That distinction is the whole point. "Checked out" means somebody watched
 * them leave; "auto-closed" means the school assumed it. A register that
 * records the second as the first is the paper register with a database
 * underneath, and its on-campus count drifts into fiction within a week.
 */
exports.reconcile = async (req, res) => {
  try {
    const graceMinutes = Number(req.body.graceMinutes ?? 120);
    if (!Number.isFinite(graceMinutes) || graceMinutes < 0) {
      return fail(res, 400, 'graceMinutes must be a non-negative number.');
    }

    const open = await VisitorPass.find({ status: 'checked-in' });

    const stale = open.filter((pass) => pass.minutesOverstayed > graceMinutes);

    if (stale.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'Nothing to reconcile — every open pass is still within its expected window.',
        closed: 0,
        stillOpen: open.length,
      });
    }

    const now = new Date();
    const note = `Auto-closed by end-of-day reconciliation; overstayed the expected departure by more than ${graceMinutes} minutes.`;

    const result = await VisitorPass.updateMany(
      { _id: { $in: stale.map((pass) => pass._id) }, status: 'checked-in' },
      {
        $set: {
          status: 'auto-closed',
          checkOutAt: now,
          checkedOutBy: req.user._id,
          subjectKey: null,
        },
        $push: {
          movements: {
            action: 'auto-closed',
            by: req.user._id,
            byName: req.user.name || '',
            note,
            at: now,
          },
        },
      }
    );

    return res.status(200).json({
      success: true,
      message: `${result.modifiedCount} pass(es) auto-closed. These were not observed leaving — they are recorded as assumed, not confirmed.`,
      closed: result.modifiedCount,
      stillOpen: open.length - result.modifiedCount,
      badges: stale.map((pass) => pass.badgeNumber),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to reconcile open passes');
  }
};

/**
 * GET /api/visitors/stats
 */
exports.getStats = async (req, res) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [open, recent] = await Promise.all([
      VisitorPass.find({ status: 'checked-in' }).select(
        'accompanyingCount checkInAt expectedDurationMinutes'
      ),
      VisitorPass.find({ createdAt: { $gte: since } }).select(
        'passType status approvalStatus purpose checkInAt checkOutAt'
      ),
    ]);

    const stats = {
      onCampusNow: open.length,
      headcountNow: open.reduce((total, pass) => total + 1 + (pass.accompanyingCount || 0), 0),
      overstayedNow: open.filter((pass) => pass.isOverstayed).length,
      last30Days: recent.length,
      visitors: 0,
      gatePasses: 0,
      checkedOut: 0,
      autoClosed: 0,
      cancelled: 0,
      refused: 0,
      awaitingApproval: 0,
    };

    const byPurpose = {};
    let durationSum = 0;
    let durationCount = 0;

    recent.forEach((pass) => {
      if (pass.passType === 'visitor') stats.visitors += 1;
      if (pass.passType === 'gate-pass') stats.gatePasses += 1;
      if (pass.status === 'checked-out') stats.checkedOut += 1;
      if (pass.status === 'auto-closed') stats.autoClosed += 1;
      if (pass.status === 'cancelled') stats.cancelled += 1;
      if (pass.approvalStatus === 'rejected') stats.refused += 1;
      if (pass.approvalStatus === 'pending' && pass.status === 'expected') {
        stats.awaitingApproval += 1;
      }

      byPurpose[pass.purpose] = (byPurpose[pass.purpose] || 0) + 1;

      if (pass.checkInAt && pass.checkOutAt) {
        durationSum += (pass.checkOutAt.getTime() - pass.checkInAt.getTime()) / 60000;
        durationCount += 1;
      }
    });

    stats.averageVisitMinutes = durationCount > 0 ? Math.round(durationSum / durationCount) : null;

    // The share of closures nobody actually witnessed. A high number here means
    // the gate is not being worked, and it is the one figure on this dashboard
    // that says something about the process rather than the visitors.
    const closed = stats.checkedOut + stats.autoClosed;
    stats.unobservedExitRate = closed > 0 ? Math.round((stats.autoClosed / closed) * 100) : null;

    stats.byPurpose = Object.entries(byPurpose)
      .map(([purpose, count]) => ({ purpose, count }))
      .sort((a, b) => b.count - a.count);

    return res.status(200).json({ success: true, stats });
  } catch (error) {
    return serverError(res, error, 'Failed to compute gate statistics');
  }
};
