const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');
const alumniController = require('../controllers/alumniController');

// Everything under /api/alumni needs a session. The directory is not public —
// that is the point of the verification step.
router.use(protect);

const office = verifyRole('admin', 'staff');

// ---- Directory ----
// The literal paths are declared before "/profiles/:id" so they are never
// swallowed by the parameterised route.
router.get('/profiles/me', alumniController.getMyProfile);
router.get('/profiles/pending', office, alumniController.getPendingProfiles);

router.get('/profiles', alumniController.browseProfiles);
router.post('/profiles', alumniController.createProfile);

// Visibility of an unverified profile is decided inside the controller, so the
// owner can open their own pending profile through the same URL.
router.get('/profiles/:id', alumniController.getProfile);
router.patch('/profiles/:id', alumniController.updateProfile);

// ---- Verification ----
router.patch('/profiles/:id/verify', office, alumniController.verifyProfile);

// ---- Mentorship ----
router.post('/profiles/:id/mentorship', alumniController.requestMentorship);
router.patch('/profiles/:id/mentorship/:requestId/respond', alumniController.respondToRequest);
router.patch('/profiles/:id/mentorship/:requestId/complete', alumniController.completeMentorship);
router.patch('/profiles/:id/mentorship/:requestId/withdraw', alumniController.withdrawRequest);

router.get('/my-requests', alumniController.getMyRequests);

// ---- Reporting ----
router.get('/stats', office, alumniController.getStats);

module.exports = router;
