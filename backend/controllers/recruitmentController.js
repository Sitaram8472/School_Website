const mongoose = require('mongoose');
const {
  JobPosting,
  JobApplication,
  POSTING_STATUSES,
  EMPLOYMENT_TYPES,
  APPLICATION_STAGES,
  DEFAULT_CRITERIA,
  DEFAULT_OFFER_VALIDITY_DAYS,
} = require('../models/JobPosting');
const User = require('../models/User');

/**
 * Recruitment.
 *
 * Three handlers carry the module.
 *
 * `submitScore` is where the sealed panel is enforced: it writes one card per
 * panellist and every response afterwards goes through `forViewer`, which
 * removes the other cards until the panel is complete.
 *
 * `makeOffer` is a guarded `$inc` on the posting's live-offer count, so the
 * establishment cannot be exceeded by two people acting at the same moment.
 *
 * `respondToOffer` and `reconcilePosting` are the two ways a post comes back,
 * and both go through `releasePost`, which uses the application's own hold state
 * so the same post is never released twice.
 */

const DAY_MS = 86400000;

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
    return Object.values(error.errors)
      .map((e) => e.message)
      .join(' ');
  }
  if (error.name === 'ValidatorError' || error.name === 'CastError') return error.message;
  return null;
}

function sanitisePosting(body) {
  return {
    title: body.title,
    department: body.department,
    subject: body.subject,
    employmentType: EMPLOYMENT_TYPES.includes(body.employmentType) ? body.employmentType : undefined,
    vacancies: body.vacancies === undefined ? undefined : Number(body.vacancies),
    minQualification: body.minQualification,
    minExperienceYears:
      body.minExperienceYears === undefined ? undefined : Number(body.minExperienceYears),
    salaryBand: body.salaryBand,
    opensOn: body.opensOn,
    closesOn: body.closesOn,
    offerValidityDays:
      body.offerValidityDays === undefined ? undefined : Number(body.offerValidityDays),
    criteria: Array.isArray(body.criteria)
      ? body.criteria.map((criterion) => ({
          key: criterion.key,
          label: criterion.label,
          weight: Number(criterion.weight),
          maxScore: Number(criterion.maxScore),
        }))
      : undefined,
  };
}

async function loadPosting(id) {
  if (!isValidId(id)) return { status: 400, message: 'Invalid posting id' };
  const posting = await JobPosting.findById(id);
  if (!posting) return { status: 404, message: 'Posting not found' };
  return { posting };
}

async function loadApplication(id) {
  if (!isValidId(id)) return { status: 400, message: 'Invalid application id' };

  const application = await JobApplication.findById(id);
  if (!application) return { status: 404, message: 'Application not found' };

  const posting = await JobPosting.findById(application.posting);
  if (!posting) return { status: 404, message: 'The posting for that application is gone' };

  return { application, posting };
}

/**
 * Take one of the posts, or refuse with how many are actually free.
 *
 * The guard lives inside the query so the count is evaluated by the database
 * against the document as it is at that instant.
 */
async function holdPost(postingId) {
  const held = await JobPosting.findOneAndUpdate(
    { _id: postingId, $expr: { $lt: ['$liveOffers', '$vacancies'] } },
    { $inc: { liveOffers: 1 } },
    { new: true }
  );

  if (held) return { posting: held };

  const posting = await JobPosting.findById(postingId);
  return {
    error: `All ${posting.vacancies} posts are under offer; ${posting.liveOffers} live offers stand`,
  };
}

/** Give a post back, once, whatever calls this and however often. */
async function releasePost(application, nextStage, actor, note) {
  const now = new Date();
  const released = await JobApplication.findOneAndUpdate(
    { _id: application._id, offerHold: 'held' },
    {
      $set: {
        stage: nextStage,
        offerHold: 'released',
        'offer.respondedAt': now,
        'offer.responseNote': note,
      },
      $push: {
        history: { action: nextStage, by: actor ? actor._id : undefined, at: now, note },
      },
    },
    { new: true }
  );

  if (!released) return null;

  await JobPosting.updateOne(
    { _id: application.posting, liveOffers: { $gt: 0 } },
    { $inc: { liveOffers: -1 } }
  );

  return released;
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/** GET /api/recruitment/meta */
exports.getMeta = async (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      postingStatuses: POSTING_STATUSES,
      employmentTypes: EMPLOYMENT_TYPES,
      applicationStages: APPLICATION_STAGES,
      defaultCriteria: DEFAULT_CRITERIA,
      defaultOfferValidityDays: DEFAULT_OFFER_VALIDITY_DAYS,
    },
  });
};

// ---------------------------------------------------------------------------
// Postings
// ---------------------------------------------------------------------------

/** POST /api/recruitment/postings */
exports.createPosting = async (req, res) => {
  try {
    const posting = new JobPosting({
      ...sanitisePosting(req.body),
      status: 'draft',
      createdBy: req.user._id,
    });

    posting.recordHistory('created', req.user._id);
    await posting.save();

    return res.status(201).json({ success: true, message: 'Posting drafted', data: posting });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to create the posting');
  }
};

/** GET /api/recruitment/postings */
exports.listPostings = async (req, res) => {
  try {
    const filter = {};
    if (req.query.status && POSTING_STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (req.query.department) filter.department = req.query.department;

    const postings = await JobPosting.find(filter).sort({ closesOn: -1 }).limit(200);

    const counts = await JobApplication.aggregate([
      { $group: { _id: '$posting', count: { $sum: 1 } } },
    ]);
    const countsById = new Map(counts.map((row) => [String(row._id), row.count]));

    return res.status(200).json({
      success: true,
      count: postings.length,
      data: postings.map((posting) => ({
        ...posting.toObject(),
        applicationCount: countsById.get(String(posting._id)) || 0,
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load postings');
  }
};

/** GET /api/recruitment/postings/:id */
exports.getPosting = async (req, res) => {
  try {
    const { posting, status, message } = await loadPosting(req.params.id);
    if (!posting) return fail(res, status, message);

    await posting.populate('panel.user', 'name email role');

    return res.status(200).json({
      success: true,
      data: {
        posting,
        seatsFree: posting.seatsFree,
        acceptingApplications: posting.isAcceptingApplications(),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the posting');
  }
};

/** PATCH /api/recruitment/postings/:id */
exports.updatePosting = async (req, res) => {
  try {
    const { posting, status, message } = await loadPosting(req.params.id);
    if (!posting) return fail(res, status, message);

    if (posting.status !== 'draft') {
      return fail(res, 409, 'A published posting cannot be edited; close it and draft another');
    }

    const updates = sanitisePosting(req.body);
    Object.entries(updates).forEach(([key, value]) => {
      if (value !== undefined) posting.set(key, value);
    });

    posting.recordHistory('edited', req.user._id);
    await posting.save();

    return res.status(200).json({ success: true, message: 'Posting updated', data: posting });
  } catch (error) {
    const msg = validationMessage(error);
    if (msg) return fail(res, 400, msg);
    return serverError(res, error, 'Failed to update the posting');
  }
};

/** PATCH /api/recruitment/postings/:id/publish */
exports.publishPosting = async (req, res) => {
  try {
    const { posting, status, message } = await loadPosting(req.params.id);
    if (!posting) return fail(res, status, message);

    if (posting.status !== 'draft') {
      return fail(res, 409, `That posting is already ${posting.status}`);
    }
    if (!posting.panel.length) {
      return fail(res, 409, 'Assign the interview panel before publishing; the seal depends on it');
    }

    const year = new Date(posting.closesOn).getFullYear();
    const serial = await JobPosting.countDocuments({ ref: { $regex: `^VAC/${year}/` } });
    posting.ref = `VAC/${year}/${String(serial + 1).padStart(3, '0')}`;
    posting.status = 'open';
    posting.recordHistory('published', req.user._id);
    await posting.save();

    return res.status(200).json({
      success: true,
      message: `Published as ${posting.ref}`,
      data: posting,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to publish the posting');
  }
};

/** PATCH /api/recruitment/postings/:id/close */
exports.closePosting = async (req, res) => {
  try {
    const { posting, status, message } = await loadPosting(req.params.id);
    if (!posting) return fail(res, status, message);

    if (['closed', 'shortlisting', 'interviewing', 'offered', 'filled'].includes(posting.status)) {
      return res.status(200).json({ success: true, message: 'Already closed', data: posting });
    }

    posting.status = 'closed';
    posting.recordHistory('closed to applications', req.user._id, req.body.note);
    await posting.save();

    return res.status(200).json({ success: true, message: 'Closed to applications', data: posting });
  } catch (error) {
    return serverError(res, error, 'Failed to close the posting');
  }
};

/** POST /api/recruitment/postings/:id/panel */
exports.addPanellist = async (req, res) => {
  try {
    const { posting, status, message } = await loadPosting(req.params.id);
    if (!posting) return fail(res, status, message);

    if (!isValidId(req.body.user)) return fail(res, 400, 'Invalid user id');

    const member = await User.findById(req.body.user).select('name role');
    if (!member) return fail(res, 404, 'That user does not exist');
    if (member.role === 'student') return fail(res, 400, 'A student cannot sit on a hiring panel');

    if (posting.hasPanellist(member._id)) {
      return res.status(200).json({ success: true, message: 'Already on the panel', data: posting });
    }

    posting.panel.push({ user: member._id });
    posting.recordHistory('panellist added', req.user._id, member.name);
    await posting.save();

    // The seal depends on the panel size, so every application's aggregate is
    // now describing a smaller panel than the one that exists.
    const applications = await JobApplication.find({ posting: posting._id });
    for (const application of applications) {
      application.recomputeAggregate(posting);
      await application.save();
    }

    return res.status(201).json({
      success: true,
      message: `${member.name} added; the panel is now ${posting.panel.length}`,
      data: posting,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to add the panellist');
  }
};

/** DELETE /api/recruitment/postings/:id/panel/:uid */
exports.removePanellist = async (req, res) => {
  try {
    const { posting, status, message } = await loadPosting(req.params.id);
    if (!posting) return fail(res, status, message);

    posting.panel = posting.panel.filter((member) => String(member.user) !== String(req.params.uid));
    posting.recordHistory('panellist removed', req.user._id);
    await posting.save();

    const applications = await JobApplication.find({ posting: posting._id });
    for (const application of applications) {
      application.recomputeAggregate(posting);
      await application.save();
    }

    return res.status(200).json({ success: true, message: 'Panellist removed', data: posting });
  } catch (error) {
    return serverError(res, error, 'Failed to remove the panellist');
  }
};

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

/** POST /api/recruitment/postings/:id/applications */
exports.createApplication = async (req, res) => {
  try {
    const { posting, status, message } = await loadPosting(req.params.id);
    if (!posting) return fail(res, status, message);

    if (!posting.isAcceptingApplications()) {
      // Name the date. "Not allowed" is what makes somebody ring the office.
      return fail(
        res,
        409,
        posting.status === 'open'
          ? `Applications closed on ${posting.closesOn.toISOString().slice(0, 10)}`
          : `That posting is ${posting.status} and is not taking applications`
      );
    }

    const counted = await JobPosting.findByIdAndUpdate(
      posting._id,
      { $inc: { applicationCounter: 1 } },
      { new: true }
    );

    const application = new JobApplication({
      posting: posting._id,
      reference: `${posting.ref}/A${String(counted.applicationCounter).padStart(3, '0')}`,
      candidateName: req.body.candidateName,
      email: req.body.email,
      phone: req.body.phone,
      qualification: req.body.qualification,
      yearsExperience: Number(req.body.yearsExperience) || 0,
      coverNote: req.body.coverNote,
      stage: 'received',
    });

    application.recomputeAggregate(posting);
    application.recordHistory('received', req.user._id);
    await application.save();

    return res.status(201).json({
      success: true,
      message: `Recorded as ${application.reference}`,
      data: application,
    });
  } catch (error) {
    if (error.code === 11000) {
      return fail(res, 409, 'That candidate has already applied for this post');
    }
    const msg = validationMessage(error);
    if (msg) return fail(res, 400, msg);
    return serverError(res, error, 'Failed to record the application');
  }
};

/** GET /api/recruitment/postings/:id/applications */
exports.listApplications = async (req, res) => {
  try {
    const { posting, status, message } = await loadPosting(req.params.id);
    if (!posting) return fail(res, status, message);

    const filter = { posting: posting._id };
    if (req.query.stage && APPLICATION_STAGES.includes(req.query.stage)) {
      filter.stage = req.query.stage;
    }

    const applications = await JobApplication.find(filter).sort({ createdAt: 1 });

    return res.status(200).json({
      success: true,
      count: applications.length,
      data: applications.map((application) => application.forViewer(req.user._id)),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load applications');
  }
};

/** GET /api/recruitment/applications/:id */
exports.getApplication = async (req, res) => {
  try {
    const { application, posting, status, message } = await loadApplication(req.params.id);
    if (!application) return fail(res, status, message);

    return res.status(200).json({
      success: true,
      data: {
        application: application.forViewer(req.user._id),
        posting,
        myScore: application.scoreBy(req.user._id),
        daysToRespond: application.daysToRespond(),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the application');
  }
};

/** PATCH /api/recruitment/applications/:id/screen */
exports.screenApplication = async (req, res) => {
  try {
    const { application, posting, status, message } = await loadApplication(req.params.id);
    if (!application) return fail(res, status, message);

    if (application.stage !== 'received') {
      return fail(res, 409, `That application is already ${application.stage}`);
    }

    const meetsQualification = Boolean(req.body.meetsQualification);
    const meetsExperience =
      req.body.meetsExperience === undefined
        ? application.yearsExperience >= posting.minExperienceYears
        : Boolean(req.body.meetsExperience);

    application.screening = {
      meetsQualification,
      meetsExperience,
      note: req.body.note,
      screenedBy: req.user._id,
      screenedAt: new Date(),
    };
    application.stage = 'screened';
    application.recordHistory('screened', req.user._id, req.body.note);
    await application.save();

    return res.status(200).json({ success: true, message: 'Screened', data: application });
  } catch (error) {
    return serverError(res, error, 'Failed to screen the application');
  }
};

/** PATCH /api/recruitment/applications/:id/shortlist */
exports.shortlistApplication = async (req, res) => {
  try {
    const { application, posting, status, message } = await loadApplication(req.params.id);
    if (!application) return fail(res, status, message);

    if (application.stage !== 'screened') {
      return fail(res, 409, 'Screen the application before shortlisting it');
    }

    application.stage = 'shortlisted';
    application.recordHistory('shortlisted', req.user._id, req.body.note);
    await application.save();

    if (posting.status === 'closed') {
      posting.status = 'shortlisting';
      await posting.save();
    }

    return res.status(200).json({ success: true, message: 'Shortlisted', data: application });
  } catch (error) {
    return serverError(res, error, 'Failed to shortlist the application');
  }
};

/**
 * POST /api/recruitment/applications/:id/scores
 *
 * One card per panellist, revisable until the panel completes. After that a
 * revision would be a revision made with the mean in view, which is not a
 * revision.
 */
exports.submitScore = async (req, res) => {
  try {
    const { application, posting, status, message } = await loadApplication(req.params.id);
    if (!application) return fail(res, status, message);

    if (!posting.hasPanellist(req.user._id)) {
      return fail(res, 403, 'You are not on the panel for this post');
    }
    if (!['shortlisted', 'interviewed'].includes(application.stage)) {
      return fail(res, 409, `A ${application.stage} application is not at interview`);
    }

    const incoming = Array.isArray(req.body.scores) ? req.body.scores : [];
    const scores = [];

    for (const entry of incoming) {
      const criterion = posting.criterionFor(entry.key);
      if (!criterion) return fail(res, 400, `"${entry.key}" is not a criterion on this post`);

      const score = Number(entry.score);
      if (!Number.isFinite(score) || score < 0 || score > criterion.maxScore) {
        return fail(
          res,
          400,
          `${criterion.label} is scored out of ${criterion.maxScore}; ${entry.score} is not`
        );
      }
      scores.push({ key: criterion.key, score });
    }

    const missing = posting.criteria.filter(
      (criterion) => !scores.some((entry) => entry.key === criterion.key)
    );
    if (missing.length) {
      return fail(res, 400, `Score every criterion; ${missing.map((c) => c.label).join(', ')} missing`);
    }

    const existing = application.scoreBy(req.user._id);
    if (existing && application.aggregate.isComplete) {
      return fail(res, 409, 'The panel is complete; a score cannot be revised after the mean is out');
    }

    const card = {
      panellist: req.user._id,
      scores,
      weightedTotal: JobApplication.weightedTotalFor(posting, scores),
      comment: req.body.comment,
      submittedAt: new Date(),
    };

    if (existing) {
      application.panelScores = application.panelScores.map((entry) =>
        String(entry.panellist) === String(req.user._id) ? card : entry
      );
    } else {
      application.panelScores.push(card);
    }

    application.recomputeAggregate(posting);
    application.recordHistory(existing ? 'score revised' : 'score submitted', req.user._id);
    await application.save();

    if (posting.status === 'shortlisting') {
      posting.status = 'interviewing';
      await posting.save();
    }

    return res.status(200).json({
      success: true,
      message: application.aggregate.isComplete
        ? `Panel complete — mean ${application.aggregate.mean}, spread ${application.aggregate.spread}`
        : `Recorded; ${application.aggregate.panelCount} of ${application.aggregate.expectedPanel} panellists have scored`,
      data: application.forViewer(req.user._id),
    });
  } catch (error) {
    const msg = validationMessage(error);
    if (msg) return fail(res, 400, msg);
    return serverError(res, error, 'Failed to record the score');
  }
};

/** PATCH /api/recruitment/applications/:id/interviewed */
exports.markInterviewed = async (req, res) => {
  try {
    const { application, status, message } = await loadApplication(req.params.id);
    if (!application) return fail(res, status, message);

    if (application.stage !== 'shortlisted') {
      return fail(res, 409, `A ${application.stage} application cannot be marked interviewed`);
    }

    application.stage = 'interviewed';
    application.recordHistory('interviewed', req.user._id, req.body.note);
    await application.save();

    return res.status(200).json({ success: true, message: 'Marked interviewed', data: application });
  } catch (error) {
    return serverError(res, error, 'Failed to mark the application interviewed');
  }
};

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

/** PATCH /api/recruitment/applications/:id/offer */
exports.makeOffer = async (req, res) => {
  try {
    const { application, posting, status, message } = await loadApplication(req.params.id);
    if (!application) return fail(res, status, message);

    if (application.isLiveOffer()) {
      return res.status(200).json({ success: true, message: 'An offer already stands', data: application });
    }
    if (application.stage !== 'interviewed') {
      return fail(res, 409, 'Only an interviewed candidate can be made an offer');
    }
    if (!application.aggregate.isComplete) {
      return fail(
        res,
        409,
        `The panel is not complete — ${application.aggregate.panelCount} of ${application.aggregate.expectedPanel} have scored`
      );
    }

    const { posting: held, error } = await holdPost(posting._id);
    if (error) return fail(res, 409, error);

    const now = new Date();
    application.stage = 'offer-made';
    application.offerHold = 'held';
    application.offer = {
      madeAt: now,
      madeBy: req.user._id,
      expiresAt: new Date(now.getTime() + posting.offerValidityDays * DAY_MS),
      salaryOffered: req.body.salaryOffered || posting.salaryBand,
    };
    application.recordHistory('offer made', req.user._id, req.body.note);
    await application.save();

    if (held.status !== 'offered') {
      held.status = 'offered';
      await held.save();
    }

    return res.status(200).json({
      success: true,
      message: `Offer made; ${held.seatsFree} of ${held.vacancies} posts still free`,
      data: { application, posting: held },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to make the offer');
  }
};

/**
 * PATCH /api/recruitment/applications/:id/offer/respond
 *
 * Accepting is firm and singular: every other live offer to the same email
 * address is withdrawn here, each giving its own post back, so the physics
 * vacancy learns on the day that the maths vacancy got the candidate.
 */
exports.respondToOffer = async (req, res) => {
  try {
    const { application, posting, status, message } = await loadApplication(req.params.id);
    if (!application) return fail(res, status, message);

    if (application.stage !== 'offer-made') {
      return fail(res, 409, `That application is ${application.stage}; there is no live offer`);
    }

    const accepted = String(req.body.decision).toLowerCase() === 'accept';
    const now = new Date();

    if (!accepted) {
      const released = await releasePost(
        application,
        'offer-declined',
        req.user,
        req.body.note || 'declined by the candidate'
      );
      if (!released) return fail(res, 409, 'That offer changed a moment ago; reload it');

      return res.status(200).json({
        success: true,
        message: 'Offer declined; the post is free again',
        data: released,
      });
    }

    if (application.offerHasExpired(now)) {
      return fail(
        res,
        409,
        `That offer expired on ${application.offer.expiresAt.toISOString().slice(0, 10)}`
      );
    }

    const confirmed = await JobApplication.findOneAndUpdate(
      { _id: application._id, stage: 'offer-made', offerHold: 'held' },
      {
        $set: {
          stage: 'offer-accepted',
          offerHold: 'confirmed',
          'offer.respondedAt': now,
          'offer.responseNote': req.body.note,
        },
        $push: { history: { action: 'offer accepted', by: req.user._id, at: now } },
      },
      { new: true }
    );

    if (!confirmed) return fail(res, 409, 'That offer changed a moment ago; reload it');

    const rivals = await JobApplication.find({
      email: confirmed.email,
      _id: { $ne: confirmed._id },
      stage: 'offer-made',
    });

    let withdrawn = 0;
    for (const rival of rivals) {
      const released = await releasePost(
        rival,
        'withdrawn',
        req.user,
        'the candidate accepted another post here'
      );
      if (released) withdrawn += 1;
    }

    if (posting.liveOffers >= posting.vacancies) {
      const filled = await JobPosting.findById(posting._id);
      const acceptedCount = await JobApplication.countDocuments({
        posting: posting._id,
        stage: 'offer-accepted',
      });
      if (acceptedCount >= filled.vacancies) {
        filled.status = 'filled';
        await filled.save();
      }
    }

    return res.status(200).json({
      success: true,
      message: withdrawn
        ? `Offer accepted; ${withdrawn} other offer${withdrawn === 1 ? '' : 's'} to this candidate withdrawn`
        : 'Offer accepted',
      data: confirmed,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to record the response');
  }
};

/** PATCH /api/recruitment/applications/:id/reject */
exports.rejectApplication = async (req, res) => {
  try {
    const { application, status, message } = await loadApplication(req.params.id);
    if (!application) return fail(res, status, message);

    if (['offer-accepted', 'rejected'].includes(application.stage)) {
      return fail(res, 409, `That application is ${application.stage}`);
    }

    if (application.isLiveOffer()) {
      await releasePost(application, 'rejected', req.user, req.body.note);
    } else {
      application.stage = 'rejected';
      application.decisionNote = req.body.note;
      application.recordHistory('rejected', req.user._id, req.body.note);
      await application.save();
    }

    const fresh = await JobApplication.findById(application._id);
    return res.status(200).json({ success: true, message: 'Application closed', data: fresh });
  } catch (error) {
    return serverError(res, error, 'Failed to reject the application');
  }
};

/**
 * POST /api/recruitment/postings/:id/reconcile
 *
 * Lapses every offer past its date and frees each post in the same operation.
 * Idempotent — the hold state means a second sweep in the same minute moves
 * nothing.
 */
exports.reconcilePosting = async (req, res) => {
  try {
    const { posting, status, message } = await loadPosting(req.params.id);
    if (!posting) return fail(res, status, message);

    const now = new Date();
    const due = await JobApplication.find({
      posting: posting._id,
      stage: 'offer-made',
      'offer.expiresAt': { $lte: now },
    });

    let lapsed = 0;
    for (const application of due) {
      const released = await releasePost(application, 'offer-lapsed', req.user, 'offer lapsed');
      if (released) lapsed += 1;
    }

    const fresh = await JobPosting.findById(posting._id);
    return res.status(200).json({
      success: true,
      message: `${lapsed} offer${lapsed === 1 ? '' : 's'} lapsed; ${fresh.seatsFree} of ${fresh.vacancies} posts free`,
      data: { lapsed, posting: fresh },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to reconcile the posting');
  }
};

// ---------------------------------------------------------------------------
// Panel and reporting
// ---------------------------------------------------------------------------

/** GET /api/recruitment/panel/mine */
exports.getMyPanelWork = async (req, res) => {
  try {
    const postings = await JobPosting.find({ 'panel.user': req.user._id }).sort({ closesOn: -1 });
    const postingIds = postings.map((posting) => posting._id);

    const applications = await JobApplication.find({
      posting: { $in: postingIds },
      stage: { $in: ['shortlisted', 'interviewed'] },
    }).sort({ createdAt: 1 });

    return res.status(200).json({
      success: true,
      data: {
        postings,
        awaitingMyScore: applications
          .filter((application) => !application.scoreBy(req.user._id))
          .map((application) => application.forViewer(req.user._id)),
        scored: applications
          .filter((application) => application.scoreBy(req.user._id))
          .map((application) => application.forViewer(req.user._id)),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load your panel work');
  }
};

/** GET /api/recruitment/stats */
exports.getStats = async (req, res) => {
  try {
    const [byStage, openPostings] = await Promise.all([
      JobApplication.aggregate([{ $group: { _id: '$stage', count: { $sum: 1 } } }]),
      JobPosting.find({ status: { $in: ['open', 'shortlisting', 'interviewing', 'offered'] } }),
    ]);

    const now = new Date();
    const lapsing = await JobApplication.countDocuments({
      stage: 'offer-made',
      'offer.expiresAt': { $lte: new Date(now.getTime() + 3 * DAY_MS) },
    });

    return res.status(200).json({
      success: true,
      data: {
        byStage: byStage.reduce((acc, row) => ({ ...acc, [row._id]: row.count }), {}),
        openPostings: openPostings.map((posting) => ({
          id: posting._id,
          ref: posting.ref,
          title: posting.title,
          vacancies: posting.vacancies,
          liveOffers: posting.liveOffers,
          seatsFree: posting.seatsFree,
        })),
        offersLapsingWithin3Days: lapsing,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load recruitment statistics');
  }
};
