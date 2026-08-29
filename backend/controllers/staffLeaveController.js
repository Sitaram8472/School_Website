const mongoose = require('mongoose');
const StaffAbsence = require('../models/StaffAbsence');
const {
  StaffLeaveEntitlement,
  StaffLeaveRequest,
  LEAVE_TYPES,
  REQUEST_STATUSES,
  HALF_DAY_MARKERS,
  UNMETERED_TYPES,
  DEFAULT_ALLOWANCES,
  CERTIFICATE_THRESHOLD_DAYS,
  todayKey,
  toHalves,
} = require('../models/StaffLeave');

/**
 * Staff leave.
 *
 * Two endpoints carry the module. `getMyEntitlement` returns a balance that was
 * computed from the approved requests a moment ago rather than read from a
 * column, and `approveRequest` refuses to grant leave that is not there and
 * says by how much.
 *
 * The third thing worth reading is `approveRequest`'s tail: an approved request
 * that asked for cover creates the `StaffAbsence` rows itself, one per working
 * day, so the substitute board learns about the leave from the leave rather
 * than from somebody retyping it.
 */

// How reasons map onto the absence board's smaller vocabulary. Leave types the
// board has no word for arrive as `personal`, which is true and unrevealing —
// the cover board does not need to know somebody is on bereavement leave.
const ABSENCE_REASON_FOR_TYPE = {
  sick: 'sick',
  casual: 'personal',
  earned: 'personal',
  maternity: 'personal',
  paternity: 'personal',
  bereavement: 'personal',
  unpaid: 'personal',
  study: 'training',
  compensatory: 'personal',
};

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

/** The academic year a date falls in, on a July start. */
function academicYearFor(dateKey = todayKey()) {
  const [year, month] = dateKey.split('-').map(Number);
  const startYear = month >= 7 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** The year after this one, in the same notation. */
function nextAcademicYear(academicYear) {
  const startYear = Number(academicYear.split('-')[0]);
  if (!Number.isFinite(startYear)) return null;
  return `${startYear + 1}-${String((startYear + 2) % 100).padStart(2, '0')}`;
}

/**
 * The fields a member of staff may set on a request. Status, the decision, the
 * day count and the links to the cover board are all server-owned.
 */
function sanitiseRequest(body) {
  return {
    academicYear: body.academicYear,
    type: body.type,
    startDate: body.startDate,
    endDate: body.endDate,
    startHalf: body.startHalf,
    endHalf: body.endHalf,
    reason: body.reason,
    contactDuringLeave: body.contactDuringLeave,
    medicalCertificateRef: body.medicalCertificateRef,
    coverRequired: body.coverRequired,
    coverPeriods: Array.isArray(body.coverPeriods)
      ? body.coverPeriods.map((period) => ({
          dayOfWeek: Number(period.dayOfWeek),
          periodLabel: period.periodLabel,
          startTime: period.startTime,
          endTime: period.endTime,
          className: period.className,
          subject: period.subject,
          room: period.room,
          lessonPlan: period.lessonPlan,
        }))
      : undefined,
  };
}

function stripUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));
}

/**
 * The entitlement row for a person and year, created on first use.
 *
 * Creating it lazily matters: a school that has to seed a row for every member
 * of staff before anybody can book a day off is a school where the first leave
 * request fails for a reason nobody understands.
 */
async function ensureEntitlement(staffId, academicYear, actorId) {
  let entitlement = await StaffLeaveEntitlement.findOne({
    staff: staffId,
    academicYear,
  });
  if (entitlement) return entitlement;

  entitlement = new StaffLeaveEntitlement({
    staff: staffId,
    academicYear,
    allowances: DEFAULT_ALLOWANCES.map((allowance) => ({ ...allowance, carriedIn: 0 })),
  });
  entitlement.recordHistory('opened', actorId, 'Opened with the default allowances');

  try {
    await entitlement.save();
    return entitlement;
  } catch (error) {
    // Two requests raced to open the same row. The unique index caught it, so
    // read back the one that won rather than failing the request behind it.
    if (error && error.code === 11000) {
      return StaffLeaveEntitlement.findOne({ staff: staffId, academicYear });
    }
    throw error;
  }
}

/** Every request that could bear on a person's year, for balance and overlap. */
function loadRequestsFor(staffId, academicYear) {
  return StaffLeaveRequest.find({ staff: staffId, academicYear }).sort({ startDate: 1 });
}

/**
 * Load a request and check the caller may act on it. A member of staff reaches
 * their own; an admin reaches anybody's.
 */
async function loadRequestFor(id, user, { ownerOnly = false } = {}) {
  if (!isValidId(id)) return { status: 400, message: 'Invalid request id' };

  const request = await StaffLeaveRequest.findById(id);
  if (!request) return { status: 404, message: 'Leave request not found' };

  const owns = request.isOwnedBy(user);
  if (ownerOnly && !owns) {
    return { status: 403, message: 'This request belongs to another member of staff' };
  }
  if (!owns && !isAdmin(user)) {
    return { status: 403, message: 'This request belongs to another member of staff' };
  }

  return { request };
}

/**
 * Save a request with the holiday set attached, so the pre-validate hook counts
 * days against the calendar the school actually keeps.
 */
async function saveWithCalendar(request, entitlement) {
  request.$locals.nonWorkingDates = entitlement ? entitlement.nonWorkingDates : [];
  await request.save();
  return request;
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/**
 * GET /api/staff-leave/meta
 */
exports.getMeta = async (req, res) => {
  try {
    const currentYear = academicYearFor();
    return res.status(200).json({
      success: true,
      data: {
        leaveTypes: LEAVE_TYPES,
        unmeteredTypes: UNMETERED_TYPES,
        statuses: REQUEST_STATUSES,
        halfDayMarkers: HALF_DAY_MARKERS,
        defaultAllowances: DEFAULT_ALLOWANCES,
        certificateThresholdDays: CERTIFICATE_THRESHOLD_DAYS,
        currentAcademicYear: currentYear,
        nextAcademicYear: nextAcademicYear(currentYear),
        today: todayKey(),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load leave reference data');
  }
};

// ---------------------------------------------------------------------------
// Entitlement
// ---------------------------------------------------------------------------

/**
 * GET /api/staff-leave/entitlements/mine
 *
 * The balance, derived. Nothing on this response was stored as a total.
 */
exports.getMyEntitlement = async (req, res) => {
  try {
    const academicYear = req.query.academicYear || academicYearFor();
    const entitlement = await ensureEntitlement(req.user._id, academicYear, req.user._id);
    const requests = await loadRequestsFor(req.user._id, academicYear);

    return res.status(200).json({
      success: true,
      data: {
        entitlement: {
          _id: entitlement._id,
          staff: entitlement.staff,
          academicYear: entitlement.academicYear,
          allowances: entitlement.allowances,
          nonWorkingDates: entitlement.nonWorkingDates,
          isClosed: entitlement.isClosed,
        },
        ledger: entitlement.buildLedger(requests),
        requests: requests.map((request) => request.toRow()),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load your leave entitlement');
  }
};

/**
 * GET /api/staff-leave/entitlements
 */
exports.listEntitlements = async (req, res) => {
  try {
    const academicYear = req.query.academicYear || academicYearFor();

    const entitlements = await StaffLeaveEntitlement.find({ academicYear })
      .populate('staff', 'name email role')
      .sort({ createdAt: 1 });

    const requests = await StaffLeaveRequest.find({ academicYear });
    const byStaff = new Map();
    for (const request of requests) {
      const key = String(request.staff);
      if (!byStaff.has(key)) byStaff.set(key, []);
      byStaff.get(key).push(request);
    }

    const rows = entitlements.map((entitlement) => ({
      _id: entitlement._id,
      staff: entitlement.staff,
      academicYear: entitlement.academicYear,
      isClosed: entitlement.isClosed,
      ledger: entitlement.buildLedger(byStaff.get(String(entitlement.staff?._id)) || []),
    }));

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    return serverError(res, error, 'Failed to load entitlements');
  }
};

/**
 * GET /api/staff-leave/entitlements/:staffId
 */
exports.getStaffEntitlement = async (req, res) => {
  try {
    const { staffId } = req.params;
    if (!isValidId(staffId)) return fail(res, 400, 'Invalid staff id');

    const academicYear = req.query.academicYear || academicYearFor();
    const entitlement = await ensureEntitlement(staffId, academicYear, req.user._id);
    const requests = await loadRequestsFor(staffId, academicYear);

    return res.status(200).json({
      success: true,
      data: {
        entitlement,
        ledger: entitlement.buildLedger(requests),
        requests: requests.map((request) => request.toRow()),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load that entitlement');
  }
};

/**
 * POST /api/staff-leave/entitlements
 */
exports.createEntitlement = async (req, res) => {
  try {
    const { staff, academicYear } = req.body;
    if (!isValidId(staff)) return fail(res, 400, 'Invalid staff id');
    if (!academicYear) return fail(res, 400, 'Academic year is required');

    const existing = await StaffLeaveEntitlement.findOne({ staff, academicYear });
    if (existing) {
      return fail(res, 409, `${academicYear} is already open for that member of staff`);
    }

    const entitlement = new StaffLeaveEntitlement({
      staff,
      academicYear,
      allowances: Array.isArray(req.body.allowances) ? req.body.allowances : undefined,
      openingAdjustment: req.body.openingAdjustment,
      adjustmentType: req.body.adjustmentType,
      adjustmentReason: req.body.adjustmentReason,
      nonWorkingDates: req.body.nonWorkingDates,
    });
    entitlement.recordHistory('opened', req.user._id, req.body.note);

    await entitlement.save();

    return res.status(201).json({ success: true, data: entitlement });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to open that entitlement');
  }
};

/**
 * PATCH /api/staff-leave/entitlements/:id
 */
exports.updateEntitlement = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid entitlement id');

    const entitlement = await StaffLeaveEntitlement.findById(id);
    if (!entitlement) return fail(res, 404, 'Entitlement not found');
    if (entitlement.isClosed) {
      return fail(res, 409, 'A closed year cannot be edited');
    }

    if (Array.isArray(req.body.allowances)) entitlement.allowances = req.body.allowances;
    if (req.body.openingAdjustment !== undefined) {
      entitlement.openingAdjustment = req.body.openingAdjustment;
    }
    if (req.body.adjustmentType !== undefined) {
      entitlement.adjustmentType = req.body.adjustmentType;
    }
    if (req.body.adjustmentReason !== undefined) {
      entitlement.adjustmentReason = req.body.adjustmentReason;
    }
    if (Array.isArray(req.body.nonWorkingDates)) {
      entitlement.nonWorkingDates = req.body.nonWorkingDates;
    }

    entitlement.recordHistory('adjusted', req.user._id, req.body.note);
    await entitlement.save();

    return res.status(200).json({ success: true, data: entitlement });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update that entitlement');
  }
};

/**
 * POST /api/staff-leave/years/:year/close
 *
 * Carry-over, computed and capped, for everybody at once.
 *
 * Running it twice is a no-op: a year that is already closed is skipped, and a
 * next-year row that already has a carried figure is left alone. April stops
 * being a negotiation and becomes a button that can be pressed twice safely.
 */
exports.closeYear = async (req, res) => {
  try {
    const { year } = req.params;
    const following = nextAcademicYear(year);
    if (!following) return fail(res, 400, 'Invalid academic year');

    const entitlements = await StaffLeaveEntitlement.find({ academicYear: year });
    if (entitlements.length === 0) {
      return fail(res, 404, `No entitlements exist for ${year}`);
    }

    const summary = [];

    for (const entitlement of entitlements) {
      if (entitlement.isClosed) {
        summary.push({
          staff: entitlement.staff,
          skipped: true,
          reason: 'already closed',
        });
        continue;
      }

      const requests = await loadRequestsFor(entitlement.staff, year);
      const carryOver = entitlement.computeCarryOver(requests);

      const target = await ensureEntitlement(entitlement.staff, following, req.user._id);
      for (const line of carryOver) {
        const allowance = target.allowanceFor(line.type);
        if (allowance) {
          allowance.carriedIn = line.carried;
        } else if (line.carried > 0) {
          target.allowances.push({
            type: line.type,
            days: 0,
            carriedIn: line.carried,
            carryCap: line.carryCap,
          });
        }
      }
      const forfeited = toHalves(carryOver.reduce((sum, l) => sum + l.forfeited, 0));
      target.recordHistory(
        'carry-in',
        req.user._id,
        `Carried from ${year}: ${carryOver
          .filter((l) => l.carried > 0)
          .map((l) => `${l.type} ${l.carried}`)
          .join(', ') || 'nothing'}`
      );
      await target.save();

      entitlement.isClosed = true;
      entitlement.closedAt = new Date();
      entitlement.closedBy = req.user._id;
      entitlement.recordHistory(
        'closed',
        req.user._id,
        `Carried forward to ${following}; ${forfeited} day(s) forfeited above the cap`
      );
      await entitlement.save();

      summary.push({
        staff: entitlement.staff,
        skipped: false,
        carried: carryOver.filter((line) => line.carried > 0),
        forfeited,
      });
    }

    return res.status(200).json({
      success: true,
      message: `${year} closed and carried into ${following}`,
      data: { year, nextYear: following, summary },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to close that year');
  }
};

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * POST /api/staff-leave/requests
 *
 * The client sends dates and half-day flags. It does not send a day count —
 * that is computed against the working calendar, which is the whole reason this
 * exists rather than a spreadsheet column.
 */
exports.createRequest = async (req, res) => {
  try {
    let staff = req.user._id;
    if (req.body.staff && String(req.body.staff) !== String(req.user._id)) {
      if (!isAdmin(req.user)) {
        return fail(res, 403, 'Only an admin can raise leave for another member of staff');
      }
      if (!isValidId(req.body.staff)) return fail(res, 400, 'Invalid staff id');
      staff = req.body.staff;
    }

    const fields = stripUndefined(sanitiseRequest(req.body));
    const academicYear = fields.academicYear || academicYearFor(fields.startDate);
    const entitlement = await ensureEntitlement(staff, academicYear, req.user._id);

    if (entitlement.isClosed) {
      return fail(res, 409, `${academicYear} is closed and cannot take new leave`);
    }

    const request = new StaffLeaveRequest({
      ...fields,
      academicYear,
      staff,
      staffName: String(req.user._id) === String(staff) ? req.user.name : undefined,
      status: 'draft',
    });
    request.recordHistory('created', req.user._id);

    await saveWithCalendar(request, entitlement);

    return res.status(201).json({
      success: true,
      message: `Saved as a draft — ${request.dayUnits} day(s)`,
      data: request.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to raise that leave request');
  }
};

/**
 * POST /api/staff-leave/requests/preview
 *
 * What would this cost, without saving anything? The form uses it to say "2.5
 * days, leaves 4.5 casual" before the request is submitted, so the refusal at
 * approval time stops being a surprise a fortnight later.
 */
exports.previewRequest = async (req, res) => {
  try {
    const { startDate, endDate, startHalf, endHalf, type } = req.body;
    if (!startDate || !endDate) return fail(res, 400, 'Both dates are required');

    const academicYear = req.body.academicYear || academicYearFor(startDate);
    const entitlement = await ensureEntitlement(req.user._id, academicYear, req.user._id);
    const requests = await loadRequestsFor(req.user._id, academicYear);

    const probe = new StaffLeaveRequest({
      staff: req.user._id,
      academicYear,
      type: type || 'casual',
      startDate,
      endDate,
      startHalf,
      endHalf,
      reason: 'preview',
    });
    probe.$locals.nonWorkingDates = entitlement.nonWorkingDates;
    const validation = probe.validateSync();

    const ledger = entitlement.buildLedger(requests);
    const line = ledger.lines.find((l) => l.type === (type || 'casual'));
    const overlaps = StaffLeaveRequest.findOverlaps(requests, startDate, endDate, null);

    return res.status(200).json({
      success: true,
      data: {
        dayUnits: probe.dayUnits,
        workingDays: probe.workingDays,
        remainingBefore: line ? line.remaining : 0,
        remainingAfter: line ? toHalves(Math.max(line.remaining - probe.dayUnits, 0)) : 0,
        shortfall:
          line && !UNMETERED_TYPES.includes(type || 'casual')
            ? toHalves(Math.max(probe.dayUnits - line.remaining, 0))
            : 0,
        overlaps: overlaps.map((o) => ({
          _id: o._id,
          startDate: o.startDate,
          endDate: o.endDate,
          status: o.status,
          type: o.type,
        })),
        problem: validation ? validationMessage(validation) : null,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to price that leave');
  }
};

/**
 * GET /api/staff-leave/requests/mine
 */
exports.getMyRequests = async (req, res) => {
  try {
    const filter = { staff: req.user._id };
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;
    if (req.query.status) filter.status = req.query.status;

    const requests = await StaffLeaveRequest.find(filter).sort({ startDate: -1 });

    return res.status(200).json({
      success: true,
      count: requests.length,
      data: requests.map((request) => request.toRow()),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load your leave requests');
  }
};

/**
 * GET /api/staff-leave/requests/pending
 *
 * The approval queue, each row carrying the requester's remaining balance —
 * because approving without it is approving blind.
 */
exports.getPendingRequests = async (req, res) => {
  try {
    const requests = await StaffLeaveRequest.find({ status: 'submitted' })
      .populate('staff', 'name email role')
      .sort({ startDate: 1 });

    const rows = [];
    for (const request of requests) {
      const staffId = request.staff?._id || request.staff;
      const entitlement = await ensureEntitlement(
        staffId,
        request.academicYear,
        req.user._id
      );
      const siblings = await loadRequestsFor(staffId, request.academicYear);
      const ledger = entitlement.buildLedger(siblings);
      const line = ledger.lines.find((l) => l.type === request.type);

      rows.push({
        ...request.toRow(),
        staff: request.staff,
        remaining: line ? line.remaining : 0,
        wouldOverdraw: line ? request.dayUnits > line.remaining : false,
        overlaps: StaffLeaveRequest.findOverlaps(
          siblings,
          request.startDate,
          request.endDate,
          request._id
        ).map((o) => ({ _id: o._id, startDate: o.startDate, endDate: o.endDate })),
      });
    }

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    return serverError(res, error, 'Failed to load the approval queue');
  }
};

/**
 * GET /api/staff-leave/requests/calendar
 *
 * Who is out, by date. The query that stops two heads of department being off
 * on results day.
 */
exports.getCalendar = async (req, res) => {
  try {
    const from = req.query.from || todayKey();
    const to = req.query.to || from;
    if (to < from) return fail(res, 400, 'The end of the range is before its start');

    const requests = await StaffLeaveRequest.find({
      status: { $in: ['submitted', 'approved'] },
      startDate: { $lte: to },
      endDate: { $gte: from },
    }).populate('staff', 'name email');

    const withNames = requests.map((request) => {
      if (!request.staffName && request.staff && request.staff.name) {
        request.staffName = request.staff.name;
      }
      return request;
    });

    return res.status(200).json({
      success: true,
      data: {
        from,
        to,
        days: StaffLeaveRequest.buildCalendar(withNames, from, to),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build the absence calendar');
  }
};

/**
 * GET /api/staff-leave/requests
 */
exports.listRequests = async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.type) filter.type = req.query.type;
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;
    if (req.query.staff && isValidId(req.query.staff)) filter.staff = req.query.staff;
    if (req.query.from) filter.endDate = { $gte: req.query.from };
    if (req.query.to) filter.startDate = { $lte: req.query.to };

    const requests = await StaffLeaveRequest.find(filter)
      .populate('staff', 'name email role')
      .sort({ startDate: -1 })
      .limit(Math.min(Number(req.query.limit) || 200, 500));

    return res.status(200).json({
      success: true,
      count: requests.length,
      data: requests.map((request) => ({ ...request.toRow(), staff: request.staff })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load leave requests');
  }
};

/**
 * GET /api/staff-leave/requests/:id
 */
exports.getRequest = async (req, res) => {
  try {
    const result = await loadRequestFor(req.params.id, req.user);
    if (result.status) return fail(res, result.status, result.message);

    await result.request.populate('staff', 'name email role');

    return res.status(200).json({
      success: true,
      data: {
        ...result.request.toRow(),
        staff: result.request.staff,
        history: result.request.history,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load that leave request');
  }
};

/**
 * PATCH /api/staff-leave/requests/:id
 */
exports.updateRequest = async (req, res) => {
  try {
    const result = await loadRequestFor(req.params.id, req.user, { ownerOnly: true });
    if (result.status) return fail(res, result.status, result.message);

    const { request } = result;
    if (!request.isEditable()) {
      return fail(res, 409, `A ${request.status} request can no longer be edited`);
    }

    const fields = stripUndefined(sanitiseRequest(req.body));
    delete fields.academicYear;
    Object.assign(request, fields);

    const entitlement = await ensureEntitlement(
      request.staff,
      request.academicYear,
      req.user._id
    );
    request.recordHistory('edited', req.user._id);
    await saveWithCalendar(request, entitlement);

    return res.status(200).json({
      success: true,
      message: `Updated — ${request.dayUnits} day(s)`,
      data: request.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update that request');
  }
};

/**
 * PATCH /api/staff-leave/requests/:id/submit
 */
exports.submitRequest = async (req, res) => {
  try {
    const result = await loadRequestFor(req.params.id, req.user, { ownerOnly: true });
    if (result.status) return fail(res, result.status, result.message);

    const { request } = result;
    if (request.status !== 'draft') {
      return fail(res, 409, `A ${request.status} request cannot be submitted again`);
    }

    const entitlement = await ensureEntitlement(
      request.staff,
      request.academicYear,
      req.user._id
    );
    if (entitlement.isClosed) {
      return fail(res, 409, `${request.academicYear} is closed`);
    }

    const siblings = await loadRequestsFor(request.staff, request.academicYear);
    const overlaps = StaffLeaveRequest.findOverlaps(
      siblings,
      request.startDate,
      request.endDate,
      request._id
    );
    if (overlaps.length) {
      return fail(
        res,
        409,
        `This overlaps leave already booked from ${overlaps[0].startDate} to ${overlaps[0].endDate}`
      );
    }

    request.status = 'submitted';
    request.submittedAt = new Date();
    request.recordHistory('submitted', req.user._id);
    await saveWithCalendar(request, entitlement);

    return res.status(200).json({
      success: true,
      message: 'Submitted for approval',
      data: request.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to submit that request');
  }
};

/**
 * PATCH /api/staff-leave/requests/:id/approve
 *
 * Where the module earns its keep. The balance is recomputed here rather than
 * read, the shortfall is stated as a number, and an approval that asked for
 * cover creates the absences before it returns.
 */
exports.approveRequest = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid request id');

    const request = await StaffLeaveRequest.findById(id);
    if (!request) return fail(res, 404, 'Leave request not found');

    const entitlement = await ensureEntitlement(
      request.staff,
      request.academicYear,
      req.user._id
    );
    const siblings = await loadRequestsFor(request.staff, request.academicYear);
    const ledger = entitlement.buildLedger(siblings);
    const line = ledger.lines.find((l) => l.type === request.type);

    const overlaps = StaffLeaveRequest.findOverlaps(
      siblings,
      request.startDate,
      request.endDate,
      request._id
    ).filter((other) => other.status === 'approved');

    const problem = request.approvabilityErrorFor(req.user, {
      remaining: line ? line.remaining : 0,
      entitlement,
      overlapping: overlaps,
    });
    if (problem) return fail(res, 409, problem);

    request.status = 'approved';
    request.decidedBy = req.user._id;
    request.decidedAt = new Date();
    request.decisionNote = req.body.note || null;
    request.recordHistory('approved', req.user._id, req.body.note);

    const created = [];
    if (request.coverRequired) {
      for (const date of request.datesNeedingCover()) {
        const periods = request.absencePeriodsFor(date);
        if (periods.length === 0) continue;

        // One absence per date, matching how the cover board is keyed. An
        // absence already on the board for that date is left alone rather than
        // duplicated — re-approving a leave must not double the cover.
        const existing = await StaffAbsence.findOne({
          staff: request.staff,
          date,
          status: { $in: ['pending', 'approved'] },
        });
        if (existing) {
          if (!request.linkedAbsences.some((x) => String(x) === String(existing._id))) {
            request.linkedAbsences.push(existing._id);
          }
          continue;
        }

        const absence = new StaffAbsence({
          staff: request.staff,
          staffName: request.staffName,
          date,
          reason: ABSENCE_REASON_FOR_TYPE[request.type] || 'personal',
          details: `Approved ${request.type} leave (${request.startDate} to ${request.endDate})`,
          status: 'approved',
          reportedBy: request.staff,
          approvedBy: req.user._id,
          approvedAt: new Date(),
          periods,
        });

        try {
          await absence.save();
          request.linkedAbsences.push(absence._id);
          created.push({ date, periods: periods.length });
        } catch (absenceError) {
          // The leave is granted either way — refusing somebody's approved
          // leave because the cover board rejected a period would be the tail
          // wagging the dog. Record the gap where it can be seen.
          request.recordHistory(
            'cover-failed',
            req.user._id,
            `${date}: ${validationMessage(absenceError) || absenceError.message}`
          );
        }
      }
    }

    await saveWithCalendar(request, entitlement);

    return res.status(200).json({
      success: true,
      message: `Approved — ${request.dayUnits} day(s) of ${request.type} leave`,
      data: {
        ...request.toRow(),
        coverCreated: created,
        remainingAfter: line
          ? toHalves(Math.max(line.remaining - request.dayUnits, 0))
          : null,
      },
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to approve that request');
  }
};

/**
 * PATCH /api/staff-leave/requests/:id/reject
 */
exports.rejectRequest = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid request id');
    if (!req.body.reason || !String(req.body.reason).trim()) {
      return fail(res, 400, 'A rejection needs a reason');
    }

    const request = await StaffLeaveRequest.findById(id);
    if (!request) return fail(res, 404, 'Leave request not found');
    if (String(request.staff) === String(req.user._id)) {
      return fail(res, 403, 'You cannot decide your own leave');
    }
    if (request.status !== 'submitted') {
      return fail(res, 409, `A ${request.status} request cannot be rejected`);
    }

    request.status = 'rejected';
    request.decisionNote = req.body.reason;
    request.recordHistory('rejected', req.user._id, req.body.reason);

    const entitlement = await ensureEntitlement(
      request.staff,
      request.academicYear,
      req.user._id
    );
    await saveWithCalendar(request, entitlement);

    return res.status(200).json({
      success: true,
      message: 'Rejected',
      data: request.toRow(),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to reject that request');
  }
};

/**
 * PATCH /api/staff-leave/requests/:id/cancel
 *
 * Cancelling approved leave withdraws the cover with it. Leaving a substitute
 * booked for a lesson nobody is missing is how the board loses its credibility.
 */
exports.cancelRequest = async (req, res) => {
  try {
    const result = await loadRequestFor(req.params.id, req.user);
    if (result.status) return fail(res, result.status, result.message);

    const { request } = result;
    if (['cancelled', 'withdrawn', 'rejected'].includes(request.status)) {
      return fail(res, 409, `This request is already ${request.status}`);
    }

    const wasApproved = request.status === 'approved';
    request.status = wasApproved ? 'withdrawn' : 'cancelled';
    request.decisionNote = req.body.reason || null;
    request.recordHistory(
      wasApproved ? 'withdrawn' : 'cancelled',
      req.user._id,
      req.body.reason
    );

    let released = 0;
    if (request.linkedAbsences.length) {
      const updated = await StaffAbsence.updateMany(
        { _id: { $in: request.linkedAbsences }, status: { $ne: 'cancelled' } },
        {
          $set: {
            status: 'cancelled',
            cancelReason: `Leave ${request.status} on ${todayKey()}`,
            cancelledAt: new Date(),
          },
        }
      );
      released = updated.modifiedCount || 0;
    }

    const entitlement = await ensureEntitlement(
      request.staff,
      request.academicYear,
      req.user._id
    );
    await saveWithCalendar(request, entitlement);

    return res.status(200).json({
      success: true,
      message: `${wasApproved ? 'Withdrawn' : 'Cancelled'}; ${released} cover day(s) released`,
      data: request.toRow(),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to cancel that request');
  }
};

/**
 * GET /api/staff-leave/stats
 */
exports.getStats = async (req, res) => {
  try {
    const academicYear = req.query.academicYear || academicYearFor();

    const requests = await StaffLeaveRequest.find({ academicYear });

    const byStatus = {};
    const byType = {};
    let approvedDays = 0;
    let pendingDays = 0;

    for (const request of requests) {
      byStatus[request.status] = (byStatus[request.status] || 0) + 1;
      if (request.status === 'approved') {
        approvedDays += request.dayUnits;
        byType[request.type] = toHalves((byType[request.type] || 0) + request.dayUnits);
      } else if (request.status === 'submitted') {
        pendingDays += request.dayUnits;
      }
    }

    const today = todayKey();
    const outToday = requests.filter(
      (request) => request.status === 'approved' && request.coversDate(today)
    ).length;

    return res.status(200).json({
      success: true,
      data: {
        academicYear,
        requestCount: requests.length,
        byStatus,
        byType: Object.entries(byType)
          .map(([type, days]) => ({ type, days }))
          .sort((a, b) => b.days - a.days),
        approvedDays: toHalves(approvedDays),
        pendingDays: toHalves(pendingDays),
        outToday,
        awaitingDecision: byStatus.submitted || 0,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build leave statistics');
  }
};
