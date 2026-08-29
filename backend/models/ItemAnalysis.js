const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * Item analysis for one exam.
 *
 * `SubmissionList` shows a teacher one column of scores. That says how the
 * students did; it says nothing about how the *paper* did, and the data to
 * answer the second question is already stored — `Submission.answers[]` holds
 * every response and `Exam.questions[]` holds the key and the points.
 *
 * The statistic worth having is discrimination. A question the strongest third
 * of the class gets wrong more often than the weakest third is almost always a
 * miskeyed answer, and in a score column it looks completely unremarkable.
 *
 * A snapshot, not a live view: two analyses of the same exam a week apart with
 * different numbers of submissions are two facts, and both should survive.
 */

const ITEM_FLAGS = [
  'too-easy',
  'too-hard',
  'non-discriminating',
  'negative-discrimination',
  'suspected-miskey',
  'dead-distractor',
  'ambiguous-distractor',
];

// Below this many submissions nothing is computed. It is a statistical rule —
// two decimal places on nine data points invites conclusions the sample cannot
// carry — and a privacy one: with six submissions, "five of six got Q4 wrong"
// plus a score list identifies children.
const DEFAULT_MINIMUM_COHORT = 10;
const ABSOLUTE_MINIMUM_COHORT = 5;

// The classical upper/lower split. 27% maximises the separation between the
// groups for a normal distribution while keeping each group big enough to mean
// something.
const GROUP_FRACTION = 0.27;

// Where a working question sits. Outside this band an item is either giving
// marks away or taking them from everybody, and in both cases it is telling
// you nothing about who knows the subject.
const EASY_ABOVE = 0.9;
const HARD_BELOW = 0.2;

// |D| under this is noise rather than discrimination.
const FLAT_DISCRIMINATION = 0.1;

// Below this the item is actively backwards, which is what a wrong key looks
// like from the outside.
const MISKEY_DISCRIMINATION = -0.15;

const distractorSchema = new mongoose.Schema(
  {
    option: {
      type: String,
      trim: true,
      default: '',
    },
    isKey: {
      type: Boolean,
      default: false,
    },
    chosenBy: {
      type: Number,
      default: 0,
    },
    chosenByUpperGroup: {
      type: Number,
      default: 0,
    },
    chosenByLowerGroup: {
      type: Number,
      default: 0,
    },
  },
  { _id: false }
);

const itemSchema = new mongoose.Schema(
  {
    questionId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    questionText: {
      type: String,
      trim: true,
      default: '',
    },
    type: {
      type: String,
      trim: true,
      default: 'MCQ',
    },
    points: {
      type: Number,
      default: 1,
    },
    // How many submissions carried any answer at all for this question. A
    // blank is not a wrong answer, and counting it as one deflates facility by
    // however many students ran out of time.
    attempted: {
      type: Number,
      default: 0,
    },
    correct: {
      type: Number,
      default: 0,
    },
    // The p-value: proportion of attempts that were right.
    facility: {
      type: Number,
      default: 0,
    },
    // Upper-lower index over the top and bottom groups.
    discrimination: {
      type: Number,
      default: 0,
    },
    // Item-total correlation. Uses the whole cohort rather than two slices of
    // it, so it disagrees with `discrimination` occasionally — and where the
    // two disagree is itself worth looking at.
    pointBiserial: {
      type: Number,
      default: null,
    },
    distractors: {
      type: [distractorSchema],
      default: [],
    },
    flags: {
      type: [String],
      enum: {
        values: ITEM_FLAGS,
        message: 'Invalid item flag',
      },
      default: [],
    },
  },
  { _id: false }
);

const noteSchema = new mongoose.Schema(
  {
    questionId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    text: {
      type: String,
      required: true,
      trim: true,
      maxlength: [600, 'A note cannot exceed 600 characters'],
    },
    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    addedByName: {
      type: String,
      trim: true,
      default: '',
    },
    addedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const itemAnalysisSchema = new mongoose.Schema(
  {
    exam: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: [true, 'Exam is required'],
    },

    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      default: null,
    },

    title: {
      type: String,
      trim: true,
      default: '',
    },

    // A hash over every question's text, key and points at the moment of the
    // analysis. If the exam is edited afterwards this no longer matches, and
    // the snapshot stops claiming to describe the current paper.
    paperFingerprint: {
      type: String,
      required: [true, 'A paper fingerprint is required'],
      trim: true,
    },

    cohortSize: {
      type: Number,
      required: [true, 'Cohort size is required'],
      min: [0, 'Cohort size cannot be negative'],
    },

    minimumCohort: {
      type: Number,
      default: DEFAULT_MINIMUM_COHORT,
    },

    analysedAt: {
      type: Date,
      default: Date.now,
    },

    analysedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'The person running the analysis is required'],
    },

    meanScore: { type: Number, default: 0 },
    meanPercent: { type: Number, default: 0 },
    medianPercent: { type: Number, default: 0 },
    standardDeviation: { type: Number, default: 0 },
    minPercent: { type: Number, default: 0 },
    maxPercent: { type: Number, default: 0 },
    maxPoints: { type: Number, default: 0 },

    // Omitted rather than reported as zero when it cannot be computed. A
    // reliability of 0 and a reliability that does not exist are different
    // statements about a paper.
    reliabilityKr20: {
      type: Number,
      default: null,
    },

    upperGroupSize: { type: Number, default: 0 },
    lowerGroupSize: { type: Number, default: 0 },

    items: {
      type: [itemSchema],
      default: [],
    },

    suppressed: {
      type: Boolean,
      default: false,
    },

    suppressionReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Suppression reason cannot exceed 300 characters'],
      default: '',
    },

    supersededBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ItemAnalysis',
      default: null,
    },

    // What the teacher decided to do about an item. Append-only, per question,
    // and permanent — "rewrote this for next year" belongs against the item.
    notes: {
      type: [noteSchema],
      default: [],
    },
  },
  { timestamps: true }
);

itemAnalysisSchema.index({ exam: 1, analysedAt: -1 });
itemAnalysisSchema.index({ analysedBy: 1, analysedAt: -1 });

/**
 * A snapshot is a record of what was true when it was taken, so nothing in it
 * may be rewritten afterwards. Only `notes` and `supersededBy` are open.
 */
itemAnalysisSchema.pre('save', function () {
  if (this.isNew) return;

  const frozen = ['items', 'cohortSize', 'paperFingerprint', 'meanScore', 'reliabilityKr20', 'exam'];
  const edited = frozen.find((field) => this.isModified(field));

  if (edited) {
    throw new Error(`"${edited}" cannot be changed: an analysis is a snapshot, not a live view`);
  }
});

itemAnalysisSchema.methods.addNote = function (actor, questionId, text) {
  if (!text || !String(text).trim()) {
    throw new Error('A note needs some text');
  }

  const known = this.items.some((item) => String(item.questionId) === String(questionId));
  if (!known && this.items.length) {
    throw new Error('That question is not part of this analysis');
  }

  this.notes.push({
    questionId,
    text: String(text).trim(),
    addedBy: actor._id,
    addedByName: actor.name || '',
    addedAt: new Date(),
  });

  return this;
};

/**
 * Does this snapshot still describe the paper as it stands?
 * Compared rather than stored, so an exam edited five minutes ago is caught
 * without anything having to notice the edit.
 */
itemAnalysisSchema.methods.isCurrentFor = function (exam) {
  return this.paperFingerprint === this.constructor.fingerprint(exam);
};

/**
 * A stable hash of everything about the paper that would change the numbers:
 * the wording, the type, the key and the marks.
 */
itemAnalysisSchema.statics.fingerprint = function (exam) {
  const parts = (exam.questions || []).map((question) =>
    [
      String(question._id),
      String(question.questionText || ''),
      String(question.type || ''),
      String(question.correctAnswer || ''),
      String(question.points || 1),
      (question.options || []).join(' '),
    ].join('')
  );

  return crypto.createHash('sha256').update(parts.join('')).digest('hex').slice(0, 32);
};

/**
 * How an answer is marked.
 *
 * Deliberately the same rule `submitExam` uses for MCQs — an exact match
 * against the stored key — because an analysis that marks more strictly or
 * more loosely than the grader produces figures that do not reconcile with the
 * score column, and a teacher will trust the score column.
 *
 * `ShortAnswer` is not auto-graded at submission time at all, so it is marked
 * here on a trimmed, case-insensitive comparison and its numbers are reported
 * for what they are.
 */
itemAnalysisSchema.statics.isCorrect = function (question, providedAnswer) {
  if (providedAnswer === undefined || providedAnswer === null) return false;

  const given = String(providedAnswer).trim();
  if (!given) return false;

  const key = String(question.correctAnswer || '').trim();

  if (question.type === 'MCQ') return given === key;

  return given.toLowerCase() === key.toLowerCase();
};

itemAnalysisSchema.statics.ITEM_FLAGS = ITEM_FLAGS;
itemAnalysisSchema.statics.DEFAULT_MINIMUM_COHORT = DEFAULT_MINIMUM_COHORT;
itemAnalysisSchema.statics.ABSOLUTE_MINIMUM_COHORT = ABSOLUTE_MINIMUM_COHORT;
itemAnalysisSchema.statics.GROUP_FRACTION = GROUP_FRACTION;
itemAnalysisSchema.statics.EASY_ABOVE = EASY_ABOVE;
itemAnalysisSchema.statics.HARD_BELOW = HARD_BELOW;
itemAnalysisSchema.statics.FLAT_DISCRIMINATION = FLAT_DISCRIMINATION;
itemAnalysisSchema.statics.MISKEY_DISCRIMINATION = MISKEY_DISCRIMINATION;

module.exports = mongoose.model('ItemAnalysis', itemAnalysisSchema);
