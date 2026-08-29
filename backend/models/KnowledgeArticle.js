const mongoose = require('mongoose');

/**
 * One reviewed, dated answer to one question people actually ask.
 *
 * The school's answers currently live in two hard-coded places that do not
 * know about each other: `data/knowledgeBase.js`, a template literal the
 * assistant is instructed to treat as its only source of truth, and the
 * `faqData` array in `FAQ.jsx`. Both are edited by developers, in commits,
 * and neither has an author, an approver or a review date.
 *
 * The comment at the top of `knowledgeBase.js` — "edit this file any time to
 * update what the assistant knows" — is the problem stated plainly. The people
 * who know the answers are the admissions office and the front desk, and
 * editing that file is a commit, a review and a deploy.
 *
 * So the useful properties here are not the fields. They are: somebody owns
 * this answer, somebody else agreed to it, it has a date it must be looked at
 * again, and the version a family was shown last term still exists.
 */

const ARTICLE_STATUSES = ['draft', 'in-review', 'published', 'archived'];

// An article in one of these states still holds its slug. Archiving releases
// it, so a slug can be reused without the old article being deleted.
const LIVE_STATUSES = ['draft', 'in-review', 'published'];

const CATEGORIES = [
  'admissions',
  'fees',
  'academics',
  'campus-life',
  'transport',
  'results',
  'support',
  'general',
];

const AUDIENCES = ['public', 'students', 'parents', 'staff'];

// Who may read which audience. `public` is in every list because an article
// meant for everybody is still meant for the people who are signed in.
const AUDIENCE_BY_ROLE = {
  student: ['public', 'students'],
  teacher: ['public', 'students', 'parents', 'staff'],
  staff: ['public', 'students', 'parents', 'staff'],
  admin: ['public', 'students', 'parents', 'staff'],
};

// Long enough that "yes" is not an article, short enough to stay an answer.
const MIN_ANSWER = 20;
const MAX_ANSWER = 6000;

// A published answer nobody has agreed to keep true is the thing this model
// exists to prevent, so publication always sets a date it comes back for.
const DEFAULT_REVIEW_MONTHS = 12;

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

/**
 * A frozen copy of what was published before the current wording.
 *
 * Republishing is versioned rather than destructive, because "that is not what
 * your site said in March" is only answerable if March still exists.
 */
const revisionSchema = new mongoose.Schema(
  {
    version: {
      type: Number,
      required: true,
    },
    question: {
      type: String,
      trim: true,
      default: '',
    },
    answer: {
      type: String,
      trim: true,
      default: '',
    },
    publishedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    publishedByName: {
      type: String,
      trim: true,
      default: '',
    },
    publishedAt: {
      type: Date,
    },
    supersededAt: {
      type: Date,
      default: Date.now,
    },
    note: {
      type: String,
      trim: true,
      maxlength: [300, 'Revision note cannot exceed 300 characters'],
      default: '',
    },
  },
  { _id: false }
);

const knowledgeArticleSchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: [true, 'A slug is required'],
      trim: true,
      lowercase: true,
      maxlength: [120, 'Slug cannot exceed 120 characters'],
      match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'A slug may only hold lowercase words and hyphens'],
    },

    question: {
      type: String,
      required: [true, 'A question is required'],
      trim: true,
      maxlength: [300, 'Question cannot exceed 300 characters'],
    },

    answer: {
      type: String,
      required: [true, 'An answer is required'],
      trim: true,
      minlength: [MIN_ANSWER, `An answer needs at least ${MIN_ANSWER} characters`],
      maxlength: [MAX_ANSWER, `An answer cannot exceed ${MAX_ANSWER} characters`],
    },

    // The one-line version, used in listings and in the assistant's digest
    // where the full answer would swamp the prompt.
    summary: {
      type: String,
      trim: true,
      maxlength: [300, 'Summary cannot exceed 300 characters'],
      default: '',
    },

    category: {
      type: String,
      enum: {
        values: CATEGORIES,
        message: 'Invalid category',
      },
      default: 'general',
    },

    tags: {
      type: [String],
      default: [],
      validate: {
        validator: (tags) => tags.length <= 12,
        message: 'An article cannot carry more than 12 tags',
      },
    },

    /**
     * Derived from the question and the tags on save.
     *
     * Search works off this rather than a text index, because a text index is
     * a deployment step and a help centre that only works after somebody
     * remembers to run one is a help centre that does not work.
     */
    keywords: {
      type: [String],
      default: [],
    },

    audience: {
      type: String,
      enum: {
        values: AUDIENCES,
        message: 'Invalid audience',
      },
      default: 'public',
    },

    status: {
      type: String,
      enum: {
        values: ARTICLE_STATUSES,
        message: 'Invalid article status',
      },
      default: 'draft',
    },

    /**
     * Derived from `status` in `pre('save')`. MongoDB refuses `$ne` inside a
     * `partialFilterExpression`, so "unique slug among articles that are not
     * archived" has to be expressed as an equality on a flag.
     */
    isLive: {
      type: Boolean,
      default: true,
    },

    version: {
      type: Number,
      default: 1,
      min: [1, 'Version starts at 1'],
    },

    revisions: {
      type: [revisionSchema],
      default: [],
    },

    authoredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    authoredByName: {
      type: String,
      trim: true,
      maxlength: [100, 'Author name cannot exceed 100 characters'],
      default: '',
    },

    submittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    submittedAt: {
      type: Date,
    },

    publishedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    publishedByName: {
      type: String,
      trim: true,
      maxlength: [100, 'Publisher name cannot exceed 100 characters'],
      default: '',
    },

    publishedAt: {
      type: Date,
    },

    /** When this answer has to be looked at again. */
    reviewDueAt: {
      type: Date,
    },

    archivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    archivedAt: {
      type: Date,
    },

    archiveReason: {
      type: String,
      trim: true,
      maxlength: [300, 'Archive reason cannot exceed 300 characters'],
      default: '',
    },

    views: {
      type: Number,
      default: 0,
      min: 0,
    },

    helpful: {
      type: Number,
      default: 0,
      min: 0,
    },

    unhelpful: {
      type: Number,
      default: 0,
      min: 0,
    },

    history: {
      type: [historyEntrySchema],
      default: [],
    },
  },
  { timestamps: true }
);

// Unique among live articles only, so an archived article does not hold its
// slug hostage forever.
knowledgeArticleSchema.index(
  { slug: 1 },
  { unique: true, partialFilterExpression: { isLive: true } }
);

// The public list reads published articles by audience and category; the
// review queue reads by due date.
knowledgeArticleSchema.index({ status: 1, audience: 1, category: 1 });
knowledgeArticleSchema.index({ status: 1, reviewDueAt: 1 });
knowledgeArticleSchema.index({ keywords: 1 });

knowledgeArticleSchema.virtual('isStale').get(function isStale() {
  if (this.status !== 'published' || !this.reviewDueAt) return false;
  return this.reviewDueAt.getTime() < Date.now();
});

knowledgeArticleSchema.virtual('helpfulRate').get(function helpfulRate() {
  const total = this.helpful + this.unhelpful;
  if (!total) return null;
  return Math.round((this.helpful / total) * 1000) / 10;
});

knowledgeArticleSchema.set('toJSON', { virtuals: true });
knowledgeArticleSchema.set('toObject', { virtuals: true });

knowledgeArticleSchema.methods.log = function log(action, actor, note = '') {
  this.history.push({
    action,
    by: actor ? actor._id : undefined,
    byName: (actor && actor.name) || '',
    at: new Date(),
    note,
  });

  return this;
};

knowledgeArticleSchema.methods.submitForReview = function submitForReview(actor) {
  if (this.status === 'archived') {
    throw new Error('An archived article cannot be submitted for review');
  }
  if (this.status === 'in-review') {
    throw new Error('This article is already waiting for review');
  }

  this.status = 'in-review';
  this.submittedBy = actor ? actor._id : undefined;
  this.submittedAt = new Date();

  return this.log('submitted', actor);
};

/**
 * Change the wording.
 *
 * The snapshot has to be taken *here*, before the new text is assigned, which
 * is the whole reason editing goes through a method rather than through field
 * assignment in the controller. By the time a `pre('save')` hook runs, the
 * wording that was live is already gone from the document.
 *
 * Editing something that is live also takes it back into review rather than
 * changing the site silently. An answer that needs to come down *now* — a
 * wrong fee figure — is archived, which is immediate and needs no reviewer.
 */
knowledgeArticleSchema.methods.applyEdit = function applyEdit(actor, changes = {}) {
  if (this.status === 'archived') {
    throw new Error('An archived article cannot be edited; restore it first');
  }

  const wasLive = this.status === 'published';

  if (wasLive) {
    this.revisions.push({
      version: this.version,
      question: this.question,
      answer: this.answer,
      publishedBy: this.publishedBy,
      publishedByName: this.publishedByName,
      publishedAt: this.publishedAt,
      supersededAt: new Date(),
      note: 'superseded by an edit',
    });

    this.version += 1;
    this.status = 'in-review';
  }

  const editable = ['question', 'answer', 'summary', 'category', 'audience', 'slug', 'tags'];

  for (const field of editable) {
    if (changes[field] !== undefined) {
      this[field] = changes[field];
    }
  }

  this.log(wasLive ? 'edited, back to review' : 'edited', actor, changes.note || '');

  return this;
};

/**
 * Publication.
 *
 * Two rules make this mean something. The publisher may not be the author —
 * the same two-person rule the fee module applies to money, applied here to a
 * public statement — and a live article is not republished over the top of
 * itself: it goes back through `applyEdit`, which freezes what was live first.
 */
knowledgeArticleSchema.methods.publish = function publish(actor, reviewDueAt) {
  if (this.status === 'archived') {
    throw new Error('An archived article cannot be published; restore it first');
  }
  if (this.status === 'published') {
    throw new Error('This article is already published. Edit it to change what it says');
  }
  if (!actor || !actor._id) {
    throw new Error('A publisher is required');
  }
  if (this.authoredBy && String(this.authoredBy) === String(actor._id)) {
    throw new Error('An article cannot be published by the person who wrote it');
  }

  const due = reviewDueAt ? new Date(reviewDueAt) : null;

  if (due && Number.isNaN(due.getTime())) {
    throw new Error('The review date is not a valid date');
  }
  if (due && due.getTime() <= Date.now()) {
    throw new Error('A review date has to be in the future');
  }

  this.status = 'published';
  this.publishedBy = actor._id;
  this.publishedByName = actor.name || '';
  this.publishedAt = new Date();
  this.reviewDueAt =
    due ||
    new Date(
      new Date().setMonth(new Date().getMonth() + DEFAULT_REVIEW_MONTHS)
    );

  return this.log('published', actor, `v${this.version}`);
};

knowledgeArticleSchema.methods.archive = function archive(actor, reason) {
  if (this.status === 'archived') {
    throw new Error('This article is already archived');
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('An archive reason is required');
  }

  this.status = 'archived';
  this.archivedBy = actor ? actor._id : undefined;
  this.archivedAt = new Date();
  this.archiveReason = String(reason).trim();

  return this.log('archived', actor, this.archiveReason);
};

/**
 * Bring an archived article back, as a draft rather than straight to live.
 * Restoring something to the public site without anybody reading it again is
 * the failure this whole workflow is trying to avoid.
 */
knowledgeArticleSchema.methods.restore = function restore(actor) {
  if (this.status !== 'archived') {
    throw new Error('Only an archived article can be restored');
  }

  this.status = 'draft';
  this.archivedBy = undefined;
  this.archivedAt = undefined;
  this.archiveReason = '';

  return this.log('restored', actor);
};

/**
 * What a member of the public sees. Deliberately narrow: no author, no
 * history, no revisions, no internal notes.
 */
knowledgeArticleSchema.methods.toPublicRow = function toPublicRow() {
  return {
    _id: this._id,
    slug: this.slug,
    question: this.question,
    answer: this.answer,
    summary: this.summary,
    category: this.category,
    tags: this.tags,
    version: this.version,
    publishedAt: this.publishedAt,
    helpful: this.helpful,
    unhelpful: this.unhelpful,
    helpfulRate: this.helpfulRate,
  };
};

/** What a member of staff sees in the management list. */
knowledgeArticleSchema.methods.toRow = function toRow() {
  return {
    ...this.toPublicRow(),
    audience: this.audience,
    status: this.status,
    authoredBy: this.authoredBy,
    authoredByName: this.authoredByName,
    publishedBy: this.publishedBy,
    publishedByName: this.publishedByName,
    reviewDueAt: this.reviewDueAt,
    isStale: this.isStale,
    revisionCount: this.revisions.length,
    views: this.views,
    archiveReason: this.archiveReason,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

/**
 * Derived fields and the invariants that need more than one of them.
 *
 * Mongoose 9 passes no callback to middleware, so this throws rather than
 * calling `next(err)`.
 */
knowledgeArticleSchema.pre('save', function beforeSave() {
  this.isLive = LIVE_STATUSES.includes(this.status);

  // Search keywords are derived, never typed. A person maintaining a keyword
  // list by hand is a person who stops maintaining it.
  const words = `${this.question} ${this.tags.join(' ')} ${this.category}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);

  this.keywords = Array.from(new Set(words)).slice(0, 60);

  if (!this.summary) {
    this.summary = this.answer.slice(0, 200);
  }

  // Archived is terminal for editing. Reading and restoring stay possible;
  // changing the wording of something withdrawn from the site does not.
  if (!this.isNew && this.status === 'archived' && !this.isModified('status')) {
    const frozen = ['question', 'answer', 'summary', 'slug', 'audience', 'category'];
    const edited = frozen.find((field) => this.isModified(field));

    if (edited) {
      throw new Error(`"${edited}" cannot be changed while the article is archived`);
    }
  }

  if (this.status === 'published' && !this.publishedBy) {
    throw new Error('A published article must record who published it');
  }

  if (
    this.status === 'published' &&
    this.authoredBy &&
    this.publishedBy &&
    String(this.authoredBy) === String(this.publishedBy)
  ) {
    throw new Error('An article cannot be published by the person who wrote it');
  }
});

knowledgeArticleSchema.statics.STATUSES = ARTICLE_STATUSES;
knowledgeArticleSchema.statics.LIVE_STATUSES = LIVE_STATUSES;
knowledgeArticleSchema.statics.CATEGORIES = CATEGORIES;
knowledgeArticleSchema.statics.AUDIENCES = AUDIENCES;
knowledgeArticleSchema.statics.AUDIENCE_BY_ROLE = AUDIENCE_BY_ROLE;
knowledgeArticleSchema.statics.DEFAULT_REVIEW_MONTHS = DEFAULT_REVIEW_MONTHS;

/**
 * The audiences a viewer may read. An anonymous visitor gets `public` and
 * nothing else, which is what makes the read routes safe to leave unguarded.
 */
knowledgeArticleSchema.statics.audiencesFor = function audiencesFor(user) {
  if (!user || !user.role) return ['public'];
  return AUDIENCE_BY_ROLE[user.role] || ['public'];
};

/** Turn a question into a slug candidate. */
knowledgeArticleSchema.statics.slugify = function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 110);
};

/**
 * The published corpus rendered in the plain-text shape `data/knowledgeBase.js`
 * produces.
 *
 * This is the point of building it this way round: the assistant can be
 * pointed at a live, reviewed, dated corpus by changing one `require`, with no
 * part of this change having to touch `chatController.js` now.
 */
knowledgeArticleSchema.statics.buildDigest = async function buildDigest(audiences = ['public']) {
  const articles = await this.find({
    status: 'published',
    audience: { $in: audiences },
  })
    .sort({ category: 1, question: 1 })
    .limit(500);

  if (!articles.length) return '';

  const byCategory = new Map();

  for (const article of articles) {
    if (!byCategory.has(article.category)) byCategory.set(article.category, []);
    byCategory.get(article.category).push(article);
  }

  const sections = [];
  let index = 1;

  for (const [category, rows] of byCategory) {
    const heading = `${index}. ${category.replace(/-/g, ' ').toUpperCase()}`;
    const body = rows
      .map((row) => `Q: ${row.question}\nA: ${row.answer}`)
      .join('\n\n');

    sections.push(`${heading}\n${body}`);
    index += 1;
  }

  return sections.join('\n\n');
};

/**
 * One reader's verdict on one article.
 *
 * A counter on its own cannot say "this person has already voted", so the vote
 * is a row with a unique compound index behind it. The key is minted in the
 * browser and kept in local storage: it identifies a browser, not a person,
 * which is the most an unauthenticated help page can honestly claim — and it
 * is enough to stop the same reader pressing the button forty times.
 */
const articleVoteSchema = new mongoose.Schema(
  {
    article: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'KnowledgeArticle',
      required: true,
    },
    voterKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: [80, 'Voter key cannot exceed 80 characters'],
    },
    helpful: {
      type: Boolean,
      required: true,
    },
  },
  { timestamps: true }
);

articleVoteSchema.index({ article: 1, voterKey: 1 }, { unique: true });

const KnowledgeArticle = mongoose.model('KnowledgeArticle', knowledgeArticleSchema);
const KnowledgeArticleVote = mongoose.model('KnowledgeArticleVote', articleVoteSchema);

module.exports = KnowledgeArticle;
module.exports.KnowledgeArticle = KnowledgeArticle;
module.exports.KnowledgeArticleVote = KnowledgeArticleVote;
