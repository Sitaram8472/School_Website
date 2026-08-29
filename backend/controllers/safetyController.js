const mongoose = require('mongoose');
const SafetyEvent = require('../models/SafetyEvent');

/**
 * Emergency drills and safety incidents.
 *
 * If only one handler in this file is reviewed, review `closeEvent`. Everything
 * else is a form; that one is the rule.
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

function isAdmin(user) {
  return user && user.role === 'admin';
}

function canCoordinate(event, user) {
  return event.isCoordinator(user._id) || isAdmin(user);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * POST /api/safety/events
 *
 * A drill is created `planned`; a real incident is created already
 * `in-progress` with the alarm stamped, because nobody is going to plan one and
 * then press start.
 */
exports.createEvent = async (req, res) => {
  try {
    const { eventType, incidentCategory, title, date, assemblyPoints } = req.body;

    if (!SafetyEvent.EVENT_TYPES.includes(eventType)) {
      return fail(
        res,
        400,
        `eventType must be one of: ${SafetyEvent.EVENT_TYPES.join(', ')}.`
      );
    }

    const isIncident = eventType === 'real-incident';
    if (isIncident && !SafetyEvent.INCIDENT_CATEGORIES.includes(incidentCategory)) {
      return fail(
        res,
        400,
        `A real incident needs a category: ${SafetyEvent.INCIDENT_CATEGORIES.join(', ')}.`
      );
    }

    const event = await SafetyEvent.create({
      eventType,
      incidentCategory: isIncident ? incidentCategory : null,
      title,
      date: date || SafetyEvent.todayKey(),
      assemblyPoints: Array.isArray(assemblyPoints) ? assemblyPoints : [],
      coordinator: req.user._id,
      coordinatorName: req.user.name,
      status: isIncident ? 'in-progress' : 'planned',
      alarmRaisedAt: isIncident ? new Date() : null,
      // Roll calls, timings and every derived count are server-owned.
    });

    return res.status(201).json({
      success: true,
      message: isIncident
        ? 'Incident opened. The clock is running.'
        : 'Drill scheduled. Record the expected headcounts before the alarm.',
      data: event.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to open the event');
  }
};

/**
 * GET /api/safety/events
 */
exports.listEvents = async (req, res) => {
  try {
    const { eventType, status, from, to, unresolvedOnly } = req.query;

    const filter = {};
    if (eventType) filter.eventType = eventType;
    if (status) filter.status = status;
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = from;
      if (to) filter.date.$lte = to;
    }

    let events = await SafetyEvent.find(filter).sort({ date: -1 }).limit(200);

    if (unresolvedOnly === 'true') {
      events = events.filter((event) => event.outstandingCount > 0);
    }

    return res.status(200).json({
      success: true,
      count: events.length,
      data: events.map((event) => event.redactFor(req.user)),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch safety events');
  }
};

/**
 * GET /api/safety/events/:id
 */
exports.getEvent = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid event id.');

    const event = await SafetyEvent.findById(req.params.id);
    if (!event) return fail(res, 404, 'Event not found.');

    return res.status(200).json({
      success: true,
      data: {
        ...event.redactFor(req.user),
        closureBlockedBecause: event.closureError(),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the event');
  }
};

/**
 * PATCH /api/safety/events/:id
 * Editable only while planned. Once the alarm has gone the record is evidence.
 */
exports.updateEvent = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid event id.');

    const event = await SafetyEvent.findById(req.params.id);
    if (!event) return fail(res, 404, 'Event not found.');
    if (!canCoordinate(event, req.user)) {
      return fail(res, 403, 'Only the coordinator or an admin can edit this event.');
    }
    if (event.status !== 'planned') {
      return fail(
        res,
        409,
        'This event has already started. Its record can be added to, but not rewritten.'
      );
    }

    for (const field of ['title', 'date', 'assemblyPoints', 'incidentCategory']) {
      if (req.body[field] !== undefined) event[field] = req.body[field];
    }
    await event.save();

    return res.status(200).json({
      success: true,
      message: 'Event updated.',
      data: event.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update the event');
  }
};

/**
 * PATCH /api/safety/events/:id/start
 *
 * Stamps `alarmRaisedAt` server-side, which is what makes every timing on this
 * event a measurement rather than a claim. Conditional on the event still being
 * planned, so a second tap cannot restart the clock and shrink the evacuation
 * time.
 */
exports.startEvent = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid event id.');

    const event = await SafetyEvent.findOneAndUpdate(
      { _id: req.params.id, status: 'planned' },
      { $set: { status: 'in-progress', alarmRaisedAt: new Date() } },
      { new: true }
    );

    if (!event) return fail(res, 409, 'That event is not waiting to start.');

    return res.status(200).json({
      success: true,
      message: 'Alarm raised. The clock is running.',
      data: event.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to start the event');
  }
};

// ---------------------------------------------------------------------------
// Roll calls
// ---------------------------------------------------------------------------

/**
 * POST /api/safety/events/:id/roll-calls
 *
 * Submitted per class by the class teacher, so the counts arrive in parallel
 * rather than through one person with a clipboard. `unaccountedCount` is
 * recomputed in the model's pre-validate hook from expected − present −
 * authorised absences, and the named list has to agree with it; a roll call
 * that says everybody is present while naming two missing children is refused
 * rather than filed.
 *
 * Resubmission replaces the class's earlier roll call, because a recount under
 * pressure is normal and the alternative is two rows for the same class.
 */
exports.submitRollCall = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid event id.');

    const event = await SafetyEvent.findById(req.params.id);
    if (!event) return fail(res, 404, 'Event not found.');
    if (event.status !== 'in-progress' && event.status !== 'reconciled') {
      return fail(res, 409, 'That event is not taking roll calls.');
    }

    const {
      className,
      assemblyPoint,
      expectedCount,
      presentCount,
      absentPreAuthorised,
      unaccounted,
      notes,
    } = req.body;

    if (!className || String(className).trim() === '') {
      return fail(res, 400, 'Say which class this roll call is for.');
    }

    const names = (Array.isArray(unaccounted) ? unaccounted : []).map((entry) => ({
      studentName: typeof entry === 'string' ? entry : entry.studentName,
      note: typeof entry === 'string' ? null : entry.note || null,
    }));

    const existing = event.rollCalls.find(
      (rollCall) => rollCall.className === String(className).trim()
    );

    // A resolved entry is a fact about what happened to a child; a recount must
    // not quietly discard it. Anybody already resolved keeps their resolution.
    const resolvedBefore = existing
      ? existing.unaccounted.filter((entry) => entry.resolvedAt)
      : [];

    const merged = names.map((entry) => {
      const previous = resolvedBefore.find(
        (old) => old.studentName === entry.studentName
      );
      return previous ? previous.toObject() : entry;
    });

    const payload = {
      className: String(className).trim(),
      assemblyPoint: assemblyPoint || null,
      expectedCount: Number(expectedCount),
      presentCount: Number(presentCount),
      absentPreAuthorised: Number(absentPreAuthorised) || 0,
      unaccounted: merged,
      reportedBy: req.user._id,
      reporterName: req.user.name,
      reportedAt: new Date(),
      notes: notes || null,
    };

    if (existing) {
      existing.set(payload);
    } else {
      event.rollCalls.push(payload);
    }

    // Reaching "everybody reported and nobody missing" is a state the event
    // arrives at, not a button somebody presses.
    if (event.isReconciled() && event.status === 'in-progress') {
      event.status = 'reconciled';
    } else if (!event.isReconciled() && event.status === 'reconciled') {
      event.status = 'in-progress';
    }

    await event.save();

    return res.status(201).json({
      success: true,
      message: event.isReconciled()
        ? 'Roll call recorded. Everybody is accounted for.'
        : `Roll call recorded. ${event.outstandingCount} still unaccounted for.`,
      data: event.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record the roll call');
  }
};

/**
 * PATCH /api/safety/events/:id/roll-calls/:rollCallId/unaccounted/:entryId/resolve
 *
 * The resolution note is mandatory and is the actual record. "Was at the
 * dentist, confirmed with the office" and "found in the music room, escorted
 * out" are different facts, and flattening both to a tick produces the report
 * that is useless in an inquiry.
 */
exports.resolveUnaccounted = async (req, res) => {
  try {
    const { id, rollCallId, entryId } = req.params;
    const { resolutionNote } = req.body;

    if (!isValidId(id) || !isValidId(rollCallId) || !isValidId(entryId)) {
      return fail(res, 400, 'Invalid event, roll call or entry id.');
    }
    if (!resolutionNote || String(resolutionNote).trim().length < 5) {
      return fail(
        res,
        400,
        'Say what happened to this person — at least 5 characters. This note is the record.'
      );
    }

    const event = await SafetyEvent.findById(id);
    if (!event) return fail(res, 404, 'Event not found.');

    const rollCall = event.rollCalls.id(rollCallId);
    if (!rollCall) return fail(res, 404, 'That roll call is not part of this event.');

    const entry = rollCall.unaccounted.id(entryId);
    if (!entry) return fail(res, 404, 'That person is not on the unaccounted list.');
    if (entry.resolvedAt) {
      return fail(res, 409, `${entry.studentName} has already been accounted for.`);
    }

    entry.resolvedAt = new Date();
    entry.resolutionNote = resolutionNote;
    entry.resolvedBy = req.user._id;
    entry.resolvedByName = req.user.name;

    if (event.isReconciled() && event.status === 'in-progress') {
      event.status = 'reconciled';
    }

    await event.save();

    return res.status(200).json({
      success: true,
      message: event.isReconciled()
        ? `${entry.studentName} accounted for. Everybody is now accounted for.`
        : `${entry.studentName} accounted for. ${event.outstandingCount} to go.`,
      data: event.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record that resolution');
  }
};

/**
 * GET /api/safety/events/:id/board
 *
 * The live board. During a real incident this is the only screen anybody needs:
 * who has not reported, and who is missing.
 */
exports.getBoard = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid event id.');

    const event = await SafetyEvent.findById(req.params.id);
    if (!event) return fail(res, 404, 'Event not found.');
    if (!canCoordinate(event, req.user)) {
      return fail(res, 403, 'Only the coordinator or an admin can open the board.');
    }

    // Classes the coordinator listed as expected minus those that have
    // reported. Where no list was given, the board can only show what has come
    // in — and says so, rather than implying everything is in.
    const expectedClasses = Array.isArray(req.query.classes)
      ? req.query.classes
      : String(req.query.classes || '')
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);

    const reported = event.rollCalls.map((rollCall) => rollCall.className);
    const awaiting = expectedClasses.filter((className) => !reported.includes(className));

    return res.status(200).json({
      success: true,
      event: {
        _id: event._id,
        title: event.title,
        eventType: event.eventType,
        status: event.status,
        alarmRaisedAt: event.alarmRaisedAt,
        allClearAt: event.allClearAt,
        evacuationSeconds: event.evacuationSeconds,
        reconciliationSeconds: event.reconciliationSeconds,
      },
      summary: {
        classesReported: event.classesReported,
        awaitingReport: awaiting.length,
        classListProvided: expectedClasses.length > 0,
        totalExpected: event.totalExpected,
        totalPresent: event.totalPresent,
        outstanding: event.outstandingCount,
        reconciled: event.isReconciled(),
      },
      awaiting,
      unaccounted: event.outstandingUnaccounted(),
      rollCalls: event.rollCalls.map((rollCall) => ({
        rollCallId: rollCall._id,
        className: rollCall.className,
        assemblyPoint: rollCall.assemblyPoint,
        expectedCount: rollCall.expectedCount,
        presentCount: rollCall.presentCount,
        absentPreAuthorised: rollCall.absentPreAuthorised,
        unaccountedCount: rollCall.unaccountedCount,
        outstanding: rollCall.unaccounted.filter((entry) => !entry.resolvedAt).length,
        reporterName: rollCall.reporterName,
        reportedAt: rollCall.reportedAt,
        notes: rollCall.notes,
      })),
      closureBlockedBecause: event.closureError(),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build the board');
  }
};

// ---------------------------------------------------------------------------
// Observations and actions
// ---------------------------------------------------------------------------

/**
 * POST /api/safety/events/:id/observations
 */
exports.addObservation = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid event id.');

    const { severity, area, note } = req.body;

    const event = await SafetyEvent.findById(req.params.id);
    if (!event) return fail(res, 404, 'Event not found.');
    if (event.status === 'closed' || event.status === 'cancelled') {
      return fail(res, 409, 'That event is closed.');
    }

    event.observations.push({
      severity,
      area,
      note,
      raisedBy: req.user._id,
      raisedByName: req.user.name,
    });
    await event.save();

    return res.status(201).json({
      success: true,
      message: 'Observation recorded.',
      data: event.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record the observation');
  }
};

/**
 * POST /api/safety/events/:id/actions
 *
 * An action needs an owner and a due date. A drill that produces "the west
 * stairwell door sticks" and nothing else is a drill that will produce it again
 * next term.
 */
exports.addAction = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid event id.');

    const { description, owner, ownerName, dueDate } = req.body;

    const event = await SafetyEvent.findById(req.params.id);
    if (!event) return fail(res, 404, 'Event not found.');
    if (!canCoordinate(event, req.user)) {
      return fail(res, 403, 'Only the coordinator or an admin can raise actions.');
    }
    if (event.status === 'cancelled') {
      return fail(res, 409, 'That event was cancelled.');
    }
    if (owner !== undefined && owner !== null && !isValidId(owner)) {
      return fail(res, 400, 'Invalid owner id.');
    }

    event.actions.push({
      description,
      owner: owner || null,
      ownerName: ownerName || null,
      dueDate: dueDate || null,
    });
    await event.save();

    return res.status(201).json({
      success: true,
      message: 'Action added.',
      data: event.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to add the action');
  }
};

/**
 * PATCH /api/safety/events/:id/actions/:actionId
 */
exports.updateAction = async (req, res) => {
  try {
    const { id, actionId } = req.params;
    const { status, completionNote, dueDate } = req.body;

    if (!isValidId(id) || !isValidId(actionId)) {
      return fail(res, 400, 'Invalid event or action id.');
    }

    const event = await SafetyEvent.findById(id);
    if (!event) return fail(res, 404, 'Event not found.');

    const action = event.actions.id(actionId);
    if (!action) return fail(res, 404, 'That action is not on this event.');

    const isOwner = action.owner && String(action.owner) === String(req.user._id);
    if (!isOwner && !canCoordinate(event, req.user)) {
      return fail(res, 403, 'That action is not yours to update.');
    }

    if (status !== undefined) {
      if (!SafetyEvent.ACTION_STATUSES.includes(status)) {
        return fail(
          res,
          400,
          `status must be one of: ${SafetyEvent.ACTION_STATUSES.join(', ')}.`
        );
      }
      if ((status === 'completed' || status === 'dropped') && !completionNote) {
        return fail(res, 400, 'Say what was done, or why it was dropped.');
      }
      action.status = status;
      action.completedAt = status === 'completed' ? new Date() : null;
    }
    if (completionNote !== undefined) action.completionNote = completionNote;
    if (dueDate !== undefined) action.dueDate = dueDate;

    await event.save();

    return res.status(200).json({
      success: true,
      message: 'Action updated.',
      data: event.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update the action');
  }
};

// ---------------------------------------------------------------------------
// All clear and closure
// ---------------------------------------------------------------------------

/**
 * PATCH /api/safety/events/:id/all-clear
 *
 * Refused while anybody is unaccounted for. Sounding the all-clear over a
 * missing child is the outcome this whole module is arranged to prevent, and
 * the check is the same one that guards closure.
 */
exports.soundAllClear = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid event id.');

    const event = await SafetyEvent.findById(req.params.id);
    if (!event) return fail(res, 404, 'Event not found.');
    if (!canCoordinate(event, req.user)) {
      return fail(res, 403, 'Only the coordinator or an admin can sound the all-clear.');
    }

    const blocked = event.closureError();
    if (blocked) {
      return fail(res, 409, blocked, { unaccounted: event.outstandingUnaccounted() });
    }
    if (event.allClearAt) {
      return fail(res, 409, 'The all-clear has already been given.');
    }

    event.allClearAt = new Date();
    event.status = 'reconciled';
    await event.save();

    return res.status(200).json({
      success: true,
      message: 'All clear. Everybody is accounted for.',
      data: event.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to sound the all-clear');
  }
};

/**
 * PATCH /api/safety/events/:id/close
 *
 * The rule the feature exists for.
 *
 * There is no `force` flag and no admin bypass. If anybody is still
 * unaccounted for the request is refused with their names, and the only way
 * forward is to resolve each one with a note. A system that can produce a clean
 * drill report while a child is unaccounted for is a system that produces the
 * document nobody can rely on afterwards.
 */
exports.closeEvent = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid event id.');

    const { outcome, closureNote } = req.body;

    const event = await SafetyEvent.findById(req.params.id);
    if (!event) return fail(res, 404, 'Event not found.');

    const blocked = event.closureError();
    if (blocked) {
      return fail(res, 409, blocked, { unaccounted: event.outstandingUnaccounted() });
    }

    if (!closureNote || String(closureNote).trim().length < 10) {
      return fail(res, 400, 'Write a closure note of at least 10 characters.');
    }

    event.status = 'closed';
    event.outcome = outcome || null;
    event.closureNote = closureNote;
    event.closedBy = req.user._id;
    event.closedAt = new Date();
    if (!event.allClearAt) event.allClearAt = new Date();

    await event.save();

    return res.status(200).json({
      success: true,
      message: `Event closed. ${event.openActionCount} action${
        event.openActionCount === 1 ? '' : 's'
      } still open.`,
      data: event.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to close the event');
  }
};

/**
 * PATCH /api/safety/events/:id/cancel
 * Only a drill that never started. A real incident happened whether or not
 * anybody wants it on the record.
 */
exports.cancelEvent = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid event id.');

    const { cancelReason } = req.body;
    if (!cancelReason || String(cancelReason).trim().length < 5) {
      return fail(res, 400, 'Give a reason of at least 5 characters.');
    }

    const event = await SafetyEvent.findById(req.params.id);
    if (!event) return fail(res, 404, 'Event not found.');
    if (event.status !== 'planned') {
      return fail(
        res,
        409,
        'Only a drill that has not started can be cancelled. An event that happened stays on the record.'
      );
    }

    event.status = 'cancelled';
    event.cancelReason = cancelReason;
    await event.save();

    return res.status(200).json({
      success: true,
      message: 'Drill cancelled.',
      data: event.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to cancel the event');
  }
};

/**
 * GET /api/safety/stats
 *
 * Drill frequency, evacuation times and the action backlog. The median
 * evacuation time is reported rather than the mean: one drill during a
 * thunderstorm should not move the number everybody is judged against.
 */
exports.getStats = async (req, res) => {
  try {
    const to = req.query.to || SafetyEvent.todayKey();
    const from = req.query.from || `${Number(to.slice(0, 4)) - 1}${to.slice(4)}`;

    const events = await SafetyEvent.find({ date: { $gte: from, $lte: to } });

    const byType = {};
    const times = [];
    let openActions = 0;
    let overdueActions = 0;
    let unresolved = 0;
    let criticalObservations = 0;

    for (const event of events) {
      byType[event.eventType] = (byType[event.eventType] || 0) + 1;
      if (event.evacuationSeconds !== null && event.status !== 'cancelled') {
        times.push(event.evacuationSeconds);
      }
      openActions += event.openActionCount;
      overdueActions += event.overdueActionCount;
      unresolved += event.outstandingCount;
      criticalObservations += event.observations.filter(
        (observation) => observation.severity === 'critical' || observation.severity === 'major'
      ).length;
    }

    times.sort((a, b) => a - b);
    const median =
      times.length === 0
        ? null
        : times.length % 2 === 1
          ? times[(times.length - 1) / 2]
          : Math.round((times[times.length / 2 - 1] + times[times.length / 2]) / 2);

    return res.status(200).json({
      success: true,
      window: { from, to },
      stats: {
        events: events.length,
        byType,
        drillsRun: events.filter((event) => event.isDrill && event.status === 'closed').length,
        medianEvacuationSeconds: median,
        slowestEvacuationSeconds: times.length ? times[times.length - 1] : null,
        openActions,
        overdueActions,
        stillUnaccountedFor: unresolved,
        majorObservations: criticalObservations,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build the safety statistics');
  }
};
