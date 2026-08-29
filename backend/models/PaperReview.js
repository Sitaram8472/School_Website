const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * Question-paper moderation.
 *
 * `Exam` lets a teacher author a paper and publish it. Between those two acts,
 * in every school that runs real examinations, somebody other than the author
 * reads the paper. This file is that step.
 *
 * The one idea worth defending: **an approval is an approval of one exact
 * version of a paper, and the server can prove which.**
 *
 * On submission the review computes `paperFingerprint` — a digest over the
 * ordered question text, types, options, answer keys and marks. The verdict
 * stores the fingerprint it approved. `integrityAgainst(exam)` recomputes the
 * digest from the live exam and compares, on every read, so a paper edited
 * after sign-off reports itself as superseded rather than waiting for somebody
 * to remember to look. Approval without that comparison is a process claim, not
 * a fact about an artefact.
 *
 * The second idea: the checks a machine can make are made by the machine. Marks
 * that do not add up to the declared total, an MCQ whose key is not among its
 * options, two questions with the same stem — none of those should cost a
 * moderator any attention, and all of them currently reach the hall.
 */

const ASSESSMENT_TYPES = [
  'unit-test',
  'mid-term',
  'final',
  'pre-board',
  'board-mock',
  'practical',
  'retest',
];

const REVIEW_STATUSES = [
  'draft',
  'submitted',
  'under-review',
  'changes-requested',
  'approved',
  'rejected',
  'withdrawn',
  'superseded',
];

// A review in one of these states is waiting on the moderator rather than the
// author, which is what the two queues are built from.
const MODERATOR_STATUSES = ['submitted', 'under-review'];

// A review in one of these states is finished with; a new submission starts a
// new version rather than reopening it.
const TERMINAL_STATUSES = ['rejected', 'withdrawn', 'superseded'];

const COGNITIVE_LEVELS = [
  'recall',
  'understanding',
  'application',
  'analysis',
  'evaluation',
  'creation',
];

const FINDING_CATEGORIES = [
  'accuracy',
  'ambiguity',
  'out-of-syllabus',
  'difficulty',
  'language',
  'marks',
  'duplication',
  'formatting',
  'answer-key',
];

const FINDING_SEVERITIES = ['blocker', 'major', 'minor'];

const CHECK_SEVERITIES = ['blocker', 'warning', 'note'];

// A single topic carrying more than this share of the marks is a paper about
// one thing wearing the name of a syllabus.
const TOPIC_CONCENTRATION_LIMIT = 0.4;

// Marks per minute outside this band is a paper that cannot be finished, or one
// that will be finished in half the time.
const MIN_MARKS_PER_MINUTE = 0.3;
const MAX_MARKS_PER_MINUTE = 1.5;

const MIN_MCQ_OPTIONS = 2;
const MAX_VERSIONS = 50;

/** The house blueprint, used when a paper does not state its own target. */
const DEFAULT_COGNITIVE_TARGET = {
  recall: 30,
  understanding: 20,
  application: 30,
  analysis: 15,
  evaluation: 5,
  creation: 0,
};

// A cognitive mix this far from the target, in percentage points, is worth
// saying out loud. Closer than this is noise.
const BLUEPRINT_TOLERANCE = 15;

const YEAR_PATTERN = /^\d{4}-\d{2}$/;

/** Collapse whitespace and case so "  What is  force?" matches "what is force?". */
function normaliseStem(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A digest over everything that makes the paper the paper.
 *
 * Order is included deliberately: reordering the questions produces a different
 * paper, and a moderator who approved one sequence did not approve the other.
 * Titles and descriptions are excluded — fixing a typo in the exam's name is
 * not a change to the questions, and treating it as one would train everybody
 * to ignore the warning.
 */
function fingerprintExam(exam) {
  if (!exam) return null;

  const payload = (exam.questions || []).map((question, index) => ({
    i: index,
    q: normaliseStem(question.questionText),
    t: question.type,
    o: (question.options || []).map((option) => normaliseStem(option)),
    a: normaliseStem(question.correctAnswer),
    p: Number(question.points) || 0,
  }));

  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ questions: payload, timeLimit: exam.timeLimit || null }))
    .digest('hex');
}

/** Marks on a paper, from the questions. Never from a field somebody typed. */
function totalMarksOf(exam) {
  return (exam?.questions || []).reduce(
    (sum, question) => sum + (Number(question.points) || 0),
    0
  );
}

function percent(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

const questionMetaSchema = new mongoose.Schema(
  {
    // The question's position on the paper at the time it was classified.
    // Resubmission re-derives these, so a reordered paper is reclassified
    // rather than silently mislabelled.
    index: {
      type: Number,
      required: true,
      min: 0,
    },
    cognitiveLevel: {
      type: String,
      enum: {
        values: COGNITIVE_LEVELS,
        message: 'Invalid cognitive level',
      },
    },
    topic: {
      type: String,
      trim: true,
      maxlength: [80, 'Topic cannot exceed 80 characters'],
    },
    isOutOfSyllabus: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false }
);

const checkSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      trim: true,
      maxlength: [40, 'Check code cannot exceed 40 characters'],
    },
    severity: {
      type: String,
      enum: CHECK_SEVERITIES,
      default: 'warning',
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: [300, 'Check message cannot exceed 300 characters'],
    },
    questionIndex: {
      type: Number,
      default: null,
    },
  },
  { _id: false }
);

const findingSchema = new mongoose.Schema(
  {
    questionIndex: {
      type: Number,
      default: null,
    },
    // The stem the finding was raised against, kept so the comment still makes
    // sense after the paper is reordered or the question is rewritten.
    questionExcerpt: {
      type: String,
      trim: true,
      maxlength: [200, 'Excerpt cannot exceed 200 characters'],
    },
    category: {
      type: String,
      required: [true, 'A finding needs a category'],
      enum: {
        values: FINDING_CATEGORIES,
        message: 'Invalid finding category',
      },
    },
    severity: {
      type: String,
      enum: {
        values: FINDING_SEVERITIES,
        message: 'Invalid severity',
      },
      default: 'major',
    },
    comment: {
      type: String,
      required: [true, 'A finding needs a comment'],
      trim: true,
      maxlength: [1500, 'Comment cannot exceed 1500 characters'],
    },
    raisedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    raisedAt: {
      type: Date,
      default: Date.now,
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
    resolutionNote: {
      type: String,
      trim: true,
      maxlength: [1000, 'Resolution note cannot exceed 1000 characters'],
      default: null,
    },
    // Which version of the paper the finding was raised against. A finding from
    // version 1 that was never resolved is still a fact about version 1.
    paperVersion: {
      type: Number,
      default: 1,
    },
  },
  { _id: true }
);

const historySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: [40, 'Action cannot exceed 40 characters'],
    },
    note: {
      type: String,
      trim: true,
      maxlength: [500, 'Note cannot exceed 500 characters'],
    },
    by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    at: {
      type: Date,
      default: Date.now,
    },
    paperVersion: {
      type: Number,
      default: 1,
    },
  },
  { _id: true, timestamps: false }
);

const paperReviewSchema = new mongoose.Schema(
  {
    exam: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: [true, 'A review must belong to an exam'],
      index: true,
    },
    examTitle: {
      type: String,
      trim: true,
    },
    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
    },
    academicYear: {
      type: String,
      trim: true,
      match: [YEAR_PATTERN, 'Academic year must look like 2026-27'],
    },
    assessmentType: {
      type: String,
      required: [true, 'Assessment type is required'],
      enum: {
        values: ASSESSMENT_TYPES,
        message: 'Invalid assessment type',
      },
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A review must name its author'],
      index: true,
    },
    moderator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    assignedAt: {
      type: Date,
      default: null,
    },
    // Whether the author learns who moderated. Fixed at assignment, honoured by
    // the serializer, and never relaxed afterwards.
    isBlind: {
      type: Boolean,
      default: false,
    },
    paperVersion: {
      type: Number,
      default: 1,
      min: 1,
    },
    // Derived on submission from the exam's questions. Never accepted from a
    // client, and the whole reason an approval means anything.
    paperFingerprint: {
      type: String,
      default: null,
    },
    declaredTotalMarks: {
      type: Number,
      default: null,
      min: [0, 'Declared marks cannot be negative'],
    },
    questionMeta: {
      type: [questionMetaSchema],
      default: [],
    },
    cognitiveTarget: {
      type: Map,
      of: Number,
      default: undefined,
    },
    // Derived on every submission. Stored so the queue can be sorted and
    // filtered without loading every exam, and recomputed whenever it is used
    // to make a decision.
    checks: {
      type: [checkSchema],
      default: [],
    },
    findings: {
      type: [findingSchema],
      default: [],
    },
    status: {
      type: String,
      enum: {
        values: REVIEW_STATUSES,
        message: 'Invalid status',
      },
      default: 'draft',
      index: true,
    },
    verdict: {
      decision: {
        type: String,
        enum: ['approved', 'rejected', null],
        default: null,
      },
      decidedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
      },
      decidedAt: {
        type: Date,
        default: null,
      },
      note: {
        type: String,
        trim: true,
        maxlength: [1500, 'Verdict note cannot exceed 1500 characters'],
        default: null,
      },
      // The fingerprint that was approved. The paper is allowed to change after
      // this; what is not allowed is for the change to go unnoticed.
      approvedFingerprint: {
        type: String,
        default: null,
      },
      approvedVersion: {
        type: Number,
        default: null,
      },
    },
    embargoUntil: {
      type: Date,
      default: null,
    },
    submittedAt: {
      type: Date,
      default: null,
    },
    dueBy: {
      type: String,
      default: null,
    },
    history: {
      type: [historySchema],
      default: [],
    },
  },
  { timestamps: true }
);

paperReviewSchema.index({ status: 1, createdAt: -1 });
paperReviewSchema.index({ exam: 1, paperVersion: -1 });
paperReviewSchema.index({ moderator: 1, status: 1 });

paperReviewSchema.pre('validate', function guard() {
  if (this.paperVersion > MAX_VERSIONS) {
    this.invalidate(
      'paperVersion',
      `A paper cannot be resubmitted more than ${MAX_VERSIONS} times — start a new review`
    );
  }

  if (this.verdict && this.verdict.decision !== 'approved') {
    this.verdict.approvedFingerprint = null;
    this.verdict.approvedVersion = null;
  }

  if (this.moderator && String(this.moderator) === String(this.author)) {
    this.invalidate('moderator', 'A paper cannot be moderated by its own author');
  }
});

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * The blueprint: what this paper actually asks for, by marks.
 *
 * Every figure comes from the exam's questions and this review's per-question
 * classification. Nothing is typed, which is why the bars can be trusted at all.
 */
paperReviewSchema.methods.buildBlueprint = function buildBlueprint(exam) {
  const questions = exam?.questions || [];
  const totalMarks = totalMarksOf(exam);

  const metaByIndex = new Map(
    (this.questionMeta || []).map((meta) => [meta.index, meta])
  );

  const byCognitiveLevel = {};
  const byTopic = {};
  const byQuestionType = {};
  let unclassifiedMarks = 0;
  let outOfSyllabusMarks = 0;

  questions.forEach((question, index) => {
    const marks = Number(question.points) || 0;
    const meta = metaByIndex.get(index);

    byQuestionType[question.type] = (byQuestionType[question.type] || 0) + marks;

    if (meta && meta.cognitiveLevel) {
      byCognitiveLevel[meta.cognitiveLevel] =
        (byCognitiveLevel[meta.cognitiveLevel] || 0) + marks;
    } else {
      unclassifiedMarks += marks;
    }

    if (meta && meta.topic) {
      byTopic[meta.topic] = (byTopic[meta.topic] || 0) + marks;
    }
    if (meta && meta.isOutOfSyllabus) {
      outOfSyllabusMarks += marks;
    }
  });

  const target =
    this.cognitiveTarget && this.cognitiveTarget.size
      ? Object.fromEntries(this.cognitiveTarget)
      : DEFAULT_COGNITIVE_TARGET;

  const asRows = (bucket) =>
    Object.entries(bucket)
      .map(([key, marks]) => ({ key, marks, share: percent(marks, totalMarks) }))
      .sort((a, b) => b.marks - a.marks);

  return {
    totalMarks,
    questionCount: questions.length,
    declaredTotalMarks: this.declaredTotalMarks,
    timeLimit: exam?.timeLimit || null,
    marksPerMinute: exam?.timeLimit
      ? Math.round((totalMarks / exam.timeLimit) * 100) / 100
      : null,
    byCognitiveLevel: COGNITIVE_LEVELS.map((level) => ({
      key: level,
      marks: byCognitiveLevel[level] || 0,
      share: percent(byCognitiveLevel[level] || 0, totalMarks),
      target: target[level] || 0,
      drift: percent(byCognitiveLevel[level] || 0, totalMarks) - (target[level] || 0),
    })),
    byTopic: asRows(byTopic),
    byQuestionType: asRows(byQuestionType),
    unclassifiedMarks,
    unclassifiedShare: percent(unclassifiedMarks, totalMarks),
    outOfSyllabusMarks,
  };
};

/**
 * Everything a machine can tell without reading the physics.
 *
 * Returned rather than stored on each call, so a check can never be stale
 * relative to the paper it describes. The controller stores a copy on
 * submission only so the queue can be sorted without loading every exam.
 */
paperReviewSchema.methods.runChecks = function runChecks(exam) {
  const checks = [];
  const questions = exam?.questions || [];
  const blueprint = this.buildBlueprint(exam);

  const add = (code, severity, message, questionIndex = null) =>
    checks.push({ code, severity, message, questionIndex });

  if (questions.length === 0) {
    add('no-questions', 'blocker', 'The paper has no questions');
    return checks;
  }

  if (
    this.declaredTotalMarks !== null &&
    this.declaredTotalMarks !== undefined &&
    this.declaredTotalMarks !== blueprint.totalMarks
  ) {
    add(
      'total-mismatch',
      'blocker',
      `The paper is billed as ${this.declaredTotalMarks} marks but the questions add to ${blueprint.totalMarks}`
    );
  }

  const stems = new Map();

  questions.forEach((question, index) => {
    const label = `Q${index + 1}`;
    const stem = normaliseStem(question.questionText);
    const marks = Number(question.points) || 0;

    if (!stem) {
      add('empty-stem', 'blocker', `${label} has no question text`, index);
    } else if (stems.has(stem)) {
      add(
        'duplicate-stem',
        'blocker',
        `${label} repeats ${`Q${stems.get(stem) + 1}`} word for word`,
        index
      );
    } else {
      stems.set(stem, index);
    }

    if (marks <= 0) {
      add('zero-marks', 'warning', `${label} is worth no marks`, index);
    }

    const key = normaliseStem(question.correctAnswer);

    if (question.type === 'MCQ') {
      const options = (question.options || []).map((option) => normaliseStem(option));

      if (options.length < MIN_MCQ_OPTIONS) {
        add(
          'too-few-options',
          'blocker',
          `${label} is multiple choice with ${options.length} option(s)`,
          index
        );
      }
      if (!key) {
        add('no-answer-key', 'blocker', `${label} has no correct answer recorded`, index);
      } else if (!options.includes(key)) {
        // The one that reaches the hall. A key that is not among the options
        // means every candidate is wrong, and it is found by a student.
        add(
          'key-not-an-option',
          'blocker',
          `${label}'s correct answer is not one of its options`,
          index
        );
      }

      const seen = new Set();
      for (const option of options) {
        if (!option) {
          add('empty-option', 'warning', `${label} has a blank option`, index);
          continue;
        }
        if (seen.has(option)) {
          add(
            'duplicate-option',
            'blocker',
            `${label} offers the same option twice`,
            index
          );
          break;
        }
        seen.add(option);
      }
    } else if (!key) {
      add(
        'no-answer-key',
        'blocker',
        `${label} is a written answer with no marking key`,
        index
      );
    }
  });

  if (blueprint.unclassifiedMarks > 0) {
    add(
      'unclassified',
      'warning',
      `${blueprint.unclassifiedMarks} mark(s) are not classified by cognitive level, so the blueprint is incomplete`
    );
  }

  if (blueprint.outOfSyllabusMarks > 0) {
    add(
      'out-of-syllabus',
      'blocker',
      `${blueprint.outOfSyllabusMarks} mark(s) are flagged as outside this year's syllabus`
    );
  }

  const heaviest = blueprint.byTopic[0];
  if (heaviest && heaviest.share > TOPIC_CONCENTRATION_LIMIT * 100) {
    add(
      'topic-concentration',
      'warning',
      `${heaviest.share}% of the marks are on "${heaviest.key}"`
    );
  }

  if (blueprint.marksPerMinute !== null) {
    if (blueprint.marksPerMinute > MAX_MARKS_PER_MINUTE) {
      add(
        'time-pressure',
        'warning',
        `${blueprint.totalMarks} marks in ${blueprint.timeLimit} minutes — few candidates will finish`
      );
    } else if (blueprint.marksPerMinute < MIN_MARKS_PER_MINUTE) {
      add(
        'time-slack',
        'note',
        `${blueprint.totalMarks} marks in ${blueprint.timeLimit} minutes leaves a lot of spare time`
      );
    }
  }

  for (const row of blueprint.byCognitiveLevel) {
    if (row.target > 0 && Math.abs(row.drift) > BLUEPRINT_TOLERANCE) {
      add(
        'blueprint-drift',
        'note',
        `${row.key} is ${row.share}% of the paper against a target of ${row.target}%`
      );
    }
  }

  return checks;
};

paperReviewSchema.methods.blockersIn = function blockersIn(checks) {
  return (checks || []).filter((check) => check.severity === 'blocker');
};

paperReviewSchema.methods.unresolvedFindings = function unresolvedFindings() {
  return (this.findings || []).filter((finding) => !finding.resolvedAt);
};

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

/**
 * Does the approval still describe the paper?
 *
 * Recomputed on every read rather than cached, because the whole value of the
 * comparison is that nobody has to remember to make it. A paper edited after
 * sign-off reports `changed` the next time anybody looks, and the publication
 * clearance refuses it.
 */
paperReviewSchema.methods.integrityAgainst = function integrityAgainst(exam) {
  const current = fingerprintExam(exam);
  const approved = this.verdict ? this.verdict.approvedFingerprint : null;

  if (!approved) {
    return {
      state: 'not-approved',
      currentFingerprint: current,
      approvedFingerprint: null,
      approvedVersion: null,
      matches: false,
    };
  }

  return {
    state: current === approved ? 'intact' : 'changed',
    currentFingerprint: current,
    approvedFingerprint: approved,
    approvedVersion: this.verdict.approvedVersion,
    matches: current === approved,
  };
};

/**
 * May this exam be published?
 *
 * Three separate refusals, each named, because "not cleared" tells the person
 * holding the paper nothing about what to do next.
 */
paperReviewSchema.methods.clearanceFor = function clearanceFor(exam, now = new Date()) {
  if (this.status !== 'approved') {
    return {
      cleared: false,
      reason: `The paper is ${this.status}, not approved`,
      state: this.status,
    };
  }

  const integrity = this.integrityAgainst(exam);
  if (!integrity.matches) {
    return {
      cleared: false,
      reason: `Version ${integrity.approvedVersion} was approved; the paper has changed since`,
      state: 'changed',
      integrity,
    };
  }

  if (this.embargoUntil && now < this.embargoUntil) {
    return {
      cleared: false,
      reason: `Under embargo until ${this.embargoUntil.toISOString()}`,
      state: 'embargoed',
    };
  }

  return { cleared: true, reason: null, state: 'cleared', integrity };
};

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

paperReviewSchema.methods.isAuthoredBy = function isAuthoredBy(user) {
  if (!user) return false;
  return String(this.author) === String(user._id);
};

paperReviewSchema.methods.isModeratedBy = function isModeratedBy(user) {
  if (!user || !this.moderator) return false;
  return String(this.moderator) === String(user._id);
};

/**
 * Why `candidate` may not moderate this paper, or null when they may.
 *
 * The author is refused, and so is the exam's creator where that is somebody
 * else — a paper moderated by one of its own writers is a paper nobody
 * moderated, and that is the specific failure this module exists to prevent.
 */
paperReviewSchema.methods.assignabilityErrorFor = function assignabilityErrorFor(
  candidate,
  { examCreator = null } = {}
) {
  if (!candidate) return 'No moderator named';
  if (String(candidate._id) === String(this.author)) {
    return 'A paper cannot be moderated by its own author';
  }
  if (examCreator && String(candidate._id) === String(examCreator)) {
    return 'That teacher wrote this exam and cannot moderate it';
  }
  if (this.status === 'approved') return 'This review is already approved';
  if (TERMINAL_STATUSES.includes(this.status)) {
    return `A ${this.status} review cannot be reassigned`;
  }
  return null;
};

/** Why the verdict cannot be recorded yet, or null when it can. */
paperReviewSchema.methods.verdictabilityError = function verdictabilityError(checks) {
  if (!MODERATOR_STATUSES.includes(this.status)) {
    return `A ${this.status} review is not open for a verdict`;
  }

  const blockers = this.blockersIn(checks);
  if (blockers.length) {
    return `${blockers.length} blocking check(s) still stand — first: ${blockers[0].message}`;
  }

  const unresolved = this.unresolvedFindings();
  if (unresolved.length) {
    return `${unresolved.length} finding(s) are unresolved — first: ${unresolved[0].comment.slice(0, 80)}`;
  }

  return null;
};

paperReviewSchema.methods.recordHistory = function recordHistory(action, userId, note) {
  this.history.push({
    action,
    by: userId,
    at: new Date(),
    note,
    paperVersion: this.paperVersion,
  });
  if (this.history.length > 80) this.history = this.history.slice(-80);
};

/**
 * The review as the author may see it.
 *
 * On a blind review the moderator's identity is removed here, in one place, so
 * there is no endpoint that has to remember to strip it.
 */
paperReviewSchema.methods.toAuthorView = function toAuthorView(exam) {
  const base = this.toObject({ depopulate: false });

  if (this.isBlind && !this.verdict?.decidedAt) {
    base.moderator = null;
    base.assignedBy = null;
    base.findings = (base.findings || []).map((finding) => ({
      ...finding,
      raisedBy: null,
    }));
    base.history = (base.history || []).map((entry) => ({ ...entry, by: null }));
  }

  if (exam) {
    base.blueprint = this.buildBlueprint(exam);
    base.checks = this.runChecks(exam);
    base.integrity = this.integrityAgainst(exam);
  }

  return base;
};

paperReviewSchema.statics.fingerprintExam = fingerprintExam;
paperReviewSchema.statics.totalMarksOf = totalMarksOf;
paperReviewSchema.statics.normaliseStem = normaliseStem;
paperReviewSchema.statics.ASSESSMENT_TYPES = ASSESSMENT_TYPES;
paperReviewSchema.statics.REVIEW_STATUSES = REVIEW_STATUSES;
paperReviewSchema.statics.MODERATOR_STATUSES = MODERATOR_STATUSES;
paperReviewSchema.statics.TERMINAL_STATUSES = TERMINAL_STATUSES;
paperReviewSchema.statics.COGNITIVE_LEVELS = COGNITIVE_LEVELS;
paperReviewSchema.statics.FINDING_CATEGORIES = FINDING_CATEGORIES;
paperReviewSchema.statics.FINDING_SEVERITIES = FINDING_SEVERITIES;
paperReviewSchema.statics.CHECK_SEVERITIES = CHECK_SEVERITIES;
paperReviewSchema.statics.DEFAULT_COGNITIVE_TARGET = DEFAULT_COGNITIVE_TARGET;
paperReviewSchema.statics.TOPIC_CONCENTRATION_LIMIT = TOPIC_CONCENTRATION_LIMIT;

module.exports = mongoose.model('PaperReview', paperReviewSchema);
