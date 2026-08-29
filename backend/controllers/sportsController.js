const mongoose = require('mongoose');
const Fixture = require('../models/Fixture');

/**
 * Inter-house sports fixtures and standings.
 *
 * Two handlers are worth reading closely. `findClashes` is the one the feature
 * exists for; `getStandings` is the one that must never store anything.
 * Everything else here is a form or a state transition.
 */

const HOUSES = Fixture.HOUSES;
const BLOCKING = Fixture.BLOCKING_STATUSES;

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

/** Staff may run the competition; students read it. */
function canManage(user) {
  return user && (user.role === 'admin' || user.role === 'teacher');
}

/**
 * The fields a client is allowed to set on a fixture. Everything about the
 * result, and everything derived, is server-owned — a client that could send
 * `status: 'completed'` alongside a scoreline would be writing the points
 * table directly.
 */
function sanitiseFixture(body) {
  return {
    title: body.title,
    sport: body.sport,
    stage: body.stage,
    season: body.season,
    ageGroup: body.ageGroup,
    date: body.date,
    startTime: body.startTime,
    endTime: body.endTime,
    venue: body.venue,
    homeHouse: body.homeHouse,
    awayHouse: body.awayHouse,
  };
}

function sanitiseOfficials(officials) {
  if (!Array.isArray(officials)) return [];
  return officials.map((official) => ({
    user: official.user,
    name: official.name,
    duty: official.duty,
  }));
}

/**
 * Every reason `candidate` cannot occupy its slot on its date.
 *
 * One query, one pass. The same function runs on create and on update, because
 * the double booking that actually happens in a school is a fixture being
 * *moved*, not a fixture being added — and an update path that skips the check
 * is the same as having no check.
 */
async function findClashes(candidate, ignoreId = null) {
  const filter = {
    date: candidate.date,
    status: { $in: BLOCKING },
  };
  if (ignoreId) filter._id = { $ne: ignoreId };

  const sameDay = await Fixture.find(filter).select(
    'title sport date startTime endTime startMinute endMinute venue homeHouse awayHouse officials status'
  );

  const start = candidate.startMinute;
  const end = candidate.endMinute;
  const clashes = [];

  const candidateOfficials = new Set(
    (candidate.officials || [])
      .map((o) => (o.user ? String(o.user) : null))
      .filter(Boolean)
  );

  for (const other of sameDay) {
    if (!Fixture.rangesOverlap(start, end, other.startMinute, other.endMinute)) {
      continue;
    }

    const window = `${other.startTime}-${other.endTime}`;

    for (const house of [candidate.homeHouse, candidate.awayHouse]) {
      if (other.involvesHouse(house)) {
        clashes.push({
          kind: 'house',
          house,
          fixtureId: other._id,
          message: `${house} is already playing ${other.sport} at ${window}`,
        });
      }
    }

    if (
      other.venue &&
      candidate.venue &&
      other.venue.trim().toLowerCase() === candidate.venue.trim().toLowerCase()
    ) {
      clashes.push({
        kind: 'venue',
        venue: candidate.venue,
        fixtureId: other._id,
        message: `${candidate.venue} is already booked at ${window}`,
      });
    }

    if (candidateOfficials.size) {
      for (const official of other.officials || []) {
        if (official.user && candidateOfficials.has(String(official.user))) {
          clashes.push({
            kind: 'official',
            official: official.name,
            fixtureId: other._id,
            message: `${official.name} is already officiating at ${window}`,
          });
        }
      }
    }
  }

  return clashes;
}

// ---------------------------------------------------------------------------
// Creating and editing fixtures
// ---------------------------------------------------------------------------

/**
 * POST /api/sports/fixtures
 */
exports.createFixture = async (req, res) => {
  try {
    const fixture = new Fixture({
      ...sanitiseFixture(req.body),
      officials: sanitiseOfficials(req.body.officials),
      createdBy: req.user._id,
    });

    // Validate before clash-checking: there is no point telling somebody their
    // 25:00 kick-off clashes with anything.
    await fixture.validate();

    const clashes = await findClashes(fixture);
    if (clashes.length) {
      return fail(res, 409, 'This fixture clashes with one already scheduled', {
        clashes,
      });
    }

    await fixture.save();

    return res.status(201).json({
      success: true,
      message: 'Fixture scheduled',
      data: fixture.toBoardRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to schedule fixture');
  }
};

/**
 * PATCH /api/sports/fixtures/:id
 *
 * Re-runs the clash check against the *edited* fixture, ignoring itself.
 */
exports.updateFixture = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid fixture id');

    const fixture = await Fixture.findById(id);
    if (!fixture) return fail(res, 404, 'Fixture not found');

    if (['completed', 'walkover'].includes(fixture.status)) {
      return fail(
        res,
        409,
        'This fixture has a result. Clear the result before editing it.'
      );
    }
    if (fixture.status === 'cancelled') {
      return fail(res, 409, 'This fixture was cancelled');
    }

    const updates = sanitiseFixture(req.body);
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) fixture[key] = value;
    }
    if (req.body.officials !== undefined) {
      fixture.officials = sanitiseOfficials(req.body.officials);
    }

    await fixture.validate();

    const clashes = await findClashes(fixture, fixture._id);
    if (clashes.length) {
      return fail(res, 409, 'The new slot clashes with a scheduled fixture', {
        clashes,
      });
    }

    await fixture.save();

    return res.status(200).json({
      success: true,
      message: 'Fixture updated',
      data: fixture.toBoardRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update fixture');
  }
};

/**
 * POST /api/sports/fixtures/:id/officials
 *
 * Officials are clash-checked too. A referee cannot be in two places at once
 * either, and finding that out on the morning is the same failure as a
 * double-booked team.
 */
exports.assignOfficials = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid fixture id');

    const fixture = await Fixture.findById(id);
    if (!fixture) return fail(res, 404, 'Fixture not found');
    if (fixture.status === 'cancelled') {
      return fail(res, 409, 'This fixture was cancelled');
    }

    fixture.officials = sanitiseOfficials(req.body.officials);
    await fixture.validate();

    const clashes = (await findClashes(fixture, fixture._id)).filter(
      (c) => c.kind === 'official'
    );
    if (clashes.length) {
      return fail(res, 409, 'An official is already committed elsewhere', {
        clashes,
      });
    }

    await fixture.save();

    return res.status(200).json({
      success: true,
      message: 'Officials assigned',
      data: fixture.toBoardRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to assign officials');
  }
};

// ---------------------------------------------------------------------------
// Reading fixtures
// ---------------------------------------------------------------------------

/**
 * GET /api/sports/fixtures
 */
exports.listFixtures = async (req, res) => {
  try {
    const { season, sport, house, status, ageGroup, stage, from, to, date } =
      req.query;

    const filter = {};
    if (season) filter.season = season;
    if (sport) filter.sport = sport;
    if (ageGroup) filter.ageGroup = ageGroup;
    if (stage) filter.stage = stage;
    if (status) filter.status = status;
    if (date) {
      filter.date = date;
    } else if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = from;
      if (to) filter.date.$lte = to;
    }
    if (house) {
      filter.$or = [{ homeHouse: house }, { awayHouse: house }];
    }

    const fixtures = await Fixture.find(filter)
      .sort({ date: 1, startMinute: 1 })
      .limit(500);

    return res.status(200).json({
      success: true,
      count: fixtures.length,
      data: fixtures.map((f) => f.toBoardRow()),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load fixtures');
  }
};

/**
 * GET /api/sports/fixtures/:id
 */
exports.getFixture = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid fixture id');

    const fixture = await Fixture.findById(id).populate(
      'createdBy',
      'name email'
    );
    if (!fixture) return fail(res, 404, 'Fixture not found');

    return res.status(200).json({
      success: true,
      data: {
        ...fixture.toBoardRow(),
        createdBy: fixture.createdBy,
        cancellationReason: fixture.cancellationReason,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load fixture');
  }
};

/**
 * GET /api/sports/schedule?date=YYYY-MM-DD
 *
 * One day, grouped by venue. This is the view that makes a clash obvious to a
 * human before the server has to reject it.
 */
exports.getSchedule = async (req, res) => {
  try {
    const date = req.query.date || Fixture.todayKey();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return fail(res, 400, 'Date must be in YYYY-MM-DD format');
    }

    const fixtures = await Fixture.find({
      date,
      status: { $ne: 'cancelled' },
    }).sort({ startMinute: 1 });

    const byVenue = new Map();
    for (const fixture of fixtures) {
      const key = fixture.venue;
      if (!byVenue.has(key)) byVenue.set(key, []);
      byVenue.get(key).push(fixture.toBoardRow());
    }

    const venues = [...byVenue.entries()]
      .map(([venue, rows]) => ({ venue, fixtures: rows }))
      .sort((a, b) => a.venue.localeCompare(b.venue));

    return res.status(200).json({
      success: true,
      data: {
        date,
        venues,
        total: fixtures.length,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the schedule');
  }
};

/**
 * GET /api/sports/standings
 *
 * Derived on every request from completed and walkover fixtures. Nothing here
 * writes, and there is no cached table to fall out of step.
 */
exports.getStandings = async (req, res) => {
  try {
    const { season, sport, ageGroup } = req.query;

    const filter = { status: { $in: Fixture.COUNTING_STATUSES } };
    if (season) filter.season = season;
    if (sport) filter.sport = sport;
    if (ageGroup) filter.ageGroup = ageGroup;

    const fixtures = await Fixture.find(filter).select(
      'homeHouse awayHouse status result'
    );

    const table = Fixture.buildStandings(fixtures);

    return res.status(200).json({
      success: true,
      data: {
        table,
        countedFixtures: fixtures.length,
        points: Fixture.POINTS,
        filters: { season: season || null, sport: sport || null, ageGroup: ageGroup || null },
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build standings');
  }
};

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * PATCH /api/sports/fixtures/:id/start
 */
exports.startFixture = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid fixture id');

    const fixture = await Fixture.findById(id);
    if (!fixture) return fail(res, 404, 'Fixture not found');
    if (fixture.status !== 'scheduled') {
      return fail(res, 409, `A ${fixture.status} fixture cannot be started`);
    }

    fixture.status = 'in-progress';
    await fixture.save();

    return res.status(200).json({
      success: true,
      message: 'Fixture under way',
      data: fixture.toBoardRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to start fixture');
  }
};

/**
 * PATCH /api/sports/fixtures/:id/result
 *
 * `outcome` is never read from the body — it is derived from the scores in the
 * model's pre-validate hook.
 */
exports.recordResult = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid fixture id');

    const fixture = await Fixture.findById(id);
    if (!fixture) return fail(res, 404, 'Fixture not found');

    const blocked = fixture.resultabilityError();
    if (blocked) return fail(res, 409, blocked);

    const { homeScore, awayScore, notes } = req.body;
    if (homeScore === undefined || awayScore === undefined) {
      return fail(res, 400, 'Both scores are required');
    }

    fixture.status = 'completed';
    fixture.result.homeScore = Number(homeScore);
    fixture.result.awayScore = Number(awayScore);
    fixture.result.walkoverTo = undefined;
    fixture.result.notes = notes;
    fixture.result.recordedBy = req.user._id;
    fixture.result.recordedAt = new Date();

    await fixture.save();

    return res.status(200).json({
      success: true,
      message: 'Result recorded',
      data: fixture.toBoardRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record result');
  }
};

/**
 * PATCH /api/sports/fixtures/:id/walkover
 */
exports.recordWalkover = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid fixture id');

    const fixture = await Fixture.findById(id);
    if (!fixture) return fail(res, 404, 'Fixture not found');

    const blocked = fixture.resultabilityError();
    if (blocked) return fail(res, 409, blocked);

    const { awardedTo, notes } = req.body;
    if (!awardedTo) return fail(res, 400, 'The house awarded the walkover is required');

    fixture.status = 'walkover';
    fixture.result.walkoverTo = awardedTo;
    fixture.result.notes = notes;
    fixture.result.recordedBy = req.user._id;
    fixture.result.recordedAt = new Date();

    await fixture.save();

    return res.status(200).json({
      success: true,
      message: `Walkover awarded to ${awardedTo}`,
      data: fixture.toBoardRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record walkover');
  }
};

/**
 * DELETE /api/sports/fixtures/:id/result
 *
 * Corrections happen. Returning the fixture to `scheduled` recomputes the
 * table, and `recordedBy` on the next result shows who last touched it.
 */
exports.clearResult = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid fixture id');

    const fixture = await Fixture.findById(id);
    if (!fixture) return fail(res, 404, 'Fixture not found');

    if (!['completed', 'walkover', 'abandoned'].includes(fixture.status)) {
      return fail(res, 409, 'This fixture has no result to clear');
    }

    fixture.status = 'scheduled';
    fixture.result = {};
    await fixture.save();

    return res.status(200).json({
      success: true,
      message: 'Result cleared; the fixture is open again',
      data: fixture.toBoardRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to clear result');
  }
};

/**
 * PATCH /api/sports/fixtures/:id/abandon
 *
 * Abandoned is not a goalless draw. It counts for nothing in the table and
 * keeps its slot, because an abandoned match is usually about to be replayed.
 */
exports.abandonFixture = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid fixture id');

    const fixture = await Fixture.findById(id);
    if (!fixture) return fail(res, 404, 'Fixture not found');
    if (fixture.status === 'cancelled') {
      return fail(res, 409, 'This fixture was cancelled');
    }

    fixture.status = 'abandoned';
    fixture.result.notes = req.body.reason;
    fixture.result.recordedBy = req.user._id;
    fixture.result.recordedAt = new Date();
    await fixture.save();

    return res.status(200).json({
      success: true,
      message: 'Fixture abandoned',
      data: fixture.toBoardRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to abandon fixture');
  }
};

/**
 * PATCH /api/sports/fixtures/:id/cancel
 *
 * Cancelling releases the slot, so the calendar it was blocking becomes usable
 * again. Only an admin, or the member of staff who scheduled it.
 */
exports.cancelFixture = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid fixture id');

    const fixture = await Fixture.findById(id);
    if (!fixture) return fail(res, 404, 'Fixture not found');

    const owns = String(fixture.createdBy) === String(req.user._id);
    if (!owns && !isAdmin(req.user)) {
      return fail(res, 403, 'Only an admin can cancel somebody else’s fixture');
    }
    if (fixture.status === 'cancelled') {
      return fail(res, 409, 'This fixture is already cancelled');
    }

    fixture.status = 'cancelled';
    fixture.cancelledAt = new Date();
    fixture.cancellationReason = req.body.reason;
    fixture.result = {};
    await fixture.save();

    return res.status(200).json({
      success: true,
      message: 'Fixture cancelled',
      data: fixture.toBoardRow(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to cancel fixture');
  }
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * GET /api/sports/stats
 */
exports.getStats = async (req, res) => {
  try {
    const { season } = req.query;
    const filter = season ? { season } : {};

    const fixtures = await Fixture.find(filter).select(
      'sport status date homeHouse awayHouse result'
    );

    const byStatus = {};
    for (const status of Fixture.FIXTURE_STATUSES) byStatus[status] = 0;

    const bySport = {};
    let awaitingResult = 0;
    const today = Fixture.todayKey();

    for (const fixture of fixtures) {
      byStatus[fixture.status] = (byStatus[fixture.status] || 0) + 1;
      bySport[fixture.sport] = (bySport[fixture.sport] || 0) + 1;

      // A fixture whose date has passed but which nobody has entered a result
      // for. This is the number that quietly grows all term.
      if (
        ['scheduled', 'in-progress'].includes(fixture.status) &&
        fixture.date < today
      ) {
        awaitingResult += 1;
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        total: fixtures.length,
        byStatus,
        bySport,
        awaitingResult,
        houses: HOUSES,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build sports statistics');
  }
};

/**
 * GET /api/sports/meta
 *
 * The enums, so the form does not have to keep its own copy of them and drift.
 */
exports.getMeta = async (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      sports: Fixture.SPORTS,
      stages: Fixture.STAGES,
      houses: Fixture.HOUSES,
      ageGroups: Fixture.AGE_GROUPS,
      statuses: Fixture.FIXTURE_STATUSES,
      duties: Fixture.OFFICIAL_DUTIES,
      points: Fixture.POINTS,
      canManage: canManage(req.user),
    },
  });
};
