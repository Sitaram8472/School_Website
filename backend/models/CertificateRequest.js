const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * Requests for official school documents — bonafide, character, transfer — and
 * the issued certificate that comes out the other end.
 *
 * The half of this that matters is issuance. A certificate that cannot be
 * checked by the party relying on it is decoration, so an issued document
 * carries a serial and a verification code, and there is a public endpoint
 * that will confirm both.
 */

const TYPES = [
  'bonafide',
  'character',
  'transfer',
  'migration',
  'study',
  'conduct',
  'fee-receipt',
  'mark-sheet',
];

/**
 * Per-type issuance settings.
 *
 * `code` is the middle segment of the serial. `validityMonths` is how long the
 * document is good for — a bonafide certificate for a passport application is
 * stale after six months, whereas a transfer certificate is a statement about
 * a past event and does not expire at all.
 */
const TYPE_CATALOGUE = {
  bonafide: { code: 'BON', label: 'Bonafide certificate', validityMonths: 6 },
  character: { code: 'CHR', label: 'Character certificate', validityMonths: 12 },
  transfer: { code: 'TCR', label: 'Transfer certificate', validityMonths: null },
  migration: { code: 'MIG', label: 'Migration certificate', validityMonths: null },
  study: { code: 'STD', label: 'Study certificate', validityMonths: 12 },
  conduct: { code: 'CND', label: 'Conduct certificate', validityMonths: 12 },
  'fee-receipt': { code: 'FEE', label: 'Fee receipt', validityMonths: null },
  'mark-sheet': { code: 'MRK', label: 'Mark sheet', validityMonths: null },
};

const STATUSES = [
  'submitted',
  'under-review',
  'info-required',
  'approved',
  'issued',
  'collected',
  'rejected',
  'cancelled',
  'revoked',
];

// The lifecycle, as a table. Anything not listed is a 409 — a new endpoint
// cannot invent a shortcut.
const TRANSITIONS = {
  submitted: ['under-review', 'info-required', 'rejected', 'cancelled'],
  'under-review': ['info-required', 'approved', 'rejected'],
  'info-required': ['under-review', 'rejected', 'cancelled'],
  approved: ['issued', 'rejected'],
  issued: ['collected', 'revoked'],
  collected: ['revoked'],
  rejected: [],
  cancelled: [],
  revoked: [],
};

const DELIVERY_MODES = ['collect', 'email', 'post'];

/**
 * Atomic sequence allotment.
 *
 * A serial number read as `count + 1` is a race: two clerks issuing at the
 * same moment both read the same count and both write the same serial, and
 * the unique index then rejects one of them *after* the certificate has
 * notionally been issued. `findOneAndUpdate` with `$inc` and `upsert` is one
 * operation, so the number is handed out exactly once.
 *
 * The counter is per key — `REQ-2026`, `SER-BON-2026` — so each year and each
 * certificate type numbers from 1, which is what the office expects.
 */
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

const Counter =
  mongoose.models.CertificateCounter ||
  mongoose.model('CertificateCounter', counterSchema);

async function nextSequence(key) {
  const counter = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );
  return counter.seq;
}

/**
 * 128 bits from the CSPRNG, base64url so it survives being pasted into a
 * browser bar or read down a phone.
 *
 * Deliberately not derived from the request id, the student name or a counter:
 * a verification code that can be guessed from a serial turns the endpoint
 * into a way to enumerate the student body.
 */
function makeVerificationCode() {
  return crypto.randomBytes(16).toString('base64url');
}

const remarkSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    authorName: { type: String, trim: true },
    body: {
      type: String,
      required: [true, 'A remark cannot be empty'],
      trim: true,
      minlength: [2, 'A remark must say something'],
      maxlength: [1000, 'A remark cannot exceed 1000 characters'],
    },
    // Internal remarks are filtered out server-side before the document is
    // serialised for the requester — not hidden with CSS, not omitted by the
    // client.
    isInternal: { type: Boolean, default: false },
    at: { type: Date, default: Date.now },
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

const certificateRequestSchema = new mongoose.Schema(
  {
    requestNumber: {
      type: String,
      unique: true,
      index: true,
    },
    type: {
      type: String,
      enum: {
        values: TYPES,
        message: 'Unknown certificate type',
      },
      required: [true, 'Certificate type is required'],
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    studentName: {
      type: String,
      required: [true, 'Student name is required'],
      trim: true,
      maxlength: [80, 'Student name cannot exceed 80 characters'],
    },
    className: {
      type: String,
      trim: true,
      maxlength: [30, 'Class name cannot exceed 30 characters'],
    },
    rollNumber: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: [20, 'Roll number cannot exceed 20 characters'],
    },
    // Required because "bonafide certificate" on its own is not enough
    // information to write one.
    purpose: {
      type: String,
      required: [true, 'Please say what the certificate is needed for'],
      trim: true,
      minlength: [10, 'Purpose must be at least 10 characters'],
      maxlength: [300, 'Purpose cannot exceed 300 characters'],
    },
    copies: {
      type: Number,
      default: 1,
      min: [1, 'At least one copy is required'],
      max: [5, 'At most five copies can be requested at once'],
    },
    deliveryMode: {
      type: String,
      enum: DELIVERY_MODES,
      default: 'collect',
    },
    postalAddress: {
      type: String,
      trim: true,
      maxlength: [400, 'Postal address cannot exceed 400 characters'],
      default: null,
    },
    status: {
      type: String,
      enum: STATUSES,
      default: 'submitted',
      index: true,
    },

    // --- Issuance. All of this is null until the `issued` transition. -------
    serialNumber: {
      type: String,
      default: null,
      unique: true,
      sparse: true,
    },
    verificationCode: {
      type: String,
      default: null,
      unique: true,
      sparse: true,
      index: true,
    },
    issuedAt: { type: Date, default: null },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    issuedByName: { type: String, trim: true, default: null },
    validUntil: { type: Date, default: null },
    collectedAt: { type: Date, default: null },

    // --- Refusal and revocation --------------------------------------------
    rejectionReason: { type: String, trim: true, maxlength: 300, default: null },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    revocationReason: { type: String, trim: true, maxlength: 300, default: null },

    remarks: { type: [remarkSchema], default: [] },
    auditTrail: { type: [auditSchema], default: [] },
  },
  { timestamps: true }
);

certificateRequestSchema.index({ status: 1, createdAt: -1 });
certificateRequestSchema.index({ requestedBy: 1, createdAt: -1 });

/**
 * Mongoose 9 has dropped callback-style middleware — a hook written
 * `pre('validate', function (next) {...})` is silently skipped, and this one
 * is what enforces the postal address rule.
 */
certificateRequestSchema.pre('validate', async function derive() {
  if (this.deliveryMode === 'post' && !(this.postalAddress || '').trim()) {
    this.invalidate(
      'postalAddress',
      'A postal address is required when the certificate is to be posted'
    );
  }
  if (this.deliveryMode !== 'post') {
    this.postalAddress = null;
  }
});

certificateRequestSchema.virtual('typeLabel').get(function typeLabel() {
  return (TYPE_CATALOGUE[this.type] || {}).label || this.type;
});

certificateRequestSchema.virtual('isIssued').get(function isIssued() {
  return ['issued', 'collected'].includes(this.status);
});

certificateRequestSchema.virtual('isExpired').get(function isExpired() {
  if (!this.validUntil) return false;
  return this.validUntil.getTime() < Date.now();
});

/**
 * Whether the document, as it stands, is something a third party should rely
 * on. Revoked and expired both mean no.
 */
certificateRequestSchema.virtual('isCurrentlyValid').get(function isCurrentlyValid() {
  if (!['issued', 'collected'].includes(this.status)) return false;
  if (this.revokedAt) return false;
  if (this.validUntil && this.validUntil.getTime() < Date.now()) return false;
  return true;
});

certificateRequestSchema.methods.canTransition = function canTransition(to) {
  return (TRANSITIONS[this.status] || []).includes(to);
};

/**
 * The single place status changes. Every move is recorded here, so the audit
 * trail cannot be bypassed by a handler that assigns `status` directly.
 */
certificateRequestSchema.methods.moveTo = function moveTo(to, actor, detail = null) {
  if (!this.canTransition(to)) {
    const error = new Error(`A ${this.status} request cannot become ${to}.`);
    error.code = 'ILLEGAL_TRANSITION';
    throw error;
  }
  const from = this.status;
  this.status = to;
  this.recordAudit(`status:${from}->${to}`, actor, detail, from, to);
  return this;
};

certificateRequestSchema.methods.recordAudit = function recordAudit(
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

/**
 * Allots the serial and the verification code, once.
 *
 * Both are handed out here and nowhere else, which is what makes "a request
 * that is never issued never has one" true by construction rather than by
 * every handler remembering.
 */
certificateRequestSchema.methods.allotIssuance = async function allotIssuance(actor) {
  if (this.serialNumber) {
    const error = new Error('This certificate has already been issued.');
    error.code = 'ALREADY_ISSUED';
    throw error;
  }

  const entry = TYPE_CATALOGUE[this.type];
  const year = new Date().getFullYear();
  const seq = await nextSequence(`SER-${entry.code}-${year}`);

  this.serialNumber = `EDU/${entry.code}/${year}/${String(seq).padStart(4, '0')}`;
  this.verificationCode = makeVerificationCode();
  this.issuedAt = new Date();
  this.issuedBy = actor && (actor._id || actor.id);
  this.issuedByName = actor && actor.name;

  if (entry.validityMonths) {
    const until = new Date(this.issuedAt);
    until.setMonth(until.getMonth() + entry.validityMonths);
    this.validUntil = until;
  } else {
    this.validUntil = null;
  }

  return this;
};

/**
 * The payload the public verification endpoint returns.
 *
 * Deliberately thin: enough for an admissions clerk to confirm the document in
 * their hand is genuine, and nothing that turns a leaked serial into a way to
 * learn why a student asked for it or what the office said about them.
 */
certificateRequestSchema.methods.toVerificationPayload = function toVerificationPayload() {
  return {
    valid: this.isCurrentlyValid,
    serialNumber: this.serialNumber,
    certificateType: this.typeLabel,
    studentName: this.studentName,
    className: this.className || null,
    issuedOn: this.issuedAt,
    validUntil: this.validUntil,
    status: this.revokedAt ? 'revoked' : this.isExpired ? 'expired' : 'valid',
    revokedOn: this.revokedAt || null,
  };
};

/**
 * Serialises for a viewer. Office staff see everything; the requester sees
 * their request without the internal remarks or the audit trail.
 */
certificateRequestSchema.methods.redactFor = function redactFor(viewer) {
  const plain = this.toObject({ virtuals: true });
  delete plain.__v;

  const isStaff = viewer && ['teacher', 'staff', 'admin'].includes(viewer.role);
  if (isStaff) return plain;

  plain.remarks = (plain.remarks || []).filter((remark) => !remark.isInternal);
  plain.auditTrail = [];
  return plain;
};

certificateRequestSchema.statics.nextRequestNumber = async function nextRequestNumber() {
  const year = new Date().getFullYear();
  const seq = await nextSequence(`REQ-${year}`);
  return `REQ-${year}-${String(seq).padStart(4, '0')}`;
};

certificateRequestSchema.statics.TYPES = TYPES;
certificateRequestSchema.statics.STATUSES = STATUSES;
certificateRequestSchema.statics.TRANSITIONS = TRANSITIONS;
certificateRequestSchema.statics.TYPE_CATALOGUE = TYPE_CATALOGUE;
certificateRequestSchema.statics.DELIVERY_MODES = DELIVERY_MODES;
certificateRequestSchema.statics.makeVerificationCode = makeVerificationCode;
certificateRequestSchema.statics.Counter = Counter;

certificateRequestSchema.set('toObject', { virtuals: true });
certificateRequestSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('CertificateRequest', certificateRequestSchema);
