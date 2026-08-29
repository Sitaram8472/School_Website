const express = require('express');
const rateLimit = require('express-rate-limit');

const router = express.Router();
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');
const prospectusController = require('../controllers/prospectusController');

/**
 * Printed prospectus requests, mounted at /api/contact/prospectus.
 *
 * The parent router is the website's public contact form, so there is no
 * `router.use(protect)` here — a blanket guard on this file would take the
 * public request form down with it. `protect` is attached per route instead,
 * and every route that is not deliberately public carries it.
 */

const office = [protect, verifyRole('staff', 'admin')];

/**
 * The public form costs the school a printed book and postage per submission,
 * which makes it a more attractive thing to hammer than an ordinary contact
 * form. The limiter is declared here rather than in `middleware/rateLimiter.js`
 * because this is the only route that needs it, and it is attached in front of
 * the handler on the same line — express runs matching middleware in
 * declaration order, so one registered afterwards would never run.
 */
const requestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: {
    success: false,
    message: 'Too many prospectus requests from this address. Please try again in an hour.',
  },
});

// --- Public -----------------------------------------------------------------
// Declared before `/:id` so none of these words is ever read as a request id.
router.get('/meta', prospectusController.getMeta);
router.get('/track', prospectusController.trackRequest);
router.post('/', requestLimiter, prospectusController.createRequest);

// --- The admissions office --------------------------------------------------
router.get('/summary', ...office, prospectusController.getSummary);
router.post('/staff', ...office, prospectusController.createStaffRequest);
router.get('/', ...office, prospectusController.listRequests);
router.get('/:id', ...office, prospectusController.getRequest);

// --- Fulfilment -------------------------------------------------------------
// The ladder only goes forward, and the model is what enforces that; these
// routes are the four rungs and the two ways off it.
router.patch('/:id/pack', ...office, prospectusController.packRequest);
router.patch('/:id/dispatch', ...office, prospectusController.dispatchRequest);
router.patch('/:id/deliver', ...office, prospectusController.deliverRequest);
router.patch('/:id/return', ...office, prospectusController.returnRequest);
router.patch('/:id/cancel', ...office, prospectusController.cancelRequest);
router.patch('/:id/notes', ...office, prospectusController.updateNotes);

module.exports = router;
