const mongoose = require('mongoose');

/**
 * What each member of teaching staff is qualified to do, and until when.
 *
 * `frontend/src/data/faculty.js` is a hard-coded array where each teacher has a
 * `subject` string. That is a label on a card. It does not distinguish the
 * person holding a postgraduate qualification in physics from the person
 * covering it this term, and it says nothing at all about the certificates a
 * school is legally required to keep current.
 *
 * Which brings us to the thing this model exists for. **Nothing else in this
 * codebase expires.** Search it: there is no field anywhere that becomes false
 * on a date. Every status is set by somebody and stays set. That is fine for
 * `Notice.isActive` and it is not fine for a safeguarding certificate, because
 * a lapsed certificate and a current one look identical when both are simply
 * absent from the system.
 *
 * So compliance here is **a function of today's date, computed at read time,
 * and stored nowhere**. A stored compliance flag is wrong the morning after it
 * is written, and wrong silently, which is the whole failure being fixed. There
 * is no scheduler in this repository, and adding one would only move the
 * problem: a job that does not run leaves the field stale, and the field is
 * trusted precisely because it looks maintained.
 */

const KINDS = [
  'degree',
  'teaching-licence',
  'subject-endorsement',
  'first-aid',
  'child-protection',
  'lab-safety',
  'other',
];

const STATUSES = ['submitted', 'verified', 'rejected', 'superseded', 'withdrawn'];

// Statuses in which a credential is still the current entry for its slot.
// A rejected, superseded or withdrawn certificate stays on the record — it is
// simply no longer the one in force.
const CURRENT_STATUSES = ['submitted', 'verified'];

// The compliance states, derived. Never stored.
const COMPLIANCE = {
  UNVERIFIED: 'unverified',
  VALID: 'valid',
  EXPIRING: 'expiring',
  EXPIRED: 'expired',
  NOT_IN_FORCE: 'not-in-force',
};

/**
 * How much notice each kind of certificate deserves.
 *
 * Safeguarding needs longer than a first-aid refresher, because the renewal
 * involves a third party and a queue. These are defaults; a credential may
 * carry its own.
 */
const DEFAULT_WARNING_DAYS = {
  'child-protection': 90,
  'teaching-licence': 90,
  'first-aid': 45,
  'lab-safety': 45,
  degree: 30,
  'subject-endorsement': 30,
  other: 30,
};

const historySchema = new mongoose.Schema(
  {
    action: { type: String, required: true, trim: true, maxlength: [40, 'Too long'] },
    from: { type: String, trim: true, maxlength: [80, 'Too long'] },
    to: { type: String, trim: true, maxlength: [80, 'Too long'] },
    note: { type: String, trim: true, maxlength: [500, 'Too long'] },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, trim: true, maxlength: [120, 'Too long'], default: '' },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const teacherCredentialSchema = new mongoose.Schema(
  {
    teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A credential must belong to a member of staff'],
    },

    // Denormalised so the expiry report renders without a join per row.
    teacherName: { type: String, trim: true, maxlength: [120, 'Too long'], default: '' },
    department: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },

    kind: {
      type: String,
      enum: { values: KINDS, message: 'Invalid credential kind' },
      required: [true, 'A credential kind is required'],
    },

    title: {
      type: String,
      required: [true, 'A title is required'],
      trim: true,
      maxlength: [160, 'Title cannot exceed 160 characters'],
    },

    issuer: {
      type: String,
      required: [true, 'An issuing body is required'],
      trim: true,
      maxlength: [160, 'Issuer cannot exceed 160 characters'],
    },

    // The certificate number the issuer would recognise. Part of the identity
    // of the slot a renewal supersedes.
    reference: {
      type: String,
      required: [true, 'A certificate reference is required'],
      trim: true,
      maxlength: [80, 'Reference cannot exceed 80 characters'],
    },

    issuedOn: { type: Date, required: [true, 'An issue date is required'] },

    // Null means it genuinely does not expire — a degree. That is a different
    // fact from "we have not asked", which is why it is nullable rather than
    // defaulted to some far-off date.
    expiresOn: { type: Date, default: null },

    subjects: {
      type: [{ type: String, trim: true, maxlength: [60, 'Too long'] }],
      default: [],
      validate: {
        validator: (v) => v.length <= 20,
        message: 'A credential cannot endorse more than 20 subjects',
      },
    },

    grades: {
      type: [{ type: String, trim: true, maxlength: [20, 'Too long'] }],
      default: [],
    },

    documentUrl: { type: String, trim: true, maxlength: [300, 'Too long'], default: '' },

    status: {
      type: String,
      enum: { values: STATUSES, message: 'Invalid credential status' },
      default: 'submitted',
    },

    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    verifiedAt: { type: Date, default: null },
    verificationNote: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    withdrawnAt: { type: Date, default: null },

    // The renewal chain. A renewed certificate is a new document pointing at
    // the old one; the old one is never edited.
    supersedes: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TeacherCredential',
      default: null,
    },
    supersededBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TeacherCredential',
      default: null,
    },
    supersededAt: { type: Date, default: null },

    expiryWarningDays: { type: Number, default: null, min: [0, 'Cannot be negative'] },

    // Derived from `status`. It exists because a unique partial index cannot
    // express a negation — MongoDB rejects `$ne` inside a
    // partialFilterExpression — so the boolean is what the index filters on.
    isCurrent: { type: Boolean, default: true },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

/**
 * One current credential per slot.
 *
 * The slot is (teacher, kind, reference): the same certificate number, held by
 * the same person, for the same kind of thing. Renewing under a new number
 * creates a new slot and supersedes the old one explicitly, which is what makes
 * the chain walkable.
 */
teacherCredentialSchema.index(
  { teacher: 1, kind: 1, reference: 1 },
  {
    unique: true,
    partialFilterExpression: { isCurrent: true },
    name: 'one_current_credential_per_slot',
  }
);

// The report that stops the inspection finding: what expires soonest.
teacherCredentialSchema.index({ expiresOn: 1, status: 1 });
teacherCredentialSchema.index({ teacher: 1, kind: 1, status: 1 });

// The query that matters in the other direction: who may teach this subject.
teacherCredentialSchema.index({ subjects: 1, status: 1, expiresOn: 1 });

teacherCredentialSchema.pre('validate', function derive() {
  if (this.issuedOn && this.issuedOn > new Date()) {
    this.invalidate('issuedOn', 'A certificate cannot be issued in the future');
  }

  if (this.expiresOn && this.issuedOn && this.expiresOn <= this.issuedOn) {
    this.invalidate('expiresOn', 'A certificate cannot expire before it was issued');
  }
});

teacherCredentialSchema.pre('save', function guard() {
  this.isCurrent = CURRENT_STATUSES.includes(this.status);

  if (this.verifiedBy && this.teacher && String(this.verifiedBy) === String(this.teacher)) {
    throw new Error('A member of staff cannot verify their own credential');
  }

  if (this.status === 'rejected' && !this.rejectionReason) {
    throw new Error('A rejection reason is required');
  }
});

teacherCredentialSchema.methods.recordHistory = function recordHistory(entry) {
  this.history.push({
    action: entry.action,
    from: entry.from === undefined || entry.from === null ? undefined : String(entry.from),
    to: entry.to === undefined || entry.to === null ? undefined : String(entry.to),
    note: entry.note,
    by: entry.by,
    byName: entry.byName || '',
    at: new Date(),
  });

  return this;
};

teacherCredentialSchema.methods.warningDays = function warningDays() {
  if (this.expiryWarningDays !== null && this.expiryWarningDays !== undefined) {
    return this.expiryWarningDays;
  }
  return DEFAULT_WARNING_DAYS[this.kind] || 30;
};

/**
 * The whole feature, in one function.
 *
 * Derived from `now` on every call and stored nowhere. `expiring` is a warning
 * and still counts as in force; `unverified` never counts, because a
 * certificate nobody has checked is a claim rather than a qualification and the
 * register exists to keep those two things apart.
 */
teacherCredentialSchema.methods.complianceAt = function complianceAt(now = new Date()) {
  if (!CURRENT_STATUSES.includes(this.status)) {
    return {
      state: COMPLIANCE.NOT_IN_FORCE,
      inForce: false,
      reason: `This credential is ${this.status}`,
      daysRemaining: null,
    };
  }

  if (this.status === 'submitted') {
    return {
      state: COMPLIANCE.UNVERIFIED,
      inForce: false,
      reason: 'Submitted, but nobody has checked it against the certificate',
      daysRemaining: null,
    };
  }

  if (!this.expiresOn) {
    return {
      state: COMPLIANCE.VALID,
      inForce: true,
      reason: 'Verified, and this kind of certificate does not expire',
      daysRemaining: null,
    };
  }

  const daysRemaining = Math.ceil((this.expiresOn - now) / 86400000);

  if (daysRemaining < 0) {
    return {
      state: COMPLIANCE.EXPIRED,
      inForce: false,
      reason: `Expired ${Math.abs(daysRemaining)} day${
        Math.abs(daysRemaining) === 1 ? '' : 's'
      } ago`,
      daysRemaining,
    };
  }

  if (daysRemaining <= this.warningDays()) {
    return {
      state: COMPLIANCE.EXPIRING,
      inForce: true,
      reason: `Expires in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`,
      daysRemaining,
    };
  }

  return {
    state: COMPLIANCE.VALID,
    inForce: true,
    reason: `Valid for another ${daysRemaining} days`,
    daysRemaining,
  };
};

/**
 * Was this certificate in force on some past date?
 *
 * The question an inspector actually asks, and the reason renewal supersedes
 * rather than overwrites. A single mutable status field on the teacher's record
 * could not answer it at all.
 */
teacherCredentialSchema.methods.wasInForceOn = function wasInForceOn(date) {
  const when = new Date(date);

  // A certificate the school never accepted never counted at all.
  if (!this.verifiedAt) return false;

  // A rejection or withdrawal says the certificate should never have counted,
  // so it removes cover from the whole period rather than from the date of the
  // decision onwards.
  if (['rejected', 'withdrawn'].includes(this.status)) return false;

  if (this.issuedOn > when) return false;
  if (this.expiresOn && this.expiresOn < when) return false;

  // Being superseded later does not retroactively remove cover; being
  // superseded *before* the date in question does.
  if (this.supersededAt && this.supersededAt <= when) return false;

  return true;
};

/**
 * Had the school actually checked this certificate by `date`?
 *
 * Deliberately separate from `wasInForceOn`, because they are two different
 * questions and collapsing them gives a wrong answer to both. "Was their first
 * aid valid in March?" is about the certificate. "Had we verified it by March?"
 * is about the school's own process.
 *
 * Requiring verification to predate the date would mean a school that
 * digitises its records today gets "not covered" for every date before today —
 * which is not what happened, and is the kind of confidently wrong answer that
 * is worse than no answer.
 */
teacherCredentialSchema.methods.wasVerifiedBy = function wasVerifiedBy(date) {
  if (!this.verifiedAt) return false;
  return this.verifiedAt <= new Date(date);
};

teacherCredentialSchema.methods.verify = function verify(actor, note = '') {
  if (this.status !== 'submitted') {
    throw new Error(`Only a submitted credential can be verified; this one is ${this.status}`);
  }
  if (String(actor._id) === String(this.teacher)) {
    throw new Error('A member of staff cannot verify their own credential');
  }

  this.status = 'verified';
  this.verifiedBy = actor._id;
  this.verifiedAt = new Date();
  this.verificationNote = note || '';

  return this.recordHistory({
    action: 'verified',
    from: 'submitted',
    to: 'verified',
    note,
    by: actor._id,
    byName: actor.name,
  });
};

teacherCredentialSchema.methods.reject = function reject(actor, reason) {
  if (this.status !== 'submitted') {
    throw new Error(`Only a submitted credential can be rejected; this one is ${this.status}`);
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('A rejection reason is required');
  }

  this.status = 'rejected';
  this.rejectedBy = actor._id;
  this.rejectedAt = new Date();
  this.rejectionReason = String(reason).trim();

  return this.recordHistory({
    action: 'rejected',
    from: 'submitted',
    to: 'rejected',
    note: this.rejectionReason,
    by: actor._id,
    byName: actor.name,
  });
};

/**
 * Submitted in error, by the person who submitted it.
 *
 * Deliberately distinct from `rejected`, which is a decision somebody took
 * about the certificate. Collapsing the two loses who was at fault.
 */
teacherCredentialSchema.methods.withdraw = function withdraw(actor) {
  if (this.status !== 'submitted') {
    throw new Error(`Only a submitted credential can be withdrawn; this one is ${this.status}`);
  }

  this.status = 'withdrawn';
  this.withdrawnAt = new Date();

  return this.recordHistory({
    action: 'withdrawn',
    from: 'submitted',
    to: 'withdrawn',
    by: actor._id,
    byName: actor.name,
  });
};

/**
 * Mark this credential as replaced.
 *
 * Note what is *not* done here: `expiresOn` is not touched, and the document is
 * not deleted. The lapsed certificate keeps its dates, which is the only way
 * "were you covered in March?" stays answerable.
 */
teacherCredentialSchema.methods.markSuperseded = function markSuperseded(replacement, actor) {
  this.status = 'superseded';
  this.supersededBy = replacement._id;
  this.supersededAt = new Date();

  return this.recordHistory({
    action: 'superseded',
    to: 'superseded',
    note: `replaced by ${replacement.reference}`,
    by: actor._id,
    byName: actor.name,
  });
};

/**
 * Everything expiring within `days`, soonest first.
 *
 * The report that stops the inspection finding. Only verified credentials are
 * included, because an unverified one is not cover that can lapse — it is cover
 * the school never had.
 */
teacherCredentialSchema.statics.expiringWithin = function expiringWithin(days, now = new Date()) {
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + Number(days || 60));

  return this.find({
    status: 'verified',
    expiresOn: { $ne: null, $lte: horizon },
  }).sort({ expiresOn: 1 });
};

/**
 * The query in the direction that matters: who may teach this, and are they
 * currently safeguarded?
 *
 * "Show me a teacher's certificates" is the easy question. This is the one a
 * timetable is actually built from.
 */
teacherCredentialSchema.statics.staffEndorsedFor = async function staffEndorsedFor(
  subject,
  { requireKinds = [], now = new Date() } = {}
) {
  const endorsements = await this.find({
    status: 'verified',
    subjects: subject,
    $or: [{ expiresOn: null }, { expiresOn: { $gt: now } }],
  });

  if (!requireKinds.length) {
    return endorsements.map((credential) => ({
      teacher: credential.teacher,
      teacherName: credential.teacherName,
      endorsement: credential,
      missing: [],
    }));
  }

  const teacherIds = endorsements.map((credential) => credential.teacher);

  const supporting = await this.find({
    teacher: { $in: teacherIds },
    kind: { $in: requireKinds },
    status: 'verified',
    $or: [{ expiresOn: null }, { expiresOn: { $gt: now } }],
  });

  const heldByTeacher = new Map();
  supporting.forEach((credential) => {
    const key = String(credential.teacher);
    if (!heldByTeacher.has(key)) heldByTeacher.set(key, new Set());
    heldByTeacher.get(key).add(credential.kind);
  });

  return endorsements.map((credential) => {
    const held = heldByTeacher.get(String(credential.teacher)) || new Set();
    return {
      teacher: credential.teacher,
      teacherName: credential.teacherName,
      endorsement: credential,
      missing: requireKinds.filter((kind) => !held.has(kind)),
    };
  });
};

/**
 * Was this person covered for `kind` on `date`?
 *
 * Walks every credential of that kind, in force or not, and asks each one.
 * Cheaper answers exist; none of them survive a renewal.
 */
teacherCredentialSchema.statics.pointInTimeCompliance = async function pointInTimeCompliance(
  teacherId,
  kind,
  date
) {
  const credentials = await this.find({ teacher: teacherId, kind }).sort({ issuedOn: 1 });

  const covering = credentials.filter((credential) => credential.wasInForceOn(date));

  return {
    covered: covering.length > 0,
    on: new Date(date),

    // The honest second half. A certificate can have been valid on the date
    // while the school had not yet checked it, and an inspection asks about
    // both — so both are reported rather than one standing in for the other.
    verifiedAtTheTime: covering.some((credential) => credential.wasVerifiedBy(date)),

    credentials: covering.map((credential) => ({
      _id: credential._id,
      title: credential.title,
      reference: credential.reference,
      issuedOn: credential.issuedOn,
      expiresOn: credential.expiresOn,
      verifiedAt: credential.verifiedAt,
      verifiedByThatDate: credential.wasVerifiedBy(date),
    })),
  };
};

teacherCredentialSchema.statics.KINDS = KINDS;
teacherCredentialSchema.statics.STATUSES = STATUSES;
teacherCredentialSchema.statics.CURRENT_STATUSES = CURRENT_STATUSES;
teacherCredentialSchema.statics.COMPLIANCE = COMPLIANCE;
teacherCredentialSchema.statics.DEFAULT_WARNING_DAYS = DEFAULT_WARNING_DAYS;

module.exports = mongoose.model('TeacherCredential', teacherCredentialSchema);
