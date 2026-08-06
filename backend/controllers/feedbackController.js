const mongoose = require('mongoose');
const FeedbackSurvey = require('../models/FeedbackSurvey');

/**
 * Course and teaching feedback.
 *
 * Two functions carry the module: `submitResponse`, which writes a response
 * that cannot be traced back to its author, and `getResults`, which refuses to
 * show anything until enough people have answered that a single one cannot be
 * picked out.
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

// ---------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------

/**
 * POST /api/feedback/surveys
 */
exports.createSurvey = async (req, res) => {
  try {
    const {
      title,
      description,
      type,
      course,
      courseName,
      teacher,
      teacherName,
      audience,
      targetClasses,
      opensAt,
      closesAt,
      anonymous,
      minResponsesToRelease,
      questions,
    } = req.body;

    const survey = await FeedbackSurvey.create({
      title,
      description,
      type,
      course: course && isValidId(course) ? course : null,
      courseName,
      teacher: teacher && isValidId(teacher) ? teacher : req.user._id,
      teacherName: teacherName || req.user.name || '',
      audience,
      targetClasses,
      opensAt,
      closesAt,
      // Anonymous unless the author explicitly opts out. A survey that is
      // accidentally attributable is worse than one that is deliberately so,
      // because the respondents were told otherwise.
      anonymous: anonymous === false ? false : true,
      minResponsesToRelease,
      questions: (Array.isArray(questions) ? questions : []).map((question, index) => ({
        ...question,
        order: question.order ?? index,
      })),
      status: 'draft',
      createdBy: req.user._id,
      createdByName: req.user.name || '',
      // `responses` is server-owned and deliberately absent.
    });

    return res.status(201).json({
      success: true,
      message: `"${survey.title}" saved as a draft. Publish it when you are ready to collect.`,
      data: survey.formFor(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to create the survey');
  }
};

/**
 * GET /api/feedback/surveys
 * Open surveys addressed to this user.
 */
exports.getOpenSurveys = async (req, res) => {
  try {
    const now = new Date();

    const surveys = await FeedbackSurvey.find({
      status: 'open',
      opensAt: { $lte: now },
      closesAt: { $gte: now },
    })
      .sort({ closesAt: 1 })
      .limit(100);

    const forMe = surveys.filter((survey) => survey.isForAudience(req.user));

    // Recomputing the caller's own key tells them which surveys they have
    // already done without the server ever holding the link between a person
    // and their answers.
    const done = new Set();
    forMe.forEach((survey) => {
      const key = FeedbackSurvey.respondentKeyFor(survey._id, req.user._id);
      if (survey.responses.some((response) => response.respondentKey === key)) {
        done.add(String(survey._id));
      }
    });

    return res.status(200).json({
      success: true,
      count: forMe.length,
      data: forMe.map((survey) => ({
        ...survey.formFor(),
        alreadySubmitted: done.has(String(survey._id)),
      })),
      vocabulary: {
        questionTypes: FeedbackSurvey.QUESTION_TYPES,
        audiences: FeedbackSurvey.AUDIENCES,
        types: FeedbackSurvey.SURVEY_TYPES,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch surveys');
  }
};

/**
 * GET /api/feedback/surveys/mine
 */
exports.getMySurveys = async (req, res) => {
  try {
    const filter = req.user.role === 'admin' ? {} : { createdBy: req.user._id };
    const surveys = await FeedbackSurvey.find(filter).sort({ createdAt: -1 }).limit(200);

    return res.status(200).json({
      success: true,
      count: surveys.length,
      data: surveys.map((survey) => ({
        ...survey.formFor(),
        resultsReleased: survey.resultsReleased,
      })),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch your surveys');
  }
};

/**
 * GET /api/feedback/surveys/:id
 */
exports.getSurvey = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid survey id.');

    const survey = await FeedbackSurvey.findById(req.params.id);
    if (!survey) return fail(res, 404, 'Survey not found.');

    const owner = survey.isOwnedBy(req.user);
    if (!owner && !survey.isForAudience(req.user)) {
      return fail(res, 403, 'This survey is not addressed to you.');
    }
    if (!owner && survey.status === 'draft') {
      return fail(res, 404, 'Survey not found.');
    }

    const key = FeedbackSurvey.respondentKeyFor(survey._id, req.user._id);

    return res.status(200).json({
      success: true,
      data: survey.formFor(),
      alreadySubmitted: survey.responses.some((response) => response.respondentKey === key),
      unavailableReason: survey.submissionError(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the survey');
  }
};

/**
 * PATCH /api/feedback/surveys/:id
 *
 * Once anybody has answered, the questions are frozen. Editing question 3 after
 * forty people have answered it does not update forty answers — it silently
 * reinterprets them, and every chart built afterwards is wrong in a way nobody
 * can see.
 */
exports.updateSurvey = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid survey id.');

    const survey = await FeedbackSurvey.findById(req.params.id);
    if (!survey) return fail(res, 404, 'Survey not found.');
    if (!survey.isOwnedBy(req.user)) {
      return fail(res, 403, 'You can only edit your own surveys.');
    }

    const hasResponses = survey.responses.length > 0;

    if (req.body.questions !== undefined) {
      if (hasResponses) {
        return fail(
          res,
          409,
          `${survey.responses.length} people have already answered; the questions can no longer be changed. Close this survey and publish a new one.`
        );
      }
      survey.questions = req.body.questions.map((question, index) => ({
        ...question,
        order: question.order ?? index,
      }));
    }

    if (req.body.anonymous !== undefined) {
      if (hasResponses) {
        return fail(
          res,
          409,
          'Anonymity cannot be changed once responses exist — people answered under the terms they were shown.'
        );
      }
      survey.anonymous = Boolean(req.body.anonymous);
    }

    ['title', 'description', 'courseName', 'teacherName', 'closesAt', 'targetClasses'].forEach(
      (field) => {
        if (req.body[field] !== undefined) survey[field] = req.body[field];
      }
    );

    // The threshold may only go up. Lowering it after the fact would release
    // responses that were given on the understanding they would be pooled.
    if (req.body.minResponsesToRelease !== undefined) {
      const next = Number(req.body.minResponsesToRelease);
      if (hasResponses && next < survey.minResponsesToRelease) {
        return fail(
          res,
          409,
          'The release threshold cannot be lowered once responses exist.'
        );
      }
      survey.minResponsesToRelease = next;
    }

    await survey.save();

    return res.status(200).json({
      success: true,
      message: 'Survey updated.',
      data: survey.formFor(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update the survey');
  }
};

/**
 * PATCH /api/feedback/surveys/:id/publish
 */
exports.publishSurvey = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid survey id.');

    const survey = await FeedbackSurvey.findById(req.params.id);
    if (!survey) return fail(res, 404, 'Survey not found.');
    if (!survey.isOwnedBy(req.user)) {
      return fail(res, 403, 'You can only publish your own surveys.');
    }
    if (survey.status !== 'draft') {
      return fail(res, 409, `This survey is already ${survey.status}.`);
    }
    if (survey.questions.length === 0) {
      return fail(res, 400, 'A survey with no questions cannot be published.');
    }

    survey.status = 'open';
    await survey.save();

    return res.status(200).json({
      success: true,
      message: `"${survey.title}" is now collecting responses.`,
      data: survey.formFor(),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to publish the survey');
  }
};

/**
 * PATCH /api/feedback/surveys/:id/close
 */
exports.closeSurvey = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid survey id.');

    const survey = await FeedbackSurvey.findById(req.params.id);
    if (!survey) return fail(res, 404, 'Survey not found.');
    if (!survey.isOwnedBy(req.user)) {
      return fail(res, 403, 'You can only close your own surveys.');
    }

    survey.status = 'closed';
    await survey.save();

    return res.status(200).json({
      success: true,
      message: survey.resultsReleased
        ? `Closed with ${survey.responses.length} responses. Results are available.`
        : `Closed with ${survey.responses.length} responses — below the release threshold of ${survey.minResponsesToRelease}, so the results stay sealed.`,
      data: survey.formFor(),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to close the survey');
  }
};

/**
 * DELETE /api/feedback/surveys/:id
 * Only while it has no responses. Deleting a survey people answered destroys
 * feedback they gave on the understanding it would be read.
 */
exports.deleteSurvey = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid survey id.');

    const survey = await FeedbackSurvey.findById(req.params.id);
    if (!survey) return fail(res, 404, 'Survey not found.');
    if (!survey.isOwnedBy(req.user)) {
      return fail(res, 403, 'You can only delete your own surveys.');
    }
    if (survey.responses.length > 0) {
      return fail(
        res,
        409,
        `${survey.responses.length} people have answered this. Close it instead of deleting it.`
      );
    }

    await survey.deleteOne();

    return res.status(200).json({ success: true, message: 'Survey deleted.' });
  } catch (error) {
    return serverError(res, error, 'Failed to delete the survey');
  }
};

// ---------------------------------------------------------------------------
// Responding
// ---------------------------------------------------------------------------

/**
 * POST /api/feedback/surveys/:id/responses
 *
 * The response carries `respondentKey` — an HMAC of the survey id and the
 * user id — and, on an anonymous survey, nothing else that identifies anybody.
 * `req.user._id` is never written to the document.
 *
 * The duplicate check is the `$not`/`$elemMatch` clause in the filter rather
 * than a read above the write: two taps on a slow connection would otherwise
 * both read "not yet submitted" and both push. Because the key is
 * deterministic, the filter can express "this person has not answered" without
 * the document ever having to say who this person is.
 */
exports.submitResponse = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid survey id.');

    const survey = await FeedbackSurvey.findById(req.params.id);
    if (!survey) return fail(res, 404, 'Survey not found.');

    // Read up front so the respondent gets the real reason rather than a bare
    // "could not submit" from the conditional update below.
    const blocked = survey.submissionError(req.user);
    if (blocked) return fail(res, 409, blocked);

    const invalid = survey.validateAnswers(req.body.answers);
    if (invalid) return fail(res, 400, invalid);

    const key = FeedbackSurvey.respondentKeyFor(survey._id, req.user._id);

    if (survey.responses.some((response) => response.respondentKey === key)) {
      return fail(res, 409, 'You have already answered this survey.');
    }

    const response = {
      _id: new mongoose.Types.ObjectId(),
      respondentKey: key,
      // Written only when the author explicitly made the survey attributable.
      respondent: survey.anonymous ? null : req.user._id,
      audienceRole: req.user.role || '',
      answers: req.body.answers.map((answer) => ({
        question: answer.question,
        value: answer.value,
      })),
      submittedAt: new Date(),
    };

    const now = new Date();

    const updated = await FeedbackSurvey.findOneAndUpdate(
      {
        _id: survey._id,
        status: 'open',
        opensAt: { $lte: now },
        closesAt: { $gte: now },
        responses: { $not: { $elemMatch: { respondentKey: key } } },
      },
      { $push: { responses: response } },
      { new: true }
    );

    if (!updated) {
      const current = await FeedbackSurvey.findById(survey._id);
      if (!current) return fail(res, 404, 'Survey not found.');
      if (current.responses.some((item) => item.respondentKey === key)) {
        return fail(res, 409, 'You have already answered this survey.');
      }
      return fail(res, 409, current.submissionError(req.user) || 'This survey closed while you were answering.');
    }

    return res.status(201).json({
      success: true,
      message: survey.anonymous
        ? 'Thank you. Your answers were recorded without your name attached to them.'
        : 'Thank you. Your answers were recorded.',
      // The count, never the responses.
      responseCount: updated.responses.length,
      resultsReleaseAt: updated.minResponsesToRelease,
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record your response');
  }
};

/**
 * GET /api/feedback/my-submissions
 *
 * Which surveys the caller has answered, derived by recomputing their own key.
 * It confirms *that* they responded without revealing *what* they said — the
 * server genuinely cannot reconstruct the second, which is the point.
 */
exports.getMySubmissions = async (req, res) => {
  try {
    const surveys = await FeedbackSurvey.find({
      status: { $in: ['open', 'closed'] },
    })
      .sort({ createdAt: -1 })
      .limit(200);

    const submitted = surveys
      .filter((survey) => {
        const key = FeedbackSurvey.respondentKeyFor(survey._id, req.user._id);
        return survey.responses.some((response) => response.respondentKey === key);
      })
      .map((survey) => ({
        _id: survey._id,
        title: survey.title,
        type: survey.type,
        courseName: survey.courseName,
        closesAt: survey.closesAt,
        status: survey.status,
      }));

    return res.status(200).json({ success: true, count: submitted.length, data: submitted });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch your submissions');
  }
};

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * GET /api/feedback/surveys/:id/results
 *
 * Sealed until `minResponsesToRelease` responses are in — for the author too.
 *
 * In a class of three, "one respondent rated this 1/5" is attributable by
 * anybody who knows the class, and the author is the person most likely to know
 * it. Exempting them because it is their survey is how this control gets
 * removed in practice, so it is not exempted.
 */
exports.getResults = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid survey id.');

    const survey = await FeedbackSurvey.findById(req.params.id);
    if (!survey) return fail(res, 404, 'Survey not found.');
    if (!survey.isOwnedBy(req.user)) {
      return fail(res, 403, 'You can only read results for your own surveys.');
    }

    if (survey.responses.length < survey.minResponsesToRelease) {
      return res.status(200).json({
        success: true,
        released: false,
        responseCount: survey.responses.length,
        minResponsesToRelease: survey.minResponsesToRelease,
        message: `${survey.responses.length} of ${survey.minResponsesToRelease} responses needed. Results stay sealed below the threshold — with this few, an individual answer would be identifiable.`,
        data: null,
      });
    }

    return res.status(200).json({
      success: true,
      released: true,
      survey: survey.formFor(),
      results: survey.aggregate(),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to compute the results');
  }
};

/**
 * GET /api/feedback/stats
 */
exports.getStats = async (req, res) => {
  try {
    const filter = req.user.role === 'admin' ? {} : { createdBy: req.user._id };
    const surveys = await FeedbackSurvey.find(filter).select(
      'status responses minResponsesToRelease anonymous type closesAt'
    );

    const stats = {
      totalSurveys: surveys.length,
      draft: 0,
      open: 0,
      closed: 0,
      anonymous: 0,
      totalResponses: 0,
      released: 0,
      sealed: 0,
    };

    surveys.forEach((survey) => {
      if (survey.status === 'draft') stats.draft += 1;
      if (survey.status === 'open') stats.open += 1;
      if (survey.status === 'closed') stats.closed += 1;
      if (survey.anonymous) stats.anonymous += 1;

      stats.totalResponses += survey.responses.length;

      if (survey.status !== 'draft') {
        if (survey.responses.length >= survey.minResponsesToRelease) stats.released += 1;
        else stats.sealed += 1;
      }
    });

    stats.averageResponses =
      surveys.length > 0 ? Math.round(stats.totalResponses / surveys.length) : 0;

    return res.status(200).json({ success: true, stats });
  } catch (error) {
    return serverError(res, error, 'Failed to compute feedback statistics');
  }
};
