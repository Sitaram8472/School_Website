// backend/controllers/libraryController.js
const mongoose = require('mongoose');
const Book = require('../models/Book');
const BookLoan = require('../models/BookLoan');
const User = require('../models/User');

const handleError = (res, err, message = 'Server error') => {
  console.error('[library]', err);
  return res.status(500).json({ success: false, message, error: err.message });
};

const getPagination = (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 12));
  return { page, limit, skip: (page - 1) * limit };
};

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- CATALOGUE ----

/**
 * POST /api/library/books
 */
exports.addBook = async (req, res) => {
  try {
    const { title, author, isbn, totalCopies } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: 'Title is required.' });
    }
    if (!author || !author.trim()) {
      return res.status(400).json({ success: false, message: 'Author is required.' });
    }

    const copies = Number(totalCopies);
    if (!copies || copies < 1) {
      return res.status(400).json({ success: false, message: 'Total copies must be at least 1.' });
    }

    const book = await Book.create({
      title: title.trim(),
      author: author.trim(),
      isbn: isbn ? isbn.trim() : undefined,
      category: req.body.category || 'Other',
      publisher: req.body.publisher || '',
      publishedYear: req.body.publishedYear ? Number(req.body.publishedYear) : undefined,
      edition: req.body.edition || '',
      language: req.body.language || 'English',
      shelfLocation: req.body.shelfLocation || '',
      description: req.body.description || '',
      coverUrl: req.body.coverUrl || '',
      totalCopies: copies,
      availableCopies: copies,
      addedBy: req.user._id,
    });

    return res.status(201).json({ success: true, message: 'Book added to the catalogue.', data: book });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'A book with this ISBN is already in the catalogue.',
      });
    }
    if (err.name === 'ValidationError' || err instanceof mongoose.Error) {
      return res.status(400).json({ success: false, message: err.message });
    }
    return handleError(res, err, 'Failed to add book');
  }
};

/**
 * GET /api/library/books
 * Paginated, searchable catalogue. Everyone can read it.
 */
exports.getBooks = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = { isActive: true };

    if (req.query.category && req.query.category !== 'All') {
      filter.category = req.query.category;
    }
    if (req.query.availableOnly === 'true') {
      filter.availableCopies = { $gt: 0 };
    }
    if (req.query.search) {
      const pattern = new RegExp(escapeRegex(req.query.search), 'i');
      filter.$or = [{ title: pattern }, { author: pattern }, { isbn: pattern }];
    }

    const [books, total] = await Promise.all([
      Book.find(filter).sort({ title: 1 }).skip(skip).limit(limit),
      Book.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: books,
      categories: Book.CATEGORIES,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return handleError(res, err, 'Failed to load the catalogue');
  }
};

/**
 * GET /api/library/books/:id
 */
exports.getBook = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid book id.' });
    }

    const book = await Book.findById(req.params.id);
    if (!book) {
      return res.status(404).json({ success: false, message: 'Book not found.' });
    }

    return res.json({ success: true, data: book });
  } catch (err) {
    return handleError(res, err, 'Failed to load book');
  }
};

/**
 * PUT /api/library/books/:id
 * Changing `totalCopies` shifts `availableCopies` by the same delta so books
 * already on loan are not silently un-issued.
 */
exports.updateBook = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid book id.' });
    }

    const book = await Book.findById(req.params.id);
    if (!book) {
      return res.status(404).json({ success: false, message: 'Book not found.' });
    }

    if (req.body.totalCopies !== undefined) {
      const newTotal = Number(req.body.totalCopies);
      const issued = book.totalCopies - book.availableCopies;

      if (!newTotal || newTotal < 1) {
        return res.status(400).json({ success: false, message: 'Total copies must be at least 1.' });
      }
      if (newTotal < issued) {
        return res.status(400).json({
          success: false,
          message: `${issued} copies are currently on loan — total cannot drop below that.`,
        });
      }

      book.totalCopies = newTotal;
      book.availableCopies = newTotal - issued;
    }

    [
      'title',
      'author',
      'isbn',
      'category',
      'publisher',
      'publishedYear',
      'edition',
      'language',
      'shelfLocation',
      'description',
      'coverUrl',
      'isActive',
    ].forEach((field) => {
      if (req.body[field] !== undefined) book[field] = req.body[field];
    });

    await book.save();

    return res.json({ success: true, message: 'Book updated.', data: book });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'Another book already uses this ISBN.' });
    }
    if (err.name === 'ValidationError' || err instanceof mongoose.Error) {
      return res.status(400).json({ success: false, message: err.message });
    }
    return handleError(res, err, 'Failed to update book');
  }
};

/**
 * DELETE /api/library/books/:id
 * Deactivates rather than deletes while copies are still out, so a loan always
 * has a book to point at.
 */
exports.deleteBook = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid book id.' });
    }

    const book = await Book.findById(req.params.id);
    if (!book) {
      return res.status(404).json({ success: false, message: 'Book not found.' });
    }

    const activeLoans = await BookLoan.countDocuments({
      book: book._id,
      status: { $in: ['issued', 'overdue'] },
    });

    if (activeLoans > 0) {
      return res.status(409).json({
        success: false,
        message: `${activeLoans} copy/copies are still on loan. Collect them before removing this book.`,
      });
    }

    book.isActive = false;
    await book.save();

    return res.json({ success: true, message: 'Book removed from the catalogue.' });
  } catch (err) {
    return handleError(res, err, 'Failed to remove book');
  }
};

// ---- CIRCULATION ----

/**
 * POST /api/library/loans
 * Issue a copy to a student.
 *
 * The copy count is decremented with a single conditional update guarded on
 * `availableCopies > 0`, so two librarians issuing the last copy at the same
 * moment cannot both succeed.
 */
exports.issueBook = async (req, res) => {
  try {
    const { bookId, studentId, dueDate } = req.body;

    if (!isValidId(bookId) || !isValidId(studentId)) {
      return res.status(400).json({ success: false, message: 'Valid bookId and studentId are required.' });
    }

    const [book, student] = await Promise.all([
      Book.findById(bookId),
      User.findById(studentId).select('name role isActive'),
    ]);

    if (!book || !book.isActive) {
      return res.status(404).json({ success: false, message: 'Book not found in the catalogue.' });
    }
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }
    if (!student.isActive) {
      return res.status(400).json({ success: false, message: 'This account is deactivated.' });
    }

    const activeLoans = await BookLoan.find({
      student: student._id,
      status: { $in: ['issued', 'overdue'] },
    }).select('book');

    if (activeLoans.length >= BookLoan.MAX_CONCURRENT_LOANS) {
      return res.status(400).json({
        success: false,
        message: `${student.name} already has ${activeLoans.length} books out (limit is ${BookLoan.MAX_CONCURRENT_LOANS}).`,
      });
    }

    if (activeLoans.some((loan) => loan.book.toString() === book._id.toString())) {
      return res.status(409).json({
        success: false,
        message: `${student.name} already has a copy of this book.`,
      });
    }

    // Atomic claim of one copy.
    const claimed = await Book.findOneAndUpdate(
      { _id: book._id, availableCopies: { $gt: 0 } },
      { $inc: { availableCopies: -1 } },
      { new: true }
    );

    if (!claimed) {
      return res.status(400).json({ success: false, message: 'No copies are available right now.' });
    }

    const due = dueDate
      ? new Date(dueDate)
      : new Date(Date.now() + BookLoan.LOAN_PERIOD_DAYS * 24 * 60 * 60 * 1000);

    if (Number.isNaN(due.getTime()) || due.getTime() <= Date.now()) {
      // Put the copy back before reporting the bad input.
      await Book.updateOne({ _id: book._id }, { $inc: { availableCopies: 1 } });
      return res.status(400).json({ success: false, message: 'Due date must be a future date.' });
    }

    try {
      const loan = await BookLoan.create({
        book: book._id,
        bookTitle: book.title,
        student: student._id,
        studentName: student.name,
        issuedBy: req.user._id,
        dueDate: due,
        status: 'issued',
      });

      return res.status(201).json({
        success: true,
        message: `"${book.title}" issued to ${student.name}. Due ${due.toDateString()}.`,
        data: loan,
      });
    } catch (createError) {
      // Never leave a copy stranded if the loan record fails to write.
      await Book.updateOne({ _id: book._id }, { $inc: { availableCopies: 1 } });
      throw createError;
    }
  } catch (err) {
    return handleError(res, err, 'Failed to issue book');
  }
};

/**
 * PATCH /api/library/loans/:id/return
 */
exports.returnBook = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid loan id.' });
    }

    const loan = await BookLoan.findById(req.params.id);
    if (!loan) {
      return res.status(404).json({ success: false, message: 'Loan not found.' });
    }

    try {
      loan.close(req.user, BookLoan.FINE_PER_DAY);
    } catch (validationError) {
      return res.status(409).json({ success: false, message: validationError.message });
    }

    if (req.body.notes) loan.notes = req.body.notes;
    await loan.save();

    // Return the copy to the shelf, never exceeding the catalogued total.
    const book = await Book.findById(loan.book);
    if (book && book.availableCopies < book.totalCopies) {
      await Book.updateOne({ _id: book._id }, { $inc: { availableCopies: 1 } });
    }

    return res.json({
      success: true,
      message:
        loan.fineAmount > 0
          ? `Returned ${loan.daysOverdue()} day(s) late — fine of ${loan.fineAmount} due.`
          : 'Book returned on time. Thank you!',
      data: loan,
    });
  } catch (err) {
    return handleError(res, err, 'Failed to return book');
  }
};

/**
 * PATCH /api/library/loans/:id/renew
 */
exports.renewLoan = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid loan id.' });
    }

    const loan = await BookLoan.findById(req.params.id);
    if (!loan) {
      return res.status(404).json({ success: false, message: 'Loan not found.' });
    }

    // A student may renew their own loan; staff may renew anyone's.
    const ownsLoan = loan.student.toString() === req.user._id.toString();
    const isLibrarian = ['admin', 'staff', 'teacher'].includes(req.user.role);
    if (!ownsLoan && !isLibrarian) {
      return res.status(403).json({ success: false, message: 'You can only renew your own loans.' });
    }

    try {
      loan.renew(BookLoan.LOAN_PERIOD_DAYS);
    } catch (validationError) {
      return res.status(400).json({ success: false, message: validationError.message });
    }

    await loan.save();

    return res.json({
      success: true,
      message: `Renewed. New due date is ${loan.dueDate.toDateString()}.`,
      data: loan,
    });
  } catch (err) {
    return handleError(res, err, 'Failed to renew loan');
  }
};

/**
 * GET /api/library/loans/me
 * The caller's own borrowing history, with live fine estimates.
 */
exports.getMyLoans = async (req, res) => {
  try {
    const loans = await BookLoan.find({ student: req.user._id })
      .populate('book', 'title author coverUrl shelfLocation')
      .sort({ issuedAt: -1 });

    const enriched = loans.map((loan) => ({
      ...loan.toObject(),
      daysOverdue: loan.daysOverdue(),
      estimatedFine: loan.status === 'returned' ? loan.fineAmount : loan.calculateFine(BookLoan.FINE_PER_DAY),
      overdue: loan.isOverdue(),
    }));

    const active = enriched.filter((loan) => loan.status === 'issued' || loan.status === 'overdue');

    return res.json({
      success: true,
      data: enriched,
      summary: {
        activeLoans: active.length,
        overdueLoans: active.filter((loan) => loan.overdue).length,
        outstandingFines: enriched
          .filter((loan) => !loan.finePaid)
          .reduce((sum, loan) => sum + loan.estimatedFine, 0),
        borrowLimit: BookLoan.MAX_CONCURRENT_LOANS,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Failed to load your loans');
  }
};

/**
 * GET /api/library/loans
 * Staff view of circulation, filterable by status and borrower.
 */
exports.getLoans = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = {};

    if (req.query.status && BookLoan.STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (req.query.studentId && isValidId(req.query.studentId)) {
      filter.student = req.query.studentId;
    }
    if (req.query.search) {
      filter.studentName = new RegExp(escapeRegex(req.query.search), 'i');
    }

    const [loans, total] = await Promise.all([
      BookLoan.find(filter)
        .populate('book', 'title author')
        .populate('student', 'name email')
        .sort({ dueDate: 1 })
        .skip(skip)
        .limit(limit),
      BookLoan.countDocuments(filter),
    ]);

    const enriched = loans.map((loan) => ({
      ...loan.toObject(),
      daysOverdue: loan.daysOverdue(),
      overdue: loan.isOverdue(),
    }));

    return res.json({
      success: true,
      data: enriched,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return handleError(res, err, 'Failed to load loans');
  }
};

/**
 * GET /api/library/overdue
 * Everything past its due date, worst offender first — the list a librarian
 * works through on a Monday morning.
 */
exports.getOverdueReport = async (req, res) => {
  try {
    const overdueLoans = await BookLoan.find({
      status: { $in: ['issued', 'overdue'] },
      dueDate: { $lt: new Date() },
    })
      .populate('book', 'title author')
      .populate('student', 'name email')
      .sort({ dueDate: 1 });

    const rows = overdueLoans.map((loan) => ({
      _id: loan._id,
      bookTitle: loan.book?.title || loan.bookTitle,
      studentName: loan.student?.name || loan.studentName,
      studentEmail: loan.student?.email || '',
      dueDate: loan.dueDate,
      daysOverdue: loan.daysOverdue(),
      fine: loan.calculateFine(BookLoan.FINE_PER_DAY),
    }));

    return res.json({
      success: true,
      data: rows,
      summary: {
        overdueCount: rows.length,
        totalFines: rows.reduce((sum, row) => sum + row.fine, 0),
        finePerDay: BookLoan.FINE_PER_DAY,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Failed to build the overdue report');
  }
};
