const mongoose = require('mongoose');
const AidProgram = require('../models/AidProgram');
const AidApplication = require('../models/AidApplication');

/**
 * Financial aid: programs (the funds) and applications (the requests).
 *
 * `reviewApplication` is the function this module exists for. It is the only
 * place money is committed, and the only place where getting the concurrency
 * wrong hurts a real family.
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

function isStaff(user) {
  return user.role === 'admin' || user.role === 'staff';
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

/**
 * GET /api/financial-aid/programs
 *
 * Families see programs that are open or closed but not draft — a draft fund
 * is a plan, and publishing it by accident generates applications against money
 * the school has not agreed to spend.
 */
exports.getPrograms = async (req, res) => {
  try {
    const { academicYear, aidType, status } = req.query;

    const filter = {};
    if (isStaff(req.user)) {
      if (status) filter.status = status;
    } else {
      filter.status = { $in: ['open', 'closed', 'exhausted'] };
    }
    if (academicYear) filter.academicYear = academicYear;
    if (aidType) filter.aidType = aidType;

    const programs = await AidProgram.find(filter).sort({ closesOn: -1 }).limit(200);

    return res.status(200).json({
      success: true,
      count: programs.length,
      data: programs.map((program) => ({
        ...program.toObject(),
        unavailableReason: program.applicationError(),
      })),
      vocabulary: { aidTypes: AidProgram.AID_TYPES },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch aid programs');
  }
};

/**
 * POST /api/financial-aid/programs
 */
exports.createProgram = async (req, res) => {
  try {
    const {
      name,
      description,
      academicYear,
      aidType,
      opensOn,
      closesOn,
      eligibility,
      totalBudget,
      maxAwardPerStudent,
      currency,
      scoringWeights,
      status,
    } = req.body;

    if (Number(maxAwardPerStudent) > Number(totalBudget)) {
      return fail(
        res,
        400,
        'The per-student ceiling cannot exceed the total budget — that fund could only ever make one award.'
      );
    }

    const program = await AidProgram.create({
      name,
      description,
      academicYear,
      aidType,
      opensOn,
      closesOn,
      eligibility,
      totalBudget,
      maxAwardPerStudent,
      currency,
      scoringWeights,
      status: status === 'open' ? 'open' : 'draft',
      createdBy: req.user._id,
      // `budgetAwarded` is server-owned; a client-supplied value is dropped.
    });

    return res.status(201).json({
      success: true,
      message: `Program "${program.name}" created.`,
      data: program,
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    if (error.code === 11000) {
      return fail(res, 409, 'A program with that name already exists for that academic year.');
    }
    return serverError(res, error, 'Failed to create the aid program');
  }
};

/**
 * PUT /api/financial-aid/programs/:id
 *
 * The budget can be raised once applications exist but never lowered below what
 * has already been committed — the school cannot un-award money a family has
 * been told about.
 */
exports.updateProgram = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid program id.');

    const program = await AidProgram.findById(req.params.id);
    if (!program) return fail(res, 404, 'Aid program not found.');

    const { name, description, closesOn, totalBudget, maxAwardPerStudent, eligibility, status } =
      req.body;

    if (name !== undefined) program.name = name;
    if (description !== undefined) program.description = description;
    if (closesOn !== undefined) program.closesOn = closesOn;
    if (maxAwardPerStudent !== undefined) program.maxAwardPerStudent = maxAwardPerStudent;

    if (totalBudget !== undefined) {
      if (Number(totalBudget) < program.budgetAwarded) {
        return fail(
          res,
          409,
          `${program.budgetAwarded} ${program.currency} has already been awarded from this fund; the budget cannot be set below that.`
        );
      }
      program.totalBudget = totalBudget;
    }

    // Changing the weights after applications have been scored would leave two
    // scoring regimes in one fund, and the applications reviewed first would
    // have been judged by rules the later ones never faced.
    if (req.body.scoringWeights !== undefined) {
      const scored = await AidApplication.countDocuments({
        program: program._id,
        status: { $ne: 'draft' },
      });
      if (scored > 0) {
        return fail(
          res,
          409,
          `${scored} application(s) have already been scored under the current weights; they cannot be changed now.`
        );
      }
      program.scoringWeights = req.body.scoringWeights;
    }

    if (eligibility !== undefined) program.eligibility = eligibility;

    if (status !== undefined) {
      if (!AidProgram.PROGRAM_STATUSES.includes(status)) {
        return fail(res, 400, `Status must be one of: ${AidProgram.PROGRAM_STATUSES.join(', ')}`);
      }
      program.status = status;
    }

    await program.save();

    return res.status(200).json({ success: true, message: 'Program updated.', data: program });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update the aid program');
  }
};

/**
 * PATCH /api/financial-aid/programs/:id/close
 * Closing stops new applications; it does not stop the committee reviewing the
 * ones already in.
 */
exports.closeProgram = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid program id.');

    const program = await AidProgram.findById(req.params.id);
    if (!program) return fail(res, 404, 'Aid program not found.');

    program.status = 'closed';
    await program.save();

    const pending = await AidApplication.countDocuments({
      program: program._id,
      status: { $in: AidApplication.REVIEWABLE_STATUSES },
    });

    return res.status(200).json({
      success: true,
      message: `"${program.name}" is closed to new applications. ${pending} still awaiting a decision.`,
      data: program,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to close the program');
  }
};

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

/**
 * POST /api/financial-aid/applications
 * Creates a draft. Nothing is scored or reviewed until it is submitted.
 */
exports.createApplication = async (req, res) => {
  try {
    const { programId } = req.body;
    if (!isValidId(programId)) return fail(res, 400, 'A valid programId is required.');

    const program = await AidProgram.findById(programId);
    if (!program) return fail(res, 404, 'Aid program not found.');

    const blocked = program.applicationError();
    if (blocked) return fail(res, 409, blocked);

    const existing = await AidApplication.findOne({ program: program._id, student: req.user._id });
    if (existing) {
      return fail(res, 409, 'You already have an application for this program.', {
        applicationId: existing._id,
        status: existing.status,
      });
    }

    if (Number(req.body.amountRequested) > program.maxAwardPerStudent) {
      return fail(
        res,
        400,
        `This program awards at most ${program.maxAwardPerStudent} ${program.currency} per student.`
      );
    }

    const application = new AidApplication({
      program: program._id,
      programName: program.name,
      student: req.user._id,
      studentName: req.user.name || '',
      className: req.user.className || '',
      academicYear: program.academicYear,
      householdIncome: req.body.householdIncome,
      dependants: req.body.dependants,
      guardianOccupation: req.body.guardianOccupation,
      academicPercentage: req.body.academicPercentage,
      attendancePercentage: req.body.attendancePercentage,
      amountRequested: req.body.amountRequested,
      statementOfNeed: req.body.statementOfNeed,
      documents: Array.isArray(req.body.documents) ? req.body.documents : [],
      status: 'draft',
      // `score` and `amountAwarded` are server-owned and deliberately absent.
    });

    application.recordTransition('draft', req.user, 'Application started');
    await application.save();

    return res.status(201).json({
      success: true,
      message: 'Draft saved. Submit it when you are ready — you can edit it until then.',
      data: application.viewFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    if (error.code === 11000) {
      return fail(res, 409, 'You already have an application for this program.');
    }
    return serverError(res, error, 'Failed to create the application');
  }
};

/**
 * PATCH /api/financial-aid/applications/:id
 * Drafts only. Editing the declared figures after submission would change the
 * score the committee is looking at while they are looking at it.
 */
exports.updateApplication = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid application id.');

    const application = await AidApplication.findById(req.params.id);
    if (!application) return fail(res, 404, 'Application not found.');

    if (String(application.student) !== String(req.user._id)) {
      return fail(res, 403, 'You can only edit your own application.');
    }
    if (application.status !== 'draft') {
      return fail(
        res,
        409,
        `This application is ${application.status} and can no longer be edited. Withdraw it if the details are wrong.`
      );
    }

    const editable = [
      'householdIncome',
      'dependants',
      'guardianOccupation',
      'academicPercentage',
      'attendancePercentage',
      'amountRequested',
      'statementOfNeed',
      'documents',
    ];

    editable.forEach((field) => {
      if (req.body[field] !== undefined) application[field] = req.body[field];
    });

    await application.save();

    return res.status(200).json({
      success: true,
      message: 'Draft updated.',
      data: application.viewFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update the application');
  }
};

/**
 * PATCH /api/financial-aid/applications/:id/submit
 *
 * Scoring happens here, once, from the figures as declared at submission. The
 * score is computed server-side and never read from the request — a
 * client-supplied score is not a score, it is a claim.
 */
exports.submitApplication = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid application id.');

    const application = await AidApplication.findById(req.params.id);
    if (!application) return fail(res, 404, 'Application not found.');

    if (String(application.student) !== String(req.user._id)) {
      return fail(res, 403, 'You can only submit your own application.');
    }
    if (application.status !== 'draft') {
      return fail(res, 409, `This application has already been ${application.status}.`);
    }

    const program = await AidProgram.findById(application.program);
    if (!program) return fail(res, 404, 'The program for this application no longer exists.');

    const closed = program.applicationError();
    if (closed) return fail(res, 409, closed);

    const ineligible = program.eligibilityError(application);
    if (ineligible) return fail(res, 409, ineligible);

    if (application.amountRequested > program.maxAwardPerStudent) {
      return fail(
        res,
        400,
        `This program awards at most ${program.maxAwardPerStudent} ${program.currency} per student.`
      );
    }

    const score = program.computeScore(application);
    application.score = { ...score, computedAt: new Date() };
    application.submittedAt = new Date();
    application.recordTransition('submitted', req.user, `Scored ${score.total}/100 on submission`);

    await application.save();

    return res.status(200).json({
      success: true,
      message: 'Application submitted. You will be told the outcome once the committee has reviewed it.',
      data: application.viewFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to submit the application');
  }
};

/**
 * PATCH /api/financial-aid/applications/:id/withdraw
 */
exports.withdrawApplication = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid application id.');

    const application = await AidApplication.findById(req.params.id);
    if (!application) return fail(res, 404, 'Application not found.');

    if (String(application.student) !== String(req.user._id)) {
      return fail(res, 403, 'You can only withdraw your own application.');
    }
    if (application.isDecided) {
      return fail(res, 409, `This application is already ${application.status}.`);
    }

    application.recordTransition('withdrawn', req.user, req.body.reason || '');
    await application.save();

    return res.status(200).json({
      success: true,
      message: 'Application withdrawn.',
      data: application.viewFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to withdraw the application');
  }
};

/**
 * GET /api/financial-aid/applications/me
 */
exports.getMyApplications = async (req, res) => {
  try {
    const applications = await AidApplication.find({ student: req.user._id }).sort({
      createdAt: -1,
    });

    return res.status(200).json({
      success: true,
      count: applications.length,
      data: applications.map((application) => application.viewFor(req.user)),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch your applications');
  }
};

/**
 * GET /api/financial-aid/applications
 * The review queue, highest score first.
 */
exports.getApplications = async (req, res) => {
  try {
    const { programId, status, className, minScore } = req.query;

    const filter = {};
    if (programId && isValidId(programId)) filter.program = programId;
    if (status) filter.status = status;
    if (className) filter.className = className;
    if (minScore) filter['score.total'] = { $gte: Number(minScore) };

    // Drafts belong to the family until they choose to submit them.
    if (!status) filter.status = { $ne: 'draft' };

    const applications = await AidApplication.find(filter)
      .sort({ 'score.total': -1, submittedAt: 1 })
      .limit(400);

    return res.status(200).json({
      success: true,
      count: applications.length,
      data: applications.map((application) => application.viewFor(req.user)),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch applications');
  }
};

/**
 * GET /api/financial-aid/applications/:id
 */
exports.getApplication = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid application id.');

    const application = await AidApplication.findById(req.params.id);
    if (!application) return fail(res, 404, 'Application not found.');

    if (!isStaff(req.user) && String(application.student) !== String(req.user._id)) {
      return fail(res, 403, 'You can only view your own application.');
    }

    return res.status(200).json({ success: true, data: application.viewFor(req.user) });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the application');
  }
};

/**
 * PATCH /api/financial-aid/applications/:id/review
 *
 * The decision, and the only place money leaves the fund.
 *
 * An approval is two writes that have to agree:
 *
 *  1. Reserve the award on the program with a conditional update whose filter
 *     carries the budget test —
 *     `$expr: { $lte: [{ $add: ['$budgetAwarded', award] }, '$totalBudget'] }`.
 *     Two reviewers approving the last ₹50,000 at the same instant both pass a
 *     read-then-write check and both commit; here the second matches no
 *     document and gets a 409 with the real remaining budget.
 *
 *  2. Attach the award to the application, guarded on it still being
 *     reviewable so a double-tap cannot award twice.
 *
 * If step 2 fails the reservation from step 1 is released. Without that the
 * fund leaks budget on every partial failure and slowly stops being able to
 * award money it actually has.
 *
 * The reservation comes first because the reverse order — mark the application
 * approved, then find the fund is empty — leaves a family holding an approval
 * the school cannot honour, which is the exact harm this module was opened for.
 */
exports.reviewApplication = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid application id.');

    const { decision, amountAwarded, reviewNote } = req.body;

    if (!['approved', 'rejected', 'waitlisted', 'under-review'].includes(decision)) {
      return fail(
        res,
        400,
        "decision must be 'approved', 'rejected', 'waitlisted' or 'under-review'."
      );
    }
    if (decision !== 'under-review' && (!reviewNote || !String(reviewNote).trim())) {
      return fail(res, 400, 'A review note is required so the family can be told why.');
    }

    const application = await AidApplication.findById(req.params.id);
    if (!application) return fail(res, 404, 'Application not found.');

    if (!AidApplication.REVIEWABLE_STATUSES.includes(application.status)) {
      return fail(res, 409, `This application is ${application.status} and cannot be reviewed.`);
    }

    const program = await AidProgram.findById(application.program);
    if (!program) return fail(res, 404, 'The program for this application no longer exists.');

    const note = reviewNote ? String(reviewNote).trim() : '';

    // ---- The non-monetary decisions: no reservation needed ----
    if (decision !== 'approved') {
      const updated = await AidApplication.findOneAndUpdate(
        { _id: application._id, status: { $in: AidApplication.REVIEWABLE_STATUSES } },
        {
          $set: {
            status: decision,
            reviewedBy: req.user._id,
            reviewedByName: req.user.name || '',
            reviewedAt: new Date(),
            reviewNote: note,
          },
          $push: {
            history: {
              from: application.status,
              to: decision,
              by: req.user._id,
              byName: req.user.name || '',
              note,
              at: new Date(),
            },
          },
        },
        { new: true }
      );

      if (!updated) return fail(res, 409, 'This application was decided while you were reviewing it.');

      return res.status(200).json({
        success: true,
        message: `Application ${decision}.`,
        data: updated.viewFor(req.user),
      });
    }

    // ---- Approval ----
    const award = Math.round(Number(amountAwarded ?? application.amountRequested));

    if (!Number.isFinite(award) || award <= 0) {
      return fail(res, 400, 'The awarded amount must be a positive number.');
    }
    if (award > program.maxAwardPerStudent) {
      return fail(
        res,
        400,
        `That exceeds this program's per-student ceiling of ${program.maxAwardPerStudent} ${program.currency}.`
      );
    }
    if (award > program.budgetRemaining) {
      return fail(
        res,
        409,
        `Only ${program.budgetRemaining} ${program.currency} is left in this fund.`,
        { budgetRemaining: program.budgetRemaining }
      );
    }

    // 1. Reserve.
    const reserved = await AidProgram.findOneAndUpdate(
      {
        _id: program._id,
        status: { $in: ['open', 'closed'] },
        $expr: { $lte: [{ $add: ['$budgetAwarded', award] }, '$totalBudget'] },
      },
      { $inc: { budgetAwarded: award } },
      { new: true }
    );

    if (!reserved) {
      const current = await AidProgram.findById(program._id);
      return fail(
        res,
        409,
        current
          ? `That award no longer fits: ${current.budgetRemaining} ${current.currency} is left in the fund.`
          : 'Aid program not found.',
        { budgetRemaining: current ? current.budgetRemaining : 0 }
      );
    }

    // 2. Attach.
    const updated = await AidApplication.findOneAndUpdate(
      { _id: application._id, status: { $in: AidApplication.REVIEWABLE_STATUSES } },
      {
        $set: {
          status: 'approved',
          amountAwarded: award,
          reviewedBy: req.user._id,
          reviewedByName: req.user.name || '',
          reviewedAt: new Date(),
          reviewNote: note,
        },
        $push: {
          history: {
            from: application.status,
            to: 'approved',
            by: req.user._id,
            byName: req.user.name || '',
            note: `${note} (awarded ${award} ${program.currency})`,
            at: new Date(),
          },
        },
      },
      { new: true }
    );

    if (!updated) {
      // Somebody decided this application between the reservation and now. The
      // money we set aside is not being used, so give it back.
      await AidProgram.updateOne({ _id: program._id }, { $inc: { budgetAwarded: -award } });
      return fail(res, 409, 'This application was decided while you were approving it.');
    }

    // Mark the fund exhausted once nothing meaningful is left, so it drops out
    // of the list families can apply to. Conditional so it cannot race a budget
    // increase back the other way.
    if (reserved.budgetRemaining <= 0) {
      await AidProgram.updateOne(
        { _id: program._id, status: 'open', $expr: { $gte: ['$budgetAwarded', '$totalBudget'] } },
        { $set: { status: 'exhausted' } }
      );
    }

    return res.status(200).json({
      success: true,
      message: `Approved. ${award} ${program.currency} awarded; ${reserved.budgetRemaining} left in the fund.`,
      data: updated.viewFor(req.user),
      budgetRemaining: reserved.budgetRemaining,
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record the review decision');
  }
};

/**
 * GET /api/financial-aid/summary
 */
exports.getSummary = async (req, res) => {
  try {
    const [programs, applications] = await Promise.all([
      AidProgram.find({}).select('name totalBudget budgetAwarded status currency academicYear'),
      AidApplication.find({}).select('status amountAwarded amountRequested score program'),
    ]);

    const summary = {
      programs: programs.length,
      openPrograms: 0,
      totalBudget: 0,
      totalAwarded: 0,
      applications: 0,
      submitted: 0,
      underReview: 0,
      approved: 0,
      rejected: 0,
      waitlisted: 0,
      withdrawn: 0,
      totalRequested: 0,
    };

    programs.forEach((program) => {
      if (program.status === 'open') summary.openPrograms += 1;
      summary.totalBudget += program.totalBudget;
      summary.totalAwarded += program.budgetAwarded;
    });

    let scoreSum = 0;
    let scored = 0;

    applications.forEach((application) => {
      if (application.status === 'draft') return;
      summary.applications += 1;
      summary.totalRequested += application.amountRequested;

      if (application.status === 'submitted') summary.submitted += 1;
      if (application.status === 'under-review') summary.underReview += 1;
      if (application.status === 'approved') summary.approved += 1;
      if (application.status === 'rejected') summary.rejected += 1;
      if (application.status === 'waitlisted') summary.waitlisted += 1;
      if (application.status === 'withdrawn') summary.withdrawn += 1;

      if (application.score?.total) {
        scoreSum += application.score.total;
        scored += 1;
      }
    });

    summary.budgetRemaining = Math.max(0, summary.totalBudget - summary.totalAwarded);
    summary.averageScore = scored > 0 ? Math.round(scoreSum / scored) : null;
    summary.averageAward =
      summary.approved > 0 ? Math.round(summary.totalAwarded / summary.approved) : 0;

    // The gap between what families asked for and what the school can give.
    // Worth showing plainly — it is the number that justifies growing the fund.
    summary.unmetNeed = Math.max(0, summary.totalRequested - summary.totalAwarded);

    return res.status(200).json({ success: true, summary });
  } catch (error) {
    return serverError(res, error, 'Failed to compute the financial aid summary');
  }
};
