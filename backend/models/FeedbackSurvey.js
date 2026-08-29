const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * Course and teaching feedback surveys.
 *
 * The whole module turns on one decision: an anonymous response stores a keyed
 * hash of the respondent, never the respondent.
 *
 * The obvious implementation keeps `respondent: ObjectId` and hides it in the
 * UI. That is not anonymity — it is anonymity until somebody runs a query, and
 * students know it, which is why the paper version of this exercise produces
 * uniformly positive feedback and teaches the school nothing.
 *
 * Storing `HMAC(surveyId + userId, secret)` instead gets both properties at
 * once:
 *
 *   - the same person submitting twice produces the same key, so duplicates are
 *     detectable — which is the requirement that usually forces systems to keep
 *     the identity in the first place;
 *   - the key is scoped to one survey, so keys cannot be joined across surveys
 *     to rebuild somebody's history.
 *
 * Reversing it needs the secret and a brute-force over the user table. Reading
 * a stored id needs a SELECT. That gap is the feature.
 */

const SURVEY_TYPES = ['course', 'teaching', 'facility', 'general'];
const SURVEY_STATUSES = ['draft', 'open', 'closed'];
const AUDIENCES = ['students', 'parents', 'teachers', 'all'];
const QUESTION_TYPES = ['rating', 'scale', 'single-choice', 'multi-choice', 'text', 'yes-no'];

// Types whose answers can be summarised as a number.
const NUMERIC_TYPES = ['rating', 'scale'];

const questionSchema = new mongoose.Schema(
  {
    prompt: {
      type: String,
      required: [true, 'Every question needs a prompt'],
      trim: true,
      maxlength: [300, 'Question prompt cannot exceed 300 characters'],
    },

    type: {
      type: String,
      enum: {
        values: QUESTION_TYPES,
        message: 'Invalid question type',
      },
      required: [true, 'Question type is required'],
    },

    options: {
      type: [String],
      default: [],
      validate: {
        validator(values) {
          // A choice question with no options is a dead end for the respondent.
          if (['single-choice', 'multi-choice'].includes(this.type)) {
            return Array.isArray(values) && values.length >= 2;
          }
          return true;
        },
        message: 'A choice question needs at least two options',
      },
    },

    required: {
      type: Boolean,
      default: false,
    },

    order: {
      type: Number,
      default: 0,
    },
  },
  { _id: true }
);

const answerSchema = new mongoose.Schema(
  {
    question: {
      type: mongoose.Schema.Types.ObjectId,
      required: [true, 'An answer must reference a question'],
    },

    // Numeric for rating/scale, string for text/choice/yes-no, array for
    // multi-choice. Mixed rather than five nullable columns.
    value: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { _id: false }
);

const responseSchema = new mongoose.Schema(
  {
    /**
     * HMAC(surveyId + respondentId, ANON_SECRET). Never the id itself.
     */
    respondentKey: {
      type: String,
      required: [true, 'A respondent key is required'],
      trim: true,
    },

    /**
     * Populated only for a survey explicitly created as non-anonymous. On an
     * anonymous survey this field is never written, so there is nothing for a
     * later query to find.
     */
    respondent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    /**
     * The respondent's role, kept so results can be split by audience.
     *
     * Deliberately not the class: in a school with one section per year, a class
     * plus a role identifies a small enough group to make the anonymity claim
     * false, which is the same disclosure the release threshold exists to stop.
     */
    audienceRole: {
      type: String,
      trim: true,
      maxlength: [20, 'Audience role cannot exceed 20 characters'],
      default: '',
    },

    answers: {
      type: [answerSchema],
      default: [],
    },

    submittedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const feedbackSurveySchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Survey title is required'],
      trim: true,
      maxlength: [150, 'Title cannot exceed 150 characters'],
    },

    description: {
      type: String,
      trim: true,
      maxlength: [1000, 'Description cannot exceed 1000 characters'],
      default: '',
    },

    type: {
      type: String,
      enum: {
        values: SURVEY_TYPES,
        message: 'Invalid survey type',
      },
      default: 'course',
    },

    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      default: null,
    },

    courseName: {
      type: String,
      trim: true,
      maxlength: [120, 'Course name cannot exceed 120 characters'],
      default: '',
    },

    teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    teacherName: {
      type: String,
      trim: true,
      maxlength: [100, 'Teacher name cannot exceed 100 characters'],
      default: '',
    },

    audience: {
      type: String,
      enum: {
        values: AUDIENCES,
        message: 'Invalid audience',
      },
      default: 'students',
    },

    targetClasses: {
      type: [String],
      default: [],
    },

    opensAt: {
      type: Date,
      required: [true, 'An opening date is required'],
    },

    closesAt: {
      type: Date,
      required: [true, 'A closing date is required'],
      validate: {
        validator(value) {
          return !this.opensAt || value > this.opensAt;
        },
        message: 'The closing date must be after the opening date',
      },
    },

    anonymous: {
      type: Boolean,
      default: true,
    },

    /**
     * Results stay sealed until this many responses are in.
     *
     * Anonymity fails at small n whatever is stored: in a class of three, "one
     * respondent rated this 1/5" is attributable by anybody who knows the class.
     * The threshold binds the survey's own author too — a teacher reading their
     * own two responses is exactly the disclosure it exists to prevent, and
     * "but it is their survey" is how this control gets quietly removed.
     */
    minResponsesToRelease: {
      type: Number,
      default: 5,
      min: [2, 'A release threshold below two provides no protection at all'],
      max: [100, 'A threshold above one hundred would seal most surveys forever'],
    },

    questions: {
      type: [questionSchema],
      default: [],
      validate: {
        validator(values) {
          return Array.isArray(values) && values.length > 0;
        },
        message: 'A survey needs at least one question',
      },
    },

    responses: {
      type: [responseSchema],
      default: [],
    },

    status: {
      type: String,
      enum: {
        values: SURVEY_STATUSES,
        message: 'Invalid survey status',
      },
      default: 'draft',
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'The author is required'],
    },

    createdByName: {
      type: String,
      trim: true,
      maxlength: [100, 'Author name cannot exceed 100 characters'],
      default: '',
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

feedbackSurveySchema.index({ status: 1, opensAt: 1, closesAt: 1 });
feedbackSurveySchema.index({ createdBy: 1, createdAt: -1 });
feedbackSurveySchema.index({ course: 1 });
feedbackSurveySchema.index({ 'responses.respondentKey': 1 });

feedbackSurveySchema.virtual('responseCount').get(function () {
  return this.responses.length;
});

feedbackSurveySchema.virtual('isOpen').get(function () {
  const now = Date.now();
  return (
    this.status === 'open' && this.opensAt.getTime() <= now && this.closesAt.getTime() >= now
  );
});

feedbackSurveySchema.virtual('resultsReleased').get(function () {
  return this.responses.length >= this.minResponsesToRelease;
});

/**
 * The respondent key for a given survey and user.
 *
 * Falls back to `JWT_SECRET` when `ANON_SECRET` is unset so the module works
 * out of the box. Setting a separate secret is worth doing: rotating it is what
 * invalidates every historical key, and it means an incident affecting the auth
 * secret does not also hand somebody the ability to de-anonymise past feedback.
 */
feedbackSurveySchema.statics.respondentKeyFor = function (surveyId, userId) {
  const secret = process.env.ANON_SECRET || process.env.JWT_SECRET || 'anon-fallback-secret';
  return crypto
    .createHmac('sha256', secret)
    .update(`${String(surveyId)}:${String(userId)}`)
    .digest('hex');
};

/**
 * Why this user cannot submit, or null when they can.
 */
feedbackSurveySchema.methods.submissionError = function (user) {
  if (this.status === 'draft') return 'This survey has not been published yet.';
  if (this.status === 'closed') return 'This survey is closed.';

  const now = Date.now();
  if (this.opensAt.getTime() > now) {
    return `This survey opens on ${this.opensAt.toISOString().slice(0, 10)}.`;
  }
  if (this.closesAt.getTime() < now) {
    return `This survey closed on ${this.closesAt.toISOString().slice(0, 10)}.`;
  }

  if (!this.isForAudience(user)) return 'This survey is not addressed to you.';

  return null;
};

feedbackSurveySchema.methods.isForAudience = function (user) {
  if (this.audience === 'all') return true;

  const role = user.role;
  const matchesRole =
    (this.audience === 'students' && role === 'student') ||
    (this.audience === 'teachers' && role === 'teacher') ||
    (this.audience === 'parents' && role === 'staff');

  if (!matchesRole) return false;

  if (this.targetClasses.length > 0 && user.className) {
    return this.targetClasses.includes(user.className);
  }
  return true;
};

feedbackSurveySchema.methods.isOwnedBy = function (user) {
  return String(this.createdBy) === String(user._id) || user.role === 'admin';
};

/**
 * Validate a submitted answer set against the question list.
 *
 * Returns an error message or null. Done here rather than in the controller so
 * the rules live next to the questions they are about.
 */
feedbackSurveySchema.methods.validateAnswers = function (answers) {
  if (!Array.isArray(answers)) return 'answers must be an array.';

  const byId = {};
  this.questions.forEach((question) => {
    byId[String(question._id)] = question;
  });

  const seen = new Set();

  for (const answer of answers) {
    const question = byId[String(answer.question)];
    if (!question) return `Answer refers to a question that is not on this survey.`;
    if (seen.has(String(answer.question))) {
      return `Two answers were given for "${question.prompt}".`;
    }
    seen.add(String(answer.question));

    const value = answer.value;

    if (question.type === 'rating') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        return `"${question.prompt}" expects a whole number from 1 to 5.`;
      }
    } else if (question.type === 'scale') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 10) {
        return `"${question.prompt}" expects a whole number from 1 to 10.`;
      }
    } else if (question.type === 'yes-no') {
      if (!['yes', 'no'].includes(value)) {
        return `"${question.prompt}" expects "yes" or "no".`;
      }
    } else if (question.type === 'single-choice') {
      if (!question.options.includes(value)) {
        return `"${value}" is not one of the options for "${question.prompt}".`;
      }
    } else if (question.type === 'multi-choice') {
      if (!Array.isArray(value) || value.some((item) => !question.options.includes(item))) {
        return `"${question.prompt}" expects a list drawn from its options.`;
      }
    } else if (question.type === 'text') {
      if (typeof value !== 'string' || value.length > 2000) {
        return `"${question.prompt}" expects text of up to 2000 characters.`;
      }
    }
  }

  const missing = this.questions.filter(
    (question) => question.required && !seen.has(String(question._id))
  );
  if (missing.length > 0) {
    return `These questions are required: ${missing.map((q) => q.prompt).join('; ')}`;
  }

  return null;
};

/**
 * Server-side aggregation.
 *
 * Text answers come back shuffled. Their order in storage is submission order,
 * and submission order combined with knowing roughly when somebody filled the
 * form in is enough to attribute a comment — anonymity that leaks through
 * sequence position is not anonymity.
 */
feedbackSurveySchema.methods.aggregate = function () {
  const byQuestion = this.questions
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((question) => {
      const values = [];
      this.responses.forEach((response) => {
        const answer = response.answers.find(
          (item) => String(item.question) === String(question._id)
        );
        if (answer && answer.value !== null && answer.value !== undefined) {
          values.push(answer.value);
        }
      });

      const result = {
        questionId: question._id,
        prompt: question.prompt,
        type: question.type,
        answered: values.length,
        skipped: this.responses.length - values.length,
      };

      if (NUMERIC_TYPES.includes(question.type)) {
        const numbers = values.map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
        const max = question.type === 'rating' ? 5 : 10;

        result.max = max;
        result.mean =
          numbers.length > 0
            ? Math.round((numbers.reduce((sum, n) => sum + n, 0) / numbers.length) * 100) / 100
            : null;
        result.median =
          numbers.length > 0
            ? numbers.length % 2 === 1
              ? numbers[(numbers.length - 1) / 2]
              : (numbers[numbers.length / 2 - 1] + numbers[numbers.length / 2]) / 2
            : null;

        const distribution = {};
        for (let i = 1; i <= max; i += 1) distribution[i] = 0;
        numbers.forEach((n) => {
          distribution[n] = (distribution[n] || 0) + 1;
        });
        result.distribution = distribution;
      } else if (question.type === 'yes-no') {
        result.distribution = {
          yes: values.filter((v) => v === 'yes').length,
          no: values.filter((v) => v === 'no').length,
        };
      } else if (['single-choice', 'multi-choice'].includes(question.type)) {
        const distribution = {};
        question.options.forEach((option) => {
          distribution[option] = 0;
        });
        values.forEach((value) => {
          const picks = Array.isArray(value) ? value : [value];
          picks.forEach((pick) => {
            distribution[pick] = (distribution[pick] || 0) + 1;
          });
        });
        result.distribution = distribution;
      } else if (question.type === 'text') {
        const texts = values.filter((v) => typeof v === 'string' && v.trim());
        // Fisher-Yates, so what comes back carries no ordering information.
        for (let i = texts.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          [texts[i], texts[j]] = [texts[j], texts[i]];
        }
        result.responses = texts;
      }

      return result;
    });

  const byRole = {};
  this.responses.forEach((response) => {
    const role = response.audienceRole || 'unknown';
    byRole[role] = (byRole[role] || 0) + 1;
  });

  return {
    responseCount: this.responses.length,
    byRole,
    questions: byQuestion,
  };
};

/**
 * The survey without its responses, for anybody who is about to fill it in.
 */
feedbackSurveySchema.methods.formFor = function () {
  return {
    _id: this._id,
    title: this.title,
    description: this.description,
    type: this.type,
    courseName: this.courseName,
    teacherName: this.teacherName,
    audience: this.audience,
    opensAt: this.opensAt,
    closesAt: this.closesAt,
    anonymous: this.anonymous,
    minResponsesToRelease: this.minResponsesToRelease,
    status: this.status,
    createdByName: this.createdByName,
    responseCount: this.responses.length,
    questions: this.questions
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((question) => ({
        _id: question._id,
        prompt: question.prompt,
        type: question.type,
        options: question.options,
        required: question.required,
        order: question.order,
      })),
  };
};

feedbackSurveySchema.statics.SURVEY_TYPES = SURVEY_TYPES;
feedbackSurveySchema.statics.SURVEY_STATUSES = SURVEY_STATUSES;
feedbackSurveySchema.statics.AUDIENCES = AUDIENCES;
feedbackSurveySchema.statics.QUESTION_TYPES = QUESTION_TYPES;

module.exports = mongoose.model('FeedbackSurvey', feedbackSurveySchema);
