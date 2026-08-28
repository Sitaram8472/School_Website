const mongoose = require('mongoose');

const ProspectusRequest = require('../models/ProspectusRequest');
const { ProspectusCounter } = require('../models/ProspectusRequest');

/**
 * Printed prospectus requests.
 *
 * Two handlers carry the feature.
 *
 * `createRequest` is public, so it is the one that has to be careful. It takes
 * only the fields it knows about — never the request body spread into a model
 * — refuses a status or a reference supplied by the caller, and returns an
 * existing request unchanged when the same `requestKey` arrives twice. A
 * duplicate here is a second printed book and its postage, so retry-safety is
 * a cost control rather than a nicety.
 *
 * `trackRequest` is the other public one. It requires the reference *and* the
 * email it was created with, and answers from `toPublicRow`, which does not
 * carry the address, the phone number or the internal notes that sit on the
 * document beside them.
 */

const MAX_LIST = 200;

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

function serverError(res, error, message) {
  console.error(`${message}:`, error);
  return res.status(500).json({
    success: false,
    message,
    error: error.message,
  });
}

function validationMessage(error) {
  if (!error) return null;
  if (error.name === 'ValidationError') {
    return Object.values(error.errors)
      .map((e) => e.message)
      .join(' ');
  }
  if (error.name === 'ValidatorError' || error.name === 'CastError') {
    return error.message;
  }
  return null;
}

function clean(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

/**
 * GET /api/contact/prospectus/meta
 *
 * Public, because the form that uses it is public. It carries no data about
 * anybody's request — only the vocabulary the form needs.
 */
exports.getMeta = async (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      statuses: ProspectusRequest.STATUSES,
      channels: ProspectusRequest.CHANNELS,
      postalChannels: ProspectusRequest.POSTAL_CHANNELS,
      relationships: ProspectusRequest.RELATIONSHIPS,
      sources: ProspectusRequest.SOURCES,
      maxQuantity: ProspectusRequest.MAX_QUANTITY,
      nextStatuses: ProspectusRequest.NEXT_STATUSES,
    },
  });
};

/**
 * POST /api/contact/prospectus
 *
 * Public and rate limited. The limiter is attached in the route file, in front
 * of this handler on the same line — express runs matching middleware in
 * declaration order, so one registered afterwards would never run.
 */
exports.createRequest = async (req, res) => {
  try {
    const requestKey = clean(req.body.requestKey);
    if (!requestKey) {
      return fail(res, 400, 'A request key is required');
    }

    // The retry path. Answered before anything is written, so a second click
    // costs a read rather than a book.
    const existing = await ProspectusRequest.findOne({ requestKey });
    if (existing) {
      return res.status(200).json({
        success: true,
        message: 'This request has already been received',
        duplicate: true,
        data: existing.toPublicRow(),
      });
    }

    const channel = clean(req.body.channel, 'post');
    if (!ProspectusRequest.CHANNELS.includes(channel)) {
      return fail(res, 400, 'Choose how the prospectus should reach you');
    }

    const postal = ProspectusRequest.POSTAL_CHANNELS.includes(channel);
    const body = req.body.address || {};

    // Only the fields this handler knows about. `status`, `reference` and the
    // fulfilment timestamps are never taken from a public body.
    const request = new ProspectusRequest({
      requestKey,
      applicantName: clean(req.body.applicantName),
      email: clean(req.body.email).toLowerCase(),
      phone: clean(req.body.phone),
      relationship: clean(req.body.relationship, 'parent'),
      studentName: clean(req.body.studentName),
      gradeSought: clean(req.body.gradeSought),
      academicYear: clean(req.body.academicYear),
      intakeTerm: clean(req.body.intakeTerm),
      channel,
      quantity: Number(req.body.quantity) || 1,
      source: 'website',
      status: 'received',
      address: postal
        ? {
            line1: clean(body.line1),
            line2: clean(body.line2),
            city: clean(body.city),
            state: clean(body.state),
            postcode: clean(body.postcode),
            country: clean(body.country, 'India'),
          }
        : {},
    });

    request.reference = await ProspectusCounter.next(request.academicYear);
    request.log('received', null, `via ${request.source}`);

    await request.save();

    return res.status(201).json({
      success: true,
      message:
        'Your request has been received. Keep the reference below to check on it later.',
      data: request.toPublicRow(),
    });
  } catch (error) {
    // Two submissions racing on the same key: the index is the guard, and the
    // right answer is still "we have it", not an error the family has to read.
    if (error.code === 11000 && error.keyPattern && error.keyPattern.requestKey) {
      const existing = await ProspectusRequest.findOne({
        requestKey: clean(req.body.requestKey),
      });

      if (existing) {
        return res.status(200).json({
          success: true,
          message: 'This request has already been received',
          duplicate: true,
          data: existing.toPublicRow(),
        });
      }
    }

    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 400, message);

    return serverError(res, error, 'Failed to record the prospectus request');
  }
};

/**
 * GET /api/contact/prospectus/track
 *
 * Public. Requires the reference *and* the email it was created with, so a
 * guessed or overheard reference on its own gets nothing back.
 */
exports.trackRequest = async (req, res) => {
  try {
    const reference = clean(req.query.reference).toUpperCase();
    const email = clean(req.query.email).toLowerCase();

    if (!reference || !email) {
      return fail(res, 400, 'Give both the reference and the email address you used');
    }

    const request = await ProspectusRequest.findOne({ reference, email });

    // The same answer whether the reference does not exist or the email does
    // not match it, so this route cannot be used to find out which.
    if (!request) {
      return fail(res, 404, 'No request matches that reference and email address');
    }

    return res.status(200).json({
      success: true,
      data: request.toPublicRow(),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to look up the request');
  }
};

/**
 * GET /api/contact/prospectus
 *
 * The fulfilment queue. Oldest first, because a request that has waited a week
 * is the one that should be packed next.
 */
exports.listRequests = async (req, res) => {
  try {
    const query = {};

    if (req.query.status) {
      if (!ProspectusRequest.STATUSES.includes(req.query.status)) {
        return fail(res, 400, 'Invalid status filter');
      }
      query.status = req.query.status;
    }

    if (req.query.channel) {
      if (!ProspectusRequest.CHANNELS.includes(req.query.channel)) {
        return fail(res, 400, 'Invalid channel filter');
      }
      query.channel = req.query.channel;
    }

    if (req.query.grade) {
      query.gradeSought = clean(req.query.grade);
    }

    if (req.query.q) {
      const term = clean(req.query.q);
      const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      query.$or = [
        { reference: new RegExp(safe, 'i') },
        { applicantName: new RegExp(safe, 'i') },
        { email: new RegExp(safe, 'i') },
      ];
    }

    const requests = await ProspectusRequest.find(query)
      .sort({ createdAt: 1 })
      .limit(MAX_LIST);

    return res.status(200).json({
      success: true,
      count: requests.length,
      data: requests.map((request) => request.toRow()),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load prospectus requests');
  }
};

/**
 * GET /api/contact/prospectus/summary
 *
 * The question a print run is decided on: how many books, for which grade,
 * through which channel. Aggregated in the database rather than counted into a
 * field that would drift from the rows it summarises.
 */
exports.getSummary = async (req, res) => {
  try {
    const match = {};
    if (req.query.academicYear) {
      match.academicYear = clean(req.query.academicYear);
    }

    const [byStatus, byGrade, byChannel] = await Promise.all([
      ProspectusRequest.aggregate([
        { $match: match },
        { $group: { _id: '$status', requests: { $sum: 1 }, copies: { $sum: '$quantity' } } },
        { $sort: { _id: 1 } },
      ]),
      ProspectusRequest.aggregate([
        { $match: { ...match, status: { $nin: ['cancelled'] } } },
        { $group: { _id: '$gradeSought', requests: { $sum: 1 }, copies: { $sum: '$quantity' } } },
        { $sort: { copies: -1 } },
        { $limit: 40 },
      ]),
      ProspectusRequest.aggregate([
        { $match: match },
        { $group: { _id: '$channel', requests: { $sum: 1 }, copies: { $sum: '$quantity' } } },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const shape = (rows) =>
      rows.map((row) => ({
        key: row._id || 'unspecified',
        requests: row.requests,
        copies: row.copies,
      }));

    const outstanding = await ProspectusRequest.countDocuments({
      ...match,
      status: { $in: ['received', 'packed'] },
    });

    return res.status(200).json({
      success: true,
      data: {
        byStatus: shape(byStatus),
        byGrade: shape(byGrade),
        byChannel: shape(byChannel),
        outstanding,
        generatedAt: new Date(),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to summarise prospectus requests');
  }
};

/**
 * GET /api/contact/prospectus/:id
 */
exports.getRequest = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid request id');

    const request = await ProspectusRequest.findById(id)
      .populate('packedBy', 'name')
      .populate('dispatchedBy', 'name')
      .populate('history.by', 'name');

    if (!request) return fail(res, 404, 'Prospectus request not found');

    return res.status(200).json({
      success: true,
      data: {
        ...request.toRow(),
        history: request.history,
        packedBy: request.packedBy,
        dispatchedBy: request.dispatchedBy,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the prospectus request');
  }
};

/**
 * One shape for every step of the ladder. Each of the fulfilment routes is the
 * same three lines — load, move, save — so they share the loader and differ
 * only in the method they call.
 */
async function advance(req, res, apply, successMessage, failureMessage) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid request id');

    const request = await ProspectusRequest.findById(id);
    if (!request) return fail(res, 404, 'Prospectus request not found');

    apply(request);
    await request.save();

    return res.status(200).json({
      success: true,
      message: successMessage,
      data: request.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 409, message);
    return serverError(res, error, failureMessage);
  }
}

exports.packRequest = (req, res) =>
  advance(
    req,
    res,
    (request) => request.pack(req.user, clean(req.body.note)),
    'Marked as packed',
    'Failed to mark the request as packed'
  );

exports.dispatchRequest = (req, res) =>
  advance(
    req,
    res,
    (request) =>
      request.dispatch(req.user, clean(req.body.courier), clean(req.body.trackingRef)),
    'Marked as dispatched',
    'Failed to mark the request as dispatched'
  );

exports.deliverRequest = (req, res) =>
  advance(
    req,
    res,
    (request) => request.markDelivered(req.user, clean(req.body.note)),
    'Marked as delivered',
    'Failed to mark the request as delivered'
  );

exports.returnRequest = (req, res) =>
  advance(
    req,
    res,
    (request) => request.markReturned(req.user, req.body.reason),
    'Marked as returned',
    'Failed to mark the request as returned'
  );

exports.cancelRequest = (req, res) =>
  advance(
    req,
    res,
    (request) => request.cancel(req.user, req.body.reason),
    'Request cancelled',
    'Failed to cancel the request'
  );

/**
 * PATCH /api/contact/prospectus/:id/notes
 *
 * Notes are the one field staff may edit after the fact, and editing them is
 * still written to the history so the queue does not acquire silent changes.
 */
exports.updateNotes = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid request id');

    const request = await ProspectusRequest.findById(id);
    if (!request) return fail(res, 404, 'Prospectus request not found');

    request.notes = clean(req.body.notes).slice(0, 1000);
    request.log('note', req.user);

    await request.save();

    return res.status(200).json({
      success: true,
      message: 'Note saved',
      data: request.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to save the note');
  }
};

/**
 * POST /api/contact/prospectus/staff
 *
 * The walk-in and telephone path. Same model, different source, and staff may
 * set it — which is why it is a separate, authenticated handler rather than a
 * `source` field the public route would have to be trusted not to accept.
 */
exports.createStaffRequest = async (req, res) => {
  try {
    const source = clean(req.body.source, 'walk-in');
    if (!ProspectusRequest.SOURCES.includes(source)) {
      return fail(res, 400, 'Invalid source');
    }

    const channel = clean(req.body.channel, 'collect');
    const postal = ProspectusRequest.POSTAL_CHANNELS.includes(channel);
    const body = req.body.address || {};

    const request = new ProspectusRequest({
      requestKey: clean(req.body.requestKey) || `staff-${new mongoose.Types.ObjectId()}`,
      applicantName: clean(req.body.applicantName),
      email: clean(req.body.email).toLowerCase(),
      phone: clean(req.body.phone),
      relationship: clean(req.body.relationship, 'parent'),
      studentName: clean(req.body.studentName),
      gradeSought: clean(req.body.gradeSought),
      academicYear: clean(req.body.academicYear),
      intakeTerm: clean(req.body.intakeTerm),
      channel,
      quantity: Number(req.body.quantity) || 1,
      source,
      status: 'received',
      notes: clean(req.body.notes),
      address: postal
        ? {
            line1: clean(body.line1),
            line2: clean(body.line2),
            city: clean(body.city),
            state: clean(body.state),
            postcode: clean(body.postcode),
            country: clean(body.country, 'India'),
          }
        : {},
    });

    request.reference = await ProspectusCounter.next(request.academicYear);
    request.log('received', req.user, `via ${source}`);

    await request.save();

    return res.status(201).json({
      success: true,
      message: 'Request recorded',
      data: request.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record the request');
  }
};
