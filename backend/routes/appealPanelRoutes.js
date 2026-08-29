const express = require('express');

const router = express.Router();
const verifyRole = require('../middleware/verifyRole');
const panelController = require('../controllers/appealPanelController');

/**
 * Appeal reviewer panels, mounted at /api/appeals/panels.
 *
 * The parent router already applies `protect`, so every route here has a
 * session behind it. Reading a panel is open to teaching staff — a reviewer
 * should be able to see the roster they are on and what everybody is carrying
 * — while every change to membership is admin-only.
 */

const staff = verifyRole('teacher', 'admin');
const admin = verifyRole('admin');

// --- Reference data ---------------------------------------------------------
router.get('/meta', panelController.getMeta);

// --- Reads ------------------------------------------------------------------
// Declared before `/:id` so none of these words is ever read as a panel id.
router.get('/eligible', staff, panelController.getEligibleStaff);
router.get('/course/:courseId', staff, panelController.getPanelForCourse);
router.get('/', staff, panelController.listPanels);

router.get('/:id', staff, panelController.getPanel);
router.get('/:id/workload', staff, panelController.getWorkload);
router.get('/:id/suggest', staff, panelController.suggestReviewer);

// --- Membership -------------------------------------------------------------
// Who may review a course's appeals is a standing decision about people, so it
// sits with admins rather than with whoever is running the exam this week.
router.post('/', admin, panelController.createPanel);
router.post('/:id/members', admin, panelController.addMember);
router.delete('/:id/members/:userId', admin, panelController.removeMember);
router.patch('/:id/members/:userId/seat', admin, panelController.setSeat);

router.patch('/:id/activate', admin, panelController.activatePanel);
router.patch('/:id/retire', admin, panelController.retirePanel);

// The stricter door onto assignment: membership first, then the recusal rules
// the appeals module already enforces.
router.patch('/:id/assign', admin, panelController.assignFromPanel);

module.exports = router;
