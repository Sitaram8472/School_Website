const mongoose = require('mongoose');
const CertificateRequest = require('../models/CertificateRequest');

/**
 * Certificate and official-document requests.
 *
 * Two audiences: the student tracking their request, and the office working
 * the queue. Plus one endpoint with no audience at all — `verifyCertificate`
 * is public, because a certificate nobody can check is decoration.
 */

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

function serverError(res, error, message) {
  console.error(`${message}:`, error);
  return res.status(500).json({ success: false, message, error: error.message });
}

function validationMessage(error) {
  if (!error) return null;
  if (error.name === 'ValidationError') {
    return Object.values(error.errors).map((e) => e.message).join(' ');
  }
  if (error.name === 'ValidatorError' || error.name === 'CastError') {
    return error.message;
  }
  return null;
}

function isStaff(user) {
  return ['teacher', 'staff', 'admin'].includes(user.role);
}

function ownsRequest(request, user) {
  return String(request.requestedBy) === String(user._id);
}

/**
 * Wraps a `moveTo` so an illegal transition comes back as a 409 rather than a
 * 500. Returns an error message, or null when the move succeeded.
 */
function tryMove(request, to, actor, detail) {
  try {
    request.moveTo(to, actor, detail);
    return null;
  } catch (error) {
    if (error.code === 'ILLEGAL_TRANSITION') return error.message;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Requesting
// ---------------------------------------------------------------------------

/**
 * POST /api/certificates
 */
exports.submitRequest = async (req, res) => {
  try {
    const {
      type,
      studentName,
      className,
      rollNumber,
      purpose,
      copies,
      deliveryMode,
      postalAddress,
    } = req.body;

    const request = new CertificateRequest({
      type,
      requestedBy: req.user._id,
      studentName: studentName || req.user.name,
      className,
      rollNumber,
      purpose,
      copies,
      deliveryMode,
      postalAddress,
      // requestNumber, status, serialNumber and verificationCode are all
      // server-owned and deliberately not read from the body.
    });

    // Validate before burning a sequence number — otherwise a form with a
    // missing purpose leaves a hole in the request numbering.
    const invalid = request.validateSync();
    if (invalid) return fail(res, 400, validationMessage(invalid));

    request.requestNumber = await CertificateRequest.nextRequestNumber();
    request.recordAudit('request:submitted', req.user, request.type);
    await request.save();

    return res.status(201).json({
      success: true,
      message: `Request submitted. Your reference is ${request.requestNumber}.`,
      data: request.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to submit the request');
  }
};

/**
 * GET /api/certificates/mine
 */
exports.getMyRequests = async (req, res) => {
  try {
    const requests = await CertificateRequest.find({ requestedBy: req.user._id })
      .sort({ createdAt: -1 })
      .limit(100);

    return res.status(200).json({
      success: true,
      count: requests.length,
      data: requests.map((request) => request.redactFor(req.user)),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch your requests');
  }
};

/**
 * GET /api/certificates/:id
 */
exports.getRequest = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid request id.');

    const request = await CertificateRequest.findById(req.params.id);
    if (!request) return fail(res, 404, 'Request not found.');

    if (!isStaff(req.user) && !ownsRequest(request, req.user)) {
      return fail(res, 403, 'You can only view your own requests.');
    }

    return res.status(200).json({ success: true, data: request.redactFor(req.user) });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the request');
  }
};

/**
 * PATCH /api/certificates/:id/cancel
 * The requester withdrawing, before the office has committed to anything.
 */
exports.cancelRequest = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid request id.');

    const request = await CertificateRequest.findById(req.params.id);
    if (!request) return fail(res, 404, 'Request not found.');
    if (!ownsRequest(request, req.user)) {
      return fail(res, 403, 'You can only cancel your own request.');
    }

    const refusal = tryMove(request, 'cancelled', req.user, req.body.reason || null);
    if (refusal) return fail(res, 409, refusal);

    await request.save();

    return res.status(200).json({
      success: true,
      message: 'Request cancelled.',
      data: request.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to cancel the request');
  }
};

/**
 * POST /api/certificates/:id/remarks
 * A public reply. The requester may answer an information request here; staff
 * may also post an internal note the requester never sees.
 */
exports.addRemark = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid request id.');

    const { body, isInternal } = req.body;

    const request = await CertificateRequest.findById(req.params.id);
    if (!request) return fail(res, 404, 'Request not found.');

    const staff = isStaff(req.user);
    if (!staff && !ownsRequest(request, req.user)) {
      return fail(res, 403, 'You can only comment on your own request.');
    }

    const remark = request.remarks.create({
      author: req.user._id,
      authorName: req.user.name,
      body,
      // Only staff can mark a remark internal. A requester posting
      // `isInternal: true` would otherwise be able to hide their own reply.
      isInternal: staff ? Boolean(isInternal) : false,
      at: new Date(),
    });

    let invalid = null;
    try {
      invalid = remark.validateSync() || null;
    } catch (error) {
      // A detached array subdocument throws its ValidatorError rather than
      // returning a ValidationError — uncaught, that is a 500 for an empty box.
      invalid = error;
    }
    if (invalid) return fail(res, 400, validationMessage(invalid) || 'Invalid remark.');

    request.remarks.push(remark);

    // A requester answering an information request moves it back into the
    // queue, so it does not sit in `info-required` forever waiting for
    // somebody to notice the reply.
    if (!staff && request.status === 'info-required') {
      tryMove(request, 'under-review', req.user, 'requester responded');
    }

    request.recordAudit('remark:added', req.user, remark.isInternal ? 'internal' : 'public');
    await request.save();

    return res.status(201).json({
      success: true,
      message: 'Remark added.',
      data: request.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to add the remark');
  }
};

// ---------------------------------------------------------------------------
// Office queue
// ---------------------------------------------------------------------------

/**
 * GET /api/certificates/queue
 */
exports.getQueue = async (req, res) => {
  try {
    const { status, type, search } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (search) {
      const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { requestNumber: new RegExp(safe, 'i') },
        { studentName: new RegExp(safe, 'i') },
        { rollNumber: new RegExp(safe, 'i') },
      ];
    }

    const requests = await CertificateRequest.find(filter)
      .sort({ createdAt: 1 })
      .limit(200);

    return res.status(200).json({
      success: true,
      count: requests.length,
      data: requests.map((request) => request.redactFor(req.user)),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the queue');
  }
};

/**
 * PATCH /api/certificates/:id/review
 */
exports.startReview = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid request id.');

    const request = await CertificateRequest.findById(req.params.id);
    if (!request) return fail(res, 404, 'Request not found.');

    const refusal = tryMove(request, 'under-review', req.user);
    if (refusal) return fail(res, 409, refusal);

    await request.save();

    return res.status(200).json({
      success: true,
      message: 'Request taken up for review.',
      data: request.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to start the review');
  }
};

/**
 * PATCH /api/certificates/:id/request-info
 * Ask the student for something. The question is posted as a public remark so
 * they actually learn what is needed rather than just seeing a status change.
 */
exports.requestInformation = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid request id.');

    const { question } = req.body;
    if (!question || !question.trim()) {
      return fail(res, 400, 'Say what information is needed.');
    }

    const request = await CertificateRequest.findById(req.params.id);
    if (!request) return fail(res, 404, 'Request not found.');

    const refusal = tryMove(request, 'info-required', req.user, question.trim());
    if (refusal) return fail(res, 409, refusal);

    request.remarks.push({
      author: req.user._id,
      authorName: req.user.name,
      body: question.trim(),
      isInternal: false,
      at: new Date(),
    });

    await request.save();

    return res.status(200).json({
      success: true,
      message: 'Information requested from the student.',
      data: request.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to request information');
  }
};

/**
 * PATCH /api/certificates/:id/approve
 * Approval is not issuance — it means the office is satisfied the document can
 * be written. Nothing is numbered yet.
 */
exports.approveRequest = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid request id.');

    const request = await CertificateRequest.findById(req.params.id);
    if (!request) return fail(res, 404, 'Request not found.');

    const refusal = tryMove(request, 'approved', req.user, req.body.note || null);
    if (refusal) return fail(res, 409, refusal);

    await request.save();

    return res.status(200).json({
      success: true,
      message: 'Approved. Issue the certificate to allot a serial number.',
      data: request.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to approve the request');
  }
};

/**
 * PATCH /api/certificates/:id/issue
 *
 * The moment the document becomes real. The serial and the verification code
 * are allotted here and nowhere else, which is what makes "a request that is
 * never issued never has one" true by construction.
 */
exports.issueCertificate = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid request id.');

    const request = await CertificateRequest.findById(req.params.id);
    if (!request) return fail(res, 404, 'Request not found.');

    // Checked before the transition so a second issue attempt on an
    // already-issued certificate cannot overwrite the serial.
    if (request.serialNumber) {
      return fail(
        res,
        409,
        `This certificate was already issued as ${request.serialNumber}.`
      );
    }

    const refusal = tryMove(request, 'issued', req.user);
    if (refusal) return fail(res, 409, refusal);

    try {
      await request.allotIssuance(req.user);
    } catch (error) {
      if (error.code === 'ALREADY_ISSUED') return fail(res, 409, error.message);
      throw error;
    }

    await request.save();

    return res.status(200).json({
      success: true,
      message: `Issued as ${request.serialNumber}.`,
      data: request.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to issue the certificate');
  }
};

/**
 * PATCH /api/certificates/:id/collected
 */
exports.markCollected = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid request id.');

    const request = await CertificateRequest.findById(req.params.id);
    if (!request) return fail(res, 404, 'Request not found.');

    const refusal = tryMove(request, 'collected', req.user, req.body.note || null);
    if (refusal) return fail(res, 409, refusal);

    request.collectedAt = new Date();
    await request.save();

    return res.status(200).json({
      success: true,
      message: 'Marked as collected.',
      data: request.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to mark the request collected');
  }
};

/**
 * PATCH /api/certificates/:id/reject
 */
exports.rejectRequest = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid request id.');

    const { reason } = req.body;
    if (!reason || !reason.trim()) {
      return fail(res, 400, 'A reason is required so the student knows why.');
    }

    const request = await CertificateRequest.findById(req.params.id);
    if (!request) return fail(res, 404, 'Request not found.');

    const refusal = tryMove(request, 'rejected', req.user, reason.trim());
    if (refusal) return fail(res, 409, refusal);

    request.rejectionReason = reason.trim();
    // Posted publicly, not just stored — a rejection the student cannot read
    // is a rejection they will queue up to ask about.
    request.remarks.push({
      author: req.user._id,
      authorName: req.user.name,
      body: `Request rejected: ${reason.trim()}`,
      isInternal: false,
      at: new Date(),
    });

    await request.save();

    return res.status(200).json({
      success: true,
      message: 'Request rejected.',
      data: request.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to reject the request');
  }
};

/**
 * PATCH /api/certificates/:id/revoke
 *
 * The certificate stays on file with its serial intact — revocation is a state
 * the public endpoint reports, not an erasure. A revoked serial that returned
 * "never existed" would be worse than useless to whoever is holding a copy.
 */
exports.revokeCertificate = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid request id.');

    const { reason } = req.body;
    if (!reason || !reason.trim()) {
      return fail(res, 400, 'A revocation reason is required.');
    }

    const request = await CertificateRequest.findById(req.params.id);
    if (!request) return fail(res, 404, 'Request not found.');

    const refusal = tryMove(request, 'revoked', req.user, reason.trim());
    if (refusal) return fail(res, 409, refusal);

    request.revokedAt = new Date();
    request.revokedBy = req.user._id;
    request.revocationReason = reason.trim();
    await request.save();

    return res.status(200).json({
      success: true,
      message: `${request.serialNumber} revoked.`,
      data: request.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to revoke the certificate');
  }
};

// ---------------------------------------------------------------------------
// Public verification
// ---------------------------------------------------------------------------

/**
 * GET /api/certificates/verify/:code
 *
 * Deliberately public — the party that needs to check a certificate is a
 * college admissions clerk who has no account here and never will.
 *
 * An unknown code and a revoked one both come back `valid: false`. They are
 * different situations, but answering "that code has never existed" turns the
 * endpoint into an oracle: anyone could probe it to work out the shape of the
 * serial space, or confirm a guess. The payload for a real certificate is
 * likewise the minimum an admissions clerk needs — never the purpose, the
 * remarks or the audit trail.
 */
exports.verifyCertificate = async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();

    // Cheap shape check first, so a wildly wrong code never reaches the index.
    if (!code || code.length > 64) {
      return res.status(200).json({
        success: true,
        valid: false,
        message: 'No certificate matches that verification code.',
      });
    }

    const request = await CertificateRequest.findOne({ verificationCode: code });

    if (!request || !['issued', 'collected', 'revoked'].includes(request.status)) {
      return res.status(200).json({
        success: true,
        valid: false,
        message: 'No certificate matches that verification code.',
      });
    }

    const payload = request.toVerificationPayload();

    return res.status(200).json({
      success: true,
      ...payload,
      message: payload.valid
        ? 'This certificate was issued by the school and is currently valid.'
        : payload.status === 'revoked'
          ? 'This certificate was issued by the school but has since been revoked.'
          : 'This certificate was issued by the school but has expired.',
    });
  } catch (error) {
    return serverError(res, error, 'Failed to verify the certificate');
  }
};

/**
 * GET /api/certificates/stats
 */
exports.getStats = async (req, res) => {
  try {
    const requests = await CertificateRequest.find({}).select(
      'status type createdAt issuedAt revokedAt'
    );

    const stats = {
      total: requests.length,
      open: 0,
      issued: 0,
      collected: 0,
      rejected: 0,
      revoked: 0,
      byType: {},
      averageTurnaroundHours: null,
    };

    const openStatuses = ['submitted', 'under-review', 'info-required', 'approved'];
    let turnaroundSum = 0;
    let turnaroundCount = 0;

    requests.forEach((request) => {
      if (openStatuses.includes(request.status)) stats.open += 1;
      if (request.status === 'issued') stats.issued += 1;
      if (request.status === 'collected') stats.collected += 1;
      if (request.status === 'rejected') stats.rejected += 1;
      if (request.status === 'revoked') stats.revoked += 1;

      stats.byType[request.type] = (stats.byType[request.type] || 0) + 1;

      if (request.issuedAt && request.createdAt) {
        turnaroundSum += request.issuedAt.getTime() - request.createdAt.getTime();
        turnaroundCount += 1;
      }
    });

    if (turnaroundCount > 0) {
      stats.averageTurnaroundHours = Math.round(
        turnaroundSum / turnaroundCount / 3600000
      );
    }

    return res.status(200).json({ success: true, stats });
  } catch (error) {
    return serverError(res, error, 'Failed to compute certificate statistics');
  }
};
