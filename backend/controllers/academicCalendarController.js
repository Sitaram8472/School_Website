const mongoose = require('mongoose');
const AcademicTerm = require('../models/AcademicTerm');

/**
 * The academic calendar.
 *
 * Two handlers matter beyond the CRUD.
 *
 * `getWorkingDays` is the endpoint the rest of the codebase needs and does not
 * have: the instructional-day count for any range. That is the honest
 * attendance denominator, and until something can produce it, an attendance
 * percentage is a number divided by however many rows happen to exist.
 *
 * `addException` expands a range server-side and refuses the three cases that
 * silently do nothing today — an exception outside its term, one that runs past
 * the term end, and a `working-day` on a day that already works.
 *
 * Every count in this file comes from `term.summary()`, which walks the term
 * and classifies each date once. Nothing here increments a stored total.
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

function isAdmin(user) {
  return user && user.role === 'admin';
}

function parseDate(value, fieldLabel) {
  if (value === undefined || value === null || value === '') return { value: undefined };
  const date = AcademicTerm.toDayStart(value);
  if (!date) return { error: `${fieldLabel} is not a valid date` };
  return { value: date };
}

/** Non-admins never see a draft. A draft calendar read as final is how four sources of term dates became five. */
function visibilityQuery(user) {
  return isAdmin(user) ? {} : { status: 'published' };
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/**
 * GET /api/academic-calendar/meta
 */
exports.getMeta = async (req, res) => {
  try {
    return ok(res, {
      termNames: AcademicTerm.TERM_NAMES,
      statuses: AcademicTerm.STATUSES,
      exceptionKinds: AcademicTerm.EXCEPTION_KINDS,
      dayKinds: AcademicTerm.DAY_KINDS,
      kindPrecedence: AcademicTerm.KIND_PRECEDENCE,
      annualStatutoryTarget: AcademicTerm.ANNUAL_STATUTORY_TARGET,
      maxExceptions: AcademicTerm.MAX_EXCEPTIONS,
    });
  } catch (error) {
    return serverError(res, error, 'Could not load calendar reference data');
  }
};

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

/**
 * POST /api/academic-calendar/terms
 */
exports.createTerm = async (req, res) => {
  try {
    const { session, name, label, startDate, endDate, weeklyOffDays, statutoryTarget } = req.body;

    const start = parseDate(startDate, 'Start date');
    if (start.error) return fail(res, 400, start.error);
    if (!start.value) return fail(res, 400, 'A start date is required');

    const end = parseDate(endDate, 'End date');
    if (end.error) return fail(res, 400, end.error);
    if (!end.value) return fail(res, 400, 'An end date is required');

    const term = new AcademicTerm({
      session,
      name,
      label,
      startDate: start.value,
      endDate: end.value,
      weeklyOffDays: Array.isArray(weeklyOffDays) ? weeklyOffDays : undefined,
      statutoryTarget,
      status: 'draft',
    });

    const clash = await findOverlap(term);
    if (clash) {
      return fail(
        res,
        409,
        `These dates overlap ${clash.label || clash.name} (${clash.startDate
          .toISOString()
          .slice(0, 10)} to ${clash.endDate.toISOString().slice(0, 10)}). Two terms claiming the same day makes every count ambiguous.`
      );
    }

    term.recordHistory({
      action: 'created',
      by: req.user._id,
      note: `${start.value.toISOString().slice(0, 10)} to ${end.value.toISOString().slice(0, 10)}`,
    });

    await term.save();

    return res.status(201).json({
      success: true,
      message: 'Term created as a draft',
      data: term.toDetail(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not create the term');
  }
};

/**
 * The other term of this session whose dates overlap `term`, or null.
 *
 * Checked against the stored siblings rather than trusted from the request,
 * and excludes the term itself so an edit does not clash with its own old row.
 */
async function findOverlap(term) {
  const siblings = await AcademicTerm.find({
    session: term.session,
    _id: { $ne: term._id },
    status: { $ne: 'archived' },
  });

  return siblings.find((sibling) => term.overlaps(sibling)) || null;
}

/**
 * PATCH /api/academic-calendar/terms/:id
 */
exports.updateTerm = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid term id');

    const term = await AcademicTerm.findById(id);
    if (!term) return fail(res, 404, 'Term not found');
    if (term.status === 'archived') {
      return fail(res, 409, 'An archived term is a record of a year that happened');
    }

    const changed = [];

    for (const [field, label] of [
      ['startDate', 'Start date'],
      ['endDate', 'End date'],
    ]) {
      if (req.body[field] === undefined) continue;
      const parsed = parseDate(req.body[field], label);
      if (parsed.error) return fail(res, 400, parsed.error);
      term[field] = parsed.value;
      changed.push(field);
    }

    for (const field of ['label', 'statutoryTarget']) {
      if (req.body[field] === undefined) continue;
      term[field] = req.body[field];
      changed.push(field);
    }

    if (Array.isArray(req.body.weeklyOffDays)) {
      term.weeklyOffDays = req.body.weeklyOffDays;
      changed.push('weeklyOffDays');
    }

    if (!changed.length) return fail(res, 400, 'Nothing to update');

    if (changed.includes('startDate') || changed.includes('endDate')) {
      const clash = await findOverlap(term);
      if (clash) {
        return fail(res, 409, `These dates overlap ${clash.label || clash.name}`);
      }

      // Narrowing a term can strand exceptions outside it. The schema would
      // reject the save; saying which ones is more use than saying that.
      const stranded = (term.exceptions || []).filter((exception) => {
        const last = exception.endDate || exception.date;
        return exception.date < term.startDate || last > term.endDate;
      });
      if (stranded.length) {
        return fail(
          res,
          409,
          `Those dates would leave ${stranded.length} exception(s) outside the term: ${stranded
            .map((exception) => exception.title)
            .join(', ')}`
        );
      }
    }

    term.recordHistory({
      action: 'updated',
      by: req.user._id,
      note: `Changed ${changed.join(', ')}`,
    });

    await term.save();
    return ok(res, term.toDetail(), { message: 'Term updated' });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not update the term');
  }
};

/**
 * PATCH /api/academic-calendar/terms/:id/status
 */
exports.setStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid term id');
    if (!AcademicTerm.STATUSES.includes(status)) return fail(res, 400, 'Invalid status');

    const term = await AcademicTerm.findById(id);
    if (!term) return fail(res, 404, 'Term not found');
    if (term.status === status) return fail(res, 400, `This term is already ${status}`);
    if (term.status === 'archived') {
      return fail(res, 409, 'An archived term cannot be reopened');
    }

    const previous = term.status;
    term.status = status;

    term.recordHistory({
      action: 'status-changed',
      by: req.user._id,
      note: `${previous} to ${status}`,
    });

    await term.save();

    const summary = term.summary();
    return ok(res, term.toDetail(), {
      message:
        status === 'published' && summary.shortfall
          ? `Published. This term delivers ${summary.instructionalDays} instructional days, ${summary.shortfall} short of the ${summary.statutoryTarget} apportioned to it.`
          : `Term ${status}`,
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not change the term status');
  }
};

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

/**
 * POST /api/academic-calendar/terms/:id/exceptions
 *
 * A range is one row, not nine. The refusals here are the ones that currently
 * fail silently.
 */
exports.addException = async (req, res) => {
  try {
    const { id } = req.params;
    const { date, endDate, kind, title, note } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid term id');
    if (!AcademicTerm.EXCEPTION_KINDS.includes(kind)) {
      return fail(res, 400, 'Invalid exception kind');
    }
    if (!title || String(title).trim().length < 2) {
      return fail(res, 400, 'An exception needs a title — it is what the calendar shows');
    }

    const term = await AcademicTerm.findById(id);
    if (!term) return fail(res, 404, 'Term not found');
    if (term.status === 'archived') {
      return fail(res, 409, 'An archived term cannot be changed');
    }

    const from = parseDate(date, 'Date');
    if (from.error) return fail(res, 400, from.error);
    if (!from.value) return fail(res, 400, 'A date is required');

    const to = parseDate(endDate, 'End date');
    if (to.error) return fail(res, 400, to.error);
    if (to.value && to.value < from.value) {
      return fail(res, 400, 'The range ends before it starts');
    }

    const last = to.value || from.value;

    if (from.value < term.startDate || last > term.endDate) {
      // Refused rather than truncated. A half-term silently clipped to the
      // term end is a calendar that disagrees with the letter home.
      return fail(
        res,
        400,
        `That range runs outside the term (${term.startDate
          .toISOString()
          .slice(0, 10)} to ${term.endDate.toISOString().slice(0, 10)}).`
      );
    }

    if ((term.exceptions || []).length >= AcademicTerm.MAX_EXCEPTIONS) {
      return fail(res, 409, 'This term already carries the maximum number of exceptions');
    }

    // A working day declared on a day that already works means somebody has
    // misread the weekly pattern, and the row would do nothing.
    if (kind === 'working-day') {
      const alreadyWorking = [];
      for (
        let cursor = from.value;
        cursor <= last;
        cursor = AcademicTerm.addDays(cursor, 1)
      ) {
        if (!term.weeklyOffDays.includes(cursor.getUTCDay())) {
          alreadyWorking.push(cursor.toISOString().slice(0, 10));
        }
      }
      if (alreadyWorking.length) {
        return fail(
          res,
          400,
          `${alreadyWorking.slice(0, 3).join(', ')}${
            alreadyWorking.length > 3 ? ` and ${alreadyWorking.length - 3} more` : ''
          } already fall on working days, so this would have no effect.`
        );
      }
    }

    // What the classification actually changes. Computed before and after so
    // the response can say what this row did rather than that it was saved.
    const before = term.summary().instructionalDays;

    term.exceptions.push({
      date: from.value,
      endDate: to.value,
      kind,
      title,
      note,
      addedBy: req.user._id,
      addedAt: new Date(),
    });

    const after = term.summary().instructionalDays;
    const delta = after - before;

    term.recordHistory({
      action: 'exception-added',
      by: req.user._id,
      note: `${kind}: ${title} (${delta >= 0 ? '+' : ''}${delta} instructional days)`,
    });

    await term.save();

    return res.status(201).json({
      success: true,
      message:
        delta === 0
          ? `"${title}" recorded. It does not change the instructional-day count — those days were already closed.`
          : `"${title}" recorded. Instructional days ${delta > 0 ? 'up' : 'down'} by ${Math.abs(delta)}.`,
      data: term.toDetail(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not add the exception');
  }
};

/**
 * DELETE /api/academic-calendar/terms/:id/exceptions/:eid
 */
exports.removeException = async (req, res) => {
  try {
    const { id, eid } = req.params;
    if (!isValidId(id) || !isValidId(eid)) return fail(res, 400, 'Invalid id');

    const term = await AcademicTerm.findById(id);
    if (!term) return fail(res, 404, 'Term not found');
    if (term.status === 'archived') {
      return fail(res, 409, 'An archived term cannot be changed');
    }

    const exception = term.exceptions.id(eid);
    if (!exception) return fail(res, 404, 'Exception not found on this term');

    const title = exception.title;
    const before = term.summary().instructionalDays;
    exception.deleteOne();
    const after = term.summary().instructionalDays;

    term.recordHistory({
      action: 'exception-removed',
      by: req.user._id,
      note: `${title} (${after - before >= 0 ? '+' : ''}${after - before} instructional days)`,
    });

    await term.save();
    return ok(res, term.toDetail(), { message: `"${title}" removed` });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not remove the exception');
  }
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * GET /api/academic-calendar/terms
 */
exports.listTerms = async (req, res) => {
  try {
    const query = visibilityQuery(req.user);
    if (req.query.session) query.session = String(req.query.session).slice(0, 10);

    const terms = await AcademicTerm.find(query).sort({ startDate: 1 }).limit(60);
    return ok(
      res,
      terms.map((term) => term.toRow()),
      { count: terms.length }
    );
  } catch (error) {
    return serverError(res, error, 'Could not load terms');
  }
};

/**
 * GET /api/academic-calendar/terms/current
 */
exports.getCurrentTerm = async (req, res) => {
  try {
    const today = AcademicTerm.toDayStart(new Date());
    const term = await AcademicTerm.findOne({
      ...visibilityQuery(req.user),
      startDate: { $lte: today },
      endDate: { $gte: today },
    });

    if (!term) {
      // Not an error. Half of August is not in a term, and answering "no" is
      // more useful than answering 404.
      return ok(res, null, { message: 'Today does not fall inside a published term' });
    }

    return ok(res, {
      ...term.toDetail(),
      today: term.classifyDay(today),
      // Instructional days left is the number a teacher planning a scheme of
      // work actually wants, and it is not knowable from a term-dates letter.
      instructionalDaysRemaining: term.instructionalDaysBetween(today, term.endDate),
    });
  } catch (error) {
    return serverError(res, error, 'Could not load the current term');
  }
};

/**
 * GET /api/academic-calendar/terms/:id
 */
exports.getTerm = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid term id');

    const term = await AcademicTerm.findById(id);
    if (!term) return fail(res, 404, 'Term not found');
    if (term.status === 'draft' && !isAdmin(req.user)) {
      return fail(res, 404, 'Term not found');
    }

    return ok(res, term.toDetail());
  } catch (error) {
    return serverError(res, error, 'Could not load the term');
  }
};

/**
 * GET /api/academic-calendar/terms/:id/days
 *
 * The full classified day walk. Every date carries its bucket and its reason,
 * so the month grid can say why the 14th is closed.
 */
exports.getTermDays = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid term id');

    const term = await AcademicTerm.findById(id);
    if (!term) return fail(res, 404, 'Term not found');
    if (term.status === 'draft' && !isAdmin(req.user)) {
      return fail(res, 404, 'Term not found');
    }

    const from = parseDate(req.query.from, 'From');
    if (from.error) return fail(res, 400, from.error);
    const to = parseDate(req.query.to, 'To');
    if (to.error) return fail(res, 400, to.error);

    const days = term.walk(from.value, to.value);
    return ok(res, days, { count: days.length });
  } catch (error) {
    return serverError(res, error, 'Could not walk the term');
  }
};

/**
 * GET /api/academic-calendar/terms/:id/summary
 */
exports.getTermSummary = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid term id');

    const term = await AcademicTerm.findById(id);
    if (!term) return fail(res, 404, 'Term not found');
    if (term.status === 'draft' && !isAdmin(req.user)) {
      return fail(res, 404, 'Term not found');
    }

    return ok(res, term.summary());
  } catch (error) {
    return serverError(res, error, 'Could not summarise the term');
  }
};

/**
 * GET /api/academic-calendar/working-days?from=&to=
 *
 * The query the rest of the codebase needs. Sums instructional days across
 * every published term the range touches, so a range spanning two terms does
 * not count the gap between them as school.
 */
exports.getWorkingDays = async (req, res) => {
  try {
    const from = parseDate(req.query.from, 'From');
    if (from.error) return fail(res, 400, from.error);
    if (!from.value) return fail(res, 400, 'A "from" date is required');

    const to = parseDate(req.query.to, 'To');
    if (to.error) return fail(res, 400, to.error);
    if (!to.value) return fail(res, 400, 'A "to" date is required');

    if (to.value < from.value) return fail(res, 400, 'The range ends before it starts');

    const terms = await AcademicTerm.find({
      ...visibilityQuery(req.user),
      startDate: { $lte: to.value },
      endDate: { $gte: from.value },
    }).sort({ startDate: 1 });

    let instructionalDays = 0;
    let schoolDays = 0;
    const perTerm = [];

    for (const term of terms) {
      const days = term.walk(from.value, to.value);
      const instructional = days.filter((day) => day.instructional).length;
      const open = days.filter((day) => day.open).length;

      instructionalDays += instructional;
      schoolDays += open;

      perTerm.push({
        termId: term._id,
        name: term.label || term.name,
        session: term.session,
        instructionalDays: instructional,
        schoolDays: open,
      });
    }

    const calendarDays = Math.round((to.value - from.value) / 86400000) + 1;

    return ok(res, {
      from: from.value,
      to: to.value,
      calendarDays,
      instructionalDays,
      schoolDays,
      perTerm,
      // Stated rather than implied: a range with no term behind it returns
      // zero, and a caller dividing by that needs to know why.
      coveredByTerms: terms.length > 0,
    });
  } catch (error) {
    return serverError(res, error, 'Could not compute working days');
  }
};

/**
 * GET /api/academic-calendar/is-school-day?date=
 */
exports.isSchoolDay = async (req, res) => {
  try {
    const parsed = parseDate(req.query.date || new Date(), 'Date');
    if (parsed.error) return fail(res, 400, parsed.error);

    const date = parsed.value;
    const term = await AcademicTerm.findOne({
      ...visibilityQuery(req.user),
      startDate: { $lte: date },
      endDate: { $gte: date },
    });

    if (!term) {
      return ok(res, {
        date,
        inTerm: false,
        open: false,
        instructional: false,
        reason: 'Outside term time',
      });
    }

    const day = term.classifyDay(date);
    return ok(res, {
      ...day,
      inTerm: true,
      termId: term._id,
      termName: term.label || term.name,
    });
  } catch (error) {
    return serverError(res, error, 'Could not classify that date');
  }
};

/**
 * GET /api/academic-calendar/session/:session/summary
 */
exports.getSessionSummary = async (req, res) => {
  try {
    const { session } = req.params;
    const terms = await AcademicTerm.find({
      ...visibilityQuery(req.user),
      session: String(session).slice(0, 10),
    }).sort({ startDate: 1 });

    if (!terms.length) return fail(res, 404, 'No terms recorded for that session');

    const rows = terms.map((term) => ({ ...term.toRow(), summary: term.summary() }));

    const totals = rows.reduce(
      (acc, row) => {
        acc.instructionalDays += row.summary.instructionalDays;
        acc.schoolDays += row.summary.schoolDays;
        acc.holidays += row.summary.holidays;
        acc.unplannedClosures += row.summary.unplannedClosures;
        acc.recoveredByWorkingDays += row.summary.recoveredByWorkingDays;
        return acc;
      },
      {
        instructionalDays: 0,
        schoolDays: 0,
        holidays: 0,
        unplannedClosures: 0,
        recoveredByWorkingDays: 0,
      }
    );

    // The statutory requirement is annual, so it is compared against the year's
    // instructional total here and never summed out of the per-term shares.
    const annualTarget = AcademicTerm.ANNUAL_STATUTORY_TARGET;

    return ok(res, {
      session,
      terms: rows,
      totals: {
        ...totals,
        annualTarget,
        shortfall: Math.max(annualTarget - totals.instructionalDays, 0),
        // Only meaningful once the whole year is on record. Two of three terms
        // will always look short, and reading that as a problem is the mistake
        // this endpoint should not encourage.
        termsRecorded: rows.length,
        complete: rows.length >= 3,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Could not summarise the session');
  }
};

exports.findOverlap = findOverlap;
