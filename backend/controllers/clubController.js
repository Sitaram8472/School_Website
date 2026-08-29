const mongoose = require('mongoose');

const Club = require('../models/Club');
const ClubMembership = require('../models/ClubMembership');
const User = require('../models/User');

const fail = (res, error, fallbackStatus = 400) => {
  if (error && error.name === 'ValidationError') {
    const messages = Object.values(error.errors).map((e) => e.message);
    return res.status(400).json({ success: false, message: messages.join(', ') });
  }

  if (error && error.code === 11000) {
    return res.status(409).json({
      success: false,
      message: 'That already exists — a club with this name, or a membership for this student',
    });
  }

  if (error && error.userFacing) {
    return res
      .status(error.statusCode || fallbackStatus)
      .json({ success: false, message: error.message });
  }

  console.error('[Clubs]', error);
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
const conflict = (message) => makeError(message, 409);

// Longest search term we will build a pattern from. Beyond this it is a probe,
// not a search.
const MAX_SEARCH_LENGTH = 80;

/**
 * Case-insensitive "contains" matcher over untrusted input, with the regex
 * metacharacters escaped so the term matches literally.
 *
 * Passed through raw, a search of `.*` matched every club rather than clubs
 * containing that text, `(a+)+$` triggered catastrophic backtracking — roughly
 * two minutes of pinned CPU for a 33-character query string — and an
 * unbalanced `[` threw and surfaced as a 500.
 */
const searchPattern = (value) => {
  const term = String(value).trim().slice(0, MAX_SEARCH_LENGTH);
  return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
};

const assertObjectId = (value, label = 'id') => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw badRequest(`Invalid ${label}`);
  }
  return value;
};

const userId = (req) => String(req.user.id || req.user._id);

/**
 * A club is run by its coordinator; an admin can act on any club. Teachers who
 * do not coordinate a given club are deliberately not privileged over it.
 */
const assertMayManage = (req, club) => {
  if (req.user.role === 'admin') return;
  if (String(club.coordinator) === userId(req)) return;

  throw forbidden('Only this club\'s coordinator or an admin can do that');
};

/**
 * Recomputes `memberCount` from the membership collection. Called after every
 * write that could change it, so the number on the card is always the number of
 * rows behind it.
 */
const syncMemberCount = async (clubId) => {
  const count = await ClubMembership.countDocuments({ club: clubId, status: 'active' });
  await Club.updateOne({ _id: clubId }, { $set: { memberCount: count } });
  return count;
};

// ---------------------------------------------------------------------------
// Clubs
// ---------------------------------------------------------------------------

exports.createClub = async (req, res) => {
  try {
    const {
      name,
      category,
      description,
      coverImage,
      meetingDay,
      meetingTime,
      venue,
      capacity,
      eligibleClasses,
      requiresApproval,
      coordinatorId,
    } = req.body;

    // Only an admin may hand a club to somebody else; a teacher creating one
    // coordinates it themselves.
    let coordinator = userId(req);
    if (coordinatorId && req.user.role === 'admin') {
      assertObjectId(coordinatorId, 'coordinator id');
      coordinator = coordinatorId;
    }

    const owner = await User.findById(coordinator).select('name role');
    if (!owner) throw notFound('Coordinator not found');

    const club = new Club({
      name,
      category,
      description,
      coverImage,
      meetingDay,
      meetingTime: meetingTime || undefined,
      venue,
      capacity,
      eligibleClasses,
      requiresApproval: Boolean(requiresApproval),
      coordinator,
      coordinatorName: owner.name,
      memberCount: 0,
    });

    await club.save();

    return res.status(201).json({ success: true, data: club });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getClubs = async (req, res) => {
  try {
    const { category, status, search, mine, limit = 60, page = 1 } = req.query;

    const filter = {};
    if (category) filter.category = category;

    // Students never see archived clubs; staff can ask for them explicitly.
    if (req.user.role === 'student') {
      filter.status = { $ne: 'archived' };
    } else if (status) {
      filter.status = status;
    }

    if (search) {
      const pattern = searchPattern(search);
      filter.$or = [{ name: pattern }, { description: pattern }, { coordinatorName: pattern }];
    }

    if (mine === 'true') {
      filter.coordinator = userId(req);
    }

    const perPage = Math.min(Number(limit) || 60, 100);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * perPage;

    const clubs = await Club.find(filter)
      .sort({ name: 1 })
      .skip(skip)
      .limit(perPage)
      .select('-sessions.attendees');

    // One query for every membership this student holds, rather than one per
    // club, so the directory stays a fixed number of round trips.
    const memberships = await ClubMembership.find({
      student: userId(req),
      status: { $in: ['pending', 'active'] },
    }).select('club status role');

    const byClub = new Map(memberships.map((m) => [String(m.club), m]));

    const data = clubs.map((club) => {
      const membership = byClub.get(String(club._id));
      return {
        ...club.toObject(),
        myMembership: membership
          ? { status: membership.status, role: membership.role }
          : null,
      };
    });

    const total = await Club.countDocuments(filter);

    return res.status(200).json({ success: true, count: data.length, total, data });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getClub = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'club id');

    const club = await Club.findById(req.params.id).populate('coordinator', 'name email');
    if (!club) throw notFound('Club not found');

    const membership = await ClubMembership.findOne({
      club: club._id,
      student: userId(req),
    });

    const isManager = req.user.role === 'admin' || String(club.coordinator?._id || club.coordinator) === userId(req);

    // The roster is for the people running the club, not for browsing.
    const members = isManager
      ? await ClubMembership.find({ club: club._id, status: { $in: ['active', 'pending'] } })
          .populate('student', 'name email')
          .sort({ status: 1, studentName: 1 })
      : undefined;

    return res.status(200).json({
      success: true,
      data: {
        club,
        myMembership: membership || null,
        upcomingSessions: club.upcomingSessions,
        members,
      },
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.updateClub = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'club id');

    const club = await Club.findById(req.params.id);
    if (!club) throw notFound('Club not found');

    assertMayManage(req, club);

    // `memberCount`, `slug` and `sessions` are derived or have their own
    // endpoints; letting them through here would let a coordinator invent
    // members.
    const editable = [
      'name',
      'category',
      'description',
      'coverImage',
      'meetingDay',
      'meetingTime',
      'venue',
      'capacity',
      'eligibleClasses',
      'requiresApproval',
      'status',
    ];

    editable.forEach((field) => {
      if (req.body[field] !== undefined) {
        club[field] = req.body[field];
      }
    });

    await club.save();

    return res.status(200).json({ success: true, data: club });
  } catch (error) {
    return fail(res, error);
  }
};

exports.deleteClub = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'club id');

    const club = await Club.findById(req.params.id);
    if (!club) throw notFound('Club not found');

    const active = await ClubMembership.countDocuments({ club: club._id, status: 'active' });
    if (active > 0) {
      throw conflict(
        `Cannot delete "${club.name}" — it still has ${active} member(s). Archive it instead.`
      );
    }

    await club.deleteOne();

    return res.status(200).json({ success: true, message: 'Club deleted' });
  } catch (error) {
    return fail(res, error);
  }
};

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

exports.joinClub = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'club id');

    const club = await Club.findById(req.params.id);
    if (!club) throw notFound('Club not found');

    if (club.status !== 'open') {
      throw conflict(`"${club.name}" is not accepting members right now`);
    }

    const student = await User.findById(userId(req)).select('name role');
    if (!student) throw notFound('Student not found');

    const className = req.body.className || '';

    if (!club.acceptsClass(className)) {
      throw forbidden(
        `"${club.name}" is open to ${club.eligibleClasses.join(', ')} only`
      );
    }

    // Re-derive the count immediately before the capacity check so a stale
    // number cannot admit one member past the cap.
    const currentCount = await syncMemberCount(club._id);
    const goesActive = !club.requiresApproval;

    if (goesActive && currentCount + 1 > club.capacity) {
      throw conflict(`"${club.name}" is full (${currentCount}/${club.capacity})`);
    }

    let membership = await ClubMembership.findOne({ club: club._id, student: student._id });

    if (membership) {
      if (['active', 'pending'].includes(membership.status)) {
        throw conflict(`You are already ${membership.status} in "${club.name}"`);
      }

      // Rejoining reuses the existing row so the compound unique index holds
      // and the student's history is not duplicated.
      membership.transitionTo(goesActive ? 'active' : 'pending');
      membership.className = className || membership.className;
      membership.motivation = req.body.motivation || membership.motivation;
      await membership.save();
    } else {
      membership = await ClubMembership.create({
        club: club._id,
        clubName: club.name,
        student: student._id,
        studentName: student.name,
        className,
        motivation: req.body.motivation || '',
        status: goesActive ? 'active' : 'pending',
      });
    }

    await syncMemberCount(club._id);

    return res.status(201).json({
      success: true,
      message: goesActive
        ? `You have joined "${club.name}"`
        : `Your request to join "${club.name}" is awaiting approval`,
      data: membership,
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.leaveClub = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'club id');

    const membership = await ClubMembership.findOne({
      club: req.params.id,
      student: userId(req),
    });

    if (!membership) throw notFound('You are not a member of that club');

    // The row is kept rather than deleted, so a coordinator can still see that
    // this student was once a member.
    membership.transitionTo('left', null, req.body.reason || 'Left the club');
    await membership.save();

    await syncMemberCount(req.params.id);

    return res.status(200).json({ success: true, message: 'You have left the club', data: membership });
  } catch (error) {
    return fail(res, error);
  }
};

exports.decideMembership = async (req, res) => {
  try {
    assertObjectId(req.params.membershipId, 'membership id');

    const { decision, note } = req.body;
    if (!['approve', 'reject'].includes(decision)) {
      throw badRequest('Decision must be either approve or reject');
    }

    const membership = await ClubMembership.findById(req.params.membershipId);
    if (!membership) throw notFound('Membership not found');

    const club = await Club.findById(membership.club);
    if (!club) throw notFound('Club not found');

    assertMayManage(req, club);

    if (membership.status !== 'pending') {
      throw conflict(`That request has already been decided (it is ${membership.status})`);
    }

    if (decision === 'approve') {
      const currentCount = await syncMemberCount(club._id);
      if (currentCount + 1 > club.capacity) {
        throw conflict(`"${club.name}" is full (${currentCount}/${club.capacity})`);
      }
      membership.transitionTo('active', userId(req), note || '');
    } else {
      membership.transitionTo('rejected', userId(req), note || '');
    }

    await membership.save();
    await syncMemberCount(club._id);

    return res.status(200).json({ success: true, data: membership });
  } catch (error) {
    return fail(res, error);
  }
};

exports.setMemberRole = async (req, res) => {
  try {
    assertObjectId(req.params.membershipId, 'membership id');

    const membership = await ClubMembership.findById(req.params.membershipId);
    if (!membership) throw notFound('Membership not found');

    const club = await Club.findById(membership.club);
    if (!club) throw notFound('Club not found');

    assertMayManage(req, club);

    if (membership.status !== 'active') {
      throw conflict('Only an active member can hold a club role');
    }

    membership.role = req.body.role;
    await membership.save();

    return res.status(200).json({ success: true, data: membership });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getMyClubs = async (req, res) => {
  try {
    const memberships = await ClubMembership.find({
      student: userId(req),
      status: { $in: ['active', 'pending'] },
    })
      .populate('club')
      .sort({ createdAt: -1 });

    // Collapse every upcoming session across the student's clubs into one
    // chronological list — the thing they actually want to see.
    const upcoming = [];
    memberships.forEach((membership) => {
      if (membership.status !== 'active' || !membership.club) return;

      (membership.club.upcomingSessions || []).forEach((session) => {
        upcoming.push({
          clubId: membership.club._id,
          clubName: membership.club.name,
          sessionId: session._id,
          title: session.title,
          scheduledFor: session.scheduledFor,
          venue: session.venue,
          durationMinutes: session.durationMinutes,
        });
      });
    });

    upcoming.sort((a, b) => new Date(a.scheduledFor) - new Date(b.scheduledFor));

    return res.status(200).json({
      success: true,
      count: memberships.length,
      data: memberships,
      upcomingSessions: upcoming.slice(0, 20),
    });
  } catch (error) {
    return fail(res, error);
  }
};

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

exports.scheduleSession = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'club id');

    const club = await Club.findById(req.params.id);
    if (!club) throw notFound('Club not found');

    assertMayManage(req, club);

    const session = club.addSession(req.body);
    await club.save();

    return res.status(201).json({ success: true, data: session });
  } catch (error) {
    return fail(res, error);
  }
};

exports.cancelSession = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'club id');

    const club = await Club.findById(req.params.id);
    if (!club) throw notFound('Club not found');

    assertMayManage(req, club);

    const session = club.findSession(req.params.sessionId);
    if (!session) throw notFound('Session not found');

    if (session.status === 'held') {
      throw conflict('That session has already been held');
    }

    session.status = 'cancelled';
    club.markModified('sessions');
    await club.save();

    return res.status(200).json({ success: true, data: session });
  } catch (error) {
    return fail(res, error);
  }
};

/**
 * Bulk attendance. Every id in the payload is checked against the active
 * roster first — marking a non-member present would quietly corrupt the
 * attendance rate the report card is built from.
 */
exports.markAttendance = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'club id');

    const { attendance } = req.body;
    if (!Array.isArray(attendance)) {
      throw badRequest('Send an attendance array of { studentId, present }');
    }

    const club = await Club.findById(req.params.id);
    if (!club) throw notFound('Club not found');

    assertMayManage(req, club);

    const session = club.findSession(req.params.sessionId);
    if (!session) throw notFound('Session not found');

    if (session.status === 'cancelled') {
      throw conflict('That session was cancelled');
    }

    const members = await ClubMembership.find({ club: club._id, status: 'active' });
    const byStudent = new Map(members.map((m) => [String(m.student), m]));

    const strangers = attendance.filter((row) => !byStudent.has(String(row.studentId)));
    if (strangers.length) {
      throw badRequest(
        `${strangers.length} of those students are not active members of this club`
      );
    }

    // Attendance is re-recorded from scratch each time, so correcting a
    // mistaken entry does not leave the old one behind.
    const previous = new Map((session.attendees || []).map((a) => [String(a.student), a.present]));

    session.attendees = attendance.map((row) => ({
      student: row.studentId,
      studentName: byStudent.get(String(row.studentId)).studentName,
      present: Boolean(row.present),
    }));
    session.status = 'held';
    session.attendanceTakenAt = new Date();

    club.markModified('sessions');
    await club.save();

    // Roll the per-member counters forward by the delta rather than
    // recounting, and undo any previous entry for this session first.
    await Promise.all(
      attendance.map((row) => {
        const membership = byStudent.get(String(row.studentId));
        const wasPresent = previous.get(String(row.studentId));

        if (wasPresent !== undefined) {
          if (wasPresent) membership.attendanceCount = Math.max(membership.attendanceCount - 1, 0);
          else membership.sessionsMissed = Math.max(membership.sessionsMissed - 1, 0);
        }

        if (row.present) membership.attendanceCount += 1;
        else membership.sessionsMissed += 1;

        return membership.save();
      })
    );

    return res.status(200).json({
      success: true,
      message: `Attendance recorded for ${attendance.length} member(s)`,
      data: session,
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.addAchievement = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'club id');

    const club = await Club.findById(req.params.id);
    if (!club) throw notFound('Club not found');

    assertMayManage(req, club);

    club.achievements.push({
      title: req.body.title,
      awardedOn: req.body.awardedOn || new Date(),
      description: req.body.description || '',
    });

    await club.save();

    return res.status(201).json({ success: true, data: club.achievements });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getClubStats = async (req, res) => {
  try {
    const clubs = await Club.find({});

    const byCategory = new Map();
    clubs.forEach((club) => {
      const entry = byCategory.get(club.category) || { category: club.category, clubs: 0, members: 0 };
      entry.clubs += 1;
      entry.members += club.memberCount || 0;
      byCategory.set(club.category, entry);
    });

    const [activeMemberships, pendingRequests] = await Promise.all([
      ClubMembership.countDocuments({ status: 'active' }),
      ClubMembership.countDocuments({ status: 'pending' }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        totalClubs: clubs.length,
        openClubs: clubs.filter((c) => c.status === 'open').length,
        fullClubs: clubs.filter((c) => c.isFull).length,
        activeMemberships,
        pendingRequests,
        byCategory: [...byCategory.values()].sort((a, b) => b.members - a.members),
        mostPopular: [...clubs]
          .sort((a, b) => b.memberCount - a.memberCount)
          .slice(0, 5)
          .map((c) => ({ name: c.name, memberCount: c.memberCount, capacity: c.capacity })),
      },
    });
  } catch (error) {
    return fail(res, error);
  }
};
