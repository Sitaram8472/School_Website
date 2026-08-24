const mongoose = require('mongoose');

/**
 * What was agreed in a parent-teacher meeting.
 *
 * `MeetingSlot` books the meeting properly and then records the meeting itself
 * as one free-text field on the booking — `outcomeNote`, written by the teacher,
 * kept away from the family by `redactFor`, and rewritable at any time with no
 * trace. A record of a conversation that one participant can silently rewrite
 * and the other cannot see is worse than no record.
 *
 * The property this file holds is that **a published outcome is immutable**.
 * Corrections are addenda: dated, attributed, appended. Everything else —
 * actions with owners, the family's copy, the acknowledgement — follows from
 * taking that seriously.
 */

const OUTCOME_STATUSES = ['draft', 'published', 'closed'];

const ACTION_OWNER_ROLES = ['school', 'family', 'student'];

const ACTION_STATUSES = ['open', 'completed', 'cancelled', 'carried-forward'];

// An action in one of these is finished with, so it does not hold the outcome
// open and does not appear on anybody's chase list.
const SETTLED_ACTION_STATUSES = ['completed', 'cancelled', 'carried-forward'];

const MEETING_PURPOSES = [
  'ptm',
  'academic-concern',
  'counselling',
  'admission',
  'general',
];

const MAX_ACTIONS = 20;
const MAX_BULLETS = 10;
const MAX_ADDENDA = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDay = (value) => {
  const date = value ? new Date(value) : new Date();
  date.setHours(0, 0, 0, 0);
  return date;
};

const actionSchema = new mongoose.Schema(
  {
    // Stable and 1-based. Cancelling action 2 does not renumber 3, because the
    // family has been given a numbered list.
    index: { type: Number, required: true, min: 1 },

    description: {
      type: String,
      required: [true, 'An action needs to say what will be done'],
      trim: true,
      minlength: [8, 'Please describe the action in a little more detail'],
      maxlength: [500, 'An action cannot exceed 500 characters'],
    },

    /**
     * Who undertook to do it.
     *
     * Kept separate from the free text because the useful report — "what did
     * the school promise and not do?" — is impossible if the school's
     * undertakings and the parents' are in one undifferentiated list.
     */
    ownerRole: {
      type: String,
      enum: { values: ACTION_OWNER_ROLES, message: 'Invalid action owner' },
      required: [true, 'Say who is doing this'],
    },
    ownerName: {
      type: String,
      required: [true, 'An action needs a named owner'],
      trim: true,
      maxlength: [80, 'Owner name cannot exceed 80 characters'],
    },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    dueOn: {
      type: Date,
      required: [true, 'An action needs a date, or it is not an action'],
    },

    status: {
      type: String,
      enum: { values: ACTION_STATUSES, message: 'Invalid action status' },
      default: 'open',
    },
    completedAt: { type: Date, default: null },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    completedByName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },
    evidenceNote: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    // Only meaningful on `carried-forward` and `cancelled`, and required there.
    settlementReason: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    addedAfterPublication: { type: Boolean, default: false },
  },
  { _id: false }
);

const addendumSchema = new mongoose.Schema(
  {
    text: {
      type: String,
      required: [true, 'An addendum needs some text'],
      trim: true,
      minlength: [4, 'Please write a little more'],
      maxlength: [2000, 'An addendum cannot exceed 2000 characters'],
    },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    addedByName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },
    addedByRole: { type: String, trim: true, maxlength: [20, 'Too long'], default: '' },
    addedAt: { type: Date, default: Date.now },
    // Forced true on a family-authored addendum: a parent cannot write a
    // private note about themselves, and staff cannot hide one written in reply.
    visibleToFamily: { type: Boolean, default: true },
  },
  { _id: false }
);

const historyEntrySchema = new mongoose.Schema(
  {
    action: { type: String, required: true, trim: true, maxlength: [40, 'Too long'] },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },
    at: { type: Date, default: Date.now },
    note: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },
  },
  { _id: false }
);

const meetingOutcomeSchema = new mongoose.Schema(
  {
    slot: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MeetingSlot',
      required: [true, 'An outcome must belong to a slot'],
    },
    // The booking's own reference, which is what identifies one family's
    // meeting inside a slot that may hold several.
    bookingReference: {
      type: String,
      required: [true, 'An outcome must name the booking it is for'],
      trim: true,
      maxlength: [80, 'Too long'],
    },

    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    teacherName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },

    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    guardianName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },
    studentName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },
    className: { type: String, trim: true, maxlength: [30, 'Too long'], default: '' },

    meetingDate: { type: String, trim: true, default: '' },
    purpose: {
      type: String,
      enum: { values: MEETING_PURPOSES, message: 'Invalid purpose' },
      default: 'ptm',
    },

    /**
     * The shared account, written for the family to read.
     *
     * Deliberately not called "notes". A note is something you write for
     * yourself; this is a letter to somebody who was in the room.
     */
    discussionSummary: {
      type: String,
      required: [true, 'Write up what was discussed'],
      trim: true,
      minlength: [30, 'Please write a little more — this is what the family will read'],
      maxlength: [5000, 'Summary cannot exceed 5000 characters'],
    },

    strengths: {
      type: [{ _id: false, text: { type: String, trim: true, maxlength: 300 } }],
      default: [],
      validate: {
        validator: (rows) => rows.length <= MAX_BULLETS,
        message: `No more than ${MAX_BULLETS} points`,
      },
    },
    concerns: {
      type: [{ _id: false, text: { type: String, trim: true, maxlength: 300 } }],
      default: [],
      validate: {
        validator: (rows) => rows.length <= MAX_BULLETS,
        message: `No more than ${MAX_BULLETS} points`,
      },
    },

    // Staff-only. Never in a family-facing payload, and the family serialiser
    // is built by naming fields rather than by deleting this one.
    privateNote: { type: String, trim: true, maxlength: [3000, 'Too long'], default: '' },

    actions: {
      type: [actionSchema],
      default: [],
      validate: {
        validator: (rows) => rows.length <= MAX_ACTIONS,
        message: `No more than ${MAX_ACTIONS} actions`,
      },
    },

    status: {
      type: String,
      enum: { values: OUTCOME_STATUSES, message: 'Invalid status' },
      default: 'draft',
    },

    publishedAt: { type: Date, default: null },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    closedAt: { type: Date, default: null },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    closureNote: { type: String, trim: true, maxlength: [1000, 'Too long'], default: '' },

    addenda: {
      type: [addendumSchema],
      default: [],
      validate: {
        validator: (rows) => rows.length <= MAX_ADDENDA,
        message: `No more than ${MAX_ADDENDA} addenda`,
      },
    },

    acknowledgedAt: { type: Date, default: null },
    acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // The previous outcome for the same student, so a teacher opening a new
    // write-up can see what was agreed last time without a search.
    previousOutcome: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MeetingOutcome',
      default: null,
    },

    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true }
);

// One outcome per booking. At the database, because the duplicate this stops is
// a teacher double-submitting the write-up form.
meetingOutcomeSchema.index({ slot: 1, bookingReference: 1 }, { unique: true });

meetingOutcomeSchema.index({ teacher: 1, createdAt: -1 });
meetingOutcomeSchema.index({ requestedBy: 1, status: 1 });
meetingOutcomeSchema.index({ status: 1, 'actions.dueOn': 1 });
meetingOutcomeSchema.index({ studentName: 1, meetingDate: -1 });

meetingOutcomeSchema.pre('validate', function checkContent() {
  if (this.strengths.length === 0) {
    this.invalidate('strengths', 'Name at least one strength. There is always one.');
  }

  const indices = this.actions.map((action) => action.index);
  if (new Set(indices).size !== indices.length) {
    this.invalidate('actions', 'Action numbers must be unique');
  }

  const unexplained = this.actions.find(
    (action) =>
      (action.status === 'carried-forward' || action.status === 'cancelled') &&
      !action.settlementReason
  );

  if (unexplained) {
    this.invalidate(
      'actions',
      `Action ${unexplained.index} is ${unexplained.status} without a reason`
    );
  }
});

/**
 * Immutability after publication.
 *
 * This is the property the existing `outcomeNote` fails and the reason this
 * model exists. The write-up, the bullets and the terms of every action that
 * was in the published version are frozen; new actions and completions are
 * allowed, because those are things that happen afterwards.
 */
meetingOutcomeSchema.pre('save', function guardOutcome() {
  if (this.isNew || this.status === 'draft') return;

  const frozen = ['discussionSummary', 'strengths', 'concerns', 'purpose', 'slot',
    'bookingReference', 'requestedBy', 'teacher'];

  const edited = frozen.find((field) => this.isModified(field));

  if (edited) {
    throw new Error(
      `"${edited}" cannot be changed once the outcome is published. Add an addendum instead.`
    );
  }

  // An action that existed at publication keeps the terms the family was given.
  // Completing it, cancelling it or carrying it forward is fine; rewriting what
  // was promised is not.
  if (this.isModified('actions')) {
    const original = this.$locals.publishedActions;

    if (Array.isArray(original)) {
      const changed = this.actions.find((action) => {
        const before = original.find((row) => row.index === action.index);
        if (!before || action.addedAfterPublication) return false;

        return (
          before.description !== action.description ||
          Number(before.dueOn) !== Number(action.dueOn) ||
          before.ownerRole !== action.ownerRole
        );
      });

      if (changed) {
        throw new Error(
          `Action ${changed.index} was published as it stands and cannot be reworded or re-dated`
        );
      }
    }
  }
});

/**
 * Snapshot the published actions so the guard above has something to compare
 * against, kept in `$locals` — the documented per-document scratch space. Mongoose
 * gives no "value at load" for subdocument arrays, and re-reading the database on
 * every save would be a read per write.
 */
meetingOutcomeSchema.post('init', function rememberActions() {
  if (this.status === 'draft') return;

  this.$locals.publishedActions = this.actions.map((action) => ({
    index: action.index,
    description: action.description,
    dueOn: action.dueOn,
    ownerRole: action.ownerRole,
  }));
});

meetingOutcomeSchema.methods.log = function log(action, actor, note = '') {
  this.history.push({
    action,
    by: actor ? actor._id : undefined,
    byName: (actor && actor.name) || '',
    at: new Date(),
    note,
  });

  return this;
};

meetingOutcomeSchema.methods.nextActionIndex = function nextActionIndex() {
  return this.actions.reduce((highest, action) => Math.max(highest, action.index), 0) + 1;
};

/**
 * Overdue is worked out from the dates on every read. Not a stored flag, and
 * not a scheduled job — both of those are ways for the list to be wrong.
 */
meetingOutcomeSchema.methods.actionRows = function actionRows(today = new Date()) {
  const cutoff = startOfDay(today);

  return this.actions
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((action) => {
      const due = startOfDay(action.dueOn);
      const settled = SETTLED_ACTION_STATUSES.includes(action.status);

      return {
        index: action.index,
        description: action.description,
        ownerRole: action.ownerRole,
        ownerName: action.ownerName,
        owner: action.owner,
        dueOn: action.dueOn,
        status: action.status,
        completedAt: action.completedAt,
        completedByName: action.completedByName,
        evidenceNote: action.evidenceNote,
        settlementReason: action.settlementReason,
        addedAfterPublication: action.addedAfterPublication,
        overdue: !settled && due < cutoff,
        daysLate: settled ? 0 : Math.max(0, Math.round((cutoff - due) / DAY_MS)),
      };
    });
};

meetingOutcomeSchema.methods.actionTally = function actionTally(today = new Date()) {
  const rows = this.actionRows(today);

  const count = (predicate) => rows.filter(predicate).length;

  return {
    total: rows.length,
    open: count((row) => row.status === 'open'),
    completed: count((row) => row.status === 'completed'),
    overdue: count((row) => row.overdue),
    // The two figures kept apart on purpose: mixing what the school promised
    // with what the parents undertook makes the report useless.
    schoolOpen: count((row) => row.status === 'open' && row.ownerRole === 'school'),
    schoolOverdue: count((row) => row.overdue && row.ownerRole === 'school'),
    familyOpen: count((row) => row.status === 'open' && row.ownerRole !== 'school'),
  };
};

meetingOutcomeSchema.methods.publish = function publish(actor) {
  if (this.status !== 'draft') {
    throw new Error(`Only a draft can be published; this one is ${this.status}`);
  }

  this.status = 'published';
  this.publishedAt = new Date();
  this.publishedBy = actor._id;

  // From here on the guard compares against this.
  this.$locals.publishedActions = this.actions.map((action) => ({
    index: action.index,
    description: action.description,
    dueOn: action.dueOn,
    ownerRole: action.ownerRole,
  }));

  return this.log('published', actor, `${this.actions.length} agreed action(s)`);
};

meetingOutcomeSchema.methods.addAction = function addAction(actor, payload) {
  const action = {
    index: this.nextActionIndex(),
    description: payload.description,
    ownerRole: payload.ownerRole,
    ownerName: payload.ownerName,
    owner: payload.owner || null,
    dueOn: payload.dueOn,
    status: 'open',
    addedAfterPublication: this.status !== 'draft',
  };

  this.actions.push(action);
  this.log('action-added', actor, `${action.index}: ${action.description}`);

  return action;
};

meetingOutcomeSchema.methods.settleAction = function settleAction(index, actor, payload) {
  const action = this.actions.find((row) => row.index === Number(index));
  if (!action) throw new Error(`There is no action ${index} on this outcome`);

  if (SETTLED_ACTION_STATUSES.includes(action.status)) {
    throw new Error(`Action ${index} is already ${action.status}`);
  }

  const status = payload.status || 'completed';
  if (!ACTION_STATUSES.includes(status) || status === 'open') {
    throw new Error('An action can be completed, cancelled or carried forward');
  }

  if (status !== 'completed' && !payload.reason) {
    throw new Error(`Say why action ${index} is being ${status}`);
  }

  action.status = status;
  action.completedAt = new Date();
  action.completedBy = actor._id;
  action.completedByName = actor.name || '';
  action.evidenceNote = payload.evidenceNote || '';
  action.settlementReason = payload.reason || '';

  this.log(`action-${status}`, actor, `action ${index}`);

  return action;
};

meetingOutcomeSchema.methods.addAddendum = function addAddendum(actor, text, isFamily) {
  if (this.status === 'draft') {
    throw new Error('A draft is still editable; addenda are for published outcomes');
  }

  this.addenda.push({
    text,
    addedBy: actor._id,
    addedByName: actor.name || '',
    addedByRole: isFamily ? 'family' : actor.role || 'staff',
    addedAt: new Date(),
    // A parent cannot write a private note about themselves, and staff cannot
    // hide one written in reply to them.
    visibleToFamily: isFamily ? true : Boolean(text) && true,
  });

  return this.log('addendum', actor);
};

/**
 * Closing requires the actions to be settled.
 *
 * An outcome cannot be closed with an open overdue action just because the term
 * ended, which is exactly when it would otherwise happen.
 */
meetingOutcomeSchema.methods.close = function close(actor, note = '') {
  if (this.status !== 'published') {
    throw new Error(`Only a published outcome can be closed; this one is ${this.status}`);
  }

  const open = this.actions.filter((action) => action.status === 'open');

  if (open.length > 0) {
    throw new Error(
      `${open.length} action(s) are still open: ${open
        .map((action) => `#${action.index}`)
        .join(', ')}. Complete, cancel or carry each one forward first.`
    );
  }

  this.status = 'closed';
  this.closedAt = new Date();
  this.closedBy = actor._id;
  this.closureNote = note || '';

  return this.log('closed', actor, note);
};

meetingOutcomeSchema.methods.acknowledge = function acknowledge(actor) {
  if (this.status === 'draft') {
    throw new Error('This write-up has not been shared yet');
  }
  if (this.acknowledgedAt) return this;

  this.acknowledgedAt = new Date();
  this.acknowledgedBy = actor._id;

  return this.log('acknowledged', actor);
};

meetingOutcomeSchema.statics.OUTCOME_STATUSES = OUTCOME_STATUSES;
meetingOutcomeSchema.statics.ACTION_OWNER_ROLES = ACTION_OWNER_ROLES;
meetingOutcomeSchema.statics.ACTION_STATUSES = ACTION_STATUSES;
meetingOutcomeSchema.statics.SETTLED_ACTION_STATUSES = SETTLED_ACTION_STATUSES;
meetingOutcomeSchema.statics.MEETING_PURPOSES = MEETING_PURPOSES;
meetingOutcomeSchema.statics.MAX_ACTIONS = MAX_ACTIONS;
meetingOutcomeSchema.statics.startOfDay = startOfDay;

module.exports = mongoose.model('MeetingOutcome', meetingOutcomeSchema);
