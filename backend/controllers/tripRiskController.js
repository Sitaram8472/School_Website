// backend/controllers/tripRiskController.js
const mongoose = require('mongoose');
const FieldTrip = require('../models/FieldTrip');
const TripRiskAssessment = require('../models/TripRiskAssessment');

/**
 * Risk assessments for field trips.
 *
 * The question this module answers is "can this trip open?", and it answers it
 * as a list of reasons rather than as a boolean. A trip lead discovering the
 * blockers one rejection at a time is how the assessment ends up being written
 * at seven in the morning on the day of departure.
 *
 * Nothing here is derived once and stored. The escort requirement, the number
 * of guardians who refused first-aid consent, and whether the assessment still
 * covers the group are all recomputed against the live trip on every read,
 * because the trip is exactly the thing that moves after the plan is written.
 */

const handleError = (res, err, message = 'Server error') => {
  console.error('[trip-risk]', err);
  return res.status(500).json({ success: false, message, error: err.message });
};

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const getPagination = (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
};

const isAdmin = (user) => user && user.role === 'admin';

const canWrite = (trip, user) =>
  isAdmin(user) || (trip && String(trip.organiser) === String(user._id));

/**
 * Guardians who consented to the trip and refused permission for first aid.
 *
 * `FieldTrip` collects this and then nothing reads it. The escort needs to know
 * before the coach leaves, not after somebody falls over.
 */
const refusedMedicalConsent = (trip) =>
  trip
    .activeParticipants()
    .filter(
      (participant) => participant.consent && participant.consent.medicalTreatmentConsent === false
    )
    .map((participant) => ({
      studentName: participant.studentName,
      className: participant.className,
      guardianName: participant.guardianName,
      emergencyContactNumber: participant.emergencyContactNumber,
    }));

const publicAssessment = (assessment, trip) => {
  const currency = trip ? assessment.currencyAgainst(trip) : null;

  return {
    _id: assessment._id,
    trip: assessment.trip,
    tripTitle: assessment.tripTitle,
    destination: assessment.destination,
    departureDate: assessment.departureDate,
    version: assessment.version,
    supersedes: assessment.supersedes,
    activityCategory: assessment.activityCategory,
    ageBand: assessment.ageBand,
    assessedHeadcount: assessment.assessedHeadcount,
    assessedEscortCount: assessment.assessedEscortCount,
    requiredEscorts: assessment.requiredEscorts,
    escortShortfall: assessment.escortShortfall,
    firstAiders: assessment.firstAiders,
    noMedicalConsentCount: assessment.noMedicalConsentCount,
    hazards: assessment.hazards,
    emergencyPlan: assessment.emergencyPlan,
    status: assessment.status,
    assessedBy: assessment.assessedBy,
    assessedByName: assessment.assessedByName,
    assessedAt: assessment.assessedAt,
    submittedAt: assessment.submittedAt,
    approvedBy: assessment.approvedBy,
    approvedByName: assessment.approvedByName,
    approvedAt: assessment.approvedAt,
    approvalNote: assessment.approvalNote,
    rejectionReason: assessment.rejectionReason,
    // Computed, both of them, on every read.
    submissionBlockers: assessment.submissionBlockers(),
    currency,
    residualTolerance:
      TripRiskAssessment.RESIDUAL_TOLERANCE[assessment.activityCategory] || 8,
    history: assessment.history,
    createdAt: assessment.createdAt,
  };
};

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

exports.getRiskMeta = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        statuses: TripRiskAssessment.ASSESSMENT_STATUSES,
        activityCategories: TripRiskAssessment.ACTIVITY_CATEGORIES,
        ageBands: TripRiskAssessment.AGE_BANDS,
        supervisionRatios: TripRiskAssessment.SUPERVISION_RATIOS,
        residualTolerance: TripRiskAssessment.RESIDUAL_TOLERANCE,
        hazardLibrary: TripRiskAssessment.HAZARD_LIBRARY,
        highAssuranceCategories: TripRiskAssessment.HIGH_ASSURANCE_CATEGORIES,
        minimumEscorts: TripRiskAssessment.MINIMUM_ESCORTS,
        minHeadcountPoints: TripRiskAssessment.MIN_HEADCOUNT_POINTS,
        ratingMax: TripRiskAssessment.RATING_MAX,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not load risk reference data');
  }
};

// ---------------------------------------------------------------------------
// Writing an assessment
// ---------------------------------------------------------------------------

exports.createAssessment = async (req, res) => {
  try {
    const { tripId } = req.params;
    if (!isValidId(tripId)) {
      return res.status(400).json({ success: false, message: 'Invalid trip id' });
    }

    const trip = await FieldTrip.findById(tripId);
    if (!trip) {
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }

    if (!canWrite(trip, req.user)) {
      return res
        .status(403)
        .json({ success: false, message: 'Only the organiser or an admin may assess this trip' });
    }

    const existingOpen = await TripRiskAssessment.findOne({ trip: trip._id, isOpen: true });
    if (existingOpen) {
      return res.status(409).json({
        success: false,
        message: `This trip already has a version ${existingOpen.version} assessment in ${existingOpen.status}`,
      });
    }

    const previous = await TripRiskAssessment.findOne({ trip: trip._id }).sort({ version: -1 });

    const {
      activityCategory = 'standard',
      ageBand,
      hazards = [],
      firstAiders = [],
      emergencyPlan = {},
    } = req.body;

    const refused = refusedMedicalConsent(trip);

    const assessment = new TripRiskAssessment({
      trip: trip._id,
      tripTitle: trip.title,
      destination: trip.destination,
      departureDate: trip.departureDate,
      version: previous ? previous.version + 1 : 1,
      supersedes: previous ? previous._id : null,
      activityCategory,
      ageBand,
      // Stamped from the trip, not from the body. An organiser who could type
      // the headcount could type a smaller one.
      assessedHeadcount: trip.confirmedCount || 0,
      assessedEscortCount: (trip.staffEscorts || []).length,
      noMedicalConsentCount: refused.length,
      hazards,
      firstAiders,
      emergencyPlan,
      status: 'draft',
      assessedBy: req.user._id,
      assessedByName: req.user.name || '',
    });

    assessment.log('drafted', req.user, `version ${assessment.version}`);

    try {
      await assessment.save();
    } catch (saveErr) {
      if (saveErr.code === 11000) {
        return res
          .status(409)
          .json({ success: false, message: 'This trip already has an assessment in progress' });
      }
      if (saveErr.name === 'ValidationError') {
        return res.status(400).json({ success: false, message: saveErr.message });
      }
      throw saveErr;
    }

    if (previous && previous.status === 'approved') {
      previous.markSuperseded(req.user);
      await previous.save();
    }

    return res.status(201).json({
      success: true,
      message: `Assessment version ${assessment.version} drafted`,
      data: publicAssessment(assessment, trip),
    });
  } catch (err) {
    return handleError(res, err, 'Could not create the assessment');
  }
};

exports.updateAssessment = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid assessment id' });
    }

    const assessment = await TripRiskAssessment.findById(id);
    if (!assessment) {
      return res.status(404).json({ success: false, message: 'Assessment not found' });
    }

    if (assessment.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: `Only a draft assessment can be edited; this one is ${assessment.status}. Create a new version instead.`,
      });
    }

    const trip = await FieldTrip.findById(assessment.trip);

    if (!isAdmin(req.user) && String(assessment.assessedBy) !== String(req.user._id)) {
      return res
        .status(403)
        .json({ success: false, message: 'Only the assessor or an admin may edit this' });
    }

    const editable = ['activityCategory', 'ageBand', 'hazards', 'firstAiders', 'emergencyPlan'];
    editable.forEach((field) => {
      if (req.body[field] !== undefined) assessment[field] = req.body[field];
    });

    // Re-stamp from the trip, so an edit picks up children who registered since
    // the draft was started rather than freezing a stale headcount.
    if (trip) {
      assessment.assessedHeadcount = trip.confirmedCount || 0;
      assessment.assessedEscortCount = (trip.staffEscorts || []).length;
      assessment.noMedicalConsentCount = refusedMedicalConsent(trip).length;
    }

    assessment.log('edited', req.user);

    try {
      await assessment.save();
    } catch (saveErr) {
      if (saveErr.name === 'ValidationError') {
        return res.status(400).json({ success: false, message: saveErr.message });
      }
      throw saveErr;
    }

    return res.status(200).json({
      success: true,
      message: 'Assessment updated',
      data: publicAssessment(assessment, trip),
    });
  } catch (err) {
    return handleError(res, err, 'Could not update the assessment');
  }
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

exports.getAssessmentForTrip = async (req, res) => {
  try {
    const { tripId } = req.params;
    if (!isValidId(tripId)) {
      return res.status(400).json({ success: false, message: 'Invalid trip id' });
    }

    const trip = await FieldTrip.findById(tripId);
    if (!trip) {
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }

    // The live one if there is one; otherwise the most recent approved version,
    // because "the trip has no open assessment" and "the trip has never been
    // assessed" are different answers.
    const assessment =
      (await TripRiskAssessment.findOne({ trip: trip._id, isOpen: true })) ||
      (await TripRiskAssessment.findOne({ trip: trip._id }).sort({ version: -1 }));

    if (!assessment) {
      return res.status(200).json({ success: true, data: null });
    }

    return res.status(200).json({
      success: true,
      data: publicAssessment(assessment, trip),
    });
  } catch (err) {
    return handleError(res, err, 'Could not load the assessment');
  }
};

exports.getAssessmentHistory = async (req, res) => {
  try {
    const { tripId } = req.params;
    if (!isValidId(tripId)) {
      return res.status(400).json({ success: false, message: 'Invalid trip id' });
    }

    const versions = await TripRiskAssessment.find({ trip: tripId }).sort({ version: -1 });

    return res.status(200).json({
      success: true,
      count: versions.length,
      data: versions.map((version) => ({
        _id: version._id,
        version: version.version,
        status: version.status,
        assessedByName: version.assessedByName,
        assessedAt: version.assessedAt,
        approvedByName: version.approvedByName,
        approvedAt: version.approvedAt,
        assessedHeadcount: version.assessedHeadcount,
        hazardCount: version.hazards.length,
      })),
    });
  } catch (err) {
    return handleError(res, err, 'Could not load assessment history');
  }
};

exports.getAssessment = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid assessment id' });
    }

    const assessment = await TripRiskAssessment.findById(id);
    if (!assessment) {
      return res.status(404).json({ success: false, message: 'Assessment not found' });
    }

    const trip = await FieldTrip.findById(assessment.trip);

    return res.status(200).json({
      success: true,
      data: publicAssessment(assessment, trip),
    });
  } catch (err) {
    return handleError(res, err, 'Could not load the assessment');
  }
};

/**
 * Can this trip open?
 *
 * Every reason it cannot, in one list, with the two numbers that produced each
 * one. This is the endpoint the panel leads with.
 */
exports.getReadiness = async (req, res) => {
  try {
    const { tripId } = req.params;
    if (!isValidId(tripId)) {
      return res.status(400).json({ success: false, message: 'Invalid trip id' });
    }

    const trip = await FieldTrip.findById(tripId);
    if (!trip) {
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }

    const approved = await TripRiskAssessment.findOne({
      trip: trip._id,
      status: 'approved',
    }).sort({ version: -1 });

    const open = await TripRiskAssessment.findOne({ trip: trip._id, isOpen: true });
    const refused = refusedMedicalConsent(trip);
    const blockers = [];

    if (!approved) {
      blockers.push(
        open
          ? `The assessment is still in ${open.status} and has not been approved.`
          : 'This trip has no risk assessment.'
      );
    }

    let currency = null;
    if (approved) {
      currency = approved.currencyAgainst(trip);
      currency.reasons.forEach((reason) => blockers.push(reason));

      // A first aider who is not going is the most obvious way a plan on paper
      // fails on the day.
      const escortIds = new Set(
        (trip.staffEscorts || []).map((escort) => String(escort.staff)).filter(Boolean)
      );
      escortIds.add(String(trip.organiser));

      const absent = approved.firstAiders.filter(
        (aider) => aider.staff && !escortIds.has(String(aider.staff))
      );

      absent.forEach((aider) => {
        blockers.push(`${aider.name || 'A named first aider'} is not on this trip's escort list.`);
      });
    }

    const { required, perAdult } = TripRiskAssessment.requiredEscortsFor(
      trip.confirmedCount || 0,
      approved ? approved.ageBand : 'mixed',
      approved ? approved.activityCategory : 'standard'
    );

    return res.status(200).json({
      success: true,
      data: {
        trip: {
          _id: trip._id,
          title: trip.title,
          destination: trip.destination,
          departureDate: trip.departureDate,
          status: trip.status,
          confirmedCount: trip.confirmedCount,
          escortCount: (trip.staffEscorts || []).length,
        },
        ready: blockers.length === 0,
        blockers,
        approvedVersion: approved ? approved.version : null,
        approvedAt: approved ? approved.approvedAt : null,
        currency,
        supervision: {
          childrenPerAdult: perAdult,
          required,
          named: (trip.staffEscorts || []).length,
          shortfall: Math.max(0, required - (trip.staffEscorts || []).length),
        },
        // The field the model already collects and nothing reads.
        refusedMedicalConsent: refused,
      },
    });
  } catch (err) {
    return handleError(res, err, 'Could not work out readiness');
  }
};

/**
 * Trips that are open or about to be, with no approved assessment covering
 * them. The report this module exists to make possible.
 */
exports.getOutstanding = async (req, res) => {
  try {
    const trips = await FieldTrip.find({ status: { $in: ['draft', 'open'] } }).sort({
      departureDate: 1,
    });

    const approved = await TripRiskAssessment.find({
      trip: { $in: trips.map((trip) => trip._id) },
      status: 'approved',
    });

    const byTrip = new Map(approved.map((row) => [String(row.trip), row]));
    const rows = [];

    trips.forEach((trip) => {
      const assessment = byTrip.get(String(trip._id));
      const currency = assessment ? assessment.currencyAgainst(trip) : null;

      if (!assessment || !currency.isCurrent) {
        rows.push({
          trip: trip._id,
          title: trip.title,
          destination: trip.destination,
          departureDate: trip.departureDate,
          status: trip.status,
          confirmedCount: trip.confirmedCount,
          escortCount: (trip.staffEscorts || []).length,
          organiserName: trip.organiserName,
          assessmentVersion: assessment ? assessment.version : null,
          reason: assessment ? currency.reasons.join(' ') : 'No approved assessment',
        });
      }
    });

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (err) {
    return handleError(res, err, 'Could not build the outstanding list');
  }
};

exports.getQueue = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = { status: 'submitted' };

    const [assessments, total] = await Promise.all([
      TripRiskAssessment.find(filter).sort({ submittedAt: 1 }).skip(skip).limit(limit),
      TripRiskAssessment.countDocuments(filter),
    ]);

    const trips = await FieldTrip.find({ _id: { $in: assessments.map((row) => row.trip) } });
    const byId = new Map(trips.map((trip) => [String(trip._id), trip]));

    return res.status(200).json({
      success: true,
      count: assessments.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      data: assessments.map((assessment) =>
        publicAssessment(assessment, byId.get(String(assessment.trip)))
      ),
    });
  } catch (err) {
    return handleError(res, err, 'Could not load the approval queue');
  }
};

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

exports.submitAssessment = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid assessment id' });
    }

    const assessment = await TripRiskAssessment.findById(id);
    if (!assessment) {
      return res.status(404).json({ success: false, message: 'Assessment not found' });
    }

    if (!isAdmin(req.user) && String(assessment.assessedBy) !== String(req.user._id)) {
      return res
        .status(403)
        .json({ success: false, message: 'Only the assessor or an admin may submit this' });
    }

    try {
      assessment.submit(req.user);
    } catch (stateErr) {
      return res.status(400).json({
        success: false,
        message: stateErr.message,
        blockers: stateErr.blockers || [],
      });
    }

    await assessment.save();
    const trip = await FieldTrip.findById(assessment.trip);

    return res.status(200).json({
      success: true,
      message: 'Assessment submitted for approval',
      data: publicAssessment(assessment, trip),
    });
  } catch (err) {
    return handleError(res, err, 'Could not submit the assessment');
  }
};

/**
 * Approval, by somebody who is not going.
 *
 * An admin may approve anything. A teacher may approve only a trip they are not
 * escorting — being on the coach is not a review, and the person organising a
 * trip is the worst-placed person to judge whether it is safe.
 */
exports.approveAssessment = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid assessment id' });
    }

    const assessment = await TripRiskAssessment.findById(id);
    if (!assessment) {
      return res.status(404).json({ success: false, message: 'Assessment not found' });
    }

    const trip = await FieldTrip.findById(assessment.trip);

    if (!isAdmin(req.user)) {
      if (!trip) {
        return res
          .status(409)
          .json({ success: false, message: 'The trip this assessment covers no longer exists' });
      }
      if (trip.isEscort(req.user._id)) {
        return res.status(403).json({
          success: false,
          message: 'You are escorting this trip, so you cannot approve its assessment',
        });
      }
    }

    if (String(assessment.assessedBy) === String(req.user._id)) {
      return res.status(403).json({
        success: false,
        message: 'An assessment cannot be approved by the person who wrote it',
      });
    }

    // Re-check against the trip as it stands now, not as it stood when the
    // assessment was submitted. Children may have registered in between.
    if (trip) {
      const currency = assessment.currencyAgainst(trip);
      const liveHeadcount = trip.confirmedCount || 0;

      if (liveHeadcount > assessment.assessedHeadcount) {
        return res.status(409).json({
          success: false,
          message:
            `This assessment was written for ${assessment.assessedHeadcount} children and ` +
            `${liveHeadcount} are now registered. It needs revising before approval.`,
          data: { reasons: currency.reasons },
        });
      }
    }

    try {
      assessment.approve(req.user, req.body.note);
    } catch (stateErr) {
      return res.status(400).json({ success: false, message: stateErr.message });
    }

    await assessment.save();

    return res.status(200).json({
      success: true,
      message: `Assessment version ${assessment.version} approved`,
      data: publicAssessment(assessment, trip),
    });
  } catch (err) {
    return handleError(res, err, 'Could not approve the assessment');
  }
};

exports.rejectAssessment = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid assessment id' });
    }

    const assessment = await TripRiskAssessment.findById(id);
    if (!assessment) {
      return res.status(404).json({ success: false, message: 'Assessment not found' });
    }

    if (String(assessment.assessedBy) === String(req.user._id)) {
      return res.status(403).json({
        success: false,
        message: 'An assessment cannot be rejected by the person who wrote it',
      });
    }

    const trip = await FieldTrip.findById(assessment.trip);

    if (!isAdmin(req.user) && trip && trip.isEscort(req.user._id)) {
      return res.status(403).json({
        success: false,
        message: 'You are escorting this trip, so you cannot review its assessment',
      });
    }

    try {
      assessment.reject(req.user, req.body.reason);
    } catch (stateErr) {
      return res.status(400).json({ success: false, message: stateErr.message });
    }

    await assessment.save();

    return res.status(200).json({
      success: true,
      message: 'Assessment sent back for revision',
      data: publicAssessment(assessment, trip),
    });
  } catch (err) {
    return handleError(res, err, 'Could not reject the assessment');
  }
};

exports.withdrawAssessment = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid assessment id' });
    }

    const assessment = await TripRiskAssessment.findById(id);
    if (!assessment) {
      return res.status(404).json({ success: false, message: 'Assessment not found' });
    }

    if (!isAdmin(req.user) && String(assessment.assessedBy) !== String(req.user._id)) {
      return res
        .status(403)
        .json({ success: false, message: 'Only the assessor or an admin may withdraw this' });
    }

    try {
      assessment.withdraw(req.user, req.body.reason);
    } catch (stateErr) {
      return res.status(400).json({ success: false, message: stateErr.message });
    }

    await assessment.save();
    const trip = await FieldTrip.findById(assessment.trip);

    return res.status(200).json({
      success: true,
      message: 'Assessment withdrawn',
      data: publicAssessment(assessment, trip),
    });
  } catch (err) {
    return handleError(res, err, 'Could not withdraw the assessment');
  }
};
