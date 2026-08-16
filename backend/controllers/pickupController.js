const mongoose = require('mongoose');
const {
  PickupAuthorisation,
  ReleaseEvent,
  RELATIONSHIPS,
  AUTHORISATION_SCOPES,
  AUTHORISATION_STATUSES,
  ID_TYPES,
  RELEASE_TYPES,
  VERIFICATION_METHODS,
  RETURNING_TYPES,
  MAX_AUTHORISATIONS_PER_STUDENT,
  todayKey,
  timeKey,
} = require('../models/PickupAuthorisation');

/**
 * Authorised pickup and student release.
 *
 * Three handlers matter.
 *
 * `getCollectors` is the gate lookup: everybody who may collect this child
 * *right now*, with restricted names first and in red. Validity is computed at
 * the moment of the request, so the neighbour who was allowed for a week in
 * August is not allowed in February without anybody having to remember.
 *
 * `createRelease` refuses to record a release against an authorisation that is
 * not valid, and offers exactly one way past that: an override with a reason
 * and a named approver. The child goes home either way — the difference is
 * whether the school can say what happened.
 *
 * `getOpenReleases` is the reconciliation. Every child released today who has
 * not come back, overdue ones first.
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

function isStaff(user) {
  return user && ['teacher', 'staff', 'admin'].includes(user.role);
}

/**
 * Whether `user` is a parent of `studentId`.
 *
 * The `User` model in this repository does not yet carry a parent-to-child
 * link, so the check is: the requester raised the authorisation, or is named on
 * it as the guardian, or is the student themselves. It is deliberately narrow —
 * widening it later is a change to this one function rather than to every
 * handler.
 */
async function ownsStudent(user, studentId) {
  if (!user) return false;
  if (String(user._id) === String(studentId)) return true;

  const linked = await PickupAuthorisation.exists({
    student: studentId,
    $or: [{ requestedBy: user._id }, { guardianUser: user._id }],
  });
  return Boolean(linked);
}

/** The fields a requester may set. Status, approval and the code are ours. */
function sanitiseAuthorisation(body) {
  return {
    guardianName: body.guardianName,
    relationship: body.relationship,
    guardianUser: body.guardianUser,
    phone: body.phone,
    altPhone: body.altPhone,
    photoUrl: body.photoUrl,
    idType: body.idType,
    idLastFour: body.idLastFour,
    scope: body.scope,
    validFrom: body.validFrom,
    validUntil: body.validUntil,
    daysOfWeek: Array.isArray(body.daysOfWeek) ? body.daysOfWeek.map(Number) : undefined,
    notBefore: body.notBefore,
    notAfter: body.notAfter,
    notes: body.notes,
  };
}

function stripUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/**
 * GET /api/pickup/meta
 */
exports.getMeta = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        relationships: RELATIONSHIPS,
        scopes: AUTHORISATION_SCOPES,
        statuses: AUTHORISATION_STATUSES,
        idTypes: ID_TYPES,
        releaseTypes: RELEASE_TYPES,
        returningTypes: RETURNING_TYPES,
        verificationMethods: VERIFICATION_METHODS,
        maxPerStudent: MAX_AUTHORISATIONS_PER_STUDENT,
        today: todayKey(),
        now: timeKey(),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load pickup reference data');
  }
};

// ---------------------------------------------------------------------------
// Authorisations
// ---------------------------------------------------------------------------

/**
 * POST /api/pickup/authorisations
 *
 * A parent asks; the school approves. A parent cannot approve their own new
 * collector — that is the whole point of the record, and a self-approved
 * authorisation is a note on a phone with extra steps.
 *
 * A restriction can only be raised by staff. A parent naming another adult as
 * barred is a safeguarding matter for a person, not a form.
 */
exports.createAuthorisation = async (req, res) => {
  try {
    const { student } = req.body;
    if (!isValidId(student)) return fail(res, 400, 'Invalid student id');

    if (!isStaff(req.user) && !(await ownsStudent(req.user, student))) {
      return fail(res, 403, 'That is not your child');
    }

    if (req.body.isRestricted && !isStaff(req.user)) {
      return fail(
        res,
        403,
        'Only the school can record that somebody must not collect a child'
      );
    }

    const existing = await PickupAuthorisation.countDocuments({
      student,
      status: { $in: ['pending', 'active', 'suspended'] },
    });
    if (existing >= MAX_AUTHORISATIONS_PER_STUDENT) {
      return fail(
        res,
        409,
        `A child cannot have more than ${MAX_AUTHORISATIONS_PER_STUDENT} live authorisations — revoke one first`
      );
    }

    const authorisation = new PickupAuthorisation({
      ...stripUndefined(sanitiseAuthorisation(req.body)),
      student,
      studentName: req.body.studentName,
      isRestricted: Boolean(req.body.isRestricted),
      restrictionNote: req.body.restrictionNote,
      requestedBy: req.user._id,
      status: 'pending',
    });

    // Staff raising a restriction are not making a request that needs
    // approving; a barred person is barred from the moment it is written down.
    if (authorisation.isRestricted) {
      authorisation.status = 'active';
      authorisation.approvedBy = req.user._id;
      authorisation.approvedAt = new Date();
    }

    authorisation.recordHistory(
      authorisation.isRestricted ? 'restriction-recorded' : 'requested',
      req.user._id,
      req.body.restrictionNote
    );
    await authorisation.save();

    return res.status(201).json({
      success: true,
      message: authorisation.isRestricted
        ? 'Restriction recorded — this person will be refused at the gate'
        : 'Requested. The school has to approve it before it can be used.',
      data: authorisation.toOwnerRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record that authorisation');
  }
};

/**
 * GET /api/pickup/authorisations/mine
 */
exports.getMyAuthorisations = async (req, res) => {
  try {
    const authorisations = await PickupAuthorisation.find({
      $or: [{ requestedBy: req.user._id }, { guardianUser: req.user._id }],
    })
      .populate('student', 'name email')
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: authorisations.length,
      data: authorisations.map((authorisation) => ({
        ...authorisation.toOwnerRow(),
        student: authorisation.student,
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load your authorisations');
  }
};

/**
 * GET /api/pickup/authorisations
 */
exports.listAuthorisations = async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.student && isValidId(req.query.student)) {
      filter.student = req.query.student;
    }
    if (req.query.restricted === 'true') filter.isRestricted = true;

    const authorisations = await PickupAuthorisation.find(filter)
      .populate('student', 'name email')
      .sort({ isRestricted: -1, createdAt: -1 })
      .limit(Math.min(Number(req.query.limit) || 200, 500));

    return res.status(200).json({
      success: true,
      count: authorisations.length,
      data: authorisations.map((authorisation) => ({
        ...authorisation.toGateRow(),
        student: authorisation.student,
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load authorisations');
  }
};

/**
 * GET /api/pickup/authorisations/pending
 */
exports.getPendingAuthorisations = async (req, res) => {
  try {
    const authorisations = await PickupAuthorisation.find({ status: 'pending' })
      .populate('student', 'name email')
      .populate('requestedBy', 'name email')
      .sort({ createdAt: 1 });

    return res.status(200).json({
      success: true,
      count: authorisations.length,
      data: authorisations.map((authorisation) => ({
        ...authorisation.toGateRow(),
        student: authorisation.student,
        requestedBy: authorisation.requestedBy,
        validFrom: authorisation.validFrom,
        validUntil: authorisation.validUntil,
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the approval queue');
  }
};

/**
 * GET /api/pickup/authorisations/:id
 */
exports.getAuthorisation = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid authorisation id');

    const authorisation = await PickupAuthorisation.findById(id).populate(
      'student',
      'name email'
    );
    if (!authorisation) return fail(res, 404, 'Authorisation not found');

    const owns =
      String(authorisation.requestedBy) === String(req.user._id) ||
      String(authorisation.guardianUser) === String(req.user._id);

    if (!owns && !isStaff(req.user)) {
      return fail(res, 403, 'That authorisation is not yours');
    }

    return res.status(200).json({
      success: true,
      data: {
        ...(owns ? authorisation.toOwnerRow() : authorisation.toGateRow()),
        student: authorisation.student,
        history: isStaff(req.user) ? authorisation.history : undefined,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load that authorisation');
  }
};

/**
 * PATCH /api/pickup/authorisations/:id
 */
exports.updateAuthorisation = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid authorisation id');

    const authorisation = await PickupAuthorisation.findById(id);
    if (!authorisation) return fail(res, 404, 'Authorisation not found');

    const owns = String(authorisation.requestedBy) === String(req.user._id);
    if (!owns && !isStaff(req.user)) {
      return fail(res, 403, 'That authorisation is not yours');
    }
    if (owns && !isStaff(req.user) && authorisation.status !== 'pending') {
      return fail(
        res,
        409,
        'An approved authorisation can only be changed by the school — ask for a new one instead'
      );
    }
    if (['revoked', 'expired'].includes(authorisation.status)) {
      return fail(res, 409, `A ${authorisation.status} authorisation cannot be edited`);
    }

    Object.assign(authorisation, stripUndefined(sanitiseAuthorisation(req.body)));

    // Editing the window after approval re-opens it for approval. A permission
    // that silently widens itself is not a permission anybody granted.
    if (authorisation.status === 'active' && !isStaff(req.user)) {
      authorisation.status = 'pending';
      authorisation.approvedBy = null;
      authorisation.approvedAt = null;
    }

    authorisation.recordHistory('edited', req.user._id, req.body.note);
    await authorisation.save();

    return res.status(200).json({
      success: true,
      message: 'Updated',
      data: authorisation.toOwnerRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update that authorisation');
  }
};

/**
 * PATCH /api/pickup/authorisations/:id/approve
 *
 * Approval issues the verification code. A code that exists before somebody has
 * checked the person is a code for an unchecked person.
 */
exports.approveAuthorisation = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid authorisation id');

    const authorisation = await PickupAuthorisation.findById(id);
    if (!authorisation) return fail(res, 404, 'Authorisation not found');
    if (authorisation.isRestricted) {
      return fail(res, 409, 'A restriction is not a permission and cannot be approved');
    }
    if (authorisation.status === 'active') {
      return fail(res, 409, 'That authorisation is already active');
    }
    if (['revoked', 'expired'].includes(authorisation.status)) {
      return fail(res, 409, `A ${authorisation.status} authorisation cannot be approved`);
    }
    if (String(authorisation.requestedBy) === String(req.user._id) && !isAdmin(req.user)) {
      return fail(res, 403, 'You cannot approve an authorisation you requested yourself');
    }

    authorisation.status = 'active';
    authorisation.approvedBy = req.user._id;
    authorisation.approvedAt = new Date();
    const code = authorisation.reissueCode();

    authorisation.recordHistory('approved', req.user._id, req.body.note);
    await authorisation.save();

    return res.status(200).json({
      success: true,
      message: `Approved. The verification code is ${code}.`,
      data: authorisation.toOwnerRow(),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to approve that authorisation');
  }
};

/**
 * PATCH /api/pickup/authorisations/:id/suspend
 */
exports.suspendAuthorisation = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid authorisation id');
    if (!req.body.reason || !String(req.body.reason).trim()) {
      return fail(res, 400, 'A suspension needs a reason');
    }

    const authorisation = await PickupAuthorisation.findById(id);
    if (!authorisation) return fail(res, 404, 'Authorisation not found');
    if (['revoked', 'expired'].includes(authorisation.status)) {
      return fail(res, 409, `A ${authorisation.status} authorisation cannot be suspended`);
    }

    authorisation.status = 'suspended';
    authorisation.suspendedReason = req.body.reason;
    authorisation.recordHistory('suspended', req.user._id, req.body.reason);
    await authorisation.save();

    return res.status(200).json({
      success: true,
      message: 'Suspended',
      data: authorisation.toGateRow(),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to suspend that authorisation');
  }
};

/**
 * PATCH /api/pickup/authorisations/:id/revoke
 *
 * Revocation is permanent. A revoked authorisation is never reactivated — a new
 * one is created — so the trail of who could collect a child, and when, cannot
 * be rewritten after the fact.
 */
exports.revokeAuthorisation = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid authorisation id');
    if (!req.body.reason || !String(req.body.reason).trim()) {
      return fail(res, 400, 'A revocation needs a reason');
    }

    const authorisation = await PickupAuthorisation.findById(id);
    if (!authorisation) return fail(res, 404, 'Authorisation not found');
    if (authorisation.status === 'revoked') {
      return fail(res, 409, 'That authorisation is already revoked');
    }

    authorisation.status = 'revoked';
    authorisation.revokedBy = req.user._id;
    authorisation.revokedAt = new Date();
    authorisation.revokeReason = req.body.reason;
    authorisation.verificationCode = null;

    authorisation.recordHistory('revoked', req.user._id, req.body.reason);
    await authorisation.save();

    return res.status(200).json({
      success: true,
      message: 'Revoked. It cannot be reactivated — raise a new one if needed.',
      data: authorisation.toGateRow(),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to revoke that authorisation');
  }
};

/**
 * POST /api/pickup/authorisations/:id/code
 */
exports.reissueCode = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid authorisation id');

    const authorisation = await PickupAuthorisation.findById(id);
    if (!authorisation) return fail(res, 404, 'Authorisation not found');

    const owns =
      String(authorisation.requestedBy) === String(req.user._id) ||
      String(authorisation.guardianUser) === String(req.user._id);
    if (!owns && !isStaff(req.user)) {
      return fail(res, 403, 'That authorisation is not yours');
    }
    if (authorisation.status !== 'active') {
      return fail(res, 409, 'Only an active authorisation has a code');
    }

    const code = authorisation.reissueCode();
    authorisation.recordHistory('code-reissued', req.user._id);
    await authorisation.save();

    return res.status(200).json({
      success: true,
      message: 'A new code has been issued; the previous one no longer works',
      data: { verificationCode: code, codeIssuedAt: authorisation.codeIssuedAt },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to reissue that code');
  }
};

/**
 * POST /api/pickup/authorisations/sweep
 *
 * Materialise expiry. `hasLapsed()` already tells the truth on every read; this
 * only makes the stored status agree with it, so a human reading a list sees
 * what the checks see. Running it twice changes nothing.
 */
exports.sweepExpired = async (req, res) => {
  try {
    const today = todayKey();
    const candidates = await PickupAuthorisation.find({
      status: { $in: ['active', 'suspended', 'pending'] },
      validUntil: { $ne: null, $lt: today },
      isRestricted: false,
    });

    let expired = 0;
    for (const authorisation of candidates) {
      if (!authorisation.hasLapsed(today)) continue;
      authorisation.status = 'expired';
      authorisation.verificationCode = null;
      authorisation.recordHistory(
        'expired',
        req.user._id,
        `Lapsed on ${authorisation.validUntil}`
      );
      await authorisation.save();
      expired += 1;
    }

    return res.status(200).json({
      success: true,
      message: `${expired} authorisation(s) marked expired`,
      data: { checked: candidates.length, expired, today },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to sweep expired authorisations');
  }
};

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * GET /api/pickup/students/:studentId/collectors
 *
 * The gate lookup. Restricted names come first, because hiding them is how they
 * get missed, and every row carries the reason it is or is not usable right now.
 */
exports.getCollectors = async (req, res) => {
  try {
    const { studentId } = req.params;
    if (!isValidId(studentId)) return fail(res, 400, 'Invalid student id');

    const date = req.query.date || todayKey();
    const time = req.query.time || timeKey();

    const authorisations = await PickupAuthorisation.find({
      student: studentId,
      status: { $ne: 'revoked' },
    }).sort({ isRestricted: -1, guardianName: 1 });

    const rows = authorisations.map((authorisation) =>
      authorisation.toGateRow(date, time)
    );

    const restricted = rows.filter((row) => row.isRestricted);
    const valid = rows.filter((row) => !row.isRestricted && row.validity.valid);
    const unusable = rows.filter((row) => !row.isRestricted && !row.validity.valid);

    const openReleases = await ReleaseEvent.find({
      student: studentId,
      status: 'open',
    }).sort({ releasedAt: -1 });

    return res.status(200).json({
      success: true,
      data: {
        date,
        time,
        restricted,
        valid,
        unusable,
        hasRestrictions: restricted.length > 0,
        openReleases: openReleases.map((release) => release.toRow()),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to look that student up');
  }
};

/**
 * POST /api/pickup/releases
 *
 * Recording that a child left.
 *
 * A release names the authorisation it was made under, and an authorisation
 * that is not valid right now cannot be named. The one way past that is an
 * override, which costs a reason and a named approver — because the child is
 * going home either way, and the only question is whether the school can say
 * what happened.
 */
exports.createRelease = async (req, res) => {
  try {
    const { student, type, verifiedBy } = req.body;
    if (!isValidId(student)) return fail(res, 400, 'Invalid student id');

    const date = req.body.date || todayKey();
    const time = req.body.time || timeKey();

    let authorisation = null;
    let collectedByName = req.body.collectedByName;
    let relationship = req.body.relationship;

    if (verifiedBy !== 'override') {
      if (!isValidId(req.body.authorisation)) {
        return fail(
          res,
          400,
          'Name the authorisation this release was made under, or record it as an override'
        );
      }

      authorisation = await PickupAuthorisation.findById(req.body.authorisation);
      if (!authorisation) return fail(res, 404, 'Authorisation not found');
      if (String(authorisation.student) !== String(student)) {
        return fail(res, 409, 'That authorisation belongs to a different child');
      }

      const validity = authorisation.validityAt(date, time);
      if (!validity.valid) {
        // The refusal names the reason, so the person at the gate knows whether
        // to call the office or reach for an override.
        return fail(res, 409, `Refused: ${validity.reason}`, {
          state: validity.state,
          isRestricted: authorisation.isRestricted,
        });
      }

      if (verifiedBy === 'code') {
        const supplied = String(req.body.verificationCode || '')
          .trim()
          .toUpperCase();
        if (!supplied || supplied !== authorisation.verificationCode) {
          return fail(res, 403, 'That verification code does not match');
        }
      }

      collectedByName = collectedByName || authorisation.guardianName;
      relationship = relationship || authorisation.relationship;
    }

    const release = new ReleaseEvent({
      student,
      studentName: req.body.studentName,
      authorisation: authorisation ? authorisation._id : null,
      collectedByName,
      relationship,
      type,
      date,
      releasedAt: new Date(),
      releasedBy: req.user._id,
      verifiedBy,
      overrideReason: req.body.overrideReason,
      overrideApprovedBy: req.body.overrideApprovedBy,
      expectedReturn: req.body.expectedReturn,
      notes: req.body.notes,
    });

    await release.save();

    if (authorisation) {
      authorisation.recordHistory('used', req.user._id, `${type} on ${date} at ${time}`);
      await authorisation.save();
    }

    return res.status(201).json({
      success: true,
      message:
        release.status === 'open'
          ? `Released. This stays open until somebody records ${collectedByName ? 'the return' : 'a return'}.`
          : 'Released',
      data: release.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record that release');
  }
};

/**
 * GET /api/pickup/releases/today
 */
exports.getTodaysReleases = async (req, res) => {
  try {
    const date = req.query.date || todayKey();

    const releases = await ReleaseEvent.find({ date })
      .populate('student', 'name email')
      .populate('releasedBy', 'name')
      .sort({ releasedAt: -1 });

    return res.status(200).json({
      success: true,
      count: releases.length,
      data: releases.map((release) => ({
        ...release.toRow(),
        student: release.student,
        releasedBy: release.releasedBy,
      })),
    });
  } catch (error) {
    return serverError(res, error, "Failed to load today's releases");
  }
};

/**
 * GET /api/pickup/releases/open
 *
 * The reconciliation: every child who left and has not come back, overdue
 * first. This query is the difference between knowing a child is out and
 * finding out at 5pm when a parent calls.
 */
exports.getOpenReleases = async (req, res) => {
  try {
    const releases = await ReleaseEvent.find({ status: 'open' })
      .populate('student', 'name email')
      .populate('releasedBy', 'name')
      .sort({ date: 1, releasedAt: 1 });

    const now = new Date();
    const rows = releases.map((release) => ({
      ...release.toRow(now),
      student: release.student,
      releasedBy: release.releasedBy,
    }));

    rows.sort((a, b) => Number(b.isOverdue) - Number(a.isOverdue));

    return res.status(200).json({
      success: true,
      count: rows.length,
      overdueCount: rows.filter((row) => row.isOverdue).length,
      data: rows,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load open collections');
  }
};

/**
 * GET /api/pickup/releases/mine
 */
exports.getMyReleases = async (req, res) => {
  try {
    const mine = await PickupAuthorisation.find({
      $or: [{ requestedBy: req.user._id }, { guardianUser: req.user._id }],
    }).distinct('student');

    const students = [...new Set([...mine.map(String), String(req.user._id)])];

    const releases = await ReleaseEvent.find({ student: { $in: students } })
      .populate('student', 'name')
      .sort({ releasedAt: -1 })
      .limit(100);

    return res.status(200).json({
      success: true,
      count: releases.length,
      data: releases.map((release) => ({
        ...release.toRow(),
        student: release.student,
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load your collection history');
  }
};

/**
 * PATCH /api/pickup/releases/:id/return
 */
exports.recordReturn = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid release id');

    const release = await ReleaseEvent.findById(id);
    if (!release) return fail(res, 404, 'Release not found');
    if (release.status !== 'open') {
      return fail(res, 409, 'That collection is not open');
    }

    release.returnedAt = new Date();
    release.returnRecordedBy = req.user._id;
    if (req.body.notes) release.notes = req.body.notes;
    await release.save();

    return res.status(200).json({
      success: true,
      message: 'Return recorded',
      data: release.toRow(),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to record that return');
  }
};

/**
 * GET /api/pickup/releases/overrides
 *
 * The Monday report. Every release made without a valid authorisation, with the
 * reason and the person who approved it. The gap between the rule and the car
 * park, in one list.
 */
exports.getOverrides = async (req, res) => {
  try {
    const from = req.query.from || null;
    const filter = { verifiedBy: 'override' };
    if (from) filter.date = { $gte: from };

    const releases = await ReleaseEvent.find(filter)
      .populate('student', 'name email')
      .populate('releasedBy', 'name')
      .populate('overrideApprovedBy', 'name')
      .sort({ date: -1, releasedAt: -1 })
      .limit(Math.min(Number(req.query.limit) || 100, 300));

    return res.status(200).json({
      success: true,
      count: releases.length,
      data: releases.map((release) => ({
        ...release.toRow(),
        student: release.student,
        releasedBy: release.releasedBy,
        overrideApprovedBy: release.overrideApprovedBy,
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the override report');
  }
};

/**
 * GET /api/pickup/stats
 */
exports.getStats = async (req, res) => {
  try {
    const today = todayKey();

    const [authorisations, releases] = await Promise.all([
      PickupAuthorisation.find({}),
      ReleaseEvent.find({ date: today }),
    ]);

    const byStatus = {};
    let restricted = 0;
    let lapsedButActive = 0;

    for (const authorisation of authorisations) {
      byStatus[authorisation.status] = (byStatus[authorisation.status] || 0) + 1;
      if (authorisation.isRestricted) restricted += 1;
      if (authorisation.status === 'active' && authorisation.hasLapsed(today)) {
        lapsedButActive += 1;
      }
    }

    const byVerification = {};
    for (const release of releases) {
      byVerification[release.verifiedBy] = (byVerification[release.verifiedBy] || 0) + 1;
    }

    const open = await ReleaseEvent.countDocuments({ status: 'open' });

    return res.status(200).json({
      success: true,
      data: {
        today,
        authorisationCount: authorisations.length,
        byStatus,
        restricted,
        // Rows whose stored status disagrees with the derived truth. The checks
        // already ignore them; this is how many the sweep would tidy.
        lapsedButStillMarkedActive: lapsedButActive,
        releasesToday: releases.length,
        byVerification,
        overridesToday: byVerification.override || 0,
        openCollections: open,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build pickup statistics');
  }
};
