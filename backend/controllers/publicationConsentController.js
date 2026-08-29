// backend/controllers/publicationConsentController.js
const mongoose = require('mongoose');
const User = require('../models/User');
const PublicationConsent = require('../models/PublicationConsent');
const { PublicationUsage } = require('../models/PublicationConsent');

/**
 * Publication consent, and the usage register that makes withdrawal mean
 * something.
 *
 * Two handlers carry the weight.
 *
 * `registerUsage` checks every named child against `isPublishable` for that
 * channel and refuses the whole registration if any one of them fails, naming
 * which. Recording a publication that was not permitted is not a thing the
 * system should help with.
 *
 * `withdrawConsent` does not merely stop future publication — it finds every
 * usage on that channel naming that child, marks each `takedown-required` with a
 * due date, and reports how many. A withdrawal that leaves the existing
 * photographs up is a withdrawal in name only, and the queue it produces is the
 * actual deliverable.
 */

const handleError = (res, err, message = 'Server error') => {
  console.error('[publication-consent]', err);
  return res.status(500).json({ success: false, message, error: err.message });
};

const fail = (res, status, message, extra = {}) =>
  res.status(status).json({ success: false, message, ...extra });

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const isStaff = (user) => user && ['teacher', 'staff', 'admin'].includes(user.role);
const isOffice = (user) => user && ['staff', 'admin'].includes(user.role);

const asBadRequest = (err) =>
  err instanceof Error && !['MongoServerError', 'MongooseError', 'ValidationError'].includes(err.name);

const getPagination = (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
};

const publicConsent = (consent) => ({
  _id: consent._id,
  student: consent.student,
  studentName: consent.studentName,
  className: consent.className,
  academicYear: consent.academicYear,
  channel: consent.channel,
  scope: consent.scope,
  decision: consent.decision,
  status: consent.status,
  guardianName: consent.guardianName,
  guardianRelationship: consent.guardianRelationship,
  guardianContact: consent.guardianContact,
  evidenceReference: consent.evidenceReference,
  recordedByName: consent.recordedByName,
  recordedAt: consent.recordedAt,
  studentObjection: consent.studentObjection,
  effectiveFrom: consent.effectiveFrom,
  expiresAt: consent.expiresAt,
  withdrawnAt: consent.withdrawnAt,
  withdrawalReason: consent.withdrawalReason,
  supersededBy: consent.supersededBy,
  history: consent.history,
});

/**
 * The family's own view.
 *
 * The guardian's contact details and the office's audit trail are staff record;
 * what a family needs is the state of each channel and a button.
 */
const familyConsent = (consent) => ({
  _id: consent._id,
  studentName: consent.studentName,
  academicYear: consent.academicYear,
  channel: consent.channel,
  scope: consent.scope,
  decision: consent.decision,
  status: consent.status,
  guardianName: consent.guardianName,
  expiresAt: consent.expiresAt,
  withdrawnAt: consent.withdrawnAt,
  objected: Boolean(consent.studentObjection && consent.studentObjection.objected),
});

/**
 * May this child appear on this channel, at this scope?
 *
 * The answer for a student with no record at all is **no**, with the reason
 * "never asked" — because that is what the absence of a consent means, and
 * defaulting the other way is the failure the whole module exists to prevent.
 */
const decideFor = async (studentId, channel, scope, academicYear, when = new Date()) => {
  const filter = { student: studentId, channel };
  if (academicYear) filter.academicYear = academicYear;

  const consent = await PublicationConsent.findOne(filter).sort({ recordedAt: -1 });

  if (!consent) {
    return {
      allowed: false,
      reason: 'No consent has ever been recorded for this channel',
      consent: null,
    };
  }

  const verdict = consent.permits(scope, when);
  return { ...verdict, consent };
};

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

exports.getMeta = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        channels: PublicationConsent.CHANNELS,
        scopes: PublicationConsent.SCOPES,
        scopeCovers: PublicationConsent.SCOPE_COVERS,
        decisions: PublicationConsent.DECISIONS,
        statuses: PublicationConsent.CONSENT_STATUSES,
        relationships: PublicationConsent.RELATIONSHIPS,
        usageStatuses: PublicationUsage.USAGE_STATUSES,
        takedownDays: PublicationConsent.TAKEDOWN_DAYS,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load consent reference data');
  }
};

// ---------------------------------------------------------------------------
// The family's view
// ---------------------------------------------------------------------------

/**
 * GET /mine
 *
 * One row per channel, including the channels nobody has ever been asked about
 * — because "never asked" is a state a family is entitled to see, and it is
 * invisible if the list is built from the records that exist.
 */
exports.getMine = async (req, res) => {
  try {
    const consents = await PublicationConsent.find({ student: req.user._id }).sort({
      recordedAt: -1,
    });

    const latest = new Map();
    consents.forEach((consent) => {
      if (!latest.has(consent.channel)) latest.set(consent.channel, consent);
    });

    const rows = PublicationConsent.CHANNELS.map((channel) => {
      const consent = latest.get(channel);
      if (!consent) {
        return { channel, state: 'never-asked', consent: null, allowed: false };
      }

      const verdict = consent.permits(null);
      return {
        channel,
        state: verdict.allowed ? 'granted' : consent.status === 'withdrawn' ? 'withdrawn' : consent.decision === 'withheld' ? 'withheld' : 'not-in-force',
        reason: verdict.reason,
        allowed: verdict.allowed,
        consent: familyConsent(consent),
      };
    });

    const usages = await PublicationUsage.find({
      'students.student': req.user._id,
      status: { $ne: 'removed' },
    })
      .sort({ publishedAt: -1 })
      .limit(50);

    return res.status(200).json({
      success: true,
      data: {
        rows,
        // What is currently out there under these consents. A withdrawal
        // button next to a count of nothing is a different decision from one
        // next to a count of eleven.
        liveUsageCount: usages.filter((usage) => usage.status === 'live').length,
        pendingTakedownCount: usages.filter((usage) => usage.status === 'takedown-required').length,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load your consents');
  }
};

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

exports.check = async (req, res) => {
  try {
    const { studentId, channel, scope, academicYear } = req.query;

    if (!isValidId(studentId)) return fail(res, 400, 'Invalid student id.');
    if (!PublicationConsent.CHANNELS.includes(channel)) {
      return fail(res, 400, 'A valid channel is required.');
    }
    if (scope && !PublicationConsent.SCOPES.includes(scope)) {
      return fail(res, 400, 'Invalid scope.');
    }

    const verdict = await decideFor(studentId, channel, scope || null, academicYear || null);

    return res.status(200).json({
      success: true,
      data: {
        student: studentId,
        channel,
        scope: scope || null,
        allowed: verdict.allowed,
        reason: verdict.reason,
        consent: verdict.consent ? publicConsent(verdict.consent) : null,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not check that consent');
  }
};

/**
 * GET /coverage?className&academicYear
 *
 * How many children in a class have a live consent per channel, and — the part
 * that matters — the list of those who do not.
 */
exports.getCoverage = async (req, res) => {
  try {
    const { className, academicYear } = req.query;
    if (!className) return fail(res, 400, 'className is required.');

    const students = await User.find({ role: 'student' }).select('name').limit(500);

    const filter = { className, status: 'active', decision: 'granted' };
    if (academicYear) filter.academicYear = academicYear;

    const consents = await PublicationConsent.find(filter);

    const byChannel = {};
    PublicationConsent.CHANNELS.forEach((channel) => {
      byChannel[channel] = { channel, granted: 0, missing: [] };
    });

    const granted = new Set();
    consents.forEach((consent) => {
      if (!consent.permits(null).allowed) return;
      granted.add(`${consent.student}:${consent.channel}`);
    });

    students.forEach((student) => {
      PublicationConsent.CHANNELS.forEach((channel) => {
        if (granted.has(`${student._id}:${channel}`)) {
          byChannel[channel].granted += 1;
        } else {
          byChannel[channel].missing.push({ _id: student._id, name: student.name });
        }
      });
    });

    return res.status(200).json({
      success: true,
      data: {
        className,
        academicYear: academicYear || null,
        studentCount: students.length,
        // Sorted worst-first: the channel with the least coverage is the one
        // somebody is about to publish on without checking.
        channels: Object.values(byChannel).sort((a, b) => a.granted - b.granted),
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not build the coverage report');
  }
};

// ---------------------------------------------------------------------------
// Recording consent
// ---------------------------------------------------------------------------

exports.recordConsent = async (req, res) => {
  try {
    const {
      studentId,
      className = '',
      academicYear,
      channel,
      scope = 'image-and-name',
      decision,
      guardianName,
      guardianRelationship,
      guardianContact = '',
      evidenceReference,
    } = req.body;

    if (!isValidId(studentId)) return fail(res, 400, 'Invalid student id.');
    if (!PublicationConsent.CHANNELS.includes(channel)) {
      return fail(res, 400, 'A valid channel is required.');
    }
    if (!PublicationConsent.DECISIONS.includes(decision)) {
      return fail(res, 400, 'decision must be granted or withheld.');
    }

    const student = await User.findById(studentId).select('name role');
    if (!student) return fail(res, 404, 'That student does not exist.');
    if (student.role !== 'student') return fail(res, 400, 'Consent is recorded about students.');

    /**
     * Re-recording supersedes rather than edits.
     *
     * The history of what was permitted when is the only thing that answers
     * "what were you relying on in March", so the previous record stays with a
     * pointer to its replacement.
     */
    const existing = await PublicationConsent.findOne({
      student: studentId,
      channel,
      academicYear,
      isHolding: true,
    });

    const consent = new PublicationConsent({
      student: student._id,
      studentName: student.name,
      className,
      academicYear,
      channel,
      scope,
      decision,
      guardianName,
      guardianRelationship,
      guardianContact,
      evidenceReference,
      recordedBy: req.user._id,
      recordedByName: req.user.name,
    });

    if (existing) {
      existing.supersede(req.user, consent);
      await existing.save();
    }

    consent.log('recorded', req.user, `${decision} for ${channel}`);
    await consent.save();

    return res.status(201).json({
      success: true,
      message:
        decision === 'granted'
          ? `${student.name} may appear on ${channel} until ${consent.expiresAt
              .toISOString()
              .slice(0, 10)}.`
          : `Consent for ${channel} is recorded as withheld for ${student.name}.`,
      data: publicConsent(consent),
      superseded: existing ? existing._id : null,
    });
  } catch (err) {
    if (err.code === 11000) {
      return fail(res, 409, 'A live consent already exists for that student, channel and year.');
    }
    if (err.name === 'ValidationError') {
      return fail(res, 400, Object.values(err.errors)[0].message);
    }
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, 'Could not record the consent');
  }
};

exports.listConsents = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = {};

    if (req.query.status) filter.status = req.query.status;
    if (req.query.channel) filter.channel = req.query.channel;
    if (req.query.className) filter.className = req.query.className;
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;
    if (isValidId(req.query.studentId)) filter.student = req.query.studentId;

    const [consents, total] = await Promise.all([
      PublicationConsent.find(filter).sort({ recordedAt: -1 }).skip(skip).limit(limit),
      PublicationConsent.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      count: consents.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      data: consents.map(publicConsent),
    });
  } catch (err) {
    return handleError(res, err, 'Could not list consents');
  }
};

exports.getConsent = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid consent id.');

    const consent = await PublicationConsent.findById(id);
    if (!consent) return fail(res, 404, 'Consent not found.');

    const owns = String(consent.student) === String(req.user._id);
    if (!isOffice(req.user) && !owns) {
      return fail(res, 403, 'That consent is not about you.');
    }

    return res.status(200).json({
      success: true,
      data: isOffice(req.user) ? publicConsent(consent) : familyConsent(consent),
    });
  } catch (err) {
    return handleError(res, err, 'Could not load that consent');
  }
};

exports.noteObjection = async (req, res) => {
  try {
    const { id } = req.params;
    const { objected, note = '' } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid consent id.');
    if (typeof objected !== 'boolean') return fail(res, 400, 'objected must be true or false.');

    const consent = await PublicationConsent.findById(id);
    if (!consent) return fail(res, 404, 'Consent not found.');

    consent.noteObjection(req.user, objected, note);
    await consent.save();

    return res.status(200).json({
      success: true,
      message: objected
        ? `${consent.studentName}'s objection is recorded. Nothing may be published on ${consent.channel} while it stands, whatever the guardian agreed.`
        : 'The objection has been lifted.',
      data: publicConsent(consent),
    });
  } catch (err) {
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, 'Could not record the objection');
  }
};

/**
 * PATCH /:id/withdraw
 *
 * Three things in one act, and the third is the one that matters.
 */
exports.withdrawConsent = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid consent id.');

    const consent = await PublicationConsent.findById(id);
    if (!consent) return fail(res, 404, 'Consent not found.');

    const owns = String(consent.student) === String(req.user._id);
    if (!isOffice(req.user) && !owns) {
      return fail(res, 403, 'That consent is not yours to withdraw.');
    }

    consent.withdraw(req.user, req.body.reason);
    await consent.save();

    // Everything already out there on this channel naming this child.
    const affected = await PublicationUsage.find({
      channel: consent.channel,
      'students.student': consent.student,
      status: 'live',
    });

    for (const usage of affected) {
      usage.requireTakedown(
        req.user,
        consent.student,
        `Consent withdrawn for ${consent.studentName}`
      );
      await usage.save();
    }

    return res.status(200).json({
      success: true,
      message: affected.length
        ? `Consent withdrawn. ${affected.length} published item(s) now need taking down, due within ${PublicationConsent.TAKEDOWN_DAYS} days.`
        : 'Consent withdrawn. Nothing published under it is still live.',
      data: publicConsent(consent),
      takedownsRaised: affected.length,
      takedownDueDays: PublicationConsent.TAKEDOWN_DAYS,
    });
  } catch (err) {
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, 'Could not withdraw the consent');
  }
};

// ---------------------------------------------------------------------------
// The usage register
// ---------------------------------------------------------------------------

/**
 * POST /usages
 *
 * Records something that has been published, and refuses to record it unless
 * every child named in it is actually permitted to be there.
 *
 * The whole registration is refused rather than the offending children dropped,
 * because a photograph is not divisible: if one child in it has no consent, the
 * photograph is the problem.
 */
exports.registerUsage = async (req, res) => {
  try {
    const {
      assetReference,
      assetLabel = '',
      channel,
      scope = 'image',
      studentIds = [],
      academicYear,
    } = req.body;

    if (!assetReference) return fail(res, 400, 'assetReference is required.');
    if (!PublicationConsent.CHANNELS.includes(channel)) {
      return fail(res, 400, 'A valid channel is required.');
    }
    if (!Array.isArray(studentIds) || !studentIds.length) {
      return fail(res, 400, 'At least one student must be named.');
    }
    if (studentIds.some((id) => !isValidId(id))) {
      return fail(res, 400, 'One of the student ids is invalid.');
    }

    const students = await User.find({ _id: { $in: studentIds }, role: 'student' }).select('name');
    if (students.length !== studentIds.length) {
      return fail(res, 404, 'One of those students does not exist.');
    }

    const rows = [];
    const refused = [];

    for (const student of students) {
      const verdict = await decideFor(student._id, channel, scope, academicYear || null);

      if (!verdict.allowed) {
        refused.push({ student: student._id, name: student.name, reason: verdict.reason });
        continue;
      }

      rows.push({
        student: student._id,
        studentName: student.name,
        consent: verdict.consent._id,
      });
    }

    if (refused.length) {
      return fail(
        res,
        409,
        `Not permitted on ${channel}: ${refused.map((row) => `${row.name} (${row.reason})`).join('; ')}.`,
        { refused }
      );
    }

    const usage = new PublicationUsage({
      assetReference,
      assetLabel,
      channel,
      scope,
      students: rows,
      publishedBy: req.user._id,
      publishedByName: req.user.name,
    });

    usage.log('published', req.user, `${rows.length} student(s) on ${channel}`);
    await usage.save();

    return res.status(201).json({
      success: true,
      message: `Recorded on ${channel}, against ${rows.length} live consent(s).`,
      data: usage,
    });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return fail(res, 400, Object.values(err.errors)[0].message);
    }
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, 'Could not record that publication');
  }
};

exports.listUsages = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = {};

    if (req.query.status) filter.status = req.query.status;
    if (req.query.channel) filter.channel = req.query.channel;
    if (isValidId(req.query.studentId)) filter['students.student'] = req.query.studentId;

    const [usages, total] = await Promise.all([
      PublicationUsage.find(filter).sort({ publishedAt: -1 }).skip(skip).limit(limit),
      PublicationUsage.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      count: usages.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      data: usages,
    });
  } catch (err) {
    return handleError(res, err, 'Could not list publications');
  }
};

/**
 * GET /takedowns
 *
 * The screen. Everything else on this router is context for it.
 */
exports.getTakedowns = async (req, res) => {
  try {
    const usages = await PublicationUsage.find({ status: 'takedown-required' })
      .sort({ takedownDueAt: 1 })
      .limit(200);

    const now = Date.now();

    return res.status(200).json({
      success: true,
      count: usages.length,
      data: {
        // Sorted by how far past the deadline each one is, because that is the
        // order somebody should work through them in.
        rows: usages.map((usage) => usage.toObject()),
        overdue: usages.filter((usage) => usage.takedownDueAt && usage.takedownDueAt.getTime() < now)
          .length,
        takedownDays: PublicationConsent.TAKEDOWN_DAYS,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not build the takedown queue');
  }
};

exports.markRemoved = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid publication id.');

    const usage = await PublicationUsage.findById(id);
    if (!usage) return fail(res, 404, 'Publication not found.');

    usage.markRemoved(req.user, req.body.note);
    await usage.save();

    const outstanding = await PublicationUsage.countDocuments({ status: 'takedown-required' });

    return res.status(200).json({
      success: true,
      message: outstanding
        ? `Taken down. ${outstanding} item(s) still to go.`
        : 'Taken down. The queue is empty.',
      data: usage,
      outstanding,
    });
  } catch (err) {
    if (asBadRequest(err)) return fail(res, 400, err.message);
    return handleError(res, err, 'Could not record the takedown');
  }
};

exports.decideFor = decideFor;
exports.isStaff = isStaff;
