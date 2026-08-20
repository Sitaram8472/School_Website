const crypto = require('crypto');
const mongoose = require('mongoose');
const MeetingSlot = require('../models/MeetingSlot');

/**
 * Parent-teacher meeting slots.
 *
 * The one thing worth reading closely in this file is `bookSlot`. Everything
 * else is bookkeeping.
 */

const ACTIVE = MeetingSlot.ACTIVE_BOOKING_STATUSES;

/**
 * Booking references are random rather than sequential.
 *
 * A sequential reference needs a read of the current count before the write,
 * which is exactly the race the atomic capacity guard exists to avoid — it
 * would be odd to close the door on double-booking and then reopen it to hand
 * out a reference. Six hex characters inside one slot is not going to collide,
 * and the reference is a label for a human, not a key.
 */
function makeReference() {
  const year = new Date().getFullYear();
  return `PTM-${year}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function ownsSlot(slot, user) {
  return String(slot.teacher) === String(user._id) || user.role === 'admin';
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

/**
 * Mongoose validation errors carry every failed path; surfacing only the first
 * one is how you get a user fixing their form one field per submission.
 *
 * A single `ValidatorError` is handled too — see `validateSubdocument` for why
 * one can arrive here on its own.
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

/**
 * Validates a subdocument and returns the error rather than propagating it.
 *
 * A detached array subdocument does not have a parent to record the failure
 * against, so Mongoose throws the `ValidatorError` out of `validateSync()`
 * instead of returning a `ValidationError` the way a top-level document does.
 * Left uncaught that turns "your agenda is too short" into a 500.
 */
function validateSubdocument(doc) {
  try {
    return doc.validateSync() || null;
  } catch (error) {
    return error;
  }
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/**
 * POST /api/meetings/slots
 *
 * Publishes one slot, or a run of back-to-back slots when `repeat` is given —
 * a PTM afternoon is fifteen twenty-minute slots and nobody is filling that
 * form fifteen times.
 */
exports.createSlots = async (req, res) => {
  try {
    const {
      title,
      purpose,
      mode,
      location,
      date,
      startTime,
      endTime,
      capacity,
      bookingCutoffMinutes,
      cancellationCutoffMinutes,
      notesForParents,
      repeat,
    } = req.body;

    const startMinute = MeetingSlot.toMinutes(startTime);
    const endMinute = MeetingSlot.toMinutes(endTime);

    if (startMinute === null || endMinute === null) {
      return fail(res, 400, 'startTime and endTime must be in HH:MM format.');
    }
    if (endMinute <= startMinute) {
      return fail(res, 400, 'endTime must be after startTime.');
    }

    const repeatCount = Number.isInteger(repeat) ? repeat : 1;
    if (repeatCount < 1 || repeatCount > 30) {
      return fail(res, 400, 'repeat must be between 1 and 30.');
    }

    const duration = endMinute - startMinute;
    if (startMinute + duration * repeatCount > 24 * 60) {
      return fail(res, 400, 'The requested run of slots would spill past midnight.');
    }

    // Everything already on this teacher's calendar for that date, so the
    // overlap check is one query rather than one per slot.
    const existing = await MeetingSlot.find({
      teacher: req.user._id,
      date,
      status: { $ne: 'cancelled' },
    }).select('startMinute endMinute startTime endTime');

    const planned = [];
    for (let i = 0; i < repeatCount; i += 1) {
      const slotStart = startMinute + duration * i;
      const slotEnd = slotStart + duration;
      const candidate = { startMinute: slotStart, endMinute: slotEnd };

      const clash =
        existing.find((slot) => MeetingSlot.overlaps(slot, candidate)) ||
        planned.find((slot) => MeetingSlot.overlaps(slot, candidate));

      if (clash) {
        return fail(
          res,
          409,
          `That would clash with an existing slot at ${clash.startTime || formatMinutes(clash.startMinute)}. A teacher cannot be in two places at once.`
        );
      }
      planned.push(candidate);
    }

    const docs = planned.map((slot) => ({
      teacher: req.user._id,
      teacherName: req.user.name,
      title,
      purpose,
      mode,
      location,
      date,
      startTime: formatMinutes(slot.startMinute),
      endTime: formatMinutes(slot.endMinute),
      capacity,
      bookingCutoffMinutes,
      cancellationCutoffMinutes,
      notesForParents,
      // bookedCount, status and bookingClosesAt are deliberately absent — they
      // are server-owned and a client-supplied value is dropped here.
    }));

    const created = await MeetingSlot.create(docs);

    return res.status(201).json({
      success: true,
      message: `${created.length} slot${created.length === 1 ? '' : 's'} published.`,
      data: created.map((slot) => slot.redactFor(req.user)),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to publish meeting slots');
  }
};

function formatMinutes(minutes) {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * GET /api/meetings/slots/mine
 * The teacher's own calendar, bookings included.
 */
exports.getMySlots = async (req, res) => {
  try {
    const { date, status } = req.query;
    const filter = { teacher: req.user._id };
    if (date) filter.date = date;
    if (status) filter.status = status;

    const slots = await MeetingSlot.find(filter).sort({ date: 1, startMinute: 1 });

    return res.status(200).json({
      success: true,
      count: slots.length,
      data: slots.map((slot) => slot.redactFor(req.user)),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch your meeting slots');
  }
};

/**
 * GET /api/meetings/slots
 * The browse view. Returns seat counts; other families' bookings are stripped
 * by `redactFor`.
 */
exports.browseSlots = async (req, res) => {
  try {
    const { teacher, date, purpose, mode, availableOnly } = req.query;

    const filter = { status: { $in: ['open', 'full'] } };
    if (teacher && isValidId(teacher)) filter.teacher = teacher;
    if (date) filter.date = date;
    if (purpose) filter.purpose = purpose;
    if (mode) filter.mode = mode;

    // Past slots are noise on a booking page.
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    filter.date = filter.date || { $gte: todayKey };

    let slots = await MeetingSlot.find(filter)
      .sort({ date: 1, startMinute: 1 })
      .limit(300);

    if (availableOnly === 'true') {
      slots = slots.filter((slot) => slot.isBookable);
    }

    return res.status(200).json({
      success: true,
      count: slots.length,
      data: slots.map((slot) => ({
        ...slot.redactFor(req.user),
        unavailableReason: slot.bookabilityError(),
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch meeting slots');
  }
};

/**
 * GET /api/meetings/slots/:id
 */
exports.getSlot = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid slot id.');

    const slot = await MeetingSlot.findById(req.params.id);
    if (!slot) return fail(res, 404, 'Meeting slot not found.');

    return res.status(200).json({
      success: true,
      data: {
        ...slot.redactFor(req.user),
        unavailableReason: slot.bookabilityError(),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the meeting slot');
  }
};

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

/**
 * POST /api/meetings/slots/:id/book
 *
 * The capacity guard is the filter of a single `findOneAndUpdate`:
 *
 *   - `status: 'open'`                      not cancelled, closed or completed
 *   - `bookingClosesAt: { $gt: now }`       still inside the booking window
 *   - `$expr: bookedCount < capacity`       a seat is genuinely free
 *   - `bookings` has no active booking      one seat per family per slot
 *     by this user
 *
 * and the update pushes the booking and increments the counter. Read-compare-
 * write would let two parents tapping *Book* at the same instant both pass the
 * comparison before either writes; here the loser matches nothing and gets a
 * 409. The counter is what makes this expressible in one operation, which is
 * why `bookedCount` exists at all rather than `bookings.length`.
 */
exports.bookSlot = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid slot id.');

    const slot = await MeetingSlot.findById(req.params.id);
    if (!slot) return fail(res, 404, 'Meeting slot not found.');

    // Checked up front so the family gets the real reason rather than a bare
    // "could not book" from the atomic guard below. The guard is still the
    // authority — this is the error message, not the check.
    const blocked = slot.bookabilityError();
    if (blocked) return fail(res, 409, blocked);

    if (slot.findBookingFor(req.user._id)) {
      return fail(res, 409, 'You already have a booking for this slot.');
    }

    // A family holding two slots with the same teacher on the same afternoon
    // is almost always a mistake, and it costs another family a seat.
    //
    // Unlike the capacity guard this is a plain pre-check: it spans documents,
    // so it cannot be folded into the conditional update. Two requests racing
    // each other could both pass it. That is a far less likely and far less
    // damaging outcome than an overbooked slot, and it is visible to the
    // teacher, so it is left as a pre-check rather than reached for with a
    // transaction.
    const sameDay = await MeetingSlot.findOne({
      _id: { $ne: slot._id },
      teacher: slot.teacher,
      date: slot.date,
      status: { $ne: 'cancelled' },
      bookings: {
        $elemMatch: { requestedBy: req.user._id, status: { $in: ACTIVE } },
      },
    }).select('startTime endTime');

    if (sameDay) {
      return fail(
        res,
        409,
        `You already have a booking with this teacher on ${slot.date} at ${sameDay.startTime}.`
      );
    }

    const booking = slot.bookings.create({
      reference: makeReference(),
      requestedBy: req.user._id,
      requesterName: req.user.name,
      guardianName: req.body.guardianName,
      studentName: req.body.studentName,
      className: req.body.className,
      contactNumber: req.body.contactNumber,
      agenda: req.body.agenda,
      status: 'booked',
      bookedAt: new Date(),
    });

    // Validate the subdocument before it goes anywhere near the atomic update,
    // so a 400 for a missing agenda never consumes a seat.
    const invalid = validateSubdocument(booking);
    if (invalid) {
      return fail(res, 400, validationMessage(invalid) || 'That booking is not valid.');
    }

    const updated = await MeetingSlot.findOneAndUpdate(
      {
        _id: slot._id,
        status: 'open',
        bookingClosesAt: { $gt: new Date() },
        $expr: { $lt: ['$bookedCount', '$capacity'] },
        bookings: {
          $not: {
            $elemMatch: { requestedBy: req.user._id, status: { $in: ACTIVE } },
          },
        },
      },
      {
        $push: { bookings: booking.toObject() },
        $inc: { bookedCount: 1 },
      },
      { new: true }
    );

    if (!updated) {
      // Something changed between the read above and the write. Almost always
      // the last seat going to somebody else.
      const current = await MeetingSlot.findById(slot._id);
      return fail(
        res,
        409,
        current
          ? current.bookabilityError() || 'That seat was taken while you were booking.'
          : 'Meeting slot not found.'
      );
    }

    // Flip to `full` once the last seat goes, so the browse list can filter on
    // status. Conditional so it cannot race a cancellation back to `open`.
    if (updated.bookedCount >= updated.capacity) {
      await MeetingSlot.updateOne(
        { _id: updated._id, status: 'open', $expr: { $gte: ['$bookedCount', '$capacity'] } },
        { $set: { status: 'full' } }
      );
      updated.status = 'full';
    }

    return res.status(201).json({
      success: true,
      message: `Booked. Your reference is ${booking.reference}.`,
      data: updated.redactFor(req.user),
      reference: booking.reference,
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to book the meeting slot');
  }
};

/**
 * PATCH /api/meetings/slots/:id/bookings/:bookingId/cancel
 *
 * Either side may cancel. The seat is returned in the same update that closes
 * the booking, and the `$inc` is guarded on the booking still being active so
 * a double-tap cannot decrement the counter twice.
 */
exports.cancelBooking = async (req, res) => {
  try {
    const { id, bookingId } = req.params;
    if (!isValidId(id) || !isValidId(bookingId)) {
      return fail(res, 400, 'Invalid slot or booking id.');
    }

    const slot = await MeetingSlot.findById(id);
    if (!slot) return fail(res, 404, 'Meeting slot not found.');

    const booking = slot.bookings.id(bookingId);
    if (!booking) return fail(res, 404, 'Booking not found.');

    const isRequester = String(booking.requestedBy) === String(req.user._id);
    const isTeacher = ownsSlot(slot, req.user);

    if (!isRequester && !isTeacher) {
      return fail(res, 403, 'You can only cancel your own booking.');
    }
    if (!ACTIVE.includes(booking.status)) {
      return fail(res, 409, 'This booking is no longer active.');
    }
    if (booking.status !== 'booked') {
      return fail(res, 409, 'Attendance has already been recorded for this booking.');
    }

    // The teacher may cancel at any time — they are the one who has to be
    // there. A family is held to the cutoff.
    if (isRequester && !isTeacher) {
      const tooLate = slot.cancellationError();
      if (tooLate) return fail(res, 409, tooLate);
    }

    if (isTeacher && !isRequester && !req.body.reason) {
      return fail(res, 400, 'Please give a reason so the family knows why.');
    }

    const newStatus = isRequester ? 'cancelled-by-parent' : 'cancelled-by-teacher';

    const updated = await MeetingSlot.findOneAndUpdate(
      {
        _id: slot._id,
        bookings: { $elemMatch: { _id: booking._id, status: 'booked' } },
      },
      {
        $set: {
          'bookings.$[entry].status': newStatus,
          'bookings.$[entry].cancelledAt': new Date(),
          'bookings.$[entry].cancelReason': req.body.reason || null,
        },
        $inc: { bookedCount: -1 },
      },
      {
        new: true,
        arrayFilters: [{ 'entry._id': booking._id, 'entry.status': 'booked' }],
      }
    );

    if (!updated) {
      return fail(res, 409, 'This booking was already cancelled.');
    }

    // A seat came back, so the slot is bookable again.
    if (updated.status === 'full' && updated.bookedCount < updated.capacity) {
      await MeetingSlot.updateOne(
        { _id: updated._id, status: 'full', $expr: { $lt: ['$bookedCount', '$capacity'] } },
        { $set: { status: 'open' } }
      );
      updated.status = 'open';
    }

    return res.status(200).json({
      success: true,
      message: 'Booking cancelled.',
      data: updated.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to cancel the booking');
  }
};

/**
 * GET /api/meetings/my-bookings
 */
exports.getMyBookings = async (req, res) => {
  try {
    const slots = await MeetingSlot.find({
      'bookings.requestedBy': req.user._id,
    }).sort({ date: -1, startMinute: -1 });

    const bookings = [];
    slots.forEach((slot) => {
      slot.bookings
        .filter((booking) => String(booking.requestedBy) === String(req.user._id))
        .forEach((booking) => {
          bookings.push({
            ...booking.toObject(),
            slotId: slot._id,
            teacherName: slot.teacherName,
            title: slot.title,
            date: slot.date,
            startTime: slot.startTime,
            endTime: slot.endTime,
            mode: slot.mode,
            location: slot.location,
            slotStatus: slot.status,
            canCancel: booking.status === 'booked' && slot.cancellationError() === null,
          });
        });
    });

    return res.status(200).json({
      success: true,
      count: bookings.length,
      data: bookings,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch your bookings');
  }
};

// ---------------------------------------------------------------------------
// After the meeting
// ---------------------------------------------------------------------------

/**
 * PATCH /api/meetings/slots/:id/bookings/:bookingId/attendance
 *
 * Marking somebody a no-show before the meeting has finished is not a record,
 * it is a prediction, so this refuses until the slot has ended.
 */
exports.recordAttendance = async (req, res) => {
  try {
    const { id, bookingId } = req.params;
    const { status } = req.body;

    if (!isValidId(id) || !isValidId(bookingId)) {
      return fail(res, 400, 'Invalid slot or booking id.');
    }
    if (!['attended', 'no-show'].includes(status)) {
      return fail(res, 400, "status must be 'attended' or 'no-show'.");
    }

    const slot = await MeetingSlot.findById(id);
    if (!slot) return fail(res, 404, 'Meeting slot not found.');
    if (!ownsSlot(slot, req.user)) {
      return fail(res, 403, 'Only the teacher who published this slot can record attendance.');
    }
    if (!slot.hasEnded) {
      return fail(res, 409, 'Attendance can only be recorded once the meeting has finished.');
    }

    const booking = slot.bookings.id(bookingId);
    if (!booking) return fail(res, 404, 'Booking not found.');
    if (booking.status !== 'booked') {
      return fail(res, 409, `This booking is ${booking.status}; attendance cannot be recorded.`);
    }

    booking.status = status;
    slot.status = 'completed';
    await slot.save();

    return res.status(200).json({
      success: true,
      message: `Marked as ${status}.`,
      data: slot.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to record attendance');
  }
};

/**
 * PATCH /api/meetings/slots/:id/bookings/:bookingId/outcome
 * What was agreed. The family can read this — a meeting whose outcome only the
 * teacher remembers is a meeting that did not happen.
 */
exports.recordOutcome = async (req, res) => {
  try {
    const { id, bookingId } = req.params;
    const { outcomeNote } = req.body;

    if (!isValidId(id) || !isValidId(bookingId)) {
      return fail(res, 400, 'Invalid slot or booking id.');
    }
    if (!outcomeNote || !outcomeNote.trim()) {
      return fail(res, 400, 'outcomeNote cannot be empty.');
    }

    const slot = await MeetingSlot.findById(id);
    if (!slot) return fail(res, 404, 'Meeting slot not found.');
    if (!ownsSlot(slot, req.user)) {
      return fail(res, 403, 'Only the teacher who published this slot can record an outcome.');
    }

    const booking = slot.bookings.id(bookingId);
    if (!booking) return fail(res, 404, 'Booking not found.');
    if (!['attended', 'no-show'].includes(booking.status)) {
      return fail(res, 409, 'Record attendance before writing an outcome note.');
    }

    booking.outcomeNote = outcomeNote.trim();
    booking.outcomeRecordedAt = new Date();
    await slot.save();

    return res.status(200).json({
      success: true,
      message: 'Outcome recorded.',
      data: slot.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record the outcome');
  }
};

// ---------------------------------------------------------------------------
// Slot administration
// ---------------------------------------------------------------------------

/**
 * PATCH /api/meetings/slots/:id
 * Only the fields that are safe to change once families may already have
 * booked. Times are not among them — moving a slot under a family that has
 * arranged time off work is a cancellation, and should look like one.
 */
exports.updateSlot = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid slot id.');

    const slot = await MeetingSlot.findById(req.params.id);
    if (!slot) return fail(res, 404, 'Meeting slot not found.');
    if (!ownsSlot(slot, req.user)) {
      return fail(res, 403, 'You can only edit your own slots.');
    }
    if (['cancelled', 'completed'].includes(slot.status)) {
      return fail(res, 409, `A ${slot.status} slot cannot be edited.`);
    }

    const { location, notesForParents, capacity, closed } = req.body;

    if (location !== undefined) slot.location = location;
    if (notesForParents !== undefined) slot.notesForParents = notesForParents;

    if (capacity !== undefined) {
      if (capacity < slot.bookedCount) {
        return fail(
          res,
          409,
          `There are already ${slot.bookedCount} bookings; capacity cannot be reduced below that.`
        );
      }
      slot.capacity = capacity;
    }

    if (closed !== undefined) {
      slot.status = closed ? 'closed' : 'open';
    }

    // Keep `full` honest after a capacity change.
    if (slot.status === 'open' && slot.bookedCount >= slot.capacity) slot.status = 'full';
    if (slot.status === 'full' && slot.bookedCount < slot.capacity) slot.status = 'open';

    await slot.save();

    return res.status(200).json({
      success: true,
      message: 'Slot updated.',
      data: slot.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update the slot');
  }
};

/**
 * PATCH /api/meetings/slots/:id/cancel
 * Cancels the slot and every live booking on it, with a reason the families
 * can read.
 */
exports.cancelSlot = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid slot id.');

    const { reason } = req.body;
    if (!reason || !reason.trim()) {
      return fail(res, 400, 'A cancellation reason is required.');
    }

    const slot = await MeetingSlot.findById(req.params.id);
    if (!slot) return fail(res, 404, 'Meeting slot not found.');
    if (!ownsSlot(slot, req.user)) {
      return fail(res, 403, 'You can only cancel your own slots.');
    }
    if (slot.status === 'cancelled') {
      return fail(res, 409, 'This slot is already cancelled.');
    }
    if (slot.status === 'completed') {
      return fail(res, 409, 'A completed slot cannot be cancelled.');
    }

    let released = 0;
    slot.bookings.forEach((booking) => {
      if (booking.status === 'booked') {
        booking.status = 'cancelled-by-teacher';
        booking.cancelledAt = new Date();
        booking.cancelReason = reason.trim();
        released += 1;
      }
    });

    slot.status = 'cancelled';
    slot.cancelReason = reason.trim();
    slot.cancelledAt = new Date();
    slot.bookedCount = 0;
    await slot.save();

    return res.status(200).json({
      success: true,
      message: `Slot cancelled; ${released} booking${released === 1 ? '' : 's'} released.`,
      data: slot.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to cancel the slot');
  }
};

/**
 * DELETE /api/meetings/slots/:id
 * Only for slots nobody booked. A slot with live bookings has to be cancelled
 * with a reason instead, so the families involved are told something.
 */
exports.deleteSlot = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid slot id.');

    const slot = await MeetingSlot.findById(req.params.id);
    if (!slot) return fail(res, 404, 'Meeting slot not found.');
    if (!ownsSlot(slot, req.user)) {
      return fail(res, 403, 'You can only delete your own slots.');
    }
    if (slot.activeBookings().length > 0) {
      return fail(
        res,
        409,
        'This slot has bookings. Cancel it with a reason instead of deleting it.'
      );
    }

    await slot.deleteOne();

    return res.status(200).json({ success: true, message: 'Slot deleted.' });
  } catch (error) {
    return serverError(res, error, 'Failed to delete the slot');
  }
};

/**
 * GET /api/meetings/stats
 */
exports.getStats = async (req, res) => {
  try {
    const filter = req.user.role === 'admin' ? {} : { teacher: req.user._id };
    const slots = await MeetingSlot.find(filter).select(
      'status capacity bookedCount bookings date'
    );

    const stats = {
      totalSlots: slots.length,
      openSlots: 0,
      fullSlots: 0,
      cancelledSlots: 0,
      seatsOffered: 0,
      seatsBooked: 0,
      attended: 0,
      noShows: 0,
      cancelledByParents: 0,
      cancelledByTeachers: 0,
    };

    slots.forEach((slot) => {
      if (slot.status === 'open') stats.openSlots += 1;
      if (slot.status === 'full') stats.fullSlots += 1;
      if (slot.status === 'cancelled') stats.cancelledSlots += 1;
      if (slot.status !== 'cancelled') {
        stats.seatsOffered += slot.capacity;
        stats.seatsBooked += slot.bookedCount;
      }
      slot.bookings.forEach((booking) => {
        if (booking.status === 'attended') stats.attended += 1;
        if (booking.status === 'no-show') stats.noShows += 1;
        if (booking.status === 'cancelled-by-parent') stats.cancelledByParents += 1;
        if (booking.status === 'cancelled-by-teacher') stats.cancelledByTeachers += 1;
      });
    });

    stats.utilisation =
      stats.seatsOffered > 0
        ? Math.round((stats.seatsBooked / stats.seatsOffered) * 100)
        : 0;

    const decided = stats.attended + stats.noShows;
    stats.attendanceRate = decided > 0 ? Math.round((stats.attended / decided) * 100) : null;

    return res.status(200).json({ success: true, stats });
  } catch (error) {
    return serverError(res, error, 'Failed to compute meeting statistics');
  }
};
