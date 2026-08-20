import { useState, useEffect, useContext, useCallback } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * Exam re-evaluation appeals.
 *
 * For a student the page leads with the deadline, as a countdown per
 * submission. That is the single fact an email thread never carries, and it is
 * the reason appeals arrive eleven weeks late today.
 *
 * Opening an appeal starts from the student's actual answers, so disputing
 * question 7 is a click on question 7 rather than a paragraph describing it.
 *
 * For a reviewer the decision panel puts awarded, claimed and revised marks
 * side by side with a running delta, and refuses to submit a non-zero delta
 * without a note — the same refusal the server makes, applied early so the
 * round trip is not wasted.
 */

const REASON_LABELS = {
  'calculation-error': 'Marks added up wrongly',
  'unmarked-answer': 'An answer was not marked',
  'marking-scheme-mismatch': 'Does not match the marking scheme',
  'answer-misread': 'The answer was misread',
  'technical-issue': 'A technical problem during the exam',
  other: 'Other',
};

const STATUS_STYLES = {
  submitted: 'bg-amber-100 text-amber-800',
  'under-review': 'bg-blue-100 text-blue-700',
  accepted: 'bg-green-100 text-green-700',
  'partially-accepted': 'bg-emerald-100 text-emerald-800',
  rejected: 'bg-red-100 text-red-700',
  withdrawn: 'bg-gray-200 text-gray-600',
};

const STATUS_LABELS = {
  submitted: 'Awaiting a reviewer',
  'under-review': 'Under review',
  accepted: 'Upheld',
  'partially-accepted': 'Partly upheld',
  rejected: 'Not upheld',
  withdrawn: 'Withdrawn',
};

const DECISION_LABELS = {
  pending: 'Not yet decided',
  upheld: 'Upheld',
  'partially-upheld': 'Partly upheld',
  rejected: 'Not upheld',
};

const StatusChip = ({ status }) => (
  <span
    className={`px-2 py-0.5 rounded text-xs font-medium ${
      STATUS_STYLES[status] || 'bg-gray-100 text-gray-700'
    }`}
  >
    {STATUS_LABELS[status] || status}
  </span>
);

/** "6 days left" is actionable; a date is not. */
const Countdown = ({ days }) => {
  if (days === null || days === undefined) return null;
  if (days <= 0) {
    return <span className="text-xs text-gray-500">Window closed</span>;
  }
  return (
    <span
      className={`text-xs font-medium ${
        days <= 3 ? 'text-red-600' : days <= 7 ? 'text-amber-700' : 'text-gray-500'
      }`}
    >
      {days} {days === 1 ? 'day' : 'days'} left to appeal
    </span>
  );
};

const RemarkAppeals = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isStaff = role === 'teacher' || role === 'admin';

  const [tab, setTab] = useState(isStaff ? 'queue' : 'mine');
  const [meta, setMeta] = useState(null);

  const [appeals, setAppeals] = useState([]);
  const [appealable, setAppealable] = useState([]);
  const [queue, setQueue] = useState([]);
  const [detail, setDetail] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // The submission an appeal is being drafted against, and the draft itself.
  const [draftFor, setDraftFor] = useState(null);
  const [draft, setDraft] = useState({
    reason: 'calculation-error',
    narrative: '',
    disputed: {},
  });

  // The reviewer's decision panel.
  const [decisionNote, setDecisionNote] = useState('');

  const readError = (err, fallback) => err?.response?.data?.message || fallback;

  const clearMessages = () => {
    setError('');
    setNotice('');
  };

  const loadMeta = useCallback(async () => {
    try {
      const { data } = await api.get('/appeals/meta');
      setMeta(data.data);
    } catch {
      // The form falls back to its own labels.
    }
  }, []);

  const loadMine = useCallback(async () => {
    setLoading(true);
    try {
      const [appealsRes, appealableRes] = await Promise.all([
        api.get('/appeals/mine'),
        api.get('/appeals/appealable'),
      ]);
      setAppeals(appealsRes.data.data || []);
      setAppealable(appealableRes.data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load your appeals'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/appeals/queue');
      setQueue(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the appeal queue'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (appealId) => {
    try {
      const { data } = await api.get(`/appeals/${appealId}`);
      setDetail(data.data);
      setDecisionNote(data.data.decisionNote || '');
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load that appeal'));
    }
  }, []);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    if (tab === 'mine') loadMine();
    if (tab === 'queue') loadQueue();
  }, [tab, loadMine, loadQueue]);

  const toggleDisputed = (question, awardedMarks) => {
    const key = String(question._id);
    const next = { ...draft.disputed };
    if (next[key]) {
      delete next[key];
    } else {
      next[key] = {
        questionId: key,
        awardedMarks,
        claimedMarks: question.points ?? 1,
        studentNote: '',
      };
    }
    setDraft({ ...draft, disputed: next });
  };

  const submitAppeal = async (submissionId) => {
    clearMessages();
    const disputedAnswers = Object.values(draft.disputed);
    if (disputedAnswers.length === 0) {
      setError('Choose at least one question you are disputing.');
      return;
    }
    try {
      await api.post('/appeals', {
        submissionId,
        reason: draft.reason,
        narrative: draft.narrative,
        disputedAnswers,
      });
      setNotice('Appeal submitted.');
      setDraftFor(null);
      setDraft({ reason: 'calculation-error', narrative: '', disputed: {} });
      loadMine();
    } catch (err) {
      setError(readError(err, 'Could not submit the appeal'));
    }
  };

  const withdrawAppeal = async (appealId) => {
    clearMessages();
    try {
      await api.patch(`/appeals/${appealId}/withdraw`);
      setNotice('Appeal withdrawn.');
      loadMine();
    } catch (err) {
      setError(readError(err, 'Could not withdraw the appeal'));
    }
  };

  const startReview = async (appealId) => {
    clearMessages();
    try {
      await api.patch(`/appeals/${appealId}/start`);
      setNotice('Review started.');
      loadQueue();
      loadDetail(appealId);
    } catch (err) {
      setError(readError(err, 'Could not start the review'));
    }
  };

  const decideQuestion = async (appealId, answerId, decision, revisedMarks) => {
    clearMessages();
    try {
      const { data } = await api.patch(`/appeals/${appealId}/questions/${answerId}`, {
        decision,
        revisedMarks,
      });
      setDetail((current) => ({ ...current, ...data.data }));
    } catch (err) {
      setError(readError(err, 'Could not record that decision'));
    }
  };

  const decideAppeal = async (appealId, outcome) => {
    clearMessages();
    try {
      const { data } = await api.patch(`/appeals/${appealId}/decide`, {
        outcome,
        decisionNote,
      });
      setNotice(data.message);
      setDetail(null);
      loadQueue();
    } catch (err) {
      setError(readError(err, 'Could not record the decision'));
    }
  };

  const reasons = meta?.reasons || Object.keys(REASON_LABELS);

  const tabs = [
    ...(isStaff ? [{ key: 'queue', label: 'Review queue' }] : []),
    { key: 'mine', label: 'My appeals' },
  ];

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-gray-800">Re-evaluation appeals</h1>
        <p className="text-gray-600 mt-1">
          Appeals must be opened within {meta?.windowDays || 14} days of a result,
          and are decided by somebody other than the person who marked the paper.
        </p>
      </header>

      <div className="flex flex-wrap gap-2 mb-6 border-b border-gray-200">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => {
              setTab(entry.key);
              setDetail(null);
              clearMessages();
            }}
            className={`px-4 py-2 -mb-px border-b-2 font-medium transition ${
              tab === entry.key
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {entry.label}
            {entry.key === 'queue' && queue.length > 0 && (
              <span className="ml-2 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs">
                {queue.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 p-3 rounded bg-green-50 border border-green-200 text-green-700">
          {notice}
        </div>
      )}

      {loading && <p className="text-gray-500">Loading…</p>}

      {tab === 'mine' && !loading && (
        <>
          <section className="mb-8">
            <h2 className="text-lg font-semibold text-gray-800 mb-3">
              Results you can still appeal
            </h2>

            {appealable.filter((row) => row.canAppeal).length === 0 && (
              <p className="text-gray-500">
                Nothing is currently inside its appeal window.
              </p>
            )}

            <div className="space-y-3">
              {appealable
                .filter((row) => row.canAppeal)
                .map((row) => (
                  <article
                    key={row.submissionId}
                    className="border border-gray-200 rounded-lg p-4 bg-white"
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="font-medium text-gray-800">
                        {row.exam?.title}
                      </span>
                      <span className="text-sm text-gray-600">
                        scored {row.score}
                      </span>
                      <span className="ml-auto flex items-center gap-3">
                        <Countdown days={row.daysRemaining} />
                        <button
                          type="button"
                          onClick={() => {
                            setDraftFor(
                              draftFor === row.submissionId ? null : row.submissionId
                            );
                            setDraft({
                              reason: 'calculation-error',
                              narrative: '',
                              disputed: {},
                            });
                            clearMessages();
                          }}
                          className="text-sm px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                        >
                          {draftFor === row.submissionId ? 'Cancel' : 'Appeal'}
                        </button>
                      </span>
                    </div>

                    {draftFor === row.submissionId && (
                      <div className="mt-4 pt-4 border-t border-gray-100">
                        <label className="text-sm block mb-3">
                          <span className="block text-gray-600 mb-1">
                            What is the problem?
                          </span>
                          <select
                            value={draft.reason}
                            onChange={(e) =>
                              setDraft({ ...draft, reason: e.target.value })
                            }
                            className="border border-gray-300 rounded px-3 py-1.5"
                          >
                            {reasons.map((reason) => (
                              <option key={reason} value={reason}>
                                {REASON_LABELS[reason] || reason}
                              </option>
                            ))}
                          </select>
                        </label>

                        <p className="text-sm text-gray-600 mb-2">
                          Choose the questions you are disputing:
                        </p>
                        <ul className="space-y-2 mb-3">
                          {row.questions.map((question, index) => {
                            const key = String(question._id);
                            const picked = Boolean(draft.disputed[key]);
                            return (
                              <li
                                key={key}
                                className={`p-2 rounded border text-sm ${
                                  picked
                                    ? 'border-blue-300 bg-blue-50'
                                    : 'border-gray-200 bg-gray-50'
                                }`}
                              >
                                <label className="flex items-start gap-2 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={picked}
                                    onChange={() => toggleDisputed(question, 0)}
                                    className="mt-1"
                                  />
                                  <span className="flex-1">
                                    <span className="text-gray-500">
                                      Q{index + 1}.{' '}
                                    </span>
                                    {question.questionText}
                                    <span className="text-gray-400">
                                      {' '}
                                      ({question.points ?? 1} marks)
                                    </span>
                                  </span>
                                </label>

                                {picked && (
                                  <div className="mt-2 ml-6 flex flex-wrap gap-3 items-end">
                                    <label className="text-xs">
                                      <span className="block text-gray-600 mb-1">
                                        Marks you were given
                                      </span>
                                      <input
                                        type="number"
                                        min="0"
                                        max={question.points ?? 1}
                                        value={draft.disputed[key].awardedMarks}
                                        onChange={(e) =>
                                          setDraft({
                                            ...draft,
                                            disputed: {
                                              ...draft.disputed,
                                              [key]: {
                                                ...draft.disputed[key],
                                                awardedMarks: Number(e.target.value),
                                              },
                                            },
                                          })
                                        }
                                        className="border border-gray-300 rounded px-2 py-1 w-20"
                                      />
                                    </label>
                                    <label className="text-xs">
                                      <span className="block text-gray-600 mb-1">
                                        Marks you believe are due
                                      </span>
                                      <input
                                        type="number"
                                        min="0"
                                        max={question.points ?? 1}
                                        value={draft.disputed[key].claimedMarks}
                                        onChange={(e) =>
                                          setDraft({
                                            ...draft,
                                            disputed: {
                                              ...draft.disputed,
                                              [key]: {
                                                ...draft.disputed[key],
                                                claimedMarks: Number(e.target.value),
                                              },
                                            },
                                          })
                                        }
                                        className="border border-gray-300 rounded px-2 py-1 w-20"
                                      />
                                    </label>
                                  </div>
                                )}
                              </li>
                            );
                          })}
                        </ul>

                        <label className="text-sm block mb-3">
                          <span className="block text-gray-600 mb-1">
                            Set out your case
                          </span>
                          <textarea
                            rows={3}
                            value={draft.narrative}
                            onChange={(e) =>
                              setDraft({ ...draft, narrative: e.target.value })
                            }
                            className="border border-gray-300 rounded px-3 py-1.5 w-full"
                          />
                        </label>

                        <button
                          type="button"
                          onClick={() => submitAppeal(row.submissionId)}
                          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
                        >
                          Submit appeal
                        </button>
                      </div>
                    )}
                  </article>
                ))}
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-3">My appeals</h2>

            {appeals.length === 0 && (
              <p className="text-gray-500">You have not appealed any results.</p>
            )}

            <div className="space-y-3">
              {appeals.map((appeal) => (
                <article
                  key={appeal._id}
                  className="border border-gray-200 rounded-lg p-4 bg-white"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-medium text-gray-800">
                      {appeal.exam?.title || 'Exam'}
                    </span>
                    <span className="text-sm text-gray-500">
                      {REASON_LABELS[appeal.reason] || appeal.reason}
                    </span>
                    <span className="text-sm text-gray-600">
                      {appeal.disputedAnswers.length} question(s)
                    </span>
                    <span className="ml-auto flex items-center gap-2">
                      {appeal.isDecided && appeal.marksDelta !== 0 && (
                        <span className="text-sm font-semibold text-green-700">
                          {appeal.originalTotal} → {appeal.revisedTotal}
                        </span>
                      )}
                      <StatusChip status={appeal.status} />
                    </span>
                  </div>

                  {appeal.decisionNote && (
                    <p className="mt-2 text-sm text-gray-600">
                      {appeal.decisionNote}
                    </p>
                  )}

                  {appeal.isOpen && (
                    <button
                      type="button"
                      onClick={() => withdrawAppeal(appeal._id)}
                      className="mt-3 text-sm px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
                    >
                      Withdraw
                    </button>
                  )}
                </article>
              ))}
            </div>
          </section>
        </>
      )}

      {tab === 'queue' && !loading && (
        <section className="space-y-3">
          {queue.length === 0 && <p className="text-gray-500">The queue is empty.</p>}

          {queue.map((appeal) => (
            <article
              key={appeal._id}
              className={`border rounded-lg p-4 ${
                appeal.eligibilityError
                  ? 'border-gray-200 bg-gray-50 opacity-75'
                  : 'border-gray-200 bg-white'
              }`}
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium text-gray-800">
                  {appeal.student?.name || 'Unknown student'}
                </span>
                <span className="text-sm text-gray-600">{appeal.exam?.title}</span>
                <span className="text-sm text-gray-500">
                  marked by {appeal.originalMarker?.name || 'unknown'}
                </span>
                <span className="text-sm text-gray-500">
                  {appeal.disputedAnswers.length} question(s)
                </span>
                {appeal.waitingDays > 0 && (
                  <span
                    className={`text-xs ${
                      appeal.waitingDays > 14
                        ? 'text-red-600 font-medium'
                        : 'text-gray-400'
                    }`}
                  >
                    waiting {appeal.waitingDays}d
                  </span>
                )}
                <span className="ml-auto">
                  <StatusChip status={appeal.status} />
                </span>
              </div>

              <p className="mt-2 text-sm text-gray-600">{appeal.narrative}</p>

              {appeal.eligibilityError ? (
                <p className="mt-3 text-sm text-amber-700">
                  {appeal.eligibilityError}
                </p>
              ) : (
                <div className="mt-3 flex gap-2">
                  {appeal.status === 'submitted' && (
                    <button
                      type="button"
                      onClick={() => startReview(appeal._id)}
                      className="text-sm px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                    >
                      Take this review
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      detail?._id === appeal._id ? setDetail(null) : loadDetail(appeal._id)
                    }
                    className="text-sm px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
                  >
                    {detail?._id === appeal._id ? 'Close' : 'Open'}
                  </button>
                </div>
              )}

              {detail?._id === appeal._id && (
                <div className="mt-4 pt-4 border-t border-gray-100">
                  <ul className="space-y-3">
                    {detail.disputedAnswers.map((answer) => (
                      <li
                        key={answer._id}
                        className="p-3 rounded bg-gray-50 border border-gray-200"
                      >
                        <p className="text-sm text-gray-800">{answer.questionText}</p>
                        <p className="text-xs text-gray-500 mt-1">
                          Awarded {answer.awardedMarks} · claimed{' '}
                          {answer.claimedMarks} · worth {answer.maxMarks}
                          {' · '}
                          {DECISION_LABELS[answer.decision]}
                        </p>
                        {answer.studentNote && (
                          <p className="text-xs text-gray-600 mt-1">
                            Student: {answer.studentNote}
                          </p>
                        )}

                        {detail.status === 'under-review' && (
                          <div className="mt-2 flex flex-wrap gap-2 items-end">
                            <label className="text-xs">
                              <span className="block text-gray-600 mb-1">
                                Revised marks
                              </span>
                              <input
                                type="number"
                                min="0"
                                max={answer.maxMarks}
                                defaultValue={
                                  answer.revisedMarks ?? answer.awardedMarks
                                }
                                onBlur={(e) =>
                                  decideQuestion(
                                    detail._id,
                                    answer._id,
                                    answer.decision === 'pending'
                                      ? 'upheld'
                                      : answer.decision,
                                    Number(e.target.value)
                                  )
                                }
                                className="border border-gray-300 rounded px-2 py-1 w-20"
                              />
                            </label>
                            <button
                              type="button"
                              onClick={() =>
                                decideQuestion(detail._id, answer._id, 'rejected')
                              }
                              className="text-xs px-3 py-1.5 rounded border border-gray-300 bg-white hover:bg-gray-100"
                            >
                              Original mark stands
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>

                  <div className="mt-4 p-3 rounded bg-white border border-gray-200">
                    <p className="text-sm text-gray-700 mb-2">
                      Total {detail.originalTotal}
                      {detail.revisedTotal !== null && (
                        <>
                          {' → '}
                          <span className="font-semibold">{detail.revisedTotal}</span>
                          <span
                            className={
                              detail.marksDelta > 0
                                ? 'text-green-700'
                                : detail.marksDelta < 0
                                  ? 'text-red-700'
                                  : 'text-gray-500'
                            }
                          >
                            {' '}
                            ({detail.marksDelta > 0 ? '+' : ''}
                            {detail.marksDelta})
                          </span>
                        </>
                      )}
                    </p>

                    {detail.status === 'under-review' && (
                      <>
                        <label className="text-sm block mb-2">
                          <span className="block text-gray-600 mb-1">
                            Decision note{' '}
                            {detail.marksDelta !== 0 && (
                              <span className="text-red-600">(required)</span>
                            )}
                          </span>
                          <textarea
                            rows={2}
                            value={decisionNote}
                            onChange={(e) => setDecisionNote(e.target.value)}
                            className="border border-gray-300 rounded px-3 py-1.5 w-full"
                          />
                        </label>

                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={detail.marksDelta !== 0 && !decisionNote}
                            onClick={() => decideAppeal(detail._id, 'accepted')}
                            className="text-sm px-3 py-1 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                          >
                            Uphold
                          </button>
                          <button
                            type="button"
                            disabled={detail.marksDelta !== 0 && !decisionNote}
                            onClick={() =>
                              decideAppeal(detail._id, 'partially-accepted')
                            }
                            className="text-sm px-3 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                          >
                            Partly uphold
                          </button>
                          <button
                            type="button"
                            onClick={() => decideAppeal(detail._id, 'rejected')}
                            className="text-sm px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
                          >
                            Do not uphold
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </article>
          ))}
        </section>
      )}
    </div>
  );
};

export default RemarkAppeals;
