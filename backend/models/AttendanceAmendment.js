const mongoose = require('mongoose');

/**
 * Corrections to a register that has already been taken.
 *
 * `Attendance` is four fields and an array, and `markAttendance` refuses
 * outright if a register already exists for the class and date. That refusal is
 * the right instinct and the wrong outcome: it means the register cannot be
 * corrected at all. There is no update route and no delete route, so a student
 * who arrives fifteen minutes late, or whose medical certificate turns up on
 * Thursday, stays absent permanently — and the attendance percentage that goes
 * on the report card and triggers the intervention letter is wrong with nobody
 * able to fix it.
 *
 * The property this file is built around is that **an amendment applies exactly
 * once, and only if the register still says what the amendment says it says.**
 * Application is a guarded update filtered on the record still holding
 * `originalStatus`. If the register moved underneath, the update matches
 * nothing and the amendment is refused rather than overwriting a value it was
 * not written for.
 *
 * That guard is what stops two amendments raised from two stale views, both
 * approved, both applied, with the second silently reversing the first and
 * nobody informed. It makes the double-apply arithmetically impossible rather
 * than administratively unlikely.
 */

const AMENDMENT_STATUSES = [
  'submitted',
  'approved',
  'applied',
  'rejected',
  'withdrawn',
  'superseded',
];

// An amendment in one of these holds its row. A rejected, withdrawn, applied or
// superseded one releases it so a corrected amendment can be raised.
const HOLDING_STATUSES = ['submitted', 'approved'];

// The register only knows these two. An amendment does not get to invent a
// third, because the thing it writes into is `Attendance.records[].status` and
// widening that enum from here would leave every existing reader guessing.
const MARKS = ['Present', 'Absent'];

/**
 * Why the register is wrong.
 *
 * A closed list, because "Absent" already covers an unexplained absence, an
 * authorised one, a medical one and a mistyped row, and the distinction between
 * those is the entire point of keeping the record.
 *
 * `wrong-student` is separate from `clerical-error` on purpose: it is the one
 * reason that implies a *second* row is also wrong.
 */
const REASON_CODES = [
  'late-arrival',
  'medical',
  'bereavement',
  'authorised-activity',
  'religious-observance',
  'clerical-error',
  'wrong-student',
];

// Reasons that make an absence one the school itself authorised. Kept here so
// the summary can count them without every caller re-deciding.
const AUTHORISED_REASONS = ['medical', 'bereavement', 'authorised-activity', 'religious-observance'];

// Past this, a correction is a different act from a same-day one and needs an
// admin rather than a peer.
const AMENDMENT_WINDOW_DAYS = 14;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const CERTIFICATION_STATUSES = ['certified', 'reopened'];

const monthKeyOf = (dateKey) => (DATE_PATTERN.test(dateKey || '') ? dateKey.slice(0, 7) : '');

const daysSince = (dateKey, now = new Date()) => {
  if (!DATE_PATTERN.test(dateKey || '')) return 0;

  const [year, month, day] = dateKey.split('-').map(Number);
  const from = new Date(year, month - 1, day);
  const to = new Date(now);
  to.setHours(0, 0, 0, 0);

  return Math.max(0, Math.round((to - from) / (24 * 60 * 60 * 1000)));
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

const attendanceAmendmentSchema = new mongoose.Schema(
  {
    attendance: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Attendance',
      required: [true, 'An amendment must name the register it corrects'],
    },
    className: { type: String, trim: true, maxlength: [40, 'Too long'], default: '' },

    date: {
      type: String,
      required: [true, 'An amendment needs the date of the register'],
      match: [DATE_PATTERN, 'Date must be in YYYY-MM-DD format'],
    },
    // Derived from the register date, never from when the correction was asked
    // for. A September register corrected in October belongs to September.
    monthKey: {
      type: String,
      required: true,
      match: [MONTH_PATTERN, 'Month must be in YYYY-MM format'],
    },

    /**
     * The register's own key. `Attendance.records[]` holds a free-text
     * `studentName` and nothing else, so this is the only thing that identifies
     * a row.
     */
    studentName: {
      type: String,
      required: [true, 'An amendment must name the student'],
      trim: true,
      maxlength: [80, 'Too long'],
    },

    /**
     * Resolved where the name resolves to exactly one student, and left null
     * where it does not.
     *
     * Two children called Rahul Sharma are one row in `records[]`, and guessing
     * which of them was absent is worse than admitting the register cannot
     * tell. A null here is a statement, not a gap.
     */
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    studentResolved: { type: Boolean, default: false },
    studentAmbiguous: { type: Boolean, default: false },

    /**
     * Read off the register at request time and never accepted from the body.
     *
     * A client that believes the mark was `Absent` when the register says
     * `Present` is a client working from a stale view, and its amendment is
     * refused on exactly those grounds.
     */
    originalStatus: {
      type: String,
      enum: { values: MARKS, message: 'Invalid original mark' },
      required: true,
    },
    requestedStatus: {
      type: String,
      enum: { values: MARKS, message: 'Invalid requested mark' },
      required: [true, 'An amendment needs the mark it is asking for'],
    },

    reasonCode: {
      type: String,
      enum: { values: REASON_CODES, message: 'Invalid reason code' },
      required: [true, 'An amendment needs a reason'],
    },
    reasonNote: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    evidenceReference: { type: String, trim: true, maxlength: [120, 'Too long'], default: '' },
    evidenceSeenBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    evidenceSeenByName: { type: String, trim: true, default: '' },
    evidenceSeenAt: { type: Date, default: null },

    status: {
      type: String,
      enum: { values: AMENDMENT_STATUSES, message: 'Invalid amendment status' },
      default: 'submitted',
    },

    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'An amendment must name who asked for it'],
    },
    requestedByName: { type: String, trim: true, default: '' },
    requestedByRole: { type: String, trim: true, default: '' },
    submittedAt: { type: Date, default: Date.now },

    // Derived from the register date at request time and frozen, so the record
    // says how late the correction was, not how late it looks today.
    daysLate: { type: Number, default: 0, min: 0 },
    lateRequest: { type: Boolean, default: false },

    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedByName: { type: String, trim: true, default: '' },
    approvedAt: { type: Date, default: null },

    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    withdrawnAt: { type: Date, default: null },

    appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    appliedAt: { type: Date, default: null },

    // Set on the older amendment when a newer one is approved over it, so the
    // two truths never sit side by side unlabelled.
    supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AttendanceAmendment', default: null },

    /**
     * Derived from `status`. It backs the unique partial index, because a
     * `partialFilterExpression` cannot express a negation and a rejected
     * amendment has to release the row.
     */
    isHolding: { type: Boolean, default: true },

    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true }
);

// One live amendment per row of one register.
attendanceAmendmentSchema.index(
  { attendance: 1, studentName: 1 },
  { unique: true, partialFilterExpression: { isHolding: true } }
);

attendanceAmendmentSchema.index({ status: 1, submittedAt: 1 });
attendanceAmendmentSchema.index({ className: 1, monthKey: 1, status: 1 });
attendanceAmendmentSchema.index({ student: 1, status: 1 });
attendanceAmendmentSchema.index({ requestedBy: 1, submittedAt: -1 });

attendanceAmendmentSchema.pre('validate', function deriveMonth() {
  if (!this.monthKey && this.date) this.monthKey = monthKeyOf(this.date);

  if (this.monthKey && this.date && monthKeyOf(this.date) !== this.monthKey) {
    this.invalidate('monthKey', 'The month must be the month of the register');
  }
});

attendanceAmendmentSchema.pre('save', function guardAmendment() {
  this.isHolding = HOLDING_STATUSES.includes(this.status);

  if (this.originalStatus === this.requestedStatus) {
    throw new Error('An amendment must change the mark it is correcting');
  }

  if (this.approvedBy && this.requestedBy && this.approvedBy.equals(this.requestedBy)) {
    throw new Error('An amendment cannot be approved by the person who asked for it');
  }

  if (this.rejectedBy && this.requestedBy && this.rejectedBy.equals(this.requestedBy)) {
    throw new Error('An amendment cannot be rejected by the person who asked for it');
  }

  // Once decided, the facts it was decided on are fixed.
  if (!this.isNew && this.status !== 'submitted') {
    const frozen = [
      'attendance',
      'studentName',
      'originalStatus',
      'requestedStatus',
      'date',
      'monthKey',
      'reasonCode',
    ];
    const edited = frozen.find((field) => this.isModified(field));

    if (edited) {
      throw new Error(`"${edited}" cannot be changed once the amendment has been decided`);
    }
  }
});

attendanceAmendmentSchema.methods.log = function log(action, actor, note = '') {
  this.history.push({
    action,
    by: actor ? actor._id : undefined,
    byName: (actor && actor.name) || '',
    at: new Date(),
    note,
  });

  return this;
};

attendanceAmendmentSchema.methods.recordEvidence = function recordEvidence(actor, reference) {
  if (this.status !== 'submitted') {
    throw new Error('Evidence can only be recorded while the amendment is still open');
  }
  if (!reference || !String(reference).trim()) {
    throw new Error('An evidence reference is required');
  }

  this.evidenceReference = String(reference).trim();
  this.evidenceSeenBy = actor._id;
  this.evidenceSeenByName = actor.name || '';
  this.evidenceSeenAt = new Date();

  return this.log('evidence-recorded', actor, this.evidenceReference);
};

attendanceAmendmentSchema.methods.approve = function approve(actor) {
  if (this.status !== 'submitted') {
    throw new Error(`Only a submitted amendment can be approved; this one is ${this.status}`);
  }
  if (actor._id.equals(this.requestedBy)) {
    throw new Error('An amendment cannot be approved by the person who asked for it');
  }

  /**
   * A late correction needs an admin rather than a peer. Two weeks after the
   * register was taken, nobody in the room remembers the lesson, and the
   * decision stops being a colleague confirming what they saw.
   */
  if (this.lateRequest && actor.role !== 'admin') {
    throw new Error(
      `This register is ${this.daysLate} days old; a correction past ${AMENDMENT_WINDOW_DAYS} days needs an administrator`
    );
  }

  this.status = 'approved';
  this.approvedBy = actor._id;
  this.approvedByName = actor.name || '';
  this.approvedAt = new Date();

  return this.log('approved', actor);
};

attendanceAmendmentSchema.methods.reject = function reject(actor, reason) {
  if (!['submitted', 'approved'].includes(this.status)) {
    throw new Error(`A ${this.status} amendment cannot be rejected`);
  }
  if (actor._id.equals(this.requestedBy)) {
    throw new Error('An amendment cannot be rejected by the person who asked for it');
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('A rejection reason is required');
  }

  this.status = 'rejected';
  this.rejectedBy = actor._id;
  this.rejectedAt = new Date();
  this.rejectionReason = String(reason).trim();

  return this.log('rejected', actor, this.rejectionReason);
};

attendanceAmendmentSchema.methods.withdraw = function withdraw(actor) {
  if (this.status !== 'submitted') {
    throw new Error(`Only a submitted amendment can be withdrawn; this one is ${this.status}`);
  }
  if (!actor._id.equals(this.requestedBy) && actor.role !== 'admin') {
    throw new Error('Only the person who asked, or an administrator, may withdraw an amendment');
  }

  this.status = 'withdrawn';
  this.withdrawnAt = new Date();

  return this.log('withdrawn', actor);
};

attendanceAmendmentSchema.methods.markApplied = function markApplied(actor) {
  this.status = 'applied';
  this.appliedBy = actor._id;
  this.appliedAt = new Date();

  return this.log('applied', actor, `${this.originalStatus} to ${this.requestedStatus}`);
};

/**
 * Close an amendment out without deciding it.
 *
 * Used when a month is certified over the top of amendments still open. They
 * are not rejected — nobody judged them — and they are not left open, because
 * an amendment that can never be applied is a queue item that never clears.
 * `superseded` says exactly what happened: the register moved on without them.
 */
attendanceAmendmentSchema.methods.supersede = function supersede(actor, note = '', replacement = null) {
  if (!HOLDING_STATUSES.includes(this.status)) {
    throw new Error(`A ${this.status} amendment cannot be superseded`);
  }

  this.status = 'superseded';
  if (replacement) this.supersededBy = replacement._id;

  return this.log('superseded', actor, note);
};

/**
 * The percentage, computed from the registers rather than stored anywhere.
 *
 * There is no counter to drift, so an applied amendment moves the number for
 * free — which is the entire reason the amendment exists.
 */
attendanceAmendmentSchema.statics.percentageFor = function percentageFor(registers, studentName) {
  const wanted = String(studentName || '').trim().toLowerCase();

  let sessions = 0;
  let present = 0;

  registers.forEach((register) => {
    register.records.forEach((record) => {
      if (String(record.studentName || '').trim().toLowerCase() !== wanted) return;
      sessions += 1;
      if (record.status === 'Present') present += 1;
    });
  });

  return {
    sessions,
    present,
    absent: sessions - present,
    // A student with no recorded sessions has no percentage. Reporting 0 is how
    // a data-entry gap becomes an intervention letter.
    percent: sessions ? Math.round((present / sessions) * 1000) / 10 : null,
  };
};

attendanceAmendmentSchema.statics.AMENDMENT_STATUSES = AMENDMENT_STATUSES;
attendanceAmendmentSchema.statics.HOLDING_STATUSES = HOLDING_STATUSES;
attendanceAmendmentSchema.statics.MARKS = MARKS;
attendanceAmendmentSchema.statics.REASON_CODES = REASON_CODES;
attendanceAmendmentSchema.statics.AUTHORISED_REASONS = AUTHORISED_REASONS;
attendanceAmendmentSchema.statics.AMENDMENT_WINDOW_DAYS = AMENDMENT_WINDOW_DAYS;
attendanceAmendmentSchema.statics.monthKeyOf = monthKeyOf;
attendanceAmendmentSchema.statics.daysSince = daysSince;

/**
 * One class-month, signed off.
 *
 * Certification seals the month against further amendment and stores the counts
 * it certified, so the figure that was reported stays recoverable after the
 * fact. Reopening is deliberately possible and deliberately logged: a month
 * that can never be reopened produces a second, unofficial register.
 */
const registerCertificationSchema = new mongoose.Schema(
  {
    className: {
      type: String,
      required: [true, 'A certification needs a class'],
      trim: true,
      maxlength: [40, 'Too long'],
    },
    monthKey: {
      type: String,
      required: [true, 'A certification needs a month'],
      match: [MONTH_PATTERN, 'Month must be in YYYY-MM format'],
    },

    status: {
      type: String,
      enum: { values: CERTIFICATION_STATUSES, message: 'Invalid certification status' },
      default: 'certified',
    },

    sessionCount: { type: Number, default: 0, min: 0 },
    recordCount: { type: Number, default: 0, min: 0 },
    presentCount: { type: Number, default: 0, min: 0 },
    absentCount: { type: Number, default: 0, min: 0 },
    percent: { type: Number, default: 0, min: 0, max: 100 },

    certifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    certifiedByName: { type: String, trim: true, default: '' },
    certifiedAt: { type: Date, default: Date.now },

    reopenedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reopenedAt: { type: Date, default: null },
    reopenReason: { type: String, trim: true, maxlength: [500, 'Too long'], default: '' },

    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true }
);

registerCertificationSchema.index({ className: 1, monthKey: 1 }, { unique: true });

registerCertificationSchema.methods.log = attendanceAmendmentSchema.methods.log;

registerCertificationSchema.methods.reopen = function reopen(actor, reason) {
  if (this.status !== 'certified') {
    throw new Error('That month is not certified');
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('Reopening a certified month needs a reason');
  }

  this.status = 'reopened';
  this.reopenedBy = actor._id;
  this.reopenedAt = new Date();
  this.reopenReason = String(reason).trim();

  return this.log('reopened', actor, this.reopenReason);
};

registerCertificationSchema.statics.CERTIFICATION_STATUSES = CERTIFICATION_STATUSES;

const AttendanceAmendment = mongoose.model('AttendanceAmendment', attendanceAmendmentSchema);
const RegisterCertification = mongoose.model('RegisterCertification', registerCertificationSchema);

module.exports = AttendanceAmendment;
module.exports.AttendanceAmendment = AttendanceAmendment;
module.exports.RegisterCertification = RegisterCertification;
