// backend/controllers/admissionDocumentController.js
const mongoose = require('mongoose');
const Application = require('../models/Application');
const AdmissionDocument = require('../models/AdmissionDocument');
const { DocumentRequirement } = require('../models/AdmissionDocument');

/**
 * Admission document requirements, receipt and verification.
 *
 * The checklist is computed on every call. Nothing stores whether an
 * application is document-complete, because a stored flag written in March is
 * a lie by June once a medical certificate expires — and June is when the gap
 * is found under the current arrangement, with the child already enrolled.
 */

const handleError = (res, err, message = 'Server error') => {
  console.error('[admission-documents]', err);
  return res.status(500).json({ success: false, message, error: err.message });
};

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const getPagination = (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
};

/**
 * The checklist for one application: every active requirement that applies to
 * its grade, joined to whatever has been received against it.
 *
 * Returns rows rather than a verdict, because "not complete" without the rows
 * is a message that sends somebody to a filing cabinet.
 */
const buildChecklist = async (application, now = new Date()) => {
  const requirements = await DocumentRequirement.find({ isActive: true }).sort({ code: 1 });

  const applicable = requirements.filter((requirement) => requirement.appliesTo(application.grade));

  const documents = await AdmissionDocument.find({
    application: application._id,
    isLive: true,
  });

  const byCode = documents.reduce(
    (map, document) => ({ ...map, [document.requirementCode]: document }),
    {}
  );

  const rows = applicable.map((requirement) => {
    const document = byCode[requirement.code];
    const state = document ? document.assess(requirement, now) : 'missing';

    return {
      requirement: requirement._id,
      code: requirement.code,
      label: requirement.label,
      description: requirement.description,
      isMandatory: requirement.isMandatory,
      maxAgeMonths: requirement.maxAgeMonths,
      acceptedFormats: requirement.acceptedFormats,
      state,
      document: document
        ? {
            _id: document._id,
            format: document.format,
            reference: document.reference,
            issuedOn: document.issuedOn,
            expiresOn: document.expiresOn,
            issuingAuthority: document.issuingAuthority,
            receivedBy: document.receivedBy,
            receivedAt: document.receivedAt,
            verifiedBy: document.verifiedBy,
            verifiedAt: document.verifiedAt,
            rejectionReason: document.rejectionReason,
          }
        : null,
    };
  });

  const mandatory = rows.filter((row) => row.isMandatory);
  const outstanding = mandatory.filter((row) => row.state !== 'verified');

  return {
    rows,
    mandatoryCount: mandatory.length,
    mandatoryVerified: mandatory.length - outstanding.length,
    outstanding,
    complete: outstanding.length === 0 && mandatory.length > 0,
  };
};

// ---- REFERENCE DATA ----

/**
 * GET /api/applications/documents/meta
 */
exports.getDocumentMeta = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        codes: AdmissionDocument.CODES,
        formats: AdmissionDocument.FORMATS,
        states: AdmissionDocument.STATES,
        checklistStates: AdmissionDocument.CHECKLIST_STATES,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load document reference data');
  }
};

// ---- REQUIREMENTS ----

/**
 * POST /api/applications/documents/requirements
 * The rule, as data. Today it is a sentence in somebody's head, applied
 * inconsistently across a season.
 */
exports.createRequirement = async (req, res) => {
  try {
    const {
      code,
      label,
      description,
      appliesToGrades,
      isMandatory,
      requiresIssueDate,
      maxAgeMonths,
      requiresExpiryDate,
      acceptedFormats,
    } = req.body;

    if (!AdmissionDocument.CODES.includes(code)) {
      return res.status(400).json({
        success: false,
        message: `Code must be one of: ${AdmissionDocument.CODES.join(', ')}`,
      });
    }
    if (!label || !String(label).trim()) {
      return res.status(400).json({ success: false, message: 'A label is required.' });
    }

    const formats = Array.isArray(acceptedFormats) && acceptedFormats.length
      ? acceptedFormats.filter((format) => AdmissionDocument.FORMATS.includes(format))
      : AdmissionDocument.FORMATS;

    const requirement = new DocumentRequirement({
      code,
      label: String(label).trim(),
      description: String(description || '').trim(),
      appliesToGrades: Array.isArray(appliesToGrades)
        ? appliesToGrades.map((grade) => String(grade).trim()).filter(Boolean)
        : [],
      isMandatory: isMandatory !== false,
      requiresIssueDate: Boolean(requiresIssueDate) || Number(maxAgeMonths) > 0,
      maxAgeMonths: Number(maxAgeMonths) || 0,
      requiresExpiryDate: Boolean(requiresExpiryDate),
      acceptedFormats: formats,
      createdBy: req.user._id,
    });

    requirement.log('created', req.user, code);

    try {
      await requirement.save();
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({
          success: false,
          message: `There is already a live requirement for ${code}. Retire it first.`,
        });
      }
      throw err;
    }

    return res.status(201).json({ success: true, message: 'Requirement added.', data: requirement });
  } catch (err) {
    if (err.name === 'ValidationError' || err.message.includes('issue date')) {
      return res.status(400).json({ success: false, message: err.message });
    }
    return handleError(res, err, 'Could not create the requirement');
  }
};

/**
 * GET /api/applications/documents/requirements
 */
exports.getRequirements = async (req, res) => {
  try {
    const filter = req.query.includeRetired === 'true' ? {} : { isActive: true };

    const requirements = await DocumentRequirement.find(filter)
      .populate('createdBy', 'name role')
      .sort({ code: 1 });

    return res.status(200).json({ success: true, count: requirements.length, data: requirements });
  } catch (err) {
    return handleError(res, err, 'Could not load requirements');
  }
};

/**
 * PATCH /api/applications/documents/requirements/:id
 */
exports.updateRequirement = async (req, res) => {
  try {
    const { id } = req.params;
    const { label, description, appliesToGrades, isMandatory, maxAgeMonths, requiresExpiryDate } =
      req.body;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid requirement id.' });
    }

    const requirement = await DocumentRequirement.findById(id);
    if (!requirement) {
      return res.status(404).json({ success: false, message: 'Requirement not found.' });
    }
    if (!requirement.isActive) {
      return res.status(409).json({
        success: false,
        message: 'A retired requirement cannot be edited. Create a new one instead.',
      });
    }

    if (label !== undefined) requirement.label = String(label).trim();
    if (description !== undefined) requirement.description = String(description).trim();
    if (Array.isArray(appliesToGrades)) {
      requirement.appliesToGrades = appliesToGrades.map((grade) => String(grade).trim()).filter(Boolean);
    }
    if (isMandatory !== undefined) requirement.isMandatory = Boolean(isMandatory);
    if (maxAgeMonths !== undefined) {
      requirement.maxAgeMonths = Number(maxAgeMonths) || 0;
      if (requirement.maxAgeMonths > 0) requirement.requiresIssueDate = true;
    }
    if (requiresExpiryDate !== undefined) requirement.requiresExpiryDate = Boolean(requiresExpiryDate);

    requirement.log('updated', req.user);

    await requirement.save();

    return res.status(200).json({ success: true, message: 'Requirement updated.', data: requirement });
  } catch (err) {
    if (err.name === 'ValidationError' || err.message.includes('issue date')) {
      return res.status(400).json({ success: false, message: err.message });
    }
    return handleError(res, err, 'Could not update the requirement');
  }
};

/**
 * PATCH /api/applications/documents/requirements/:id/retire
 * Retired, not deleted — an application assessed against last year's rules
 * stays explicable.
 */
exports.retireRequirement = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid requirement id.' });
    }

    const requirement = await DocumentRequirement.findById(id);
    if (!requirement) {
      return res.status(404).json({ success: false, message: 'Requirement not found.' });
    }
    if (!requirement.isActive) {
      return res.status(409).json({ success: false, message: 'That requirement is already retired.' });
    }

    requirement.retiredAt = new Date();
    requirement.log('retired', req.user, String(req.body.note || '').trim());

    await requirement.save();

    return res.status(200).json({
      success: true,
      message: 'Requirement retired. It no longer appears on new checklists.',
      data: requirement,
    });
  } catch (err) {
    return handleError(res, err, 'Could not retire the requirement');
  }
};

// ---- DOCUMENTS ----

/**
 * POST /api/applications/documents/:applicationId
 *
 * Receipt, not verification. Whoever is at the counter records what arrived;
 * somebody else has to say it is genuine.
 */
exports.receiveDocument = async (req, res) => {
  try {
    const { applicationId } = req.params;
    const { requirementCode, format, reference, issuedOn, expiresOn, issuingAuthority } = req.body;

    if (!isValidId(applicationId)) {
      return res.status(400).json({ success: false, message: 'Invalid application id.' });
    }

    const application = await Application.findById(applicationId);
    if (!application) {
      return res.status(404).json({ success: false, message: 'Application not found.' });
    }

    const requirement = await DocumentRequirement.findOne({ code: requirementCode, isActive: true });
    if (!requirement) {
      return res.status(404).json({
        success: false,
        message: 'There is no live requirement with that code.',
      });
    }
    if (!requirement.appliesTo(application.grade)) {
      return res.status(409).json({
        success: false,
        message: `${requirement.label} is not required for ${application.grade}.`,
      });
    }
    if (!requirement.acceptedFormats.includes(format)) {
      return res.status(400).json({
        success: false,
        message: `${requirement.label} is accepted as: ${requirement.acceptedFormats.join(', ')}.`,
      });
    }
    if (requirement.requiresIssueDate && !issuedOn) {
      return res.status(400).json({
        success: false,
        message: `${requirement.label} needs an issue date.`,
      });
    }
    if (requirement.requiresExpiryDate && !expiresOn) {
      return res.status(400).json({
        success: false,
        message: `${requirement.label} needs an expiry date.`,
      });
    }

    // A replacement supersedes rather than overwrites, so a rejected
    // certificate and its correction are two rows and the history survives.
    const existing = await AdmissionDocument.findOne({
      application: application._id,
      requirementCode,
      isLive: true,
    });

    const document = new AdmissionDocument({
      application: application._id,
      requirementCode,
      format,
      reference: String(reference || '').trim(),
      issuedOn: issuedOn ? new Date(issuedOn) : null,
      expiresOn: expiresOn ? new Date(expiresOn) : null,
      issuingAuthority: String(issuingAuthority || '').trim(),
      receivedBy: req.user._id,
      receivedAt: new Date(),
    });

    document.log('received', req.user, format);

    if (existing) {
      existing.state = 'superseded';
      existing.isLive = false;
      existing.supersededBy = document._id;
      existing.log('superseded', req.user);
      await existing.save();
    }

    try {
      await document.save();
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({
          success: false,
          message: 'A live document for that requirement already exists on this application.',
        });
      }
      throw err;
    }

    return res.status(201).json({
      success: true,
      message: existing
        ? `${requirement.label} recorded. It supersedes the previous one.`
        : `${requirement.label} recorded and awaiting verification.`,
      data: document,
    });
  } catch (err) {
    if (err.name === 'ValidationError' || err.message.includes('expire')) {
      return res.status(400).json({ success: false, message: err.message });
    }
    return handleError(res, err, 'Could not record the document');
  }
};

/**
 * GET /api/applications/documents/:applicationId
 */
exports.getDocuments = async (req, res) => {
  try {
    const { applicationId } = req.params;

    if (!isValidId(applicationId)) {
      return res.status(400).json({ success: false, message: 'Invalid application id.' });
    }

    const documents = await AdmissionDocument.find({ application: applicationId })
      .populate('receivedBy', 'name role')
      .populate('verifiedBy', 'name role')
      .sort({ receivedAt: -1 });

    return res.status(200).json({ success: true, count: documents.length, data: documents });
  } catch (err) {
    return handleError(res, err, 'Could not load the documents');
  }
};

/**
 * GET /api/applications/documents/:applicationId/checklist
 */
exports.getChecklist = async (req, res) => {
  try {
    const { applicationId } = req.params;

    if (!isValidId(applicationId)) {
      return res.status(400).json({ success: false, message: 'Invalid application id.' });
    }

    const application = await Application.findById(applicationId);
    if (!application) {
      return res.status(404).json({ success: false, message: 'Application not found.' });
    }

    const checklist = await buildChecklist(application);

    return res.status(200).json({
      success: true,
      data: {
        application: {
          _id: application._id,
          studentName: application.studentName,
          grade: application.grade,
          status: application.status,
        },
        ...checklist,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not build the checklist');
  }
};

/**
 * PATCH /api/applications/documents/item/:id/verify
 * The second pair of eyes. This is the rule the pencil tick has never had.
 */
exports.verifyDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid document id.' });
    }

    const document = await AdmissionDocument.findById(id);
    if (!document) {
      return res.status(404).json({ success: false, message: 'Document not found.' });
    }

    try {
      document.verify(req.user, note);
    } catch (err) {
      return res.status(403).json({ success: false, message: err.message });
    }

    await document.save();

    return res.status(200).json({ success: true, message: 'Document verified.', data: document });
  } catch (err) {
    return handleError(res, err, 'Could not verify the document');
  }
};

/**
 * PATCH /api/applications/documents/item/:id/reject
 */
exports.rejectDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid document id.' });
    }

    const document = await AdmissionDocument.findById(id);
    if (!document) {
      return res.status(404).json({ success: false, message: 'Document not found.' });
    }

    try {
      document.reject(req.user, reason);
    } catch (err) {
      return res.status(403).json({ success: false, message: err.message });
    }

    await document.save();

    return res.status(200).json({
      success: true,
      message: 'Document rejected. The applicant needs to bring a replacement.',
      data: document,
    });
  } catch (err) {
    return handleError(res, err, 'Could not reject the document');
  }
};

/**
 * GET /api/applications/documents/:applicationId/clearance
 *
 * The gate an admissions decision should pass through: is this application
 * documented, right now?
 *
 * A GET rather than a PATCH on purpose. There is nothing to store — an
 * application cleared in March is not cleared in June once a certificate
 * expires, so the answer has to be recomputed at the moment it is asked for.
 * A stored `documentsComplete` flag would be exactly the lie this module
 * exists to remove.
 */
exports.getClearance = async (req, res) => {
  try {
    const { applicationId } = req.params;

    if (!isValidId(applicationId)) {
      return res.status(400).json({ success: false, message: 'Invalid application id.' });
    }

    const application = await Application.findById(applicationId);
    if (!application) {
      return res.status(404).json({ success: false, message: 'Application not found.' });
    }

    const checklist = await buildChecklist(application);

    if (checklist.mandatoryCount === 0) {
      return res.status(200).json({
        success: true,
        message:
          'No mandatory document requirements apply to this grade. ' +
          'That is not the same as being documented — add the requirements first.',
        data: { application: application._id, cleared: false, mandatoryCount: 0, outstanding: [] },
      });
    }

    const cleared = checklist.outstanding.length === 0;

    return res.status(200).json({
      success: true,
      message: cleared
        ? `All ${checklist.mandatoryCount} mandatory documents are verified and in date.`
        : `${checklist.outstanding.length} mandatory document(s) are not verified.`,
      data: {
        application: application._id,
        cleared,
        checkedAt: new Date(),
        mandatoryCount: checklist.mandatoryCount,
        mandatoryVerified: checklist.mandatoryVerified,
        outstanding: checklist.outstanding.map((row) => ({
          code: row.code,
          label: row.label,
          state: row.state,
        })),
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not check the clearance');
  }
};

/**
 * GET /api/applications/documents/outstanding
 *
 * The report the front desk currently rebuilds by hand every morning of
 * admission week: which applications are still missing something, and what.
 */
exports.getOutstanding = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = req.query.status ? { status: req.query.status } : { status: 'Pending' };

    const [applications, total] = await Promise.all([
      Application.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Application.countDocuments(filter),
    ]);

    const now = new Date();
    const rows = [];

    for (const application of applications) {
      const checklist = await buildChecklist(application, now);

      if (checklist.outstanding.length) {
        rows.push({
          application: {
            _id: application._id,
            studentName: application.studentName,
            grade: application.grade,
            status: application.status,
            createdAt: application.createdAt,
          },
          mandatoryCount: checklist.mandatoryCount,
          mandatoryVerified: checklist.mandatoryVerified,
          outstanding: checklist.outstanding.map((row) => ({
            code: row.code,
            label: row.label,
            state: row.state,
          })),
        });
      }
    }

    return res.status(200).json({
      success: true,
      count: rows.length,
      scanned: applications.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      data: rows,
    });
  } catch (err) {
    return handleError(res, err, 'Could not build the outstanding list');
  }
};

/**
 * GET /api/applications/documents/stats
 */
exports.getDocumentStats = async (req, res) => {
  try {
    const [byState, byCode, unverified] = await Promise.all([
      AdmissionDocument.aggregate([
        { $group: { _id: '$state', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      AdmissionDocument.aggregate([
        { $match: { isLive: true } },
        { $group: { _id: '$requirementCode', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      AdmissionDocument.countDocuments({ state: 'submitted' }),
    ]);

    // Present, in date, and still nobody has looked at it. That queue length is
    // the honest measure of whether verification is actually happening.
    return res.status(200).json({
      success: true,
      data: { byState, byCode, awaitingVerification: unverified },
    });
  } catch (err) {
    return handleError(res, err, 'Could not build the document statistics');
  }
};
