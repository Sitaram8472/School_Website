import { useState, useEffect, useCallback, useContext, useMemo } from 'react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * Year-end progression.
 *
 * For a student: nothing at all until their cohort is published, then the
 * outcome in plain words and any conditions with their dates. Not the
 * thresholds they missed by, not the reasons, and never the override note —
 * that is a professional judgement about a child, written for the staff record.
 *
 * For staff: recommendation and decision as two adjacent columns, with the
 * divergences highlighted, because that column pair *is* the review. The
 * evidence sits inline rather than behind a click, since the attendance figure
 * and the failed subjects are the argument, and hiding them behind navigation
 * is how a decision gets made without them.
 */

const OUTCOME_LABELS = {
  promote: 'Moves up',
  'promote-conditional': 'Moves up, with conditions',
  retain: 'Repeats the year',
  refer: 'Referred for a further decision',
  'insufficient-evidence': 'Not enough recorded to say',
};

const OUTCOME_STYLES = {
  promote: 'bg-green-100 text-green-700',
  'promote-conditional': 'bg-amber-100 text-amber-800',
  retain: 'bg-red-100 text-red-700',
  refer: 'bg-blue-100 text-blue-700',
  'insufficient-evidence': 'bg-gray-200 text-gray-600',
};

const CONDITION_STYLES = {
  open: 'bg-amber-100 text-amber-800',
  met: 'bg-green-100 text-green-700',
  'not-met': 'bg-red-100 text-red-700',
  waived: 'bg-gray-200 text-gray-600',
};

const outcomeLabel = (value) => OUTCOME_LABELS[value] || value || '—';

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—';

const percentText = (value) => (value === null || value === undefined ? '—' : `${value}%`);

const ProgressionPanel = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isSignedIn = Boolean(role);
  const isStaff = role === 'teacher' || role === 'admin';
  const isAdmin = role === 'admin';

  const [meta, setMeta] = useState(null);
  const [mine, setMine] = useState([]);

  const [className, setClassName] = useState('');
  const [academicYear, setAcademicYear] = useState('');
  const [cohort, setCohort] = useState(null);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 6000);
  };

  const explain = (err, fallback) =>
    setError(err?.response?.data?.message || err?.message || fallback);

  // ---- loading -------------------------------------------------------------

  const loadMeta = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const res = await api.get('/reports/progression/meta');
      setMeta(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load progression reference data.');
    }
  }, [isSignedIn]);

  const loadMine = useCallback(async () => {
    if (!isSignedIn) return;

    setLoading(true);
    try {
      const res = await api.get('/reports/progression/mine');
      setMine(res.data.data || []);
    } catch (err) {
      explain(err, 'Could not load your progression.');
    } finally {
      setLoading(false);
    }
  }, [isSignedIn]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    loadMine();
  }, [loadMine]);

  const published = cohort?.cohort?.status === 'published';

  const divergences = useMemo(
    () => (cohort?.rows || []).filter((row) => row.isOverride),
    [cohort]
  );

  // ---- acting --------------------------------------------------------------

  const loadCohort = async () => {
    if (!className || !academicYear) {
      setError('A class and an academic year are both needed.');
      return;
    }

    setError('');
    setBusy('cohort');

    try {
      const res = await api.get(
        `/reports/progression/cohorts/${encodeURIComponent(className)}/${encodeURIComponent(academicYear)}`
      );
      setCohort(res.data.data || null);
    } catch (err) {
      setCohort(null);
      explain(err, 'Could not load that cohort.');
    } finally {
      setBusy('');
    }
  };

  const generate = async () => {
    setError('');
    setBusy('generate');

    try {
      const res = await api.post(
        `/reports/progression/cohorts/${encodeURIComponent(className)}/${encodeURIComponent(academicYear)}/generate`
      );
      flash(res.data.message || 'Cohort generated.');
      loadCohort();
    } catch (err) {
      explain(err, 'Could not generate the cohort.');
    } finally {
      setBusy('');
    }
  };

  const decide = async (row, outcome) => {
    const diverges = outcome !== row.recommendation;
    let reason = '';

    if (diverges || row.recommendation === 'insufficient-evidence') {
      reason = window.prompt(
        `The recommendation is "${outcomeLabel(row.recommendation)}". Why is ${row.studentName} being recorded as "${outcomeLabel(outcome)}"?`
      );
      if (!reason) return;
    }

    setError('');
    setBusy(row._id);

    try {
      const res = await api.patch(`/reports/progression/${row._id}/decide`, { outcome, reason });
      flash(res.data.message || 'Recorded.');
      loadCohort();
    } catch (err) {
      explain(err, 'Could not record that decision.');
    } finally {
      setBusy('');
    }
  };

  const countersign = async (row) => {
    setError('');
    setBusy(row._id);

    try {
      const res = await api.patch(`/reports/progression/${row._id}/countersign`);
      flash(res.data.message || 'Countersigned.');
      loadCohort();
    } catch (err) {
      explain(err, 'Could not countersign that decision.');
    } finally {
      setBusy('');
    }
  };

  const publish = async () => {
    const confirmed = window.confirm(
      `Publishing ${className} (${academicYear}) seals every decision in it. ${divergences.length} of them depart from the recommendation. Nothing can change afterwards except settling a condition. Continue?`
    );
    if (!confirmed) return;

    setError('');
    setBusy('publish');

    try {
      const res = await api.post(
        `/reports/progression/cohorts/${encodeURIComponent(className)}/${encodeURIComponent(academicYear)}/publish`
      );
      flash(res.data.message || 'Cohort published.');
      loadCohort();
    } catch (err) {
      explain(err, 'Could not publish the cohort.');
    } finally {
      setBusy('');
    }
  };

  const settle = async (row, index, status) => {
    const note = window.prompt('Anything to record with it? (optional)');

    setError('');
    setBusy(row._id);

    try {
      const res = await api.patch(
        `/reports/progression/${row._id}/conditions/${index}/settle`,
        { status, note: note || '' }
      );
      flash(res.data.message || 'Condition settled.');
      loadCohort();
      loadMine();
    } catch (err) {
      explain(err, 'Could not settle that condition.');
    } finally {
      setBusy('');
    }
  };

  if (!isSignedIn) return null;

  return (
    <div className="bg-white rounded-3xl shadow-2xl p-6 sm:p-8 mb-10 text-left">
      <div className="mb-4">
        <h2 className="text-2xl font-bold text-blue-700">End of year</h2>
        <p className="text-sm text-gray-500 mt-1">
          Whether the year is complete, and what happens next.
        </p>
      </div>

      {error && (
        <div className="mb-4 text-sm bg-red-50 border border-red-100 text-red-700 rounded px-3 py-2">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 text-sm bg-emerald-50 border border-emerald-100 text-emerald-700 rounded px-3 py-2">
          {success}
        </div>
      )}

      {/* ---- the student's own ---- */}
      <div className="border border-gray-100 rounded-2xl p-4 mb-6">
        {loading && !mine.length ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : mine.length ? (
          <div className="space-y-3">
            {mine.map((row) => (
              <div key={row._id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-base text-gray-900 font-medium">
                      {outcomeLabel(row.decision)}
                      {row.toClass ? ` — into ${row.toClass}` : ''}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {row.academicYear} · from {row.fromClass} · published{' '}
                      {formatDate(row.publishedAt)}
                    </p>
                  </div>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      OUTCOME_STYLES[row.decision] || 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {outcomeLabel(row.decision)}
                  </span>
                </div>

                {row.conditions?.length > 0 && (
                  <div className="mt-3 space-y-2">
                    <p className="text-sm text-gray-700">What still has to happen</p>
                    {row.conditions.map((condition, index) => (
                      <div
                        key={`${condition.subject}-${index}`}
                        className="flex flex-wrap items-center justify-between gap-2 bg-gray-50 rounded-lg px-3 py-2"
                      >
                        <div>
                          <p className="text-sm text-gray-800">{condition.subject}</p>
                          <p className="text-xs text-gray-600 mt-0.5">
                            {condition.requirement} · by {formatDate(condition.dueBy)}
                          </p>
                        </div>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            CONDITION_STYLES[condition.status] || 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {condition.status}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500">
            No decision has been published for you. Decisions are published for a whole class at
            once, at the end of the year.
          </p>
        )}
      </div>

      {/* ---- staff ---- */}
      {isStaff && (
        <div className="space-y-6">
          <div className="border border-gray-100 rounded-2xl p-4">
            <div className="flex flex-wrap gap-2 items-end">
              <label className="text-sm">
                <span className="block text-xs text-gray-500 mb-1">Class</span>
                <input
                  type="text"
                  value={className}
                  onChange={(event) => setClassName(event.target.value)}
                  placeholder="Grade 8"
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
                />
              </label>
              <label className="text-sm">
                <span className="block text-xs text-gray-500 mb-1">Academic year</span>
                <input
                  type="text"
                  value={academicYear}
                  onChange={(event) => setAcademicYear(event.target.value)}
                  placeholder="2026-2027"
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
                />
              </label>
              <button
                type="button"
                disabled={busy === 'cohort'}
                onClick={loadCohort}
                className="text-sm px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50"
              >
                Open
              </button>
              {isAdmin && (
                <button
                  type="button"
                  disabled={busy === 'generate' || !className || !academicYear}
                  onClick={generate}
                  className="text-sm px-4 py-2 border border-gray-200 rounded-lg disabled:opacity-50"
                >
                  Generate
                </button>
              )}
            </div>
          </div>

          {cohort && (
            <>
              <div className="border border-gray-100 rounded-2xl p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="grid gap-3 sm:grid-cols-4 text-sm flex-1">
                    <div>
                      <p className="text-xs text-gray-500">Students</p>
                      <p className="text-gray-800">{cohort.counts.total}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Decided</p>
                      <p className="text-gray-800">
                        {cohort.counts.decided}
                        {cohort.counts.undecided > 0 && (
                          <span className="text-amber-700">
                            {' '}
                            ({cohort.counts.undecided} to go)
                          </span>
                        )}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Overrides</p>
                      <p className={cohort.counts.overrides > 0 ? 'text-amber-700' : 'text-gray-800'}>
                        {cohort.counts.overrides}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Awaiting countersignature</p>
                      <p
                        className={
                          cohort.counts.awaitingCountersign > 0 ? 'text-red-600' : 'text-gray-800'
                        }
                      >
                        {cohort.counts.awaitingCountersign}
                      </p>
                    </div>
                  </div>

                  {isAdmin && !published && (
                    <button
                      type="button"
                      disabled={busy === 'publish'}
                      onClick={publish}
                      className="text-sm px-4 py-2 bg-indigo-600 text-white rounded-lg disabled:opacity-50"
                    >
                      Publish the cohort
                    </button>
                  )}
                  {published && (
                    <span className="text-xs px-2 py-1 rounded-full bg-green-100 text-green-700">
                      Published {formatDate(cohort.cohort.publishedAt)}
                    </span>
                  )}
                </div>

                {cohort.rule && (
                  <p className="text-xs text-gray-500 mt-3">
                    Thresholds in force: {cohort.rule.minAttendancePercent}% attendance,{' '}
                    {cohort.rule.minSubjectsPassed} subject(s) passed at{' '}
                    {cohort.rule.passMarkPercent}%, at most{' '}
                    {cohort.rule.maxConditionalSubjects} condition(s), promoting into{' '}
                    {cohort.rule.promotesTo}.
                  </p>
                )}
              </div>

              <div className="border border-gray-100 rounded-2xl p-4">
                <h3 className="font-semibold text-gray-800 text-sm mb-3">
                  Recommendation against decision
                </h3>

                <div className="space-y-3">
                  {cohort.rows.map((row) => (
                    <div
                      key={row._id}
                      className={`rounded-xl px-3 py-3 ${
                        row.isOverride ? 'bg-amber-50 border border-amber-100' : 'bg-gray-50'
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900">{row.studentName}</p>
                          <p className="text-xs text-gray-600 mt-1">
                            Attendance {percentText(row.evidence?.attendancePercent)} over{' '}
                            {row.evidence?.sessionsRecorded || 0} session(s) ·{' '}
                            {row.evidence?.subjectsPassed || 0} of{' '}
                            {row.evidence?.subjectsAssessed || 0} subject(s) passed
                            {row.evidence?.subjectsFailed?.length
                              ? ` · below the pass mark in ${row.evidence.subjectsFailed.join(', ')}`
                              : ''}
                          </p>
                          {row.recommendationReasons?.length > 0 && (
                            <ul className="text-xs text-gray-500 mt-1 list-disc list-inside">
                              {row.recommendationReasons.map((reason) => (
                                <li key={reason}>{reason}</li>
                              ))}
                            </ul>
                          )}
                          {row.isOverride && row.overrideReason && (
                            <p className="text-xs text-amber-800 mt-1">
                              Override: {row.overrideReason}
                              {row.counterSignedByName
                                ? ` · countersigned by ${row.counterSignedByName}`
                                : ' · not yet countersigned'}
                            </p>
                          )}
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full ${
                              OUTCOME_STYLES[row.recommendation] || 'bg-gray-100 text-gray-600'
                            }`}
                          >
                            {outcomeLabel(row.recommendation)}
                          </span>
                          <span className="text-gray-400 text-xs">→</span>
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full ${
                              row.decision
                                ? OUTCOME_STYLES[row.decision] || 'bg-gray-100 text-gray-600'
                                : 'bg-white border border-dashed border-gray-300 text-gray-400'
                            }`}
                          >
                            {row.decision ? outcomeLabel(row.decision) : 'Not decided'}
                          </span>
                        </div>
                      </div>

                      {!published && (
                        <div className="flex flex-wrap gap-2 mt-3">
                          {(meta?.outcomes || ['promote', 'promote-conditional', 'retain', 'refer']).map(
                            (outcome) => (
                              <button
                                key={outcome}
                                type="button"
                                disabled={busy === row._id}
                                onClick={() => decide(row, outcome)}
                                className={`text-xs px-2.5 py-1 rounded border disabled:opacity-50 ${
                                  row.decision === outcome
                                    ? 'bg-blue-600 text-white border-blue-600'
                                    : 'border-gray-200 text-gray-700'
                                }`}
                              >
                                {outcomeLabel(outcome)}
                              </button>
                            )
                          )}

                          {isAdmin && row.isOverride && !row.counterSignedAt && (
                            <button
                              type="button"
                              disabled={busy === row._id}
                              onClick={() => countersign(row)}
                              className="text-xs px-2.5 py-1 rounded bg-emerald-600 text-white disabled:opacity-50"
                            >
                              Countersign
                            </button>
                          )}
                        </div>
                      )}

                      {row.conditions?.length > 0 && (
                        <div className="mt-3 space-y-1">
                          {row.conditions.map((condition, index) => (
                            <div
                              key={condition._id || index}
                              className="flex flex-wrap items-center justify-between gap-2 bg-white rounded px-2 py-1.5"
                            >
                              <p className="text-xs text-gray-700">
                                {condition.subject}: {condition.requirement} · by{' '}
                                {formatDate(condition.dueBy)}
                              </p>
                              {condition.status === 'open' ? (
                                <div className="flex gap-1">
                                  <button
                                    type="button"
                                    disabled={busy === row._id}
                                    onClick={() => settle(row, index, 'met')}
                                    className="text-xs px-2 py-0.5 rounded bg-emerald-600 text-white disabled:opacity-50"
                                  >
                                    Met
                                  </button>
                                  <button
                                    type="button"
                                    disabled={busy === row._id}
                                    onClick={() => settle(row, index, 'not-met')}
                                    className="text-xs px-2 py-0.5 rounded border border-gray-200 disabled:opacity-50"
                                  >
                                    Not met
                                  </button>
                                </div>
                              ) : (
                                <span
                                  className={`text-xs px-2 py-0.5 rounded-full ${
                                    CONDITION_STYLES[condition.status] || 'bg-gray-100'
                                  }`}
                                >
                                  {condition.status}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <p className="text-xs text-gray-500 mt-3">
                  The left badge is what the arithmetic said; the right one is what was decided. The
                  gap between the two columns is the review, so the recommendation is never
                  overwritten — a departure costs a reason and a second signature, and the cohort
                  will not publish until every one of them has both.
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default ProgressionPanel;
