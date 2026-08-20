const mongoose = require('mongoose');
const TrainingRecord = require('../models/TrainingRecord');

/**
 * Staff professional development.
 *
 * The endpoint this module exists for is `getExpiring`: every mandatory
 * certification in the school lapsing inside a window, soonest first. It is one
 * query because `expiresOn` is a derived, indexed field rather than something
 * somebody has to remember to look at.
 *
 * Nothing here adds planned hours to completed hours. That is the spreadsheet
 * habit the status column exists to break.
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
 * The fields a member of staff may set. Approval, completion and everything on
 * the certificate that is derived are all server-owned.
 */
function sanitiseRecord(body) {
  return {
    academicYear: body.academicYear,
    title: body.title,
    provider: body.provider,
    type: body.type,
    competency: body.competency,
    startDate: body.startDate,
    endDate: body.endDate,
    creditHours: body.creditHours === undefined ? undefined : Number(body.creditHours),
    isMandatory: body.isMandatory,
    reflection: body.reflection,
    evidenceNote: body.evidenceNote,
  };
}

/**
 * Load a record and check the caller may act on it. A member of staff reaches
 * their own; an admin reaches anybody's.
 */
async function loadRecordFor(id, user, { ownerOnly = false } = {}) {
  if (!isValidId(id)) return { status: 400, message: 'Invalid record id' };

  const record = await TrainingRecord.findById(id);
  if (!record) return { status: 404, message: 'Training record not found' };

  const owns = record.isOwnedBy(user);
  if (ownerOnly && !owns) {
    return { status: 403, message: 'This record belongs to another member of staff' };
  }
  if (!owns && !isAdmin(user)) {
    return { status: 403, message: 'This record belongs to another member of staff' };
  }

  return { record };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * POST /api/staff-training/records
 */
exports.createRecord = async (req, res) => {
  try {
    let staff = req.user._id;
    if (req.body.staff && String(req.body.staff) !== String(req.user._id)) {
      if (!isAdmin(req.user)) {
        return fail(res, 403, 'Only an admin can create a record for another member of staff');
      }
      if (!isValidId(req.body.staff)) return fail(res, 400, 'Invalid staff id');
      staff = req.body.staff;
    }

    const record = new TrainingRecord({
      ...sanitiseRecord(req.body),
      staff,
      status: 'planned',
    });

    record.recordHistory('created', req.user._id);
    await record.save();

    return res.status(201).json({
      success: true,
      message: record.isMandatory
        ? 'Record created and sent for approval'
        : 'Record created',
      data: record.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to create training record');
  }
};

/**
 * GET /api/staff-training/records/mine
 */
exports.getMyRecords = async (req, res) => {
  try {
    const filter = { staff: req.user._id };
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;
    if (req.query.status) filter.status = req.query.status;

    const records = await TrainingRecord.find(filter).sort({ startDate: -1 });

    return res.status(200).json({
      success: true,
      count: records.length,
      data: records.map((record) => record.toRow()),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load your training records');
  }
};

/**
 * GET /api/staff-training/records
 */
exports.listRecords = async (req, res) => {
  try {
    const { staff, academicYear, competency, status, type, approvalStatus } = req.query;

    const filter = {};
    if (academicYear) filter.academicYear = academicYear;
    if (competency) filter.competency = competency;
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (approvalStatus) filter.approvalStatus = approvalStatus;
    if (staff) {
      if (!isValidId(staff)) return fail(res, 400, 'Invalid staff id');
      filter.staff = staff;
    }

    const records = await TrainingRecord.find(filter)
      .populate('staff', 'name email role')
      .sort({ createdAt: -1 })
      .limit(500);

    return res.status(200).json({
      success: true,
      count: records.length,
      data: records.map((record) => ({
        ...record.toRow(),
        staff: record.staff,
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load training records');
  }
};

/**
 * GET /api/staff-training/records/:id
 */
exports.getRecord = async (req, res) => {
  try {
    const loaded = await loadRecordFor(req.params.id, req.user);
    if (!loaded.record) return fail(res, loaded.status, loaded.message);

    await loaded.record.populate('staff', 'name email');

    return res.status(200).json({
      success: true,
      data: {
        ...loaded.record.toRow(),
        staff: loaded.record.staff,
        reflection: loaded.record.reflection,
        evidenceNote: loaded.record.evidenceNote,
        history: loaded.record.history,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load training record');
  }
};

/**
 * PATCH /api/staff-training/records/:id
 */
exports.updateRecord = async (req, res) => {
  try {
    const loaded = await loadRecordFor(req.params.id, req.user, { ownerOnly: true });
    if (!loaded.record) return fail(res, loaded.status, loaded.message);

    const record = loaded.record;
    if (!record.isEditable()) {
      return fail(res, 409, `A ${record.status} record cannot be edited`);
    }

    const updates = sanitiseRecord(req.body);
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) record[key] = value;
    }

    record.recordHistory('edited', req.user._id);
    await record.save();

    return res.status(200).json({
      success: true,
      message: 'Record updated',
      data: record.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update training record');
  }
};

/**
 * PATCH /api/staff-training/records/:id/start
 */
exports.startRecord = async (req, res) => {
  try {
    const loaded = await loadRecordFor(req.params.id, req.user, { ownerOnly: true });
    if (!loaded.record) return fail(res, loaded.status, loaded.message);

    const record = loaded.record;
    if (record.status !== 'planned') {
      return fail(res, 409, `A ${record.status} record cannot be started`);
    }

    record.status = 'in-progress';
    record.recordHistory('started', req.user._id);
    await record.save();

    return res.status(200).json({
      success: true,
      message: 'Training under way',
      data: record.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to start training record');
  }
};

/**
 * PATCH /api/staff-training/records/:id/complete
 *
 * The refusals live on the model so this handler cannot forget one. Completing
 * before the end date is the claim the annual total is built on, and it is
 * refused rather than warned about.
 */
exports.completeRecord = async (req, res) => {
  try {
    const loaded = await loadRecordFor(req.params.id, req.user, { ownerOnly: true });
    if (!loaded.record) return fail(res, loaded.status, loaded.message);

    const record = loaded.record;
    const blocked = record.completabilityError();
    if (blocked) return fail(res, 409, blocked);

    record.status = 'completed';
    record.completedAt = new Date();
    if (req.body.reflection !== undefined) record.reflection = req.body.reflection;
    record.recordHistory('completed', req.user._id, req.body.note);

    await record.save();

    return res.status(200).json({
      success: true,
      message: `${record.creditHours} hours now count toward your annual total`,
      data: record.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to complete training record');
  }
};

/**
 * PATCH /api/staff-training/records/:id/cancel
 *
 * A withdrawn course stays in the year's record. Cancelling is a status, not a
 * delete.
 */
exports.cancelRecord = async (req, res) => {
  try {
    const loaded = await loadRecordFor(req.params.id, req.user);
    if (!loaded.record) return fail(res, loaded.status, loaded.message);

    const record = loaded.record;
    if (record.status === 'completed') {
      return fail(res, 409, 'A completed record cannot be cancelled');
    }
    if (record.status === 'cancelled') {
      return fail(res, 409, 'This record is already cancelled');
    }

    record.status = 'cancelled';
    record.recordHistory('cancelled', req.user._id, req.body.reason);
    await record.save();

    return res.status(200).json({
      success: true,
      message: 'Record cancelled',
      data: record.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to cancel training record');
  }
};

/**
 * PATCH /api/staff-training/records/:id/certificate
 *
 * `expiresOn` is not in the payload and cannot be. It is computed from the
 * issue date and the validity period in the model's pre-validate hook.
 */
exports.setCertificate = async (req, res) => {
  try {
    const loaded = await loadRecordFor(req.params.id, req.user, { ownerOnly: true });
    if (!loaded.record) return fail(res, loaded.status, loaded.message);

    const record = loaded.record;
    if (record.status === 'cancelled') {
      return fail(res, 409, 'This record was cancelled');
    }

    const { reference, issuedOn, validMonths, fileUrl } = req.body;
    if (!issuedOn) return fail(res, 400, 'The certificate issue date is required');

    record.certificate.reference = reference;
    record.certificate.issuedOn = issuedOn;
    record.certificate.fileUrl = fileUrl;
    // Undefined lets the model apply the competency default rather than
    // carrying forward whatever was there before.
    record.certificate.validMonths =
      validMonths === undefined || validMonths === null || validMonths === ''
        ? undefined
        : Number(validMonths);

    record.recordHistory('certificate recorded', req.user._id, reference);
    await record.save();

    const expiry = record.expiryState();

    return res.status(200).json({
      success: true,
      message: expiry.expiresOn
        ? `Certificate recorded. It expires on ${expiry.expiresOn}.`
        : 'Certificate recorded',
      data: record.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record certificate');
  }
};

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

/**
 * PATCH /api/staff-training/records/:id/request-approval
 */
exports.requestApproval = async (req, res) => {
  try {
    const loaded = await loadRecordFor(req.params.id, req.user, { ownerOnly: true });
    if (!loaded.record) return fail(res, loaded.status, loaded.message);

    const record = loaded.record;
    if (record.approvalStatus === 'approved') {
      return fail(res, 409, 'This record is already approved');
    }

    record.isMandatory = true;
    record.approvalStatus = 'pending';
    record.declineReason = undefined;
    record.recordHistory('approval requested', req.user._id);
    await record.save();

    return res.status(200).json({
      success: true,
      message: 'Sent for approval',
      data: record.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to request approval');
  }
};

/**
 * PATCH /api/staff-training/records/:id/approve
 *
 * An admin cannot approve their own record. Holding the role is necessary but
 * not sufficient.
 */
exports.approveRecord = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid record id');

    const record = await TrainingRecord.findById(id);
    if (!record) return fail(res, 404, 'Training record not found');

    if (record.approvalStatus === 'approved') {
      return res.status(200).json({
        success: true,
        message: 'This record was already approved',
        data: record.toRow(),
      });
    }

    const blocked = record.approvabilityErrorFor(req.user);
    if (blocked) return fail(res, 409, blocked);

    record.approvalStatus = 'approved';
    record.approvedBy = req.user._id;
    record.approvedAt = new Date();
    record.recordHistory('approved', req.user._id, req.body.note);

    await record.save();

    return res.status(200).json({
      success: true,
      message: 'Record approved',
      data: record.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to approve record');
  }
};

/**
 * PATCH /api/staff-training/records/:id/decline
 */
exports.declineRecord = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid record id');

    const record = await TrainingRecord.findById(id);
    if (!record) return fail(res, 404, 'Training record not found');

    const reason = req.body.reason;
    if (!reason || String(reason).trim().length < 5) {
      return fail(res, 400, 'A reason of at least 5 characters is required');
    }

    const blocked = record.approvabilityErrorFor(req.user);
    if (blocked) return fail(res, 409, blocked);

    record.approvalStatus = 'declined';
    record.declineReason = reason;
    record.recordHistory('declined', req.user._id, reason);

    await record.save();

    return res.status(200).json({
      success: true,
      message: 'Record declined',
      data: record.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to decline record');
  }
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

async function summaryFor(staffId, academicYear) {
  const filter = { staff: staffId };
  if (academicYear) filter.academicYear = academicYear;

  const records = await TrainingRecord.find(filter);
  return TrainingRecord.buildSummary(records);
}

/**
 * GET /api/staff-training/summary/mine
 */
exports.getMySummary = async (req, res) => {
  try {
    const summary = await summaryFor(req.user._id, req.query.academicYear);
    return res.status(200).json({ success: true, data: summary });
  } catch (error) {
    return serverError(res, error, 'Failed to build your training summary');
  }
};

/**
 * GET /api/staff-training/summary/:staffId
 */
exports.getStaffSummary = async (req, res) => {
  try {
    const { staffId } = req.params;
    if (!isValidId(staffId)) return fail(res, 400, 'Invalid staff id');

    const summary = await summaryFor(staffId, req.query.academicYear);
    return res.status(200).json({ success: true, data: summary });
  } catch (error) {
    return serverError(res, error, 'Failed to build training summary');
  }
};

/**
 * GET /api/staff-training/expiring?withinDays=90
 *
 * The compliance report that does not exist in a spreadsheet. One indexed
 * query, because the expiry date is derived and stored rather than left in
 * somebody's memory.
 */
exports.getExpiring = async (req, res) => {
  try {
    const withinDays = Number(req.query.withinDays) || TrainingRecord.EXPIRING_SOON_DAYS;
    if (withinDays < 0 || withinDays > 1095) {
      return fail(res, 400, 'withinDays must be between 0 and 1095');
    }

    const today = TrainingRecord.todayKey();
    const cutoff = new Date(Date.parse(`${today}T00:00:00`) + withinDays * 86400000);
    const cutoffKey = [
      cutoff.getFullYear(),
      String(cutoff.getMonth() + 1).padStart(2, '0'),
      String(cutoff.getDate()).padStart(2, '0'),
    ].join('-');

    const filter = {
      status: 'completed',
      'certificate.expiresOn': { $ne: null, $lte: cutoffKey },
    };
    if (req.query.mandatoryOnly === 'true') filter.isMandatory = true;

    const records = await TrainingRecord.find(filter)
      .populate('staff', 'name email role')
      .sort({ 'certificate.expiresOn': 1 })
      .limit(300);

    const rows = records.map((record) => ({
      ...record.toRow(today),
      staff: record.staff,
    }));

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: {
        withinDays,
        cutoff: cutoffKey,
        expired: rows.filter((row) => row.expiry.state === 'expired'),
        expiringSoon: rows.filter((row) => row.expiry.state !== 'expired'),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build the expiry report');
  }
};

/**
 * GET /api/staff-training/stats
 */
exports.getStats = async (req, res) => {
  try {
    const filter = {};
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;

    const records = await TrainingRecord.find(filter);
    const today = TrainingRecord.todayKey();

    const byStatus = {};
    for (const status of TrainingRecord.RECORD_STATUSES) byStatus[status] = 0;

    const byCompetency = {};
    let completedHours = 0;
    let pendingApprovals = 0;
    let expired = 0;
    let expiringSoon = 0;

    for (const record of records) {
      byStatus[record.status] = (byStatus[record.status] || 0) + 1;

      if (record.countsTowardTotal()) {
        completedHours += record.creditHours;
        byCompetency[record.competency] =
          (byCompetency[record.competency] || 0) + record.creditHours;
      }

      if (record.approvalStatus === 'pending') pendingApprovals += 1;

      const expiry = record.expiryState(today);
      if (expiry.state === 'expired') expired += 1;
      else if (expiry.state === 'expiring-soon') expiringSoon += 1;
    }

    return res.status(200).json({
      success: true,
      data: {
        total: records.length,
        byStatus,
        byCompetency,
        completedHours: Math.round(completedHours * 10) / 10,
        pendingApprovals,
        expiredCertifications: expired,
        expiringSoonCertifications: expiringSoon,
        annualRequirement: TrainingRecord.DEFAULT_ANNUAL_REQUIREMENT,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build training statistics');
  }
};

/**
 * GET /api/staff-training/meta
 */
exports.getMeta = async (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      types: TrainingRecord.TRAINING_TYPES,
      competencies: TrainingRecord.COMPETENCIES,
      statuses: TrainingRecord.RECORD_STATUSES,
      approvalStatuses: TrainingRecord.APPROVAL_STATUSES,
      defaultValidMonths: TrainingRecord.DEFAULT_VALID_MONTHS,
      expiringSoonDays: TrainingRecord.EXPIRING_SOON_DAYS,
      annualRequirement: TrainingRecord.DEFAULT_ANNUAL_REQUIREMENT,
      isAdmin: isAdmin(req.user),
    },
  });
};
