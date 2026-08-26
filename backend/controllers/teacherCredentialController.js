const mongoose = require('mongoose');
const path = require('path');
const TeacherCredential = require('../models/TeacherCredential');
const User = require('../models/User');

/**
 * The teaching credential register.
 *
 * Two rules run through everything here.
 *
 * **Compliance is never read from the database.** Every response that mentions
 * whether a certificate is in force calls `complianceAt(now)` and derives it.
 * There is no stored flag to go stale, and no scheduled job whose absence would
 * make one lie.
 *
 * **A renewal supersedes; it does not overwrite.** `renewCredential` writes a
 * new document and marks the old one superseded with its dates untouched, so
 * `pointInTimeCompliance` can still answer "were you covered in March?" — the
 * question an inspection actually asks, and the one a mutable status field on
 * the user record could never answer.
 *
 * The register also holds rejection reasons, so a teacher may read their own
 * credentials and nobody else's; the department-wide view is admin only.
 */

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

function ok(res, data, extra = {}) {
  return res.status(200).json({ success: true, data, ...extra });
}

function created(res, data) {
  return res.status(201).json({ success: true, data });
}

function serverError(res, error, message) {
  console.error(`${message}:`, error);
  return res.status(500).json({ success: false, message, error: error.message });
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
  if (error.code === 11000) {
    return 'A current credential with that reference already exists for this member of staff';
  }
  return null;
}

function isAdmin(user) {
  return user && user.role === 'admin';
}

function parseDate(value, fieldLabel, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    return required ? { error: `${fieldLabel} is required` } : { value: null };
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { error: `${fieldLabel} is not a valid date` };
  return { value: date };
}

function parseList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * A credential as the API returns it, with compliance derived rather than read.
 *
 * The rejection reason and verification note are withheld from anyone who is
 * neither an admin nor the person the credential belongs to.
 */
function credentialRow(credential, viewer, now = new Date()) {
  const mine = String(credential.teacher) === String(viewer._id);
  const privileged = isAdmin(viewer) || mine;

  const row = {
    _id: credential._id,
    teacher: credential.teacher,
    teacherName: credential.teacherName,
    department: credential.department,
    kind: credential.kind,
    title: credential.title,
    issuer: credential.issuer,
    reference: credential.reference,
    issuedOn: credential.issuedOn,
    expiresOn: credential.expiresOn,
    subjects: credential.subjects,
    grades: credential.grades,
    status: credential.status,
    verifiedAt: credential.verifiedAt,
    supersedes: credential.supersedes,
    supersededBy: credential.supersededBy,
    supersededAt: credential.supersededAt,
    isCurrent: credential.isCurrent,
    warningDays: credential.warningDays(),
    createdAt: credential.createdAt,

    // Derived here, every time. Never stored.
    compliance: credential.complianceAt(now),
  };

  if (privileged) {
    row.documentUrl = credential.documentUrl;
    row.rejectionReason = credential.rejectionReason;
    row.verificationNote = credential.verificationNote;
    row.history = credential.history;
  }

  return row;
}

/* ------------------------------------------------------------------------- *
 * Handlers
 * ------------------------------------------------------------------------- */

exports.getCredentialMeta = async (req, res) => {
  try {
    return ok(res, {
      kinds: TeacherCredential.KINDS,
      statuses: TeacherCredential.STATUSES,
      compliance: TeacherCredential.COMPLIANCE,
      defaultWarningDays: TeacherCredential.DEFAULT_WARNING_DAYS,
    });
  } catch (error) {
    return serverError(res, error, 'Could not load the credential options');
  }
};

/**
 * Submit a certificate.
 *
 * A teacher submits their own; an admin may submit on behalf of somebody else,
 * because certificates arrive in the school office on paper at least as often
 * as they arrive from the person who holds them.
 */
exports.createCredential = async (req, res) => {
  try {
    const {
      teacherId,
      kind,
      title,
      issuer,
      reference,
      issuedOn,
      expiresOn,
      subjects,
      grades,
      expiryWarningDays,
      supersedes,
    } = req.body;

    const owner = teacherId && isAdmin(req.user) ? teacherId : req.user._id;

    if (!isValidId(owner)) return fail(res, 400, 'That member of staff id is not valid');

    if (!TeacherCredential.KINDS.includes(kind)) {
      return fail(res, 400, 'Invalid credential kind');
    }

    const issued = parseDate(issuedOn, 'Issue date', { required: true });
    if (issued.error) return fail(res, 400, issued.error);

    const expires = parseDate(expiresOn, 'Expiry date');
    if (expires.error) return fail(res, 400, expires.error);

    const teacher = await User.findById(owner).select('name role');
    if (!teacher) return fail(res, 404, 'That member of staff does not exist');

    const credential = new TeacherCredential({
      teacher: owner,
      teacherName: teacher.name,
      department: req.body.department || '',
      kind,
      title,
      issuer,
      reference,
      issuedOn: issued.value,
      expiresOn: expires.value,
      subjects: parseList(subjects),
      grades: parseList(grades),
      expiryWarningDays:
        expiryWarningDays === undefined || expiryWarningDays === ''
          ? null
          : Number(expiryWarningDays),
      supersedes: supersedes && isValidId(supersedes) ? supersedes : null,
      // The multer pipeline already configured on this route file writes the
      // scanned certificate to /uploads, so no new upload plumbing is added.
      documentUrl: req.file ? `/uploads/${path.basename(req.file.path)}` : '',
    });

    credential.recordHistory({
      action: 'submitted',
      to: 'submitted',
      by: req.user._id,
      byName: req.user.name,
    });

    await credential.save();

    return created(res, credentialRow(credential, req.user));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

/**
 * Renew a certificate.
 *
 * The new document is written first and the old one is superseded second, so a
 * failure between the two leaves the school with two current credentials rather
 * than none. Two is a duplicate somebody notices; none is cover that silently
 * disappeared.
 */
exports.renewCredential = async (req, res) => {
  try {
    const { id } = req.params;
    const { reference, issuedOn, expiresOn, issuer, title, subjects, grades } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'That credential id is not valid');

    const previous = await TeacherCredential.findById(id);
    if (!previous) return fail(res, 404, 'That credential does not exist');

    const mine = String(previous.teacher) === String(req.user._id);
    if (!isAdmin(req.user) && !mine) {
      return fail(res, 403, 'You can only renew your own credentials');
    }

    if (!previous.isCurrent) {
      return fail(res, 400, `A ${previous.status} credential cannot be renewed`);
    }

    const issued = parseDate(issuedOn, 'Issue date', { required: true });
    if (issued.error) return fail(res, 400, issued.error);

    const expires = parseDate(expiresOn, 'Expiry date');
    if (expires.error) return fail(res, 400, expires.error);

    const replacement = new TeacherCredential({
      teacher: previous.teacher,
      teacherName: previous.teacherName,
      department: previous.department,
      kind: previous.kind,
      title: title || previous.title,
      issuer: issuer || previous.issuer,
      reference: reference || previous.reference,
      issuedOn: issued.value,
      expiresOn: expires.value,
      subjects: subjects === undefined ? previous.subjects : parseList(subjects),
      grades: grades === undefined ? previous.grades : parseList(grades),
      expiryWarningDays: previous.expiryWarningDays,
      supersedes: previous._id,
      documentUrl: req.file ? `/uploads/${path.basename(req.file.path)}` : '',
    });

    replacement.recordHistory({
      action: 'submitted',
      to: 'submitted',
      note: `renewal of ${previous.reference}`,
      by: req.user._id,
      byName: req.user.name,
    });

    await replacement.save();

    // Only now is the old one stood down — and its dates are left exactly as
    // they were, which is what keeps the point-in-time question answerable.
    previous.markSuperseded(replacement, req.user);
    await previous.save();

    return created(res, credentialRow(replacement, req.user));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

exports.verifyCredential = async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'That credential id is not valid');

    const credential = await TeacherCredential.findById(id);
    if (!credential) return fail(res, 404, 'That credential does not exist');

    credential.verify(req.user, note);
    await credential.save();

    return ok(res, credentialRow(credential, req.user));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

exports.rejectCredential = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'That credential id is not valid');

    const credential = await TeacherCredential.findById(id);
    if (!credential) return fail(res, 404, 'That credential does not exist');

    credential.reject(req.user, reason);
    await credential.save();

    return ok(res, credentialRow(credential, req.user));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

exports.withdrawCredential = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'That credential id is not valid');

    const credential = await TeacherCredential.findById(id);
    if (!credential) return fail(res, 404, 'That credential does not exist');

    const mine = String(credential.teacher) === String(req.user._id);
    if (!isAdmin(req.user) && !mine) {
      return fail(res, 403, 'You can only withdraw your own credentials');
    }

    credential.withdraw(req.user);
    await credential.save();

    return ok(res, credentialRow(credential, req.user));
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return fail(res, 400, error.message);
  }
};

/**
 * A teacher's own record, in full.
 *
 * Grouped by kind, because "do I hold a current first-aid certificate" is a
 * question about a slot rather than about a list, and the superseded entries
 * belong beside the current one rather than scattered through a flat feed.
 */
exports.getMyCredentials = async (req, res) => {
  try {
    const now = new Date();

    const credentials = await TeacherCredential.find({ teacher: req.user._id }).sort({
      kind: 1,
      issuedOn: -1,
    });

    const rows = credentials.map((credential) => credentialRow(credential, req.user, now));

    const byKind = {};
    rows.forEach((row) => {
      if (!byKind[row.kind]) byKind[row.kind] = [];
      byKind[row.kind].push(row);
    });

    return ok(res, {
      credentials: rows,
      byKind,
      gaps: TeacherCredential.KINDS.filter(
        (kind) => !rows.some((row) => row.kind === kind && row.compliance.inForce)
      ),
    });
  } catch (error) {
    return serverError(res, error, 'Could not load your credentials');
  }
};

/**
 * The register, for an admin.
 *
 * Filterable by kind, by staff member and — the useful one — by derived
 * compliance state. The state is not a stored field, so the filter is applied
 * after the query rather than inside it; the register is a few hundred rows in
 * a school of this size, and a stored field that could be indexed is exactly
 * the thing this model refuses to keep.
 */
exports.listCredentials = async (req, res) => {
  try {
    const { kind, teacherId, status, compliance } = req.query;

    const filter = {};
    if (kind && TeacherCredential.KINDS.includes(kind)) filter.kind = kind;
    if (status && TeacherCredential.STATUSES.includes(status)) filter.status = status;
    if (teacherId && isValidId(teacherId)) filter.teacher = teacherId;

    const now = new Date();

    const credentials = await TeacherCredential.find(filter)
      .sort({ expiresOn: 1, createdAt: -1 })
      .limit(500);

    let rows = credentials.map((credential) => credentialRow(credential, req.user, now));

    if (compliance) {
      rows = rows.filter((row) => row.compliance.state === compliance);
    }

    return ok(res, rows, { total: rows.length });
  } catch (error) {
    return serverError(res, error, 'Could not load the credential register');
  }
};

/**
 * What lapses next.
 *
 * The report that stops the inspection finding, sorted by how soon rather than
 * by who — because the ordering is the entire value of it.
 */
exports.getExpiring = async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 60, 1), 365);
    const now = new Date();

    const credentials = await TeacherCredential.expiringWithin(days, now);

    const rows = credentials.map((credential) => credentialRow(credential, req.user, now));

    return ok(res, {
      horizonDays: days,
      expired: rows.filter((row) => row.compliance.state === 'expired'),
      expiring: rows.filter((row) => row.compliance.state === 'expiring'),
      // A verified certificate inside the horizon but outside its own warning
      // window is not yet a warning, and listing it as one trains people to
      // ignore the list.
      upcoming: rows.filter((row) => row.compliance.state === 'valid'),
    });
  } catch (error) {
    return serverError(res, error, 'Could not build the expiry report');
  }
};

/**
 * Who may teach this subject, and are they safeguarded?
 *
 * The query a timetable is actually built from. Nothing is blocked on the
 * answer yet — making it a hard gate before the register is populated would
 * lock the school out of its own substitution board — but the data is here and
 * queryable in one call.
 */
exports.getEndorsedStaff = async (req, res) => {
  try {
    const { subject, require: requireKinds } = req.query;

    if (!subject) return fail(res, 400, 'A subject is required');

    const kinds = parseList(requireKinds).filter((kind) =>
      TeacherCredential.KINDS.includes(kind)
    );

    const rows = await TeacherCredential.staffEndorsedFor(subject, { requireKinds: kinds });

    return ok(res, {
      subject,
      required: kinds,
      eligible: rows.filter((row) => row.missing.length === 0),
      blocked: rows.filter((row) => row.missing.length > 0),
    });
  } catch (error) {
    return serverError(res, error, 'Could not work out who is endorsed for that subject');
  }
};

/**
 * Were they covered on that date?
 *
 * Admin only: it reaches across staff members and is the question asked when
 * something has already gone wrong.
 */
exports.getPointInTime = async (req, res) => {
  try {
    const { teacherId, kind, on } = req.query;

    if (!isValidId(teacherId)) return fail(res, 400, 'That member of staff id is not valid');
    if (!TeacherCredential.KINDS.includes(kind)) return fail(res, 400, 'Invalid credential kind');

    const date = parseDate(on, 'Date', { required: true });
    if (date.error) return fail(res, 400, date.error);

    const answer = await TeacherCredential.pointInTimeCompliance(teacherId, kind, date.value);

    return ok(res, answer);
  } catch (error) {
    return serverError(res, error, 'Could not answer that point-in-time question');
  }
};
