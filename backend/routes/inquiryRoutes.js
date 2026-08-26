const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const { createInquiry } = require("../controllers/inquiryController.js");
const { protect } = require("../middleware/Auth");
const verifyRole = require("../middleware/verifyRole");
const callbacks = require("../controllers/inquiryCallbackController");

// The public POST below is unauthenticated and was unbounded: anybody could
// write to this collection at any volume. The limiter is declared here rather
// than added to middleware/rateLimiter.js because that file has open changes
// against it — and a contact form is a different shape of limit from a login
// attempt anyway. Ten an hour is generous enough that a family filling the form
// in twice never notices.
const inquiryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: {
    success: false,
    message: "Too many enquiries from this address. Please try again in an hour.",
  },
});

// --- Public ------------------------------------------------------------------
// Unchanged apart from the limiter in front of it. This route is the contact
// form on the website and it must stay reachable with no credentials.
router.post("/", inquiryLimiter, createInquiry);

// --- Staff -------------------------------------------------------------------
// `protect` is attached per route on purpose. `router.use(protect)` on this file
// would put authentication in front of the public form above and take the
// website down.
const staffOnly = [protect, verifyRole("admin", "staff")];

// Static segments first, so none of these words is ever read as an id.
router.get("/meta", staffOnly, callbacks.getCallbackMeta);
router.get("/stats", staffOnly, callbacks.getResponseStats);

// The read side Inquiry never had — there was no GET route on this file at all,
// so the only way to see an enquiry was to open the database. A follow-up queue
// built on records nobody can fetch is not usable.
router.get("/", staffOnly, callbacks.listInquiries);

router.get("/callbacks", staffOnly, callbacks.listCallbacks);
router.post("/callbacks", staffOnly, callbacks.createCallback);
router.get("/callbacks/:id", staffOnly, callbacks.getCallback);

// Reassignment deliberately leaves dueBy alone: the work moving desk is not the
// parent's problem.
router.patch("/callbacks/:id/assign", staffOnly, callbacks.assignCallback);
router.patch("/callbacks/:id/schedule", staffOnly, callbacks.scheduleCallback);
router.post("/callbacks/:id/attempts", staffOnly, callbacks.recordAttempt);

// Closing needs an outcome; "unreachable" needs the attempts to justify it.
router.patch("/callbacks/:id/close", staffOnly, callbacks.closeCallback);
router.patch("/callbacks/:id/unreachable", staffOnly, callbacks.markUnreachable);

// A reopen creates a new callback rather than flipping the old one back, so the
// first conversation keeps its own dates and its own outcome.
router.post("/callbacks/:id/reopen", staffOnly, callbacks.reopenCallback);

// Declared last: /:id would otherwise swallow /meta, /stats and /callbacks.
router.get("/:id", staffOnly, callbacks.getInquiry);

module.exports = router;
