const mongoose = require('mongoose');
const LessonObservation = require('../models/LessonObservation');
const User = require('../models/User');

/**
 * Lesson observation and teaching appraisal.
 *
 * Three handlers carry the feature.
 *
 * `getObservation` never reaches for the raw document. Everything leaves
 * through `toDetailFor(req.user)`, which redacts by status in one place — a
 * gate every handler has to remember is a gate one handler forgets.
 *
 * `shareFeedback` is the transition the whole module is built around. It is
 * refused without a scored domain and without an agreed action, because
 * feedback with no action is a conversation and a year of them is what the
 * school has now.
 *
 * `acknowledge` is restricted to the observee alone. Acknowledgement is the
 * record that the conversation happened, so nobody may produce it on somebody
 * else's behalf — not the observer, and not an admin.
 */

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

function ok(res, data, extra = {}) {
  return res.status(200).json({ success: true, data, ...extra });
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

function parseDate(value, fieldLabel) {
  if (value === undefined || value === null || value === '') return { value: undefined };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { error: `${fieldLabel} is not a valid date` };
  }
  return { value: date };
}

/** The academic year containing `date`, in the school's 2026-27 form. */
function academicYearFor(date = new Date()) {
  const year = date.getFullYear();
  // The year turns over in August, which is when a school year does.
  const startYear = date.getMonth() >= 7 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Whether `user` may read this observation at all, before any redaction. */
function canRead(observation, user) {
  return (
    isAdmin(user) ||
    observation.isObserver(user) ||
    observation.isObservee(user) ||
    (observation.moderation && String(observation.moderation.moderator) === String(user._id))
  );
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/**
 * GET /api/observations/meta
 */
exports.getMeta = async (req, res) => {
  try {
    return ok(res, {
      cycles: LessonObservation.CYCLES,
      statuses: LessonObservation.STATUSES,
      domainKeys: LessonObservation.DOMAIN_KEYS,
      domainLabels: LessonObservation.DOMAIN_LABELS,
      scoreLabels: LessonObservation.SCORE_LABELS,
      actionStatuses: LessonObservation.ACTION_STATUSES,
      minScore: LessonObservation.MIN_SCORE,
      maxScore: LessonObservation.MAX_SCORE,
      maxActions: LessonObservation.MAX_ACTIONS,
      currentAcademicYear: academicYearFor(),
    });
  } catch (error) {
    return serverError(res, error, 'Could not load observation reference data');
  }
};

// ---------------------------------------------------------------------------
// Scheduling and recording
// ---------------------------------------------------------------------------

/**
 * POST /api/observations
 */
exports.scheduleObservation = async (req, res) => {
  try {
    const {
      observeeId,
      courseId,
      subject,
      yearGroup,
      cycle,
      scheduledFor,
      focusAreas,
      academicYear,
    } = req.body;

    if (!isValidId(observeeId)) return fail(res, 400, 'Invalid teacher id');

    const observee = await User.findById(observeeId).select('name role');
    if (!observee) return fail(res, 404, 'That person does not have an account');
    if (observee.role === 'student') {
      return fail(res, 400, 'Lesson observations are of teaching staff');
    }

    // Refused here as well as in the schema, so the caller gets a sentence
    // rather than a validation blob.
    if (String(observee._id) === String(req.user._id)) {
      return fail(res, 400, 'An observation must be carried out by somebody else');
    }

    const scheduled = parseDate(scheduledFor, 'Scheduled date');
    if (scheduled.error) return fail(res, 400, scheduled.error);
    if (!scheduled.value) return fail(res, 400, 'A date is required');

    const observation = new LessonObservation({
      observee: observee._id,
      observer: req.user._id,
      course: isValidId(courseId) ? courseId : undefined,
      subject,
      yearGroup,
      cycle,
      academicYear: academicYear || academicYearFor(scheduled.value),
      scheduledFor: scheduled.value,
      focusAreas: Array.isArray(focusAreas)
        ? focusAreas.filter((key) => LessonObservation.DOMAIN_KEYS.includes(key))
        : [],
      status: 'scheduled',
    });

    observation.recordHistory({
      action: 'scheduled',
      to: 'scheduled',
      by: req.user._id,
      note: `For ${scheduled.value.toISOString().slice(0, 10)}`,
    });

    await observation.save();

    return res.status(201).json({
      success: true,
      message: `Observation of ${observee.name} scheduled`,
      data: observation.toDetailFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not schedule the observation');
  }
};

/**
 * PATCH /api/observations/:id
 *
 * The lesson particulars, before anything has been shared. Scores are not
 * here — they go through `/record`, which is a different act.
 */
exports.updateObservation = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid observation id');

    const observation = await LessonObservation.findById(id);
    if (!observation) return fail(res, 404, 'Observation not found');

    if (!observation.isObserver(req.user) && !isAdmin(req.user)) {
      return fail(res, 403, 'Only the observer can edit this observation');
    }
    if (observation.isShared()) {
      return fail(
        res,
        409,
        'This observation has been shared. Corrections are appended rather than typed over.'
      );
    }

    const changed = [];
    for (const field of ['subject', 'yearGroup', 'cycle', 'lessonDuration', 'pupilCount']) {
      if (req.body[field] === undefined) continue;
      observation[field] = req.body[field];
      changed.push(field);
    }

    if (req.body.scheduledFor !== undefined) {
      const scheduled = parseDate(req.body.scheduledFor, 'Scheduled date');
      if (scheduled.error) return fail(res, 400, scheduled.error);
      observation.scheduledFor = scheduled.value;
      changed.push('scheduledFor');
    }

    if (Array.isArray(req.body.focusAreas)) {
      observation.focusAreas = req.body.focusAreas.filter((key) =>
        LessonObservation.DOMAIN_KEYS.includes(key)
      );
      changed.push('focusAreas');
    }

    if (!changed.length) return fail(res, 400, 'Nothing to update');

    observation.recordHistory({
      action: 'updated',
      by: req.user._id,
      note: `Changed ${changed.join(', ')}`,
    });

    await observation.save();
    return ok(res, observation.toDetailFor(req.user), { message: 'Observation updated' });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not update the observation');
  }
};

/**
 * PATCH /api/observations/:id/record
 *
 * Domain scores and evidence. Replaces the domain array wholesale rather than
 * merging, so a domain removed from the form is removed from the record — a
 * merge would leave an orphaned score contributing to the mean forever.
 */
exports.recordObservation = async (req, res) => {
  try {
    const { id } = req.params;
    const { domains, observedAt, lessonDuration, pupilCount } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid observation id');

    const observation = await LessonObservation.findById(id);
    if (!observation) return fail(res, 404, 'Observation not found');

    if (!observation.isObserver(req.user)) {
      return fail(res, 403, 'Only the observer can record this observation');
    }
    if (observation.isShared()) {
      return fail(res, 409, 'This observation has already been shared and cannot be rescored');
    }
    if (observation.status === 'cancelled') {
      return fail(res, 409, 'This observation was cancelled');
    }

    if (!Array.isArray(domains) || !domains.length) {
      return fail(res, 400, 'Score at least one domain');
    }

    const built = [];
    const seen = new Set();

    for (const entry of domains) {
      const key = String(entry.key);
      if (!LessonObservation.DOMAIN_KEYS.includes(key)) {
        return fail(res, 400, `Unknown observation domain: ${key}`);
      }
      if (seen.has(key)) {
        return fail(res, 400, `The ${key} domain was scored twice`);
      }
      seen.add(key);

      // A domain may carry notes and no score. That is a real state — the
      // observer saw something worth writing down and is not yet ready to
      // grade it — and it must not silently become a zero.
      const score =
        entry.score === undefined || entry.score === null || entry.score === ''
          ? undefined
          : Number(entry.score);

      if (score !== undefined) {
        if (
          !Number.isInteger(score) ||
          score < LessonObservation.MIN_SCORE ||
          score > LessonObservation.MAX_SCORE
        ) {
          return fail(
            res,
            400,
            `Scores run from ${LessonObservation.MIN_SCORE} to ${LessonObservation.MAX_SCORE}`
          );
        }
      }

      built.push({
        key,
        score,
        strengths: entry.strengths,
        developmentPoints: entry.developmentPoints,
      });
    }

    const observed = parseDate(observedAt, 'Observation date');
    if (observed.error) return fail(res, 400, observed.error);

    observation.domains = built;
    observation.observedAt = observed.value || observation.observedAt || new Date();
    if (lessonDuration !== undefined) observation.lessonDuration = lessonDuration;
    if (pupilCount !== undefined) observation.pupilCount = pupilCount;

    const previous = observation.status;
    if (observation.status === 'scheduled') observation.status = 'observed';

    observation.recordHistory({
      action: 'recorded',
      from: previous,
      to: observation.status,
      by: req.user._id,
      note: `${built.filter((d) => Number.isFinite(d.score)).length} domain(s) scored`,
    });

    await observation.save();
    return ok(res, observation.toDetailFor(req.user), {
      message: 'Observation recorded. It is not visible to the teacher until you share it.',
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not record the observation');
  }
};

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * PATCH /api/observations/:id/share
 *
 * The transition that makes the scores readable by the person they are about.
 * It is the observer's act, and nobody else's — an admin sharing on their
 * behalf is precisely the grade-delivered-by-email this replaces.
 */
exports.shareFeedback = async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid observation id');

    const observation = await LessonObservation.findById(id);
    if (!observation) return fail(res, 404, 'Observation not found');

    if (!observation.isObserver(req.user)) {
      return fail(res, 403, 'Only the observer can share this feedback');
    }

    const blocked = observation.shareBlockedReason();
    if (blocked) return fail(res, 409, blocked);

    const previous = observation.status;
    observation.status = 'feedback-shared';
    observation.sharedAt = new Date();

    observation.recordHistory({
      action: 'shared',
      from: previous,
      to: 'feedback-shared',
      by: req.user._id,
      note,
    });

    await observation.save();

    const lag = observation.sharingLagDays();
    return ok(res, observation.toDetailFor(req.user), {
      message:
        lag !== null && lag > 14
          ? `Feedback shared, ${lag} days after the lesson.`
          : 'Feedback shared.',
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not share the feedback');
  }
};

/**
 * PATCH /api/observations/:id/acknowledge
 *
 * The observee, and only the observee.
 */
exports.acknowledge = async (req, res) => {
  try {
    const { id } = req.params;
    const { response } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid observation id');

    const observation = await LessonObservation.findById(id);
    if (!observation) return fail(res, 404, 'Observation not found');

    if (!observation.isObservee(req.user)) {
      return fail(res, 403, 'Only the teacher observed can acknowledge this feedback');
    }
    if (!observation.isShared()) {
      return fail(res, 409, 'This feedback has not been shared yet');
    }
    if (observation.acknowledgedAt) {
      return fail(res, 409, 'You have already acknowledged this observation');
    }

    observation.status = 'acknowledged';
    observation.acknowledgedAt = new Date();
    if (response) observation.observeeResponse = response;

    observation.recordHistory({
      action: 'acknowledged',
      from: 'feedback-shared',
      to: 'acknowledged',
      by: req.user._id,
      note: response ? 'With a written response' : undefined,
    });

    await observation.save();
    return ok(res, observation.toDetailFor(req.user), { message: 'Acknowledged' });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not acknowledge the observation');
  }
};

// ---------------------------------------------------------------------------
// Agreed actions
// ---------------------------------------------------------------------------

/**
 * POST /api/observations/:id/actions
 */
exports.addAction = async (req, res) => {
  try {
    const { id } = req.params;
    const { description, dueBy, supportOffered, ownerId } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid observation id');

    const observation = await LessonObservation.findById(id);
    if (!observation) return fail(res, 404, 'Observation not found');

    if (!observation.isObserver(req.user)) {
      return fail(res, 403, 'Only the observer can add agreed actions');
    }
    if (observation.status === 'closed' || observation.status === 'cancelled') {
      return fail(res, 409, 'This observation is no longer open');
    }
    if ((observation.agreedActions || []).length >= LessonObservation.MAX_ACTIONS) {
      return fail(
        res,
        409,
        `An observation carries at most ${LessonObservation.MAX_ACTIONS} actions. More than that is a list nobody works through.`
      );
    }

    const due = parseDate(dueBy, 'Due date');
    if (due.error) return fail(res, 400, due.error);
    if (!due.value) return fail(res, 400, 'An agreed action needs a date');

    // Defaults to the teacher, because an action nobody owns is the failure
    // this module exists to remove. An observer may take one on themselves —
    // "arrange a paired lesson" is properly theirs.
    const owner =
      ownerId && isValidId(ownerId) && String(ownerId) === String(observation.observer)
        ? observation.observer
        : observation.observee;

    observation.agreedActions.push({
      description,
      owner,
      dueBy: due.value,
      supportOffered,
      status: 'open',
    });

    observation.recordHistory({
      action: 'action-added',
      to: due.value.toISOString().slice(0, 10),
      by: req.user._id,
      note: String(description || '').slice(0, 200),
    });

    await observation.save();

    return res.status(201).json({
      success: true,
      message: 'Action agreed',
      data: observation.toDetailFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not add the action');
  }
};

/**
 * PATCH /api/observations/:id/actions/:aid
 */
exports.updateAction = async (req, res) => {
  try {
    const { id, aid } = req.params;
    const { status, evidence } = req.body;

    if (!isValidId(id) || !isValidId(aid)) return fail(res, 400, 'Invalid id');

    const observation = await LessonObservation.findById(id);
    if (!observation) return fail(res, 404, 'Observation not found');

    const action = observation.agreedActions.id(aid);
    if (!action) return fail(res, 404, 'Action not found on this observation');

    const isOwner = String(action.owner) === String(req.user._id);
    if (!isOwner && !observation.isObserver(req.user) && !isAdmin(req.user)) {
      return fail(res, 403, 'Only the action owner or the observer can update this');
    }

    if (status && !LessonObservation.ACTION_STATUSES.includes(status)) {
      return fail(res, 400, 'Invalid action status');
    }

    // Completing without evidence is how a list gets cleared rather than
    // worked through.
    if (status === 'completed' && !evidence && !action.evidence) {
      return fail(res, 400, 'Say what you did before marking the action complete');
    }

    const previous = action.status;
    if (evidence !== undefined) action.evidence = evidence;
    if (status) {
      action.status = status;
      action.completedAt = status === 'completed' ? new Date() : undefined;
    }

    observation.recordHistory({
      action: 'action-updated',
      from: previous,
      to: action.status,
      by: req.user._id,
    });

    await observation.save();
    return ok(res, observation.toDetailFor(req.user), { message: 'Action updated' });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not update the action');
  }
};

/**
 * GET /api/observations/actions/mine
 *
 * Every agreed action owned by the signed-in user, across every observation,
 * overdue first. This list is the follow-up gap, closed.
 */
exports.getMyActions = async (req, res) => {
  try {
    const observations = await LessonObservation.find({
      'agreedActions.owner': req.user._id,
      status: { $in: [...LessonObservation.SHARED_STATUSES] },
    })
      .populate('observer', 'name')
      .sort({ scheduledFor: -1 })
      .limit(200);

    const now = new Date();
    const rows = [];

    for (const observation of observations) {
      for (const action of observation.agreedActions || []) {
        if (String(action.owner) !== String(req.user._id)) continue;
        rows.push({
          observationId: observation._id,
          cycle: observation.cycle,
          academicYear: observation.academicYear,
          subject: observation.subject,
          observedAt: observation.observedAt,
          observerName: observation.observer ? observation.observer.name : null,
          actionId: action._id,
          description: action.description,
          dueBy: action.dueBy,
          supportOffered: action.supportOffered,
          status: action.status,
          evidence: action.evidence,
          completedAt: action.completedAt,
          daysOverdue: observation.actionDaysOverdue(action, now),
        });
      }
    }

    rows.sort((a, b) => {
      if (b.daysOverdue !== a.daysOverdue) return b.daysOverdue - a.daysOverdue;
      return new Date(a.dueBy).getTime() - new Date(b.dueBy).getTime();
    });

    return ok(res, rows, {
      count: rows.length,
      overdueCount: rows.filter((row) => row.daysOverdue > 0).length,
    });
  } catch (error) {
    return serverError(res, error, 'Could not load your agreed actions');
  }
};

// ---------------------------------------------------------------------------
// Moderation and closing
// ---------------------------------------------------------------------------

/**
 * PATCH /api/observations/:id/moderate
 *
 * A second read of an existing observation. `varianceNote` is required when
 * the moderated score differs, because that difference is the only calibration
 * signal the school will ever collect.
 */
exports.moderate = async (req, res) => {
  try {
    const { id } = req.params;
    const { agreedScore, varianceNote } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid observation id');

    const observation = await LessonObservation.findById(id);
    if (!observation) return fail(res, 404, 'Observation not found');

    const ineligible = observation.moderatorEligibilityError(req.user);
    if (ineligible) return fail(res, 403, ineligible);

    const score = Number(agreedScore);
    if (
      !Number.isFinite(score) ||
      score < LessonObservation.MIN_SCORE ||
      score > LessonObservation.MAX_SCORE
    ) {
      return fail(
        res,
        400,
        `A moderated score runs from ${LessonObservation.MIN_SCORE} to ${LessonObservation.MAX_SCORE}`
      );
    }

    const observerScore = observation.overallScore();
    if (observerScore !== null && Math.abs(score - observerScore) >= 0.5 && !varianceNote) {
      return fail(
        res,
        400,
        `Your score of ${score} differs from the observer's ${observerScore}. Say why — that difference is the only calibration the school gets.`
      );
    }

    observation.moderation = {
      moderator: req.user._id,
      moderatedAt: new Date(),
      agreedScore: score,
      varianceNote,
    };

    observation.recordHistory({
      action: 'moderated',
      from: observerScore === null ? undefined : String(observerScore),
      to: String(score),
      by: req.user._id,
      note: varianceNote,
    });

    await observation.save();
    return ok(res, observation.toDetailFor(req.user), { message: 'Moderation recorded' });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not record the moderation');
  }
};

/**
 * PATCH /api/observations/:id/close
 */
exports.closeObservation = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid observation id');

    const observation = await LessonObservation.findById(id);
    if (!observation) return fail(res, 404, 'Observation not found');

    if (!observation.isObserver(req.user) && !isAdmin(req.user)) {
      return fail(res, 403, 'Only the observer or an admin can close this observation');
    }

    const blocked = observation.closeBlockedReason();
    if (blocked) return fail(res, 409, blocked);

    const previous = observation.status;
    observation.status = 'closed';

    observation.recordHistory({
      action: 'closed',
      from: previous,
      to: 'closed',
      by: req.user._id,
    });

    await observation.save();
    return ok(res, observation.toDetailFor(req.user), { message: 'Observation closed' });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not close the observation');
  }
};

/**
 * PATCH /api/observations/:id/cancel
 */
exports.cancelObservation = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid observation id');
    if (!reason || String(reason).trim().length < 5) {
      return fail(res, 400, 'Say why the observation is being cancelled');
    }

    const observation = await LessonObservation.findById(id);
    if (!observation) return fail(res, 404, 'Observation not found');

    if (!observation.isObserver(req.user) && !isAdmin(req.user)) {
      return fail(res, 403, 'Only the observer or an admin can cancel this observation');
    }
    if (observation.isShared()) {
      return fail(res, 409, 'Shared feedback cannot be cancelled away');
    }

    const previous = observation.status;
    observation.status = 'cancelled';
    observation.cancellationReason = reason;

    observation.recordHistory({
      action: 'cancelled',
      from: previous,
      to: 'cancelled',
      by: req.user._id,
      note: reason,
    });

    await observation.save();
    return ok(res, observation.toDetailFor(req.user), { message: 'Observation cancelled' });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not cancel the observation');
  }
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * GET /api/observations/mine
 *
 * Observations of the signed-in teacher. Redaction happens in `toRowFor`, so
 * an unshared one arrives with `awaitingFeedback: true` and no scores.
 */
exports.getMyObservations = async (req, res) => {
  try {
    const observations = await LessonObservation.find({ observee: req.user._id })
      .populate('observer', 'name role')
      .sort({ scheduledFor: -1 })
      .limit(100);

    const now = new Date();
    const rows = observations.map((observation) => observation.toRowFor(req.user, now));

    return ok(res, rows, {
      count: rows.length,
      awaitingFeedback: rows.filter((row) => row.awaitingFeedback).length,
    });
  } catch (error) {
    return serverError(res, error, 'Could not load your observations');
  }
};

/**
 * GET /api/observations/by-me
 */
exports.getObservationsByMe = async (req, res) => {
  try {
    const observations = await LessonObservation.find({ observer: req.user._id })
      .populate('observee', 'name role')
      .sort({ scheduledFor: -1 })
      .limit(100);

    const now = new Date();
    const rows = observations.map((observation) => ({
      ...observation.toRowFor(req.user, now),
      observeeName: observation.observee ? observation.observee.name : null,
      shareBlockedReason: observation.shareBlockedReason(),
    }));

    return ok(res, rows, {
      count: rows.length,
      unshared: rows.filter((row) => !row.isShared && row.status !== 'cancelled').length,
    });
  } catch (error) {
    return serverError(res, error, 'Could not load your observations');
  }
};

/**
 * GET /api/observations
 */
exports.listObservations = async (req, res) => {
  try {
    const { cycle, academicYear, status, observeeId } = req.query;
    const query = {};

    if (cycle && LessonObservation.CYCLES.includes(cycle)) query.cycle = cycle;
    if (academicYear) query.academicYear = String(academicYear).slice(0, 10);
    if (status && LessonObservation.STATUSES.includes(status)) query.status = status;
    if (observeeId && isValidId(observeeId)) query.observee = observeeId;

    const observations = await LessonObservation.find(query)
      .populate('observee', 'name role')
      .populate('observer', 'name role')
      .sort({ scheduledFor: -1 })
      .limit(300);

    const now = new Date();
    const rows = observations.map((observation) => ({
      ...observation.toRowFor(req.user, now),
      observeeName: observation.observee ? observation.observee.name : null,
      observerName: observation.observer ? observation.observer.name : null,
    }));

    return ok(res, rows, { count: rows.length });
  } catch (error) {
    return serverError(res, error, 'Could not load observations');
  }
};

/**
 * GET /api/observations/:id
 */
exports.getObservation = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid observation id');

    const observation = await LessonObservation.findById(id)
      .populate('observee', 'name role')
      .populate('observer', 'name role')
      .populate('agreedActions.owner', 'name');

    if (!observation) return fail(res, 404, 'Observation not found');

    if (!canRead(observation, req.user)) {
      return fail(res, 403, 'This observation is not yours to read');
    }

    return ok(res, {
      ...observation.toDetailFor(req.user),
      observeeName: observation.observee ? observation.observee.name : null,
      observerName: observation.observer ? observation.observer.name : null,
    });
  } catch (error) {
    return serverError(res, error, 'Could not load the observation');
  }
};

/**
 * GET /api/observations/history/:teacherId
 *
 * One teacher's scored domains across cycles — the year-on-year view a Word
 * document cannot produce, which is the reason an observation cycle currently
 * cannot show whether anything improved.
 */
exports.getTeacherHistory = async (req, res) => {
  try {
    const { teacherId } = req.params;
    if (!isValidId(teacherId)) return fail(res, 400, 'Invalid teacher id');

    if (!isAdmin(req.user) && String(teacherId) !== String(req.user._id)) {
      return fail(res, 403, 'You can only read your own observation history');
    }

    const observations = await LessonObservation.find({
      observee: teacherId,
      status: { $in: [...LessonObservation.SHARED_STATUSES] },
    })
      .sort({ scheduledFor: 1 })
      .limit(50);

    const timeline = observations.map((observation) => ({
      _id: observation._id,
      cycle: observation.cycle,
      academicYear: observation.academicYear,
      observedAt: observation.observedAt,
      overallScore: observation.overallScore(),
      domains: (observation.domains || []).reduce((acc, domain) => {
        if (Number.isFinite(domain.score)) acc[domain.key] = domain.score;
        return acc;
      }, {}),
    }));

    // Per-domain movement between the first and last shared observation. The
    // one thing a teacher actually wants from an appraisal record.
    const movement = {};
    for (const key of LessonObservation.DOMAIN_KEYS) {
      const scored = timeline.filter((entry) => Number.isFinite(entry.domains[key]));
      if (scored.length < 2) continue;
      movement[key] = {
        first: scored[0].domains[key],
        latest: scored[scored.length - 1].domains[key],
        change: scored[scored.length - 1].domains[key] - scored[0].domains[key],
      };
    }

    return ok(res, { timeline, movement });
  } catch (error) {
    return serverError(res, error, 'Could not load the observation history');
  }
};

/**
 * GET /api/observations/stats
 */
exports.getStats = async (req, res) => {
  try {
    const observations = await LessonObservation.find({}).limit(1000);

    const byStatus = {};
    const domainTotals = {};
    let sharingLagSum = 0;
    let sharingLagCount = 0;
    let actionsTotal = 0;
    let actionsCompleted = 0;
    let actionsOverdue = 0;
    let varianceSum = 0;
    let varianceCount = 0;

    const now = new Date();

    for (const observation of observations) {
      byStatus[observation.status] = (byStatus[observation.status] || 0) + 1;

      for (const domain of observation.domains || []) {
        if (!Number.isFinite(domain.score)) continue;
        if (!domainTotals[domain.key]) domainTotals[domain.key] = { sum: 0, count: 0 };
        domainTotals[domain.key].sum += domain.score;
        domainTotals[domain.key].count += 1;
      }

      const lag = observation.sharingLagDays();
      if (lag !== null) {
        sharingLagSum += lag;
        sharingLagCount += 1;
      }

      for (const action of observation.agreedActions || []) {
        actionsTotal += 1;
        if (action.status === 'completed') actionsCompleted += 1;
        if (observation.actionDaysOverdue(action, now) > 0) actionsOverdue += 1;
      }

      const overall = observation.overallScore();
      if (
        observation.moderation &&
        Number.isFinite(observation.moderation.agreedScore) &&
        overall !== null
      ) {
        varianceSum += Math.abs(observation.moderation.agreedScore - overall);
        varianceCount += 1;
      }
    }

    const domainMeans = Object.entries(domainTotals)
      .map(([key, value]) => ({
        key,
        label: LessonObservation.DOMAIN_LABELS[key] || key,
        mean: Math.round((value.sum / value.count) * 10) / 10,
        count: value.count,
      }))
      .sort((a, b) => a.mean - b.mean);

    return ok(res, {
      total: observations.length,
      byStatus,
      domainMeans,
      // The number that shames a process: how long a teacher waits to be told.
      meanSharingLagDays: sharingLagCount
        ? Math.round((sharingLagSum / sharingLagCount) * 10) / 10
        : null,
      actions: {
        total: actionsTotal,
        completed: actionsCompleted,
        overdue: actionsOverdue,
        completionRate: actionsTotal
          ? Math.round((actionsCompleted / actionsTotal) * 100)
          : null,
      },
      meanModerationVariance: varianceCount
        ? Math.round((varianceSum / varianceCount) * 100) / 100
        : null,
    });
  } catch (error) {
    return serverError(res, error, 'Could not compute observation statistics');
  }
};

/**
 * GET /api/observations/teachers
 */
exports.getTeachers = async (req, res) => {
  try {
    const teachers = await User.find({ role: { $in: ['teacher', 'staff', 'admin'] } })
      .select('name email role')
      .sort({ name: 1 })
      .limit(500);

    // Never offer somebody themselves in the observee list.
    return ok(res, teachers.filter((person) => String(person._id) !== String(req.user._id)));
  } catch (error) {
    return serverError(res, error, 'Could not load the staff list');
  }
};

exports.academicYearFor = academicYearFor;
