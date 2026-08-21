const mongoose = require('mongoose');

/**
 * The documents an admission application has to be backed by.
 *
 * `Application` takes a name, a date of birth and a grade, and gives the row a
 * status of Pending. All of it is typed by the applicant and none of it is
 * checked against anything — the date of birth in particular, which is the
 * field age-eligibility is decided on and the one most often wrong.
 *
 * Two schemas here. The requirement is the rule: which documents a given grade
 * has to produce, and how stale one is allowed to be. The document is one
 * artefact received against one of those rules.
 *
 * The property the module exists for is that **completeness is never stored**.
 * A checklist that was complete in March is not complete in June once a medical
 * certificate expires, and a boolean written in March cannot know that.
 */

const DOCUMENT_CODES = [
  'birth-certificate',
  'transfer-certificate',
  'mark-sheet',
  'category-certificate',
  'address-proof',
  'medical-record',
  'passport-photo',
  'guardian-id',
  'migration-certificate',
  'other',
];

const FORMATS = ['original', 'attested-copy', 'photocopy', 'digital'];

const DOCUMENT_STATES = ['submitted', 'verified', 'rejected', 'superseded'];

// The six honest answers a checklist row can give. `expired` and `stale` are
// the two a naive present/absent checklist gets wrong every time, because the
// document *is* there.
const CHECKLIST_STATES = ['missing', 'submitted', 'verified', 'rejected', 'expired', 'stale'];

const historyEntrySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: [40, 'History action cannot exceed 40 characters'],
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
      maxlength: [400, 'History note cannot exceed 400 characters'],
      default: '',
    },
  },
  { _id: false }
);

const documentRequirementSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      enum: {
        values: DOCUMENT_CODES,
        message: 'Invalid document code',
      },
      required: [true, 'A document code is required'],
    },

    label: {
      type: String,
      required: [true, 'A label is required'],
      trim: true,
      maxlength: [120, 'Label cannot exceed 120 characters'],
    },

    description: {
      type: String,
      trim: true,
      maxlength: [400, 'Description cannot exceed 400 characters'],
      default: '',
    },

    // Empty means every grade. Held as free text to match `Application.grade`,
    // which is a trimmed string rather than an enumeration.
    appliesToGrades: {
      type: [String],
      default: [],
    },

    isMandatory: {
      type: Boolean,
      default: true,
    },

    requiresIssueDate: {
      type: Boolean,
      default: false,
    },

    // A document older than this is stale even though it is present. Zero
    // means it never goes off.
    maxAgeMonths: {
      type: Number,
      default: 0,
      min: [0, 'Maximum age cannot be negative'],
    },

    requiresExpiryDate: {
      type: Boolean,
      default: false,
    },

    acceptedFormats: {
      type: [String],
      enum: {
        values: FORMATS,
        message: 'Invalid document format',
      },
      default: FORMATS,
    },

    effectiveFrom: {
      type: Date,
      default: Date.now,
    },

    retiredAt: {
      type: Date,
      default: null,
    },

    // Derived from `retiredAt`. A stored boolean because a unique partial index
    // cannot express a negation.
    isActive: {
      type: Boolean,
      default: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'The author of the requirement is required'],
    },

    history: {
      type: [historyEntrySchema],
      default: [],
    },
  },
  { timestamps: true }
);

// One live requirement per code. Retiring keeps the row, so the index has to be
// partial or a re-introduced requirement would collide with the retired one.
documentRequirementSchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);

documentRequirementSchema.pre('save', function () {
  this.isActive = !this.retiredAt;

  if (this.requiresIssueDate === false && this.maxAgeMonths > 0) {
    // A staleness rule with no issue date to measure from is a rule that can
    // never fire, which is worse than no rule at all.
    throw new Error('A maximum age needs an issue date to measure from');
  }

  if (!this.acceptedFormats.length) {
    this.acceptedFormats = FORMATS;
  }
});

documentRequirementSchema.methods.log = function (action, actor, note = '') {
  this.history.push({
    action,
    by: actor ? actor._id : undefined,
    byName: (actor && actor.name) || '',
    at: new Date(),
    note,
  });

  return this;
};

/**
 * Does this requirement apply to a given grade?
 * An empty `appliesToGrades` means every grade, compared case-insensitively
 * because `Application.grade` is free text typed by an applicant.
 */
documentRequirementSchema.methods.appliesTo = function (grade) {
  if (!this.appliesToGrades.length) return true;

  const wanted = String(grade || '').trim().toLowerCase();

  return this.appliesToGrades.some((entry) => String(entry).trim().toLowerCase() === wanted);
};

documentRequirementSchema.statics.CODES = DOCUMENT_CODES;
documentRequirementSchema.statics.FORMATS = FORMATS;

const admissionDocumentSchema = new mongoose.Schema(
  {
    application: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Application',
      required: [true, 'Application is required'],
    },

    requirementCode: {
      type: String,
      enum: {
        values: DOCUMENT_CODES,
        message: 'Invalid document code',
      },
      required: [true, 'A requirement code is required'],
    },

    format: {
      type: String,
      enum: {
        values: FORMATS,
        message: 'Invalid document format',
      },
      required: [true, 'The format received is required'],
    },

    // The file store is out of scope. What is recorded here is that the
    // artefact exists, what it is, and who handled it — which is the part the
    // paper folder currently loses.
    reference: {
      type: String,
      trim: true,
      maxlength: [200, 'Reference cannot exceed 200 characters'],
      default: '',
    },

    issuedOn: {
      type: Date,
      default: null,
    },

    expiresOn: {
      type: Date,
      default: null,
    },

    issuingAuthority: {
      type: String,
      trim: true,
      maxlength: [160, 'Issuing authority cannot exceed 160 characters'],
      default: '',
    },

    state: {
      type: String,
      enum: {
        values: DOCUMENT_STATES,
        message: 'Invalid document state',
      },
      default: 'submitted',
    },

    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'The person receiving the document is required'],
    },

    receivedAt: {
      type: Date,
      default: Date.now,
    },

    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    verifiedAt: {
      type: Date,
      default: null,
    },

    verificationNote: {
      type: String,
      trim: true,
      maxlength: [400, 'Verification note cannot exceed 400 characters'],
      default: '',
    },

    rejectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    rejectedAt: {
      type: Date,
      default: null,
    },

    rejectionReason: {
      type: String,
      trim: true,
      maxlength: [400, 'Rejection reason cannot exceed 400 characters'],
      default: '',
    },

    // A replacement points back at what it replaced, so the record of a
    // rejected certificate and its correction is two rows rather than one
    // overwritten one.
    supersededBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AdmissionDocument',
      default: null,
    },

    isLive: {
      type: Boolean,
      default: true,
    },

    history: {
      type: [historyEntrySchema],
      default: [],
    },
  },
  { timestamps: true }
);

// Exactly one live document per requirement per application. The history stays
// readable because superseded rows drop out of the partial filter.
admissionDocumentSchema.index(
  { application: 1, requirementCode: 1 },
  { unique: true, partialFilterExpression: { isLive: true } }
);

admissionDocumentSchema.index({ application: 1, state: 1 });
admissionDocumentSchema.index({ state: 1, receivedAt: -1 });

admissionDocumentSchema.pre('save', function () {
  this.isLive = this.state !== 'superseded';

  if (this.verifiedBy && this.receivedBy && this.verifiedBy.equals(this.receivedBy)) {
    throw new Error('A document cannot be verified by the person who received it');
  }
  if (this.rejectedBy && this.receivedBy && this.rejectedBy.equals(this.receivedBy)) {
    throw new Error('A document cannot be rejected by the person who received it');
  }

  if (this.expiresOn && this.issuedOn && this.expiresOn <= this.issuedOn) {
    throw new Error('A document cannot expire before it was issued');
  }

  // Once somebody has looked at it and made a call, the details are the
  // details they made that call on. Correcting them means superseding the row.
  if (!this.isNew && this.state !== 'submitted') {
    const frozen = ['issuedOn', 'expiresOn', 'requirementCode', 'format'];
    const edited = frozen.find((field) => this.isModified(field));

    if (edited) {
      throw new Error(`"${edited}" cannot be changed once the document has been assessed`);
    }
  }
});

admissionDocumentSchema.methods.log = function (action, actor, note = '') {
  this.history.push({
    action,
    by: actor ? actor._id : undefined,
    byName: (actor && actor.name) || '',
    at: new Date(),
    note,
  });

  return this;
};

admissionDocumentSchema.methods.verify = function (actor, note = '') {
  if (this.state !== 'submitted') {
    throw new Error(`Only a submitted document can be verified; this one is ${this.state}`);
  }
  if (actor._id.equals(this.receivedBy)) {
    throw new Error('A document cannot be verified by the person who received it');
  }

  this.state = 'verified';
  this.verifiedBy = actor._id;
  this.verifiedAt = new Date();
  this.verificationNote = String(note || '').trim();

  return this.log('verified', actor, note);
};

admissionDocumentSchema.methods.reject = function (actor, reason) {
  if (this.state !== 'submitted') {
    throw new Error(`Only a submitted document can be rejected; this one is ${this.state}`);
  }
  if (actor._id.equals(this.receivedBy)) {
    throw new Error('A document cannot be rejected by the person who received it');
  }
  if (!reason || !String(reason).trim()) {
    // The applicant has to be told what to bring back. "Rejected" on its own
    // sends them to the counter to ask a person.
    throw new Error('A rejection reason is required so the applicant knows what to bring');
  }

  this.state = 'rejected';
  this.rejectedBy = actor._id;
  this.rejectedAt = new Date();
  this.rejectionReason = String(reason).trim();

  return this.log('rejected', actor, this.rejectionReason);
};

/**
 * How this document stands against its requirement, right now.
 *
 * Evaluated rather than stored, and evaluated against the clock at the moment
 * of the call — which is the only way an expiry that passed overnight shows up
 * without anything having to run.
 */
admissionDocumentSchema.methods.assess = function (requirement, now = new Date()) {
  if (this.state === 'rejected') return 'rejected';
  if (this.state === 'superseded') return 'missing';

  if (this.expiresOn && this.expiresOn.getTime() < now.getTime()) return 'expired';

  if (requirement && requirement.maxAgeMonths > 0 && this.issuedOn) {
    const limit = new Date(this.issuedOn.getTime());
    limit.setMonth(limit.getMonth() + requirement.maxAgeMonths);

    if (limit.getTime() < now.getTime()) return 'stale';
  }

  return this.state === 'verified' ? 'verified' : 'submitted';
};

admissionDocumentSchema.statics.STATES = DOCUMENT_STATES;
admissionDocumentSchema.statics.CHECKLIST_STATES = CHECKLIST_STATES;
admissionDocumentSchema.statics.CODES = DOCUMENT_CODES;
admissionDocumentSchema.statics.FORMATS = FORMATS;

const DocumentRequirement = mongoose.model('DocumentRequirement', documentRequirementSchema);
const AdmissionDocument = mongoose.model('AdmissionDocument', admissionDocumentSchema);

module.exports = AdmissionDocument;
module.exports.AdmissionDocument = AdmissionDocument;
module.exports.DocumentRequirement = DocumentRequirement;
