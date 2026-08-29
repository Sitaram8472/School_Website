const mongoose = require('mongoose');

const KnowledgeArticle = require('../models/KnowledgeArticle');
const { KnowledgeArticleVote } = require('../models/KnowledgeArticle');

/**
 * Knowledge articles.
 *
 * Two handlers carry the feature.
 *
 * `publishArticle` is where the workflow gets its meaning: it refuses to let
 * the author publish their own answer. `updateArticle` is its other half — it
 * goes through `applyEdit`, which freezes the wording that is currently live
 * into `revisions[]` before the new text lands, so what a family was shown
 * last term still exists. Everything else is bookkeeping around those two.
 *
 * `listPublic` is the one that has to be careful, because it answers without a
 * session. Every read path narrows by `KnowledgeArticle.audiencesFor(req.user)`
 * and projects through `toPublicRow`, which carries no author, no history and
 * no revisions — so an unauthenticated caller cannot widen the audience by
 * asking nicely.
 */

const MAX_LIST = 200;

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

function serverError(res, error, message) {
  console.error(`${message}:`, error);
  return res.status(500).json({
    success: false,
    message,
    error: error.message,
  });
}

function validationMessage(error) {
  if (!error) return null;
  if (error.name === 'ValidationError') {
    return Object.values(error.errors)
      .map((e) => e.message)
      .join(' ');
  }
  if (error.name === 'ValidatorError' || error.name === 'CastError') {
    return error.message;
  }
  return null;
}

function duplicateMessage(error) {
  if (error && error.code === 11000) {
    return 'Another live article already uses that slug';
  }
  return null;
}

function clean(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function isEditor(user) {
  return user && ['teacher', 'staff', 'admin'].includes(user.role);
}

/**
 * The audiences this caller may read, and nothing wider. An anonymous visitor
 * gets `['public']`, which is what makes the read routes safe unguarded.
 */
function audienceFilter(req) {
  return { $in: KnowledgeArticle.audiencesFor(req.user) };
}

/**
 * GET /api/knowledge-articles/meta
 */
exports.getMeta = async (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      statuses: KnowledgeArticle.STATUSES,
      categories: KnowledgeArticle.CATEGORIES,
      audiences: KnowledgeArticle.AUDIENCES,
      readableAudiences: KnowledgeArticle.audiencesFor(req.user),
      defaultReviewMonths: KnowledgeArticle.DEFAULT_REVIEW_MONTHS,
      canEdit: isEditor(req.user),
      canPublish: !!(req.user && req.user.role === 'admin'),
    },
  });
};

/**
 * GET /api/knowledge-articles
 *
 * Public. Published articles only, narrowed to what this caller may read.
 */
exports.listPublic = async (req, res) => {
  try {
    const query = {
      status: 'published',
      audience: audienceFilter(req),
    };

    if (req.query.category) {
      if (!KnowledgeArticle.CATEGORIES.includes(req.query.category)) {
        return fail(res, 400, 'Invalid category');
      }
      query.category = req.query.category;
    }

    const articles = await KnowledgeArticle.find(query)
      .sort({ category: 1, question: 1 })
      .limit(MAX_LIST);

    const categories = {};
    for (const article of articles) {
      categories[article.category] = (categories[article.category] || 0) + 1;
    }

    return res.status(200).json({
      success: true,
      count: articles.length,
      data: articles.map((article) => article.toPublicRow()),
      categories,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the help centre');
  }
};

/**
 * GET /api/knowledge-articles/search?q=
 *
 * Matches against the derived `keywords` array rather than a text index. A
 * text index is a deployment step, and a help centre that only works once
 * somebody has remembered to run one is a help centre that does not work.
 */
exports.searchArticles = async (req, res) => {
  try {
    const term = clean(req.query.q);
    if (!term) return fail(res, 400, 'Give something to search for');

    const words = term
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2);

    const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const articles = await KnowledgeArticle.find({
      status: 'published',
      audience: audienceFilter(req),
      $or: [
        { keywords: { $in: words } },
        { question: new RegExp(safe, 'i') },
      ],
    })
      .limit(50)
      .sort({ helpful: -1 });

    // Ranked by how many of the searched words each article actually carries,
    // so a two-word match sorts above a one-word one.
    const ranked = articles
      .map((article) => ({
        article,
        hits: words.filter((word) => article.keywords.includes(word)).length,
      }))
      .sort((a, b) => b.hits - a.hits)
      .map((row) => row.article.toPublicRow());

    return res.status(200).json({
      success: true,
      count: ranked.length,
      data: ranked,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to search the help centre');
  }
};

/**
 * GET /api/knowledge-articles/digest
 *
 * The published corpus in the plain-text shape `data/knowledgeBase.js`
 * produces. Exposed so the assistant can be pointed at a reviewed, dated
 * corpus later by changing one `require`, without this change having to touch
 * `chatController.js` now.
 */
exports.getDigest = async (req, res) => {
  try {
    const digest = await KnowledgeArticle.buildDigest(
      KnowledgeArticle.audiencesFor(req.user)
    );

    return res.status(200).json({
      success: true,
      data: {
        digest,
        characters: digest.length,
        generatedAt: new Date(),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build the knowledge digest');
  }
};

/**
 * GET /api/knowledge-articles/slug/:slug
 *
 * Counts a view with an atomic `$inc` rather than a read-modify-write, so two
 * readers arriving together are two views.
 */
exports.getBySlug = async (req, res) => {
  try {
    const slug = clean(req.params.slug).toLowerCase();

    const article = await KnowledgeArticle.findOne({
      slug,
      status: 'published',
      audience: audienceFilter(req),
    });

    if (!article) return fail(res, 404, 'No published answer with that name');

    await KnowledgeArticle.updateOne({ _id: article._id }, { $inc: { views: 1 } });

    return res.status(200).json({
      success: true,
      data: article.toPublicRow(),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the article');
  }
};

/**
 * POST /api/knowledge-articles/slug/:slug/rate
 *
 * One verdict per reader. The vote is a row with a unique compound index
 * behind it rather than a bare `$inc`, so pressing the button twice changes a
 * mind instead of stuffing the ballot.
 */
exports.rateArticle = async (req, res) => {
  try {
    const slug = clean(req.params.slug).toLowerCase();
    const voterKey = clean(req.body.voterKey);
    const helpful = req.body.helpful === true || req.body.helpful === 'true';

    if (!voterKey) return fail(res, 400, 'A voter key is required');

    const article = await KnowledgeArticle.findOne({
      slug,
      status: 'published',
      audience: audienceFilter(req),
    });

    if (!article) return fail(res, 404, 'No published answer with that name');

    const existing = await KnowledgeArticleVote.findOne({
      article: article._id,
      voterKey,
    });

    if (existing) {
      if (existing.helpful === helpful) {
        return res.status(200).json({
          success: true,
          message: 'Your feedback was already recorded',
          data: article.toPublicRow(),
        });
      }

      // A changed mind moves one count to the other rather than adding a
      // second vote.
      existing.helpful = helpful;
      await existing.save();

      await KnowledgeArticle.updateOne(
        { _id: article._id },
        helpful
          ? { $inc: { helpful: 1, unhelpful: -1 } }
          : { $inc: { helpful: -1, unhelpful: 1 } }
      );
    } else {
      await KnowledgeArticleVote.create({ article: article._id, voterKey, helpful });

      await KnowledgeArticle.updateOne(
        { _id: article._id },
        helpful ? { $inc: { helpful: 1 } } : { $inc: { unhelpful: 1 } }
      );
    }

    const updated = await KnowledgeArticle.findById(article._id);

    return res.status(200).json({
      success: true,
      message: 'Thank you — that helps us keep this accurate',
      data: updated.toPublicRow(),
    });
  } catch (error) {
    // Two clicks racing on the same key: the index is the guard, and the right
    // answer is still "recorded", not an error the reader has to interpret.
    if (error.code === 11000) {
      return res.status(200).json({
        success: true,
        message: 'Your feedback was already recorded',
      });
    }

    return serverError(res, error, 'Failed to record your feedback');
  }
};

/**
 * GET /api/knowledge-articles/manage
 *
 * Everything, any status, for the people who maintain it.
 */
exports.listAll = async (req, res) => {
  try {
    const query = {};

    if (req.query.status) {
      if (!KnowledgeArticle.STATUSES.includes(req.query.status)) {
        return fail(res, 400, 'Invalid status filter');
      }
      query.status = req.query.status;
    }

    if (req.query.category) {
      query.category = req.query.category;
    }

    const articles = await KnowledgeArticle.find(query)
      .sort({ updatedAt: -1 })
      .limit(MAX_LIST);

    return res.status(200).json({
      success: true,
      count: articles.length,
      data: articles.map((article) => article.toRow()),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load articles');
  }
};

/**
 * GET /api/knowledge-articles/stale
 *
 * What is past its review date. An answer with no owner and no review date is
 * how a fee figure from two years ago ends up being quoted as fact.
 */
exports.listStale = async (req, res) => {
  try {
    const now = new Date();
    const soon = new Date(now.getTime() + 30 * 86400000);

    const [overdue, dueSoon] = await Promise.all([
      KnowledgeArticle.find({ status: 'published', reviewDueAt: { $lt: now } })
        .sort({ reviewDueAt: 1 })
        .limit(MAX_LIST),
      KnowledgeArticle.find({
        status: 'published',
        reviewDueAt: { $gte: now, $lt: soon },
      })
        .sort({ reviewDueAt: 1 })
        .limit(MAX_LIST),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        overdue: overdue.map((article) => article.toRow()),
        dueSoon: dueSoon.map((article) => article.toRow()),
        generatedAt: now,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the review queue');
  }
};

/**
 * POST /api/knowledge-articles
 */
exports.createArticle = async (req, res) => {
  try {
    const question = clean(req.body.question);
    const answer = clean(req.body.answer);

    if (!question) return fail(res, 400, 'A question is required');
    if (!answer) return fail(res, 400, 'An answer is required');

    const slug = clean(req.body.slug).toLowerCase() || KnowledgeArticle.slugify(question);
    if (!slug) return fail(res, 400, 'That question does not produce a usable slug');

    const article = new KnowledgeArticle({
      slug,
      question,
      answer,
      summary: clean(req.body.summary),
      category: clean(req.body.category, 'general'),
      audience: clean(req.body.audience, 'public'),
      tags: Array.isArray(req.body.tags)
        ? req.body.tags.map((tag) => clean(tag)).filter(Boolean).slice(0, 12)
        : [],
      status: 'draft',
      authoredBy: req.user._id,
      authoredByName: req.user.name || '',
    });

    article.log('created', req.user);
    await article.save();

    return res.status(201).json({
      success: true,
      message: 'Draft saved. Somebody other than you has to publish it.',
      data: article.toRow(),
    });
  } catch (error) {
    const duplicate = duplicateMessage(error);
    if (duplicate) return fail(res, 409, duplicate);

    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 400, message);

    return serverError(res, error, 'Failed to create the article');
  }
};

/**
 * PATCH /api/knowledge-articles/:id
 *
 * The edit goes through `applyEdit` rather than through field assignment here,
 * because the wording that is currently live has to be frozen into
 * `revisions[]` *before* the new text lands on the document — after that, it is
 * gone. Editing something live also sends it back into review rather than
 * changing the site silently; an answer that has to come down immediately is
 * archived instead, which needs no reviewer.
 */
exports.updateArticle = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid article id');

    const article = await KnowledgeArticle.findById(id);
    if (!article) return fail(res, 404, 'Article not found');

    if (article.status === 'archived') {
      return fail(res, 409, 'An archived article cannot be edited. Restore it first');
    }

    const wasLive = article.status === 'published';
    const changes = { note: clean(req.body.note) };

    if (req.body.question !== undefined) changes.question = clean(req.body.question);
    if (req.body.answer !== undefined) changes.answer = clean(req.body.answer);
    if (req.body.summary !== undefined) changes.summary = clean(req.body.summary);
    if (req.body.category !== undefined) changes.category = clean(req.body.category);
    if (req.body.audience !== undefined) changes.audience = clean(req.body.audience);
    if (req.body.slug !== undefined) changes.slug = clean(req.body.slug).toLowerCase();

    if (Array.isArray(req.body.tags)) {
      changes.tags = req.body.tags.map((tag) => clean(tag)).filter(Boolean).slice(0, 12);
    }

    article.applyEdit(req.user, changes);
    await article.save();

    return res.status(200).json({
      success: true,
      message: wasLive
        ? `Saved as version ${article.version}. It has come off the site until somebody publishes it again.`
        : 'Article updated',
      data: article.toRow(),
    });
  } catch (error) {
    const duplicate = duplicateMessage(error);
    if (duplicate) return fail(res, 409, duplicate);

    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 400, message);

    return serverError(res, error, 'Failed to update the article');
  }
};

/**
 * PATCH /api/knowledge-articles/:id/submit
 */
exports.submitArticle = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid article id');

    const article = await KnowledgeArticle.findById(id);
    if (!article) return fail(res, 404, 'Article not found');

    article.submitForReview(req.user);
    await article.save();

    return res.status(200).json({
      success: true,
      message: 'Sent for review',
      data: article.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 409, message);
    return serverError(res, error, 'Failed to submit the article');
  }
};

/**
 * PATCH /api/knowledge-articles/:id/publish
 *
 * The rule that makes a published answer mean something: not the person who
 * wrote it. Enforced here and again in the model, because a rule that lives in
 * one place is a rule that a second code path will eventually walk around.
 */
exports.publishArticle = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid article id');

    const article = await KnowledgeArticle.findById(id);
    if (!article) return fail(res, 404, 'Article not found');

    if (article.authoredBy && String(article.authoredBy) === String(req.user._id)) {
      return fail(
        res,
        409,
        'You wrote this answer, so somebody else has to publish it'
      );
    }

    article.publish(req.user, req.body.reviewDueAt);
    await article.save();

    return res.status(200).json({
      success: true,
      message: `Published as version ${article.version}`,
      data: article.toRow(),
    });
  } catch (error) {
    const duplicate = duplicateMessage(error);
    if (duplicate) return fail(res, 409, duplicate);

    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 409, message);

    return serverError(res, error, 'Failed to publish the article');
  }
};

/**
 * PATCH /api/knowledge-articles/:id/archive
 */
exports.archiveArticle = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid article id');

    const { reason } = req.body;
    if (!reason || !String(reason).trim()) {
      return fail(res, 400, 'An archive reason is required');
    }

    const article = await KnowledgeArticle.findById(id);
    if (!article) return fail(res, 404, 'Article not found');

    article.archive(req.user, reason);
    await article.save();

    return res.status(200).json({
      success: true,
      message: 'Article archived and removed from the site',
      data: article.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 409, message);
    return serverError(res, error, 'Failed to archive the article');
  }
};

/**
 * PATCH /api/knowledge-articles/:id/restore
 *
 * Back to draft rather than straight to live, because restoring something to
 * the public site without anybody reading it again is the failure this whole
 * workflow exists to avoid.
 */
exports.restoreArticle = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid article id');

    const article = await KnowledgeArticle.findById(id);
    if (!article) return fail(res, 404, 'Article not found');

    const clash = await KnowledgeArticle.findOne({
      slug: article.slug,
      isLive: true,
      _id: { $ne: article._id },
    });

    if (clash) {
      return fail(
        res,
        409,
        'A live article has taken that slug since this one was archived. Change its slug first'
      );
    }

    article.restore(req.user);
    await article.save();

    return res.status(200).json({
      success: true,
      message: 'Restored as a draft',
      data: article.toRow(),
    });
  } catch (error) {
    const duplicate = duplicateMessage(error);
    if (duplicate) return fail(res, 409, duplicate);

    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 409, message);

    return serverError(res, error, 'Failed to restore the article');
  }
};

/**
 * GET /api/knowledge-articles/:id
 *
 * The full record, revisions and history included. Staff only — this is the
 * view `toPublicRow` deliberately does not give.
 */
exports.getArticle = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid article id');

    const article = await KnowledgeArticle.findById(id)
      .populate('authoredBy', 'name email')
      .populate('publishedBy', 'name')
      .populate('history.by', 'name');

    if (!article) return fail(res, 404, 'Article not found');

    return res.status(200).json({
      success: true,
      data: {
        ...article.toRow(),
        revisions: article.revisions,
        history: article.history,
        authoredBy: article.authoredBy,
        publishedBy: article.publishedBy,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the article');
  }
};
