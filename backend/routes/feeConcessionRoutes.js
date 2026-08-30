const express = require('express');

const router = express.Router();
const concessionController = require('../controllers/feeConcessionController');
const verifyRole = require('../middleware/verifyRole');

/**
 * Fee concessions.
 *
 * Mounted under a static `/concessions` prefix on `/api/fees`, which already
 * applies `protect`. A family reaches the read routes; everything that grants,
 * decides or revokes is the finance office's.
 */

const bursar = verifyRole('admin', 'staff');
const approver = verifyRole('admin');

router.get('/meta', concessionController.getMeta);

// --- The family's own -------------------------------------------------------
// Declared before `/:id` so "mine" is never read as an identifier.
router.get('/mine', concessionController.getMyConcessions);

// --- Schemes ----------------------------------------------------------------
// What the school offers, as opposed to who holds it. Only an admin writes a
// scheme: a rate that staff can edit is a rate that drifts.
router.get('/schemes', bursar, concessionController.listSchemes);
router.post('/schemes', approver, concessionController.createScheme);
router.patch('/schemes/:id', approver, concessionController.updateScheme);
router.patch('/schemes/:id/status', approver, concessionController.setSchemeStatus);

// --- Reporting and pricing --------------------------------------------------
// `preview` answers what an invoice would come to under a scheme before
// anything is granted, which is the question the decision actually turns on.
router.get('/register', bursar, concessionController.getRegister);
router.get('/preview', bursar, concessionController.preview);

// Ownership is decided in the controller so a family can price their own bill.
router.get('/invoice/:invoiceId', concessionController.getInvoicePricing);

// --- Concessions ------------------------------------------------------------
router.post('/', bursar, concessionController.createConcession);
router.get('/', bursar, concessionController.listConcessions);

router.get('/:id', concessionController.getConcession);

router.patch('/:id/submit', bursar, concessionController.submitConcession);
router.patch('/:id/evidence', bursar, concessionController.recordEvidence);

// The two-person rule is enforced in the handler and again in the model.
// Holding the admin role is necessary but not sufficient.
router.patch('/:id/approve', approver, concessionController.approveConcession);
router.patch('/:id/reject', approver, concessionController.rejectConcession);
router.patch('/:id/revoke', approver, concessionController.revokeConcession);

module.exports = router;
