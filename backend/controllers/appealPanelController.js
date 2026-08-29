const mongoose = require('mongoose');

const AppealPanel = require('../models/AppealPanel');
const RemarkAppeal = require('../models/RemarkAppeal');
const Course = require('../models/Course');
const Exam = require('../models/Exam');
const User = require('../models/User');

/**
 * Appeal reviewer panels.
 *
 * Two handlers carry the feature.
 *
 * `addMember` is where the gap in the existing assignment path is closed. The
 * candidate is **loaded** and their role checked, which is exactly what
 * `assignReviewer` cannot do today: it calls `reviewerEligibilityError` with a
 * bare `{ _id: reviewerId }` literal, so a well-formed id belonging to nobody
 * passes both of its rules.
 *
 * `assignFromPanel` is the one worth reading closely. It is a second, stricter
 * door onto the same operation: it resolves the appeal's course through its
 * exam, refuses a candidate who is not an active member of that course's
 * active panel, re-runs the existing recusal rules on top rather than in place
 * of that, and writes the move through the appeal's own `recordAudit` so the
 * trail reads identically whichever door was used.
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

function duplicateMessage(error) {
  if (error && error.code === 11000) {
    return 'This course already has a live panel. Retire it before creating another';
  }
  return null;
}

/**
 * Open appeals per reviewer, straight from the appeals collection.
 *
 * Computed rather than counted into a field on the panel. A stored counter is
 * the thing that ends up disagreeing with the rows it is supposed to
 * summarise, and the whole point of the number is to be trusted enough to
 * assign work by.
 */
async function openLoadByReviewer(userIds) {
  if (!userIds.length) return new Map();

  const rows = await RemarkAppeal.aggregate([
    {
      $match: {
        reviewer: { $in: userIds.map((id) => new mongoose.Types.ObjectId(String(id))) },
        status: { $in: RemarkAppeal.OPEN_STATUSES },
      },
    },
    { $group: { _id: '$reviewer', open: { $sum: 1 } } },
  ]);

  return new Map(rows.map((row) => [String(row._id), row.open]));
}

/**
 * GET /api/appeals/panels/meta
 */
exports.getMeta = async (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      statuses: AppealPanel.STATUSES,
      seats: AppealPanel.SEATS,
      eligibleRoles: AppealPanel.ELIGIBLE_ROLES,
      maxMembers: AppealPanel.MAX_MEMBERS,
      defaultMinReviewers: AppealPanel.DEFAULT_MIN_REVIEWERS,
      canManage: !!(req.user && req.user.role === 'admin'),
    },
  });
};

/**
 * GET /api/appeals/panels/eligible
 *
 * Staff who could be added. Filtered by role in the query rather than in the
 * browser, so the list a panel is built from cannot contain somebody the model
 * will then refuse.
 */
exports.getEligibleStaff = async (req, res) => {
  try {
    const query = { role: { $in: AppealPanel.ELIGIBLE_ROLES } };

    if (req.query.q) {
      const safe = String(req.query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [{ name: new RegExp(safe, 'i') }, { email: new RegExp(safe, 'i') }];
    }

    const staff = await User.find(query)
      .select('name email role')
      .sort({ name: 1 })
      .limit(MAX_LIST);

    const load = await openLoadByReviewer(staff.map((person) => person._id));

    return res.status(200).json({
      success: true,
      count: staff.length,
      data: staff.map((person) => ({
        _id: person._id,
        name: person.name,
        email: person.email,
        role: person.role,
        openAppeals: load.get(String(person._id)) || 0,
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load eligible staff');
  }
};

/**
 * GET /api/appeals/panels
 */
exports.listPanels = async (req, res) => {
  try {
    const query = {};

    if (req.query.status) {
      if (!AppealPanel.STATUSES.includes(req.query.status)) {
        return fail(res, 400, 'Invalid status filter');
      }
      query.status = req.query.status;
    }

    if (req.query.academicYear) {
      query.academicYear = String(req.query.academicYear).trim();
    }

    const panels = await AppealPanel.find(query)
      .sort({ createdAt: -1 })
      .limit(MAX_LIST);

    return res.status(200).json({
      success: true,
      count: panels.length,
      data: panels.map((panel) => panel.toRow()),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load appeal panels');
  }
};

/**
 * GET /api/appeals/panels/course/:courseId
 *
 * The panel governing one course. Returns `null` rather than a 404 when there
 * is none, because "this course has no panel" is a normal answer the builder
 * page renders a prompt for.
 */
exports.getPanelForCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    if (!isValidId(courseId)) return fail(res, 400, 'Invalid course id');

    const panel = await AppealPanel.liveFor(courseId);
    const course = await Course.findById(courseId).select('name');

    if (!panel) {
      return res.status(200).json({
        success: true,
        data: null,
        courseName: course ? course.name : '',
      });
    }

    const load = await openLoadByReviewer(
      panel.activeMembers.map((member) => member.user)
    );

    const row = panel.toRow();
    row.members = row.members.map((member) => ({
      ...member,
      openAppeals: load.get(String(member.user)) || 0,
    }));

    return res.status(200).json({
      success: true,
      data: row,
      courseName: course ? course.name : panel.courseName,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the panel for this course');
  }
};

/**
 * GET /api/appeals/panels/:id
 */
exports.getPanel = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid panel id');

    const panel = await AppealPanel.findById(id)
      .populate('createdBy', 'name')
      .populate('history.by', 'name');

    if (!panel) return fail(res, 404, 'Panel not found');

    return res.status(200).json({
      success: true,
      data: {
        ...panel.toRow(),
        history: panel.history,
        createdBy: panel.createdBy,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the panel');
  }
};

/**
 * GET /api/appeals/panels/:id/workload
 *
 * What each member is currently carrying. This is the number that was missing
 * entirely: without it, the same one or two conscientious reviewers get picked
 * off the queue every time and nobody can see it happening.
 */
exports.getWorkload = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid panel id');

    const panel = await AppealPanel.findById(id);
    if (!panel) return fail(res, 404, 'Panel not found');

    const members = panel.activeMembers;
    const load = await openLoadByReviewer(members.map((member) => member.user));

    const rows = members.map((member) => ({
      user: member.user,
      name: member.name,
      seat: member.seat,
      openAppeals: load.get(String(member.user)) || 0,
    }));

    const total = rows.reduce((sum, row) => sum + row.openAppeals, 0);

    return res.status(200).json({
      success: true,
      data: {
        panel: panel._id,
        courseName: panel.courseName,
        members: rows.sort((a, b) => a.openAppeals - b.openAppeals),
        totalOpen: total,
        averageOpen: rows.length ? Math.round((total / rows.length) * 10) / 10 : 0,
        generatedAt: new Date(),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to compute the panel workload');
  }
};

/**
 * Everyone on `panel` who may take `appeal`, least loaded first.
 *
 * The recusal rules stay where they are — `reviewerEligibilityError` is called
 * per candidate — and membership is layered on top of them.
 */
async function eligibleMembers(panel, appeal) {
  const members = panel.activeMembers;
  const load = await openLoadByReviewer(members.map((member) => member.user));

  return members
    .map((member) => ({
      user: member.user,
      name: member.name,
      seat: member.seat,
      openAppeals: load.get(String(member.user)) || 0,
      eligibilityError: appeal.reviewerEligibilityError({ _id: member.user }),
    }))
    .sort((a, b) => a.openAppeals - b.openAppeals);
}

/**
 * GET /api/appeals/panels/:id/suggest?appeal=<id>
 *
 * The least-loaded member who is not the student and not the original marker.
 * Returned with the rejected candidates and the reason each was rejected, so
 * the admin can see *why* the suggestion is who it is rather than being handed
 * a name with no working.
 */
exports.suggestReviewer = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid panel id');

    const appealId = req.query.appeal;
    if (!isValidId(appealId)) return fail(res, 400, 'Invalid appeal id');

    const [panel, appeal] = await Promise.all([
      AppealPanel.findById(id),
      RemarkAppeal.findById(appealId),
    ]);

    if (!panel) return fail(res, 404, 'Panel not found');
    if (!appeal) return fail(res, 404, 'Appeal not found');

    const candidates = await eligibleMembers(panel, appeal);
    const available = candidates.filter((candidate) => !candidate.eligibilityError);

    return res.status(200).json({
      success: true,
      data: {
        suggested: available[0] || null,
        candidates,
        recused: candidates.filter((candidate) => candidate.eligibilityError),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to suggest a reviewer');
  }
};

/**
 * POST /api/appeals/panels
 */
exports.createPanel = async (req, res) => {
  try {
    const { course: courseId, name, academicYear, minReviewers, notes } = req.body;

    if (!isValidId(courseId)) return fail(res, 400, 'Invalid course id');

    const course = await Course.findById(courseId).select('name');
    if (!course) return fail(res, 404, 'Course not found');

    const existing = await AppealPanel.liveFor(courseId);
    if (existing) {
      return fail(
        res,
        409,
        `${course.name} already has a ${existing.status} panel. Retire it before creating another`,
        { existingPanelId: existing._id }
      );
    }

    const panel = new AppealPanel({
      course: course._id,
      courseName: course.name || '',
      name: String(name || `${course.name} appeal panel`).trim(),
      academicYear: String(academicYear || '').trim(),
      minReviewers: Number(minReviewers) || AppealPanel.DEFAULT_MIN_REVIEWERS,
      notes: String(notes || '').trim(),
      status: 'draft',
      createdBy: req.user._id,
    });

    panel.log('created', req.user);
    await panel.save();

    return res.status(201).json({
      success: true,
      message: 'Panel drafted. Add its members, then activate it.',
      data: panel.toRow(),
    });
  } catch (error) {
    const duplicate = duplicateMessage(error);
    if (duplicate) return fail(res, 409, duplicate);

    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 400, message);

    return serverError(res, error, 'Failed to create the panel');
  }
};

/**
 * POST /api/appeals/panels/:id/members
 *
 * The candidate is loaded and their role checked here. This is the check the
 * existing assignment path cannot make, because it never resolves the id.
 */
exports.addMember = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid panel id');

    const { userId, seat } = req.body;
    if (!isValidId(userId)) return fail(res, 400, 'Invalid user id');

    const [panel, candidate] = await Promise.all([
      AppealPanel.findById(id),
      User.findById(userId).select('name email role'),
    ]);

    if (!panel) return fail(res, 404, 'Panel not found');
    if (!candidate) return fail(res, 404, 'That user does not exist');
    if (panel.status === 'retired') {
      return fail(res, 409, 'A retired panel cannot take new members');
    }

    panel.addMember(candidate, req.user, seat || 'member');
    await panel.save();

    return res.status(200).json({
      success: true,
      message: `${candidate.name} added to the panel`,
      data: panel.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 409, message);
    return serverError(res, error, 'Failed to add the member');
  }
};

/**
 * DELETE /api/appeals/panels/:id/members/:userId
 */
exports.removeMember = async (req, res) => {
  try {
    const { id, userId } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid panel id');
    if (!isValidId(userId)) return fail(res, 400, 'Invalid user id');

    const reason = req.body.reason || req.query.reason;
    if (!reason || !String(reason).trim()) {
      return fail(res, 400, 'A removal reason is required');
    }

    const panel = await AppealPanel.findById(id);
    if (!panel) return fail(res, 404, 'Panel not found');

    // A departure is the case this whole check exists for: taking somebody off
    // the roster should not silently orphan the appeals already addressed to
    // them.
    const open = await RemarkAppeal.countDocuments({
      reviewer: userId,
      status: { $in: RemarkAppeal.OPEN_STATUSES },
    });

    if (open > 0 && !req.body.reassignLater) {
      return fail(
        res,
        409,
        `That reviewer still has ${open} open appeal(s). Reassign them first, or re-send with reassignLater: true to remove anyway`,
        { openAppeals: open }
      );
    }

    panel.removeMember(userId, req.user, reason);
    await panel.save();

    return res.status(200).json({
      success: true,
      message: 'Member removed',
      data: panel.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 409, message);
    return serverError(res, error, 'Failed to remove the member');
  }
};

/**
 * PATCH /api/appeals/panels/:id/members/:userId/seat
 */
exports.setSeat = async (req, res) => {
  try {
    const { id, userId } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid panel id');
    if (!isValidId(userId)) return fail(res, 400, 'Invalid user id');

    const panel = await AppealPanel.findById(id);
    if (!panel) return fail(res, 404, 'Panel not found');

    panel.setSeat(userId, req.user, req.body.seat);
    await panel.save();

    return res.status(200).json({
      success: true,
      message: 'Seat updated',
      data: panel.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 409, message);
    return serverError(res, error, 'Failed to update the seat');
  }
};

/**
 * PATCH /api/appeals/panels/:id/activate
 */
exports.activatePanel = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid panel id');

    const panel = await AppealPanel.findById(id);
    if (!panel) return fail(res, 404, 'Panel not found');

    panel.activate(req.user);
    await panel.save();

    return res.status(200).json({
      success: true,
      message: 'Panel activated',
      data: panel.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 409, message);
    return serverError(res, error, 'Failed to activate the panel');
  }
};

/**
 * PATCH /api/appeals/panels/:id/retire
 *
 * A roster that can be deleted out from under live work is not a roster, so
 * the open-appeal count is checked before anything is written.
 */
exports.retirePanel = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid panel id');

    const { reason } = req.body;
    if (!reason || !String(reason).trim()) {
      return fail(res, 400, 'A retirement reason is required');
    }

    const panel = await AppealPanel.findById(id);
    if (!panel) return fail(res, 404, 'Panel not found');

    const memberIds = panel.activeMembers.map((member) => member.user);
    const open = memberIds.length
      ? await RemarkAppeal.countDocuments({
          reviewer: { $in: memberIds },
          status: { $in: RemarkAppeal.OPEN_STATUSES },
        })
      : 0;

    if (open > 0) {
      return fail(
        res,
        409,
        `This panel's members still hold ${open} open appeal(s). Decide or reassign them first`,
        { openAppeals: open }
      );
    }

    panel.retire(req.user, reason);
    await panel.save();

    return res.status(200).json({
      success: true,
      message: 'Panel retired',
      data: panel.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 409, message);
    return serverError(res, error, 'Failed to retire the panel');
  }
};

/**
 * PATCH /api/appeals/panels/:id/assign
 *
 * Assignment through the panel.
 *
 * The order matters: membership is checked first, then the existing recusal
 * rules. A reviewer who is on the panel but marked the paper is still refused,
 * and a reviewer who did not mark it but is not on the panel is refused too —
 * neither check subsumes the other.
 */
exports.assignFromPanel = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid panel id');

    const { appealId, reviewerId } = req.body;
    if (!isValidId(appealId)) return fail(res, 400, 'Invalid appeal id');
    if (!isValidId(reviewerId)) return fail(res, 400, 'Invalid reviewer id');

    const [panel, appeal] = await Promise.all([
      AppealPanel.findById(id),
      RemarkAppeal.findById(appealId),
    ]);

    if (!panel) return fail(res, 404, 'Panel not found');
    if (!appeal) return fail(res, 404, 'Appeal not found');

    if (panel.status !== 'active') {
      return fail(res, 409, `A ${panel.status} panel cannot be assigned from`);
    }
    if (!appeal.isOpen()) {
      return fail(res, 409, `A ${appeal.status} appeal cannot be reassigned`);
    }

    // The appeal knows its exam; the exam knows its course; the panel covers a
    // course. Checking that chain is what stops a Physics re-mark being handed
    // to the panel for another subject.
    const exam = await Exam.findById(appeal.exam).select('course title');
    if (!exam) return fail(res, 404, 'The exam behind this appeal no longer exists');

    if (String(exam.course) !== String(panel.course)) {
      return fail(
        res,
        409,
        `This panel covers ${panel.courseName || 'another course'}, and this appeal is against ${exam.title || 'an exam'} on a different one`
      );
    }

    if (!panel.isActiveMember(reviewerId)) {
      return fail(
        res,
        409,
        'That reviewer is not on this panel. Add them to it first, or pick somebody who is'
      );
    }

    // The existing rules, unchanged and still applied.
    const blocked = appeal.reviewerEligibilityError({ _id: reviewerId });
    if (blocked) return fail(res, 409, blocked);

    const member = panel.findMember(reviewerId);
    const from = appeal.reviewer ? String(appeal.reviewer) : null;

    appeal.reviewer = reviewerId;
    appeal.recordAudit({
      action: 'reviewer assigned',
      from,
      to: String(reviewerId),
      note: `from panel "${panel.name}"`,
      by: req.user._id,
    });

    await appeal.save();

    panel.log('reviewer assigned', req.user, String(appeal._id), member ? member.name : '');
    await panel.save();

    return res.status(200).json({
      success: true,
      message: `Assigned to ${member ? member.name : 'the reviewer'}`,
      data: appeal.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 409, message);
    return serverError(res, error, 'Failed to assign the reviewer');
  }
};
