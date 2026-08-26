const mongoose = require('mongoose');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const KpiTarget = require('../models/KpiTarget');

/**
 * Targets for the analytics dashboard.
 *
 * The whole module turns on one split, and it is worth stating plainly because
 * every function here either implements it or protects it:
 *
 *   an **open** target's actual is aggregated over `AnalyticsEvent` on every
 *   request, so the number is always current;
 *
 *   a **closed** target's actual is read from `certifiedActual`, and the event
 *   log is never touched again.
 *
 * `AnalyticsEvent` is an event log and will eventually be pruned. Without the
 * second half, pruning silently rewrites the past, and a judgement recorded in
 * a governors' minute stops being checkable against the system that produced
 * it. Certification is therefore one-way: a figure that turns out to have been
 * wrong is corrected by a new target that supersedes this one, never by an edit
 * to the number a decision was taken against.
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

function created(res, data) {
  return res.status(201).json({ success: true, data });
}

function serverError(res, error, message) {
  console.error(`${message}:`, error);
  return res.status(500).json({ success: false, message, error: error.message });
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
    return 'A live target already exists for that metric, scope and period';
  }
  return null;
}

function isAdmin(user) {
  return user && user.role === 'admin';
}

function parseDate(value, fieldLabel) {
  if (value === undefined || value === null || value === '') {
    return { error: `${fieldLabel} is required` };
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { error: `${fieldLabel} is not a valid date` };
  return { value: date };
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/**
 * `Infinity` is not JSON.
 *
 * `attainmentFor` legitimately returns it — a target of zero that was beaten,
 * an `at-most` target with no activity at all — and `JSON.stringify` turns it
 * into `null`, which reads on the dashboard as "no data" rather than "cleared
 * completely". Capping it at a number keeps the meaning.
 */
function finite(value, cap = 999) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return cap;
  return round2(value);
}

/* ------------------------------------------------------------------------- *
 * Deriving an actual
 * ------------------------------------------------------------------------- */

/**
 * Count what actually happened, for one metric, in one window, in one scope.
 *
 * A role-scoped metric has to join through to `users`, because `AnalyticsEvent`
 * stores only `userId`. That join is why `cohort` comes back from the same
 * pipeline rather than a second query — the set of people in scope is the same
 * set either way, and computing it twice invites the two numbers to disagree.
 */
async function deriveActual(target) {
  const spec = KpiTarget.METRICS[target.metric];
  if (!spec) throw new Error(`Unknown metric ${target.metric}`);

  const pipeline = [
    {
      $match: {
        eventType: spec.eventType,
        createdAt: { $gte: target.periodStart, $lt: target.periodEnd },
      },
    },
  ];

  if (target.scope.kind === 'role') {
    pipeline.push(
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'actor',
        },
      },
      { $unwind: '$actor' },
      { $match: { 'actor.role': target.scope.role } }
    );
  }

  // Both numbers from one pass: the metric itself, and how many distinct people
  // it came from, which is what the suppression rule is applied to.
  pipeline.push({
    $group: {
      _id: null,
      rows: { $sum: 1 },
      users: { $addToSet: '$userId' },
    },
  });

  const [row] = await AnalyticsEvent.aggregate(pipeline);

  const cohort = row ? row.users.length : 0;
  const actual = row ? (spec.distinct ? cohort : row.rows) : 0;

  return { actual, cohort };
}

/**
 * A target with its result attached — derived if the period is open, read from
 * the record if it is closed.
 *
 * Small cohorts are suppressed rather than rounded. A percentage against three
 * people is a number that should not be shown at all, and the suppression is
 * applied here, once, so no caller can forget it.
 */
async function withResult(target, now = new Date()) {
  const base = target.toObject ? target.toObject() : { ...target };

  const closed = target.status === 'closed';

  let actual;
  let cohort;
  let sourced;

  if (closed) {
    actual = target.certifiedActual;
    cohort = target.certifiedCohort;
    sourced = 'certified';
  } else {
    const derived = await deriveActual(target);
    actual = derived.actual;
    cohort = derived.cohort;
    sourced = 'derived';
  }

  const suppressed = cohort !== null && cohort < target.minimumCohort;

  const attainment = closed
    ? target.certifiedAttainment
    : KpiTarget.attainmentFor(actual, target.targetValue, target.direction);

  const result = {
    sourced,
    actual: suppressed ? null : actual,
    cohort,
    suppressed,
    suppressionReason: suppressed
      ? `Fewer than ${target.minimumCohort} people are in scope, so no figure is reported`
      : null,
    attainment: suppressed ? null : finite(attainment),
    met: suppressed ? null : KpiTarget.isMet(actual, target.targetValue, target.direction),
    pace: suppressed ? null : target.pace ? target.pace(actual, now) : null,
    periodOpen: target.periodEnd > now && target.periodStart <= now,
    periodEnded: target.periodEnd <= now,
    awaitingCertification: target.status === 'live' && target.periodEnd <= now,
  };

  return { ...base, result };
}

/* ------------------------------------------------------------------------- *
 * Handlers
 * ------------------------------------------------------------------------- */

exports.getTargetMeta = async (req, res) => {
  try {
    return ok(res, {
      metrics: Object.entries(KpiTarget.METRICS).map(([key, spec]) => ({
        key,
        label: spec.label,
        distinct: spec.distinct,
        eventType: spec.eventType,
      })),
      statuses: KpiTarget.STATUSES,
      directions: KpiTarget.DIRECTIONS,
      scopeKinds: KpiTarget.SCOPE_KINDS,
      roles: KpiTarget.ROLES,
      maxPeriodDays: KpiTarget.MAX_PERIOD_DAYS,
    });
  } catch (error) {
    return serverError(res, error, 'Could not load the target options');
  }
};

exports.createTarget = async (req, res) => {
  try {
    const {
      metric,
      scopeKind,
      role,
      label,
      rationale,
      periodStart,
      periodEnd,
      targetValue,
      direction,
      unit,
      minimumCohort,
      supersedes,
      activate,
    } = req.body;

    if (!KpiTarget.METRIC_KEYS.includes(metric)) {
      return fail(res, 400, 'Invalid metric');
    }

    const start = parseDate(periodStart, 'Period start');
    if (start.error) return fail(res, 400, start.error);

    const end = parseDate(periodEnd, 'Period end');
    if (end.error) return fail(res, 400, end.error);

    // Refused here as well as on activation, so a draft written against a
    // finished period never exists in the first place.
    if (end.value <= new Date()) {
      return fail(
        res,
        400,
        'That period has already ended. A target cannot be set for a window whose result is ' +
          'already known — that is a description, not an expectation.'
      );
    }

    if (supersedes && !isValidId(supersedes)) {
      return fail(res, 400, 'That superseded target id is not valid');
    }

    const target = new KpiTarget({
      metric,
      scope: { kind: scopeKind || 'school', role: scopeKind === 'role' ? role : '' },
      label,
      rationale,
      periodStart: start.value,
      periodEnd: end.value,
      targetValue,
      direction: direction || 'at-least',
      unit,
      minimumCohort: minimumCohort === undefined ? 5 : Number(minimumCohort),
      owner: req.user._id,
      ownerName: req.user.name,
      createdBy: req.user._id,
      supersedes: supersedes || null,
    });

    target.recordHistory({
      action: 'created',
      to: 'draft',
      by: req.user._id,
      byName: req.user.name,
    });

    if (activate) {
      // The query half of the overlap rule. The index catches identical
      // normalised periods even under a race; this catches irregular windows
      // that genuinely overlap but normalise to different keys.
      const clashes = await KpiTarget.overlapping(target);
      if (clashes.length) {
        return fail(
          res,
          409,
          `A live target for this metric and scope already covers part of that window: ` +
            `"${clashes[0].label}" runs from ${clashes[0].periodStart
              .toISOString()
              .slice(0, 10)} to ${clashes[0].periodEnd.toISOString().slice(0, 10)}.`
        );
      }

      target.activate(req.user);
    }

    await target.save();

    if (supersedes) {
      await KpiTarget.updateOne({ _id: supersedes }, { $set: { supersededBy: target._id } });
    }

    return created(res, await withResult(target));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

exports.activateTarget = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'That target id is not valid');

    const target = await KpiTarget.findById(id);
    if (!target) return fail(res, 404, 'That target does not exist');

    const clashes = await KpiTarget.overlapping(target);
    if (clashes.length) {
      return fail(
        res,
        409,
        `A live target for this metric and scope already covers part of that window: ` +
          `"${clashes[0].label}".`
      );
    }

    target.activate(req.user);
    await target.save();

    return ok(res, await withResult(target));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

exports.updateTarget = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'That target id is not valid');

    const target = await KpiTarget.findById(id);
    if (!target) return fail(res, 404, 'That target does not exist');

    if (target.status !== 'draft') {
      // Said in full rather than as a 403, because the reason is the feature.
      return fail(
        res,
        400,
        'Only a draft target can be edited. Once a target is live the expectation is the one ' +
          'the period was run against; correcting it means raising a new target that supersedes ' +
          'this one.'
      );
    }

    ['label', 'rationale', 'unit'].forEach((field) => {
      if (req.body[field] !== undefined) target[field] = req.body[field];
    });

    if (req.body.targetValue !== undefined) target.targetValue = req.body.targetValue;
    if (req.body.minimumCohort !== undefined) target.minimumCohort = Number(req.body.minimumCohort);
    if (req.body.direction !== undefined) target.direction = req.body.direction;

    if (req.body.periodStart) {
      const start = parseDate(req.body.periodStart, 'Period start');
      if (start.error) return fail(res, 400, start.error);
      target.periodStart = start.value;
    }

    if (req.body.periodEnd) {
      const end = parseDate(req.body.periodEnd, 'Period end');
      if (end.error) return fail(res, 400, end.error);
      target.periodEnd = end.value;
    }

    target.recordHistory({ action: 'edited', by: req.user._id, byName: req.user.name });

    await target.save();

    return ok(res, await withResult(target));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

/**
 * Freeze the result.
 *
 * The actual is derived one final time here and written onto the record. After
 * this the event log is irrelevant to this target, which is the point: the
 * number survives the log being pruned.
 */
exports.certifyTarget = async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'That target id is not valid');

    const target = await KpiTarget.findById(id);
    if (!target) return fail(res, 404, 'That target does not exist');

    if (target.certifiedAt) {
      return fail(
        res,
        400,
        'This target has already been certified. A corrected figure is a new target that ' +
          'supersedes this one, not an edit to the number a decision was taken against.'
      );
    }

    const { actual, cohort } = await deriveActual(target);
    const attainment = finite(
      KpiTarget.attainmentFor(actual, target.targetValue, target.direction)
    );

    target.certify(req.user, { actual, attainment, cohort, note });
    await target.save();

    return ok(res, await withResult(target));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

exports.abandonTarget = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'That target id is not valid');

    const target = await KpiTarget.findById(id);
    if (!target) return fail(res, 404, 'That target does not exist');

    target.abandon(req.user, reason);
    await target.save();

    return ok(res, await withResult(target));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

exports.listTargets = async (req, res) => {
  try {
    const { status, metric, scopeKind, role } = req.query;

    const filter = {};
    if (status && KpiTarget.STATUSES.includes(status)) filter.status = status;
    if (metric && KpiTarget.METRIC_KEYS.includes(metric)) filter.metric = metric;
    if (scopeKind && KpiTarget.SCOPE_KINDS.includes(scopeKind)) filter['scope.kind'] = scopeKind;
    if (role && KpiTarget.ROLES.includes(role)) filter['scope.role'] = role;

    const targets = await KpiTarget.find(filter).sort({ periodEnd: -1 }).limit(200);

    const now = new Date();
    const rows = await Promise.all(targets.map((target) => withResult(target, now)));

    return ok(res, rows);
  } catch (error) {
    return serverError(res, error, 'Could not load the targets');
  }
};

exports.getTarget = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'That target id is not valid');

    const target = await KpiTarget.findById(id);
    if (!target) return fail(res, 404, 'That target does not exist');

    return ok(res, await withResult(target));
  } catch (error) {
    return serverError(res, error, 'Could not load that target');
  }
};

/**
 * The scoreboard: every live target, with how it is doing.
 *
 * Split into the ones that need somebody to act — behind pace, or finished and
 * waiting to be certified — and the ones that do not, because a flat list of
 * twenty targets is a list nobody reads.
 */
exports.getScoreboard = async (req, res) => {
  try {
    const now = new Date();

    const targets = await KpiTarget.find({
      status: { $in: ['live', 'closed'] },
      periodEnd: { $gte: new Date(now.getFullYear() - 1, 0, 1) },
    })
      .sort({ periodEnd: -1 })
      .limit(100);

    const rows = await Promise.all(targets.map((target) => withResult(target, now)));

    const live = rows.filter((row) => row.status === 'live');

    return ok(res, {
      live,
      closed: rows.filter((row) => row.status === 'closed'),
      needsAttention: live.filter(
        (row) =>
          row.result.awaitingCertification ||
          (row.result.pace && !row.result.pace.onTrack && !row.result.suppressed)
      ),
      counts: {
        live: live.length,
        awaitingCertification: live.filter((row) => row.result.awaitingCertification).length,
        behind: live.filter((row) => row.result.pace && !row.result.pace.onTrack).length,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Could not build the scoreboard');
  }
};

exports.deriveActual = deriveActual;
exports.isAdmin = isAdmin;
