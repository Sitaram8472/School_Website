const mongoose = require('mongoose');

/**
 * Emergency broadcasts and acknowledgements.
 *
 * `Notice` publishes to a board, which is the right model for "sports day is on
 * Saturday" and the wrong one for "there is a fire in C block", because a board
 * cannot tell anybody **who has not read it**.
 *
 * Two schemas: the broadcast, and one recipient's receipt of it. Three rules
 * shape them.
 *
 *   Dispatch is idempotent. `dispatchKey` is unique at the database, so the
 *     coordinator tapping send again on a bad connection finds the broadcast
 *     that already exists instead of starting a second wave.
 *
 *   Receipts are unique per (broadcast, recipient), so a dispatch that failed
 *     halfway can be resumed and completes the set exactly.
 *
 *   A dispatched message is immutable. The body is fingerprinted at dispatch
 *     and a pre-save guard refuses every later edit; a correction is a new
 *     broadcast with `supersedes` set, so both versions exist in order and the
 *     record shows what people were actually told first.
 */

const SEVERITIES = ['information', 'advisory', 'urgent', 'emergency'];

const CHANNELS = ['in-app', 'email', 'sms', 'phone-tree'];

const BROADCAST_STATUSES = ['draft', 'dispatched', 'closed', 'cancelled'];

const RECEIPT_STATES = [
  'pending',
  'acknowledged',
  'acknowledged-late',
  'escalated',
  'escalated-acknowledged',
];

// States that still want somebody to do something about them.
const OUTSTANDING_STATES = ['pending', 'escalated'];

const AUDIENCE_ROLES = ['student', 'teacher', 'staff', 'admin'];

const MINUTE_MS = 60000;

const DEFAULT_ACKNOWLEDGE_WITHIN_MINUTES = 30;
const DEFAULT_ESCALATE_AFTER_MINUTES = 45;
const MAX_WINDOW_MINUTES = 10080; // a week

const historySchema = new mongoose.Schema(
  {
    action: { type: String, required: true, trim: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
    note: { type: String, trim: true, maxlength: 400 },
  },
  { _id: false }
);

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

const broadcastSchema = new mongoose.Schema(
  {
    ref: { type: String, default: null },

    title: {
      type: String,
      required: [true, 'A broadcast needs a title'],
      trim: true,
      maxlength: [120, 'Keep the title short enough to read on a lock screen'],
    },

    body: {
      type: String,
      required: [true, 'A broadcast needs a body'],
      trim: true,
      minlength: [10, 'Say what has happened and what to do'],
      maxlength: 4000,
    },

    severity: { type: String, enum: SEVERITIES, default: 'information', index: true },

    audience: {
      roles: {
        type: [String],
        default: [],
        validate: {
          validator: (list) => list.every((role) => AUDIENCE_ROLES.includes(role)),
          message: 'Unknown audience role',
        },
      },
      users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      activeOnly: { type: Boolean, default: true },
    },

    // What was intended. Actually putting an SMS on a wire is somebody else's
    // module; recording that it was meant to go by SMS is this one's business.
    channels: {
      type: [String],
      default: ['in-app'],
      validate: {
        validator: (list) => list.length > 0 && list.every((channel) => CHANNELS.includes(channel)),
        message: 'Choose at least one channel',
      },
    },

    requiresAcknowledgement: { type: Boolean, default: true },

    acknowledgeWithinMinutes: {
      type: Number,
      default: DEFAULT_ACKNOWLEDGE_WITHIN_MINUTES,
      min: [1, 'Give people at least a minute'],
      max: [MAX_WINDOW_MINUTES, 'A week is not an acknowledgement window'],
    },

    escalateAfterMinutes: {
      type: Number,
      default: DEFAULT_ESCALATE_AFTER_MINUTES,
      min: [1, 'Give people at least a minute'],
      max: [MAX_WINDOW_MINUTES, 'A week is not an escalation window'],
    },

    escalationNote: { type: String, trim: true, maxlength: 400 },

    // The idempotency key. Unique, and supplied by whoever presses send.
    dispatchKey: { type: String, required: true, unique: true, trim: true, maxlength: 80 },

    status: { type: String, enum: BROADCAST_STATUSES, default: 'draft', index: true },

    dispatchedAt: Date,
    dispatchedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    bodyFingerprint: { type: String, default: null },

    // A correction is a new broadcast, not an edit to this one.
    supersedes: { type: mongoose.Schema.Types.ObjectId, ref: 'Broadcast', default: null },

    closedAt: Date,
    closureNote: { type: String, trim: true, maxlength: 500 },
    outstandingAtClose: { type: Number, default: null },

    cancelledAt: Date,

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

broadcastSchema.index({ status: 1, dispatchedAt: -1 });

broadcastSchema.methods.isDispatched = function isDispatched() {
  return ['dispatched', 'closed'].includes(this.status);
};

broadcastSchema.methods.isEditable = function isEditable() {
  return this.status === 'draft';
};

/**
 * A digest of what was sent. Cheap, and enough to notice that a stored
 * broadcast is not the one people acted on.
 */
broadcastSchema.methods.computeFingerprint = function computeFingerprint() {
  const material = [
    this.title,
    this.body,
    this.severity,
    (this.audience.roles || []).join(','),
    (this.audience.users || []).map(String).sort().join(','),
  ].join('|');

  let hash = 5381;
  for (let i = 0; i < material.length; i += 1) {
    hash = ((hash << 5) + hash + material.charCodeAt(i)) | 0;
  }
  return `b${(hash >>> 0).toString(16)}:${material.length}`;
};

broadcastSchema.methods.isIntact = function isIntact() {
  if (!this.bodyFingerprint) return true;
  return this.bodyFingerprint === this.computeFingerprint();
};

broadcastSchema.methods.recordHistory = function recordHistory(action, by, note) {
  this.history.push({ action, by, note, at: new Date() });
  if (this.history.length > 120) this.history = this.history.slice(-120);
  return this;
};

/**
 * Nothing that was sent may be edited afterwards.
 *
 * A correction is a new broadcast referencing this one. Editing the text people
 * acted on is how a school ends up unable to say what it told anybody.
 */
broadcastSchema.pre('save', function refuseEditsAfterDispatch() {
  if (this.isNew || !this.dispatchedAt) return;

  const frozen = ['title', 'body', 'severity', 'audience', 'channels', 'dispatchKey'];
  const touched = frozen.filter((path) => this.isModified(path));
  if (touched.length) {
    throw new Error(
      `A dispatched broadcast cannot be edited (${touched.join(', ')}); issue a correction instead`
    );
  }
});

broadcastSchema.set('toJSON', { virtuals: true });
broadcastSchema.set('toObject', { virtuals: true });

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

const broadcastReceiptSchema = new mongoose.Schema(
  {
    broadcast: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Broadcast',
      required: true,
      index: true,
    },

    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    state: { type: String, enum: RECEIPT_STATES, default: 'pending', index: true },

    deliveredAt: { type: Date, default: Date.now },
    dueAt: Date,
    acknowledgedAt: Date,
    escalatedAt: Date,
    note: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

// One receipt per person per broadcast. A resumed or retried dispatch completes
// the set instead of duplicating it.
broadcastReceiptSchema.index({ broadcast: 1, recipient: 1 }, { unique: true });
broadcastReceiptSchema.index({ state: 1, deliveredAt: 1 });

broadcastReceiptSchema.methods.isOutstanding = function isOutstanding() {
  return OUTSTANDING_STATES.includes(this.state);
};

broadcastReceiptSchema.methods.isAcknowledged = function isAcknowledged() {
  return ['acknowledged', 'acknowledged-late', 'escalated-acknowledged'].includes(this.state);
};

/**
 * Which acknowledged state this receipt should move to.
 *
 * Late is recorded as late and an acknowledgement after an escalation says so.
 * Both are acknowledged; neither pretends the escalation did not happen, which
 * is the difference between a record and a reassurance.
 */
broadcastReceiptSchema.methods.acknowledgedStateAt = function acknowledgedStateAt(
  now = new Date()
) {
  if (this.state === 'escalated') return 'escalated-acknowledged';
  if (this.dueAt && now.getTime() > this.dueAt.getTime()) return 'acknowledged-late';
  return 'acknowledged';
};

broadcastReceiptSchema.methods.isEscalationDue = function isEscalationDue(
  escalateAfterMinutes,
  now = new Date()
) {
  if (this.state !== 'pending') return false;
  if (!this.deliveredAt) return false;
  return now.getTime() - this.deliveredAt.getTime() >= escalateAfterMinutes * MINUTE_MS;
};

broadcastReceiptSchema.set('toJSON', { virtuals: true });
broadcastReceiptSchema.set('toObject', { virtuals: true });

const Broadcast = mongoose.model('Broadcast', broadcastSchema);
const BroadcastReceipt = mongoose.model('BroadcastReceipt', broadcastReceiptSchema);

module.exports = {
  Broadcast,
  BroadcastReceipt,
  SEVERITIES,
  CHANNELS,
  BROADCAST_STATUSES,
  RECEIPT_STATES,
  OUTSTANDING_STATES,
  AUDIENCE_ROLES,
  DEFAULT_ACKNOWLEDGE_WITHIN_MINUTES,
  DEFAULT_ESCALATE_AFTER_MINUTES,
  MINUTE_MS,
};
