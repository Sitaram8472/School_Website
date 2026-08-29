const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * One record for every person who is on campus and should not be.
 *
 * Visitors coming in and students going out are the same object here, because
 * the question the module exists to answer — *who is on campus right now* —
 * does not care which direction somebody moved. Splitting them would mean
 * writing the atomic check-out twice and having two answers to the only
 * question that matters during an evacuation.
 */

const PASS_TYPES = ['visitor', 'gate-pass'];
const PASS_STATUSES = ['expected', 'checked-in', 'checked-out', 'cancelled', 'auto-closed'];
const APPROVAL_STATUSES = ['not-required', 'pending', 'approved', 'rejected'];
const ID_PROOF_TYPES = ['aadhaar', 'driving-licence', 'passport', 'voter-id', 'employee-id', 'other'];
const VISIT_PURPOSES = [
  'parent-meeting',
  'admission-enquiry',
  'delivery',
  'maintenance',
  'official',
  'event',
  'student-pickup',
  'medical',
  'other',
];

const movementSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: [true, 'Movement action is required'],
      trim: true,
      maxlength: [40, 'Action cannot exceed 40 characters'],
    },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '', trim: true, maxlength: 100 },
    note: { type: String, default: '', trim: true, maxlength: 300 },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const visitorPassSchema = new mongoose.Schema(
  {
    passType: {
      type: String,
      enum: {
        values: PASS_TYPES,
        message: 'Invalid pass type',
      },
      required: [true, 'Pass type is required'],
    },

    badgeNumber: {
      type: String,
      trim: true,
      unique: true,
      maxlength: [30, 'Badge number cannot exceed 30 characters'],
    },

    // ---- Visitor identity (passType: 'visitor') ----
    visitorName: {
      type: String,
      trim: true,
      maxlength: [100, 'Visitor name cannot exceed 100 characters'],
      default: '',
    },

    visitorPhone: {
      type: String,
      trim: true,
      maxlength: [20, 'Phone cannot exceed 20 characters'],
      default: '',
    },

    visitorEmail: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: [120, 'Email cannot exceed 120 characters'],
      default: '',
    },

    organisation: {
      type: String,
      trim: true,
      maxlength: [120, 'Organisation cannot exceed 120 characters'],
      default: '',
    },

    idProofType: {
      type: String,
      enum: {
        values: ID_PROOF_TYPES,
        message: 'Invalid ID proof type',
      },
      default: 'other',
    },

    /**
     * The last four characters of the ID, and nothing else.
     *
     * A gate terminal does not need to retain a database of full government ID
     * numbers, and one that does is a liability the school is carrying for no
     * operational benefit. Four characters is enough for a human at the desk to
     * confirm the card in front of them matches the record.
     */
    idNumberMasked: {
      type: String,
      trim: true,
      maxlength: [12, 'Masked ID cannot exceed 12 characters'],
      default: '',
    },

    /**
     * A keyed hash of whatever identifies this person — the ID number for a
     * visitor, the student id for a gate pass.
     *
     * This is what the "one open pass per person" index is built on. The masked
     * ID cannot carry that job: too many people share a last four. Hashing lets
     * the uniqueness hold without the full number ever being stored.
     */
    subjectKey: {
      type: String,
      trim: true,
      default: null,
      select: false,
    },

    vehicleNumber: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: [20, 'Vehicle number cannot exceed 20 characters'],
      default: '',
    },

    accompanyingCount: {
      type: Number,
      default: 0,
      min: [0, 'Accompanying count cannot be negative'],
      max: [50, 'Fifty accompanying people is a coach party, not a visit'],
    },

    // ---- Host (passType: 'visitor') ----
    host: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    hostName: {
      type: String,
      trim: true,
      maxlength: [100, 'Host name cannot exceed 100 characters'],
      default: '',
    },

    // ---- Student release (passType: 'gate-pass') ----
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    studentName: {
      type: String,
      trim: true,
      maxlength: [100, 'Student name cannot exceed 100 characters'],
      default: '',
    },

    className: {
      type: String,
      trim: true,
      maxlength: [50, 'Class name cannot exceed 50 characters'],
      default: '',
    },

    guardianName: {
      type: String,
      trim: true,
      maxlength: [100, 'Guardian name cannot exceed 100 characters'],
      default: '',
    },

    guardianRelation: {
      type: String,
      trim: true,
      maxlength: [40, 'Relation cannot exceed 40 characters'],
      default: '',
    },

    // ---- The visit ----
    purpose: {
      type: String,
      enum: {
        values: VISIT_PURPOSES,
        message: 'Invalid purpose',
      },
      required: [true, 'A purpose is required'],
    },

    purposeNote: {
      type: String,
      trim: true,
      maxlength: [300, 'Purpose note cannot exceed 300 characters'],
      default: '',
    },

    expectedDurationMinutes: {
      type: Number,
      default: 60,
      min: [5, 'A visit shorter than five minutes is not worth a badge'],
      max: [720, 'A visit longer than twelve hours needs a different arrangement'],
    },

    status: {
      type: String,
      enum: {
        values: PASS_STATUSES,
        message: 'Invalid pass status',
      },
      default: 'expected',
    },

    approvalStatus: {
      type: String,
      enum: {
        values: APPROVAL_STATUSES,
        message: 'Invalid approval status',
      },
      default: 'pending',
    },

    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    approvedByName: { type: String, default: '', trim: true, maxlength: 100 },
    approvedAt: { type: Date, default: null },

    approvalNote: {
      type: String,
      trim: true,
      maxlength: [300, 'Approval note cannot exceed 300 characters'],
      default: '',
    },

    checkInAt: { type: Date, default: null },
    checkOutAt: { type: Date, default: null },

    checkedInBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    checkedOutBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    securityNotes: {
      type: String,
      trim: true,
      maxlength: [500, 'Security notes cannot exceed 500 characters'],
      default: '',
    },

    movements: {
      type: [movementSchema],
      default: [],
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/**
 * The live roll. A partial index means the evacuation list is one indexed
 * lookup rather than a scan of every visit the school has ever had.
 */
visitorPassSchema.index(
  { status: 1, checkInAt: -1 },
  { partialFilterExpression: { status: 'checked-in' } }
);

/**
 * One open pass per person, enforced by the database rather than by every
 * future code path remembering to check.
 *
 * The difference between this and an application-level guard is the difference
 * between an invariant and a habit.
 */
visitorPassSchema.index(
  { subjectKey: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'checked-in', subjectKey: { $type: 'string' } },
  }
);

visitorPassSchema.index({ host: 1, approvalStatus: 1 });
visitorPassSchema.index({ passType: 1, createdAt: -1 });
visitorPassSchema.index({ student: 1, createdAt: -1 });

/**
 * Badge numbers are random rather than sequential.
 *
 * A sequential badge needs a read of the current count before the write, which
 * reintroduces exactly the race the check-in guard exists to avoid. The badge
 * is a label a human reads off a lanyard, not a key.
 */
visitorPassSchema.pre('validate', function () {
  if (!this.badgeNumber) {
    const prefix = this.passType === 'gate-pass' ? 'GP' : 'VP';
    const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, '');
    this.badgeNumber = `${prefix}-${stamp}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  }
});

visitorPassSchema.virtual('isOnCampus').get(function () {
  return this.status === 'checked-in';
});

/**
 * Minutes on site — live for an open pass, final for a closed one.
 */
visitorPassSchema.virtual('durationMinutes').get(function () {
  if (!this.checkInAt) return null;
  const end = this.checkOutAt ? this.checkOutAt.getTime() : Date.now();
  return Math.max(0, Math.round((end - this.checkInAt.getTime()) / 60000));
});

/**
 * Past the expected departure and still open.
 *
 * This is the number the paper register cannot produce, because it has no
 * concept of an expected departure at all.
 */
visitorPassSchema.virtual('isOverstayed').get(function () {
  if (this.status !== 'checked-in' || !this.checkInAt) return false;
  const elapsed = (Date.now() - this.checkInAt.getTime()) / 60000;
  return elapsed > this.expectedDurationMinutes;
});

visitorPassSchema.virtual('minutesOverstayed').get(function () {
  if (this.status !== 'checked-in' || !this.checkInAt) return 0;
  const elapsed = (Date.now() - this.checkInAt.getTime()) / 60000;
  return Math.max(0, Math.round(elapsed - this.expectedDurationMinutes));
});

/**
 * Build the subject key. Never stores the input.
 *
 * Falls back to `JWT_SECRET` when `GATE_SECRET` is unset so the module works
 * out of the box; a school that cares should set its own, because rotating it
 * is what invalidates every historical key.
 */
visitorPassSchema.statics.makeSubjectKey = function (raw) {
  if (!raw) return null;
  const secret = process.env.GATE_SECRET || process.env.JWT_SECRET || 'gate-fallback-secret';
  return crypto
    .createHmac('sha256', secret)
    .update(String(raw).trim().toLowerCase())
    .digest('hex');
};

visitorPassSchema.statics.maskId = function (raw) {
  if (!raw) return '';
  const value = String(raw).trim();
  return value.length <= 4 ? value : `••••${value.slice(-4)}`;
};

/**
 * Why this pass cannot be checked in, or null when it can.
 */
visitorPassSchema.methods.checkInError = function () {
  if (this.status === 'checked-in') return 'This pass is already checked in.';
  if (this.status === 'checked-out') return 'This pass has already been closed.';
  if (this.status === 'cancelled') return 'This pass was cancelled.';
  if (this.status === 'auto-closed') return 'This pass was closed by end-of-day reconciliation.';

  if (this.approvalStatus === 'pending') {
    return this.passType === 'gate-pass'
      ? 'A member of staff has to approve this release before the student leaves.'
      : `${this.hostName || 'The host'} has not approved this visit yet.`;
  }
  if (this.approvalStatus === 'rejected') {
    return `This pass was refused: ${this.approvalNote || 'no reason given'}.`;
  }
  return null;
};

visitorPassSchema.methods.recordMovement = function (action, actor, note = '') {
  this.movements.push({
    action,
    by: actor ? actor._id : null,
    byName: actor ? actor.name || '' : '',
    note,
    at: new Date(),
  });
  return this;
};

/**
 * The shape a given viewer gets.
 *
 * A teacher approving a visit needs to know who is coming and why. They do not
 * need the visitor's ID details or the security log, so they do not get them.
 */
visitorPassSchema.methods.redactFor = function (viewer) {
  const staff = viewer.role === 'admin' || viewer.role === 'staff';
  const base = this.toObject();

  delete base.subjectKey;

  if (!staff) {
    delete base.idNumberMasked;
    delete base.idProofType;
    delete base.securityNotes;
    delete base.movements;
  }

  return base;
};

visitorPassSchema.statics.PASS_TYPES = PASS_TYPES;
visitorPassSchema.statics.PASS_STATUSES = PASS_STATUSES;
visitorPassSchema.statics.APPROVAL_STATUSES = APPROVAL_STATUSES;
visitorPassSchema.statics.ID_PROOF_TYPES = ID_PROOF_TYPES;
visitorPassSchema.statics.VISIT_PURPOSES = VISIT_PURPOSES;

module.exports = mongoose.model('VisitorPass', visitorPassSchema);
