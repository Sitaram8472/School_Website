const mongoose = require('mongoose');

/**
 * Who is entitled to re-mark a paper for a course.
 *
 * `assignReviewer` will currently hand a re-mark to any user id an admin
 * sends. The only check is `RemarkAppeal.reviewerEligibilityError`, which is
 * two rules — not the student, not the original marker — and both are right.
 * They are also the only rules there are, so nothing stops a Physics re-mark
 * being assigned to whoever happens to be free, and the check runs against a
 * bare `{ _id: reviewerId }` literal rather than a loaded user, so a
 * well-formed id belonging to nobody is assigned successfully.
 *
 * A panel is the missing half: the list of people who may take this course's
 * appeals at all. Recusal stays where it is; membership is what this adds.
 */

const PANEL_STATUSES = ['draft', 'active', 'retired'];

// A panel in one of these states governs its course. Retiring releases it, so
// a replacement panel can be created without deleting the record of the old.
const LIVE_STATUSES = ['draft', 'active'];

const SEATS = ['chair', 'member'];

// The roles a panel member may hold. A student cannot review, and neither can
// an account with no teaching or administrative standing.
const ELIGIBLE_ROLES = ['teacher', 'staff', 'admin'];

const DEFAULT_MIN_REVIEWERS = 2;
const MAX_MEMBERS = 25;

const historyEntrySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: [40, 'History action cannot exceed 40 characters'],
    },
    subject: {
      type: String,
      trim: true,
      maxlength: [100, 'History subject cannot exceed 100 characters'],
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

/**
 * One person's place on the panel.
 *
 * Removal is a flag rather than a splice. A panel that quietly loses a row
 * cannot answer "who was entitled to review this in March", which is the
 * question asked when a decision from March is challenged.
 */
const memberSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A panel member needs a user'],
    },
    name: {
      type: String,
      trim: true,
      maxlength: [100, 'Member name cannot exceed 100 characters'],
      default: '',
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: [120, 'Member email cannot exceed 120 characters'],
      default: '',
    },
    seat: {
      type: String,
      enum: {
        values: SEATS,
        message: 'Invalid panel seat',
      },
      default: 'member',
    },
    active: {
      type: Boolean,
      default: true,
    },
    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    addedAt: {
      type: Date,
      default: Date.now,
    },
    removedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    removedAt: {
      type: Date,
    },
    removalReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Removal reason cannot exceed 300 characters'],
      default: '',
    },
  },
  { _id: false }
);

const appealPanelSchema = new mongoose.Schema(
  {
    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: [true, 'The course this panel covers is required'],
    },

    // Denormalised the way the appeals module already denormalises, so a list
    // of panels renders without a join per row.
    courseName: {
      type: String,
      trim: true,
      maxlength: [120, 'Course name cannot exceed 120 characters'],
      default: '',
    },

    name: {
      type: String,
      required: [true, 'A panel name is required'],
      trim: true,
      maxlength: [120, 'Panel name cannot exceed 120 characters'],
    },

    academicYear: {
      type: String,
      trim: true,
      maxlength: [20, 'Academic year cannot exceed 20 characters'],
      default: '',
    },

    members: {
      type: [memberSchema],
      default: [],
      validate: {
        validator: (members) => members.length <= MAX_MEMBERS,
        message: `A panel cannot hold more than ${MAX_MEMBERS} members`,
      },
    },

    /**
     * The floor an active panel must keep. Two is the default because a panel
     * of one is a person, and a person who is recused leaves nobody.
     */
    minReviewers: {
      type: Number,
      default: DEFAULT_MIN_REVIEWERS,
      min: [1, 'A panel needs at least one reviewer'],
      max: [10, 'A floor above 10 reviewers is not a floor'],
    },

    status: {
      type: String,
      enum: {
        values: PANEL_STATUSES,
        message: 'Invalid panel status',
      },
      default: 'draft',
    },

    /**
     * Derived from `status` in `pre('save')`. MongoDB refuses `$ne` inside a
     * `partialFilterExpression`, so "one panel per course that is not retired"
     * has to be expressed as an equality on a flag.
     */
    isLive: {
      type: Boolean,
      default: true,
    },

    notes: {
      type: String,
      trim: true,
      maxlength: [1000, 'Notes cannot exceed 1000 characters'],
      default: '',
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    activatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    activatedAt: {
      type: Date,
    },

    retiredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    retiredAt: {
      type: Date,
    },

    retirementReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Retirement reason cannot exceed 300 characters'],
      default: '',
    },

    history: {
      type: [historyEntrySchema],
      default: [],
    },
  },
  { timestamps: true }
);

// One live panel per course. Two admins setting up a department cannot each
// end up with their own roster for the same subject.
appealPanelSchema.index(
  { course: 1 },
  { unique: true, partialFilterExpression: { isLive: true } }
);

appealPanelSchema.index({ status: 1, createdAt: -1 });
appealPanelSchema.index({ 'members.user': 1, isLive: 1 });

appealPanelSchema.virtual('activeMembers').get(function activeMembers() {
  return this.members.filter((member) => member.active);
});

appealPanelSchema.virtual('chairs').get(function chairs() {
  return this.members.filter((member) => member.active && member.seat === 'chair');
});

appealPanelSchema.set('toJSON', { virtuals: true });
appealPanelSchema.set('toObject', { virtuals: true });

appealPanelSchema.methods.findMember = function findMember(userId) {
  return this.members.find((member) => String(member.user) === String(userId));
};

appealPanelSchema.methods.isActiveMember = function isActiveMember(userId) {
  const member = this.findMember(userId);
  return !!(member && member.active);
};

appealPanelSchema.methods.log = function log(action, actor, note = '', subject = '') {
  this.history.push({
    action,
    subject,
    by: actor ? actor._id : undefined,
    byName: (actor && actor.name) || '',
    at: new Date(),
    note,
  });

  return this;
};

/**
 * Add somebody, or bring back somebody who was removed.
 *
 * Reactivation reuses the existing row on purpose. A fresh entry would paper
 * over the removal, and the removal is the part somebody will later want to
 * read.
 *
 * `candidate` is a loaded user document, not an id — the role check is the
 * whole reason this exists, and it cannot be made against a bare id.
 */
appealPanelSchema.methods.addMember = function addMember(candidate, actor, seat = 'member') {
  if (!candidate || !candidate._id) {
    throw new Error('That user does not exist');
  }
  if (!ELIGIBLE_ROLES.includes(candidate.role)) {
    throw new Error(
      `${candidate.name || 'That user'} is a ${candidate.role} and cannot review appeals`
    );
  }
  if (!SEATS.includes(seat)) {
    throw new Error(`"${seat}" is not a panel seat`);
  }

  const existing = this.findMember(candidate._id);

  if (existing && existing.active) {
    throw new Error(`${candidate.name || 'That user'} is already on this panel`);
  }

  if (existing) {
    existing.active = true;
    existing.seat = seat;
    existing.addedBy = actor ? actor._id : undefined;
    existing.addedAt = new Date();
    existing.removedBy = undefined;
    existing.removedAt = undefined;
    existing.removalReason = '';

    return this.log('member restored', actor, '', candidate.name || '');
  }

  if (this.members.length >= MAX_MEMBERS) {
    throw new Error(`A panel cannot hold more than ${MAX_MEMBERS} members`);
  }

  this.members.push({
    user: candidate._id,
    name: candidate.name || '',
    email: candidate.email || '',
    seat,
    active: true,
    addedBy: actor ? actor._id : undefined,
    addedAt: new Date(),
  });

  return this.log('member added', actor, seat, candidate.name || '');
};

/**
 * Take somebody off, refusing the removal that would leave the panel unable to
 * do its job. The arithmetic goes in the message: "you would be left with one,
 * and this panel needs two" is actionable in a way that "cannot remove" is not.
 */
appealPanelSchema.methods.removeMember = function removeMember(userId, actor, reason) {
  const member = this.findMember(userId);

  if (!member || !member.active) {
    throw new Error('That person is not on this panel');
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('A removal reason is required');
  }

  if (this.status === 'active') {
    const remaining = this.activeMembers.length - 1;

    if (remaining < this.minReviewers) {
      throw new Error(
        `Removing ${member.name || 'this member'} would leave ${remaining} reviewer(s); ` +
          `this panel needs ${this.minReviewers}`
      );
    }

    if (member.seat === 'chair' && this.chairs.length === 1) {
      throw new Error(
        'This is the panel’s only chair. Appoint another chair before removing them'
      );
    }
  }

  member.active = false;
  member.removedBy = actor ? actor._id : undefined;
  member.removedAt = new Date();
  member.removalReason = String(reason).trim();

  return this.log('member removed', actor, member.removalReason, member.name || '');
};

appealPanelSchema.methods.setSeat = function setSeat(userId, actor, seat) {
  if (!SEATS.includes(seat)) {
    throw new Error(`"${seat}" is not a panel seat`);
  }

  const member = this.findMember(userId);
  if (!member || !member.active) {
    throw new Error('That person is not on this panel');
  }

  if (member.seat === seat) {
    throw new Error(`${member.name || 'That member'} is already the ${seat}`);
  }

  // Standing down the last chair would leave an active panel without one,
  // which is the state `activate` refuses to create in the first place.
  if (this.status === 'active' && member.seat === 'chair' && this.chairs.length === 1) {
    throw new Error(
      'This is the panel’s only chair. Appoint another chair before standing this one down'
    );
  }

  const from = member.seat;
  member.seat = seat;

  return this.log('seat changed', actor, `${from} to ${seat}`, member.name || '');
};

appealPanelSchema.methods.activate = function activate(actor) {
  if (this.status === 'active') {
    throw new Error('This panel is already active');
  }
  if (this.status === 'retired') {
    throw new Error('A retired panel cannot be reactivated; create a new one');
  }

  if (this.activeMembers.length < this.minReviewers) {
    throw new Error(
      `This panel has ${this.activeMembers.length} reviewer(s) and needs ${this.minReviewers}`
    );
  }
  if (!this.chairs.length) {
    throw new Error('A panel needs a chair before it can be activated');
  }

  this.status = 'active';
  this.activatedBy = actor ? actor._id : undefined;
  this.activatedAt = new Date();

  return this.log('activated', actor);
};

/**
 * Retirement. The open-work check lives in the controller, because it needs to
 * count appeals and a model method that reaches into another collection is how
 * a require cycle starts.
 */
appealPanelSchema.methods.retire = function retire(actor, reason) {
  if (this.status === 'retired') {
    throw new Error('This panel is already retired');
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('A retirement reason is required');
  }

  this.status = 'retired';
  this.retiredBy = actor ? actor._id : undefined;
  this.retiredAt = new Date();
  this.retirementReason = String(reason).trim();

  return this.log('retired', actor, this.retirementReason);
};

appealPanelSchema.methods.toRow = function toRow() {
  return {
    _id: this._id,
    course: this.course,
    courseName: this.courseName,
    name: this.name,
    academicYear: this.academicYear,
    status: this.status,
    minReviewers: this.minReviewers,
    memberCount: this.activeMembers.length,
    chairCount: this.chairs.length,
    canActivate:
      this.status === 'draft' &&
      this.activeMembers.length >= this.minReviewers &&
      this.chairs.length > 0,
    members: this.members.map((member) => ({
      user: member.user,
      name: member.name,
      email: member.email,
      seat: member.seat,
      active: member.active,
      addedAt: member.addedAt,
      removedAt: member.removedAt,
      removalReason: member.removalReason,
    })),
    notes: this.notes,
    activatedAt: this.activatedAt,
    retiredAt: this.retiredAt,
    retirementReason: this.retirementReason,
    createdAt: this.createdAt,
  };
};

/**
 * Derived flag and the invariants that need more than one field.
 *
 * Mongoose 9 passes no callback to middleware, so this throws rather than
 * calling `next(err)`.
 */
appealPanelSchema.pre('save', function beforeSave() {
  this.isLive = LIVE_STATUSES.includes(this.status);

  // Nobody holds two rows on one panel. The add path prevents it; this is the
  // guard for any other path that ever touches `members` directly.
  const seen = new Set();
  for (const member of this.members) {
    const key = String(member.user);
    if (seen.has(key)) {
      throw new Error(`${member.name || 'A member'} appears on this panel twice`);
    }
    seen.add(key);
  }

  if (this.status === 'active') {
    const active = this.members.filter((member) => member.active);

    if (active.length < this.minReviewers) {
      throw new Error(
        `An active panel needs ${this.minReviewers} reviewers; this one has ${active.length}`
      );
    }
    if (!active.some((member) => member.seat === 'chair')) {
      throw new Error('An active panel must have a chair');
    }
  }

  // The course a panel covers is what its membership was chosen for. Moving it
  // to another course would silently make everyone on it a reviewer for a
  // subject nobody agreed to.
  if (!this.isNew && this.isModified('course')) {
    throw new Error('A panel cannot be moved to a different course');
  }
});

appealPanelSchema.statics.STATUSES = PANEL_STATUSES;
appealPanelSchema.statics.LIVE_STATUSES = LIVE_STATUSES;
appealPanelSchema.statics.SEATS = SEATS;
appealPanelSchema.statics.ELIGIBLE_ROLES = ELIGIBLE_ROLES;
appealPanelSchema.statics.MAX_MEMBERS = MAX_MEMBERS;
appealPanelSchema.statics.DEFAULT_MIN_REVIEWERS = DEFAULT_MIN_REVIEWERS;

/** The live panel for a course, if there is one. */
appealPanelSchema.statics.liveFor = function liveFor(courseId) {
  return this.findOne({ course: courseId, isLive: true });
};

/** The active panel for a course — the only one an assignment may be made from. */
appealPanelSchema.statics.activeFor = function activeFor(courseId) {
  return this.findOne({ course: courseId, status: 'active' });
};

module.exports = mongoose.model('AppealPanel', appealPanelSchema);
