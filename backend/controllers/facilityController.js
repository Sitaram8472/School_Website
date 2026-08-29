const crypto = require('crypto');
const mongoose = require('mongoose');
const Facility = require('../models/Facility');

/**
 * Facility and room booking.
 *
 * `createBooking` is the handler worth reading. Everything else is a register,
 * a list or a state transition.
 */

const ACTIVE = Facility.ACTIVE_BOOKING_STATUSES;

/**
 * References are random rather than sequential. A sequential one needs a read
 * of the current count before the write, which is exactly the race the atomic
 * clash guard exists to avoid — it would be odd to close the door on double
 * booking and then reopen it to hand out a label.
 */
function makeReference() {
  const year = new Date().getFullYear();
  return `RM-${year}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function fail(res, status, message) {
  return res.status(status).json({ success: false, message });
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
  if (error.code === 11000) {
    return 'A facility with that code already exists.';
  }
  return null;
}

/**
 * A detached array subdocument has no parent to record failures against, so
 * Mongoose throws the `ValidatorError` out of `validateSync()` rather than
 * returning a `ValidationError`. Uncaught, that turns "title too short" into a
 * 500.
 */
function validateSubdocument(doc) {
  try {
    return doc.validateSync() || null;
  } catch (error) {
    return error;
  }
}

function isAdmin(user) {
  return user && user.role === 'admin';
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

/**
 * POST /api/facilities
 */
exports.createFacility = async (req, res) => {
  try {
    const fields = [
      'name',
      'code',
      'category',
      'building',
      'floor',
      'capacity',
      'amenities',
      'openingTime',
      'closingTime',
      'bufferMinutes',
      'requiresApproval',
      'minBookingMinutes',
      'maxBookingMinutes',
      'maxAdvanceDays',
      'notes',
    ];

    const payload = {};
    for (const field of fields) {
      if (req.body[field] !== undefined) payload[field] = req.body[field];
    }
    // `bookings` and `status` are server-owned; a client-supplied value is
    // dropped by not being copied here.

    const facility = await Facility.create(payload);

    return res.status(201).json({
      success: true,
      message: `${facility.name} is now bookable.`,
      data: facility.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to register the facility');
  }
};

/**
 * GET /api/facilities
 */
exports.listFacilities = async (req, res) => {
  try {
    const { category, minCapacity, amenity, includeRetired } = req.query;

    const filter = {};
    if (category) filter.category = category;
    if (minCapacity) filter.capacity = { $gte: Number(minCapacity) };
    if (amenity) filter.amenities = amenity;
    if (includeRetired !== 'true') filter.status = { $ne: 'retired' };

    const facilities = await Facility.find(filter).sort({ category: 1, name: 1 }).limit(300);

    return res.status(200).json({
      success: true,
      count: facilities.length,
      data: facilities.map((facility) => facility.redactFor(req.user)),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch facilities');
  }
};

/**
 * GET /api/facilities/:id
 */
exports.getFacility = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid facility id.');

    const facility = await Facility.findById(req.params.id);
    if (!facility) return fail(res, 404, 'Facility not found.');

    return res.status(200).json({
      success: true,
      data: facility.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the facility');
  }
};

/**
 * PATCH /api/facilities/:id
 *
 * Opening hours and the buffer may be tightened, but not in a way that would
 * invalidate a booking somebody is already holding. Silently shrinking the day
 * under a confirmed booking is how a room ends up double-used by the rules
 * themselves.
 */
exports.updateFacility = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid facility id.');

    const facility = await Facility.findById(req.params.id);
    if (!facility) return fail(res, 404, 'Facility not found.');

    const editable = [
      'name',
      'category',
      'building',
      'floor',
      'capacity',
      'amenities',
      'openingTime',
      'closingTime',
      'bufferMinutes',
      'requiresApproval',
      'minBookingMinutes',
      'maxBookingMinutes',
      'maxAdvanceDays',
      'notes',
    ];
    for (const field of editable) {
      if (req.body[field] !== undefined) facility[field] = req.body[field];
    }

    const today = Facility.todayKey();
    const newOpening = Facility.toMinutes(facility.openingTime);
    const newClosing = Facility.toMinutes(facility.closingTime);

    const stranded = facility.bookings.find(
      (booking) =>
        ACTIVE.includes(booking.status) &&
        booking.date >= today &&
        (booking.startMinute < newOpening || booking.endMinute > newClosing)
    );
    if (stranded) {
      return fail(
        res,
        409,
        `${stranded.reference} on ${stranded.date} runs ${stranded.startTime}–${stranded.endTime}, outside the new opening hours. Cancel it first.`
      );
    }

    await facility.save();

    return res.status(200).json({
      success: true,
      message: 'Facility updated.',
      data: facility.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update the facility');
  }
};

/**
 * PATCH /api/facilities/:id/status
 *
 * Closing a room for maintenance leaves the bookings that are already on it
 * visible rather than deleting them, so somebody has to deal with each one.
 * A closure discovered on the morning is the failure mode being avoided.
 */
exports.setFacilityStatus = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid facility id.');

    const { status } = req.body;
    if (!Facility.FACILITY_STATUSES.includes(status)) {
      return fail(
        res,
        400,
        `status must be one of: ${Facility.FACILITY_STATUSES.join(', ')}.`
      );
    }

    const facility = await Facility.findById(req.params.id);
    if (!facility) return fail(res, 404, 'Facility not found.');

    facility.status = status;
    await facility.save();

    const today = Facility.todayKey();
    const affected = facility.bookings.filter(
      (booking) => ACTIVE.includes(booking.status) && booking.date >= today
    );

    return res.status(200).json({
      success: true,
      message:
        status === 'active'
          ? `${facility.name} is bookable again.`
          : `${facility.name} is now ${status}. ${affected.length} existing booking${
              affected.length === 1 ? '' : 's'
            } still need dealing with.`,
      affected: affected.map((booking) => ({
        reference: booking.reference,
        date: booking.date,
        startTime: booking.startTime,
        endTime: booking.endTime,
        requesterName: booking.requesterName,
        title: booking.title,
      })),
      data: facility.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to change the facility status');
  }
};

/**
 * DELETE /api/facilities/:id
 * Refused while anybody is holding a future booking on it.
 */
exports.deleteFacility = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid facility id.');

    const facility = await Facility.findById(req.params.id);
    if (!facility) return fail(res, 404, 'Facility not found.');

    const today = Facility.todayKey();
    const future = facility.bookings.filter(
      (booking) => ACTIVE.includes(booking.status) && booking.date >= today
    );
    if (future.length > 0) {
      return fail(
        res,
        409,
        `${future.length} booking${future.length === 1 ? ' is' : 's are'} still held on ${facility.name}. Retire it instead, or cancel them first.`
      );
    }

    await facility.deleteOne();

    return res.status(200).json({ success: true, message: 'Facility removed.' });
  } catch (error) {
    return serverError(res, error, 'Failed to remove the facility');
  }
};

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * GET /api/facilities/availability?date=&startTime=&endTime=&category=
 *
 * "What is free on Thursday at 2" in one request. Where a window is given, each
 * facility is answered yes or no; where it is not, the free gaps are returned.
 */
exports.getAvailability = async (req, res) => {
  try {
    const { date, startTime, endTime, category, minCapacity } = req.query;
    const day = date || Facility.todayKey();

    const filter = { status: 'active' };
    if (category) filter.category = category;
    if (minCapacity) filter.capacity = { $gte: Number(minCapacity) };

    const facilities = await Facility.find(filter).sort({ name: 1 }).limit(200);

    const startMinute = Facility.toMinutes(startTime);
    const endMinute = Facility.toMinutes(endTime);
    const hasWindow = startMinute !== null && endMinute !== null && endMinute > startMinute;

    const rows = facilities.map((facility) => {
      const booked = facility.bookingsOn(day).map((booking) => ({
        bookingId: booking._id,
        reference: booking.reference,
        startTime: booking.startTime,
        endTime: booking.endTime,
        startMinute: booking.startMinute,
        endMinute: booking.endMinute,
        status: booking.status,
        title: booking.title,
        requesterName: ['teacher', 'admin'].includes(req.user.role)
          ? booking.requesterName
          : undefined,
      }));

      const base = {
        _id: facility._id,
        name: facility.name,
        code: facility.code,
        category: facility.category,
        building: facility.building,
        capacity: facility.capacity,
        amenities: facility.amenities,
        requiresApproval: facility.requiresApproval,
        bufferMinutes: facility.bufferMinutes,
        openingTime: facility.openingTime,
        closingTime: facility.closingTime,
        booked,
        freeWindows: facility.freeWindowsOn(day),
      };

      if (!hasWindow) return base;

      const problem = facility.requestError({ date: day, startMinute, endMinute });
      if (problem) return { ...base, free: false, reason: problem };

      const guarded = facility.guardedWindow(startMinute, endMinute);
      const clash = facility
        .bookingsOn(day)
        .find(
          (booking) =>
            booking.startMinute < guarded.endMinute && guarded.startMinute < booking.endMinute
        );

      return {
        ...base,
        free: !clash,
        reason: clash
          ? `Taken ${clash.startTime}–${clash.endTime}${
              facility.bufferMinutes ? ` (including ${facility.bufferMinutes} min setup)` : ''
            }`
          : null,
      };
    });

    return res.status(200).json({
      success: true,
      date: day,
      window: hasWindow ? { startTime, endTime } : null,
      count: rows.length,
      data: rows,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to work out availability');
  }
};

/**
 * GET /api/facilities/:id/schedule?date=
 */
exports.getSchedule = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid facility id.');

    const facility = await Facility.findById(req.params.id);
    if (!facility) return fail(res, 404, 'Facility not found.');

    const day = req.query.date || Facility.todayKey();
    const isStaff = ['teacher', 'admin'].includes(req.user.role);

    const bookings = facility.bookingsOn(day).map((booking) => ({
      bookingId: booking._id,
      reference: booking.reference,
      title: isStaff || String(booking.requestedBy) === String(req.user._id)
        ? booking.title
        : 'Reserved',
      startTime: booking.startTime,
      endTime: booking.endTime,
      startMinute: booking.startMinute,
      endMinute: booking.endMinute,
      status: booking.status,
      requesterName: isStaff ? booking.requesterName : undefined,
      expectedAttendance: isStaff ? booking.expectedAttendance : undefined,
      setupNotes: isStaff ? booking.setupNotes : undefined,
    }));

    return res.status(200).json({
      success: true,
      date: day,
      facility: {
        _id: facility._id,
        name: facility.name,
        code: facility.code,
        openingTime: facility.openingTime,
        closingTime: facility.closingTime,
        bufferMinutes: facility.bufferMinutes,
        requiresApproval: facility.requiresApproval,
        status: facility.status,
      },
      freeWindows: facility.freeWindowsOn(day),
      count: bookings.length,
      data: bookings,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the schedule');
  }
};

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

/**
 * POST /api/facilities/:id/bookings
 *
 * The clash guard is the filter of a single `findOneAndUpdate`:
 *
 *   - `status: 'active'`               the room is open for business
 *   - `bookings: { $not: { $elemMatch: { date,
 *                                        status: { $in: ACTIVE },
 *                                        startMinute: { $lt: guardedEnd },
 *                                        endMinute:   { $gt: guardedStart } } } }`
 *
 * which reads "this facility has no live booking on that date whose interval
 * intersects mine", and the update pushes the booking. If two requests race,
 * the second one's filter no longer matches and it gets a 409 — the double
 * booking is impossible, not merely unlikely. A read-then-write version lets
 * both requests pass the check before either writes, which is the paper diary
 * reimplemented in JavaScript.
 *
 * The guarded interval is the requested one widened by the facility's buffer on
 * each side, so the chairs going out and the chairs coming back are part of the
 * window the database protects rather than a note in the description.
 */
exports.createBooking = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid facility id.');

    const facility = await Facility.findById(req.params.id);
    if (!facility) return fail(res, 404, 'Facility not found.');

    const { title, purpose, date, startTime, endTime, expectedAttendance, setupNotes } =
      req.body;

    const startMinute = Facility.toMinutes(startTime);
    const endMinute = Facility.toMinutes(endTime);

    // Everything except the clash. The clash is the update's job, and checking
    // it twice is how a codebase starts trusting the copy that cannot be
    // trusted.
    const problem = facility.requestError({ date, startMinute, endMinute });
    if (problem) return fail(res, 409, problem);

    if (expectedAttendance && Number(expectedAttendance) > facility.capacity) {
      return fail(
        res,
        400,
        `${facility.name} holds ${facility.capacity}. Book somewhere larger.`
      );
    }

    const guarded = facility.guardedWindow(startMinute, endMinute);

    const booking = facility.bookings.create({
      reference: makeReference(),
      requestedBy: req.user._id,
      requesterName: req.user.name,
      title,
      purpose,
      date,
      startTime,
      endTime,
      startMinute: guarded.startMinute,
      endMinute: guarded.endMinute,
      requestedStartMinute: startMinute,
      requestedEndMinute: endMinute,
      expectedAttendance: expectedAttendance || 1,
      setupNotes,
      // A room that needs nobody's permission is live on submission. Making a
      // teacher wait for approval to use a spare classroom is how a booking
      // system gets abandoned for the diary it replaced.
      status: facility.requiresApproval ? 'pending' : 'approved',
      approvedBy: facility.requiresApproval ? null : req.user._id,
      approvedAt: facility.requiresApproval ? null : new Date(),
    });

    // Subdocument validators do not run inside `findOneAndUpdate` with `$push`,
    // so the booking is validated here before the atomic write.
    const invalid = validateSubdocument(booking);
    if (invalid) {
      const message = validationMessage(invalid);
      return fail(res, 400, message || 'Those booking details are not valid.');
    }

    const updated = await Facility.findOneAndUpdate(
      {
        _id: facility._id,
        status: 'active',
        bookings: {
          $not: {
            $elemMatch: {
              date,
              status: { $in: ACTIVE },
              startMinute: { $lt: guarded.endMinute },
              endMinute: { $gt: guarded.startMinute },
            },
          },
        },
      },
      { $push: { bookings: booking.toObject() } },
      { new: true }
    );

    if (!updated) {
      // Re-read to say which booking took it, rather than a bare "could not".
      const fresh = await Facility.findById(facility._id).select('bookings status name bufferMinutes');
      const clash =
        fresh &&
        fresh.bookings.find(
          (existing) =>
            existing.date === date &&
            ACTIVE.includes(existing.status) &&
            existing.startMinute < guarded.endMinute &&
            guarded.startMinute < existing.endMinute
        );

      return fail(
        res,
        409,
        clash
          ? `That window was taken a moment ago (${clash.startTime}–${clash.endTime}). Pick another.`
          : 'That window is no longer available.'
      );
    }

    const stored = updated.bookings[updated.bookings.length - 1];

    return res.status(201).json({
      success: true,
      message: facility.requiresApproval
        ? `Request submitted. Your reference is ${stored.reference}; the room is held while it is decided.`
        : `Booked. Your reference is ${stored.reference}.`,
      reference: stored.reference,
      data: updated.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to book the facility');
  }
};

/**
 * PATCH /api/facilities/:id/bookings/:bookingId/approve
 */
exports.approveBooking = async (req, res) => {
  try {
    const { id, bookingId } = req.params;
    if (!isValidId(id) || !isValidId(bookingId)) {
      return fail(res, 400, 'Invalid facility or booking id.');
    }

    const updated = await Facility.findOneAndUpdate(
      {
        _id: id,
        bookings: { $elemMatch: { _id: bookingId, status: 'pending' } },
      },
      {
        $set: {
          'bookings.$[target].status': 'approved',
          'bookings.$[target].approvedBy': req.user._id,
          'bookings.$[target].approvedAt': new Date(),
          'bookings.$[target].rejectionReason': null,
        },
      },
      { new: true, arrayFilters: [{ 'target._id': bookingId }] }
    );

    if (!updated) return fail(res, 409, 'That request is not awaiting a decision.');

    return res.status(200).json({
      success: true,
      message: 'Booking approved.',
      data: updated.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to approve the booking');
  }
};

/**
 * PATCH /api/facilities/:id/bookings/:bookingId/reject
 * Rejecting frees the interval, because a rejected request is no longer holding
 * the room.
 */
exports.rejectBooking = async (req, res) => {
  try {
    const { id, bookingId } = req.params;
    const { rejectionReason } = req.body;

    if (!isValidId(id) || !isValidId(bookingId)) {
      return fail(res, 400, 'Invalid facility or booking id.');
    }
    if (!rejectionReason || String(rejectionReason).trim().length < 5) {
      return fail(res, 400, 'Give a reason of at least 5 characters.');
    }

    const updated = await Facility.findOneAndUpdate(
      {
        _id: id,
        bookings: { $elemMatch: { _id: bookingId, status: 'pending' } },
      },
      {
        $set: {
          'bookings.$[target].status': 'rejected',
          'bookings.$[target].rejectionReason': rejectionReason,
        },
      },
      { new: true, arrayFilters: [{ 'target._id': bookingId }] }
    );

    if (!updated) return fail(res, 409, 'That request is not awaiting a decision.');

    return res.status(200).json({
      success: true,
      message: 'Request rejected and the window freed.',
      data: updated.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to reject the booking');
  }
};

/**
 * PATCH /api/facilities/:id/bookings/:bookingId/cancel
 *
 * The requester or an admin. Filtered on the booking still being active so a
 * double tap cannot overwrite a cancellation reason with a second one.
 */
exports.cancelBooking = async (req, res) => {
  try {
    const { id, bookingId } = req.params;
    if (!isValidId(id) || !isValidId(bookingId)) {
      return fail(res, 400, 'Invalid facility or booking id.');
    }

    const facility = await Facility.findById(id);
    if (!facility) return fail(res, 404, 'Facility not found.');

    const booking = facility.bookings.id(bookingId);
    if (!booking) return fail(res, 404, 'That booking is not on this facility.');

    const isOwner = String(booking.requestedBy) === String(req.user._id);
    if (!isOwner && !isAdmin(req.user)) {
      return fail(res, 403, 'You can only cancel your own bookings.');
    }
    if (!ACTIVE.includes(booking.status)) {
      return fail(res, 409, 'That booking is not active.');
    }

    const updated = await Facility.findOneAndUpdate(
      {
        _id: facility._id,
        bookings: { $elemMatch: { _id: booking._id, status: { $in: ACTIVE } } },
      },
      {
        $set: {
          'bookings.$[target].status': 'cancelled',
          'bookings.$[target].cancelReason': req.body.cancelReason || null,
        },
      },
      { new: true, arrayFilters: [{ 'target._id': booking._id }] }
    );

    if (!updated) {
      return fail(res, 409, 'That booking changed while you were looking at it.');
    }

    return res.status(200).json({
      success: true,
      message: 'Booking cancelled. The window is free again.',
      data: updated.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to cancel the booking');
  }
};

/**
 * GET /api/facilities/my-bookings
 */
exports.getMyBookings = async (req, res) => {
  try {
    const facilities = await Facility.find({
      'bookings.requestedBy': req.user._id,
    }).limit(300);

    const rows = [];
    for (const facility of facilities) {
      for (const booking of facility.bookings) {
        if (String(booking.requestedBy) !== String(req.user._id)) continue;
        rows.push({
          facilityId: facility._id,
          bookingId: booking._id,
          facilityName: facility.name,
          facilityCode: facility.code,
          building: facility.building,
          reference: booking.reference,
          title: booking.title,
          purpose: booking.purpose,
          date: booking.date,
          startTime: booking.startTime,
          endTime: booking.endTime,
          status: booking.status,
          rejectionReason: booking.rejectionReason,
          cancelReason: booking.cancelReason,
          expectedAttendance: booking.expectedAttendance,
        });
      }
    }

    rows.sort((a, b) => b.date.localeCompare(a.date) || a.startTime.localeCompare(b.startTime));

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch your bookings');
  }
};

/**
 * GET /api/facilities/pending
 * The approval queue, across every facility that needs one.
 */
exports.getPendingRequests = async (req, res) => {
  try {
    const facilities = await Facility.find({
      'bookings.status': 'pending',
    }).limit(300);

    const rows = [];
    for (const facility of facilities) {
      for (const booking of facility.bookings) {
        if (booking.status !== 'pending') continue;
        rows.push({
          facilityId: facility._id,
          bookingId: booking._id,
          facilityName: facility.name,
          reference: booking.reference,
          title: booking.title,
          purpose: booking.purpose,
          date: booking.date,
          startTime: booking.startTime,
          endTime: booking.endTime,
          requesterName: booking.requesterName,
          expectedAttendance: booking.expectedAttendance,
          setupNotes: booking.setupNotes,
        });
      }
    }

    rows.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the approval queue');
  }
};

/**
 * GET /api/facilities/stats
 * Utilisation as a share of the hours each room is actually open, because a
 * count of bookings says nothing about a hall booked once for eight hours.
 */
exports.getStats = async (req, res) => {
  try {
    const to = req.query.to || Facility.todayKey();
    const from = req.query.from || to;

    const facilities = await Facility.find({ status: { $ne: 'retired' } });
    const days = Math.max(1, Facility.daysBetween(from, to) + 1);

    const rows = facilities.map((facility) => {
      const inWindow = facility.bookings.filter(
        (booking) =>
          booking.date >= from &&
          booking.date <= to &&
          ACTIVE.includes(booking.status)
      );

      const minutes = inWindow.reduce(
        (total, booking) => total + (booking.endMinute - booking.startMinute),
        0
      );
      const openMinutes = facility.openMinutesPerDay * days;

      return {
        _id: facility._id,
        name: facility.name,
        code: facility.code,
        category: facility.category,
        bookings: inWindow.length,
        bookedMinutes: minutes,
        openMinutes,
        utilisation: openMinutes > 0 ? Math.round((minutes / openMinutes) * 100) : 0,
        pending: facility.bookings.filter((booking) => booking.status === 'pending').length,
      };
    });

    rows.sort((a, b) => b.utilisation - a.utilisation);

    return res.status(200).json({
      success: true,
      window: { from, to, days },
      stats: {
        facilities: rows.length,
        totalBookings: rows.reduce((total, row) => total + row.bookings, 0),
        pending: rows.reduce((total, row) => total + row.pending, 0),
      },
      data: rows,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build the utilisation report');
  }
};
