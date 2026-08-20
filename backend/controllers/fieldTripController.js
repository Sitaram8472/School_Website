const mongoose = require('mongoose');
const FieldTrip = require('../models/FieldTrip');

/**
 * Field trips and excursions.
 *
 * Two handlers carry the weight: `register`, which will not create a
 * participant without consent and will not create one past capacity, and
 * `getManifest`, which is the only place the medical brief leaves the database.
 * The rest is bookkeeping.
 */

const ACTIVE = FieldTrip.ACTIVE_PARTICIPANT_STATUSES;

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
  return null;
}

/**
 * Validates a detached subdocument and returns the error rather than letting it
 * propagate.
 *
 * An array subdocument built on its own has no parent to record failures
 * against, so Mongoose throws the `ValidatorError` out of `validateSync()`
 * instead of returning a `ValidationError` the way a top-level document does.
 * Uncaught, that turns "the guardian must type their name" into a 500.
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

function canManage(trip, user) {
  return String(trip.organiser) === String(user._id) || isAdmin(user);
}

// ---------------------------------------------------------------------------
// Organising
// ---------------------------------------------------------------------------

/**
 * POST /api/trips
 * Creates a trip in `draft`. Publishing is a separate, deliberate step.
 */
exports.createTrip = async (req, res) => {
  try {
    const {
      title,
      destination,
      purpose,
      description,
      departureDate,
      returnDate,
      departureTime,
      returnTime,
      meetingPoint,
      transportMode,
      costPerStudent,
      capacity,
      eligibleClasses,
      staffEscorts,
      emergencyContact,
      consentDeadline,
    } = req.body;

    const trip = await FieldTrip.create({
      title,
      destination,
      purpose,
      description,
      departureDate,
      returnDate,
      departureTime,
      returnTime,
      meetingPoint,
      transportMode,
      costPerStudent,
      capacity,
      eligibleClasses: Array.isArray(eligibleClasses) ? eligibleClasses : [],
      staffEscorts: Array.isArray(staffEscorts) ? staffEscorts : [],
      emergencyContact,
      consentDeadline,
      organiser: req.user._id,
      organiserName: req.user.name,
      // status, confirmedCount and participants are deliberately absent. They
      // are server-owned and any client-supplied value is dropped here.
    });

    return res.status(201).json({
      success: true,
      message: 'Trip created as a draft. Publish it when the details are settled.',
      data: trip.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to create the trip');
  }
};

/**
 * GET /api/trips
 * The browse view. Drafts belong to their organiser and appear nowhere else.
 */
exports.listTrips = async (req, res) => {
  try {
    const { purpose, className, openOnly, from, to } = req.query;

    const filter = { status: { $in: ['open', 'closed', 'completed'] } };
    if (purpose) filter.purpose = purpose;
    if (className) {
      // A trip with no class restriction is open to everybody, which is why the
      // empty-array case has to be part of the filter rather than assumed.
      filter.$or = [{ eligibleClasses: className }, { eligibleClasses: { $size: 0 } }];
    }
    if (from || to) {
      filter.departureDate = {};
      if (from) filter.departureDate.$gte = from;
      if (to) filter.departureDate.$lte = to;
    } else {
      filter.departureDate = { $gte: FieldTrip.todayKey() };
    }

    let trips = await FieldTrip.find(filter)
      .sort({ departureDate: 1 })
      .limit(200);

    if (openOnly === 'true') {
      trips = trips.filter((trip) => trip.isOpen);
    }

    return res.status(200).json({
      success: true,
      count: trips.length,
      data: trips.map((trip) => ({
        ...trip.redactFor(req.user),
        unavailableReason: trip.registrationError(),
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch trips');
  }
};

/**
 * GET /api/trips/mine
 */
exports.getMyTrips = async (req, res) => {
  try {
    const trips = await FieldTrip.find({
      $or: [{ organiser: req.user._id }, { 'staffEscorts.staff': req.user._id }],
    })
      .sort({ departureDate: -1 })
      .limit(200);

    return res.status(200).json({
      success: true,
      count: trips.length,
      data: trips.map((trip) => trip.redactFor(req.user)),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch your trips');
  }
};

/**
 * GET /api/trips/:id
 */
exports.getTrip = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid trip id.');

    const trip = await FieldTrip.findById(req.params.id);
    if (!trip) return fail(res, 404, 'Trip not found.');

    if (trip.status === 'draft' && !canManage(trip, req.user)) {
      return fail(res, 404, 'Trip not found.');
    }

    return res.status(200).json({
      success: true,
      data: {
        ...trip.redactFor(req.user),
        unavailableReason: trip.registrationError(),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the trip');
  }
};

/**
 * PATCH /api/trips/:id
 *
 * Once families have registered, the details they consented to are frozen —
 * changing a destination under a signed consent makes the consent meaningless.
 * Capacity may still be raised, and the description may still be corrected.
 */
exports.updateTrip = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid trip id.');

    const trip = await FieldTrip.findById(req.params.id);
    if (!trip) return fail(res, 404, 'Trip not found.');
    if (!canManage(trip, req.user)) {
      return fail(res, 403, 'Only the organiser or an admin can edit this trip.');
    }
    if (trip.status === 'cancelled' || trip.status === 'completed') {
      return fail(res, 409, 'This trip is closed and can no longer be edited.');
    }

    const hasRegistrations = trip.confirmedCount > 0;

    const frozen = [
      'destination',
      'departureDate',
      'returnDate',
      'departureTime',
      'returnTime',
      'meetingPoint',
      'costPerStudent',
      'consentDeadline',
    ];

    if (hasRegistrations) {
      const attempted = frozen.filter((field) => req.body[field] !== undefined);
      if (attempted.length > 0) {
        return fail(
          res,
          409,
          `Families have already consented to this trip. ${attempted.join(', ')} can no longer be changed — cancel and re-publish instead.`
        );
      }
      if (req.body.capacity !== undefined && req.body.capacity < trip.confirmedCount) {
        return fail(
          res,
          409,
          `Capacity cannot go below the ${trip.confirmedCount} seats already taken.`
        );
      }
    }

    const editable = [
      'title',
      'purpose',
      'description',
      'transportMode',
      'capacity',
      'eligibleClasses',
      'staffEscorts',
      'emergencyContact',
      ...(hasRegistrations ? [] : frozen),
    ];

    for (const field of editable) {
      if (req.body[field] !== undefined) trip[field] = req.body[field];
    }

    await trip.save();

    return res.status(200).json({
      success: true,
      message: 'Trip updated.',
      data: trip.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update the trip');
  }
};

/**
 * PATCH /api/trips/:id/status
 * draft -> open -> closed -> completed, and nothing else.
 */
exports.setStatus = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid trip id.');

    const { status } = req.body;
    const allowed = {
      draft: ['open'],
      open: ['closed', 'completed'],
      closed: ['open', 'completed'],
      completed: [],
      cancelled: [],
    };

    const trip = await FieldTrip.findById(req.params.id);
    if (!trip) return fail(res, 404, 'Trip not found.');
    if (!canManage(trip, req.user)) {
      return fail(res, 403, 'Only the organiser or an admin can change this trip.');
    }
    if (!allowed[trip.status].includes(status)) {
      return fail(res, 409, `A ${trip.status} trip cannot become ${status}.`);
    }

    trip.status = status;
    await trip.save();

    return res.status(200).json({
      success: true,
      message: `Trip is now ${status}.`,
      data: trip.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to change the trip status');
  }
};

/**
 * PATCH /api/trips/:id/cancel
 */
exports.cancelTrip = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid trip id.');

    const { cancelReason } = req.body;
    if (!cancelReason || String(cancelReason).trim().length < 5) {
      return fail(res, 400, 'Give families a reason of at least 5 characters.');
    }

    const trip = await FieldTrip.findById(req.params.id);
    if (!trip) return fail(res, 404, 'Trip not found.');
    if (!canManage(trip, req.user)) {
      return fail(res, 403, 'Only the organiser or an admin can cancel this trip.');
    }
    if (trip.status === 'cancelled') {
      return fail(res, 409, 'This trip is already cancelled.');
    }

    trip.status = 'cancelled';
    trip.cancelReason = cancelReason;
    trip.cancelledAt = new Date();
    await trip.save();

    return res.status(200).json({
      success: true,
      message: 'Trip cancelled. Families keep their record so refunds can be tracked.',
      data: trip.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to cancel the trip');
  }
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * POST /api/trips/:id/register
 *
 * The consent block is built and validated *before* the write, and the write
 * carries it. There is no path through this handler that produces a participant
 * without one — no "register now, consent later" branch — because that state is
 * exactly what the paper slip already gets wrong.
 *
 * Capacity is the filter of a single `findOneAndUpdate`:
 *
 *   - `status: 'open'`                          published, not closed or cancelled
 *   - `consentDeadline: { $gte: today }`        registration still open
 *   - `$expr: confirmedCount < capacity`        a seat is genuinely free
 *   - no active participant for this account    one registration per family
 *
 * and the update pushes the participant and increments the counter in the same
 * operation. Read-compare-write lets two guardians both pass the comparison
 * before either writes; here the loser matches nothing and gets a 409.
 */
exports.register = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid trip id.');

    const trip = await FieldTrip.findById(req.params.id);
    if (!trip) return fail(res, 404, 'Trip not found.');

    // Checked up front so the family gets the real reason rather than a bare
    // "could not register" from the guard below. The guard is still the
    // authority — this is the message, not the check.
    const blocked = trip.registrationError();
    if (blocked) return fail(res, 409, blocked);

    if (trip.findRegistrationBy(req.user._id)) {
      return fail(res, 409, 'You have already registered a child for this trip.');
    }

    const {
      studentName,
      className,
      guardianName,
      guardianContact,
      emergencyContactNumber,
      medicalNotes,
      dietaryNotes,
      guardianTypedName,
      medicalTreatmentConsent,
      photographyConsent,
      consentAcknowledged,
    } = req.body;

    if (consentAcknowledged !== true) {
      return fail(
        res,
        400,
        'The consent statement has to be acknowledged before a seat can be taken.'
      );
    }

    if (
      trip.eligibleClasses.length > 0 &&
      !trip.eligibleClasses.includes(String(className || '').trim())
    ) {
      return fail(
        res,
        409,
        `This trip is open to ${trip.eligibleClasses.join(', ')} only.`
      );
    }

    const participant = {
      studentName,
      className,
      registeredBy: req.user._id,
      guardianName,
      guardianContact,
      emergencyContactNumber,
      medicalNotes,
      dietaryNotes,
      paymentStatus: trip.costPerStudent > 0 ? 'pending' : 'not-required',
      consent: {
        givenBy: req.user._id,
        guardianTypedName,
        statementVersion: FieldTrip.CONSENT_STATEMENT_VERSION,
        givenAt: new Date(),
        medicalTreatmentConsent: medicalTreatmentConsent !== false,
        photographyConsent: photographyConsent === true,
      },
    };

    // Validate the subdocument before the atomic update, because a
    // `findOneAndUpdate` with `$push` does not run subdocument validators and
    // would happily store an empty guardian name.
    const draft = trip.participants.create(participant);
    const invalid = validateSubdocument(draft);
    if (invalid) {
      const message = validationMessage(invalid);
      return fail(res, 400, message || 'Those registration details are not valid.');
    }

    const updated = await FieldTrip.findOneAndUpdate(
      {
        _id: trip._id,
        status: 'open',
        consentDeadline: { $gte: FieldTrip.todayKey() },
        $expr: { $lt: ['$confirmedCount', '$capacity'] },
        participants: {
          $not: {
            $elemMatch: { registeredBy: req.user._id, status: { $in: ACTIVE } },
          },
        },
      },
      {
        $push: { participants: draft.toObject() },
        $inc: { confirmedCount: 1 },
      },
      { new: true }
    );

    if (!updated) {
      // Either the last seat went while this request was in flight, or the
      // trip closed. Re-read so the family is told which.
      const fresh = await FieldTrip.findById(trip._id);
      return fail(
        res,
        409,
        (fresh && fresh.registrationError()) ||
          'That seat was taken a moment ago. Please reload the trip.'
      );
    }

    return res.status(201).json({
      success: true,
      message: `${studentName} has a seat. ${updated.seatsLeft} left.`,
      data: updated.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to register for the trip');
  }
};

/**
 * PATCH /api/trips/:id/participants/:pid/withdraw
 *
 * The decrement and the status change are one conditional update, filtered on
 * the participant still being active, so a double tap cannot take the counter
 * below the number of children actually going.
 */
exports.withdraw = async (req, res) => {
  try {
    const { id, pid } = req.params;
    if (!isValidId(id) || !isValidId(pid)) {
      return fail(res, 400, 'Invalid trip or participant id.');
    }

    const trip = await FieldTrip.findById(id);
    if (!trip) return fail(res, 404, 'Trip not found.');

    const participant = trip.participants.id(pid);
    if (!participant) return fail(res, 404, 'That registration is not on this trip.');

    const isOwner = String(participant.registeredBy) === String(req.user._id);
    if (!isOwner && !canManage(trip, req.user)) {
      return fail(res, 403, 'You can only withdraw your own registration.');
    }

    if (!ACTIVE.includes(participant.status)) {
      return fail(res, 409, 'That registration has already been withdrawn.');
    }

    // The organiser can always withdraw somebody — a child who has moved school
    // should not hold a seat because a deadline passed.
    if (isOwner && !canManage(trip, req.user)) {
      const blocked = trip.withdrawalError();
      if (blocked) return fail(res, 409, blocked);
    }

    const updated = await FieldTrip.findOneAndUpdate(
      {
        _id: trip._id,
        participants: { $elemMatch: { _id: participant._id, status: { $in: ACTIVE } } },
      },
      {
        $set: {
          'participants.$[target].status': 'withdrawn',
          'participants.$[target].withdrawnAt': new Date(),
          'participants.$[target].withdrawReason': req.body.withdrawReason || null,
        },
        $inc: { confirmedCount: -1 },
      },
      { new: true, arrayFilters: [{ 'target._id': participant._id }] }
    );

    if (!updated) {
      return fail(res, 409, 'That registration changed while you were looking at it.');
    }

    return res.status(200).json({
      success: true,
      message: 'Withdrawn. The seat is available again.',
      data: updated.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to withdraw from the trip');
  }
};

/**
 * PATCH /api/trips/:id/participants/:pid/payment
 */
exports.setPayment = async (req, res) => {
  try {
    const { id, pid } = req.params;
    const { paymentStatus, paymentNote } = req.body;

    if (!isValidId(id) || !isValidId(pid)) {
      return fail(res, 400, 'Invalid trip or participant id.');
    }
    if (!FieldTrip.PAYMENT_STATUSES.includes(paymentStatus)) {
      return fail(
        res,
        400,
        `paymentStatus must be one of: ${FieldTrip.PAYMENT_STATUSES.join(', ')}.`
      );
    }

    const trip = await FieldTrip.findById(id);
    if (!trip) return fail(res, 404, 'Trip not found.');
    if (!canManage(trip, req.user)) {
      return fail(res, 403, 'Only the organiser or an admin can record payments.');
    }

    const participant = trip.participants.id(pid);
    if (!participant) return fail(res, 404, 'That registration is not on this trip.');

    participant.paymentStatus = paymentStatus;
    participant.paymentNote = paymentNote || null;
    await trip.save();

    return res.status(200).json({
      success: true,
      message: 'Payment recorded.',
      data: trip.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record the payment');
  }
};

/**
 * PATCH /api/trips/:id/participants/:pid/attendance
 * Marking the roll at the meeting point. `attended` and `absent` both keep the
 * seat — the child was expected either way, and the record should say so.
 */
exports.markAttendance = async (req, res) => {
  try {
    const { id, pid } = req.params;
    const { present } = req.body;

    if (!isValidId(id) || !isValidId(pid)) {
      return fail(res, 400, 'Invalid trip or participant id.');
    }

    const trip = await FieldTrip.findById(id);
    if (!trip) return fail(res, 404, 'Trip not found.');
    if (!trip.isEscort(req.user._id) && !isAdmin(req.user)) {
      return fail(res, 403, 'Only an escort on this trip can mark the roll.');
    }

    const participant = trip.participants.id(pid);
    if (!participant) return fail(res, 404, 'That registration is not on this trip.');
    if (participant.status === 'withdrawn') {
      return fail(res, 409, 'That child withdrew from the trip.');
    }

    participant.status = present === false ? 'absent' : 'attended';
    participant.attendanceMarkedAt = new Date();
    await trip.save();

    return res.status(200).json({
      success: true,
      message: `${participant.studentName} marked ${participant.status}.`,
      data: trip.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to mark attendance');
  }
};

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/**
 * GET /api/trips/:id/manifest
 *
 * The escort's roll call: every child travelling, with the medical brief, the
 * dietary notes and the emergency numbers, ordered for reading aloud.
 *
 * This is the only endpoint that emits another family's medical information,
 * which is why the access check is on the trip's own escort list rather than on
 * a role. A teacher who is not travelling has no reason to hold it.
 */
exports.getManifest = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid trip id.');

    const trip = await FieldTrip.findById(req.params.id);
    if (!trip) return fail(res, 404, 'Trip not found.');
    if (!trip.isEscort(req.user._id) && !isAdmin(req.user)) {
      return fail(res, 403, 'Only the organiser, an escort or an admin can read the manifest.');
    }

    const rows = trip
      .activeParticipants()
      .map((participant) => ({
        participantId: participant._id,
        studentName: participant.studentName,
        className: participant.className,
        guardianName: participant.guardianName,
        guardianContact: participant.guardianContact,
        emergencyContactNumber: participant.emergencyContactNumber,
        medicalNotes: participant.medicalNotes,
        dietaryNotes: participant.dietaryNotes,
        medicalTreatmentConsent: participant.consent?.medicalTreatmentConsent,
        photographyConsent: participant.consent?.photographyConsent,
        consentGivenAt: participant.consent?.givenAt,
        consentSignedBy: participant.consent?.guardianTypedName,
        paymentStatus: participant.paymentStatus,
        status: participant.status,
      }))
      .sort(
        (a, b) =>
          a.className.localeCompare(b.className) ||
          a.studentName.localeCompare(b.studentName)
      );

    return res.status(200).json({
      success: true,
      trip: {
        _id: trip._id,
        title: trip.title,
        destination: trip.destination,
        departureDate: trip.departureDate,
        departureTime: trip.departureTime,
        meetingPoint: trip.meetingPoint,
        emergencyContact: trip.emergencyContact,
        escorts: trip.staffEscorts,
      },
      summary: {
        travelling: rows.length,
        withMedicalNotes: rows.filter((row) => row.medicalNotes).length,
        withoutMedicalTreatmentConsent: rows.filter(
          (row) => row.medicalTreatmentConsent === false
        ).length,
        unpaid: rows.filter((row) => row.paymentStatus === 'pending').length,
      },
      count: rows.length,
      data: rows,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build the manifest');
  }
};

/**
 * GET /api/trips/my-registrations
 */
exports.getMyRegistrations = async (req, res) => {
  try {
    const trips = await FieldTrip.find({
      'participants.registeredBy': req.user._id,
    })
      .sort({ departureDate: -1 })
      .limit(200);

    const rows = [];
    for (const trip of trips) {
      for (const participant of trip.participants) {
        if (String(participant.registeredBy) !== String(req.user._id)) continue;
        rows.push({
          tripId: trip._id,
          participantId: participant._id,
          title: trip.title,
          destination: trip.destination,
          departureDate: trip.departureDate,
          departureTime: trip.departureTime,
          meetingPoint: trip.meetingPoint,
          tripStatus: trip.status,
          cancelReason: trip.cancelReason,
          costPerStudent: trip.costPerStudent,
          studentName: participant.studentName,
          className: participant.className,
          status: participant.status,
          paymentStatus: participant.paymentStatus,
          consentGivenAt: participant.consent?.givenAt,
          consentSignedBy: participant.consent?.guardianTypedName,
          canWithdraw:
            ACTIVE.includes(participant.status) && trip.withdrawalError() === null,
        });
      }
    }

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch your registrations');
  }
};

/**
 * GET /api/trips/stats
 */
exports.getStats = async (req, res) => {
  try {
    const filter = isAdmin(req.user) ? {} : { organiser: req.user._id };
    const trips = await FieldTrip.find(filter).select(
      'status purpose capacity confirmedCount costPerStudent participants departureDate'
    );

    const byStatus = {};
    const byPurpose = {};
    let seats = 0;
    let taken = 0;
    let unpaid = 0;
    let withMedicalNotes = 0;

    for (const trip of trips) {
      byStatus[trip.status] = (byStatus[trip.status] || 0) + 1;
      byPurpose[trip.purpose] = (byPurpose[trip.purpose] || 0) + 1;
      if (trip.status !== 'cancelled') {
        seats += trip.capacity;
        taken += trip.confirmedCount;
      }
      for (const participant of trip.participants) {
        if (!ACTIVE.includes(participant.status)) continue;
        if (participant.paymentStatus === 'pending') unpaid += 1;
        if (participant.medicalNotes) withMedicalNotes += 1;
      }
    }

    return res.status(200).json({
      success: true,
      stats: {
        trips: trips.length,
        byStatus,
        byPurpose,
        seats,
        taken,
        fillRate: seats > 0 ? Math.round((taken / seats) * 100) : 0,
        unpaid,
        withMedicalNotes,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build the trip statistics');
  }
};
