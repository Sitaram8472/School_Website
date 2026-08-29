const express = require('express');

const router = express.Router();
const consentController = require('../controllers/publicationConsentController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

/**
 * Publication consent.
 *
 * Mounted under a static `/publication-consent` prefix on `/api/notices`.
 * Notices are the school's publishing surface, so the gate that governs
 * publication hangs off it.
 *
 * The parent router applies `protect` per route rather than globally — the
 * notice list is public — so this one attaches it itself. Nothing here is
 * public: a register of which children may not be photographed is not
 * information for the internet.
 */

router.use(protect);

const staff = verifyRole('teacher', 'staff', 'admin');
const office = verifyRole('staff', 'admin');

router.get('/meta', consentController.getMeta);

// --- The family's own -------------------------------------------------------
// Declared before `/:id` so "mine" is never read as an identifier. The list
// covers every channel, including the ones nobody has ever been asked about —
// "never asked" is a state a family is entitled to see.
router.get('/mine', consentController.getMine);

// --- Checking ---------------------------------------------------------------
router.get('/check', staff, consentController.check);
router.get('/coverage', office, consentController.getCoverage);

// --- The takedown queue -----------------------------------------------------
// The screen this module exists for; everything else is context for it.
router.get('/takedowns', office, consentController.getTakedowns);

// --- The usage register -----------------------------------------------------
// Recording a publication is checked, not trusted: every named child is
// verified against a live consent and the whole registration is refused if any
// one of them fails.
router.post('/usages', staff, consentController.registerUsage);
router.get('/usages', office, consentController.listUsages);
router.patch('/usages/:id/remove', office, consentController.markRemoved);

// --- Consents ---------------------------------------------------------------
router.post('/', office, consentController.recordConsent);
router.get('/', office, consentController.listConsents);

// Ownership is decided in the handler, since "mine or the office" is not a role.
router.get('/:id', consentController.getConsent);

// A student's objection is recorded beside the guardian's decision, never over
// it, and it wins.
router.patch('/:id/objection', staff, consentController.noteObjection);

// A family may withdraw their own; the office may withdraw on their behalf.
router.patch('/:id/withdraw', consentController.withdrawConsent);

module.exports = router;
