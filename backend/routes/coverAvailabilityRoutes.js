const express = require('express');

const router = express.Router();
const availabilityController = require('../controllers/coverAvailabilityController');
const verifyRole = require('../middleware/verifyRole');

/**
 * Cover availability.
 *
 * Mounted under a static `/availability` prefix on `/api/substitutions`, which
 * already applies `protect`. Nothing here is public: a register of who is on a
 * phased return is not information for the internet.
 */

const teacherOrAdmin = verifyRole('teacher', 'admin');
const office = verifyRole('admin');

router.get('/meta', teacherOrAdmin, availabilityController.getMeta);

// --- The staff member's own -------------------------------------------------
// Declared before `/:staffId` so "mine" is never read as an id. The opt-out is
// the only part of a profile its subject may write, and the model bounds how
// far ahead it may run.
router.get('/mine', teacherOrAdmin, availabilityController.getMine);
router.patch('/mine/opt-out', teacherOrAdmin, availabilityController.setMyOptOut);
router.delete('/mine/opt-out', teacherOrAdmin, availabilityController.clearMyOptOut);

// --- The office's view ------------------------------------------------------
// `eligible` is the constraint-aware sibling of `/available`: same shape, plus
// the blocked people with their reasons, sorted by capacity left.
router.get('/eligible', office, availabilityController.getEligible);
router.get('/check', office, availabilityController.check);
router.get('/load', office, availabilityController.getLoad);

router.get('/', office, availabilityController.listProfiles);

// --- Profile administration -------------------------------------------------
// The working pattern, the exclusions and the caps are terms of employment, so
// they are admin-set. The subject of the profile cannot edit their own.
router.post('/:staffId', office, availabilityController.createProfile);
router.get('/:staffId', office, availabilityController.getProfile);
router.patch('/:staffId', office, availabilityController.updateProfile);
router.patch('/:staffId/status', office, availabilityController.setStatus);

router.post('/:staffId/blocks', office, availabilityController.addBlock);
router.delete('/:staffId/blocks/:blockId', office, availabilityController.removeBlock);

router.post('/:staffId/exclusions', office, availabilityController.addExclusion);
router.delete('/:staffId/exclusions/:exclusionId', office, availabilityController.removeExclusion);

module.exports = router;
