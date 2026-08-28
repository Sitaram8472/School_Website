const mongoose = require('mongoose');

/**
 * A request for a printed prospectus.
 *
 * The prospectus page offers a PDF download and nothing else, and the only
 * channel a family has for asking for the printed book is the general contact
 * form — a `Contact` document with `name`, `email`, `subject` and `message`.
 * That form has no field for a postal address, which is the one thing a
 * request to post something absolutely requires, and no state at all, so
 * nothing records whether a book was ever packed, posted or delivered.
 *
 * The difference between this and `Contact` is that a row here costs the
 * school a printed book and postage. That is why it carries a reference the
 * family can quote, an idempotency key so a double-click does not send two
 * books, and a ladder that only goes forward.
 */

const REQUEST_STATUSES = [
  'received',
  'packed',
  'dispatched',
  'delivered',
  'returned',
  'cancelled',
];

/**
 * What each status may become. A book that has left the building cannot be
 * un-sent, so `dispatched` leads only to `delivered` or `returned`, and
 * `cancelled` is unreachable once anything has been posted.
 */
const NEXT_STATUSES = {
  received: ['packed', 'cancelled'],
  packed: ['dispatched', 'cancelled'],
  dispatched: ['delivered', 'returned'],
  delivered: [],
  returned: [],
  cancelled: [],
};

const CHANNELS = ['post', 'courier', 'collect', 'email-only'];

// The channels that physically move a book to an address, and therefore the
// ones that cannot be accepted without one.
const POSTAL_CHANNELS = ['post', 'courier'];

const RELATIONSHIPS = ['parent', 'guardian', 'student', 'agent', 'other'];

const SOURCES = ['website', 'walk-in', 'phone', 'event'];

const MAX_QUANTITY = 5;

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

const historyEntrySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: [40, 'History action cannot exceed 40 characters'],
    },
    from: {
      type: String,
      trim: true,
      default: '',
    },
    to: {
      type: String,
      trim: true,
      default: '',
    },
    by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    byName: {
      type: String,
      trim: true,
      maxlength: [100, 'History actor name cannot exceed 100 characters'],
      default: '',
    },
    at: {
      type: Date,
      default: Date.now,
    },
    note: {
      type: String,
      trim: true,
      maxlength: [300, 'History note cannot exceed 300 characters'],
      default: '',
    },
  },
  { _id: false }
);

const addressSchema = new mongoose.Schema(
  {
    line1: {
      type: String,
      trim: true,
      maxlength: [150, 'Address line cannot exceed 150 characters'],
      default: '',
    },
    line2: {
      type: String,
      trim: true,
      maxlength: [150, 'Address line cannot exceed 150 characters'],
      default: '',
    },
    city: {
      type: String,
      trim: true,
      maxlength: [80, 'City cannot exceed 80 characters'],
      default: '',
    },
    state: {
      type: String,
      trim: true,
      maxlength: [80, 'State cannot exceed 80 characters'],
      default: '',
    },
    postcode: {
      type: String,
      trim: true,
      maxlength: [16, 'Postcode cannot exceed 16 characters'],
      default: '',
    },
    country: {
      type: String,
      trim: true,
      maxlength: [60, 'Country cannot exceed 60 characters'],
      default: 'India',
    },
  },
  { _id: false }
);

const prospectusRequestSchema = new mongoose.Schema(
  {
    /**
     * Short, human-quotable and gap-free. The family reads this back over the
     * phone, so it cannot be a 24-character document id.
     */
    reference: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: [24, 'Reference cannot exceed 24 characters'],
    },

    /**
     * Minted in the browser when the form is opened and reused across retries.
     * Unique, so an impatient second click returns the request that already
     * exists instead of committing the school to a second book and its postage.
     */
    requestKey: {
      type: String,
      required: [true, 'A request key is required'],
      trim: true,
      maxlength: [80, 'Request key cannot exceed 80 characters'],
    },

    applicantName: {
      type: String,
      required: [true, 'Your name is required'],
      trim: true,
      maxlength: [100, 'Name cannot exceed 100 characters'],
    },

    email: {
      type: String,
      required: [true, 'An email address is required'],
      trim: true,
      lowercase: true,
      match: [EMAIL_PATTERN, 'Please enter a valid email'],
    },

    phone: {
      type: String,
      trim: true,
      maxlength: [20, 'Phone number cannot exceed 20 characters'],
      default: '',
    },

    relationship: {
      type: String,
      enum: {
        values: RELATIONSHIPS,
        message: 'Invalid relationship',
      },
      default: 'parent',
    },

    studentName: {
      type: String,
      trim: true,
      maxlength: [100, 'Student name cannot exceed 100 characters'],
      default: '',
    },

    gradeSought: {
      type: String,
      trim: true,
      maxlength: [30, 'Grade cannot exceed 30 characters'],
      default: '',
    },

    academicYear: {
      type: String,
      trim: true,
      maxlength: [20, 'Academic year cannot exceed 20 characters'],
      default: '',
    },

    intakeTerm: {
      type: String,
      trim: true,
      maxlength: [30, 'Intake term cannot exceed 30 characters'],
      default: '',
    },

    channel: {
      type: String,
      enum: {
        values: CHANNELS,
        message: 'Invalid delivery channel',
      },
      default: 'post',
    },

    address: {
      type: addressSchema,
      default: () => ({}),
    },

    /**
     * A cap, because one form submission should not be able to commit a print
     * run. Bulk requests from a school fair are entered by staff as several
     * rows, which is also how they get counted properly.
     */
    quantity: {
      type: Number,
      default: 1,
      min: [1, 'At least one copy must be requested'],
      max: [MAX_QUANTITY, `A single request cannot exceed ${MAX_QUANTITY} copies`],
    },

    status: {
      type: String,
      enum: {
        values: REQUEST_STATUSES,
        message: 'Invalid request status',
      },
      default: 'received',
    },

    source: {
      type: String,
      enum: {
        values: SOURCES,
        message: 'Invalid source',
      },
      default: 'website',
    },

    packedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    packedAt: {
      type: Date,
    },

    dispatchedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    dispatchedAt: {
      type: Date,
    },

    courier: {
      type: String,
      trim: true,
      maxlength: [60, 'Courier name cannot exceed 60 characters'],
      default: '',
    },

    trackingRef: {
      type: String,
      trim: true,
      maxlength: [60, 'Tracking reference cannot exceed 60 characters'],
      default: '',
    },

    deliveredAt: {
      type: Date,
    },

    returnedAt: {
      type: Date,
    },

    returnReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Return reason cannot exceed 300 characters'],
      default: '',
    },

    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    cancelledAt: {
      type: Date,
    },

    cancellationReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Cancellation reason cannot exceed 300 characters'],
      default: '',
    },

    notes: {
      type: String,
      trim: true,
      maxlength: [1000, 'Notes cannot exceed 1000 characters'],
      default: '',
    },

    history: {
      type: [historyEntrySchema],
      default: [],
    },
  },
  { timestamps: true }
);

// The retry guard. Unique on its own rather than partial, because a request
// key means "this submission", and the same submission twice is the same row
// whatever state it has since reached.
prospectusRequestSchema.index({ requestKey: 1 }, { unique: true });

// The reference is quoted back by the family, so it has to resolve to exactly
// one request. Partial on a non-empty string, which a range operator can
// express and which therefore survives index creation.
prospectusRequestSchema.index(
  { reference: 1 },
  { unique: true, partialFilterExpression: { reference: { $type: 'string', $gt: '' } } }
);

// The fulfilment queue reads oldest-first within a status; tracking reads by
// reference and email together.
prospectusRequestSchema.index({ status: 1, createdAt: 1 });
prospectusRequestSchema.index({ email: 1, createdAt: -1 });
prospectusRequestSchema.index({ gradeSought: 1, academicYear: 1 });

prospectusRequestSchema.virtual('needsAddress').get(function needsAddress() {
  return POSTAL_CHANNELS.includes(this.channel);
});

prospectusRequestSchema.set('toJSON', { virtuals: true });
prospectusRequestSchema.set('toObject', { virtuals: true });

/** Whether the ladder allows this move at all. */
prospectusRequestSchema.methods.canMoveTo = function canMoveTo(next) {
  return (NEXT_STATUSES[this.status] || []).includes(next);
};

prospectusRequestSchema.methods.log = function log(action, actor, note = '', from = '', to = '') {
  this.history.push({
    action,
    from,
    to,
    by: actor ? actor._id : undefined,
    byName: (actor && actor.name) || '',
    at: new Date(),
    note,
  });

  return this;
};

/**
 * One place for every status change, so the ladder cannot be climbed by an
 * assignment somewhere that forgot to check it.
 */
prospectusRequestSchema.methods.moveTo = function moveTo(next, actor, note = '') {
  if (!REQUEST_STATUSES.includes(next)) {
    throw new Error(`"${next}" is not a request status`);
  }
  if (this.status === next) {
    throw new Error(`This request is already ${next}`);
  }
  if (!this.canMoveTo(next)) {
    throw new Error(`A ${this.status} request cannot become ${next}`);
  }

  const from = this.status;
  this.status = next;

  return this.log(next, actor, note, from, next);
};

prospectusRequestSchema.methods.pack = function pack(actor, note = '') {
  this.moveTo('packed', actor, note);
  this.packedBy = actor ? actor._id : undefined;
  this.packedAt = new Date();

  return this;
};

/**
 * A courier dispatch with no tracking number is the same as no answer when the
 * family rings to ask, so the reference is required rather than encouraged.
 */
prospectusRequestSchema.methods.dispatch = function dispatch(actor, courier = '', trackingRef = '') {
  if (this.channel === 'courier' && (!courier.trim() || !trackingRef.trim())) {
    throw new Error('A courier dispatch needs both a courier and a tracking reference');
  }

  this.moveTo('dispatched', actor, trackingRef);
  this.dispatchedBy = actor ? actor._id : undefined;
  this.dispatchedAt = new Date();
  this.courier = courier.trim();
  this.trackingRef = trackingRef.trim();

  return this;
};

prospectusRequestSchema.methods.markDelivered = function markDelivered(actor, note = '') {
  this.moveTo('delivered', actor, note);
  this.deliveredAt = new Date();

  return this;
};

prospectusRequestSchema.methods.markReturned = function markReturned(actor, reason) {
  if (!reason || !String(reason).trim()) {
    throw new Error('A return reason is required');
  }

  this.moveTo('returned', actor, String(reason).trim());
  this.returnedAt = new Date();
  this.returnReason = String(reason).trim();

  return this;
};

prospectusRequestSchema.methods.cancel = function cancel(actor, reason) {
  if (!reason || !String(reason).trim()) {
    throw new Error('A cancellation reason is required');
  }

  this.moveTo('cancelled', actor, String(reason).trim());
  this.cancelledBy = actor ? actor._id : undefined;
  this.cancelledAt = new Date();
  this.cancellationReason = String(reason).trim();

  return this;
};

/**
 * What a member of staff sees in the fulfilment queue.
 */
prospectusRequestSchema.methods.toRow = function toRow() {
  return {
    _id: this._id,
    reference: this.reference,
    applicantName: this.applicantName,
    email: this.email,
    phone: this.phone,
    relationship: this.relationship,
    studentName: this.studentName,
    gradeSought: this.gradeSought,
    academicYear: this.academicYear,
    intakeTerm: this.intakeTerm,
    channel: this.channel,
    address: this.address,
    quantity: this.quantity,
    status: this.status,
    source: this.source,
    nextStatuses: NEXT_STATUSES[this.status] || [],
    packedAt: this.packedAt,
    dispatchedAt: this.dispatchedAt,
    courier: this.courier,
    trackingRef: this.trackingRef,
    deliveredAt: this.deliveredAt,
    returnedAt: this.returnedAt,
    returnReason: this.returnReason,
    cancellationReason: this.cancellationReason,
    notes: this.notes,
    createdAt: this.createdAt,
  };
};

/**
 * What a member of the public gets back from the tracking route.
 *
 * Deliberately narrow. The address, the phone number and the internal notes
 * are on the document and none of them belong in a response that is reachable
 * with a reference and an email address.
 */
prospectusRequestSchema.methods.toPublicRow = function toPublicRow() {
  return {
    reference: this.reference,
    status: this.status,
    channel: this.channel,
    quantity: this.quantity,
    requestedAt: this.createdAt,
    packedAt: this.packedAt,
    dispatchedAt: this.dispatchedAt,
    courier: this.courier,
    trackingRef: this.trackingRef,
    deliveredAt: this.deliveredAt,
    returnedAt: this.returnedAt,
  };
};

/**
 * Cross-field validation. Mongoose 9 passes no callback to middleware, so this
 * throws rather than calling `next(err)`.
 */
prospectusRequestSchema.pre('save', function beforeSave() {
  const postal = POSTAL_CHANNELS.includes(this.channel);
  const address = this.address || {};

  if (postal) {
    const missing = ['line1', 'city', 'postcode'].filter(
      (field) => !String(address[field] || '').trim()
    );

    if (missing.length) {
      throw new Error(
        `A ${this.channel} request needs a full address; missing: ${missing.join(', ')}`
      );
    }
  } else if (
    // A collection or an email-only request has no reason to hold a home
    // address, so one is refused rather than quietly stored.
    String(address.line1 || '').trim() ||
    String(address.postcode || '').trim()
  ) {
    throw new Error(
      `A ${this.channel} request should not carry a postal address`
    );
  }

  if (this.status === 'dispatched' && this.channel === 'courier' && !this.trackingRef) {
    throw new Error('A dispatched courier request must carry a tracking reference');
  }
});

prospectusRequestSchema.statics.STATUSES = REQUEST_STATUSES;
prospectusRequestSchema.statics.NEXT_STATUSES = NEXT_STATUSES;
prospectusRequestSchema.statics.CHANNELS = CHANNELS;
prospectusRequestSchema.statics.POSTAL_CHANNELS = POSTAL_CHANNELS;
prospectusRequestSchema.statics.RELATIONSHIPS = RELATIONSHIPS;
prospectusRequestSchema.statics.SOURCES = SOURCES;
prospectusRequestSchema.statics.MAX_QUANTITY = MAX_QUANTITY;

/**
 * Serial issuer for the reference a family quotes.
 *
 * A counter rather than a digest of the document id, for the same reason the
 * fee module issues credit-note serials this way: the number is read aloud
 * over the telephone, so it has to be short and sequential, and two requests
 * arriving together have to get two numbers rather than the same one twice.
 */
const prospectusCounterSchema = new mongoose.Schema(
  {
    _id: { type: String },
    seq: { type: Number, default: 0 },
  },
  { _id: false }
);

prospectusCounterSchema.statics.next = async function next(academicYear) {
  const scope = (academicYear || '').replace(/\s+/g, '') || String(new Date().getFullYear());

  const counter = await this.findOneAndUpdate(
    { _id: `PR-${scope}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  return `PR/${scope}/${String(counter.seq).padStart(4, '0')}`;
};

const ProspectusRequest = mongoose.model('ProspectusRequest', prospectusRequestSchema);
const ProspectusCounter = mongoose.model('ProspectusCounter', prospectusCounterSchema);

module.exports = ProspectusRequest;
module.exports.ProspectusRequest = ProspectusRequest;
module.exports.ProspectusCounter = ProspectusCounter;
