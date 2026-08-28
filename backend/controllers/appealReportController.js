const mongoose = require('mongoose');

const AppealReport = require('../models/AppealReport');
const RemarkAppeal = require('../models/RemarkAppeal');
const Course = require('../models/Course');

/**
 * Published appeal outcome reports.
 *
 * Two handlers carry the feature.
 *
 * `computeFigures` is the arithmetic, and it is the direct answer to what
 * `getStats` does today: a `$match` on the period and a `$group` in the
 * database rather than `find({})` and a JavaScript loop over the whole
 * collection. Suppression is applied here, before anything is stored, so the
 * unsuppressed per-course figures never reach a document that can be
 * published.
 *
 * `approveReport` is the other one. It refuses an approver who is the person
 * who computed the report, and it stamps the digest over the figures at that
 * moment — so publication can check that what is about to go out is what was
 * agreed to.
 */

const MAX_LIST = 100;

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
    return 'There is already a live report for that period and scope. Withdraw it first, or supersede it';
  }
  return null;
}

function parseDate(value, label) {
  if (value === undefined || value === null || value === '') {
    return { error: `${label} is required` };
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { error: `${label} is not a valid date` };
  }

  return { date };
}

/**
 * Median rather than mean, for the same reason `getStats` already gives: one
 * appeal that sat for a term should not make the average look like the typical
 * experience.
 */
function median(values) {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The figures for one period, grouped by course.
 *
 * The join runs in the database: an appeal knows its exam, an exam knows its
 * course, and a per-course breakdown needs both. Doing it here rather than in
 * a loop is what stops this becoming the `find({})` it replaces.
 */
async function computeFigures({ from, to, courseId, threshold }) {
  const match = { createdAt: { $gte: from, $lte: to } };

  const pipeline = [
    { $match: match },
    {
      $lookup: {
        from: 'exams',
        localField: 'exam',
        foreignField: '_id',
        as: 'examDoc',
      },
    },
    { $unwind: { path: '$examDoc', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'courses',
        localField: 'examDoc.course',
        foreignField: '_id',
        as: 'courseDoc',
      },
    },
    { $unwind: { path: '$courseDoc', preserveNullAndEmptyArrays: true } },
  ];

  if (courseId) {
    pipeline.push({ $match: { 'courseDoc._id': new mongoose.Types.ObjectId(String(courseId)) } });
  }

  pipeline.push({
    $group: {
      _id: { $ifNull: ['$courseDoc.name', 'Unattributed'] },
      submitted: { $sum: 1 },
      upheld: { $sum: { $cond: [{ $eq: ['$status', 'accepted'] }, 1, 0] } },
      partiallyUpheld: {
        $sum: { $cond: [{ $eq: ['$status', 'partially-accepted'] }, 1, 0] },
      },
      rejected: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
      withdrawn: { $sum: { $cond: [{ $eq: ['$status', 'withdrawn'] }, 1, 0] } },
      marksMoved: { $sum: { $ifNull: ['$marksDelta', 0] } },
      // Turnarounds are pushed and reduced in JavaScript because a median is
      // not something $group can express, and the array is one number per
      // decided appeal in one period.
      turnarounds: {
        $push: {
          $cond: [
            { $and: ['$decidedAt', '$createdAt'] },
            { $subtract: ['$decidedAt', '$createdAt'] },
            null,
          ],
        },
      },
      reasons: { $push: '$reason' },
    },
  });

  pipeline.push({ $sort: { _id: 1 } });

  const grouped = await RemarkAppeal.aggregate(pipeline);

  const rawRows = grouped.map((row) => {
    const decided = row.upheld + row.partiallyUpheld + row.rejected;
    const days = row.turnarounds
      .filter((value) => value !== null && value !== undefined)
      .map((ms) => ms / 86400000);

    const medianDays = median(days);

    return {
      courseName: row._id || 'Unattributed',
      submitted: row.submitted,
      decided,
      upheld: row.upheld,
      partiallyUpheld: row.partiallyUpheld,
      rejected: row.rejected,
      withdrawn: row.withdrawn,
      upheldRate: decided
        ? Math.round(((row.upheld + row.partiallyUpheld) / decided) * 1000) / 10
        : 0,
      medianDaysToDecision: medianDays === null ? null : Math.round(medianDays * 10) / 10,
      marksMoved: row.marksMoved,
    };
  });

  // Totals come from the raw rows, before suppression. A school-wide figure
  // over every course discloses nothing about any individual, and suppressing
  // it would leave a report that says nothing at all.
  const sum = (field) => rawRows.reduce((total, row) => total + (row[field] || 0), 0);

  const decidedTotal = sum('upheld') + sum('partiallyUpheld') + sum('rejected');

  const allTurnarounds = grouped
    .flatMap((row) => row.turnarounds)
    .filter((value) => value !== null && value !== undefined)
    .map((ms) => ms / 86400000);

  const overallMedian = median(allTurnarounds);

  const reasonCounts = {};
  for (const reason of RemarkAppeal.REASONS) reasonCounts[reason] = 0;
  for (const row of grouped) {
    for (const reason of row.reasons) {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }
  }

  const rows = AppealReport.suppress(rawRows, threshold);

  return {
    rows,
    totals: {
      submitted: sum('submitted'),
      decided: decidedTotal,
      upheld: sum('upheld'),
      partiallyUpheld: sum('partiallyUpheld'),
      rejected: sum('rejected'),
      withdrawn: sum('withdrawn'),
      upheldRate: decidedTotal
        ? Math.round(((sum('upheld') + sum('partiallyUpheld')) / decidedTotal) * 1000) / 10
        : 0,
      medianDaysToDecision:
        overallMedian === null ? null : Math.round(overallMedian * 10) / 10,
      marksMoved: sum('marksMoved'),
      coursesReported: rows.filter((row) => !row.suppressed).length,
      coursesSuppressed: rows.filter((row) => row.suppressed).length,
    },
    // Reasons are suppressed on the same rule, because "one appeal for a
    // technical issue in the whole term" is as identifying as a per-course row.
    byReason: Object.entries(reasonCounts).map(([reason, count]) => ({
      reason,
      count: count >= threshold ? count : null,
      suppressed: count > 0 && count < threshold,
    })),
  };
}

/**
 * GET /api/appeals/statistics/meta
 *
 * Public: it carries the vocabulary and the suppression rule, and no figures.
 * A reader is entitled to know what the threshold is before reading a report
 * that has holes in it.
 */
exports.getMeta = async (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      statuses: AppealReport.STATUSES,
      scopes: AppealReport.SCOPES,
      reasons: RemarkAppeal.REASONS,
      defaultThreshold: AppealReport.DEFAULT_SUPPRESSION_THRESHOLD,
      minThreshold: AppealReport.MIN_SUPPRESSION_THRESHOLD,
      canManage: !!(req.user && req.user.role === 'admin'),
    },
  });
};

/**
 * GET /api/appeals/statistics/published
 *
 * Public. Live published reports only, newest first, projected through
 * `toPublicRow` so the people who prepared them are not published alongside.
 */
exports.listPublished = async (req, res) => {
  try {
    const reports = await AppealReport.find({ status: 'published', isLive: true })
      .sort({ publishedAt: -1 })
      .limit(MAX_LIST);

    return res.status(200).json({
      success: true,
      count: reports.length,
      data: reports.map((report) => report.toPublicRow()),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load published reports');
  }
};

/**
 * GET /api/appeals/statistics/published/:id
 */
exports.getPublished = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid report id');

    const report = await AppealReport.findOne({ _id: id, status: 'published' });
    if (!report) return fail(res, 404, 'No published report with that id');

    return res.status(200).json({
      success: true,
      data: report.toPublicRow(),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the report');
  }
};

/**
 * GET /api/appeals/statistics
 *
 * Every report, any status, for staff.
 */
exports.listReports = async (req, res) => {
  try {
    const query = {};

    if (req.query.status) {
      if (!AppealReport.STATUSES.includes(req.query.status)) {
        return fail(res, 400, 'Invalid status filter');
      }
      query.status = req.query.status;
    }

    const reports = await AppealReport.find(query)
      .sort({ createdAt: -1 })
      .limit(MAX_LIST);

    return res.status(200).json({
      success: true,
      count: reports.length,
      data: reports.map((report) => report.toRow()),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load reports');
  }
};

/**
 * GET /api/appeals/statistics/:id
 */
exports.getReport = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid report id');

    const report = await AppealReport.findById(id)
      .populate('computedBy', 'name')
      .populate('approvedBy', 'name')
      .populate('history.by', 'name');

    if (!report) return fail(res, 404, 'Report not found');

    return res.status(200).json({
      success: true,
      data: {
        ...report.toRow(),
        history: report.history,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the report');
  }
};

/**
 * Shared by preview and create: read the period and scope off the body and
 * refuse anything that would produce a meaningless report.
 */
async function readSpec(req) {
  const from = parseDate(req.body.from, 'The period start');
  if (from.error) return { error: from.error };

  const to = parseDate(req.body.to, 'The period end');
  if (to.error) return { error: to.error };

  if (to.date <= from.date) {
    return { error: 'A reporting period must end after it begins' };
  }

  const threshold = Number(req.body.suppressionThreshold)
    || AppealReport.DEFAULT_SUPPRESSION_THRESHOLD;

  if (threshold < AppealReport.MIN_SUPPRESSION_THRESHOLD) {
    return {
      error: `A suppression threshold below ${AppealReport.MIN_SUPPRESSION_THRESHOLD} does not suppress anything meaningful`,
    };
  }

  const scope = req.body.scope === 'course' ? 'course' : 'whole-school';
  let course = null;
  let courseName = '';

  if (scope === 'course') {
    if (!isValidId(req.body.course)) return { error: 'Invalid course id' };

    const found = await Course.findById(req.body.course).select('name');
    if (!found) return { error: 'Course not found' };

    course = found._id;
    courseName = found.name || '';
  }

  return { from: from.date, to: to.date, threshold, scope, course, courseName };
}

/**
 * POST /api/appeals/statistics/preview
 *
 * The figures without a document. Somebody choosing a threshold needs to see
 * how much it suppresses before committing a report to the record.
 */
exports.previewReport = async (req, res) => {
  try {
    const spec = await readSpec(req);
    if (spec.error) return fail(res, 400, spec.error);

    const figures = await computeFigures({
      from: spec.from,
      to: spec.to,
      courseId: spec.course,
      threshold: spec.threshold,
    });

    return res.status(200).json({
      success: true,
      data: {
        ...figures,
        period: { from: spec.from, to: spec.to },
        suppressionThreshold: spec.threshold,
        computedAt: new Date(),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to compute the preview');
  }
};

/**
 * POST /api/appeals/statistics
 *
 * Compute once and store the result. The figures *are* the report from here
 * on: they do not move when a new appeal is decided next week, which is the
 * whole difference between this and the live `getStats`.
 */
exports.createReport = async (req, res) => {
  try {
    const spec = await readSpec(req);
    if (spec.error) return fail(res, 400, spec.error);

    const label = String(req.body.periodLabel || '').trim();
    if (!label) return fail(res, 400, 'A period label is required');

    const academicYear = String(req.body.academicYear || '').trim();

    const existing = await AppealReport.findOne({
      academicYear,
      'period.label': label,
      scope: spec.scope,
      course: spec.course,
      isLive: true,
    });

    // A correction supersedes rather than overwrites, so a live report for the
    // same period is either replaced deliberately or left alone.
    if (existing && !req.body.supersede) {
      return fail(
        res,
        409,
        `A ${existing.status} report already covers ${label}. Re-send with supersede: true to replace it`,
        { existingReportId: existing._id }
      );
    }

    const figures = await computeFigures({
      from: spec.from,
      to: spec.to,
      courseId: spec.course,
      threshold: spec.threshold,
    });

    const report = new AppealReport({
      title:
        String(req.body.title || '').trim() ||
        `Appeal outcomes — ${label}${spec.courseName ? ` — ${spec.courseName}` : ''}`,
      academicYear,
      period: { label, from: spec.from, to: spec.to },
      scope: spec.scope,
      course: spec.course,
      courseName: spec.courseName,
      suppressionThreshold: spec.threshold,
      rows: figures.rows,
      totals: figures.totals,
      byReason: figures.byReason,
      narrative: String(req.body.narrative || '').trim(),
      computedBy: req.user._id,
      computedByName: req.user.name || '',
      computedAt: new Date(),
      status: 'draft',
      supersedes: existing ? existing._id : null,
    });

    report.log('computed', req.user, `${figures.totals.submitted} appeals`);

    // The old report leaves `isLive` first, so the unique index is free when
    // the new one is written.
    if (existing) {
      existing.supersededBy = report._id;

      if (existing.status === 'published') {
        existing.withdraw(req.user, `Superseded by a recomputed report for ${label}`);
      } else {
        existing.status = 'withdrawn';
        existing.withdrawnBy = req.user._id;
        existing.withdrawnAt = new Date();
        existing.withdrawalReason = `Superseded by a recomputed report for ${label}`;
        existing.log('superseded', req.user);
      }

      await existing.save();
    }

    await report.save();

    return res.status(201).json({
      success: true,
      message:
        'Report computed. Somebody other than you has to approve it before it can be published.',
      data: report.toRow(),
    });
  } catch (error) {
    const duplicate = duplicateMessage(error);
    if (duplicate) return fail(res, 409, duplicate);

    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 400, message);

    return serverError(res, error, 'Failed to compute the report');
  }
};

/**
 * PATCH /api/appeals/statistics/:id/threshold
 *
 * Drafts only, and it recomputes rather than re-suppressing what is stored —
 * suppression is lossy, so raising a threshold on already-suppressed rows
 * cannot be undone by lowering it again.
 */
exports.setThreshold = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid report id');

    const threshold = Number(req.body.suppressionThreshold);
    if (!Number.isFinite(threshold) || threshold < AppealReport.MIN_SUPPRESSION_THRESHOLD) {
      return fail(
        res,
        400,
        `A suppression threshold below ${AppealReport.MIN_SUPPRESSION_THRESHOLD} does not suppress anything meaningful`
      );
    }

    const report = await AppealReport.findById(id);
    if (!report) return fail(res, 404, 'Report not found');

    if (report.status !== 'draft') {
      return fail(res, 409, `A ${report.status} report cannot be recomputed`);
    }

    const figures = await computeFigures({
      from: report.period.from,
      to: report.period.to,
      courseId: report.course,
      threshold,
    });

    report.suppressionThreshold = threshold;
    report.rows = figures.rows;
    report.totals = figures.totals;
    report.byReason = figures.byReason;
    report.computedAt = new Date();
    report.checksum = '';

    report.log('recomputed', req.user, `threshold ${threshold}`);
    await report.save();

    return res.status(200).json({
      success: true,
      message: 'Report recomputed',
      data: report.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to recompute the report');
  }
};

/**
 * PATCH /api/appeals/statistics/:id/approve
 */
exports.approveReport = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid report id');

    const report = await AppealReport.findById(id);
    if (!report) return fail(res, 404, 'Report not found');

    if (String(report.computedBy) === String(req.user._id)) {
      return fail(
        res,
        409,
        'You computed this report, so somebody else has to approve it'
      );
    }

    report.approve(req.user);
    await report.save();

    return res.status(200).json({
      success: true,
      message: 'Report approved',
      data: report.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 409, message);
    return serverError(res, error, 'Failed to approve the report');
  }
};

/**
 * PATCH /api/appeals/statistics/:id/publish
 */
exports.publishReport = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid report id');

    const report = await AppealReport.findById(id);
    if (!report) return fail(res, 404, 'Report not found');

    report.publish(req.user);
    await report.save();

    return res.status(200).json({
      success: true,
      message: 'Report published',
      data: report.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 409, message);
    return serverError(res, error, 'Failed to publish the report');
  }
};

/**
 * PATCH /api/appeals/statistics/:id/withdraw
 */
exports.withdrawReport = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid report id');

    const { reason } = req.body;
    if (!reason || !String(reason).trim()) {
      return fail(res, 400, 'A withdrawal reason is required');
    }

    const report = await AppealReport.findById(id);
    if (!report) return fail(res, 404, 'Report not found');

    report.withdraw(req.user, reason);
    await report.save();

    return res.status(200).json({
      success: true,
      message: 'Report withdrawn',
      data: report.toRow(),
    });
  } catch (error) {
    const message = validationMessage(error) || error.message;
    if (message) return fail(res, 409, message);
    return serverError(res, error, 'Failed to withdraw the report');
  }
};
