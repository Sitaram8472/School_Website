const mongoose = require('mongoose');

/**
 * Exam hall seating plans and invigilation duty.
 *
 * The allocator lives in this file as a set of pure functions rather than in
 * the controller, so it can be reasoned about and exercised without a database
 * in front of it. A seating plan is a document that gets printed, lost and
 * reprinted; if the second print is a different plan then the invigilator's
 * copy and the door list disagree and the student in C7 is marked absent. So
 * allocation is deterministic given the stored `allocationSeed`, and the seed
 * is written down.
 */

const PLAN_STATUSES = ['draft', 'allocated', 'published', 'locked', 'cancelled'];

const CANDIDATE_STATUSES = ['unallocated', 'allocated', 'present', 'absent', 'debarred'];

const INVIGILATOR_ROLES = ['chief', 'assistant', 'relief'];

// Which moves the lifecycle permits. Anything not listed here is a 409.
const TRANSITIONS = {
  draft: ['allocated', 'cancelled'],
  allocated: ['draft', 'published', 'cancelled'],
  published: ['locked', 'cancelled'],
  locked: [],
  cancelled: [],
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const MAX_ROWS = 26;
const MAX_COLUMNS = 40;

function toMinutes(time) {
  if (typeof time !== 'string' || !TIME_PATTERN.test(time)) return null;
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Row 0 column 0 is "A1". Rows are letters because that is what gets taped to
 * the end of the row, and columns are 1-based because nobody writes "seat 0"
 * on a desk.
 */
function seatLabel(row, column) {
  return `${String.fromCharCode(65 + row)}${column + 1}`;
}

function parseSeatLabel(label) {
  const match = /^([A-Z])(\d{1,2})$/.exec(String(label || '').trim().toUpperCase());
  if (!match) return null;
  return {
    row: match[1].charCodeAt(0) - 65,
    column: Number(match[2]) - 1,
  };
}

/**
 * mulberry32 — a small, fast, fully deterministic PRNG.
 *
 * `Math.random()` would make the plan unreproducible, which is the one thing a
 * seating plan must not be.
 */
function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(items, random) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Walks the hall left-to-right along one row, then right-to-left along the
 * next.
 *
 * Straight row-major order puts consecutive candidates directly above one
 * another at every row boundary, which is the one adjacency a straight walk
 * reliably creates. Serpentine order does not.
 */
function serpentineSeats(rows, columns, blocked = []) {
  const blockedSet = new Set(blocked.map((label) => String(label).toUpperCase()));
  const seats = [];

  for (let row = 0; row < rows; row += 1) {
    const leftToRight = row % 2 === 0;
    for (let step = 0; step < columns; step += 1) {
      const column = leftToRight ? step : columns - 1 - step;
      const label = seatLabel(row, column);
      // Blocked seats are skipped, not renumbered — B3 has to mean B3 on the
      // day, whatever the plan says about it.
      if (blockedSet.has(label)) continue;
      seats.push({ row, column, label });
    }
  }
  return seats;
}

/**
 * Counts pairs of same-subject candidates sitting next to each other,
 * separately for horizontal (same row, adjacent column) and vertical (same
 * column, adjacent row) neighbours.
 *
 * Reported rather than asserted: with thirty candidates all writing the same
 * paper in a 5x6 hall, no arrangement separates them, and an allocator that
 * failed — or worse, quietly claimed success — would be useless.
 */
function countViolations(placements) {
  const bySeat = new Map();
  placements.forEach((placement) => {
    bySeat.set(`${placement.row}:${placement.column}`, placement);
  });

  let horizontal = 0;
  let vertical = 0;
  const pairs = [];

  placements.forEach((placement) => {
    const right = bySeat.get(`${placement.row}:${placement.column + 1}`);
    const below = bySeat.get(`${placement.row + 1}:${placement.column}`);

    if (right && right.subjectCode === placement.subjectCode) {
      horizontal += 1;
      pairs.push({ a: placement.seatLabel, b: right.seatLabel, axis: 'horizontal' });
    }
    if (below && below.subjectCode === placement.subjectCode) {
      vertical += 1;
      pairs.push({ a: placement.seatLabel, b: below.seatLabel, axis: 'vertical' });
    }
  });

  return { horizontal, vertical, total: horizontal + vertical, pairs };
}

const NEIGHBOUR_OFFSETS = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
];

/**
 * How many of a seat's four orthogonal neighbours are writing the same paper.
 *
 * `ignoreKey` excludes one neighbour from the count. It is used when scoring a
 * swap between two seats that happen to be neighbours: those two are always of
 * different subjects (same-subject pairs are never swapped, the score cannot
 * change), so the pair contributes nothing either before or after and counting
 * it would make an improving swap look like a worsening one.
 */
function localViolations(bySeat, row, column, subjectCode, ignoreKey = null) {
  let count = 0;
  for (const [dr, dc] of NEIGHBOUR_OFFSETS) {
    const key = `${row + dr}:${column + dc}`;
    if (key === ignoreKey) continue;
    const neighbour = bySeat.get(key);
    if (neighbour && neighbour.subjectCode === subjectCode) count += 1;
  }
  return count;
}

/**
 * Greedy repair pass — a polish over whatever the placement walk left behind.
 *
 * The walk in `allocateSeats` chooses with its neighbours in view, so on a
 * balanced subject mix there is usually nothing here to do. It earns its keep
 * near the end of a lopsided hall, where the last few seats have no
 * non-clashing candidate left and a swap with a seat further back can still
 * help. Each pair is tried and any swap that lowers the count is kept.
 *
 * The score change is computed from the two seats' own neighbourhoods rather
 * than by recounting the hall, which is what keeps this O(passes x n^2)
 * instead of O(passes x n^3) — a 20x25 hall is 500 candidates, and recounting
 * per trial swap would mean 125 million comparisons a pass.
 *
 * Candidates of the same subject are never swapped with each other: the score
 * cannot change, so the two seats' neighbourhoods stay symmetric and the local
 * delta stays exact even when the pair happens to be adjacent.
 *
 * Deterministic — the walk order is fixed and no randomness is involved, so
 * the same seed still gives the same plan.
 */
function repairAdjacency(placements, maxPasses = 4) {
  const working = placements.map((placement) => ({ ...placement }));

  const bySeat = new Map();
  working.forEach((placement) => {
    bySeat.set(`${placement.row}:${placement.column}`, placement);
  });

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let improved = false;

    for (let i = 0; i < working.length; i += 1) {
      for (let j = i + 1; j < working.length; j += 1) {
        const a = working[i];
        const b = working[j];
        if (a.subjectCode === b.subjectCode) continue;

        const keyA = `${a.row}:${a.column}`;
        const keyB = `${b.row}:${b.column}`;

        const before =
          localViolations(bySeat, a.row, a.column, a.subjectCode, keyB) +
          localViolations(bySeat, b.row, b.column, b.subjectCode, keyA);

        if (before === 0) continue;

        const after =
          localViolations(bySeat, a.row, a.column, b.subjectCode, keyB) +
          localViolations(bySeat, b.row, b.column, a.subjectCode, keyA);

        if (after >= before) continue;

        // Exchange the seats, keeping `bySeat` and the array in seat order.
        const heldSeat = { seatLabel: a.seatLabel, row: a.row, column: a.column };
        a.seatLabel = b.seatLabel;
        a.row = b.row;
        a.column = b.column;
        b.seatLabel = heldSeat.seatLabel;
        b.row = heldSeat.row;
        b.column = heldSeat.column;

        bySeat.set(`${a.row}:${a.column}`, a);
        bySeat.set(`${b.row}:${b.column}`, b);
        working[i] = b;
        working[j] = a;
        improved = true;
      }
    }

    if (!improved) break;
  }

  return working;
}

/**
 * The allocator. Pure: same candidates, same hall, same seed, same output.
 *
 * Walks the seats in serpentine order and, at each seat, takes a candidate
 * from the largest remaining subject bucket that does not clash with the
 * neighbours already placed. Taking from the *largest* bucket is what stops
 * the walk painting itself into a corner: a subject left until last has
 * nowhere to go but next to itself.
 *
 * An earlier version of this laid the interleaved list straight onto the seats
 * and then hill-climbed the clashes out. It got stuck — three subjects of ten
 * in a 5x6 hall stalled at eight vertical pairs even though a clean
 * arrangement exists. Choosing with the neighbours in view is both simpler and
 * strictly better; `repairAdjacency` stays on afterwards as a cheap polish for
 * whatever the greedy pass leaves behind.
 *
 * Returns `{ placements, violations }`, or throws when the hall is too small,
 * so the caller can turn that into a 409 without having allocated anything.
 */
function allocateSeats(candidates, hall, seed) {
  const seats = serpentineSeats(hall.rows, hall.columns, hall.blockedSeats || []);

  if (candidates.length > seats.length) {
    const error = new Error(
      `${candidates.length} candidates will not fit in ${seats.length} usable seats.`
    );
    error.code = 'HALL_TOO_SMALL';
    throw error;
  }

  const random = seededRandom(seed);

  // Shuffled within each subject: left in roll-number order, the plan would
  // seat the same neighbours together at every exam, which is its own leak.
  const buckets = new Map();
  candidates.forEach((candidate) => {
    const key = (candidate.subjectCode || 'GENERAL').toUpperCase();
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(candidate);
  });

  const pools = Array.from(buckets.entries())
    .map(([key, entries]) => ({ key, entries: seededShuffle(entries, random) }))
    // Ties broken on the subject code so the ordering is total and does not
    // depend on Map insertion order.
    .sort((a, b) => b.entries.length - a.entries.length || a.key.localeCompare(b.key));

  const bySeat = new Map();
  const placements = [];

  for (const seat of seats) {
    if (placements.length === candidates.length) break;

    const taken = new Set();
    for (const [dr, dc] of NEIGHBOUR_OFFSETS) {
      const neighbour = bySeat.get(`${seat.row + dr}:${seat.column + dc}`);
      if (neighbour) taken.add(neighbour.subjectCode);
    }

    // Largest remaining bucket that does not clash. Pools are kept sorted by
    // remaining size, so the first match is the largest.
    const remaining = pools
      .filter((pool) => pool.entries.length > 0)
      .sort((a, b) => b.entries.length - a.entries.length || a.key.localeCompare(b.key));

    const pool =
      remaining.find((entry) => !taken.has(entry.key)) ||
      // Every remaining subject already sits next to this seat. Unavoidable —
      // take the largest and let countViolations report it.
      remaining[0];

    if (!pool) break;

    const candidate = pool.entries.shift();
    const placement = {
      ...candidate,
      subjectCode: pool.key,
      seatLabel: seat.label,
      row: seat.row,
      column: seat.column,
    };
    placements.push(placement);
    bySeat.set(`${seat.row}:${seat.column}`, placement);
  }

  const repaired = repairAdjacency(placements);

  return { placements: repaired, violations: countViolations(repaired) };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const candidateSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    studentName: {
      type: String,
      required: [true, 'Candidate name is required'],
      trim: true,
      maxlength: [80, 'Candidate name cannot exceed 80 characters'],
    },
    rollNumber: {
      type: String,
      required: [true, 'Roll number is required'],
      trim: true,
      uppercase: true,
      maxlength: [20, 'Roll number cannot exceed 20 characters'],
    },
    subjectCode: {
      type: String,
      required: [true, 'Subject code is required'],
      trim: true,
      uppercase: true,
      maxlength: [12, 'Subject code cannot exceed 12 characters'],
    },
    className: {
      type: String,
      trim: true,
      maxlength: [30, 'Class name cannot exceed 30 characters'],
    },
    // All three are written by the allocator. A client-supplied value is
    // dropped when candidates are added.
    seatLabel: { type: String, default: null },
    row: { type: Number, default: null },
    column: { type: Number, default: null },
    status: {
      type: String,
      enum: CANDIDATE_STATUSES,
      default: 'unallocated',
    },
  },
  { _id: true }
);

const invigilatorSchema = new mongoose.Schema(
  {
    teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    teacherName: { type: String, trim: true },
    role: {
      type: String,
      enum: INVIGILATOR_ROLES,
      default: 'assistant',
    },
    assignedAt: { type: Date, default: Date.now },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { _id: true }
);

const auditSchema = new mongoose.Schema(
  {
    action: { type: String, required: true },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    performedByName: { type: String, trim: true },
    fromStatus: { type: String, default: null },
    toStatus: { type: String, default: null },
    detail: { type: String, trim: true, maxlength: 300, default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const hallSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Hall name is required'],
      trim: true,
      maxlength: [60, 'Hall name cannot exceed 60 characters'],
    },
    rows: {
      type: Number,
      required: [true, 'Row count is required'],
      min: [1, 'A hall needs at least one row'],
      max: [MAX_ROWS, `A hall cannot have more than ${MAX_ROWS} rows`],
    },
    columns: {
      type: Number,
      required: [true, 'Column count is required'],
      min: [1, 'A hall needs at least one column'],
      max: [MAX_COLUMNS, `A hall cannot have more than ${MAX_COLUMNS} columns`],
    },
    // Broken desk, pillar in the way, seat by the door.
    blockedSeats: {
      type: [String],
      default: [],
    },
  },
  { _id: false }
);

const seatingPlanSchema = new mongoose.Schema(
  {
    exam: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      default: null,
      index: true,
    },
    examTitle: {
      type: String,
      required: [true, 'Exam title is required'],
      trim: true,
      maxlength: [120, 'Exam title cannot exceed 120 characters'],
    },
    examDate: {
      type: String,
      required: [true, 'Exam date is required'],
      match: [DATE_PATTERN, 'Exam date must be in YYYY-MM-DD format'],
      index: true,
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
    startMinute: { type: Number, min: 0, max: 1439 },
    endMinute: { type: Number, min: 0, max: 1440 },
    hall: {
      type: hallSchema,
      required: true,
    },
    candidates: {
      type: [candidateSchema],
      default: [],
    },
    invigilators: {
      type: [invigilatorSchema],
      default: [],
    },
    status: {
      type: String,
      enum: PLAN_STATUSES,
      default: 'draft',
      index: true,
    },
    // Stored so the plan can be regenerated byte-for-byte.
    allocationSeed: {
      type: Number,
      default: null,
    },
    allocatedAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
    lockedAt: { type: Date, default: null },
    adjacencyViolations: {
      horizontal: { type: Number, default: 0 },
      vertical: { type: Number, default: 0 },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    createdByName: { type: String, trim: true },
    notes: {
      type: String,
      trim: true,
      maxlength: [500, 'Notes cannot exceed 500 characters'],
      default: null,
    },
    auditTrail: {
      type: [auditSchema],
      default: [],
    },
  },
  { timestamps: true }
);

seatingPlanSchema.index({ examDate: 1, 'hall.name': 1 });
seatingPlanSchema.index({ 'invigilators.teacher': 1, examDate: 1 });
seatingPlanSchema.index({ 'candidates.student': 1 });

/**
 * Mongoose 9 has dropped callback-style middleware — a hook written
 * `pre('validate', function (next) {...})` is silently skipped, taking this
 * derivation with it. Async function, throws rather than calling next(err).
 */
seatingPlanSchema.pre('validate', async function derive() {
  this.startMinute = toMinutes(this.startTime);
  this.endMinute = toMinutes(this.endTime);

  if (this.startMinute === null || this.endMinute === null) return;

  if (this.endMinute <= this.startMinute) {
    this.invalidate('endTime', 'End time must be after start time');
    return;
  }

  if (this.hall) {
    const bad = (this.hall.blockedSeats || []).filter((label) => {
      const parsed = parseSeatLabel(label);
      return (
        !parsed ||
        parsed.row >= this.hall.rows ||
        parsed.column >= this.hall.columns
      );
    });
    if (bad.length > 0) {
      this.invalidate(
        'hall.blockedSeats',
        `These seats are not in the hall: ${bad.join(', ')}`
      );
    }
  }
});

seatingPlanSchema.virtual('capacity').get(function capacity() {
  if (!this.hall) return 0;
  return Math.max(
    0,
    this.hall.rows * this.hall.columns - (this.hall.blockedSeats || []).length
  );
});

seatingPlanSchema.virtual('seatsUsed').get(function seatsUsed() {
  return this.candidates.filter((candidate) => candidate.seatLabel).length;
});

seatingPlanSchema.virtual('seatsFree').get(function seatsFree() {
  return Math.max(0, this.capacity - this.seatsUsed);
});

/**
 * A plan is only editable while nobody has been told where to sit.
 */
seatingPlanSchema.virtual('isEditable').get(function isEditable() {
  return ['draft', 'allocated'].includes(this.status);
});

seatingPlanSchema.methods.canTransition = function canTransition(to) {
  return (TRANSITIONS[this.status] || []).includes(to);
};

/**
 * The single place a plan changes status. Every move is recorded, so the audit
 * trail cannot be bypassed by adding another endpoint that sets `status`
 * directly.
 */
seatingPlanSchema.methods.moveTo = function moveTo(to, actor, detail = null) {
  if (!this.canTransition(to)) {
    const error = new Error(`A ${this.status} plan cannot become ${to}.`);
    error.code = 'ILLEGAL_TRANSITION';
    throw error;
  }
  const from = this.status;
  this.status = to;
  this.recordAudit(`status:${from}->${to}`, actor, detail, from, to);
  return this;
};

seatingPlanSchema.methods.recordAudit = function recordAudit(
  action,
  actor,
  detail = null,
  fromStatus = null,
  toStatus = null
) {
  this.auditTrail.push({
    action,
    performedBy: actor && (actor._id || actor.id),
    performedByName: actor && actor.name,
    fromStatus,
    toStatus,
    detail,
    at: new Date(),
  });
  return this;
};

seatingPlanSchema.methods.chiefInvigilator = function chiefInvigilator() {
  return this.invigilators.find((entry) => entry.role === 'chief') || null;
};

seatingPlanSchema.methods.hasInvigilator = function hasInvigilator(teacherId) {
  return this.invigilators.some(
    (entry) => String(entry.teacher) === String(teacherId)
  );
};

/**
 * Serialises the plan for a viewer.
 *
 * Staff see everything. A student sees the hall geometry, their own seat, and
 * nothing else — the point of a seating plan is that it is not a directory of
 * who is sitting where, and an unpublished plan tells them nothing at all.
 */
seatingPlanSchema.methods.redactFor = function redactFor(viewer) {
  const plain = this.toObject({ virtuals: true });
  delete plain.__v;

  const isStaff = viewer && ['teacher', 'staff', 'admin'].includes(viewer.role);
  if (isStaff) return plain;

  const viewerId = viewer && (viewer._id || viewer.id);
  const own = this.candidates.find(
    (candidate) => viewerId && String(candidate.student) === String(viewerId)
  );

  plain.candidates = this.status === 'published' && own ? [own.toObject()] : [];
  plain.invigilators = [];
  plain.auditTrail = [];
  plain.notes = null;
  return plain;
};

// Exposed so the controller and the checks can use exactly the code that runs
// in production, rather than a second copy that drifts.
seatingPlanSchema.statics.allocateSeats = allocateSeats;
seatingPlanSchema.statics.serpentineSeats = serpentineSeats;
seatingPlanSchema.statics.countViolations = countViolations;
seatingPlanSchema.statics.repairAdjacency = repairAdjacency;
seatingPlanSchema.statics.seededRandom = seededRandom;
seatingPlanSchema.statics.seatLabel = seatLabel;
seatingPlanSchema.statics.parseSeatLabel = parseSeatLabel;
seatingPlanSchema.statics.toMinutes = toMinutes;
seatingPlanSchema.statics.overlaps = function overlaps(a, b) {
  return a.startMinute < b.endMinute && b.startMinute < a.endMinute;
};
seatingPlanSchema.statics.PLAN_STATUSES = PLAN_STATUSES;
seatingPlanSchema.statics.INVIGILATOR_ROLES = INVIGILATOR_ROLES;
seatingPlanSchema.statics.TRANSITIONS = TRANSITIONS;

seatingPlanSchema.set('toObject', { virtuals: true });
seatingPlanSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('SeatingPlan', seatingPlanSchema);
