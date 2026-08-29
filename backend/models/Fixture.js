const mongoose = require('mongoose');

/**
 * Inter-house sports fixtures.
 *
 * There is deliberately no standings model. A stored points table is a second
 * source of truth that starts drifting from the results the moment anybody
 * edits it, and when the two disagree there is no way to tell which one is
 * lying. The table is folded out of completed fixtures on every request
 * instead — see `Fixture.buildStandings` at the bottom of this file.
 *
 * Times are stored twice: as `HH:MM` for people and as integer minutes for the
 * overlap arithmetic. Comparing time strings works right up until "09:00" meets
 * "9:00", and the failure is a team standing on the wrong field.
 */

const SPORTS = [
  'football',
  'cricket',
  'basketball',
  'hockey',
  'athletics',
  'badminton',
  'volleyball',
  'chess',
  'kabaddi',
  'swimming',
  'other',
];

const STAGES = ['league', 'quarter-final', 'semi-final', 'third-place', 'final'];

const HOUSES = ['Falcon', 'Phoenix', 'Titan', 'Vanguard'];

const AGE_GROUPS = ['u12', 'u14', 'u16', 'u19', 'open'];

const FIXTURE_STATUSES = [
  'scheduled',
  'in-progress',
  'completed',
  'abandoned',
  'walkover',
  'cancelled',
];

const OUTCOMES = ['home', 'away', 'draw'];

const OFFICIAL_DUTIES = ['referee', 'umpire', 'scorer', 'timekeeper', 'steward'];

// A fixture in one of these states still owns its slot in the calendar, so it
// counts when we ask whether a house, a venue or an official is already busy.
// `cancelled` releases the slot; `abandoned` does not, because an abandoned
// match happened — people were there — and it is usually about to be replayed.
const BLOCKING_STATUSES = [
  'scheduled',
  'in-progress',
  'completed',
  'abandoned',
  'walkover',
];

// A fixture in one of these states contributes to the points table.
const COUNTING_STATUSES = ['completed', 'walkover'];

const POINTS_WIN = 3;
const POINTS_DRAW = 1;
const POINTS_LOSS = 0;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SEASON_PATTERN = /^\d{4}-\d{2}$/;

const MIN_FIXTURE_MINUTES = 10;
const MAX_FIXTURE_MINUTES = 480;
const MAX_SCORE = 500;
const MAX_OFFICIALS = 8;

/**
 * "14:35" -> 875. Returns null rather than NaN for anything that is not a valid
 * HH:MM string, so a caller can tell "not supplied" apart from midnight.
 */
function toMinutes(time) {
  if (typeof time !== 'string' || !TIME_PATTERN.test(time)) return null;
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return null;
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Today in the server's local zone, as the YYYY-MM-DD key the model stores. */
function todayKey(now = new Date()) {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/** Half-open overlap: a fixture ending at 15:00 does not clash with one starting then. */
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

const officialSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    name: {
      type: String,
      required: [true, 'Official name is required'],
      trim: true,
      maxlength: [80, 'Official name cannot exceed 80 characters'],
    },
    duty: {
      type: String,
      enum: {
        values: OFFICIAL_DUTIES,
        message: 'Invalid duty',
      },
      default: 'referee',
    },
  },
  { _id: true, timestamps: false }
);

const resultSchema = new mongoose.Schema(
  {
    homeScore: {
      type: Number,
      min: [0, 'A score cannot be negative'],
      max: [MAX_SCORE, `A score cannot exceed ${MAX_SCORE}`],
      validate: {
        validator: Number.isInteger,
        message: 'Scores must be whole numbers',
      },
    },
    awayScore: {
      type: Number,
      min: [0, 'A score cannot be negative'],
      max: [MAX_SCORE, `A score cannot exceed ${MAX_SCORE}`],
      validate: {
        validator: Number.isInteger,
        message: 'Scores must be whole numbers',
      },
    },
    // Derived from the two scores in the parent's pre-validate hook. A client
    // that sends 1-3 alongside outcome "home" is corrected, not believed.
    outcome: {
      type: String,
      enum: {
        values: OUTCOMES,
        message: 'Invalid outcome',
      },
    },
    // Only set for a walkover, where there is no scoreline to derive from.
    walkoverTo: {
      type: String,
      enum: {
        values: HOUSES,
        message: 'Invalid house',
      },
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [500, 'Result notes cannot exceed 500 characters'],
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    recordedAt: {
      type: Date,
    },
  },
  { _id: false, timestamps: false }
);

const fixtureSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      trim: true,
      maxlength: [120, 'Title cannot exceed 120 characters'],
    },
    sport: {
      type: String,
      required: [true, 'Sport is required'],
      enum: {
        values: SPORTS,
        message: 'Invalid sport',
      },
    },
    stage: {
      type: String,
      enum: {
        values: STAGES,
        message: 'Invalid stage',
      },
      default: 'league',
    },
    season: {
      type: String,
      required: [true, 'Season is required'],
      trim: true,
      match: [SEASON_PATTERN, 'Season must look like 2026-27'],
    },
    ageGroup: {
      type: String,
      enum: {
        values: AGE_GROUPS,
        message: 'Invalid age group',
      },
      default: 'open',
    },
    date: {
      type: String,
      required: [true, 'Fixture date is required'],
      match: [DATE_PATTERN, 'Date must be in YYYY-MM-DD format'],
    },
    startTime: {
      type: String,
      required: [true, 'Start time is required'],
      match: [TIME_PATTERN, 'Start time must be in HH:MM format'],
    },
    endTime: {
      type: String,
      required: [true, 'End time is required'],
      match: [TIME_PATTERN, 'End time must be in HH:MM format'],
    },
    // Derived. Never accepted from a client.
    startMinute: {
      type: Number,
      min: 0,
      max: 1439,
    },
    endMinute: {
      type: Number,
      min: 0,
      max: 1440,
    },
    venue: {
      type: String,
      required: [true, 'Venue is required'],
      trim: true,
      maxlength: [80, 'Venue cannot exceed 80 characters'],
    },
    homeHouse: {
      type: String,
      required: [true, 'Home house is required'],
      enum: {
        values: HOUSES,
        message: 'Invalid house',
      },
    },
    awayHouse: {
      type: String,
      required: [true, 'Away house is required'],
      enum: {
        values: HOUSES,
        message: 'Invalid house',
      },
    },
    status: {
      type: String,
      enum: {
        values: FIXTURE_STATUSES,
        message: 'Invalid fixture status',
      },
      default: 'scheduled',
    },
    officials: {
      type: [officialSchema],
      default: [],
      validate: {
        validator: (v) => v.length <= MAX_OFFICIALS,
        message: `A fixture cannot have more than ${MAX_OFFICIALS} officials`,
      },
    },
    result: {
      type: resultSchema,
      default: () => ({}),
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    cancelledAt: {
      type: Date,
    },
    cancellationReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Cancellation reason cannot exceed 300 characters'],
    },
  },
  { timestamps: true }
);

fixtureSchema.index({ season: 1, sport: 1, date: 1 });
fixtureSchema.index({ date: 1, status: 1 });
fixtureSchema.index({ homeHouse: 1, date: 1 });
fixtureSchema.index({ awayHouse: 1, date: 1 });
fixtureSchema.index({ venue: 1, date: 1 });

/**
 * Everything derived lives here, so there is exactly one place where a stored
 * value can come from a client value.
 */
fixtureSchema.pre('validate', async function derive() {
  this.startMinute = toMinutes(this.startTime);
  this.endMinute = toMinutes(this.endTime);

  if (this.startMinute === null || this.endMinute === null) {
    // The `match` validators will report the malformed field; bail out rather
    // than piling a confusing duration error on top of it.
    return;
  }

  const duration = this.endMinute - this.startMinute;
  if (duration < MIN_FIXTURE_MINUTES) {
    this.invalidate(
      'endTime',
      `A fixture must run for at least ${MIN_FIXTURE_MINUTES} minutes`
    );
  } else if (duration > MAX_FIXTURE_MINUTES) {
    this.invalidate(
      'endTime',
      `A fixture cannot run for more than ${MAX_FIXTURE_MINUTES} minutes`
    );
  }

  if (this.homeHouse && this.homeHouse === this.awayHouse) {
    this.invalidate('awayHouse', 'A house cannot play itself');
  }

  if (!this.title) {
    this.title = `${this.homeHouse} v ${this.awayHouse}`;
  }

  this.deriveOutcome();
});

/**
 * The outcome is a function of the scoreline, or of `walkoverTo` when there is
 * no scoreline. Accepting it from a client is how a 1-3 defeat gets stored as
 * a win, and the points table then disagrees with the score printed beside it.
 */
fixtureSchema.methods.deriveOutcome = function deriveOutcome() {
  const result = this.result;
  if (!result) return;

  if (this.status === 'walkover') {
    if (!result.walkoverTo) {
      this.invalidate('result.walkoverTo', 'A walkover must name the house it was awarded to');
      return;
    }
    if (![this.homeHouse, this.awayHouse].includes(result.walkoverTo)) {
      this.invalidate(
        'result.walkoverTo',
        'A walkover can only be awarded to one of the two houses playing'
      );
      return;
    }
    result.outcome = result.walkoverTo === this.homeHouse ? 'home' : 'away';
    result.homeScore = undefined;
    result.awayScore = undefined;
    return;
  }

  if (this.status !== 'completed') {
    // Nothing to derive, and nothing should be lingering either.
    if (this.status === 'cancelled' || this.status === 'abandoned') {
      result.outcome = undefined;
    }
    return;
  }

  const { homeScore, awayScore } = result;
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) {
    this.invalidate('result.homeScore', 'A completed fixture needs both scores');
    return;
  }

  if (homeScore > awayScore) result.outcome = 'home';
  else if (awayScore > homeScore) result.outcome = 'away';
  else result.outcome = 'draw';
};

/** A fixture only blocks the calendar while it is in one of these states. */
fixtureSchema.methods.blocksCalendar = function blocksCalendar() {
  return BLOCKING_STATUSES.includes(this.status);
};

fixtureSchema.methods.involvesHouse = function involvesHouse(house) {
  return this.homeHouse === house || this.awayHouse === house;
};

/**
 * Why this fixture cannot take a result yet, or null when it can. Kept on the
 * model so the controller and any future importer answer the question the same
 * way.
 */
fixtureSchema.methods.resultabilityError = function resultabilityError(today = todayKey()) {
  if (this.status === 'cancelled') return 'This fixture was cancelled';
  if (this.status === 'abandoned') return 'This fixture was abandoned; reinstate it before recording a result';
  if (this.date > today) {
    return `This fixture is scheduled for ${this.date} and has not been played yet`;
  }
  return null;
};

/**
 * The public shape. `result` is flattened a little because every consumer wants
 * the scoreline and none of them want to know it lives in a sub-document.
 */
fixtureSchema.methods.toBoardRow = function toBoardRow() {
  const result = this.result || {};
  return {
    _id: this._id,
    title: this.title,
    sport: this.sport,
    stage: this.stage,
    season: this.season,
    ageGroup: this.ageGroup,
    date: this.date,
    startTime: this.startTime,
    endTime: this.endTime,
    venue: this.venue,
    homeHouse: this.homeHouse,
    awayHouse: this.awayHouse,
    status: this.status,
    officials: this.officials,
    homeScore: result.homeScore ?? null,
    awayScore: result.awayScore ?? null,
    outcome: result.outcome ?? null,
    walkoverTo: result.walkoverTo ?? null,
    resultNotes: result.notes ?? null,
    recordedAt: result.recordedAt ?? null,
    createdAt: this.createdAt,
  };
};

/**
 * Fold fixtures into a points table.
 *
 * Only `completed` and `walkover` fixtures count. An abandoned match is
 * excluded rather than treated as a goalless draw, because those are different
 * things and only one of them can be replayed.
 *
 * The ordering breaks every tie, all the way down to house name, so two
 * identical requests can never come back in a different order. A table whose
 * order depends on document insertion order is a table people stop trusting.
 */
fixtureSchema.statics.buildStandings = function buildStandings(fixtures, houses = HOUSES) {
  const table = new Map();
  for (const house of houses) {
    table.set(house, {
      house,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      scoreFor: 0,
      scoreAgainst: 0,
      scoreDifference: 0,
      walkoversFor: 0,
      walkoversAgainst: 0,
      points: 0,
    });
  }

  // Head-to-head is only consulted between exactly two tied houses, so it is
  // enough to remember who beat whom.
  const headToHead = new Map();
  const h2hKey = (a, b) => `${a}|${b}`;

  const counted = fixtures.filter((f) => COUNTING_STATUSES.includes(f.status));

  for (const fixture of counted) {
    const home = table.get(fixture.homeHouse);
    const away = table.get(fixture.awayHouse);
    if (!home || !away) continue; // a house outside the requested set

    const result = fixture.result || {};
    home.played += 1;
    away.played += 1;

    if (fixture.status === 'walkover') {
      const winner = result.walkoverTo === fixture.homeHouse ? home : away;
      const loser = winner === home ? away : home;
      winner.won += 1;
      winner.points += POINTS_WIN;
      winner.walkoversFor += 1;
      loser.lost += 1;
      loser.points += POINTS_LOSS;
      loser.walkoversAgainst += 1;
      headToHead.set(h2hKey(winner.house, loser.house), 1);
      headToHead.set(h2hKey(loser.house, winner.house), -1);
      continue;
    }

    const homeScore = result.homeScore || 0;
    const awayScore = result.awayScore || 0;

    home.scoreFor += homeScore;
    home.scoreAgainst += awayScore;
    away.scoreFor += awayScore;
    away.scoreAgainst += homeScore;

    if (result.outcome === 'home') {
      home.won += 1;
      home.points += POINTS_WIN;
      away.lost += 1;
      away.points += POINTS_LOSS;
      headToHead.set(h2hKey(home.house, away.house), 1);
      headToHead.set(h2hKey(away.house, home.house), -1);
    } else if (result.outcome === 'away') {
      away.won += 1;
      away.points += POINTS_WIN;
      home.lost += 1;
      home.points += POINTS_LOSS;
      headToHead.set(h2hKey(away.house, home.house), 1);
      headToHead.set(h2hKey(home.house, away.house), -1);
    } else {
      home.drawn += 1;
      away.drawn += 1;
      home.points += POINTS_DRAW;
      away.points += POINTS_DRAW;
    }
  }

  const rows = [...table.values()];
  for (const row of rows) {
    row.scoreDifference = row.scoreFor - row.scoreAgainst;
  }

  rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.won !== a.won) return b.won - a.won;
    if (b.scoreDifference !== a.scoreDifference) return b.scoreDifference - a.scoreDifference;
    if (b.scoreFor !== a.scoreFor) return b.scoreFor - a.scoreFor;

    // Head-to-head, only meaningful between the two houses being compared.
    const h2h = headToHead.get(h2hKey(a.house, b.house));
    if (h2h === 1) return -1;
    if (h2h === -1) return 1;

    return a.house.localeCompare(b.house);
  });

  return rows.map((row, index) => ({ ...row, position: index + 1 }));
};

fixtureSchema.statics.rangesOverlap = rangesOverlap;
fixtureSchema.statics.toMinutes = toMinutes;
fixtureSchema.statics.formatMinutes = formatMinutes;
fixtureSchema.statics.todayKey = todayKey;
fixtureSchema.statics.SPORTS = SPORTS;
fixtureSchema.statics.STAGES = STAGES;
fixtureSchema.statics.HOUSES = HOUSES;
fixtureSchema.statics.AGE_GROUPS = AGE_GROUPS;
fixtureSchema.statics.FIXTURE_STATUSES = FIXTURE_STATUSES;
fixtureSchema.statics.OFFICIAL_DUTIES = OFFICIAL_DUTIES;
fixtureSchema.statics.BLOCKING_STATUSES = BLOCKING_STATUSES;
fixtureSchema.statics.COUNTING_STATUSES = COUNTING_STATUSES;
fixtureSchema.statics.POINTS = {
  win: POINTS_WIN,
  draw: POINTS_DRAW,
  loss: POINTS_LOSS,
};

module.exports = mongoose.model('Fixture', fixtureSchema);
