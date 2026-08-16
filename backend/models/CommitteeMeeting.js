const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * Committees, their meetings, and the decisions that bind the school.
 *
 * `MeetingSlot` books a parent into a fifteen-minute slot with a teacher. This
 * is not that, and it should not be made into that.
 *
 * Four rules make a governance record worth anything, and all four are
 * arithmetic or a digest — cheap to compute, and impossible to maintain by hand
 * across a `.docx` and a folder of email:
 *
 *   Quorum is computed at the instant of each vote, from the attendance list
 *     minus members who had left, minus members with no voting rights, minus
 *     everybody who recused themselves on that motion. A decision taken without
 *     quorum is void, and the void-ness is discovered when somebody wants it to
 *     be void.
 *
 *   A vote that does not add up is refused at entry. "Carried 7-2" in a meeting
 *     of eight is unresolvable afterwards, and it is trivially preventable
 *     before.
 *
 *   A recusal changes the denominator rather than adding a footnote, and it can
 *     legitimately push a motion below quorum — which is the honest outcome
 *     when the only people entitled to vote on the canteen contract are the two
 *     without an interest in it.
 *
 *   Approved minutes are fingerprinted, so editing them afterwards is visible
 *     on the record's face rather than being a thing nobody can check.
 */

const COMMITTEE_TYPES = [
  'management',
  'pta',
  'academic-council',
  'disciplinary',
  'finance',
  'tender',
  'safety',
  'admissions',
  'ad-hoc',
];

// A committee of one of these types is not enumerable by non-members. Not
// filtered in the UI — refused in the controller.
const CONFIDENTIAL_TYPES = ['disciplinary', 'tender', 'finance'];

const MEMBER_ROLES = ['chair', 'secretary', 'member', 'invitee', 'observer'];

// Only these roles carry a vote by default. An invitee and an observer are in
// the room and are not part of the count.
const VOTING_ROLES = ['chair', 'secretary', 'member'];

const QUORUM_KINDS = ['fraction', 'fixed'];

const MEETING_MODES = ['in-person', 'online', 'hybrid'];

const MEETING_STATUSES = [
  'scheduled',
  'in-session',
  'minuted',
  'circulated',
  'approved',
  'cancelled',
];

const ATTENDANCE_STATES = ['present', 'absent', 'apology', 'late', 'left-early'];

// Somebody in one of these states was in the room for at least part of it, so
// they can be counted — subject to when they arrived and left.
const IN_THE_ROOM_STATES = ['present', 'late', 'left-early'];

const AGENDA_KINDS = ['information', 'discussion', 'decision'];

const MOTION_OUTCOMES = ['carried', 'lost', 'tied', 'void-no-quorum', 'withdrawn'];

const ACTION_STATUSES = [
  'open',
  'in-progress',
  'done',
  'carried-forward',
  'dropped',
];

// An action in one of these states is still owed to the committee.
const LIVE_ACTION_STATUSES = ['open', 'in-progress', 'carried-forward'];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const MAX_AGENDA_ITEMS = 40;
const MAX_MOTIONS = 60;
const MAX_ACTIONS = 60;

/** Today in the server's local zone, as the YYYY-MM-DD key the model stores. */
function todayKey(now = new Date()) {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function toMinutes(time) {
  if (typeof time !== 'string' || !TIME_PATTERN.test(time)) return null;
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

// ---------------------------------------------------------------------------
// Committee
// ---------------------------------------------------------------------------

const membershipSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A membership must name a person'],
    },
    name: {
      type: String,
      trim: true,
      maxlength: [120, 'Name cannot exceed 120 characters'],
    },
    role: {
      type: String,
      enum: {
        values: MEMBER_ROLES,
        message: 'Invalid committee role',
      },
      default: 'member',
    },
    // Overridable, because a chair with a casting vote only and an observer who
    // was granted one are both real arrangements.
    votingRights: {
      type: Boolean,
      default: undefined,
    },
    joinedOn: {
      type: String,
      required: [true, 'A membership needs a start date'],
      match: [DATE_PATTERN, 'Join date must be in YYYY-MM-DD format'],
    },
    leftOn: {
      type: String,
      match: [DATE_PATTERN, 'Leave date must be in YYYY-MM-DD format'],
      default: null,
    },
  },
  { _id: true }
);

const committeeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'A committee needs a name'],
      trim: true,
      maxlength: [140, 'Name cannot exceed 140 characters'],
    },
    slug: {
      type: String,
      unique: true,
      index: true,
    },
    type: {
      type: String,
      required: [true, 'A committee needs a type'],
      enum: {
        values: COMMITTEE_TYPES,
        message: 'Invalid committee type',
      },
    },
    purpose: {
      type: String,
      trim: true,
      maxlength: [1000, 'Purpose cannot exceed 1000 characters'],
      default: null,
    },
    members: {
      type: [membershipSchema],
      default: [],
    },
    quorumRule: {
      kind: {
        type: String,
        enum: {
          values: QUORUM_KINDS,
          message: 'Invalid quorum rule',
        },
        default: 'fraction',
      },
      // A fraction of the voting membership, or an absolute number.
      value: {
        type: Number,
        default: 0.5,
        min: [0, 'A quorum cannot be negative'],
      },
    },
    termStart: {
      type: String,
      match: [DATE_PATTERN, 'Term start must be in YYYY-MM-DD format'],
      default: null,
    },
    termEnd: {
      type: String,
      match: [DATE_PATTERN, 'Term end must be in YYYY-MM-DD format'],
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Server-owned counter, incremented atomically with $inc so two secretaries
    // cannot both create meeting 004.
    meetingSequence: {
      type: Number,
      default: 0,
    },
    serialPrefix: {
      type: String,
      trim: true,
      maxlength: [12, 'Prefix cannot exceed 12 characters'],
      default: null,
    },
  },
  { timestamps: true }
);

committeeSchema.index({ type: 1, isActive: 1 });
committeeSchema.index({ 'members.user': 1 });

committeeSchema.pre('validate', function derive() {
  if (!this.slug && this.name) this.slug = slugify(this.name);
  if (!this.serialPrefix && this.name) {
    this.serialPrefix = this.name
      .split(/\s+/)
      .map((word) => word[0])
      .join('')
      .toUpperCase()
      .slice(0, 6);
  }

  if (this.quorumRule.kind === 'fraction' && this.quorumRule.value > 1) {
    this.invalidate('quorumRule.value', 'A fraction quorum must be between 0 and 1');
  }

  // One live membership per person. Two rows for the same member would make
  // every count depend on which one the lookup found first.
  const live = new Set();
  for (const member of this.members) {
    if (member.leftOn) continue;
    const key = String(member.user);
    if (live.has(key)) {
      this.invalidate('members', 'That person is already a member of this committee');
    }
    live.add(key);
    if (member.leftOn && member.joinedOn && member.leftOn < member.joinedOn) {
      this.invalidate('members', 'A member cannot leave before they joined');
    }
  }
});

/** Whether this membership carries a vote, honouring an explicit override. */
committeeSchema.methods.memberVotes = function memberVotes(member) {
  if (member.votingRights !== undefined && member.votingRights !== null) {
    return member.votingRights;
  }
  return VOTING_ROLES.includes(member.role);
};

/**
 * The membership as it stood on a given date.
 *
 * Quorum is evaluated against this, not against today's list. A member who left
 * in June was present in May, and a May meeting whose quorum is recomputed
 * against a June membership is a meeting whose decisions quietly become void.
 */
committeeSchema.methods.membershipOn = function membershipOn(dateKey) {
  return this.members.filter((member) => {
    if (member.joinedOn && member.joinedOn > dateKey) return false;
    if (member.leftOn && member.leftOn < dateKey) return false;
    return true;
  });
};

/** How many must be present for the committee to decide anything, on a date. */
committeeSchema.methods.quorumOn = function quorumOn(dateKey) {
  const voting = this.membershipOn(dateKey).filter((member) =>
    this.memberVotes(member)
  );

  const required =
    this.quorumRule.kind === 'fixed'
      ? Math.max(Math.round(this.quorumRule.value), 1)
      : Math.max(Math.ceil(voting.length * this.quorumRule.value), 1);

  return { required, votingMembers: voting.length, members: voting };
};

committeeSchema.methods.roleOf = function roleOf(userId, dateKey = todayKey()) {
  const member = this.membershipOn(dateKey).find(
    (entry) => String(entry.user) === String(userId)
  );
  return member ? member.role : null;
};

committeeSchema.methods.isMember = function isMember(userId, dateKey = todayKey()) {
  return Boolean(this.roleOf(userId, dateKey));
};

committeeSchema.methods.isConfidential = function isConfidential() {
  return CONFIDENTIAL_TYPES.includes(this.type);
};

// ---------------------------------------------------------------------------
// Meeting
// ---------------------------------------------------------------------------

const attendanceSchema = new mongoose.Schema(
  {
    member: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: {
      type: String,
      trim: true,
    },
    state: {
      type: String,
      enum: {
        values: ATTENDANCE_STATES,
        message: 'Invalid attendance state',
      },
      default: 'absent',
    },
    arrivedAt: {
      type: String,
      match: [TIME_PATTERN, 'Arrival must be in HH:MM format'],
      default: null,
    },
    leftAt: {
      type: String,
      match: [TIME_PATTERN, 'Departure must be in HH:MM format'],
      default: null,
    },
    isVoting: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false }
);

const agendaItemSchema = new mongoose.Schema(
  {
    index: {
      type: Number,
      required: true,
      min: 1,
    },
    title: {
      type: String,
      required: [true, 'An agenda item needs a title'],
      trim: true,
      maxlength: [200, 'Title cannot exceed 200 characters'],
    },
    presenter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    kind: {
      type: String,
      enum: {
        values: AGENDA_KINDS,
        message: 'Invalid agenda item kind',
      },
      default: 'discussion',
    },
    papers: {
      type: [String],
      default: [],
    },
    discussion: {
      type: String,
      trim: true,
      maxlength: [4000, 'Discussion cannot exceed 4000 characters'],
      default: null,
    },
  },
  { _id: true }
);

const motionSchema = new mongoose.Schema(
  {
    agendaIndex: {
      type: Number,
      default: null,
    },
    text: {
      type: String,
      required: [true, 'A motion needs its wording'],
      trim: true,
      maxlength: [1000, 'Motion text cannot exceed 1000 characters'],
    },
    movedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A motion needs a mover'],
    },
    secondedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    votesFor: {
      type: Number,
      default: 0,
      min: [0, 'Votes cannot be negative'],
    },
    votesAgainst: {
      type: Number,
      default: 0,
      min: [0, 'Votes cannot be negative'],
    },
    abstentions: {
      type: Number,
      default: 0,
      min: [0, 'Abstentions cannot be negative'],
    },
    // Members who declared an interest and stepped out of the count for this
    // motion only.
    recusals: {
      type: [
        {
          member: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          reason: { type: String, trim: true, maxlength: 500 },
          at: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    // All four derived at the instant the vote is recorded. Never accepted from
    // a client.
    quorumAtVote: {
      type: Number,
      default: null,
    },
    membersPresentAtVote: {
      type: Number,
      default: null,
    },
    eligibleAtVote: {
      type: Number,
      default: null,
    },
    outcome: {
      type: String,
      enum: {
        values: MOTION_OUTCOMES,
        message: 'Invalid outcome',
      },
      default: null,
    },
    decidedAt: {
      type: Date,
      default: null,
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { _id: true }
);

const actionSchema = new mongoose.Schema(
  {
    ref: {
      type: String,
      trim: true,
      maxlength: [40, 'Reference cannot exceed 40 characters'],
    },
    description: {
      type: String,
      required: [true, 'An action needs a description'],
      trim: true,
      maxlength: [1000, 'Description cannot exceed 1000 characters'],
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'An action needs an owner'],
    },
    ownerName: {
      type: String,
      trim: true,
    },
    dueBy: {
      type: String,
      match: [DATE_PATTERN, 'Due date must be in YYYY-MM-DD format'],
      default: null,
    },
    status: {
      type: String,
      enum: {
        values: ACTION_STATUSES,
        message: 'Invalid action status',
      },
      default: 'open',
    },
    closedOn: {
      type: String,
      match: [DATE_PATTERN, 'Closed date must be in YYYY-MM-DD format'],
      default: null,
    },
    closingNote: {
      type: String,
      trim: true,
      maxlength: [1000, 'Closing note cannot exceed 1000 characters'],
      default: null,
    },
    // Where this action came from, if it is not new. An action carried three
    // times is visibly an action carried three times.
    carriedFromMeeting: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CommitteeMeeting',
      default: null,
    },
    carryCount: {
      type: Number,
      default: 0,
    },
    originalRef: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { _id: true }
);

const historySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: [40, 'Action cannot exceed 40 characters'],
    },
    note: {
      type: String,
      trim: true,
      maxlength: [500, 'Note cannot exceed 500 characters'],
    },
    by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    at: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true, timestamps: false }
);

const committeeMeetingSchema = new mongoose.Schema(
  {
    committee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Committee',
      required: [true, 'A meeting must belong to a committee'],
      index: true,
    },
    committeeName: {
      type: String,
      trim: true,
    },
    // Issued by the server from the committee's counter: PTA/2026-27/004.
    serial: {
      type: String,
      required: [true, 'A meeting needs a serial'],
      trim: true,
    },
    scheduledFor: {
      type: String,
      required: [true, 'A meeting needs a date'],
      match: [DATE_PATTERN, 'Date must be in YYYY-MM-DD format'],
      index: true,
    },
    startTime: {
      type: String,
      match: [TIME_PATTERN, 'Start time must be in HH:MM format'],
      default: null,
    },
    endTime: {
      type: String,
      match: [TIME_PATTERN, 'End time must be in HH:MM format'],
      default: null,
    },
    venue: {
      type: String,
      trim: true,
      maxlength: [140, 'Venue cannot exceed 140 characters'],
      default: null,
    },
    mode: {
      type: String,
      enum: {
        values: MEETING_MODES,
        message: 'Invalid meeting mode',
      },
      default: 'in-person',
    },
    status: {
      type: String,
      enum: {
        values: MEETING_STATUSES,
        message: 'Invalid meeting status',
      },
      default: 'scheduled',
      index: true,
    },
    attendance: {
      type: [attendanceSchema],
      default: [],
    },
    agenda: {
      type: [agendaItemSchema],
      default: [],
    },
    motions: {
      type: [motionSchema],
      default: [],
    },
    actions: {
      type: [actionSchema],
      default: [],
    },
    minutesText: {
      type: String,
      trim: true,
      maxlength: [40000, 'Minutes cannot exceed 40000 characters'],
      default: null,
    },
    // Derived at approval from the minutes, the motions and their outcomes.
    // Never accepted from a client.
    minutesFingerprint: {
      type: String,
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // Minutes are approved *at a later meeting*. That is how minutes are
    // actually approved, and storing which one makes the trail complete.
    approvalMeeting: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CommitteeMeeting',
      default: null,
    },
    cancelReason: {
      type: String,
      trim: true,
      maxlength: [500, 'Reason cannot exceed 500 characters'],
      default: null,
    },
    history: {
      type: [historySchema],
      default: [],
    },
  },
  { timestamps: true }
);

committeeMeetingSchema.index({ committee: 1, scheduledFor: -1 });
committeeMeetingSchema.index({ committee: 1, serial: 1 }, { unique: true });
committeeMeetingSchema.index({ 'actions.owner': 1, 'actions.status': 1 });

committeeMeetingSchema.pre('validate', function guard() {
  if (this.agenda.length > MAX_AGENDA_ITEMS) {
    this.invalidate('agenda', `A meeting cannot list more than ${MAX_AGENDA_ITEMS} items`);
  }
  if (this.motions.length > MAX_MOTIONS) {
    this.invalidate('motions', `A meeting cannot record more than ${MAX_MOTIONS} motions`);
  }
  if (this.actions.length > MAX_ACTIONS) {
    this.invalidate('actions', `A meeting cannot record more than ${MAX_ACTIONS} actions`);
  }

  for (const entry of this.attendance) {
    const arrived = toMinutes(entry.arrivedAt);
    const left = toMinutes(entry.leftAt);
    if (arrived !== null && left !== null && left <= arrived) {
      this.invalidate('attendance', `${entry.name || 'A member'} left before they arrived`);
    }
    if (!IN_THE_ROOM_STATES.includes(entry.state)) {
      entry.arrivedAt = null;
      entry.leftAt = null;
    }
  }

  for (const action of this.actions) {
    if (action.status !== 'done') action.closedOn = null;
  }

  if (this.status !== 'approved') {
    this.approvedAt = null;
    this.approvedBy = null;
    this.approvalMeeting = null;
  }
});

// ---------------------------------------------------------------------------
// Quorum and motions
// ---------------------------------------------------------------------------

/**
 * Who is entitled to vote at this moment, given a set of recusals.
 *
 * Members who had left before `atTime` are excluded, as are non-voting
 * attendees and everybody recused on this particular motion. A recusal
 * legitimately shrinks the denominator, and it can push a motion below quorum —
 * which is the honest answer when the only people entitled to vote on the
 * canteen contract are the two without an interest in it.
 */
committeeMeetingSchema.methods.eligibleAt = function eligibleAt(
  recusedIds = [],
  atTime = null
) {
  const recused = new Set(recusedIds.map(String));
  const cutoff = toMinutes(atTime);

  return this.attendance.filter((entry) => {
    if (!IN_THE_ROOM_STATES.includes(entry.state)) return false;
    if (!entry.isVoting) return false;
    if (recused.has(String(entry.member))) return false;

    if (cutoff !== null) {
      const arrived = toMinutes(entry.arrivedAt);
      const left = toMinutes(entry.leftAt);
      if (arrived !== null && arrived > cutoff) return false;
      if (left !== null && left <= cutoff) return false;
    }
    return true;
  });
};

/** Everybody in the room at a moment, voting or not — for the quorum bar. */
committeeMeetingSchema.methods.presentAt = function presentAt(atTime = null) {
  const cutoff = toMinutes(atTime);
  return this.attendance.filter((entry) => {
    if (!IN_THE_ROOM_STATES.includes(entry.state)) return false;
    if (cutoff !== null) {
      const arrived = toMinutes(entry.arrivedAt);
      const left = toMinutes(entry.leftAt);
      if (arrived !== null && arrived > cutoff) return false;
      if (left !== null && left <= cutoff) return false;
    }
    return true;
  });
};

/**
 * Whether a vote reconciles against the people entitled to cast it.
 *
 * This is the "carried 7-2 in a meeting of eight" line, made impossible at
 * entry rather than discovered in an audit. The refusal names both numbers,
 * because the person typing it has to work out which one is wrong.
 */
committeeMeetingSchema.methods.voteReconciliationError =
  function voteReconciliationError({ votesFor, votesAgainst, abstentions }, eligible) {
    const cast = (votesFor || 0) + (votesAgainst || 0) + (abstentions || 0);
    if (cast > eligible) {
      return `${cast} votes recorded but only ${eligible} member(s) were entitled to vote`;
    }
    return null;
  };

/**
 * The outcome of a vote, derived. Never accepted from a client.
 *
 * A motion voted without quorum keeps its numbers and is marked void, because
 * deleting it hides the fact that it was attempted — and that fact is exactly
 * what somebody will want to establish later.
 */
committeeMeetingSchema.methods.deriveOutcome = function deriveOutcome(
  { votesFor, votesAgainst },
  { present, required }
) {
  if (present < required) return 'void-no-quorum';
  if ((votesFor || 0) > (votesAgainst || 0)) return 'carried';
  if ((votesFor || 0) < (votesAgainst || 0)) return 'lost';
  return 'tied';
};

/**
 * The live quorum position, for the bar at the top of a meeting in session.
 *
 * It goes red the moment a member leaves and takes the count below the line,
 * because that is the moment the next motion becomes void.
 */
committeeMeetingSchema.methods.quorumStatus = function quorumStatus(
  committee,
  atTime = null
) {
  const rule = committee.quorumOn(this.scheduledFor);
  const present = this.presentAt(atTime);
  const votingPresent = present.filter((entry) => entry.isVoting);

  return {
    required: rule.required,
    votingMembers: rule.votingMembers,
    present: present.length,
    votingPresent: votingPresent.length,
    hasQuorum: votingPresent.length >= rule.required,
    shortBy: Math.max(rule.required - votingPresent.length, 0),
  };
};

// ---------------------------------------------------------------------------
// Minutes integrity
// ---------------------------------------------------------------------------

/**
 * A digest over the minutes and every recorded decision.
 *
 * Approving stores this. Any later edit to the text, a motion's wording or a
 * motion's outcome changes it, and `integrityState()` says so on the next read.
 * A `.docx` on somebody's laptop cannot do this, which is the whole reason
 * "approved minutes" currently means nothing checkable.
 */
committeeMeetingSchema.methods.computeFingerprint = function computeFingerprint() {
  const payload = {
    minutes: String(this.minutesText || '')
      .replace(/\s+/g, ' ')
      .trim(),
    motions: this.motions.map((motion) => ({
      t: String(motion.text || '')
        .replace(/\s+/g, ' ')
        .trim(),
      f: motion.votesFor,
      a: motion.votesAgainst,
      b: motion.abstentions,
      o: motion.outcome,
      q: motion.quorumAtVote,
      p: motion.membersPresentAtVote,
    })),
    actions: this.actions.map((action) => ({
      d: String(action.description || '')
        .replace(/\s+/g, ' ')
        .trim(),
      o: String(action.owner),
      u: action.dueBy,
    })),
  };

  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
};

committeeMeetingSchema.methods.integrityState = function integrityState() {
  if (this.status !== 'approved' || !this.minutesFingerprint) {
    return { state: 'not-approved', matches: false };
  }
  const current = this.computeFingerprint();
  return {
    state: current === this.minutesFingerprint ? 'intact' : 'edited-since-approval',
    matches: current === this.minutesFingerprint,
    approvedAt: this.approvedAt,
  };
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

committeeMeetingSchema.methods.openActions = function openActions() {
  return this.actions.filter((action) => LIVE_ACTION_STATUSES.includes(action.status));
};

/**
 * The open actions, shaped for the next meeting of the same committee.
 *
 * They carry across as the same action with the carry count incremented, rather
 * than being retyped as a new one — an action that has been carried three times
 * is the report, and retyping it hides exactly that.
 */
committeeMeetingSchema.methods.actionsToCarryForward =
  function actionsToCarryForward() {
    return this.openActions().map((action) => ({
      ref: action.ref,
      originalRef: action.originalRef || action.ref,
      description: action.description,
      owner: action.owner,
      ownerName: action.ownerName,
      dueBy: action.dueBy,
      status: 'carried-forward',
      carriedFromMeeting: this._id,
      carryCount: (action.carryCount || 0) + 1,
    }));
  };

committeeMeetingSchema.methods.recordHistory = function recordHistory(
  action,
  userId,
  note
) {
  this.history.push({ action, by: userId, at: new Date(), note });
  if (this.history.length > 100) this.history = this.history.slice(-100);
};

committeeMeetingSchema.methods.toRow = function toRow(committee = null) {
  const base = this.toObject({ depopulate: false });
  base.integrity = this.integrityState();
  base.openActionCount = this.openActions().length;
  if (committee) base.quorum = this.quorumStatus(committee);
  return base;
};

committeeSchema.statics.slugify = slugify;
committeeSchema.statics.todayKey = todayKey;
committeeSchema.statics.COMMITTEE_TYPES = COMMITTEE_TYPES;
committeeSchema.statics.CONFIDENTIAL_TYPES = CONFIDENTIAL_TYPES;
committeeSchema.statics.MEMBER_ROLES = MEMBER_ROLES;
committeeSchema.statics.VOTING_ROLES = VOTING_ROLES;
committeeSchema.statics.QUORUM_KINDS = QUORUM_KINDS;

committeeMeetingSchema.statics.todayKey = todayKey;
committeeMeetingSchema.statics.toMinutes = toMinutes;
committeeMeetingSchema.statics.MEETING_MODES = MEETING_MODES;
committeeMeetingSchema.statics.MEETING_STATUSES = MEETING_STATUSES;
committeeMeetingSchema.statics.ATTENDANCE_STATES = ATTENDANCE_STATES;
committeeMeetingSchema.statics.IN_THE_ROOM_STATES = IN_THE_ROOM_STATES;
committeeMeetingSchema.statics.AGENDA_KINDS = AGENDA_KINDS;
committeeMeetingSchema.statics.MOTION_OUTCOMES = MOTION_OUTCOMES;
committeeMeetingSchema.statics.ACTION_STATUSES = ACTION_STATUSES;
committeeMeetingSchema.statics.LIVE_ACTION_STATUSES = LIVE_ACTION_STATUSES;

const Committee = mongoose.model('Committee', committeeSchema);
const CommitteeMeeting = mongoose.model('CommitteeMeeting', committeeMeetingSchema);

module.exports = {
  Committee,
  CommitteeMeeting,
  COMMITTEE_TYPES,
  CONFIDENTIAL_TYPES,
  MEMBER_ROLES,
  VOTING_ROLES,
  QUORUM_KINDS,
  MEETING_MODES,
  MEETING_STATUSES,
  ATTENDANCE_STATES,
  AGENDA_KINDS,
  MOTION_OUTCOMES,
  ACTION_STATUSES,
  LIVE_ACTION_STATUSES,
  todayKey,
  slugify,
  toMinutes,
};
