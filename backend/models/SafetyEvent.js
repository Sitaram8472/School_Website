const mongoose = require('mongoose');

/**
 * Emergency drills and real safety incidents.
 *
 * One model covers both on purpose. The evacuation, the roll call and the
 * reconciliation are identical whether the alarm was planned or not, and having
 * two implementations means the one used in a real emergency is the one that
 * was never rehearsed. Drills exist to practise the response; the software
 * should be practised too.
 *
 * The rule everything else is arranged around: an event cannot be closed while
 * anybody is unaccounted for. There is no override flag, because an override
 * would be used every time, by the person under the most pressure to make the
 * number look right.
 */

const EVENT_TYPES = [
  'fire-drill',
  'earthquake-drill',
  'lockdown-drill',
  'evacuation-drill',
  'real-incident',
];

const INCIDENT_CATEGORIES = [
  'fire',
  'gas-leak',
  'chemical-spill',
  'structural',
  'medical-emergency',
  'intrusion',
  'weather',
  'other',
];

const EVENT_STATUSES = ['planned', 'in-progress', 'reconciled', 'closed', 'cancelled'];

const OBSERVATION_SEVERITIES = ['info', 'minor', 'major', 'critical'];

const ACTION_STATUSES = ['open', 'in-progress', 'completed', 'dropped'];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function todayKey(now = new Date()) {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * One person who did not answer their name at the assembly point.
 *
 * `resolutionNote` is the whole point of the record. "Was at the dentist,
 * confirmed with the office" and "found in the music room, escorted out" are
 * different facts, and a drill report that flattens both into a tick is the
 * document that turns out to be worthless in an inquiry.
 */
const unaccountedEntrySchema = new mongoose.Schema(
  {
    studentName: {
      type: String,
      required: [true, 'Name the person who is missing'],
      trim: true,
      maxlength: [80, 'Name cannot exceed 80 characters'],
    },
    note: {
      type: String,
      trim: true,
      maxlength: [300, 'Note cannot exceed 300 characters'],
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    resolutionNote: {
      type: String,
      trim: true,
      maxlength: [500, 'Resolution note cannot exceed 500 characters'],
      default: null,
    },
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    resolvedByName: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { _id: true }
);

const rollCallSchema = new mongoose.Schema(
  {
    className: {
      type: String,
      required: [true, 'Class is required'],
      trim: true,
      maxlength: [40, 'Class cannot exceed 40 characters'],
    },
    assemblyPoint: {
      type: String,
      trim: true,
      maxlength: [80, 'Assembly point cannot exceed 80 characters'],
      default: null,
    },
    // Captured when the event is planned, before the alarm. A count entered
    // afterwards is a count adjusted to match.
    expectedCount: {
      type: Number,
      required: [true, 'The expected headcount is required'],
      min: [0, 'Expected count cannot be negative'],
      max: [500, 'That headcount looks wrong'],
    },
    presentCount: {
      type: Number,
      required: [true, 'The present headcount is required'],
      min: [0, 'Present count cannot be negative'],
      max: [500, 'That headcount looks wrong'],
    },
    // Known absences from the register — the child who was off sick this
    // morning is not missing, and counting them as missing is how a real
    // missing child gets lost in the noise.
    absentPreAuthorised: {
      type: Number,
      default: 0,
      min: [0, 'Authorised absence count cannot be negative'],
      max: [500, 'That count looks wrong'],
    },
    // Derived server-side. A roll call claiming everybody is present while
    // naming two missing children is rejected rather than stored.
    unaccountedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    unaccounted: {
      type: [unaccountedEntrySchema],
      default: [],
    },
    reportedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    reporterName: {
      type: String,
      trim: true,
    },
    reportedAt: {
      type: Date,
      default: Date.now,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [500, 'Notes cannot exceed 500 characters'],
      default: null,
    },
  },
  { _id: true }
);

const observationSchema = new mongoose.Schema(
  {
    severity: {
      type: String,
      enum: OBSERVATION_SEVERITIES,
      default: 'minor',
    },
    area: {
      type: String,
      trim: true,
      maxlength: [80, 'Area cannot exceed 80 characters'],
      default: null,
    },
    note: {
      type: String,
      required: [true, 'An observation needs a description'],
      trim: true,
      minlength: [5, 'Describe the observation in at least 5 characters'],
      maxlength: [1000, 'Observation cannot exceed 1000 characters'],
    },
    raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    raisedByName: { type: String, trim: true },
    raisedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const actionSchema = new mongoose.Schema(
  {
    description: {
      type: String,
      required: [true, 'An action needs a description'],
      trim: true,
      minlength: [5, 'Describe the action in at least 5 characters'],
      maxlength: [500, 'Action cannot exceed 500 characters'],
    },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    ownerName: { type: String, trim: true, default: null },
    dueDate: {
      type: String,
      match: [DATE_PATTERN, 'Due date must be in YYYY-MM-DD format'],
      default: null,
    },
    status: {
      type: String,
      enum: ACTION_STATUSES,
      default: 'open',
    },
    completedAt: { type: Date, default: null },
    completionNote: {
      type: String,
      trim: true,
      maxlength: [500, 'Completion note cannot exceed 500 characters'],
      default: null,
    },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const safetyEventSchema = new mongoose.Schema(
  {
    eventType: {
      type: String,
      enum: EVENT_TYPES,
      required: [true, 'Event type is required'],
      index: true,
    },
    incidentCategory: {
      type: String,
      enum: [...INCIDENT_CATEGORIES, null],
      default: null,
    },
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      minlength: [3, 'Title must be at least 3 characters'],
      maxlength: [140, 'Title cannot exceed 140 characters'],
    },
    date: {
      type: String,
      required: [true, 'Date is required'],
      match: [DATE_PATTERN, 'Date must be in YYYY-MM-DD format'],
      index: true,
    },
    // Stamped by the server when the event is started. Never accepted from a
    // client — an evacuation time typed in afterwards is a claim, not a
    // measurement.
    alarmRaisedAt: { type: Date, default: null },
    allClearAt: { type: Date, default: null },
    assemblyPoints: {
      type: [String],
      default: [],
    },
    coordinator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    coordinatorName: { type: String, trim: true },
    status: {
      type: String,
      enum: EVENT_STATUSES,
      default: 'planned',
      index: true,
    },
    // Derived from the alarm and the last roll call to arrive.
    evacuationSeconds: { type: Number, default: null, min: 0 },
    // Derived from the alarm and the last unaccounted entry to be resolved.
    // This is the number the register line never contains.
    reconciliationSeconds: { type: Number, default: null, min: 0 },
    rollCalls: { type: [rollCallSchema], default: [] },
    observations: { type: [observationSchema], default: [] },
    actions: { type: [actionSchema], default: [] },
    outcome: {
      type: String,
      trim: true,
      maxlength: [2000, 'Outcome cannot exceed 2000 characters'],
      default: null,
    },
    closureNote: {
      type: String,
      trim: true,
      maxlength: [2000, 'Closure note cannot exceed 2000 characters'],
      default: null,
    },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    closedAt: { type: Date, default: null },
    cancelReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Cancellation reason cannot exceed 300 characters'],
      default: null,
    },
  },
  { timestamps: true }
);

safetyEventSchema.index({ date: -1, status: 1 });
safetyEventSchema.index({ 'rollCalls.className': 1 });

/**
 * Recomputes the derived counts and timings from the roll calls.
 *
 * An async function that throws rather than a callback-style hook: Mongoose 9
 * skips the old form silently, and here that would leave `unaccountedCount` as
 * whatever a client sent — the one number the closure rule reads.
 */
safetyEventSchema.pre('validate', async function derive() {
  for (const rollCall of this.rollCalls) {
    const derived =
      rollCall.expectedCount - rollCall.presentCount - rollCall.absentPreAuthorised;

    if (derived < 0) {
      this.invalidate(
        'rollCalls',
        `${rollCall.className}: more people are accounted for than were expected`
      );
      return;
    }

    rollCall.unaccountedCount = derived;

    // The named list and the arithmetic have to agree. A roll call saying
    // everyone is present while naming two missing children is not a roll call
    // that can be filed.
    const named = rollCall.unaccounted.length;
    if (named !== derived) {
      this.invalidate(
        'rollCalls',
        `${rollCall.className}: ${derived} unaccounted for by the headcount but ${named} named`
      );
      return;
    }
  }

  if (this.alarmRaisedAt && this.rollCalls.length > 0) {
    const last = this.rollCalls.reduce(
      (latest, rollCall) =>
        !latest || rollCall.reportedAt > latest ? rollCall.reportedAt : latest,
      null
    );
    if (last) {
      this.evacuationSeconds = Math.max(
        0,
        Math.round((last.getTime() - this.alarmRaisedAt.getTime()) / 1000)
      );
    }

    const resolutions = this.rollCalls
      .flatMap((rollCall) => rollCall.unaccounted)
      .map((entry) => entry.resolvedAt)
      .filter(Boolean);

    if (resolutions.length > 0) {
      const lastResolution = resolutions.reduce((a, b) => (a > b ? a : b));
      this.reconciliationSeconds = Math.max(
        0,
        Math.round((lastResolution.getTime() - this.alarmRaisedAt.getTime()) / 1000)
      );
    }
  }
});

safetyEventSchema.virtual('isDrill').get(function isDrill() {
  return this.eventType !== 'real-incident';
});

safetyEventSchema.virtual('classesReported').get(function classesReported() {
  return this.rollCalls.length;
});

safetyEventSchema.virtual('totalExpected').get(function totalExpected() {
  return this.rollCalls.reduce((sum, rollCall) => sum + rollCall.expectedCount, 0);
});

safetyEventSchema.virtual('totalPresent').get(function totalPresent() {
  return this.rollCalls.reduce((sum, rollCall) => sum + rollCall.presentCount, 0);
});

/**
 * Everybody still missing, across every class. This is the list the coordinator
 * is looking at, and the list `closureError` refuses to close over.
 */
safetyEventSchema.methods.outstandingUnaccounted = function outstandingUnaccounted() {
  const rows = [];
  for (const rollCall of this.rollCalls) {
    for (const entry of rollCall.unaccounted) {
      if (entry.resolvedAt) continue;
      rows.push({
        rollCallId: rollCall._id,
        entryId: entry._id,
        className: rollCall.className,
        assemblyPoint: rollCall.assemblyPoint,
        studentName: entry.studentName,
        note: entry.note,
      });
    }
  }
  return rows;
};

safetyEventSchema.virtual('outstandingCount').get(function outstandingCount() {
  return this.outstandingUnaccounted().length;
});

safetyEventSchema.virtual('openActionCount').get(function openActionCount() {
  return this.actions.filter((action) => action.status === 'open' || action.status === 'in-progress')
    .length;
});

safetyEventSchema.virtual('overdueActionCount').get(function overdueActionCount() {
  const today = todayKey();
  return this.actions.filter(
    (action) =>
      (action.status === 'open' || action.status === 'in-progress') &&
      action.dueDate &&
      action.dueDate < today
  ).length;
});

/**
 * Whether every class has reported and every named person has been resolved.
 * Reconciliation is a state the event reaches, not a step somebody performs.
 */
safetyEventSchema.methods.isReconciled = function isReconciled() {
  if (this.rollCalls.length === 0) return false;
  return this.outstandingUnaccounted().length === 0;
};

/**
 * Why the event cannot be closed, in words.
 *
 * This is the rule the whole module exists for. It is deliberately not
 * overridable: the only way past it is to resolve each outstanding entry with a
 * note saying what happened to that person.
 */
safetyEventSchema.methods.closureError = function closureError() {
  if (this.status === 'closed') return 'This event is already closed.';
  if (this.status === 'cancelled') return 'This event was cancelled.';
  if (this.status === 'planned') return 'This event has not started yet.';
  if (this.rollCalls.length === 0) {
    return 'No class has reported a roll call yet.';
  }

  const outstanding = this.outstandingUnaccounted();
  if (outstanding.length > 0) {
    const names = outstanding
      .slice(0, 5)
      .map((row) => `${row.studentName} (${row.className})`)
      .join(', ');
    return `${outstanding.length} person${
      outstanding.length === 1 ? ' is' : 's are'
    } still unaccounted for: ${names}${outstanding.length > 5 ? ', and others' : ''}. Resolve each one before closing.`;
  }

  return null;
};

safetyEventSchema.methods.isCoordinator = function isCoordinator(userId) {
  return String(this.coordinator) === String(userId);
};

/**
 * Serialises the event for a viewer.
 *
 * Coordinators and admins see everything. A class teacher sees the summary and
 * their own roll calls — the names of children missing from another class, and
 * why, are not staffroom reading.
 */
safetyEventSchema.methods.redactFor = function redactFor(viewer) {
  const plain = this.toObject({ virtuals: true });
  delete plain.__v;

  const viewerId = viewer && (viewer._id || viewer.id);
  const isAdmin = viewer && viewer.role === 'admin';
  if (isAdmin || (viewerId && this.isCoordinator(viewerId))) return plain;

  plain.rollCalls = (plain.rollCalls || []).map((rollCall) => {
    const mine = viewerId && String(rollCall.reportedBy) === String(viewerId);
    if (mine) return rollCall;
    return {
      _id: rollCall._id,
      className: rollCall.className,
      assemblyPoint: rollCall.assemblyPoint,
      expectedCount: rollCall.expectedCount,
      presentCount: rollCall.presentCount,
      unaccountedCount: rollCall.unaccountedCount,
      reportedAt: rollCall.reportedAt,
      unaccounted: [],
    };
  });
  return plain;
};

safetyEventSchema.statics.todayKey = todayKey;
safetyEventSchema.statics.EVENT_TYPES = EVENT_TYPES;
safetyEventSchema.statics.INCIDENT_CATEGORIES = INCIDENT_CATEGORIES;
safetyEventSchema.statics.EVENT_STATUSES = EVENT_STATUSES;
safetyEventSchema.statics.OBSERVATION_SEVERITIES = OBSERVATION_SEVERITIES;
safetyEventSchema.statics.ACTION_STATUSES = ACTION_STATUSES;

safetyEventSchema.set('toObject', { virtuals: true });
safetyEventSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('SafetyEvent', safetyEventSchema);
