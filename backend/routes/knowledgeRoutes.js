const express = require('express');

const router = express.Router();
const { protect, optionalProtect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');
const knowledgeController = require('../controllers/knowledgeController');

/**
 * Knowledge articles, mounted at /api/knowledge-articles.
 *
 * The parent router is the chat API, which is mounted at bare `/api` and
 * applies no blanket guard, so `protect` is attached per route here. The read
 * routes are deliberately public: this is the corpus the assistant answers
 * from and the corpus the website's help centre renders, and a help centre
 * behind a login is not a help centre.
 *
 * `optionalProtect` is what makes the audience rule work on those routes. It
 * populates `req.user` when there is a session and shrugs when there is not,
 * so a signed-in parent sees the parent articles and an anonymous visitor sees
 * only the public ones — from the same handler, with the narrowing done in the
 * query rather than after it.
 */

const editor = [protect, verifyRole('teacher', 'staff', 'admin')];
const publisher = [protect, verifyRole('admin')];

// --- Public reads -----------------------------------------------------------
// Declared before `/:id` so none of these words is ever read as an article id.
router.get('/meta', optionalProtect, knowledgeController.getMeta);
router.get('/search', optionalProtect, knowledgeController.searchArticles);
router.get('/digest', optionalProtect, knowledgeController.getDigest);
router.get('/slug/:slug', optionalProtect, knowledgeController.getBySlug);
router.post('/slug/:slug/rate', optionalProtect, knowledgeController.rateArticle);

// --- Maintaining the corpus -------------------------------------------------
// `/manage` and `/stale` sit above the public list so the words are claimed
// before anything parameterised sees them.
router.get('/manage', ...editor, knowledgeController.listAll);
router.get('/stale', ...editor, knowledgeController.listStale);

router.get('/', optionalProtect, knowledgeController.listPublic);
router.post('/', ...editor, knowledgeController.createArticle);

router.get('/:id', ...editor, knowledgeController.getArticle);
router.patch('/:id', ...editor, knowledgeController.updateArticle);
router.patch('/:id/submit', ...editor, knowledgeController.submitArticle);

// Publication is the two-person step, so it is the one an editor cannot do
// alone — and the controller refuses it even for an admin who wrote the piece.
router.patch('/:id/publish', ...publisher, knowledgeController.publishArticle);
router.patch('/:id/archive', ...publisher, knowledgeController.archiveArticle);
router.patch('/:id/restore', ...publisher, knowledgeController.restoreArticle);

module.exports = router;
