const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * Who may collect a child, and the record that they did.
 *
 * This is the module where a bug is not a wrong number. Everything in it
 * enforces a rule the school already has and currently keeps in somebody's
 * head, so the design is mostly about which things are allowed to be a stored
 * flag and which are not.
 *
 *   Validity is never a stored flag. `isValidAt(date, time)` is computed from
 *     the window, the weekdays and the time bounds, every time it is asked. A
 *     stored `active` boolean is true until somebody remembers to make it
 *     false, and the neighbour who collected a child during an illness in
 *     August is still "allowed" in February because nobody remembered.
 *
 *   A restricted person is refused first, and loudly. `isRestricted` is checked
 *     before validity, before the window, before anything. There is no code
 *     path in which the gate screen shows a restricted name in green. This is
 *     the reason the module has a schema rather than a text field.
 *
 *   A release names the authorisation it was made under. Where it cannot, it
 *     names an override, a reason and an approver instead. Refusing to release
 *     a child because the software says no is not a real option in a car park
 *     at 3pm, so the gap between the rule and reality is recorded rather than
 *     pretended away — and the override list is a report somebody reads on
 *     Monday.
 */

const RELATIONSHIPS = [
  'parent',
  'guardian',
  'grandparent',
  'sibling',
  'relative',
  'neighbour',
  'driver',
  'staff',
  'other',
];

const AUTHORISATION_SCOPES = ['standing', 'date-range', 'single-day'];

const AUTHORISATION_STATUSES = [
  'pending',
  'active',
  'suspended',
  'revoked',
  'expired',
];

// A revoked authorisation is never reactivated — a new one is created. The
// trail of who could collect a child, and when, is not rewritable.
const TERMINAL_STATUSES = ['revoked', 'expired'];

const ID_TYPES = ['aadhaar', 'driving-licence', 'passport', 'voter-id', 'staff-card', 'other'];

const RELEASE_TYPES = [
  'end-of-day',
  'early-collection',
  'emergency',
  'activity',
  'medical',
];

const VERIFICATION_METHODS = ['code', 'photo-id', 'known-to-staff', 'override'];

const RELEASE_STATUSES = ['open', 'closed', 'unreturned'];

// A release of one of these types is expected to end with the child back in
// school, so it opens rather than closes.
const RETURNING_TYPES = ['early-collection', 'medical', 'activity'];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const PHONE_PATTERN = /^[+]?[\d\s-]{6,20}$/;

const CODE_LENGTH = 6;
const MAX_AUTHORISATIONS_PER_STUDENT = 12;

/** Today in the server's local zone, as the YYYY-MM-DD key the model stores. */
function todayKey(now = new Date()) {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/** "14:35" in the server's local zone. */
function timeKey(now = new Date()) {
  return [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
  ].join(':');
}

function weekdayOf(dateKey) {
  const ms = Date.parse(`${dateKey}T00:00:00`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).getDay();
}

/**
 * A short code the parent can read down a phone line. Crypto-random rather than
 * Math.random: this is the thing that lets a stranger through a gate, and a
 * guessable one is worse than none because it looks like a control.
 */
function issueCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return code;
}

/**
 * Show the last two digits and nothing else. A gate screen that prints every
 * guardian's phone number in full is an address book anybody in a corridor can
 * photograph.
 */
function maskPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 3) return '••';
  return `••••••${digits.slice(-2)}`;
}

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

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

const pickupAuthorisationSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'An authorisation must name a student'],
      index: true,
    },
    studentName: {
      type: String,
      trim: true,
    },
    guardianName: {
      type: String,
      required: [true, 'The collector must be named'],
      trim: true,
      maxlength: [120, 'Name cannot exceed 120 characters'],
    },
    relationship: {
      type: String,
      required: [true, 'The relationship is required'],
      enum: {
        values: RELATIONSHIPS,
        message: 'Invalid relationship',
      },
    },
    // Present when the collector has an account of their own. Absent for the
    // grandmother who does not, which is most of them.
    guardianUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    phone: {
      type: String,
      required: [true, 'A contact number is required'],
      trim: true,
      match: [PHONE_PATTERN, 'That does not look like a phone number'],
    },
    altPhone: {
      type: String,
      trim: true,
      match: [PHONE_PATTERN, 'That does not look like a phone number'],
      default: null,
    },
    photoUrl: {
      type: String,
      trim: true,
      maxlength: [500, 'Photo link cannot exceed 500 characters'],
      default: null,
    },
    idType: {
      type: String,
      enum: {
        values: ID_TYPES,
        message: 'Invalid identity document type',
      },
      default: null,
    },
    // The last four digits only. Storing a whole identity number to check
    // somebody at a gate is collecting a liability to solve a lookup.
    idLastFour: {
      type: String,
      trim: true,
      match: [/^\d{4}$/, 'Record the last four digits only'],
      default: null,
    },
    scope: {
      type: String,
      enum: {
        values: AUTHORISATION_SCOPES,
        message: 'Invalid scope',
      },
      default: 'standing',
    },
    validFrom: {
      type: String,
      match: [DATE_PATTERN, 'Valid-from must be in YYYY-MM-DD format'],
      default: null,
    },
    validUntil: {
      type: String,
      match: [DATE_PATTERN, 'Valid-until must be in YYYY-MM-DD format'],
      default: null,
    },
    // 0 = Sunday .. 6 = Saturday. Empty means every day the window allows.
    daysOfWeek: {
      type: [Number],
      default: [],
      validate: {
        validator: (days) => days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
        message: 'Days of the week must be 0 (Sunday) to 6 (Saturday)',
      },
    },
    notBefore: {
      type: String,
      match: [TIME_PATTERN, 'Not-before must be in HH:MM format'],
      default: null,
    },
    notAfter: {
      type: String,
      match: [TIME_PATTERN, 'Not-after must be in HH:MM format'],
      default: null,
    },
    status: {
      type: String,
      enum: {
        values: AUTHORISATION_STATUSES,
        message: 'Invalid status',
      },
      default: 'pending',
      index: true,
    },
    // A named person who must NOT collect this child. The field that makes this
    // a safeguarding record rather than an address book.
    isRestricted: {
      type: Boolean,
      default: false,
    },
    restrictionNote: {
      type: String,
      trim: true,
      maxlength: [1000, 'Restriction note cannot exceed 1000 characters'],
      default: null,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    suspendedReason: {
      type: String,
      trim: true,
      maxlength: [500, 'Reason cannot exceed 500 characters'],
      default: null,
    },
    revokedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revokeReason: {
      type: String,
      trim: true,
      maxlength: [500, 'Reason cannot exceed 500 characters'],
      default: null,
    },
    // Issued by the server, shown to the parent, quoted at the gate. Never
    // accepted from a client.
    verificationCode: {
      type: String,
      default: null,
    },
    codeIssuedAt: {
      type: Date,
      default: null,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [1000, 'Notes cannot exceed 1000 characters'],
      default: null,
    },
    history: {
      type: [historySchema],
      default: [],
    },
  },
  { timestamps: true }
);

pickupAuthorisationSchema.index({ student: 1, status: 1 });
pickupAuthorisationSchema.index({ student: 1, isRestricted: 1 });
pickupAuthorisationSchema.index({ validUntil: 1, status: 1 });

pickupAuthorisationSchema.pre('validate', function derive() {
  if (this.validFrom && this.validUntil && this.validUntil < this.validFrom) {
    this.invalidate('validUntil', 'The window ends before it starts');
  }
  if (this.notBefore && this.notAfter && this.notAfter <= this.notBefore) {
    this.invalidate('notAfter', 'The time window ends before it starts');
  }

  // A single day is a window of one. Storing it as one means every check below
  // has one shape rather than three.
  if (this.scope === 'single-day' && this.validFrom) {
    this.validUntil = this.validFrom;
  }
  if (this.scope === 'standing') {
    this.validUntil = this.validUntil || null;
  }
  if (this.scope !== 'standing' && !this.validFrom) {
    this.invalidate('validFrom', 'A time-boxed authorisation needs a start date');
  }
  if (this.scope === 'date-range' && !this.validUntil) {
    this.invalidate('validUntil', 'A date-range authorisation needs an end date');
  }

  if (this.isRestricted && !this.restrictionNote) {
    this.invalidate(
      'restrictionNote',
      'A restriction has to say what it is — a name in red with no reason is unusable at a gate'
    );
  }

  // A restriction is not a permission. Nothing about it is ever "active", and
  // it does not expire on its own.
  if (this.isRestricted) {
    this.scope = 'standing';
    this.validUntil = null;
    this.daysOfWeek = [];
    this.notBefore = null;
    this.notAfter = null;
    this.verificationCode = null;
  }

  if (this.daysOfWeek && this.daysOfWeek.length) {
    this.daysOfWeek = [...new Set(this.daysOfWeek)].sort();
  }

  if (this.status !== 'revoked') {
    this.revokedBy = undefined;
    this.revokedAt = undefined;
    this.revokeReason = null;
  }
  if (this.status !== 'suspended') {
    this.suspendedReason = null;
  }
});

/**
 * Has this authorisation lapsed on its own?
 *
 * Derived, so the answer is right on the day rather than on the day somebody
 * last ran a sweep. The sweep endpoint exists only to make the stored status
 * agree with this, so that a human reading a list sees what the checks see.
 */
pickupAuthorisationSchema.methods.hasLapsed = function hasLapsed(today = todayKey()) {
  if (this.isRestricted) return false;
  if (!this.validUntil) return false;
  return this.validUntil < today;
};

/**
 * May this person collect the child at this moment?
 *
 * Returns a reason rather than a boolean. At a gate, "no" is not an answer
 * anybody can act on.
 */
pickupAuthorisationSchema.methods.validityAt = function validityAt(
  date = todayKey(),
  time = timeKey()
) {
  if (this.isRestricted) {
    return {
      valid: false,
      state: 'restricted',
      reason: this.restrictionNote || 'This person must not collect this child',
    };
  }

  if (this.status === 'pending') {
    return { valid: false, state: 'pending', reason: 'Not yet approved by the school' };
  }
  if (this.status === 'suspended') {
    return {
      valid: false,
      state: 'suspended',
      reason: this.suspendedReason || 'Suspended',
    };
  }
  if (this.status === 'revoked') {
    return {
      valid: false,
      state: 'revoked',
      reason: this.revokeReason || 'Revoked',
    };
  }

  if (this.validFrom && date < this.validFrom) {
    return {
      valid: false,
      state: 'not-yet',
      reason: `Not valid until ${this.validFrom}`,
    };
  }
  if (this.validUntil && date > this.validUntil) {
    return {
      valid: false,
      state: 'expired',
      reason: `Expired on ${this.validUntil}`,
    };
  }

  if (this.daysOfWeek.length) {
    const weekday = weekdayOf(date);
    if (!this.daysOfWeek.includes(weekday)) {
      return {
        valid: false,
        state: 'wrong-day',
        reason: 'Not authorised on this day of the week',
      };
    }
  }

  if (this.notBefore && time < this.notBefore) {
    return {
      valid: false,
      state: 'too-early',
      reason: `Not authorised before ${this.notBefore}`,
    };
  }
  if (this.notAfter && time > this.notAfter) {
    return {
      valid: false,
      state: 'too-late',
      reason: `Not authorised after ${this.notAfter}`,
    };
  }

  return { valid: true, state: 'valid', reason: null };
};

pickupAuthorisationSchema.methods.isValidAt = function isValidAt(date, time) {
  return this.validityAt(date, time).valid;
};

/** Regenerate the code. Never accepted from a client, in either direction. */
pickupAuthorisationSchema.methods.reissueCode = function reissueCode() {
  this.verificationCode = issueCode();
  this.codeIssuedAt = new Date();
  return this.verificationCode;
};

pickupAuthorisationSchema.methods.recordHistory = function recordHistory(
  action,
  userId,
  note
) {
  this.history.push({ action, by: userId, at: new Date(), note });
  if (this.history.length > 60) this.history = this.history.slice(-60);
};

/** How long this permission lasts, in words somebody can act on. */
pickupAuthorisationSchema.methods.windowPhrase = function windowPhrase() {
  if (this.isRestricted) return 'Must not collect';
  if (this.scope === 'single-day') return `On ${this.validFrom} only`;

  const parts = [];
  if (this.validFrom && this.validUntil) {
    parts.push(`${this.validFrom} to ${this.validUntil}`);
  } else if (this.validUntil) {
    parts.push(`until ${this.validUntil}`);
  } else {
    parts.push('no end date');
  }

  if (this.daysOfWeek.length) {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    parts.push(this.daysOfWeek.map((d) => names[d]).join(', ') + ' only');
  }
  if (this.notBefore || this.notAfter) {
    parts.push(`${this.notBefore || '00:00'}–${this.notAfter || '23:59'}`);
  }

  return parts.join(' · ');
};

/**
 * The gate view. The phone number is masked and the verification code is
 * removed — the gate confirms a code somebody quotes, it does not read it off
 * a screen in front of them.
 */
pickupAuthorisationSchema.methods.toGateRow = function toGateRow(
  date = todayKey(),
  time = timeKey()
) {
  const validity = this.validityAt(date, time);
  return {
    _id: this._id,
    student: this.student,
    studentName: this.studentName,
    guardianName: this.guardianName,
    relationship: this.relationship,
    photoUrl: this.photoUrl,
    phoneMasked: maskPhone(this.phone),
    idType: this.idType,
    idLastFour: this.idLastFour,
    isRestricted: this.isRestricted,
    restrictionNote: this.restrictionNote,
    status: this.status,
    scope: this.scope,
    windowPhrase: this.windowPhrase(),
    validity,
    hasCode: Boolean(this.verificationCode),
  };
};

/** The owner's view. Keeps the code and the full number; adds no judgement. */
pickupAuthorisationSchema.methods.toOwnerRow = function toOwnerRow(date = todayKey()) {
  return {
    ...this.toGateRow(date),
    phone: this.phone,
    altPhone: this.altPhone,
    verificationCode: this.verificationCode,
    codeIssuedAt: this.codeIssuedAt,
    validFrom: this.validFrom,
    validUntil: this.validUntil,
    daysOfWeek: this.daysOfWeek,
    notBefore: this.notBefore,
    notAfter: this.notAfter,
    notes: this.notes,
    approvedAt: this.approvedAt,
  };
};

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

const releaseEventSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A release must name a student'],
      index: true,
    },
    studentName: {
      type: String,
      trim: true,
    },
    // Null only where the release was an override, in which case the reason and
    // the approver below are required.
    authorisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PickupAuthorisation',
      default: null,
    },
    collectedByName: {
      type: String,
      required: [true, 'The person collecting must be named'],
      trim: true,
      maxlength: [120, 'Name cannot exceed 120 characters'],
    },
    relationship: {
      type: String,
      enum: {
        values: RELATIONSHIPS,
        message: 'Invalid relationship',
      },
      default: 'other',
    },
    type: {
      type: String,
      required: [true, 'The kind of release is required'],
      enum: {
        values: RELEASE_TYPES,
        message: 'Invalid release type',
      },
    },
    date: {
      type: String,
      required: true,
      match: [DATE_PATTERN, 'Date must be in YYYY-MM-DD format'],
      index: true,
    },
    releasedAt: {
      type: Date,
      default: Date.now,
    },
    releasedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A release must name the member of staff who made it'],
    },
    verifiedBy: {
      type: String,
      required: [true, 'How the collector was verified is required'],
      enum: {
        values: VERIFICATION_METHODS,
        message: 'Invalid verification method',
      },
    },
    overrideReason: {
      type: String,
      trim: true,
      maxlength: [1000, 'Reason cannot exceed 1000 characters'],
      default: null,
    },
    overrideApprovedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    expectedReturn: {
      type: String,
      match: [TIME_PATTERN, 'Expected return must be in HH:MM format'],
      default: null,
    },
    returnedAt: {
      type: Date,
      default: null,
    },
    returnRecordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    status: {
      type: String,
      enum: {
        values: RELEASE_STATUSES,
        message: 'Invalid status',
      },
      default: 'closed',
      index: true,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [1000, 'Notes cannot exceed 1000 characters'],
      default: null,
    },
  },
  { timestamps: true }
);

releaseEventSchema.index({ date: 1, status: 1 });
releaseEventSchema.index({ student: 1, date: -1 });
releaseEventSchema.index({ verifiedBy: 1, date: -1 });

releaseEventSchema.pre('validate', function derive() {
  // An override is the escape hatch, and it costs a reason and a named
  // approver. Without both it is just an unrecorded release.
  if (this.verifiedBy === 'override') {
    if (!this.overrideReason) {
      this.invalidate('overrideReason', 'An override needs a reason');
    }
    if (!this.overrideApprovedBy) {
      this.invalidate('overrideApprovedBy', 'An override needs a named approver');
    }
  } else {
    this.overrideReason = null;
    this.overrideApprovedBy = null;
    if (!this.authorisation) {
      this.invalidate(
        'authorisation',
        'A release must name the authorisation it was made under, or be recorded as an override'
      );
    }
  }

  // A collection the child comes back from stays open until somebody says they
  // came back. That open list is the difference between knowing a child is out
  // and finding out at 5pm.
  if (RETURNING_TYPES.includes(this.type) && !this.returnedAt) {
    this.status = 'open';
  } else if (this.returnedAt) {
    this.status = 'closed';
  } else if (!RETURNING_TYPES.includes(this.type)) {
    this.status = 'closed';
  }
});

/** Is this release overdue against its own expected return? */
releaseEventSchema.methods.isOverdue = function isOverdue(now = new Date()) {
  if (this.status !== 'open' || !this.expectedReturn) return false;
  if (this.date < todayKey(now)) return true;
  if (this.date > todayKey(now)) return false;
  return timeKey(now) > this.expectedReturn;
};

releaseEventSchema.methods.toRow = function toRow(now = new Date()) {
  return {
    _id: this._id,
    student: this.student,
    studentName: this.studentName,
    authorisation: this.authorisation,
    collectedByName: this.collectedByName,
    relationship: this.relationship,
    type: this.type,
    date: this.date,
    releasedAt: this.releasedAt,
    releasedBy: this.releasedBy,
    verifiedBy: this.verifiedBy,
    isOverride: this.verifiedBy === 'override',
    overrideReason: this.overrideReason,
    overrideApprovedBy: this.overrideApprovedBy,
    expectedReturn: this.expectedReturn,
    returnedAt: this.returnedAt,
    status: this.status,
    isOverdue: this.isOverdue(now),
    notes: this.notes,
  };
};

pickupAuthorisationSchema.statics.todayKey = todayKey;
pickupAuthorisationSchema.statics.timeKey = timeKey;
pickupAuthorisationSchema.statics.maskPhone = maskPhone;
pickupAuthorisationSchema.statics.issueCode = issueCode;
pickupAuthorisationSchema.statics.RELATIONSHIPS = RELATIONSHIPS;
pickupAuthorisationSchema.statics.AUTHORISATION_SCOPES = AUTHORISATION_SCOPES;
pickupAuthorisationSchema.statics.AUTHORISATION_STATUSES = AUTHORISATION_STATUSES;
pickupAuthorisationSchema.statics.TERMINAL_STATUSES = TERMINAL_STATUSES;
pickupAuthorisationSchema.statics.ID_TYPES = ID_TYPES;
pickupAuthorisationSchema.statics.MAX_AUTHORISATIONS_PER_STUDENT =
  MAX_AUTHORISATIONS_PER_STUDENT;

releaseEventSchema.statics.todayKey = todayKey;
releaseEventSchema.statics.timeKey = timeKey;
releaseEventSchema.statics.RELEASE_TYPES = RELEASE_TYPES;
releaseEventSchema.statics.VERIFICATION_METHODS = VERIFICATION_METHODS;
releaseEventSchema.statics.RELEASE_STATUSES = RELEASE_STATUSES;
releaseEventSchema.statics.RETURNING_TYPES = RETURNING_TYPES;

const PickupAuthorisation = mongoose.model(
  'PickupAuthorisation',
  pickupAuthorisationSchema
);
const ReleaseEvent = mongoose.model('ReleaseEvent', releaseEventSchema);

module.exports = {
  PickupAuthorisation,
  ReleaseEvent,
  RELATIONSHIPS,
  AUTHORISATION_SCOPES,
  AUTHORISATION_STATUSES,
  TERMINAL_STATUSES,
  ID_TYPES,
  RELEASE_TYPES,
  VERIFICATION_METHODS,
  RELEASE_STATUSES,
  RETURNING_TYPES,
  MAX_AUTHORISATIONS_PER_STUDENT,
  todayKey,
  timeKey,
  maskPhone,
  issueCode,
};
