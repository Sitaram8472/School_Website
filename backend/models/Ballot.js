const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * The two collections that make a school ballot secret.
 *
 * `Ballot` records what was chosen. It has **no voter field**, and there is
 * nowhere to put one — not a hashed one, not an encrypted one, not one behind a
 * flag. A field that exists can be read, and the promise made to a fourteen
 * year old standing against a popular candidate has to be stronger than a
 * policy about who is allowed to run the query.
 *
 * `VoterRoll` records **that** somebody voted, and nothing else. Its unique
 * compound index on `{ election, voter }` is what stops a second vote — not a
 * `findOne` followed by a `create`, which loses to two tabs and a network
 * hiccup.
 *
 * The controller writes the roll entry *first*. If the index rejects it, the
 * request stops before any ballot exists. The other order fails open: a counted
 * ballot with no roll entry is a double vote nobody can detect afterwards.
 *
 * `castAt` is rounded down to the hour on both documents. A microsecond-precise
 * timestamp on two collections is a join key, and a ballot that can be matched
 * to a roll entry by its timestamp is not anonymous. The rounding costs nothing
 * anybody needs.
 */

/** The hour containing `date`, in UTC. The de-correlation described above. */
function toHourBucket(date = new Date()) {
  const bucket = new Date(date.getTime());
  bucket.setUTCMinutes(0, 0, 0);
  return bucket;
}

/**
 * A random ballot id.
 *
 * Bucketing `castAt` to the hour is pointless if the primary key undoes it, and
 * a default Mongo `ObjectId` does exactly that: its leading four bytes are the
 * creation time in seconds. Two collections whose ids both carry the same
 * second are joinable on that second, which is the correlation the whole split
 * exists to prevent — so a ballot's id carries no time at all.
 */
function randomBallotId() {
  return crypto.randomBytes(16).toString('hex');
}

const ballotSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: randomBallotId,
    },
    election: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Election',
      required: [true, 'A ballot must belong to an election'],
    },
    positionKey: {
      type: String,
      required: [true, 'A ballot must name its position'],
      trim: true,
      lowercase: true,
    },
    // Unset means an abstention. An abstention is a choice a voter made and is
    // recorded as one, rather than as a missing row that looks like a bug.
    candidate: {
      type: mongoose.Schema.Types.ObjectId,
    },
    candidateName: {
      type: String,
      trim: true,
      maxlength: [120, 'Name cannot exceed 120 characters'],
    },
    castAt: {
      type: Date,
      required: true,
    },
  },
  // No timestamps. `createdAt` would reintroduce exactly the millisecond-level
  // join key that `castAt` is bucketed to avoid.
  { timestamps: false }
);

ballotSchema.index({ election: 1, positionKey: 1 });

const voterRollSchema = new mongoose.Schema(
  {
    election: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Election',
      required: [true, 'A roll entry must belong to an election'],
    },
    voter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A roll entry must name its voter'],
    },
    votedAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: false }
);

// The single-vote guarantee. It is a constraint rather than a check, so it
// holds under concurrency — which is the only condition where it matters.
voterRollSchema.index({ election: 1, voter: 1 }, { unique: true });

const Ballot = mongoose.model('Ballot', ballotSchema);
const VoterRoll = mongoose.model('VoterRoll', voterRollSchema);

/**
 * Count an election's ballots per position and per candidate.
 *
 * Runs against the ballot collection at publication time. The election
 * document stores the answer once; it never keeps a running counter, because a
 * counter incremented on every vote is a number that drifts on the first
 * retried request and drifts silently.
 */
async function tallyElection(election) {
  const rows = await Ballot.aggregate([
    { $match: { election: election._id } },
    {
      $group: {
        _id: { positionKey: '$positionKey', candidate: '$candidate' },
        votes: { $sum: 1 },
        candidateName: { $first: '$candidateName' },
      },
    },
  ]);

  const byPosition = new Map();
  for (const row of rows) {
    const key = row._id.positionKey;
    if (!byPosition.has(key)) byPosition.set(key, { counts: [], abstentions: 0, votesCast: 0 });
    const entry = byPosition.get(key);
    entry.votesCast += row.votes;

    if (!row._id.candidate) {
      entry.abstentions += row.votes;
      continue;
    }
    entry.counts.push({
      candidateId: row._id.candidate,
      studentName: row.candidateName,
      votes: row.votes,
    });
  }

  const tallies = [];

  for (const position of election.positions || []) {
    const entry = byPosition.get(position.key) || { counts: [], abstentions: 0, votesCast: 0 };

    // Highest first; a tie is left in whatever order it arrives, because
    // inventing a tiebreak here would decide an election by sort stability.
    const counts = entry.counts.sort((a, b) => b.votes - a.votes);

    // Seats are filled top-down, but a tie spanning the last seat elects
    // nobody into it — that is a run-off for a human to call, not a rounding
    // decision for a sort function.
    const seats = position.seats || 1;
    const cutoffVotes = counts[seats - 1] ? counts[seats - 1].votes : null;
    const tiedAtCutoff =
      cutoffVotes !== null && counts.filter((row) => row.votes === cutoffVotes).length > 1;

    counts.forEach((row, index) => {
      if (index < seats) {
        row.elected = !(tiedAtCutoff && row.votes === cutoffVotes);
      } else {
        row.elected = false;
      }
    });

    tallies.push({
      positionKey: position.key,
      positionTitle: position.title,
      seats,
      votesCast: entry.votesCast,
      abstentions: entry.abstentions,
      counts,
    });
  }

  return tallies;
}

module.exports = { Ballot, VoterRoll, tallyElection, toHourBucket };
