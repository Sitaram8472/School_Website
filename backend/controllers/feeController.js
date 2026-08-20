// backend/controllers/feeController.js
const mongoose = require('mongoose');
const FeeStructure = require('../models/FeeStructure');
const FeeInvoice = require('../models/FeeInvoice');
const User = require('../models/User');

const handleError = (res, err, message = 'Server error') => {
  console.error('[fees]', err);
  return res.status(500).json({ success: false, message, error: err.message });
};

const getPagination = (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
};

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const isBursar = (user) => user && (user.role === 'admin' || user.role === 'staff');

// ---- FEE STRUCTURES ----

/**
 * POST /api/fees/structures
 * Define what a class is billed for a given academic year. `totalAmount` is
 * ignored if the client sends it; the model derives it from the components.
 */
exports.createFeeStructure = async (req, res) => {
  try {
    const { name, academicYear, className, components, dueDate, lateFeePerDay, maxLateFee, currency, notes } =
      req.body;

    if (!name || !academicYear || !className || !dueDate) {
      return res.status(400).json({
        success: false,
        message: 'Name, academic year, class name and due date are required.',
      });
    }

    if (!Array.isArray(components) || components.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Provide at least one fee component.',
      });
    }

    const invalidComponent = components.find(
      (component) => !component.label || Number(component.amount) < 0 || Number.isNaN(Number(component.amount))
    );
    if (invalidComponent) {
      return res.status(400).json({
        success: false,
        message: 'Every component needs a label and a non-negative amount.',
      });
    }

    const parsedDue = new Date(dueDate);
    if (Number.isNaN(parsedDue.getTime())) {
      return res.status(400).json({ success: false, message: 'Due date is not a valid date.' });
    }

    const structure = await FeeStructure.create({
      name: name.trim(),
      academicYear: academicYear.trim(),
      className: className.trim(),
      components: components.map((component) => ({
        label: String(component.label).trim(),
        amount: Number(component.amount),
        mandatory: component.mandatory !== false,
        description: component.description || '',
      })),
      dueDate: parsedDue,
      lateFeePerDay: Number(lateFeePerDay) || 0,
      maxLateFee: Number(maxLateFee) || 0,
      currency: currency || 'INR',
      notes: notes || '',
      createdBy: req.user._id,
    });

    return res.status(201).json({ success: true, message: 'Fee structure created.', data: structure });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: err.message });
    }
    return handleError(res, err, 'Failed to create fee structure');
  }
};

/**
 * GET /api/fees/structures
 * Every structure, newest first, optionally filtered by year / class.
 */
exports.getFeeStructures = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = {};

    if (req.query.academicYear) filter.academicYear = req.query.academicYear;
    if (req.query.className) filter.className = new RegExp(`^${req.query.className}$`, 'i');
    if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';

    const [structures, total] = await Promise.all([
      FeeStructure.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      FeeStructure.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: structures,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return handleError(res, err, 'Failed to load fee structures');
  }
};

/**
 * PUT /api/fees/structures/:id
 * Editing components re-derives the total. Existing invoices keep the amounts
 * they were generated with — changing a structure never rewrites history.
 */
exports.updateFeeStructure = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid fee structure id.' });
    }

    const structure = await FeeStructure.findById(req.params.id);
    if (!structure) {
      return res.status(404).json({ success: false, message: 'Fee structure not found.' });
    }

    ['name', 'academicYear', 'className', 'lateFeePerDay', 'maxLateFee', 'currency', 'notes', 'isActive'].forEach(
      (field) => {
        if (req.body[field] !== undefined) structure[field] = req.body[field];
      }
    );

    if (req.body.dueDate !== undefined) {
      const parsedDue = new Date(req.body.dueDate);
      if (Number.isNaN(parsedDue.getTime())) {
        return res.status(400).json({ success: false, message: 'Due date is not a valid date.' });
      }
      structure.dueDate = parsedDue;
    }

    if (Array.isArray(req.body.components)) {
      if (req.body.components.length === 0) {
        return res.status(400).json({ success: false, message: 'Keep at least one component.' });
      }
      structure.components = req.body.components.map((component) => ({
        label: String(component.label).trim(),
        amount: Number(component.amount),
        mandatory: component.mandatory !== false,
        description: component.description || '',
      }));
    }

    await structure.save();

    return res.json({ success: true, message: 'Fee structure updated.', data: structure });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: err.message });
    }
    return handleError(res, err, 'Failed to update fee structure');
  }
};

/**
 * DELETE /api/fees/structures/:id
 * Deactivates rather than deletes when invoices already reference it, so a
 * receipt can always be traced back to what it billed.
 */
exports.deleteFeeStructure = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid fee structure id.' });
    }

    const structure = await FeeStructure.findById(req.params.id);
    if (!structure) {
      return res.status(404).json({ success: false, message: 'Fee structure not found.' });
    }

    const invoiceCount = await FeeInvoice.countDocuments({ feeStructure: structure._id });

    if (invoiceCount > 0) {
      structure.isActive = false;
      await structure.save();
      return res.json({
        success: true,
        message: `Deactivated — ${invoiceCount} invoice(s) still reference this structure.`,
      });
    }

    await structure.deleteOne();
    return res.json({ success: true, message: 'Fee structure deleted.' });
  } catch (err) {
    return handleError(res, err, 'Failed to delete fee structure');
  }
};

// ---- INVOICES ----

/**
 * POST /api/fees/invoices/generate
 * Create one invoice per student for a structure. Students who already have an
 * invoice for it are skipped rather than duplicated, so the endpoint is safe to
 * re-run after adding a new admission.
 */
exports.generateInvoices = async (req, res) => {
  try {
    const { feeStructureId, studentIds } = req.body;

    if (!isValidId(feeStructureId)) {
      return res.status(400).json({ success: false, message: 'Valid feeStructureId is required.' });
    }

    const structure = await FeeStructure.findById(feeStructureId);
    if (!structure) {
      return res.status(404).json({ success: false, message: 'Fee structure not found.' });
    }
    if (!structure.isActive) {
      return res.status(400).json({ success: false, message: 'This fee structure is inactive.' });
    }

    let students;
    if (Array.isArray(studentIds) && studentIds.length > 0) {
      const validIds = studentIds.filter(isValidId);
      students = await User.find({ _id: { $in: validIds }, role: 'student', isActive: true }).select('name');
    } else {
      students = await User.find({ role: 'student', isActive: true }).select('name');
    }

    if (students.length === 0) {
      return res.status(400).json({ success: false, message: 'No matching active students found.' });
    }

    const existing = await FeeInvoice.find({
      feeStructure: structure._id,
      student: { $in: students.map((s) => s._id) },
    }).select('student');

    const alreadyInvoiced = new Set(existing.map((invoice) => invoice.student.toString()));
    const lineItems = structure.buildLineItems();

    const toCreate = students
      .filter((student) => !alreadyInvoiced.has(student._id.toString()))
      .map((student) => ({
        student: student._id,
        studentName: student.name,
        feeStructure: structure._id,
        academicYear: structure.academicYear,
        className: structure.className,
        lineItems,
        totalAmount: structure.totalAmount,
        balance: structure.totalAmount,
        dueDate: structure.dueDate,
        currency: structure.currency,
        status: structure.dueDate.getTime() < Date.now() ? 'overdue' : 'pending',
      }));

    if (toCreate.length === 0) {
      return res.json({
        success: true,
        message: 'Every matching student already has an invoice for this structure.',
        data: { created: 0, skipped: alreadyInvoiced.size },
      });
    }

    // `create()` rather than `insertMany()` so the pre-validate hook that mints
    // the invoice number runs for each document.
    const created = await FeeInvoice.create(toCreate);

    return res.status(201).json({
      success: true,
      message: `Generated ${created.length} invoice(s).`,
      data: { created: created.length, skipped: alreadyInvoiced.size },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'An invoice already exists for one of these students.',
      });
    }
    return handleError(res, err, 'Failed to generate invoices');
  }
};

/**
 * GET /api/fees/invoices
 * Staff-facing listing with filters. Students must use /invoices/me.
 */
exports.getInvoices = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = {};

    if (req.query.status && FeeInvoice.STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;
    if (req.query.className) filter.className = new RegExp(`^${req.query.className}$`, 'i');
    if (req.query.search) filter.studentName = new RegExp(req.query.search, 'i');

    const [invoices, total] = await Promise.all([
      FeeInvoice.find(filter)
        .populate('student', 'name email')
        .sort({ dueDate: 1, createdAt: -1 })
        .skip(skip)
        .limit(limit),
      FeeInvoice.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: invoices,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return handleError(res, err, 'Failed to load invoices');
  }
};

/**
 * GET /api/fees/invoices/me
 * The caller's own invoices. There is deliberately no id parameter here — a
 * student cannot ask for anyone else's record.
 */
exports.getMyInvoices = async (req, res) => {
  try {
    const invoices = await FeeInvoice.find({ student: req.user._id })
      .populate('feeStructure', 'name lateFeePerDay maxLateFee')
      .sort({ dueDate: -1 });

    const enriched = invoices.map((invoice) => {
      const structure = invoice.feeStructure;
      const accruedLateFee = invoice.computeLateFee(
        structure?.lateFeePerDay || 0,
        structure?.maxLateFee || 0
      );

      return {
        ...invoice.toObject(),
        accruedLateFee,
        payableNow: Math.max(0, invoice.totalAmount + accruedLateFee - invoice.amountPaid),
      };
    });

    const summary = enriched.reduce(
      (acc, invoice) => {
        acc.totalBilled += invoice.totalAmount;
        acc.totalPaid += invoice.amountPaid;
        acc.totalOutstanding += invoice.payableNow;
        return acc;
      },
      { totalBilled: 0, totalPaid: 0, totalOutstanding: 0 }
    );

    return res.json({ success: true, data: enriched, summary });
  } catch (err) {
    return handleError(res, err, 'Failed to load your invoices');
  }
};

/**
 * GET /api/fees/invoices/:id
 * A student may read this only if the invoice is theirs.
 */
exports.getInvoice = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid invoice id.' });
    }

    const invoice = await FeeInvoice.findById(req.params.id)
      .populate('student', 'name email')
      .populate('feeStructure', 'name components lateFeePerDay maxLateFee')
      .populate('payments.recordedBy', 'name');

    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found.' });
    }

    const ownsInvoice = invoice.student._id.toString() === req.user._id.toString();
    if (!ownsInvoice && !isBursar(req.user)) {
      return res.status(403).json({ success: false, message: 'You can only view your own invoices.' });
    }

    return res.json({ success: true, data: invoice });
  } catch (err) {
    return handleError(res, err, 'Failed to load invoice');
  }
};

/**
 * POST /api/fees/invoices/:id/payments
 * Record a payment made through any channel. Late fees are folded in before
 * the payment is applied so the receipt reflects what was actually owed.
 */
exports.recordPayment = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid invoice id.' });
    }

    const invoice = await FeeInvoice.findById(req.params.id).populate(
      'feeStructure',
      'lateFeePerDay maxLateFee'
    );
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found.' });
    }

    const { amount, method, reference, note, paidAt } = req.body;
    if (amount === undefined || amount === null || amount === '') {
      return res.status(400).json({ success: false, message: 'Payment amount is required.' });
    }
    if (!method) {
      return res.status(400).json({ success: false, message: 'Payment method is required.' });
    }

    // Freeze whatever late fee has accrued so far onto the invoice before
    // applying the payment.
    invoice.lateFee = invoice.computeLateFee(
      invoice.feeStructure?.lateFeePerDay || 0,
      invoice.feeStructure?.maxLateFee || 0
    );

    try {
      invoice.recordPayment({ amount, method, reference, note, paidAt, recordedBy: req.user });
    } catch (validationError) {
      return res.status(400).json({ success: false, message: validationError.message });
    }

    await invoice.save();

    return res.json({
      success: true,
      message: `Payment of ${amount} recorded. Balance is now ${invoice.balance}.`,
      data: invoice,
    });
  } catch (err) {
    return handleError(res, err, 'Failed to record payment');
  }
};

/**
 * PATCH /api/fees/invoices/:id/waive
 * Write off an invoice — a scholarship, a hardship case, or a billing error.
 */
exports.waiveInvoice = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid invoice id.' });
    }

    const { reason } = req.body;
    if (!reason || !reason.trim()) {
      return res.status(400).json({ success: false, message: 'A reason is required to waive an invoice.' });
    }

    const invoice = await FeeInvoice.findById(req.params.id);
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found.' });
    }
    if (invoice.status === 'paid') {
      return res.status(409).json({ success: false, message: 'A fully paid invoice cannot be waived.' });
    }

    invoice.status = 'waived';
    invoice.waivedReason = reason.trim();
    invoice.balance = 0;
    await invoice.save();

    return res.json({ success: true, message: 'Invoice waived.', data: invoice });
  } catch (err) {
    return handleError(res, err, 'Failed to waive invoice');
  }
};

/**
 * GET /api/fees/summary
 * Collection dashboard: billed vs collected vs outstanding, plus a breakdown
 * by status and by class.
 */
exports.getCollectionSummary = async (req, res) => {
  try {
    const match = {};
    if (req.query.academicYear) match.academicYear = req.query.academicYear;

    const [totals] = await FeeInvoice.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          invoiceCount: { $sum: 1 },
          totalBilled: { $sum: '$totalAmount' },
          totalCollected: { $sum: '$amountPaid' },
          totalLateFees: { $sum: '$lateFee' },
        },
      },
    ]);

    const byStatus = await FeeInvoice.aggregate([
      { $match: match },
      { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$balance' } } },
      { $sort: { count: -1 } },
    ]);

    const byClass = await FeeInvoice.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$className',
          billed: { $sum: '$totalAmount' },
          collected: { $sum: '$amountPaid' },
          outstanding: { $sum: '$balance' },
        },
      },
      { $sort: { outstanding: -1 } },
    ]);

    const totalBilled = totals?.totalBilled || 0;
    const totalCollected = totals?.totalCollected || 0;

    return res.json({
      success: true,
      data: {
        invoiceCount: totals?.invoiceCount || 0,
        totalBilled,
        totalCollected,
        totalOutstanding: Math.max(0, totalBilled - totalCollected),
        totalLateFees: totals?.totalLateFees || 0,
        collectionRate: totalBilled > 0 ? Number(((totalCollected / totalBilled) * 100).toFixed(2)) : 0,
        byStatus,
        byClass,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Failed to build collection summary');
  }
};
