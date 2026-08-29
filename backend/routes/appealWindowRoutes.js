const express = require('express');

const router = express.Router();
const verifyRole = require('../middleware/verifyRole');
const windowController = require('../controllers/appealWindowController');

/**
 * Appeal windows, mounted at /api/appeals/windows.
 *
 * The parent router already applies `protect`, so every route here has a
 * session behind it. Reads are open to any signed-in user on purpose: a
 * deadline that only staff can see is the problem this module was written to
 * fix.
 */

const staff = verifyRole('teacher', 'admin');
const admin = verifyRole('admin');

// --- Reference data ---------------------------------------------------------
router.get('/meta', windowController.getMeta);

// --- Reads for everyone signed in -------------------------------------------
// Declared before `/:id` so none of these words is ever read as a window id.
router.get('/calendar', windowController.getCalendar);
router.get('/exam/:examId', windowController.getForExam);

// --- Staff ------------------------------------------------------------------
router.get('/exams', staff, windowController.getCandidateExams);
router.get('/', staff, windowController.listWindows);
router.post('/', staff, windowController.createWindow);

router.get('/:id', staff, windowController.getWindow);
router.patch('/:id', staff, windowController.updateWindow);
router.patch('/:id/publish', staff, windowController.publishWindow);

// The only route that moves a deadline a cohort has already been given. It
// refuses to move it earlier and it will not run without a reason.
router.patch('/:id/extend', staff, windowController.extendWindow);

// Ending a window, either because it has run its course or because it should
// never have said what it said. Both are admin-only and both are audited.
router.patch('/:id/close', admin, windowController.closeWindow);
router.patch('/:id/cancel', admin, windowController.cancelWindow);

module.exports = router;
