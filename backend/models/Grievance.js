const mongoose = require('mongoose');

const CATEGORIES = [
  'academic',
  'bullying',
  'harassment',
  'infrastructure',
  'transport',
  'hostel',
  'fee',
  'discipline',
  'other',
];

const PRIORITIES = ['low', 'medium', 'high', 'critical'];

const STATUSES = [
  'open',
  'acknowledged',
  'in-progress',
  'escalated',
  'resolved',
  'closed',
  'rejected',
];

// How long the committee has to resolve a ticket, by priority. Derived
// server-side from the priority so a reporter cannot grant themselves a
// four-hour SLA by posting a dueBy.
const SLA_HOURS = {
  critical: 4,
  high: 24,
  medium: 72,
  low: 168,
};

// Categories serious enough that a ticket opens at high priority regardless of
// what the reporter selected. Someone reporting harassment should not have to
// know to tick a box for it to be treated urgently.
const ALWAYS_URGENT_CATEGORIES = ['bullying', 'harassment'];

// Which transitions the lifecycle permits. Kept as data rather than scattered
// `if` statements so a new endpoint cannot bend the lifecycle by accident.
const ALLOWED_TRANSITIONS = {
  open: ['acknowledged', 'in-progress', 'escalated', 'rejected', 'resolved'],
  acknowledged: ['in-progress', 'escalated', 'resolved', 'rejected'],
  'in-progress': ['escalated', 'resolved', 'rejected'],
  escalated: ['in-progress', 'resolved', 'rejected'],
  resolved: ['closed', 'in-progress'],
  closed: [],
  rejected: ['in-progress'],
};

// A reporter may reopen a resolved ticket within this window.
const REOPEN_WINDOW_DAYS = 14;

const grievanceError = (message) => {
  const error = new Error(message);
  error.userFacing = true;
  return error;
};

const commentSchema = new mongoose.Schema(
  {
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    authorName: {
      type: String,
      trim: true,
      default: '',
    },
    body: {
      type: String,
      required: [true, 'A comment cannot be empty'],
      trim: true,
      maxlength: [2000, 'Comment cannot exceed 2000 characters'],
    },
    // Internal notes are filtered out server-side before a reporter sees the
    // ticket. Hiding them in the UI would not be the same thing.
    isInternal: {
      type: Boolean,
      default: false,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const auditEntrySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      trim: true,
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    performedByName: {
      type: String,
      trim: true,
      default: '',
    },
    fromStatus: {
      type: String,
      default: '',
    },
    toStatus: {
      type: String,
      default: '',
    },
    note: {
      type: String,
      trim: true,
      maxlength: [500, 'Audit note cannot exceed 500 characters'],
      default: '',
    },
    at: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const grievanceSchema = new mongoose.Schema(
  {
    // Human-readable and generated server-side. Never accepted from a client.
    ticketId: {
      type: String,
      unique: true,
      trim: true,
      uppercase: true,
    },

    category: {
      type: String,
      enum: {
        values: CATEGORIES,
        message: 'Invalid category',
      },
      required: [true, 'Category is required'],
    },

    subject: {
      type: String,
      required: [true, 'Subject is required'],
      trim: true,
      minlength: [5, 'Subject must be at least 5 characters'],
      maxlength: [200, 'Subject cannot exceed 200 characters'],
    },

    description: {
      type: String,
      required: [true, 'Description is required'],
      trim: true,
      minlength: [20, 'Please describe what happened in at least 20 characters'],
      maxlength: [5000, 'Description cannot exceed 5000 characters'],
    },

    priority: {
      type: String,
      enum: {
        values: PRIORITIES,
        message: 'Invalid priority',
      },
      default: 'medium',
    },

    isAnonymous: {
      type: Boolean,
      default: false,
    },

    // The link is kept even for an anonymous ticket so an admin can act on a
    // credible threat. The design choice is redaction at serialisation time,
    // not deletion — see redactFor() below.
    raisedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Reporter is required'],
    },

    raisedByName: {
      type: String,
      trim: true,
      default: '',
    },

    className: {
      type: String,
      trim: true,
      maxlength: [50, 'Class name cannot exceed 50 characters'],
      default: '',
    },

    status: {
      type: String,
      enum: {
        values: STATUSES,
        message: 'Invalid status',
      },
      default: 'open',
    },

    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    assignedToName: {
      type: String,
      trim: true,
      default: '',
    },

    assignedAt: {
      type: Date,
      default: null,
    },

    // Derived from priority. Never accepted from a body.
    dueBy: {
      type: Date,
      default: null,
    },

    escalationLevel: {
      type: Number,
      default: 0,
      min: [0, 'Escalation level cannot be negative'],
      max: [3, 'Escalation cannot go beyond level 3'],
    },

    escalatedAt: {
      type: Date,
      default: null,
    },

    resolution: {
      type: String,
      trim: true,
      maxlength: [3000, 'Resolution cannot exceed 3000 characters'],
      default: '',
    },

    resolvedAt: {
      type: Date,
      default: null,
    },

    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    satisfactionRating: {
      type: Number,
      default: null,
      min: [1, 'Rating runs from 1 to 5'],
      max: [5, 'Rating runs from 1 to 5'],
    },

    reopenCount: {
      type: Number,
      default: 0,
      min: [0, 'Reopen count cannot be negative'],
    },

    comments: {
      type: [commentSchema],
      default: [],
    },

    auditTrail: {
      type: [auditEntrySchema],
      default: [],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

grievanceSchema.index({ status: 1, dueBy: 1 });
grievanceSchema.index({ category: 1, status: 1 });
grievanceSchema.index({ raisedBy: 1, createdAt: -1 });
grievanceSchema.index({ assignedTo: 1, status: 1 });

grievanceSchema.virtual('ageInHours').get(function () {
  if (!this.createdAt) return 0;
  return Math.round((Date.now() - this.createdAt.getTime()) / (60 * 60 * 1000));
});

grievanceSchema.virtual('isOpen').get(function () {
  return !['resolved', 'closed', 'rejected'].includes(this.status);
});

grievanceSchema.virtual('isOverdue').get(function () {
  if (!this.dueBy) return false;
  if (!this.isOpen) return false;
  return this.dueBy < new Date();
});

grievanceSchema.virtual('slaHoursRemaining').get(function () {
  if (!this.dueBy || !this.isOpen) return null;
  return Math.round((this.dueBy.getTime() - Date.now()) / (60 * 60 * 1000));
});

grievanceSchema.virtual('resolutionHours').get(function () {
  if (!this.resolvedAt || !this.createdAt) return null;
  return Math.round((this.resolvedAt.getTime() - this.createdAt.getTime()) / (60 * 60 * 1000));
});

grievanceSchema.statics.canTransition = function (from, to) {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
};

grievanceSchema.statics.slaHoursFor = function (priority) {
  return SLA_HOURS[priority] ?? SLA_HOURS.medium;
};

/**
 * Generates the next ticket id for the current year. Retried by the controller
 * on a duplicate-key error rather than locked, because two tickets raised in
 * the same millisecond is rare and a retry is cheaper than a lock.
 */
grievanceSchema.statics.nextTicketId = async function (year = new Date().getFullYear()) {
  const prefix = `GRV-${year}-`;

  const latest = await this.findOne({ ticketId: new RegExp(`^${prefix}`) })
    .sort({ ticketId: -1 })
    .select('ticketId')
    .lean();

  const lastNumber = latest ? Number(latest.ticketId.slice(prefix.length)) : 0;
  const next = Number.isFinite(lastNumber) ? lastNumber + 1 : 1;

  return `${prefix}${String(next).padStart(4, '0')}`;
};

grievanceSchema.methods.appendAudit = function (action, actor, extra = {}) {
  this.auditTrail.push({
    action,
    performedBy: actor?.id || actor?._id || null,
    performedByName: actor?.name || '',
    fromStatus: extra.fromStatus || '',
    toStatus: extra.toStatus || '',
    note: extra.note || '',
  });
  this.markModified('auditTrail');
  return this;
};

/**
 * The single transition point. Every status change goes through here so the
 * audit trail cannot be bypassed and an illegal move cannot be made by a new
 * endpoint that forgot to check.
 */
grievanceSchema.methods.moveTo = function (next, actor, note = '') {
  const from = this.status;

  if (from === next) {
    throw grievanceError(`This ticket is already ${next}`);
  }

  if (!(ALLOWED_TRANSITIONS[from] || []).includes(next)) {
    const error = grievanceError(`A ${from} ticket cannot be moved to ${next}`);
    error.statusCode = 409;
    throw error;
  }

  this.status = next;
  this.appendAudit('status-change', actor, { fromStatus: from, toStatus: next, note });

  return this;
};

grievanceSchema.methods.escalate = function (actor, note = '') {
  if (!this.isOpen) {
    throw grievanceError('A closed ticket cannot be escalated');
  }

  if (this.escalationLevel >= 3) {
    throw grievanceError('This ticket is already at the highest escalation level');
  }

  this.escalationLevel += 1;
  this.escalatedAt = new Date();

  if (this.status !== 'escalated') {
    this.moveTo('escalated', actor, note);
  } else {
    this.appendAudit('escalated', actor, { note });
  }

  return this;
};

grievanceSchema.methods.canBeReopenedBy = function (userId) {
  if (String(this.raisedBy) !== String(userId)) return false;
  if (!['resolved', 'closed'].includes(this.status)) return false;
  if (this.status === 'closed') return false;

  if (!this.resolvedAt) return true;

  const windowMs = REOPEN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() - this.resolvedAt.getTime() <= windowMs;
};

/**
 * The one place anonymity is enforced. Every response path calls this, rather
 * than each handler remembering to omit fields — that is the difference between
 * anonymity and "we usually remember to hide it".
 *
 * `viewerRole` of 'admin' still sees the reporter, so a credible threat can be
 * acted on. Internal comments are stripped for the reporter and for anyone who
 * is not handling the ticket.
 */
grievanceSchema.methods.redactFor = function (viewer) {
  const doc = this.toObject({ virtuals: true });
  const viewerId = String(viewer?.id || viewer?._id || '');
  const isAdmin = viewer?.role === 'admin';
  const isHandler = ['teacher', 'staff', 'admin'].includes(viewer?.role);
  const isReporter = String(this.raisedBy) === viewerId;

  if (this.isAnonymous && !isAdmin) {
    doc.raisedBy = null;
    doc.raisedByName = 'Anonymous';
    doc.className = '';
  }

  // Only someone handling the ticket sees internal notes — never the reporter,
  // even though they own the ticket.
  if (!isHandler || isReporter) {
    doc.comments = (doc.comments || []).filter((comment) => !comment.isInternal);
  }

  // The audit trail is an internal record; a reporter sees the status timeline
  // through their own ticket view instead.
  if (!isHandler) {
    doc.auditTrail = undefined;
  }

  return doc;
};

grievanceSchema.pre('validate', async function () {
  // Serious categories are forced up rather than trusting the reporter to pick
  // the right urgency.
  if (this.isNew && ALWAYS_URGENT_CATEGORIES.includes(this.category)) {
    if (this.priority === 'low' || this.priority === 'medium') {
      this.priority = 'high';
    }
  }

  // dueBy is always derived, never taken from the request.
  if (this.isNew || this.isModified('priority')) {
    const hours = SLA_HOURS[this.priority] ?? SLA_HOURS.medium;
    const base = this.createdAt || new Date();
    this.dueBy = new Date(base.getTime() + hours * 60 * 60 * 1000);
  }

  if (this.status === 'resolved' && !this.resolution.trim()) {
    throw grievanceError('A ticket cannot be resolved without a resolution note');
  }

  if (this.satisfactionRating !== null && !['resolved', 'closed'].includes(this.status)) {
    throw grievanceError('A ticket can only be rated once it has been resolved');
  }
});

module.exports = mongoose.model('Grievance', grievanceSchema);
module.exports.CATEGORIES = CATEGORIES;
module.exports.PRIORITIES = PRIORITIES;
module.exports.STATUSES = STATUSES;
module.exports.SLA_HOURS = SLA_HOURS;
module.exports.ALLOWED_TRANSITIONS = ALLOWED_TRANSITIONS;
module.exports.REOPEN_WINDOW_DAYS = REOPEN_WINDOW_DAYS;
module.exports.grievanceError = grievanceError;
