const mongoose = require('mongoose');
const AlumniProfile = require('../models/AlumniProfile');

/**
 * Alumni network and mentorship.
 *
 * The function worth reading is `respondToRequest`. Everything else is CRUD
 * with a redaction step.
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

/**
 * Validate a detached subdocument without letting it throw. An array
 * subdocument built with `.create()` has no parent to record failures against,
 * so Mongoose throws the `ValidatorError` rather than returning a
 * `ValidationError` — uncaught, "your message is too short" becomes a 500.
 */
function validateSubdocument(doc) {
  try {
    return doc.validateSync() || null;
  } catch (error) {
    return error;
  }
}

function isStaff(user) {
  return user.role === 'admin' || user.role === 'staff';
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/**
 * POST /api/alumni/profiles
 *
 * A profile always starts unverified. `verificationStatus`, `verifiedBy`,
 * `verifiedAt` and `activeMenteeCount` are absent from the constructed document
 * on purpose — a request carrying `verificationStatus: 'verified'` would
 * otherwise verify itself, which defeats the only control this module has.
 */
exports.createProfile = async (req, res) => {
  try {
    const existing = await AlumniProfile.findOne({ user: req.user._id });
    if (existing) {
      return fail(res, 409, 'You already have an alumni profile. Edit it instead.', {
        profileId: existing._id,
      });
    }

    const {
      fullName,
      graduationYear,
      graduatingClass,
      currentRole,
      organisation,
      industry,
      city,
      country,
      bio,
      contactEmail,
      contactPhone,
      linkedinUrl,
      willingToMentor,
      mentorCapacity,
      mentorshipAreas,
    } = req.body;

    const profile = await AlumniProfile.create({
      user: req.user._id,
      fullName: fullName || req.user.name,
      graduationYear,
      graduatingClass,
      currentRole,
      organisation,
      industry,
      city,
      country,
      bio,
      contactEmail: contactEmail || req.user.email,
      contactPhone,
      linkedinUrl,
      willingToMentor: Boolean(willingToMentor),
      mentorCapacity,
      mentorshipAreas,
    });

    return res.status(201).json({
      success: true,
      message: 'Profile submitted. The school office will verify it before it appears in the directory.',
      data: profile.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    if (error.code === 11000) return fail(res, 409, 'You already have an alumni profile.');
    return serverError(res, error, 'Failed to create the alumni profile');
  }
};

/**
 * GET /api/alumni/profiles
 *
 * The browse view. `verificationStatus: 'verified'` is fixed in the filter and
 * not derived from a query parameter — an unverified profile must not be
 * reachable by asking for it.
 */
exports.browseProfiles = async (req, res) => {
  try {
    const { graduationYear, industry, area, city, mentorsOnly, search } = req.query;

    const filter = { verificationStatus: 'verified' };
    if (graduationYear) filter.graduationYear = Number(graduationYear);
    if (industry) filter.industry = { $regex: String(industry).trim(), $options: 'i' };
    if (city) filter.city = { $regex: String(city).trim(), $options: 'i' };
    if (area) filter.mentorshipAreas = area;
    if (mentorsOnly === 'true') filter.willingToMentor = true;
    if (search) filter.fullName = { $regex: String(search).trim(), $options: 'i' };

    const profiles = await AlumniProfile.find(filter)
      .sort({ graduationYear: -1, fullName: 1 })
      .limit(300);

    return res.status(200).json({
      success: true,
      count: profiles.length,
      data: profiles.map((profile) => profile.redactFor(req.user)),
      vocabulary: { mentorshipAreas: AlumniProfile.MENTORSHIP_AREAS },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch alumni profiles');
  }
};

/**
 * GET /api/alumni/profiles/me
 */
exports.getMyProfile = async (req, res) => {
  try {
    const profile = await AlumniProfile.findOne({ user: req.user._id });
    if (!profile) {
      return res.status(200).json({ success: true, data: null, message: 'No alumni profile yet.' });
    }

    return res.status(200).json({
      success: true,
      data: profile.redactFor(req.user),
      vocabulary: { mentorshipAreas: AlumniProfile.MENTORSHIP_AREAS },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch your alumni profile');
  }
};

/**
 * GET /api/alumni/profiles/pending
 */
exports.getPendingProfiles = async (req, res) => {
  try {
    const profiles = await AlumniProfile.find({ verificationStatus: 'pending' }).sort({
      createdAt: 1,
    });

    return res.status(200).json({
      success: true,
      count: profiles.length,
      data: profiles.map((profile) => profile.redactFor(req.user)),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch pending profiles');
  }
};

/**
 * GET /api/alumni/profiles/:id
 */
exports.getProfile = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid profile id.');

    const profile = await AlumniProfile.findById(req.params.id);
    if (!profile) return fail(res, 404, 'Alumni profile not found.');

    // An unverified profile is visible to its owner and to staff, and to nobody
    // else — including by direct link.
    if (
      profile.verificationStatus !== 'verified' &&
      !isStaff(req.user) &&
      !profile.isOwnedBy(req.user)
    ) {
      return fail(res, 404, 'Alumni profile not found.');
    }

    return res.status(200).json({
      success: true,
      data: profile.redactFor(req.user),
      unavailableReason: profile.mentorshipError(),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the alumni profile');
  }
};

/**
 * PATCH /api/alumni/profiles/:id
 *
 * Editing the identity fields of a verified profile sends it back for
 * re-verification. Otherwise "verified" would mean "was verified at some point,
 * possibly describing a different person".
 */
exports.updateProfile = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid profile id.');

    const profile = await AlumniProfile.findById(req.params.id);
    if (!profile) return fail(res, 404, 'Alumni profile not found.');

    if (!profile.isOwnedBy(req.user) && req.user.role !== 'admin') {
      return fail(res, 403, 'You can only edit your own profile.');
    }

    const identityFields = ['fullName', 'graduationYear', 'graduatingClass'];
    const profileFields = [
      'currentRole',
      'organisation',
      'industry',
      'city',
      'country',
      'bio',
      'contactEmail',
      'contactPhone',
      'linkedinUrl',
      'mentorshipAreas',
    ];

    let identityChanged = false;

    identityFields.forEach((field) => {
      if (req.body[field] !== undefined && String(req.body[field]) !== String(profile[field])) {
        profile[field] = req.body[field];
        identityChanged = true;
      }
    });

    profileFields.forEach((field) => {
      if (req.body[field] !== undefined) profile[field] = req.body[field];
    });

    if (req.body.willingToMentor !== undefined) {
      profile.willingToMentor = Boolean(req.body.willingToMentor);
    }

    if (req.body.mentorCapacity !== undefined) {
      const capacity = Number(req.body.mentorCapacity);
      if (Number.isFinite(capacity) && capacity < profile.activeMenteeCount) {
        return fail(
          res,
          409,
          `You already have ${profile.activeMenteeCount} active mentee(s); capacity cannot be set below that. Complete a mentorship first.`
        );
      }
      profile.mentorCapacity = capacity;
    }

    // An admin editing on someone's behalf does not un-verify the profile.
    if (identityChanged && profile.verificationStatus === 'verified' && req.user.role !== 'admin') {
      profile.verificationStatus = 'pending';
      profile.verifiedBy = null;
      profile.verifiedAt = null;
    }

    await profile.save();

    return res.status(200).json({
      success: true,
      message: identityChanged
        ? 'Profile updated. Because the identity details changed, it needs verifying again.'
        : 'Profile updated.',
      data: profile.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update the alumni profile');
  }
};

/**
 * PATCH /api/alumni/profiles/:id/verify
 */
exports.verifyProfile = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid profile id.');

    const { decision, reason } = req.body;
    if (!['verified', 'rejected'].includes(decision)) {
      return fail(res, 400, "decision must be 'verified' or 'rejected'.");
    }
    if (decision === 'rejected' && (!reason || !String(reason).trim())) {
      return fail(res, 400, 'A reason is required so the alumnus knows what to fix.');
    }

    const profile = await AlumniProfile.findById(req.params.id);
    if (!profile) return fail(res, 404, 'Alumni profile not found.');

    profile.verificationStatus = decision;
    profile.verifiedBy = req.user._id;
    profile.verifiedAt = new Date();
    profile.rejectionReason = decision === 'rejected' ? String(reason).trim() : '';

    await profile.save();

    return res.status(200).json({
      success: true,
      message:
        decision === 'verified'
          ? `${profile.fullName} is now in the directory.`
          : `${profile.fullName} was rejected.`,
      data: profile.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to record the verification decision');
  }
};

// ---------------------------------------------------------------------------
// Mentorship
// ---------------------------------------------------------------------------

/**
 * POST /api/alumni/profiles/:id/mentorship
 *
 * Making a request is free — it costs no seat, so there is nothing to race on
 * except the "one live request per student per alumnus" rule, which is folded
 * into the filter with `$not`/`$elemMatch` rather than checked above the write.
 */
exports.requestMentorship = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid profile id.');

    const profile = await AlumniProfile.findById(req.params.id);
    if (!profile) return fail(res, 404, 'Alumni profile not found.');

    if (profile.isOwnedBy(req.user)) {
      return fail(res, 400, 'You cannot request mentorship from yourself.');
    }

    // Read up front so the student gets the real reason rather than a bare
    // "could not request" from the conditional update below.
    const blocked = profile.mentorshipError();
    if (blocked) return fail(res, 409, blocked);

    if (profile.findRequestFrom(req.user._id)) {
      return fail(res, 409, 'You already have a live request with this alumnus.');
    }

    const request = profile.mentorships.create({
      _id: new mongoose.Types.ObjectId(),
      student: req.user._id,
      studentName: req.user.name || '',
      className: req.user.className || '',
      area: req.body.area,
      message: req.body.message,
      status: 'pending',
      requestedAt: new Date(),
    });

    // Validated before the write so a 400 for a short message never reaches the
    // database.
    const invalid = validateSubdocument(request);
    if (invalid) {
      return fail(res, 400, validationMessage(invalid) || 'That request is not valid.');
    }

    const updated = await AlumniProfile.findOneAndUpdate(
      {
        _id: profile._id,
        verificationStatus: 'verified',
        willingToMentor: true,
        mentorships: {
          $not: {
            $elemMatch: { student: req.user._id, status: { $in: ['pending', 'accepted'] } },
          },
        },
      },
      { $push: { mentorships: request.toObject() } },
      { new: true }
    );

    if (!updated) {
      const current = await AlumniProfile.findById(profile._id);
      return fail(
        res,
        409,
        current
          ? current.mentorshipError() || 'You already have a live request with this alumnus.'
          : 'Alumni profile not found.'
      );
    }

    return res.status(201).json({
      success: true,
      message: `Request sent to ${updated.fullName}.`,
      data: updated.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to send the mentorship request');
  }
};

/**
 * PATCH /api/alumni/profiles/:id/mentorship/:requestId/respond
 *
 * Accepting is the one operation here that consumes a finite resource, so it is
 * the one that has to be atomic. The filter carries both halves of the
 * invariant:
 *
 *   - `$expr: activeMenteeCount < mentorCapacity`   a seat is genuinely free
 *   - the request is still `pending`                via `$elemMatch`
 *
 * and the update flips the status and increments the counter together. An
 * alumnus who offered two seats accepting three requests in the same minute
 * would otherwise end up with three mentees, having agreed to two — and the
 * person who gets let down is a volunteer.
 *
 * Declining consumes nothing, so it takes the same guarded update purely to
 * stop a double-tap overwriting an already-recorded response.
 */
exports.respondToRequest = async (req, res) => {
  try {
    const { id, requestId } = req.params;
    const { decision, responseMessage } = req.body;

    if (!isValidId(id) || !isValidId(requestId)) {
      return fail(res, 400, 'Invalid profile or request id.');
    }
    if (!['accepted', 'declined'].includes(decision)) {
      return fail(res, 400, "decision must be 'accepted' or 'declined'.");
    }

    const profile = await AlumniProfile.findById(id);
    if (!profile) return fail(res, 404, 'Alumni profile not found.');

    if (!profile.isOwnedBy(req.user) && req.user.role !== 'admin') {
      return fail(res, 403, 'Only the alumnus can respond to their own requests.');
    }

    const request = profile.mentorships.id(requestId);
    if (!request) return fail(res, 404, 'Mentorship request not found.');
    if (request.status !== 'pending') {
      return fail(res, 409, `This request has already been ${request.status}.`);
    }

    // Silence is the worst answer a student can get, so a decline has to say
    // something.
    if (decision === 'declined' && (!responseMessage || !String(responseMessage).trim())) {
      return fail(res, 400, 'Please write a short reason so the student is not left guessing.');
    }

    if (decision === 'accepted' && profile.activeMenteeCount >= profile.mentorCapacity) {
      return fail(
        res,
        409,
        `You are already mentoring ${profile.activeMenteeCount} student(s), which is your stated capacity.`
      );
    }

    const setFields = {
      'mentorships.$[entry].status': decision,
      'mentorships.$[entry].respondedAt': new Date(),
      'mentorships.$[entry].responseMessage': responseMessage ? String(responseMessage).trim() : '',
    };

    const updated = await AlumniProfile.findOneAndUpdate(
      {
        _id: profile._id,
        mentorships: { $elemMatch: { _id: request._id, status: 'pending' } },
        ...(decision === 'accepted'
          ? { $expr: { $lt: ['$activeMenteeCount', '$mentorCapacity'] } }
          : {}),
      },
      {
        $set: setFields,
        ...(decision === 'accepted' ? { $inc: { activeMenteeCount: 1 } } : {}),
      },
      {
        new: true,
        arrayFilters: [{ 'entry._id': request._id, 'entry.status': 'pending' }],
      }
    );

    if (!updated) {
      const current = await AlumniProfile.findById(profile._id);
      const stale = current && current.mentorships.id(requestId);
      if (stale && stale.status !== 'pending') {
        return fail(res, 409, `This request has already been ${stale.status}.`);
      }
      return fail(res, 409, 'Your last free mentorship place was taken while you were responding.');
    }

    return res.status(200).json({
      success: true,
      message:
        decision === 'accepted'
          ? 'Accepted. The student can now see your contact details.'
          : 'Declined, and the student has been given your reason.',
      data: updated.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to respond to the mentorship request');
  }
};

/**
 * PATCH /api/alumni/profiles/:id/mentorship/:requestId/complete
 *
 * Returns the seat. Guarded on the request still being `accepted` so a
 * double-tap cannot decrement the counter twice and leave the alumnus looking
 * free when they are not.
 */
exports.completeMentorship = async (req, res) => {
  try {
    const { id, requestId } = req.params;
    if (!isValidId(id) || !isValidId(requestId)) {
      return fail(res, 400, 'Invalid profile or request id.');
    }

    const profile = await AlumniProfile.findById(id);
    if (!profile) return fail(res, 404, 'Alumni profile not found.');

    const request = profile.mentorships.id(requestId);
    if (!request) return fail(res, 404, 'Mentorship request not found.');

    const isMentor = profile.isOwnedBy(req.user);
    const isMentee = String(request.student) === String(req.user._id);

    if (!isMentor && !isMentee && req.user.role !== 'admin') {
      return fail(res, 403, 'Only the mentor or the mentee can close a mentorship.');
    }
    if (request.status !== 'accepted') {
      return fail(res, 409, `This mentorship is ${request.status}; there is nothing to complete.`);
    }

    const updated = await AlumniProfile.findOneAndUpdate(
      {
        _id: profile._id,
        mentorships: { $elemMatch: { _id: request._id, status: 'accepted' } },
      },
      {
        $set: {
          'mentorships.$[entry].status': 'completed',
          'mentorships.$[entry].completedAt': new Date(),
          'mentorships.$[entry].outcomeNote': req.body.outcomeNote
            ? String(req.body.outcomeNote).trim()
            : '',
        },
        $inc: { activeMenteeCount: -1 },
      },
      {
        new: true,
        arrayFilters: [{ 'entry._id': request._id, 'entry.status': 'accepted' }],
      }
    );

    if (!updated) return fail(res, 409, 'This mentorship was already closed.');

    return res.status(200).json({
      success: true,
      message: 'Mentorship marked complete. The place is free again.',
      data: updated.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to complete the mentorship');
  }
};

/**
 * PATCH /api/alumni/profiles/:id/mentorship/:requestId/withdraw
 * The student changing their mind, before anyone has spent time on it.
 */
exports.withdrawRequest = async (req, res) => {
  try {
    const { id, requestId } = req.params;
    if (!isValidId(id) || !isValidId(requestId)) {
      return fail(res, 400, 'Invalid profile or request id.');
    }

    const profile = await AlumniProfile.findById(id);
    if (!profile) return fail(res, 404, 'Alumni profile not found.');

    const request = profile.mentorships.id(requestId);
    if (!request) return fail(res, 404, 'Mentorship request not found.');
    if (String(request.student) !== String(req.user._id)) {
      return fail(res, 403, 'You can only withdraw your own request.');
    }
    if (request.status !== 'pending') {
      return fail(res, 409, `This request is ${request.status} and can no longer be withdrawn.`);
    }

    const updated = await AlumniProfile.findOneAndUpdate(
      {
        _id: profile._id,
        mentorships: { $elemMatch: { _id: request._id, status: 'pending' } },
      },
      {
        $set: {
          'mentorships.$[entry].status': 'withdrawn',
          'mentorships.$[entry].respondedAt': new Date(),
        },
      },
      {
        new: true,
        arrayFilters: [{ 'entry._id': request._id, 'entry.status': 'pending' }],
      }
    );

    if (!updated) return fail(res, 409, 'That request was answered while you were withdrawing it.');

    return res.status(200).json({
      success: true,
      message: 'Request withdrawn.',
      data: updated.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to withdraw the request');
  }
};

/**
 * GET /api/alumni/my-requests
 * Flattened so a student sees a list of requests rather than a list of profiles
 * they have to dig through.
 */
exports.getMyRequests = async (req, res) => {
  try {
    const profiles = await AlumniProfile.find({ 'mentorships.student': req.user._id }).sort({
      updatedAt: -1,
    });

    const requests = [];
    profiles.forEach((profile) => {
      const view = profile.redactFor(req.user);
      profile.mentorships
        .filter((request) => String(request.student) === String(req.user._id))
        .forEach((request) => {
          requests.push({
            ...request.toObject(),
            profileId: profile._id,
            mentorName: profile.fullName,
            mentorRole: profile.currentRole,
            mentorOrganisation: profile.organisation,
            graduationYear: profile.graduationYear,
            // Only populated once the request was accepted — `redactFor` is the
            // single place that decides this.
            contactEmail: view.contactEmail || null,
            linkedinUrl: view.linkedinUrl || null,
          });
        });
    });

    return res.status(200).json({ success: true, count: requests.length, data: requests });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch your mentorship requests');
  }
};

/**
 * GET /api/alumni/stats
 */
exports.getStats = async (req, res) => {
  try {
    const profiles = await AlumniProfile.find({}).select(
      'verificationStatus willingToMentor mentorCapacity activeMenteeCount graduationYear mentorships'
    );

    const stats = {
      totalProfiles: profiles.length,
      verified: 0,
      pending: 0,
      rejected: 0,
      mentorsAvailable: 0,
      seatsOffered: 0,
      seatsTaken: 0,
      requestsPending: 0,
      requestsAccepted: 0,
      requestsDeclined: 0,
      requestsCompleted: 0,
    };

    const byYear = {};

    profiles.forEach((profile) => {
      if (profile.verificationStatus === 'verified') stats.verified += 1;
      if (profile.verificationStatus === 'pending') stats.pending += 1;
      if (profile.verificationStatus === 'rejected') stats.rejected += 1;

      if (profile.verificationStatus === 'verified' && profile.willingToMentor) {
        stats.mentorsAvailable += 1;
        stats.seatsOffered += profile.mentorCapacity;
        stats.seatsTaken += profile.activeMenteeCount;
      }

      byYear[profile.graduationYear] = (byYear[profile.graduationYear] || 0) + 1;

      profile.mentorships.forEach((request) => {
        if (request.status === 'pending') stats.requestsPending += 1;
        if (request.status === 'accepted') stats.requestsAccepted += 1;
        if (request.status === 'declined') stats.requestsDeclined += 1;
        if (request.status === 'completed') stats.requestsCompleted += 1;
      });
    });

    stats.utilisation =
      stats.seatsOffered > 0 ? Math.round((stats.seatsTaken / stats.seatsOffered) * 100) : 0;

    // Only the answered requests count towards an acceptance rate — pending
    // ones have not been declined, they have not been decided.
    const answered = stats.requestsAccepted + stats.requestsDeclined + stats.requestsCompleted;
    stats.acceptanceRate =
      answered > 0
        ? Math.round(((stats.requestsAccepted + stats.requestsCompleted) / answered) * 100)
        : null;

    stats.byGraduationYear = Object.entries(byYear)
      .map(([year, count]) => ({ year: Number(year), count }))
      .sort((a, b) => b.year - a.year);

    return res.status(200).json({ success: true, stats });
  } catch (error) {
    return serverError(res, error, 'Failed to compute alumni statistics');
  }
};
