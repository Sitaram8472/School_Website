// backend/controllers/feeConcessionController.js
const mongoose = require('mongoose');
const User = require('../models/User');
const FeeInvoice = require('../models/FeeInvoice');
const FeeStructure = require('../models/FeeStructure');
const FeeConcession = require('../models/FeeConcession');
const { ConcessionScheme } = require('../models/FeeConcession');

/**
 * Standing fee concessions.
 *
 * Nothing in this file writes to a `FeeInvoice`. Every figure a family or a
 * bursar sees is produced by `FeeConcession.applyTo` at read time from the
 * invoice, its structure and the concessions live on that day. That is the
 * whole point: a discount written onto the invoice stops matching its own
 * reason the moment anything changes, and does so silently.
 *
 * The second rule enforced throughout is the two-person one. Whoever approves
 * may not be whoever requested, and on a scheme that requires evidence, whoever
 * verified the evidence may not be either. Checked here and again in the model,
 * because a rule that only lives in a controller is a rule a script can skip.
 */

const handleError = (res, err, message = 'Server error') => {
  console.error('[fee-concessions]', err);
  return res.status(500).json({ success: false, message, error: err.message });
};

const fail = (res, status, message, extra = {}) =>
  res.status(status).json({ success: false, message, ...extra });

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const isBursar = (user) => user && ['staff', 'admin'].includes(user.role);
const isAdmin = (user) => user && user.role === 'admin';

const getPagination = (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
};

/**
 * A domain error from a model guard, as opposed to something that went wrong.
 *
 * The model throws plain `Error`s for rule violations, and those are 400s the
 * caller can act on rather than 500s.
 */
const asBadRequest = (err) =>
  err instanceof Error && !['MongoServerError', 'MongooseError'].includes(err.name);

const publicConcession = (concession) => ({
  _id: concession._id,
  student: concession.student,
  studentName: concession.studentName,
  className: concession.className,
  academicYear: concession.academicYear,
  scheme: concession.scheme,
  schemeCode: concession.schemeCode,
  schemeName: concession.schemeName,
  basis: concession.basis,
  rate: concession.rate,
  appliesTo: concession.appliesTo,
  stackable: concession.stackable,
  status: concession.status,
  reason: concession.reason,
  evidenceRequired: concession.evidenceRequired,
  evidenceReference: concession.evidenceReference,
  evidenceSeenByName: concession.evidenceSeenByName,
  evidenceSeenAt: concession.evidenceSeenAt,
  requestedByName: concession.requestedByName,
  submittedAt: concession.submittedAt,
  approvedByName: concession.approvedByName,
  approvedAt: concession.approvedAt,
  rejectionReason: concession.rejectionReason,
  revocationReason: concession.revocationReason,
  effectiveFrom: concession.effectiveFrom,
  effectiveTo: concession.effectiveTo,
  history: concession.history,
  createdAt: concession.createdAt,
});

/**
 * The family's view. Deliberately thinner: a concession carries a reason
 * written by staff about a household, and that is a staff record.
 */
const familyConcession = (concession) => ({
  _id: concession._id,
  studentName: concession.studentName,
  academicYear: concession.academicYear,
  schemeName: concession.schemeName,
  basis: concession.basis,
  rate: concession.rate,
  appliesTo: concession.appliesTo,
  status: concession.status,
  approvedAt: concession.approvedAt,
  effectiveFrom: concession.effectiveFrom,
  effectiveTo: concession.effectiveTo,
});

const ownsStudent = (user, studentId) => String(user._id) === String(studentId);

/**
 * Everything needed to price one invoice: the invoice, its structure, and the
 * concessions live for that student and year.
 */
const priceInvoice = async (invoice) => {
  const structure = invoice.feeStructure
    ? await FeeStructure.findById(invoice.feeStructure).select('components name')
    : null;

  const concessions = await FeeConcession.find({
    student: invoice.student,
    academicYear: invoice.academicYear,
    status: 'approved',
  });

  return {
    structure,
    concessions,
    pricing: FeeConcession.applyTo(invoice, structure, concessions),
  };
};

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

exports.getMeta = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        statuses: FeeConcession.CONCESSION_STATUSES,
        liveStatuses: FeeConcession.LIVE_STATUSES,
        bases: FeeConcession.BASES,
        appliesTo: FeeConcession.APPLIES_TO,
        maxTotalConcessionPercent: FeeConcession.MAX_TOTAL_CONCESSION_PERCENT,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load concession reference data');
  }
};

// ---------------------------------------------------------------------------
// Schemes
// ---------------------------------------------------------------------------

exports.createScheme = async (req, res) => {
  try {
    const {
      code,
      name,
      description = '',
      basis,
      rate,
      appliesTo = 'all-components',
      stackable = true,
      requiresEvidence = true,
      evidenceLabel = '',
      academicYear,
    } = req.body;

    const scheme = new ConcessionScheme({
      code,
      name,
      description,
      basis,
      rate,
      appliesTo,
      stackable,
      requiresEvidence,
      evidenceLabel,
      academicYear,
      createdBy: req.user._id,
    });

    scheme.history.push({ action: 'created', by: req.user._id, byName: req.user.name });
    await scheme.save();

    return res.status(201).json({
      success: true,
      message: `Scheme "${scheme.name}" created.`,
      data: scheme,
    });
  } catch (err) {
    if (err.code === 11000) {
      return fail(res, 409, 'A scheme with that code already exists.');
    }
    if (err.name === 'ValidationError') {
      return fail(res, 400, Object.values(err.errors)[0].message);
    }
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, 'Could not create the scheme');
  }
};

exports.listSchemes = async (req, res) => {
  try {
    const filter = {};
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;
    if (req.query.active === 'true') filter.isActive = true;

    const schemes = await ConcessionScheme.find(filter).sort({ name: 1 });

    return res.status(200).json({ success: true, count: schemes.length, data: schemes });
  } catch (err) {
    return handleError(res, err, 'Could not list the schemes');
  }
};

exports.updateScheme = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid scheme id.');

    const scheme = await ConcessionScheme.findById(id);
    if (!scheme) return fail(res, 404, 'Scheme not found.');

    const fields = [
      'name',
      'description',
      'basis',
      'rate',
      'appliesTo',
      'stackable',
      'requiresEvidence',
      'evidenceLabel',
    ];

    const changed = [];
    fields.forEach((field) => {
      if (req.body[field] === undefined) return;
      if (scheme[field] === req.body[field]) return;
      scheme[field] = req.body[field];
      changed.push(field);
    });

    if (!changed.length) return fail(res, 400, 'Nothing to change.');

    scheme.history.push({
      action: 'updated',
      by: req.user._id,
      byName: req.user.name,
      note: changed.join(', '),
    });
    await scheme.save();

    /**
     * Concessions already granted are untouched on purpose. They froze the rate
     * and basis when they were granted, so this edit shapes future grants only.
     */
    return res.status(200).json({
      success: true,
      message: 'Scheme updated. Concessions already granted keep the rate they were granted at.',
      data: scheme,
    });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return fail(res, 400, Object.values(err.errors)[0].message);
    }
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, 'Could not update the scheme');
  }
};

exports.setSchemeStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid scheme id.');
    if (typeof isActive !== 'boolean') return fail(res, 400, 'isActive must be true or false.');

    const scheme = await ConcessionScheme.findById(id);
    if (!scheme) return fail(res, 404, 'Scheme not found.');

    scheme.isActive = isActive;
    scheme.history.push({
      action: isActive ? 'reopened' : 'closed',
      by: req.user._id,
      byName: req.user.name,
    });
    await scheme.save();

    // Closing a scheme stops new grants. It does not revoke the concessions
    // already held under it, which would restate bills without anybody deciding
    // to.
    return res.status(200).json({
      success: true,
      message: isActive
        ? 'Scheme reopened for new concessions.'
        : 'Scheme closed to new concessions. Concessions already granted are unaffected.',
      data: scheme,
    });
  } catch (err) {
    return handleError(res, err, 'Could not change the scheme status');
  }
};

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * GET /concessions/invoice/:invoiceId
 *
 * What this invoice actually comes to. The published total is returned
 * alongside the net, never instead of it — a bill that hides its list price is
 * the reason families do not trust the discount on it.
 */
exports.getInvoicePricing = async (req, res) => {
  try {
    const { invoiceId } = req.params;
    if (!isValidId(invoiceId)) return fail(res, 400, 'Invalid invoice id.');

    const invoice = await FeeInvoice.findById(invoiceId);
    if (!invoice) return fail(res, 404, 'Invoice not found.');

    if (!isBursar(req.user) && !ownsStudent(req.user, invoice.student)) {
      return fail(res, 403, 'That invoice is not yours.');
    }

    const { pricing, structure } = await priceInvoice(invoice);

    return res.status(200).json({
      success: true,
      data: {
        invoice: {
          _id: invoice._id,
          invoiceNumber: invoice.invoiceNumber,
          studentName: invoice.studentName,
          className: invoice.className,
          academicYear: invoice.academicYear,
          lineItems: invoice.lineItems,
          totalAmount: invoice.totalAmount,
          amountPaid: invoice.amountPaid,
          balance: invoice.balance,
          status: invoice.status,
          dueDate: invoice.dueDate,
          currency: invoice.currency,
        },
        structureName: structure ? structure.name : null,
        pricing,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not price that invoice');
  }
};

/**
 * GET /concessions/preview?invoiceId&schemeId
 *
 * What the invoice would come to under a scheme that has not been granted.
 *
 * Answered before anything is written, because "what would this cost the
 * school" is the question the decision turns on, and finding out by granting it
 * and looking is not a workflow.
 */
exports.preview = async (req, res) => {
  try {
    const { invoiceId, schemeId } = req.query;

    if (!isValidId(invoiceId)) return fail(res, 400, 'Invalid invoice id.');
    if (!isValidId(schemeId)) return fail(res, 400, 'Invalid scheme id.');

    const [invoice, scheme] = await Promise.all([
      FeeInvoice.findById(invoiceId),
      ConcessionScheme.findById(schemeId),
    ]);

    if (!invoice) return fail(res, 404, 'Invoice not found.');
    if (!scheme) return fail(res, 404, 'Scheme not found.');

    const structure = invoice.feeStructure
      ? await FeeStructure.findById(invoice.feeStructure).select('components name')
      : null;

    const existing = await FeeConcession.find({
      student: invoice.student,
      academicYear: invoice.academicYear,
      status: 'approved',
    });

    const before = FeeConcession.applyTo(invoice, structure, existing);

    // A throwaway document, never saved: it exists only to be priced.
    const hypothetical = new FeeConcession({
      student: invoice.student,
      studentName: invoice.studentName,
      academicYear: invoice.academicYear,
      scheme: scheme._id,
      schemeCode: scheme.code,
      schemeName: scheme.name,
      basis: scheme.basis,
      rate: scheme.rate,
      appliesTo: scheme.appliesTo,
      stackable: scheme.stackable,
      status: 'approved',
    });

    const after = FeeConcession.applyTo(invoice, structure, [...existing, hypothetical]);

    return res.status(200).json({
      success: true,
      data: {
        scheme: { _id: scheme._id, code: scheme.code, name: scheme.name, basis: scheme.basis, rate: scheme.rate },
        before,
        after,
        // What this one scheme is actually worth once the ceiling has had its
        // say, which is not the same as its headline rate.
        marginalValue: after.concessionAmount - before.concessionAmount,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not preview that concession');
  }
};

// ---------------------------------------------------------------------------
// Concessions
// ---------------------------------------------------------------------------

exports.createConcession = async (req, res) => {
  try {
    const { studentId, schemeId, reason = '', className = '' } = req.body;

    if (!isValidId(studentId)) return fail(res, 400, 'Invalid student id.');
    if (!isValidId(schemeId)) return fail(res, 400, 'Invalid scheme id.');

    const [student, scheme] = await Promise.all([
      User.findById(studentId).select('name role'),
      ConcessionScheme.findById(schemeId),
    ]);

    if (!student) return fail(res, 404, 'That student does not exist.');
    if (student.role !== 'student') return fail(res, 400, 'Concessions are held by students.');
    if (!scheme) return fail(res, 404, 'Scheme not found.');
    if (!scheme.isActive) return fail(res, 409, `"${scheme.name}" is closed to new concessions.`);

    const concession = new FeeConcession({
      student: student._id,
      studentName: student.name,
      className,
      academicYear: scheme.academicYear,
      scheme: scheme._id,
      schemeCode: scheme.code,
      schemeName: scheme.name,
      // Frozen here, at grant time, from the scheme table.
      basis: scheme.basis,
      rate: scheme.rate,
      appliesTo: scheme.appliesTo,
      stackable: scheme.stackable,
      evidenceRequired: scheme.requiresEvidence,
      reason,
      requestedBy: req.user._id,
      requestedByName: req.user.name,
    });

    concession.log('created', req.user, scheme.name);
    await concession.save();

    return res.status(201).json({
      success: true,
      message: `${student.name} has a draft ${scheme.name} concession.`,
      data: publicConcession(concession),
    });
  } catch (err) {
    if (err.code === 11000) {
      return fail(
        res,
        409,
        'That student already holds a live concession under this scheme for this year.'
      );
    }
    if (err.name === 'ValidationError') {
      return fail(res, 400, Object.values(err.errors)[0].message);
    }
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, 'Could not create the concession');
  }
};

exports.listConcessions = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = {};

    if (req.query.status) filter.status = req.query.status;
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;
    if (req.query.schemeCode) filter.schemeCode = req.query.schemeCode;
    if (req.query.className) filter.className = req.query.className;
    if (isValidId(req.query.studentId)) filter.student = req.query.studentId;

    const [concessions, total] = await Promise.all([
      FeeConcession.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      FeeConcession.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      count: concessions.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      data: concessions.map(publicConcession),
    });
  } catch (err) {
    return handleError(res, err, 'Could not list concessions');
  }
};

exports.getMyConcessions = async (req, res) => {
  try {
    const concessions = await FeeConcession.find({
      student: req.user._id,
      // Drafts are the office thinking aloud. A family sees a concession once
      // somebody has decided to ask for it.
      status: { $ne: 'draft' },
    }).sort({ createdAt: -1 });

    const invoices = await FeeInvoice.find({ student: req.user._id }).sort({ dueDate: -1 }).limit(10);

    const priced = [];
    for (const invoice of invoices) {
      const { pricing } = await priceInvoice(invoice);
      priced.push({
        _id: invoice._id,
        invoiceNumber: invoice.invoiceNumber,
        academicYear: invoice.academicYear,
        dueDate: invoice.dueDate,
        status: invoice.status,
        currency: invoice.currency,
        ...pricing,
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        concessions: concessions.map(familyConcession),
        invoices: priced,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load your concessions');
  }
};

exports.getConcession = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid concession id.');

    const concession = await FeeConcession.findById(id);
    if (!concession) return fail(res, 404, 'Concession not found.');

    // "Mine or bursar" is not a role, so ownership is decided here.
    if (!isBursar(req.user) && !ownsStudent(req.user, concession.student)) {
      return fail(res, 403, 'That concession is not yours.');
    }

    return res.status(200).json({
      success: true,
      data: isBursar(req.user) ? publicConcession(concession) : familyConcession(concession),
    });
  } catch (err) {
    return handleError(res, err, 'Could not load that concession');
  }
};

const transition = (verb, apply) => async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid concession id.');

    const concession = await FeeConcession.findById(id);
    if (!concession) return fail(res, 404, 'Concession not found.');

    apply(concession, req);
    await concession.save();

    return res.status(200).json({
      success: true,
      message: `Concession ${verb}.`,
      data: publicConcession(concession),
    });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return fail(res, 400, Object.values(err.errors)[0].message);
    }
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, `Could not ${verb.replace(/d$/, '')} the concession`);
  }
};

exports.submitConcession = transition('submitted', (concession, req) =>
  concession.submit(req.user)
);

exports.recordEvidence = transition('evidence recorded', (concession, req) =>
  concession.recordEvidence(req.user, req.body.evidenceReference)
);

exports.approveConcession = transition('approved', (concession, req) =>
  concession.approve(req.user)
);

exports.rejectConcession = transition('rejected', (concession, req) =>
  concession.reject(req.user, req.body.reason)
);

exports.revokeConcession = transition('revoked', (concession, req) =>
  concession.revoke(req.user, req.body.reason)
);

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

/**
 * GET /concessions/register
 *
 * What the school gave away, by scheme and by class. This is the figure the
 * trustees ask for in March and that nobody can currently produce, because
 * today a concession is either a full waiver or an edited line item.
 */
exports.getRegister = async (req, res) => {
  try {
    const academicYear = req.query.academicYear;
    const filter = { status: 'approved' };
    if (academicYear) filter.academicYear = academicYear;

    const concessions = await FeeConcession.find(filter);
    if (!concessions.length) {
      return res.status(200).json({
        success: true,
        data: { academicYear: academicYear || null, totalValue: 0, bySchemeRows: [], byClassRows: [], studentCount: 0 },
      });
    }

    const studentIds = [...new Set(concessions.map((row) => String(row.student)))];
    const invoices = await FeeInvoice.find({
      student: { $in: studentIds },
      ...(academicYear ? { academicYear } : {}),
    });

    const structureIds = [
      ...new Set(invoices.map((invoice) => String(invoice.feeStructure)).filter(Boolean)),
    ];
    const structures = await FeeStructure.find({ _id: { $in: structureIds } }).select('components');
    const byStructure = new Map(structures.map((structure) => [String(structure._id), structure]));

    const byStudent = new Map();
    concessions.forEach((concession) => {
      const key = String(concession.student);
      if (!byStudent.has(key)) byStudent.set(key, []);
      byStudent.get(key).push(concession);
    });

    const bySchemeTotals = new Map();
    const byClassTotals = new Map();
    let totalValue = 0;

    /**
     * Priced per invoice rather than per concession, because the ceiling and
     * the outstanding clamp are properties of the invoice — a concession is
     * worth what it actually took off a bill, which the headline rate does not
     * tell you.
     */
    invoices.forEach((invoice) => {
      const held = byStudent.get(String(invoice.student)) || [];
      if (!held.length) return;

      const pricing = FeeConcession.applyTo(
        invoice,
        byStructure.get(String(invoice.feeStructure)) || null,
        held
      );

      totalValue += pricing.concessionAmount;

      const classKey = invoice.className || 'Unassigned';
      byClassTotals.set(classKey, (byClassTotals.get(classKey) || 0) + pricing.concessionAmount);

      pricing.rows.forEach((row) => {
        const current = bySchemeTotals.get(row.schemeCode) || {
          schemeCode: row.schemeCode,
          schemeName: row.schemeName,
          count: 0,
          value: 0,
        };
        current.count += 1;
        current.value += row.amount;
        bySchemeTotals.set(row.schemeCode, current);
      });
    });

    return res.status(200).json({
      success: true,
      data: {
        academicYear: academicYear || null,
        studentCount: studentIds.length,
        concessionCount: concessions.length,
        invoiceCount: invoices.length,
        totalValue,
        bySchemeRows: [...bySchemeTotals.values()].sort((a, b) => b.value - a.value),
        byClassRows: [...byClassTotals.entries()]
          .map(([className, value]) => ({ className, value }))
          .sort((a, b) => b.value - a.value),
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not build the concession register');
  }
};

exports.isAdmin = isAdmin;
