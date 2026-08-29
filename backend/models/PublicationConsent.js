const mongoose = require('mongoose');

/**
 * Whether a child's image or name may appear in a school publication.
 *
 * `Gallery.jsx` renders photographs of children. `Notice` publishes
 * announcements. Nothing anywhere records whether a parent agreed to either, or
 * where anything was published once they did.
 *
 * This is not a missing nice-to-have. Publishing an identifiable image of a
 * child without a recorded permission is the most common data-protection
 * failure a school makes, and the one most likely to end in a complaint the
 * school cannot answer — because answering it needs exactly the record that
 * does not exist.
 *
 * Two properties hold the file together.
 *
 * **Consent is per channel, it expires, and its absence is a refusal.** A
 * parent happy for their child to be in the yearbook has not agreed to a
 * newspaper. A slip signed when a child was six is not permission when they are
 * sixteen. And "nobody said no" is the exact inversion of what consent means,
 * so a gap in the record returns false with a reason rather than defaulting to
 * yes.
 *
 * **Withdrawal is retroactive and it generates work.** Stopping future
 * publication leaves the existing photographs up, which is precisely the thing
 * the parent asked to stop. So withdrawing produces a takedown queue, and the
 * withdrawal is not complete until that queue is empty. The queue is the
 * deliverable; the status change is bookkeeping.
 */

const CHANNELS = [
  'website',
  'social-media',
  'press',
  'prospectus',
  'newsletter',
  'yearbook',
  'internal-display',
];

/**
 * What may be published, in widening order.
 *
 * `image-and-name` is the one that matters: a photograph captioned with a
 * child's full name is a materially different disclosure from either alone, and
 * a school that has consent for a photograph does not thereby have consent to
 * name the child in it.
 */
const SCOPES = ['work', 'image', 'name', 'image-and-name'];

// What each scope actually covers. `image-and-name` covers everything narrower;
// `work` (displaying a piece of the child's work) covers only itself.
const SCOPE_COVERS = {
  work: ['work'],
  image: ['image'],
  name: ['name'],
  'image-and-name': ['image', 'name', 'image-and-name'],
};

const DECISIONS = ['granted', 'withheld'];

const CONSENT_STATUSES = ['active', 'withdrawn', 'expired', 'superseded'];

// A consent in one of these occupies the slot for its student, channel and
// year. Everything else releases it.
const HOLDING_STATUSES = ['active'];

const USAGE_STATUSES = ['live', 'takedown-required', 'removed'];

const RELATIONSHIPS = ['mother', 'father', 'guardian', 'carer', 'other'];

// How long a withdrawal gives the school to take things down. Short on purpose:
// a deadline measured in weeks is a deadline nobody meets.
const TAKEDOWN_DAYS = 7;

const YEAR_PATTERN = /^\d{4}-\d{4}$/;

/**
 * The last day of an academic year written `2026-2027`.
 *
 * Consent expires with the year and is re-taken rather than rolled forward,
 * because a sibling concession outliving the sibling is an inconvenience and a
 * photo consent outliving the child's view of it is not.
 */
const endOfAcademicYear = (academicYear) => {
  if (!YEAR_PATTERN.test(academicYear || '')) return null;
  const endYear = Number(academicYear.split('-')[1]);
  // 31 March, the conventional close of an Indian academic year.
  return new Date(endYear, 2, 31, 23, 59, 59);
};

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

const publicationConsentSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A consent must name the student it is about'],
    },
    studentName: { type: String, trim: true, maxlength: [80, 'Too long'], default: '' },
    className: { type: String, trim: true, maxlength: [40, 'Too long'], default: '' },

    academicYear: {
      type: String,
      required: [true, 'A consent belongs to an academic year'],
      trim: true,
      match: [YEAR_PATTERN, 'Academic year must look like 2026-2027'],
    },

    channel: {
      type: String,
      enum: { values: CHANNELS, message: 'Invalid channel' },
      required: [true, 'A consent must name the channel it covers'],
    },
    scope: {
      type: String,
      enum: { values: SCOPES, message: 'Invalid scope' },
      default: 'image-and-name',
    },

    /**
     * `withheld` is worth recording as explicitly as `granted`. It separates
     * "asked and refused" from "never asked", and those need different
     * follow-up from the office.
     */
    decision: {
      type: String,
      enum: { values: DECISIONS, message: 'Invalid decision' },
      required: [true, 'A consent records a decision'],
    },

    status: {
      type: String,
      enum: { values: CONSENT_STATUSES, message: 'Invalid consent status' },
      default: 'active',
    },

    // "The parent agreed" is not a record. A name, a relationship and a
    // reference to the thing they signed is.
    guardianName: {
      type: String,
      required: [true, 'A consent must name the guardian who gave it'],
      trim: true,
      maxlength: [80, 'Too long'],
    },
    guardianRelationship: {
      type: String,
      enum: { values: RELATIONSHIPS, message: 'Invalid relationship' },
      required: [true, 'A consent must record the relationship'],
    },
    guardianContact: { type: String, trim: true, maxlength: [120, 'Too long'], default: '' },
    evidenceReference: {
      type: String,
      required: [true, 'A consent must reference the thing that was signed'],
      trim: true,
      maxlength: [120, 'Too long'],
    },

    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    recordedByName: { type: String, trim: true, default: '' },
    recordedAt: { type: Date, default: Date.now },

    /**
     * Recorded separately from the guardian's decision, never over it.
     *
     * Older students have a say and increasingly a legal one. Both views stay
     * visible, and the objection wins — which is only expressible if the two are
     * different fields.
     */
    studentObjection: {
      objected: { type: Boolean, default: false },
      notedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      notedByName: { type: String, trim: true, default: '' },
      notedAt: { type: Date, default: null },
      note: { type: String, trim: true, maxlength: [300, 'Too long'], default: '' },
    },

    effectiveFrom: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null },

    withdrawnAt: { type: Date, default: null },
    withdrawnBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    withdrawnByName: { type: String, trim: true, default: '' },
    withdrawalReason: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    supersededBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PublicationConsent',
      default: null,
    },

    /**
     * Derived from `status`. It backs the unique partial index, because a
     * `partialFilterExpression` cannot express a negation.
     */
    isHolding: { type: Boolean, default: true },

    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true }
);

// One live consent per student per channel per academic year.
publicationConsentSchema.index(
  { student: 1, channel: 1, academicYear: 1 },
  { unique: true, partialFilterExpression: { isHolding: true } }
);

publicationConsentSchema.index({ student: 1, status: 1 });
publicationConsentSchema.index({ className: 1, academicYear: 1, channel: 1 });
publicationConsentSchema.index({ status: 1, expiresAt: 1 });

publicationConsentSchema.pre('validate', function deriveExpiry() {
  if (!this.expiresAt && this.academicYear) {
    this.expiresAt = endOfAcademicYear(this.academicYear);
  }
});

publicationConsentSchema.pre('save', function guardConsent() {
  this.isHolding = HOLDING_STATUSES.includes(this.status);

  if (this.expiresAt && this.effectiveFrom && this.expiresAt <= this.effectiveFrom) {
    throw new Error('A consent cannot expire before it starts');
  }

  // Once withdrawn or superseded, what was permitted is a matter of record.
  if (!this.isNew && this.status !== 'active') {
    const frozen = ['student', 'channel', 'scope', 'academicYear', 'decision', 'guardianName'];
    const edited = frozen.find((field) => this.isModified(field));

    if (edited) {
      throw new Error(`"${edited}" cannot be changed once the consent is no longer active`);
    }
  }
});

publicationConsentSchema.methods.log = function log(action, actor, note = '') {
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
 * May this be published, and if not, why not?
 *
 * A reason rather than a boolean, because the office has to be able to tell
 * "the parent said no" from "we never asked" from "it ran out in March" — three
 * situations with three different next steps.
 */
publicationConsentSchema.methods.permits = function permits(scope, when = new Date()) {
  if (this.decision !== 'granted') {
    return { allowed: false, reason: 'The guardian withheld consent for this channel' };
  }
  if (this.status === 'withdrawn') {
    return { allowed: false, reason: 'Consent was withdrawn' };
  }
  if (this.status === 'superseded') {
    return { allowed: false, reason: 'Superseded by a later consent' };
  }
  if (this.status !== 'active') {
    return { allowed: false, reason: `Consent is ${this.status}` };
  }
  if (this.effectiveFrom && this.effectiveFrom > when) {
    return { allowed: false, reason: 'Consent has not started yet' };
  }
  if (this.expiresAt && this.expiresAt <= when) {
    return { allowed: false, reason: 'Consent expired at the end of the academic year' };
  }
  if (this.studentObjection && this.studentObjection.objected) {
    // The guardian's grant stands on the record; it simply does not win.
    return { allowed: false, reason: 'The student has objected' };
  }
  if (scope && !(SCOPE_COVERS[this.scope] || []).includes(scope)) {
    return {
      allowed: false,
      reason: `Consent covers ${this.scope}, which does not cover ${scope}`,
    };
  }

  return { allowed: true, reason: '' };
};

publicationConsentSchema.methods.withdraw = function withdraw(actor, reason) {
  if (this.status !== 'active') {
    throw new Error(`Only an active consent can be withdrawn; this one is ${this.status}`);
  }

  this.status = 'withdrawn';
  this.withdrawnAt = new Date();
  this.withdrawnBy = actor._id;
  this.withdrawnByName = actor.name || '';
  this.withdrawalReason = (reason && String(reason).trim()) || '';

  return this.log('withdrawn', actor, this.withdrawalReason);
};

publicationConsentSchema.methods.supersede = function supersede(actor, replacement) {
  if (this.status !== 'active') {
    throw new Error(`A ${this.status} consent cannot be superseded`);
  }

  this.status = 'superseded';
  this.supersededBy = replacement._id;

  return this.log('superseded', actor);
};

publicationConsentSchema.methods.noteObjection = function noteObjection(actor, objected, note) {
  this.studentObjection = {
    objected: Boolean(objected),
    notedBy: actor._id,
    notedByName: actor.name || '',
    notedAt: new Date(),
    note: (note && String(note).trim()) || '',
  };

  return this.log(objected ? 'student-objected' : 'objection-lifted', actor, this.studentObjection.note);
};

publicationConsentSchema.statics.CHANNELS = CHANNELS;
publicationConsentSchema.statics.SCOPES = SCOPES;
publicationConsentSchema.statics.SCOPE_COVERS = SCOPE_COVERS;
publicationConsentSchema.statics.DECISIONS = DECISIONS;
publicationConsentSchema.statics.CONSENT_STATUSES = CONSENT_STATUSES;
publicationConsentSchema.statics.HOLDING_STATUSES = HOLDING_STATUSES;
publicationConsentSchema.statics.RELATIONSHIPS = RELATIONSHIPS;
publicationConsentSchema.statics.TAKEDOWN_DAYS = TAKEDOWN_DAYS;
publicationConsentSchema.statics.endOfAcademicYear = endOfAcademicYear;

/**
 * One thing that was published, and who is identifiable in it.
 *
 * This is what makes a withdrawal actionable. Without it, withdrawing consent
 * for one child means somebody opening two hundred photographs and trying to
 * remember which ones she is in.
 */
const publicationUsageSchema = new mongoose.Schema(
  {
    assetReference: {
      type: String,
      required: [true, 'A usage must reference what was published'],
      trim: true,
      maxlength: [300, 'Too long'],
    },
    assetLabel: { type: String, trim: true, maxlength: [160, 'Too long'], default: '' },

    channel: {
      type: String,
      enum: { values: CHANNELS, message: 'Invalid channel' },
      required: [true, 'A usage must name the channel it went out on'],
    },
    scope: {
      type: String,
      enum: { values: SCOPES, message: 'Invalid scope' },
      default: 'image',
    },

    students: {
      type: [
        new mongoose.Schema(
          {
            student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
            studentName: { type: String, trim: true, default: '' },
            // The consent that permitted this child's inclusion, captured at
            // publication so the withdrawal can find it later.
            consent: {
              type: mongoose.Schema.Types.ObjectId,
              ref: 'PublicationConsent',
              default: null,
            },
          },
          { _id: false }
        ),
      ],
      validate: {
        validator: (rows) => rows.length > 0,
        message: 'A usage must name at least one student',
      },
    },

    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    publishedByName: { type: String, trim: true, default: '' },
    publishedAt: { type: Date, default: Date.now },

    status: {
      type: String,
      enum: { values: USAGE_STATUSES, message: 'Invalid usage status' },
      default: 'live',
    },

    takedownDueAt: { type: Date, default: null },
    takedownReason: { type: String, trim: true, maxlength: [300, 'Too long'], default: '' },
    takedownFor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    removedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    removedByName: { type: String, trim: true, default: '' },
    removedAt: { type: Date, default: null },
    removalNote: { type: String, trim: true, maxlength: [300, 'Too long'], default: '' },

    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true }
);

publicationUsageSchema.index({ 'students.student': 1, channel: 1, status: 1 });
publicationUsageSchema.index({ status: 1, takedownDueAt: 1 });
publicationUsageSchema.index({ assetReference: 1, channel: 1 });

publicationUsageSchema.methods.log = publicationConsentSchema.methods.log;

publicationUsageSchema.methods.requireTakedown = function requireTakedown(actor, student, reason) {
  if (this.status === 'removed') return this;

  this.status = 'takedown-required';
  this.takedownFor = student;
  this.takedownReason = reason || 'Consent withdrawn';
  this.takedownDueAt = new Date(Date.now() + TAKEDOWN_DAYS * 24 * 60 * 60 * 1000);

  return this.log('takedown-required', actor, this.takedownReason);
};

publicationUsageSchema.methods.markRemoved = function markRemoved(actor, note) {
  if (this.status === 'removed') {
    throw new Error('That item has already been taken down');
  }

  this.status = 'removed';
  this.removedBy = actor._id;
  this.removedByName = actor.name || '';
  this.removedAt = new Date();
  this.removalNote = (note && String(note).trim()) || '';

  return this.log('removed', actor, this.removalNote);
};

publicationUsageSchema.virtual('overdueDays').get(function overdueDays() {
  if (this.status !== 'takedown-required' || !this.takedownDueAt) return 0;
  const days = Math.floor((Date.now() - this.takedownDueAt.getTime()) / (24 * 60 * 60 * 1000));
  return Math.max(0, days);
});

publicationUsageSchema.set('toObject', { virtuals: true });
publicationUsageSchema.set('toJSON', { virtuals: true });

publicationUsageSchema.statics.USAGE_STATUSES = USAGE_STATUSES;

const PublicationConsent = mongoose.model('PublicationConsent', publicationConsentSchema);
const PublicationUsage = mongoose.model('PublicationUsage', publicationUsageSchema);

module.exports = PublicationConsent;
module.exports.PublicationConsent = PublicationConsent;
module.exports.PublicationUsage = PublicationUsage;
