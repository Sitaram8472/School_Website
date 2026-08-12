const mongoose = require('mongoose');

/**
 * Student council elections.
 *
 * The paper version ticks names off the same sheet the votes are counted from,
 * so anybody counting can see who voted for whom. The students know it, which
 * is why the candidates who need the most courage to stand do not stand.
 *
 * This model holds the election: its positions, its windows, its candidates and
 * — once, at publication — its frozen tally. It deliberately holds no votes.
 * Those live in `Ballot`, which has no voter field, and in `VoterRoll`, which
 * has no candidate field. See `models/Ballot.js` for why the split is the whole
 * guarantee.
 */

const STATUSES = [
  'draft',
  'nominations-open',
  'nominations-closed',
  'voting-open',
  'voting-closed',
  'results-published',
  'cancelled',
];

// A status may only move to one of its listed successors. An election that can
// go backwards from `results-published` is one where a losing candidate's
// parent can ask for another round of voting.
const LEGAL_TRANSITIONS = {
  draft: ['nominations-open', 'cancelled'],
  'nominations-open': ['nominations-closed', 'cancelled'],
  'nominations-closed': ['voting-open', 'nominations-open', 'cancelled'],
  'voting-open': ['voting-closed', 'cancelled'],
  'voting-closed': ['results-published', 'cancelled'],
  'results-published': [],
  cancelled: [],
};

const CANDIDATE_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'];

const MAX_POSITIONS = 12;
const MAX_CANDIDATES = 200;
const MIN_MANIFESTO = 40;
const MAX_MANIFESTO = 2000;

const positionSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: [true, 'A position needs a key'],
      trim: true,
      lowercase: true,
      maxlength: [40, 'A position key cannot exceed 40 characters'],
      match: [/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits and hyphens'],
    },
    title: {
      type: String,
      required: [true, 'A position needs a title'],
      trim: true,
      maxlength: [80, 'A position title cannot exceed 80 characters'],
    },
    seats: {
      type: Number,
      default: 1,
      min: [1, 'A position must have at least one seat'],
      max: [20, 'A position cannot have more than 20 seats'],
    },
    // Empty means the election's own cohort. A position restricted to Year 12
    // is restricted for both standing and voting.
    eligibleYearGroups: {
      type: [String],
      default: [],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [500, 'A position description cannot exceed 500 characters'],
    },
  },
  { _id: false, timestamps: false }
);

const candidateSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A candidacy must name its student'],
    },
    // Snapshotted so the ballot paper and the published result still read
    // correctly if the account is later removed.
    studentName: {
      type: String,
      trim: true,
      maxlength: [120, 'Name cannot exceed 120 characters'],
    },
    yearGroup: {
      type: String,
      trim: true,
      maxlength: [40, 'Year group cannot exceed 40 characters'],
    },
    positionKey: {
      type: String,
      required: [true, 'A candidacy must name its position'],
      trim: true,
      lowercase: true,
    },
    manifesto: {
      type: String,
      required: [true, 'A manifesto is required'],
      trim: true,
      minlength: [MIN_MANIFESTO, `Please write at least ${MIN_MANIFESTO} characters`],
      maxlength: [MAX_MANIFESTO, `Please keep this under ${MAX_MANIFESTO} characters`],
    },
    seconder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A nomination needs a seconder'],
    },
    seconderName: {
      type: String,
      trim: true,
      maxlength: [120, 'Name cannot exceed 120 characters'],
    },
    status: {
      type: String,
      enum: { values: CANDIDATE_STATUSES, message: 'Invalid candidacy status' },
      default: 'pending',
    },
    // A rejection the student cannot read is a rejection they cannot answer.
    rejectionReason: {
      type: String,
      trim: true,
      maxlength: [500, 'Reason cannot exceed 500 characters'],
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    reviewedAt: { type: Date },
    nominatedAt: { type: Date, default: Date.now },
  },
  { _id: true, timestamps: false }
);

const tallySchema = new mongoose.Schema(
  {
    positionKey: { type: String, required: true },
    positionTitle: { type: String },
    seats: { type: Number },
    votesCast: { type: Number, default: 0 },
    abstentions: { type: Number, default: 0 },
    counts: [
      {
        candidateId: { type: mongoose.Schema.Types.ObjectId },
        studentName: { type: String },
        votes: { type: Number, default: 0 },
        elected: { type: Boolean, default: false },
      },
    ],
  },
  { _id: false, timestamps: false }
);

const historySchema = new mongoose.Schema(
  {
    action: { type: String, required: true, trim: true, maxlength: [40, 'Too long'] },
    from: { type: String, trim: true, maxlength: [80, 'Too long'] },
    to: { type: String, trim: true, maxlength: [80, 'Too long'] },
    note: { type: String, trim: true, maxlength: [500, 'Too long'] },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
  },
  { _id: true, timestamps: false }
);

const electionSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'An election needs a title'],
      trim: true,
      minlength: [4, 'Title must be at least 4 characters'],
      maxlength: [150, 'Title cannot exceed 150 characters'],
    },
    academicYear: {
      type: String,
      required: [true, 'An academic year is required'],
      trim: true,
      match: [/^\d{4}-\d{2}$/, 'Use the form 2026-27'],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [2000, 'Description cannot exceed 2000 characters'],
    },

    positions: {
      type: [positionSchema],
      default: [],
      validate: {
        validator: (v) => v.length > 0 && v.length <= MAX_POSITIONS,
        message: `An election must have between 1 and ${MAX_POSITIONS} positions`,
      },
    },

    nominationOpensAt: { type: Date, required: [true, 'A nomination opening time is required'] },
    nominationClosesAt: { type: Date, required: [true, 'A nomination closing time is required'] },
    votingOpensAt: { type: Date, required: [true, 'A voting opening time is required'] },
    votingClosesAt: { type: Date, required: [true, 'A voting closing time is required'] },

    eligibleYearGroups: {
      type: [String],
      default: [],
    },
    // The denominator for turnout. Snapshotted when voting opens so a student
    // joining mid-week cannot make last year's turnout look worse.
    eligibleVoterCount: {
      type: Number,
      min: [0, 'Eligible voter count cannot be negative'],
    },

    status: {
      type: String,
      enum: { values: STATUSES, message: 'Invalid status' },
      default: 'draft',
    },

    candidates: {
      type: [candidateSchema],
      default: [],
      validate: {
        validator: (v) => v.length <= MAX_CANDIDATES,
        message: `An election cannot carry more than ${MAX_CANDIDATES} candidacies`,
      },
    },

    // Written exactly once, at publication, from the ballot collection.
    results: {
      tallies: { type: [tallySchema], default: [] },
      turnout: { type: Number },
      ballotsCast: { type: Number },
      votersRecorded: { type: Number },
      computedAt: { type: Date },
      computedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

electionSchema.index({ status: 1, votingOpensAt: -1 });
electionSchema.index({ academicYear: 1 });
electionSchema.index({ 'candidates.student': 1 });

electionSchema.pre('validate', function derive() {
  // Windows must run forwards, and voting must not start before nominations
  // finish — otherwise a ballot paper exists before its candidates do.
  if (this.nominationOpensAt && this.nominationClosesAt) {
    if (this.nominationClosesAt <= this.nominationOpensAt) {
      this.invalidate('nominationClosesAt', 'Nominations must close after they open');
    }
  }
  if (this.votingOpensAt && this.votingClosesAt) {
    if (this.votingClosesAt <= this.votingOpensAt) {
      this.invalidate('votingClosesAt', 'Voting must close after it opens');
    }
  }
  if (this.nominationClosesAt && this.votingOpensAt) {
    if (this.votingOpensAt < this.nominationClosesAt) {
      this.invalidate(
        'votingOpensAt',
        'Voting cannot open before nominations close — the ballot paper would not be final'
      );
    }
  }

  const keys = new Set();
  for (const position of this.positions || []) {
    if (keys.has(position.key)) {
      this.invalidate('positions', `Two positions share the key "${position.key}"`);
    }
    keys.add(position.key);
  }

  for (const candidate of this.candidates || []) {
    if (!keys.has(candidate.positionKey)) {
      this.invalidate(
        'candidates',
        `A candidacy names a position that does not exist: "${candidate.positionKey}"`
      );
    }
    // A student seconding their own nomination is not a second opinion.
    if (
      candidate.seconder &&
      String(candidate.seconder) === String(candidate.student)
    ) {
      this.invalidate('candidates', 'A candidate cannot second their own nomination');
    }
  }
});

electionSchema.methods.positionFor = function positionFor(key) {
  return (this.positions || []).find((position) => position.key === key) || null;
};

/** Candidates on the ballot paper: approved only, in nomination order. */
electionSchema.methods.approvedCandidatesFor = function approvedCandidatesFor(key) {
  return (this.candidates || []).filter(
    (candidate) => candidate.positionKey === key && candidate.status === 'approved'
  );
};

electionSchema.methods.candidacyFor = function candidacyFor(studentId, positionKey) {
  return (
    (this.candidates || []).find(
      (candidate) =>
        String(candidate.student) === String(studentId) &&
        candidate.positionKey === positionKey &&
        candidate.status !== 'withdrawn' &&
        candidate.status !== 'rejected'
    ) || null
  );
};

/**
 * Whether the nomination window is open **right now**, by the server clock.
 *
 * Status alone is not enough: an admin who opens nominations and goes home
 * should not leave them open past the published closing time.
 */
electionSchema.methods.nominationsOpen = function nominationsOpen(now = new Date()) {
  return (
    this.status === 'nominations-open' &&
    now >= this.nominationOpensAt &&
    now <= this.nominationClosesAt
  );
};

electionSchema.methods.votingOpen = function votingOpen(now = new Date()) {
  return this.status === 'voting-open' && now >= this.votingOpensAt && now <= this.votingClosesAt;
};

/** Why this voter may not vote, or null when they may. */
electionSchema.methods.votingBlockedReason = function votingBlockedReason(user, now = new Date()) {
  if (!user) return 'Not authenticated';
  if (user.role !== 'student') return 'Only students vote in a student council election';
  if (this.status === 'cancelled') return 'This election was cancelled';
  if (this.status !== 'voting-open') {
    return this.status === 'results-published' || this.status === 'voting-closed'
      ? 'Voting has closed'
      : 'Voting has not opened yet';
  }
  if (now < this.votingOpensAt) {
    return `Voting opens at ${this.votingOpensAt.toISOString().slice(0, 16).replace('T', ' ')}`;
  }
  if (now > this.votingClosesAt) {
    return `Voting closed at ${this.votingClosesAt.toISOString().slice(0, 16).replace('T', ' ')}`;
  }
  return null;
};

/**
 * Whether `yearGroup` may take part in this position.
 *
 * A position's own list wins where it has one; otherwise the election's list
 * applies; an empty list at both levels means the whole school.
 */
electionSchema.methods.isEligibleFor = function isEligibleFor(positionKey, yearGroup) {
  const position = this.positionFor(positionKey);
  if (!position) return false;

  const list =
    position.eligibleYearGroups && position.eligibleYearGroups.length
      ? position.eligibleYearGroups
      : this.eligibleYearGroups;

  if (!list || !list.length) return true;
  if (!yearGroup) return false;
  return list.map(String).includes(String(yearGroup));
};

electionSchema.methods.canTransitionTo = function canTransitionTo(next) {
  return (LEGAL_TRANSITIONS[this.status] || []).includes(next);
};

electionSchema.methods.recordHistory = function recordHistory(entry) {
  this.history.push({
    action: entry.action,
    from: entry.from === undefined || entry.from === null ? undefined : String(entry.from),
    to: entry.to === undefined || entry.to === null ? undefined : String(entry.to),
    note: entry.note,
    by: entry.by,
    at: new Date(),
  });
};

/**
 * The public shape of the election.
 *
 * Nominations that are pending or rejected are visible only to staff. A
 * rejected candidacy on a public page is a punishment nobody agreed to hand
 * out.
 */
electionSchema.methods.toRowFor = function toRowFor(viewer, now = new Date()) {
  const isStaff =
    viewer && (viewer.role === 'teacher' || viewer.role === 'staff' || viewer.role === 'admin');

  const positions = (this.positions || []).map((position) => {
    const candidates = isStaff
      ? (this.candidates || []).filter((candidate) => candidate.positionKey === position.key)
      : this.approvedCandidatesFor(position.key);

    return {
      key: position.key,
      title: position.title,
      seats: position.seats,
      eligibleYearGroups: position.eligibleYearGroups,
      description: position.description,
      candidates: candidates.map((candidate) => ({
        _id: candidate._id,
        student: isStaff ? candidate.student : undefined,
        studentName: candidate.studentName,
        yearGroup: candidate.yearGroup,
        manifesto: candidate.manifesto,
        status: candidate.status,
        rejectionReason: isStaff ? candidate.rejectionReason : undefined,
        seconderName: isStaff ? candidate.seconderName : undefined,
        nominatedAt: candidate.nominatedAt,
      })),
    };
  });

  return {
    _id: this._id,
    title: this.title,
    academicYear: this.academicYear,
    description: this.description,
    status: this.status,
    positions,
    nominationOpensAt: this.nominationOpensAt,
    nominationClosesAt: this.nominationClosesAt,
    votingOpensAt: this.votingOpensAt,
    votingClosesAt: this.votingClosesAt,
    eligibleYearGroups: this.eligibleYearGroups,
    eligibleVoterCount: this.eligibleVoterCount,
    nominationsOpen: this.nominationsOpen(now),
    votingOpen: this.votingOpen(now),
    resultsPublished: this.status === 'results-published',
    createdAt: this.createdAt,
  };
};

/** The frozen tally, readable only once published. */
electionSchema.methods.toResults = function toResults() {
  if (this.status !== 'results-published') return null;
  return {
    tallies: this.results.tallies,
    turnout: this.results.turnout,
    ballotsCast: this.results.ballotsCast,
    votersRecorded: this.results.votersRecorded,
    eligibleVoterCount: this.eligibleVoterCount,
    computedAt: this.results.computedAt,
  };
};

electionSchema.statics.STATUSES = STATUSES;
electionSchema.statics.LEGAL_TRANSITIONS = LEGAL_TRANSITIONS;
electionSchema.statics.CANDIDATE_STATUSES = CANDIDATE_STATUSES;
electionSchema.statics.MAX_POSITIONS = MAX_POSITIONS;
electionSchema.statics.MIN_MANIFESTO = MIN_MANIFESTO;
electionSchema.statics.MAX_MANIFESTO = MAX_MANIFESTO;

module.exports = mongoose.model('Election', electionSchema);
