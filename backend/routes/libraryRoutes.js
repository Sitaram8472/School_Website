const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');
const libraryController = require('../controllers/libraryController');

// A school library catalogue is not public — sign in first.
router.use(protect);

// Teachers double as librarians in most small schools; admin and office staff
// always have circulation rights.
const librarian = verifyRole('admin', 'staff', 'teacher');

// ---- Student-facing ----
// Registered before "/loans" and "/books/:id" so the literal path wins.
router.get('/loans/me', libraryController.getMyLoans);

// ---- Catalogue (read for everyone, write for librarians) ----
router.get('/books', libraryController.getBooks);
router.get('/books/:id', libraryController.getBook);
router.post('/books', librarian, libraryController.addBook);
router.put('/books/:id', librarian, libraryController.updateBook);
router.delete('/books/:id', librarian, libraryController.deleteBook);

// ---- Circulation ----
router.get('/loans', librarian, libraryController.getLoans);
router.post('/loans', librarian, libraryController.issueBook);
router.patch('/loans/:id/return', librarian, libraryController.returnBook);

// Renewal is open to any signed-in user; the controller enforces that a student
// can only renew a loan of their own.
router.patch('/loans/:id/renew', libraryController.renewLoan);

// ---- Reporting ----
router.get('/overdue', librarian, libraryController.getOverdueReport);

module.exports = router;
