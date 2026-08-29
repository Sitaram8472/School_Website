const mongoose = require('mongoose');

/**
 * What a course requires before a student may take it.
 *
 * `Course` has a `students[]` array and enrolment is a push onto it, so today
 * nothing knows that Physics II comes after Physics I. The prerequisite lives
 * in the prospectus, which means it is advisory in exactly the way that makes
 * it useless.
 *
 * Two rules carry this file. A rule graph containing a cycle is refused at the
 * moment it is written, rather than discovered by a student who cannot enrol
 * in either of two courses that require each other. And a waiver records the
 * gaps it was granted against, so a waiver written for one missing course
 * cannot silently cover a different one added later.
 */

const PREREQUISITE_KINDS = ['completion', 'minimum-score', 'concurrent'];

// How deep the graph walk will go before it gives up. A pre-existing cycle —
// written before this module landed, or by a direct database edit — must not
// be able to hang a request.
const MAX_GRAPH_DEPTH = 24;

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
      maxlength: [300, 'History note cannot exceed 300 characters'],
      default: '',
    },
  },
  { _id: false }
);

const coursePrerequisiteSchema = new mongoose.Schema(
  {
    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: [true, 'The course the rule applies to is required'],
    },

    requires: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: [true, 'The required course is required'],
    },

    kind: {
      type: String,
      enum: {
        values: PREREQUISITE_KINDS,
        message: 'Invalid prerequisite kind',
      },
      default: 'completion',
    },

    // Only meaningful for `minimum-score`. Held as a percentage rather than a
    // raw mark because exams differ in total points and a raw threshold would
    // mean something different for every paper.
    minimumPercent: {
      type: Number,
      min: [0, 'Minimum percent cannot be negative'],
      max: [100, 'Minimum percent cannot exceed 100'],
      default: 0,
    },

    // A mandatory rule blocks enrolment. An advisory one warns and lets it
    // through, recording that the warning was shown — which is the honest
    // model for "we recommend you have done this first".
    isMandatory: {
      type: Boolean,
      default: true,
    },

    rationale: {
      type: String,
      trim: true,
      maxlength: [400, 'Rationale cannot exceed 400 characters'],
      default: '',
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
    // cannot express a negation — MongoDB refuses `$ne` inside a
    // partialFilterExpression — so this is what the index filters on.
    isActive: {
      type: Boolean,
      default: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'The author of the rule is required'],
    },

    history: {
      type: [historyEntrySchema],
      default: [],
    },
  },
  { timestamps: true }
);

// One live rule per ordered pair. Retired rules stay, so the index has to be
// partial or re-adding a rule that was once retired would collide with it.
coursePrerequisiteSchema.index(
  { course: 1, requires: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);

coursePrerequisiteSchema.index({ course: 1, isActive: 1 });
coursePrerequisiteSchema.index({ requires: 1, isActive: 1 });

coursePrerequisiteSchema.pre('save', function () {
  this.isActive = !this.retiredAt;

  if (String(this.course) === String(this.requires)) {
    throw new Error('A course cannot be a prerequisite of itself');
  }

  if (this.kind === 'minimum-score' && !(this.minimumPercent > 0)) {
    throw new Error('A minimum-score prerequisite needs a minimum percent above zero');
  }

  if (this.kind !== 'minimum-score') {
    this.minimumPercent = 0;
  }
});

coursePrerequisiteSchema.methods.log = function (action, actor, note = '') {
  this.history.push({
    action,
    by: actor ? actor._id : undefined,
    byName: (actor && actor.name) || '',
    at: new Date(),
    note,
  });

  return this;
};

coursePrerequisiteSchema.methods.retire = function (actor, note = '') {
  if (this.retiredAt) {
    throw new Error('This rule is already retired');
  }

  this.retiredAt = new Date();
  this.isActive = false;

  return this.log('retired', actor, note);
};

/**
 * The whole active graph as an adjacency map, `courseId -> [requiredCourseId]`.
 *
 * Loaded in one query and walked in memory. The alternative — a recursive
 * `$graphLookup` per check — is both slower and harder to reason about for a
 * graph that is, in any real school, a few hundred edges.
 */
coursePrerequisiteSchema.statics.adjacency = async function () {
  const edges = await this.find({ isActive: true }).select('course requires').lean();

  return edges.reduce((map, edge) => {
    const from = String(edge.course);
    if (!map[from]) map[from] = [];
    map[from].push(String(edge.requires));
    return map;
  }, {});
};

/**
 * Would adding "course requires requiredCourse" close a loop?
 *
 * A cycle exists if `course` is already reachable from `requiredCourse` by
 * following prerequisite edges. Returns the path when it is, so the caller can
 * show which rules are involved rather than just the word "cycle".
 */
coursePrerequisiteSchema.statics.findCycle = async function (course, requiredCourse, adjacency) {
  const graph = adjacency || (await this.adjacency());

  const target = String(course);
  const start = String(requiredCourse);

  if (target === start) return [target, target];

  const seen = new Set();

  // Iterative depth-first search carrying its own path, so a pre-existing
  // cycle in the stored data cannot recurse forever.
  const stack = [[start, [target, start]]];

  while (stack.length) {
    const [node, path] = stack.pop();

    if (path.length > MAX_GRAPH_DEPTH) continue;
    if (seen.has(node)) continue;
    seen.add(node);

    const next = graph[node] || [];

    for (const neighbour of next) {
      if (neighbour === target) {
        return [...path, target];
      }
      stack.push([neighbour, [...path, neighbour]]);
    }
  }

  return null;
};

/**
 * Everything a course transitively depends on, nearest first.
 *
 * This is the question nobody can answer today: change the middle course of a
 * three-deep chain and nothing tells you what you just invalidated.
 */
coursePrerequisiteSchema.statics.chainFor = async function (courseId, adjacency) {
  const graph = adjacency || (await this.adjacency());

  const root = String(courseId);
  const seen = new Set([root]);
  const chain = [];

  let frontier = graph[root] || [];
  let depth = 1;

  while (frontier.length && depth <= MAX_GRAPH_DEPTH) {
    const nextFrontier = [];

    for (const node of frontier) {
      if (seen.has(node)) continue;
      seen.add(node);
      chain.push({ course: node, depth });
      nextFrontier.push(...(graph[node] || []));
    }

    frontier = nextFrontier;
    depth += 1;
  }

  return chain;
};

/**
 * The courses that would be affected by changing this one — the reverse of
 * `chainFor`, which is the direction a curriculum lead actually asks about.
 */
coursePrerequisiteSchema.statics.dependentsOf = async function (courseId) {
  const edges = await this.find({ isActive: true }).select('course requires').lean();

  const reverse = edges.reduce((map, edge) => {
    const from = String(edge.requires);
    if (!map[from]) map[from] = [];
    map[from].push(String(edge.course));
    return map;
  }, {});

  const root = String(courseId);
  const seen = new Set([root]);
  const dependents = [];

  let frontier = reverse[root] || [];
  let depth = 1;

  while (frontier.length && depth <= MAX_GRAPH_DEPTH) {
    const nextFrontier = [];

    for (const node of frontier) {
      if (seen.has(node)) continue;
      seen.add(node);
      dependents.push({ course: node, depth });
      nextFrontier.push(...(reverse[node] || []));
    }

    frontier = nextFrontier;
    depth += 1;
  }

  return dependents;
};

coursePrerequisiteSchema.statics.KINDS = PREREQUISITE_KINDS;
coursePrerequisiteSchema.statics.MAX_GRAPH_DEPTH = MAX_GRAPH_DEPTH;

/**
 * Permission to enrol despite an unmet prerequisite.
 *
 * `unmetAtWaiver` is the point of the schema. A waiver granted because a
 * student was missing Algebra should not silently also cover Geometry when
 * somebody adds a Geometry rule next term — so the gaps are frozen into the
 * waiver and checked against the gaps found at enrolment time.
 */
const unmetSnapshotSchema = new mongoose.Schema(
  {
    requires: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
    },
    requiresName: {
      type: String,
      trim: true,
      default: '',
    },
    kind: {
      type: String,
      enum: PREREQUISITE_KINDS,
      default: 'completion',
    },
    minimumPercent: {
      type: Number,
      default: 0,
    },
  },
  { _id: false }
);

const prerequisiteWaiverSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Student is required'],
    },

    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: [true, 'Course is required'],
    },

    unmetAtWaiver: {
      type: [unmetSnapshotSchema],
      default: [],
    },

    justification: {
      type: String,
      required: [true, 'A justification is required'],
      trim: true,
      minlength: [15, 'A waiver needs a real justification, not a placeholder'],
      maxlength: [600, 'Justification cannot exceed 600 characters'],
    },

    grantedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'The person granting the waiver is required'],
    },

    grantedAt: {
      type: Date,
      default: Date.now,
    },

    expiresAt: {
      type: Date,
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

    revocationReason: {
      type: String,
      trim: true,
      maxlength: [400, 'Revocation reason cannot exceed 400 characters'],
      default: '',
    },

    // Derived from `revokedAt`, for the same partial-index reason as `isActive`
    // above. Expiry is deliberately *not* folded in here: a boolean cannot
    // represent "live until Tuesday", so expiry is evaluated at read time.
    isLive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

prerequisiteWaiverSchema.index(
  { student: 1, course: 1 },
  { unique: true, partialFilterExpression: { isLive: true } }
);

prerequisiteWaiverSchema.index({ course: 1, isLive: 1 });

prerequisiteWaiverSchema.pre('save', function () {
  this.isLive = !this.revokedAt;

  if (this.grantedBy && this.student && this.grantedBy.equals(this.student)) {
    throw new Error('A student cannot grant their own waiver');
  }
});

/**
 * Is this waiver usable right now, and does it actually cover these gaps?
 *
 * A waiver only covers the gaps it was granted against. A gap that appeared
 * afterwards is not covered, and the caller is told which one.
 */
prerequisiteWaiverSchema.methods.coverage = function (unmet) {
  if (!this.isLive) {
    return { usable: false, reason: 'The waiver has been revoked', uncovered: unmet };
  }

  if (this.expiresAt && this.expiresAt.getTime() < Date.now()) {
    return { usable: false, reason: 'The waiver has expired', uncovered: unmet };
  }

  const covered = new Set(this.unmetAtWaiver.map((entry) => String(entry.requires)));
  const uncovered = unmet.filter((gap) => !covered.has(String(gap.requires)));

  if (uncovered.length) {
    return {
      usable: false,
      reason: 'The waiver was granted for different prerequisites',
      uncovered,
    };
  }

  return { usable: true, reason: '', uncovered: [] };
};

const CoursePrerequisite = mongoose.model('CoursePrerequisite', coursePrerequisiteSchema);
const PrerequisiteWaiver = mongoose.model('PrerequisiteWaiver', prerequisiteWaiverSchema);

module.exports = CoursePrerequisite;
module.exports.CoursePrerequisite = CoursePrerequisite;
module.exports.PrerequisiteWaiver = PrerequisiteWaiver;
