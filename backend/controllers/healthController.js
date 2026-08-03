const mongoose = require('mongoose');

const HealthProfile = require('../models/HealthProfile');
const InfirmaryVisit = require('../models/InfirmaryVisit');
const User = require('../models/User');

// Medical data is the most sensitive thing this application holds, so the
// access rule is deliberately blunt: the owning student, or the office. There
// is no "any authenticated user" read path anywhere in this module.
const MEDICAL_STAFF_ROLES = ['admin', 'staff'];

const fail = (res, error, fallbackStatus = 400) => {
  if (error && error.name === 'ValidationError') {
    const messages = Object.values(error.errors).map((e) => e.message);
    return res.status(400).json({ success: false, message: messages.join(', ') });
  }

  if (error && error.code === 11000) {
    return res.status(409).json({
      success: false,
      message: 'A health profile already exists for that student',
    });
  }

  if (error && error.userFacing) {
    return res
      .status(error.statusCode || fallbackStatus)
      .json({ success: false, message: error.message });
  }

  console.error('[Health]', error);
  return res.status(500).json({ success: false, message: 'Something went wrong on our side' });
};

const makeError = (message, statusCode) => {
  const error = new Error(message);
  error.userFacing = true;
  error.statusCode = statusCode;
  return error;
};

const badRequest = (message) => makeError(message, 400);
const forbidden = (message) => makeError(message, 403);
const notFound = (message) => makeError(message, 404);

const isMedicalStaff = (user) => MEDICAL_STAFF_ROLES.includes(user?.role);

const assertObjectId = (value, label = 'id') => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw badRequest(`Invalid ${label}`);
  }
  return value;
};

/**
 * The single gate every read of another person's medical data passes through.
 * Keeping it in one function means a new endpoint cannot accidentally ship
 * without the check.
 */
const assertMayAccess = (req, studentId) => {
  const requesterId = String(req.user.id || req.user._id);

  if (isMedicalStaff(req.user)) return;
  if (requesterId === String(studentId)) return;

  throw forbidden('You can only view your own health record');
};

// Fields a client may write to a profile. `student`, `updatedBy` and the
// timestamps are set by the server.
const PROFILE_FIELDS = [
  'studentName',
  'className',
  'bloodGroup',
  'dateOfBirth',
  'heightCm',
  'weightKg',
  'allergies',
  'chronicConditions',
  'vaccinations',
  'emergencyContacts',
  'physician',
  'insurancePolicyNumber',
  'dietaryRestrictions',
  'notes',
];

// ---------------------------------------------------------------------------
// Health profile
// ---------------------------------------------------------------------------

/**
 * Creates or updates the profile in one call. An upsert rather than separate
 * create/update endpoints because the office thinks of it as "the student's
 * health card" — one thing that either exists or does not.
 */
exports.upsertHealthProfile = async (req, res) => {
  try {
    const studentId = req.body.studentId || req.user.id || req.user._id;
    assertObjectId(studentId, 'student id');
    assertMayAccess(req, studentId);

    const student = await User.findById(studentId).select('name role');
    if (!student) throw notFound('Student not found');

    let profile = await HealthProfile.findOne({ student: studentId });

    if (!profile) {
      profile = new HealthProfile({ student: studentId, studentName: student.name });
    }

    PROFILE_FIELDS.forEach((field) => {
      if (req.body[field] !== undefined) {
        profile[field] = req.body[field];
      }
    });

    profile.studentName = profile.studentName || student.name;
    profile.updatedBy = req.user.id || req.user._id;

    await profile.save();

    return res.status(200).json({ success: true, data: profile });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getMyHealthProfile = async (req, res) => {
  try {
    const studentId = req.user.id || req.user._id;

    const profile = await HealthProfile.findOne({ student: studentId });

    const visits = await InfirmaryVisit.find({ student: studentId })
      .sort({ visitedAt: -1 })
      .limit(30)
      .populate('attendedBy', 'name');

    if (!profile) {
      return res.status(200).json({
        success: true,
        hasProfile: false,
        message: 'No health profile has been created for you yet',
        data: null,
        visits,
      });
    }

    return res.status(200).json({
      success: true,
      hasProfile: true,
      data: profile,
      visits,
      overdueVaccinations: profile.overdueVaccinations(),
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getStudentHealthProfile = async (req, res) => {
  try {
    assertObjectId(req.params.studentId, 'student id');
    assertMayAccess(req, req.params.studentId);

    const profile = await HealthProfile.findOne({ student: req.params.studentId }).populate(
      'updatedBy',
      'name'
    );

    if (!profile) throw notFound('No health profile exists for that student');

    const visits = await InfirmaryVisit.find({ student: req.params.studentId })
      .sort({ visitedAt: -1 })
      .limit(30);

    return res.status(200).json({
      success: true,
      data: profile,
      visits,
      criticalAlerts: profile.criticalAlerts,
      overdueVaccinations: profile.overdueVaccinations(),
    });
  } catch (error) {
    return fail(res, error);
  }
};

/**
 * Deliberately thin: the name, the alerts and the primary contact. This is what
 * the nurse needs on screen before treating a student, and nothing more.
 */
exports.getCriticalAlerts = async (req, res) => {
  try {
    assertObjectId(req.params.studentId, 'student id');

    const profile = await HealthProfile.findOne({ student: req.params.studentId });
    if (!profile) {
      return res.status(200).json({
        success: true,
        hasProfile: false,
        data: { alerts: [], bloodGroup: 'unknown', primaryContact: null },
      });
    }

    return res.status(200).json({
      success: true,
      hasProfile: true,
      data: {
        studentName: profile.studentName,
        bloodGroup: profile.bloodGroup,
        alerts: profile.criticalAlerts,
        primaryContact: profile.primaryContact,
        physician: profile.physician,
        dietaryRestrictions: profile.dietaryRestrictions,
      },
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.listHealthProfiles = async (req, res) => {
  try {
    const { className, bloodGroup, severeOnly, search, limit = 100, page = 1 } = req.query;

    const filter = {};
    if (className) filter.className = className;
    if (bloodGroup) filter.bloodGroup = bloodGroup;
    if (severeOnly === 'true') filter['allergies.severity'] = 'severe';
    if (search) filter.studentName = new RegExp(String(search).trim(), 'i');

    const perPage = Math.min(Number(limit) || 100, 200);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * perPage;

    const profiles = await HealthProfile.find(filter)
      .sort({ studentName: 1 })
      .skip(skip)
      .limit(perPage);

    const total = await HealthProfile.countDocuments(filter);

    return res.status(200).json({
      success: true,
      count: profiles.length,
      total,
      data: profiles,
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ---------------------------------------------------------------------------
// Infirmary visits
// ---------------------------------------------------------------------------

exports.recordVisit = async (req, res) => {
  try {
    const {
      studentId,
      visitedAt,
      complaint,
      symptoms,
      temperatureCelsius,
      bloodPressure,
      pulseBpm,
      treatmentGiven,
      medicationsAdministered,
      outcome,
      restDurationMinutes,
      parentNotified,
      notifiedVia,
      followUpRequired,
      followUpOn,
      notes,
      className,
    } = req.body;

    assertObjectId(studentId, 'student id');

    const student = await User.findById(studentId).select('name role');
    if (!student) throw notFound('Student not found');

    const visit = new InfirmaryVisit({
      student: studentId,
      studentName: student.name,
      className: className || '',
      visitedAt: visitedAt || new Date(),
      complaint,
      symptoms,
      temperatureCelsius,
      // An empty string would fail the format match; undefined leaves it unset.
      bloodPressure: bloodPressure || undefined,
      pulseBpm,
      treatmentGiven,
      medicationsAdministered,
      outcome,
      restDurationMinutes,
      parentNotified: Boolean(parentNotified),
      notifiedVia,
      followUpRequired: Boolean(followUpRequired),
      followUpOn,
      notes,
      // Taken from the token, never the body — an entry that says who treated
      // the child is only worth anything if the child's own request cannot set
      // it.
      attendedBy: req.user.id || req.user._id,
      attendedByName: req.user.name || '',
    });

    await visit.save();

    return res.status(201).json({ success: true, data: visit });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getVisits = async (req, res) => {
  try {
    const { from, to, outcome, followUpDue, search, limit = 100, page = 1 } = req.query;

    const filter = {};

    if (outcome) filter.outcome = outcome;
    if (search) filter.studentName = new RegExp(String(search).trim(), 'i');

    if (from || to) {
      filter.visitedAt = {};
      if (from) filter.visitedAt.$gte = new Date(from);
      if (to) filter.visitedAt.$lte = new Date(to);
    }

    if (followUpDue === 'true') {
      filter.followUpRequired = true;
      filter.followUpCompleted = false;
      filter.followUpOn = { $lte: new Date() };
    }

    const perPage = Math.min(Number(limit) || 100, 200);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * perPage;

    const visits = await InfirmaryVisit.find(filter)
      .sort({ visitedAt: -1 })
      .skip(skip)
      .limit(perPage)
      .populate('attendedBy', 'name');

    const total = await InfirmaryVisit.countDocuments(filter);

    return res.status(200).json({
      success: true,
      count: visits.length,
      total,
      data: visits,
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getStudentVisits = async (req, res) => {
  try {
    assertObjectId(req.params.studentId, 'student id');
    assertMayAccess(req, req.params.studentId);

    const visits = await InfirmaryVisit.find({ student: req.params.studentId })
      .sort({ visitedAt: -1 })
      .populate('attendedBy', 'name');

    // A pattern of repeat visits is the thing a paper register hides, so it is
    // computed here rather than left for someone to notice.
    const byComplaint = new Map();
    visits.forEach((visit) => {
      const key = visit.complaint.trim().toLowerCase();
      byComplaint.set(key, (byComplaint.get(key) || 0) + 1);
    });

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    return res.status(200).json({
      success: true,
      count: visits.length,
      data: visits,
      summary: {
        totalVisits: visits.length,
        visitsLast30Days: visits.filter((v) => v.visitedAt >= thirtyDaysAgo).length,
        sentHome: visits.filter((v) => v.outcome === 'sent-home').length,
        referred: visits.filter((v) => v.outcome === 'referred-to-hospital').length,
        repeatComplaints: [...byComplaint.entries()]
          .filter(([, count]) => count > 1)
          .map(([complaint, count]) => ({ complaint, count }))
          .sort((a, b) => b.count - a.count),
      },
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.markParentNotified = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'visit id');

    const visit = await InfirmaryVisit.findById(req.params.id);
    if (!visit) throw notFound('Visit not found');

    visit.markParentNotified(req.body.via || 'phone');
    await visit.save();

    return res.status(200).json({ success: true, data: visit });
  } catch (error) {
    return fail(res, error);
  }
};

exports.completeFollowUp = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'visit id');

    const visit = await InfirmaryVisit.findById(req.params.id);
    if (!visit) throw notFound('Visit not found');

    if (!visit.followUpRequired) {
      throw badRequest('That visit does not have a follow-up recorded');
    }

    visit.followUpCompleted = true;
    if (req.body.notes) {
      visit.notes = `${visit.notes ? `${visit.notes}\n` : ''}Follow-up: ${req.body.notes}`;
    }

    await visit.save();

    return res.status(200).json({ success: true, data: visit });
  } catch (error) {
    return fail(res, error);
  }
};

/**
 * Dashboard numbers for the infirmary. Visits are append-only, so these counts
 * are a faithful record rather than a snapshot someone can tidy up.
 */
exports.getInfirmarySummary = async (req, res) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [todayVisits, weekVisits, followUps, severeProfiles, totalProfiles] = await Promise.all([
      InfirmaryVisit.find({ visitedAt: { $gte: startOfToday } }).sort({ visitedAt: -1 }),
      InfirmaryVisit.find({ visitedAt: { $gte: sevenDaysAgo } }),
      InfirmaryVisit.find({
        followUpRequired: true,
        followUpCompleted: false,
      })
        .sort({ followUpOn: 1 })
        .limit(25),
      HealthProfile.find({ 'allergies.severity': 'severe' }).select('studentName className allergies'),
      HealthProfile.countDocuments({}),
    ]);

    const complaintCounts = new Map();
    weekVisits.forEach((visit) => {
      const key = visit.complaint.trim().toLowerCase();
      complaintCounts.set(key, (complaintCounts.get(key) || 0) + 1);
    });

    const topComplaints = [...complaintCounts.entries()]
      .map(([complaint, count]) => ({ complaint, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return res.status(200).json({
      success: true,
      data: {
        visitsToday: todayVisits.length,
        visitsThisWeek: weekVisits.length,
        sentHomeThisWeek: weekVisits.filter((v) => v.outcome === 'sent-home').length,
        referredThisWeek: weekVisits.filter((v) => v.outcome === 'referred-to-hospital').length,
        openFollowUps: followUps.length,
        overdueFollowUps: followUps.filter((v) => v.followUpOverdue).length,
        profilesOnFile: totalProfiles,
        studentsWithSevereAllergies: severeProfiles.map((profile) => ({
          studentName: profile.studentName,
          className: profile.className,
          allergens: profile.allergies
            .filter((a) => a.severity === 'severe')
            .map((a) => a.allergen),
        })),
        topComplaints,
        todayVisits,
        followUps,
      },
    });
  } catch (error) {
    return fail(res, error);
  }
};
