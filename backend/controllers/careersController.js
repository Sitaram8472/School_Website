const mongoose = require('mongoose');
const CollegeApplication = require('../models/CollegeApplication');

/**
 * Career guidance and college applications.
 *
 * The handlers worth reading:
 *
 * `getAtRisk` is the product. Every application in the cohort closing inside a
 * fortnight with requirements or references outstanding, soonest first. It is
 * the counsellor's job, and the school currently cannot produce it in any form.
 *
 * `submitReference` is where the confidentiality lives — the letter goes in
 * here and comes back out of no endpoint the student can reach.
 *
 * `acceptOffer` releases any previous firm acceptance and takes the new one in
 * one operation, then leans on a partial unique index to refuse the case where
 * two requests arrive together.
 */

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

/**
 * Mongoose validation errors carry every failed path. Surfacing only the first
 * is how you get somebody fixing a form one field per submission.
 */
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

function isAdmin(user) {
  return user && user.role === 'admin';
}

/**
 * Counsellors are teachers and admins here. The repository has no counsellor
 * role, so widening it later is a change to this function rather than to every
 * route.
 */
function isCounsellor(user) {
  return user && ['teacher', 'admin'].includes(user.role);
}

/** The cohort year a date falls in, on a July start. */
function cohortYearFor(dateKey = CollegeApplication.todayKey()) {
  const [year, month] = dateKey.split('-').map(Number);
  const startYear = month >= 7 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** The fields a student may set. Status transitions have their own handlers. */
function sanitiseApplication(body) {
  return {
    cohortYear: body.cohortYear,
    institution: body.institution,
    country: body.country,
    programme: body.programme,
    level: body.level,
    applicationType: body.applicationType,
    priority: body.priority,
    deadline: body.deadline,
    portalRef: body.portalRef,
    requirements: Array.isArray(body.requirements)
      ? body.requirements.map((requirement) => ({
          label: requirement.label,
          kind: requirement.kind,
          isRequired: requirement.isRequired !== false,
          status: requirement.status,
          note: requirement.note,
        }))
      : undefined,
  };
}

function stripUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));
}

/**
 * Load an application and check the caller may act on it. A student reaches
 * their own; a counsellor reaches the cohort.
 */
async function loadApplicationFor(id, user, { ownerOnly = false } = {}) {
  if (!isValidId(id)) return { status: 400, message: 'Invalid application id' };

  const application = await CollegeApplication.findById(id);
  if (!application) return { status: 404, message: 'Application not found' };

  const owns = application.isOwnedBy(user);
  if (ownerOnly && !owns) {
    return { status: 403, message: 'That application is not yours' };
  }
  if (!owns && !isCounsellor(user)) {
    return { status: 403, message: 'That application is not yours' };
  }

  return { application, owns };
}

/** The view a caller is entitled to. Confidentiality decided in one place. */
function viewFor(application, user) {
  return application.isOwnedBy(user) && !isCounsellor(user)
    ? application.toStudentView()
    : application.toStaffView();
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/**
 * GET /api/careers/meta
 */
exports.getMeta = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        levels: CollegeApplication.APPLICATION_LEVELS,
        applicationTypes: CollegeApplication.APPLICATION_TYPES,
        statuses: CollegeApplication.APPLICATION_STATUSES,
        submittedStatuses: CollegeApplication.SUBMITTED_STATUSES,
        priorities: CollegeApplication.PRIORITIES,
        requirementKinds: CollegeApplication.REQUIREMENT_KINDS,
        requirementStatuses: CollegeApplication.REQUIREMENT_STATUSES,
        refereeRelationships: CollegeApplication.REFEREE_RELATIONSHIPS,
        referenceStatuses: CollegeApplication.REFERENCE_STATUSES,
        recommendationLevels: CollegeApplication.RECOMMENDATION_LEVELS,
        atRiskDays: CollegeApplication.AT_RISK_DAYS,
        maxReferences: CollegeApplication.MAX_REFERENCES_PER_APPLICATION,
        currentCohortYear: cohortYearFor(),
        today: CollegeApplication.todayKey(),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load careers reference data');
  }
};

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

/**
 * POST /api/careers/applications
 */
exports.createApplication = async (req, res) => {
  try {
    let student = req.user._id;
    if (req.body.student && String(req.body.student) !== String(req.user._id)) {
      if (!isCounsellor(req.user)) {
        return fail(res, 403, 'Only a counsellor can raise an application for a student');
      }
      if (!isValidId(req.body.student)) return fail(res, 400, 'Invalid student id');
      student = req.body.student;
    }

    const fields = stripUndefined(sanitiseApplication(req.body));

    const application = new CollegeApplication({
      ...fields,
      cohortYear: fields.cohortYear || cohortYearFor(fields.deadline),
      student,
      studentName:
        String(student) === String(req.user._id) ? req.user.name : req.body.studentName,
      status: 'researching',
    });

    application.recordHistory('created', req.user._id);
    await application.save();

    return res.status(201).json({
      success: true,
      message: 'Application added',
      data: viewFor(application, req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to add that application');
  }
};

/**
 * GET /api/careers/applications/mine
 */
exports.getMyApplications = async (req, res) => {
  try {
    const filter = { student: req.user._id };
    if (req.query.cohortYear) filter.cohortYear = req.query.cohortYear;

    const applications = await CollegeApplication.find(filter).sort({ deadline: 1 });

    const rows = applications.map((application) => application.toStudentView());

    // Overdue first, then soonest. The order is the advice.
    const order = {
      overdue: 0,
      'due-today': 1,
      'due-soon': 2,
      upcoming: 3,
      met: 4,
      closed: 5,
      unknown: 6,
    };
    rows.sort(
      (a, b) =>
        (order[a.deadlineState.state] ?? 9) - (order[b.deadlineState.state] ?? 9) ||
        (a.deadline < b.deadline ? -1 : 1)
    );

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    return serverError(res, error, 'Failed to load your applications');
  }
};

/**
 * GET /api/careers/applications/at-risk
 *
 * The whole reason the module exists. One indexed query over the cohort,
 * filtered by a derivation rather than by a stored flag that would be stale.
 */
exports.getAtRisk = async (req, res) => {
  try {
    const today = CollegeApplication.todayKey();
    const cohortYear = req.query.cohortYear || cohortYearFor();

    const horizon = new Date(
      Date.parse(`${today}T00:00:00`) + CollegeApplication.AT_RISK_DAYS * 86400000
    );
    const horizonKey = CollegeApplication.todayKey(horizon);

    const applications = await CollegeApplication.find({
      cohortYear,
      status: { $nin: [...CollegeApplication.SUBMITTED_STATUSES, 'withdrawn'] },
      deadline: { $lte: horizonKey },
    })
      .populate('student', 'name email')
      .sort({ deadline: 1 });

    const rows = applications
      .filter((application) => application.isAtRisk(today))
      .map((application) => ({
        ...application.toStaffView(today),
        student: application.student,
      }));

    // Students with nothing in flight at all are the other half of the job, and
    // they are invisible in a list of applications by definition.
    const withApplications = await CollegeApplication.find({ cohortYear }).distinct(
      'student'
    );

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: {
        cohortYear,
        today,
        horizon: horizonKey,
        applications: rows,
        studentsWithApplications: withApplications.length,
        overdueCount: rows.filter((r) => r.deadlineState.state === 'overdue').length,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build the at-risk list');
  }
};

/**
 * GET /api/careers/applications
 */
exports.listApplications = async (req, res) => {
  try {
    const filter = {};
    if (req.query.cohortYear) filter.cohortYear = req.query.cohortYear;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.student && isValidId(req.query.student)) {
      filter.student = req.query.student;
    }

    const applications = await CollegeApplication.find(filter)
      .populate('student', 'name email')
      .sort({ deadline: 1 })
      .limit(Math.min(Number(req.query.limit) || 200, 500));

    return res.status(200).json({
      success: true,
      count: applications.length,
      data: applications.map((application) => ({
        ...application.toStaffView(),
        student: application.student,
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load applications');
  }
};

/**
 * GET /api/careers/applications/:id
 */
exports.getApplication = async (req, res) => {
  try {
    const result = await loadApplicationFor(req.params.id, req.user);
    if (result.status) return fail(res, result.status, result.message);

    await result.application.populate('student', 'name email');

    return res.status(200).json({
      success: true,
      data: {
        ...viewFor(result.application, req.user),
        student: result.application.student,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load that application');
  }
};

/**
 * PATCH /api/careers/applications/:id
 */
exports.updateApplication = async (req, res) => {
  try {
    const result = await loadApplicationFor(req.params.id, req.user);
    if (result.status) return fail(res, result.status, result.message);

    const { application } = result;
    if (CollegeApplication.SUBMITTED_STATUSES.includes(application.status)) {
      return fail(res, 409, 'This application has already gone and cannot be edited');
    }

    const fields = stripUndefined(sanitiseApplication(req.body));
    delete fields.requirements;
    Object.assign(application, fields);

    if (Array.isArray(req.body.requirements)) {
      application.requirements = sanitiseApplication(req.body).requirements;
    }

    application.recordHistory('edited', req.user._id);
    await application.save();

    return res.status(200).json({
      success: true,
      message: 'Updated',
      data: viewFor(application, req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update that application');
  }
};

/**
 * PATCH /api/careers/applications/:id/requirements/:index
 */
exports.updateRequirement = async (req, res) => {
  try {
    const result = await loadApplicationFor(req.params.id, req.user);
    if (result.status) return fail(res, result.status, result.message);

    const { application } = result;
    const index = Number(req.params.index);
    const requirement = application.requirements[index];
    if (!requirement) return fail(res, 404, 'That requirement is not on this application');

    if (req.body.status) requirement.status = req.body.status;
    if (req.body.note !== undefined) requirement.note = req.body.note;
    if (requirement.status === 'done' && !requirement.completedOn) {
      requirement.completedOn = CollegeApplication.todayKey();
    }

    application.recordHistory('requirement-updated', req.user._id, requirement.label);
    await application.save();

    return res.status(200).json({
      success: true,
      message: `${requirement.label} marked ${requirement.status}`,
      data: viewFor(application, req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update that requirement');
  }
};

/**
 * PATCH /api/careers/applications/:id/submit
 *
 * Refused while anything required is outstanding, and the refusal names the
 * item. A student who is told only that they are "not ready" goes looking.
 */
exports.submitApplication = async (req, res) => {
  try {
    const result = await loadApplicationFor(req.params.id, req.user);
    if (result.status) return fail(res, result.status, result.message);

    const { application } = result;
    const problem = application.submittabilityError();
    if (problem) return fail(res, 409, problem);

    application.status = 'submitted';
    application.submittedOn = req.body.submittedOn || CollegeApplication.todayKey();
    if (req.body.portalRef) application.portalRef = req.body.portalRef;

    application.recordHistory('submitted', req.user._id, application.portalRef);
    await application.save();

    return res.status(200).json({
      success: true,
      message: `Submitted to ${application.institution}`,
      data: viewFor(application, req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to mark that application submitted');
  }
};

/**
 * PATCH /api/careers/applications/:id/status
 */
exports.updateStatus = async (req, res) => {
  try {
    const result = await loadApplicationFor(req.params.id, req.user);
    if (result.status) return fail(res, result.status, result.message);

    const { application } = result;
    const { status } = req.body;
    if (!CollegeApplication.APPLICATION_STATUSES.includes(status)) {
      return fail(res, 400, 'Invalid status');
    }
    if (status === 'accepted') {
      return fail(res, 400, 'Use the accept endpoint — it releases any other acceptance');
    }
    if (application.offer.isFirmAcceptance && status !== 'accepted') {
      return fail(
        res,
        409,
        'This is your firm acceptance. Accept somewhere else to release it.'
      );
    }

    application.status = status;
    application.recordHistory('status-changed', req.user._id, status);
    await application.save();

    return res.status(200).json({
      success: true,
      message: `Marked ${status}`,
      data: viewFor(application, req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to update that status');
  }
};

/**
 * POST /api/careers/applications/:id/offer
 */
exports.recordOffer = async (req, res) => {
  try {
    const result = await loadApplicationFor(req.params.id, req.user);
    if (result.status) return fail(res, result.status, result.message);

    const { application } = result;

    application.offer.receivedOn = req.body.receivedOn || CollegeApplication.todayKey();
    application.offer.respondBy = req.body.respondBy || null;
    application.offer.conditions = req.body.conditions || null;
    application.offer.scholarshipAmount =
      req.body.scholarshipAmount === undefined ? null : Number(req.body.scholarshipAmount);

    application.status = req.body.conditions ? 'conditional-offer' : 'offer';
    application.recordHistory('offer-recorded', req.user._id, req.body.conditions);
    await application.save();

    return res.status(200).json({
      success: true,
      message: `Offer from ${application.institution} recorded`,
      data: viewFor(application, req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record that offer');
  }
};

/**
 * PATCH /api/careers/applications/:id/accept
 *
 * One firm acceptance per student per cohort year. This releases the previous
 * one and takes the new one; the partial unique index refuses the case where
 * two of these arrive at the same instant, which is the case application-level
 * checking cannot cover.
 */
exports.acceptOffer = async (req, res) => {
  try {
    const result = await loadApplicationFor(req.params.id, req.user, { ownerOnly: true });
    if (result.status) return fail(res, result.status, result.message);

    const { application } = result;
    if (!application.offer.receivedOn) {
      return fail(res, 409, 'There is no offer here to accept');
    }
    if (application.offer.isFirmAcceptance) {
      return fail(res, 409, 'This is already your firm acceptance');
    }

    const previous = await CollegeApplication.findOne({
      student: application.student,
      cohortYear: application.cohortYear,
      'offer.isFirmAcceptance': true,
    });

    // Release first. The index would refuse the second acceptance otherwise,
    // and the student would be told their own acceptance was a duplicate.
    if (previous) {
      previous.offer.isFirmAcceptance = false;
      previous.status = 'declined-offer';
      previous.recordHistory(
        'acceptance-released',
        req.user._id,
        `Released in favour of ${application.institution}`
      );
      await previous.save();
    }

    application.offer.isFirmAcceptance = true;
    application.offer.acceptedAt = new Date();
    application.status = 'accepted';
    application.recordHistory(
      'accepted',
      req.user._id,
      previous ? `Replacing ${previous.institution}` : undefined
    );
    await application.save();

    return res.status(200).json({
      success: true,
      message: previous
        ? `Accepted ${application.institution}; ${previous.institution} released`
        : `Accepted ${application.institution}`,
      data: viewFor(application, req.user),
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return fail(
        res,
        409,
        'You already hold a firm acceptance for this year — release it first'
      );
    }
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to accept that offer');
  }
};

/**
 * PATCH /api/careers/applications/:id/withdraw
 *
 * Withdrawn applications are retained. "Applied and withdrew" is a different
 * fact from "never applied", and the second one is what a deleted row looks
 * like.
 */
exports.withdrawApplication = async (req, res) => {
  try {
    const result = await loadApplicationFor(req.params.id, req.user);
    if (result.status) return fail(res, result.status, result.message);

    const { application } = result;
    if (application.status === 'withdrawn') {
      return fail(res, 409, 'That application is already withdrawn');
    }

    application.status = 'withdrawn';
    application.offer.isFirmAcceptance = false;
    application.recordHistory('withdrawn', req.user._id, req.body.reason);
    await application.save();

    return res.status(200).json({
      success: true,
      message: 'Withdrawn',
      data: viewFor(application, req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to withdraw that application');
  }
};

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/**
 * POST /api/careers/applications/:id/references
 */
exports.requestReference = async (req, res) => {
  try {
    const result = await loadApplicationFor(req.params.id, req.user, { ownerOnly: true });
    if (result.status) return fail(res, result.status, result.message);

    const { application } = result;
    const { referee } = req.body;
    if (!isValidId(referee)) return fail(res, 400, 'Invalid referee id');
    if (String(referee) === String(req.user._id)) {
      return fail(res, 400, 'You cannot be your own referee');
    }
    if (CollegeApplication.SUBMITTED_STATUSES.includes(application.status)) {
      return fail(res, 409, 'This application has already gone');
    }

    application.references.push({
      referee,
      refereeName: req.body.refereeName,
      relationship: req.body.relationship,
      dueBy: req.body.dueBy || application.deadline,
    });

    application.recordHistory('reference-requested', req.user._id, req.body.refereeName);
    await application.save();

    return res.status(201).json({
      success: true,
      message: 'Requested. You will see when they accept and when they submit it.',
      data: application.toStudentView(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to request that reference');
  }
};

/**
 * GET /api/careers/references/mine
 *
 * The referee's queue. Only the requests addressed to them, and nothing about
 * the student's other applications — which colleges a student is applying to is
 * none of a subject teacher's business.
 */
exports.getMyReferenceRequests = async (req, res) => {
  try {
    const applications = await CollegeApplication.find({
      'references.referee': req.user._id,
    }).populate('student', 'name email');

    const today = CollegeApplication.todayKey();
    const rows = [];

    for (const application of applications) {
      let touched = false;
      if (application.expireStaleReferences(today) > 0) touched = true;

      for (const reference of application.references) {
        if (String(reference.referee) !== String(req.user._id)) continue;
        rows.push({
          ...application.toRefereeView(reference),
          student: application.student,
        });
      }

      if (touched) await application.save();
    }

    rows.sort((a, b) => ((a.dueBy || '9999') < (b.dueBy || '9999') ? -1 : 1));

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    return serverError(res, error, 'Failed to load your reference requests');
  }
};

/**
 * Shared loader for the three referee actions. Refuses anybody who is not the
 * named referee — including the student, and including an admin.
 */
async function loadReferenceFor(applicationId, referenceId, user) {
  if (!isValidId(applicationId)) return { status: 400, message: 'Invalid application id' };

  const application = await CollegeApplication.findById(applicationId);
  if (!application) return { status: 404, message: 'Application not found' };

  const reference = application.references.id(referenceId);
  if (!reference) return { status: 404, message: 'Reference request not found' };

  if (String(reference.referee) !== String(user._id)) {
    return { status: 403, message: 'That reference was not asked of you' };
  }

  return { application, reference };
}

/**
 * PATCH /api/careers/references/:appId/:refId/accept
 */
exports.acceptReference = async (req, res) => {
  try {
    const result = await loadReferenceFor(req.params.appId, req.params.refId, req.user);
    if (result.status) return fail(res, result.status, result.message);

    const { application, reference } = result;
    if (reference.status !== 'requested') {
      return fail(res, 409, `That request is already ${reference.status}`);
    }

    reference.status = 'accepted';
    reference.respondedAt = new Date();
    application.recordHistory('reference-accepted', req.user._id);
    await application.save();

    return res.status(200).json({
      success: true,
      message: 'Accepted. The student sees that you agreed, and nothing else.',
      data: application.toRefereeView(reference),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to accept that request');
  }
};

/**
 * PATCH /api/careers/references/:appId/:refId/decline
 *
 * Declining is a first-class outcome and it is shown to the student with its
 * reason. A teacher who will not write is information the student needs in
 * October, not in December.
 */
exports.declineReference = async (req, res) => {
  try {
    if (!req.body.reason || !String(req.body.reason).trim()) {
      return fail(res, 400, 'A decline needs a reason the student can act on');
    }

    const result = await loadReferenceFor(req.params.appId, req.params.refId, req.user);
    if (result.status) return fail(res, result.status, result.message);

    const { application, reference } = result;
    if (reference.status === 'submitted') {
      return fail(res, 409, 'That reference has already been submitted');
    }

    reference.status = 'declined';
    reference.respondedAt = new Date();
    reference.declineReason = req.body.reason;
    application.recordHistory('reference-declined', req.user._id, req.body.reason);
    await application.save();

    return res.status(200).json({
      success: true,
      message: 'Declined. The student has been told, with your reason.',
      data: application.toRefereeView(reference),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to decline that request');
  }
};

/**
 * PATCH /api/careers/references/:appId/:refId/submit
 *
 * The letter goes in here. It comes back out of no endpoint the student can
 * reach — `toStudentView()` strips it, and that is the only serializer their
 * requests ever pass through.
 */
exports.submitReference = async (req, res) => {
  try {
    const result = await loadReferenceFor(req.params.appId, req.params.refId, req.user);
    if (result.status) return fail(res, result.status, result.message);

    const { application, reference } = result;
    if (reference.status === 'submitted') {
      return fail(res, 409, 'You have already submitted this reference');
    }
    if (reference.status === 'declined') {
      return fail(res, 409, 'You declined this request');
    }
    if (!req.body.letterBody || !String(req.body.letterBody).trim()) {
      return fail(res, 400, 'A reference needs a letter');
    }

    reference.letterBody = req.body.letterBody;
    reference.strengthRating =
      req.body.strengthRating === undefined ? null : Number(req.body.strengthRating);
    reference.recommendationLevel = req.body.recommendationLevel || null;
    reference.submissionRef = req.body.submissionRef || null;
    reference.status = 'submitted';
    reference.submittedAt = new Date();

    application.recordHistory('reference-submitted', req.user._id);
    await application.save();

    return res.status(200).json({
      success: true,
      message: 'Submitted. The student sees that it is in, and not what it says.',
      data: application.toRefereeView(reference),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to submit that reference');
  }
};

// ---------------------------------------------------------------------------
// Counsellor
// ---------------------------------------------------------------------------

/**
 * POST /api/careers/applications/:id/notes
 */
exports.addNote = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid application id');
    if (!req.body.body || !String(req.body.body).trim()) {
      return fail(res, 400, 'A note needs a body');
    }

    const application = await CollegeApplication.findById(id);
    if (!application) return fail(res, 404, 'Application not found');

    application.counsellorNotes.push({ body: req.body.body, by: req.user._id });
    application.recordHistory('note-added', req.user._id);
    await application.save();

    return res.status(201).json({
      success: true,
      message: 'Note added. It is not visible to the student.',
      data: application.toStaffView(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to add that note');
  }
};

/**
 * GET /api/careers/stats
 */
exports.getStats = async (req, res) => {
  try {
    const cohortYear = req.query.cohortYear || cohortYearFor();
    const today = CollegeApplication.todayKey();

    const applications = await CollegeApplication.find({ cohortYear });

    const byStatus = {};
    const byPriority = {};
    let atRisk = 0;
    let overdue = 0;
    let referencesRequested = 0;
    let referencesIn = 0;
    let referencesDeclined = 0;
    let referencesExpired = 0;
    let firmAcceptances = 0;

    const students = new Set();

    for (const application of applications) {
      students.add(String(application.student));
      byStatus[application.status] = (byStatus[application.status] || 0) + 1;
      byPriority[application.priority] = (byPriority[application.priority] || 0) + 1;

      if (application.isAtRisk(today)) atRisk += 1;
      if (application.deadlineState(today).state === 'overdue') overdue += 1;
      if (application.offer.isFirmAcceptance) firmAcceptances += 1;

      for (const reference of application.references) {
        referencesRequested += 1;
        if (reference.status === 'submitted') referencesIn += 1;
        if (reference.status === 'declined') referencesDeclined += 1;
        if (reference.status === 'expired') referencesExpired += 1;
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        cohortYear,
        applicationCount: applications.length,
        studentCount: students.size,
        applicationsPerStudent: students.size
          ? Math.round((applications.length / students.size) * 10) / 10
          : 0,
        byStatus,
        byPriority,
        atRisk,
        overdue,
        firmAcceptances,
        references: {
          requested: referencesRequested,
          submitted: referencesIn,
          declined: referencesDeclined,
          // Silence, made visible. A referee who never answered is not the same
          // as one who said no, and both are worse than being told in October.
          expired: referencesExpired,
        },
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build careers statistics');
  }
};
