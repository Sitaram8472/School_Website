import { useState, useEffect, useCallback, useContext } from 'react';
import { ShieldAlert, AlertTriangle, CheckCircle2, Clock, MessageSquare, Gavel } from 'lucide-react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * Academic-integrity cases.
 *
 * A queue rather than a form, because the failure this fixes is cases going
 * quietly stale. Cases sort by how close the reply deadline is, and one that
 * is past its deadline and still undecided is loud.
 *
 * The two-person rule is shown rather than hidden: on a case you opened
 * yourself the decision controls are visible and disabled, with the reason on
 * them. Hiding them teaches nothing and produces a support ticket the first
 * time somebody hits the 403.
 *
 * `mode` picks which half is wanted. The staff area asks for "review"; the
 * student-facing page asks for "student" and gets only the cases about them,
 * so a teacher opening that page is not shown a second copy of their queue.
 */

const ALLEGATION_LABELS = {
  'tab-switching': 'Tab switching',
  impersonation: 'Impersonation',
  'unauthorised-material': 'Unauthorised material',
  collusion: 'Collusion',
  'answer-similarity': 'Answer similarity',
  'disallowed-device': 'Disallowed device',
  other: 'Other',
};

const OUTCOME_LABELS = {
  'no-action': 'No action — dismiss',
  'warning-recorded': 'Warning recorded',
  'partial-penalty': 'Partial penalty',
  'score-void': 'Void the score',
  'resit-required': 'Resit required',
};

const STATUS_STYLES = {
  open: 'bg-amber-100 text-amber-800',
  'awaiting-response': 'bg-amber-100 text-amber-800',
  'under-review': 'bg-blue-100 text-blue-700',
  upheld: 'bg-red-100 text-red-700',
  dismissed: 'bg-green-100 text-green-700',
  withdrawn: 'bg-gray-200 text-gray-600',
};

const STATUS_LABELS = {
  open: 'Open',
  'awaiting-response': 'Awaiting reply',
  'under-review': 'Under review',
  upheld: 'Upheld',
  dismissed: 'Dismissed',
  withdrawn: 'Withdrawn',
};

const EMPTY_CASE = {
  exam: '',
  submission: '',
  allegation: 'tab-switching',
  narrative: '',
  severityClaimed: 'moderate',
  respondByDays: 5,
};

const EMPTY_DECISION = { outcome: 'no-action', penaltyPercent: 50, note: '' };

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

/** Whole days from now until a date; negative once it has passed. */
const daysUntil = (value) => {
  if (!value) return null;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.ceil((new Date(value).getTime() - Date.now()) / msPerDay);
};

const deadlineLine = (record) => {
  if (!['open', 'awaiting-response', 'under-review'].includes(record.status)) return null;

  const days = daysUntil(record.respondByDate);
  const answered = Boolean(record.studentResponse && record.studentResponse.submittedAt);

  if (answered) return { text: 'Replied — ready to decide', urgent: true };
  if (days === null) return null;
  if (days < 0) return { text: `Reply window closed ${Math.abs(days)}d ago`, urgent: true };
  if (days === 0) return { text: 'Reply window closes today', urgent: true };

  return { text: `${days}d left to reply`, urgent: false };
};

const IntegrityPanel = ({ mode = 'review' }) => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);

  const isReviewer = mode === 'review' && (role === 'teacher' || role === 'admin');
  const myId = user?._id || user?.user?._id || user?.id || null;

  const [tab, setTab] = useState(isReviewer ? 'queue' : 'mine');

  const [cases, setCases] = useState([]);
  const [myCases, setMyCases] = useState([]);
  const [exams, setExams] = useState([]);
  const [submissions, setSubmissions] = useState([]);

  const [form, setForm] = useState(EMPTY_CASE);
  const [expandedId, setExpandedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [decision, setDecision] = useState(EMPTY_DECISION);
  const [replyDrafts, setReplyDrafts] = useState({});

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 4000);
  };

  const explain = (err, fallback) =>
    setError(err?.response?.data?.message || err?.message || fallback);

  // ---- loading -------------------------------------------------------------

  const loadQueue = useCallback(async () => {
    if (!isReviewer) return;

    setLoading(true);
    try {
      const res = await api.get('/submissions/integrity');
      setCases(res.data.data || []);
    } catch (err) {
      explain(err, 'Could not load the integrity queue.');
    } finally {
      setLoading(false);
    }
  }, [isReviewer]);

  const loadMine = useCallback(async () => {
    try {
      const res = await api.get('/submissions/integrity/mine');
      setMyCases(res.data.data || []);
    } catch (err) {
      explain(err, 'Could not load your cases.');
    }
  }, []);

  const loadExams = useCallback(async () => {
    if (!isReviewer) return;

    try {
      const res = await api.get('/exams');
      setExams(res.data.data || []);
    } catch (err) {
      explain(err, 'Could not load exams.');
    }
  }, [isReviewer]);

  useEffect(() => {
    if (!user) return;
    loadQueue();
    loadMine();
    loadExams();
  }, [user, loadQueue, loadMine, loadExams]);

  // ---- opening -------------------------------------------------------------

  const chooseExam = async (examId) => {
    setForm({ ...form, exam: examId, submission: '' });
    setSubmissions([]);
    setError('');

    if (!examId) return;

    try {
      const res = await api.get(`/submissions/exam/${examId}`);
      setSubmissions(res.data.data || []);
    } catch (err) {
      explain(err, 'Could not load the submissions for that exam.');
    }
  };

  const submitCase = async (event) => {
    event.preventDefault();
    setError('');

    if (!form.submission) {
      setError('Pick the submission the case is about.');
      return;
    }
    if (form.narrative.trim().length < 20) {
      setError('Describe what was observed in at least 20 characters.');
      return;
    }

    setLoading(true);
    try {
      const res = await api.post('/submissions/integrity', {
        submission: form.submission,
        allegation: form.allegation,
        narrative: form.narrative.trim(),
        severityClaimed: form.severityClaimed,
        respondByDays: Number(form.respondByDays) || 5,
      });
      flash(res.data.message || 'Case opened.');
      setForm(EMPTY_CASE);
      setSubmissions([]);
      setTab('queue');
      await loadQueue();
    } catch (err) {
      explain(err, 'Could not open the case.');
    } finally {
      setLoading(false);
    }
  };

  // ---- deciding ------------------------------------------------------------

  const expand = async (record) => {
    if (expandedId === record._id) {
      setExpandedId('');
      setDetail(null);
      return;
    }

    setExpandedId(record._id);
    setDetail(null);
    setDecision(EMPTY_DECISION);
    setError('');

    try {
      const res = await api.get(`/submissions/integrity/${record._id}`);
      setDetail(res.data.data);
    } catch (err) {
      explain(err, 'Could not open the case.');
    }
  };

  /**
   * What the score becomes under the currently selected outcome. Mirrors the
   * server's arithmetic so the button can say "17 → 9" before anyone commits.
   */
  const projectedScore = () => {
    if (!detail || detail.currentScore === null || detail.currentScore === undefined) return null;

    const score = Number(detail.currentScore) || 0;

    if (decision.outcome === 'score-void') return 0;
    if (decision.outcome === 'partial-penalty') {
      return Math.round(score * (1 - (Number(decision.penaltyPercent) || 0) / 100));
    }

    return score;
  };

  const decide = async (record) => {
    setError('');
    setLoading(true);

    try {
      const res = await api.patch(`/submissions/integrity/${record._id}/review`, {
        outcome: decision.outcome,
        penaltyPercent: decision.penaltyPercent,
        note: decision.note.trim(),
      });
      flash(res.data.message || 'Decision recorded.');
      setExpandedId('');
      setDetail(null);
      await loadQueue();
    } catch (err) {
      explain(err, 'Could not record the decision.');
    } finally {
      setLoading(false);
    }
  };

  const withdraw = async (record) => {
    const reason = window.prompt('Why is this case being withdrawn?');
    if (reason === null) return;

    try {
      await api.patch(`/submissions/integrity/${record._id}/withdraw`, { reason: reason.trim() });
      flash('Case withdrawn.');
      await loadQueue();
    } catch (err) {
      explain(err, 'Could not withdraw the case.');
    }
  };

  const reply = async (record) => {
    const text = (replyDrafts[record._id] || '').trim();

    if (text.length < 10) {
      setError('Write at least a sentence in reply.');
      return;
    }

    setError('');
    try {
      const res = await api.post(`/submissions/integrity/${record._id}/response`, { text });
      flash(res.data.message || 'Your reply has been recorded.');
      setReplyDrafts({ ...replyDrafts, [record._id]: '' });
      await loadMine();
    } catch (err) {
      explain(err, 'Could not record your reply.');
    }
  };

  const openedByMe = (record) => {
    const opener = record.openedBy?._id || record.openedBy;
    return myId && opener && String(opener) === String(myId);
  };

  if (!user) return null;

  // ---- rendering -----------------------------------------------------------

  const statusChip = (status) => (
    <span
      className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
        STATUS_STYLES[status] || 'bg-gray-100 text-gray-600'
      }`}
    >
      {STATUS_LABELS[status] || status}
    </span>
  );

  const tabs = isReviewer
    ? [
        { key: 'queue', label: 'Review queue' },
        { key: 'open', label: 'Open a case' },
        { key: 'mine', label: 'My cases' },
      ]
    : [{ key: 'mine', label: 'My cases' }];

  return (
    <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8 mb-8">
      <div className="flex items-center gap-2 mb-1">
        <ShieldAlert size={22} className="text-red-600" />
        <h2 className="text-2xl font-bold text-[var(--text-primary)]">Exam integrity</h2>
      </div>
      <p className="text-sm text-slate-500 mb-5">
        A warning count is telemetry. A case is a stated allegation, a reply, and a decision by
        someone who was not the accuser.
      </p>

      {tabs.length > 1 && (
        <div className="flex gap-2 mb-5 border-b border-slate-100">
          {tabs.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setTab(entry.key)}
              className={`px-3 py-2 text-sm font-medium -mb-px border-b-2 transition ${
                tab === entry.key
                  ? 'border-red-600 text-red-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-3 mb-4 text-sm flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 rounded-xl p-3 mb-4 text-sm flex items-center gap-2">
          <CheckCircle2 size={16} />
          {success}
        </div>
      )}

      {/* ---- the queue ---- */}
      {tab === 'queue' && isReviewer && (
        <>
          {loading && cases.length === 0 && <p className="text-sm text-slate-500">Loading…</p>}
          {!loading && cases.length === 0 && (
            <p className="text-sm text-slate-500">No integrity cases have been opened.</p>
          )}

          <div className="space-y-3">
            {cases.map((record) => {
              const deadline = deadlineLine(record);
              const mine = openedByMe(record);
              const isExpanded = expandedId === record._id;

              return (
                <div
                  key={record._id}
                  className={`border rounded-2xl p-4 ${
                    deadline?.urgent ? 'border-red-200 bg-red-50/30' : 'border-slate-100'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold text-slate-800">
                        {record.caseRef}
                        <span className="text-slate-400 font-normal">
                          {' '}
                          · {ALLEGATION_LABELS[record.allegation] || record.allegation}
                        </span>
                      </div>
                      <div className="text-xs text-slate-500 mt-1">
                        {record.studentName || record.student?.name || 'Student'} ·{' '}
                        {record.examTitle} · opened {formatDate(record.openedAt)} by{' '}
                        {record.openedBy?.name || 'staff'}
                      </div>
                      {deadline && (
                        <div
                          className={`text-xs mt-1 inline-flex items-center gap-1 ${
                            deadline.urgent ? 'text-red-700 font-semibold' : 'text-slate-500'
                          }`}
                        >
                          <Clock size={12} /> {deadline.text}
                        </div>
                      )}
                      {record.outcome && (
                        <div className="text-xs text-slate-600 mt-1">
                          {OUTCOME_LABELS[record.outcome] || record.outcome}
                          {record.scoreBeforeOutcome !== null &&
                            record.scoreAfterOutcome !== null && (
                              <span className="font-mono">
                                {' '}
                                · {record.scoreBeforeOutcome} → {record.scoreAfterOutcome}
                              </span>
                            )}
                          {record.decidedWithoutResponse && (
                            <span className="text-amber-700"> · decided with no reply</span>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-col items-end gap-2">
                      {statusChip(record.status)}
                      <button
                        type="button"
                        onClick={() => expand(record)}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700"
                      >
                        {isExpanded ? 'Close' : 'Open'}
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="mt-4 pt-4 border-t border-slate-100">
                      <p className="text-sm text-slate-700 whitespace-pre-line">
                        {record.narrative}
                      </p>

                      {detail && detail.evidence?.length > 0 && (
                        <ul className="mt-3 space-y-1">
                          {detail.evidence.map((item, index) => (
                            <li key={index} className="text-xs text-slate-600">
                              <span className="font-semibold">{item.kind}</span> — {item.detail}
                            </li>
                          ))}
                        </ul>
                      )}

                      {detail?.studentResponse?.submittedAt ? (
                        <div className="mt-4 bg-slate-50 rounded-xl p-3">
                          <div className="text-xs font-semibold text-slate-700 flex items-center gap-1">
                            <MessageSquare size={13} /> The student's reply
                            {detail.studentResponse.wasLate && (
                              <span className="text-amber-700">(late)</span>
                            )}
                          </div>
                          <p className="text-sm text-slate-700 mt-1 whitespace-pre-line">
                            {detail.studentResponse.text}
                          </p>
                        </div>
                      ) : (
                        <p className="mt-4 text-xs text-slate-500 italic">
                          No reply yet. The window closes {formatDate(record.respondByDate)}.
                        </p>
                      )}

                      {record.status !== 'upheld' &&
                        record.status !== 'dismissed' &&
                        record.status !== 'withdrawn' && (
                          <div className="mt-4 grid md:grid-cols-2 gap-3">
                            <div>
                              <label className="block text-xs font-medium text-slate-600 mb-1">
                                Outcome
                              </label>
                              <select
                                value={decision.outcome}
                                onChange={(event) =>
                                  setDecision({ ...decision, outcome: event.target.value })
                                }
                                disabled={mine}
                                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm disabled:bg-slate-50"
                              >
                                {Object.keys(OUTCOME_LABELS).map((outcome) => (
                                  <option key={outcome} value={outcome}>
                                    {OUTCOME_LABELS[outcome]}
                                  </option>
                                ))}
                              </select>
                            </div>

                            {decision.outcome === 'partial-penalty' && (
                              <div>
                                <label className="block text-xs font-medium text-slate-600 mb-1">
                                  Penalty percent
                                </label>
                                <input
                                  type="number"
                                  min="1"
                                  max="100"
                                  value={decision.penaltyPercent}
                                  onChange={(event) =>
                                    setDecision({
                                      ...decision,
                                      penaltyPercent: Number(event.target.value),
                                    })
                                  }
                                  disabled={mine}
                                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm disabled:bg-slate-50"
                                />
                              </div>
                            )}

                            <div className="md:col-span-2">
                              <label className="block text-xs font-medium text-slate-600 mb-1">
                                Decision note
                              </label>
                              <input
                                value={decision.note}
                                onChange={(event) =>
                                  setDecision({ ...decision, note: event.target.value })
                                }
                                disabled={mine}
                                placeholder="What was decided and why"
                                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm disabled:bg-slate-50"
                              />
                            </div>

                            <div className="md:col-span-2 flex flex-wrap items-center gap-3">
                              <button
                                type="button"
                                disabled={mine || loading}
                                title={mine ? 'You opened this case, so you cannot decide it' : ''}
                                onClick={() => decide(record)}
                                className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 disabled:bg-slate-200 disabled:text-slate-500 text-white inline-flex items-center gap-2"
                              >
                                <Gavel size={15} />
                                Record decision
                                {/* The consequence, in the button, before it is
                                    committed to. */}
                                {detail && projectedScore() !== null && (
                                  <span className="font-mono">
                                    ({detail.currentScore} → {projectedScore()})
                                  </span>
                                )}
                              </button>

                              {mine && (
                                <button
                                  type="button"
                                  onClick={() => withdraw(record)}
                                  className="px-4 py-2 rounded-lg text-sm font-medium bg-slate-100 hover:bg-slate-200 text-slate-700"
                                >
                                  Withdraw
                                </button>
                              )}

                              {mine && (
                                <span className="text-xs text-slate-500">
                                  You opened this case — somebody else has to decide it.
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ---- opening a case ---- */}
      {tab === 'open' && isReviewer && (
        <form onSubmit={submitCase} className="grid md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Exam</label>
            <select
              value={form.exam}
              onChange={(event) => chooseExam(event.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            >
              <option value="">Pick an exam…</option>
              {exams.map((exam) => (
                <option key={exam._id} value={exam._id}>
                  {exam.title}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Submission</label>
            <select
              value={form.submission}
              onChange={(event) => setForm({ ...form, submission: event.target.value })}
              disabled={!form.exam}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm disabled:bg-slate-50"
            >
              <option value="">
                {form.exam ? 'Pick a submission…' : 'Pick an exam first'}
              </option>
              {submissions.map((submission) => (
                <option key={submission._id} value={submission._id}>
                  {submission.student?.name || 'Unknown'} · {submission.score} pts ·{' '}
                  {submission.cheatWarnings} warning(s)
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Allegation</label>
            <select
              value={form.allegation}
              onChange={(event) => setForm({ ...form, allegation: event.target.value })}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            >
              {Object.keys(ALLEGATION_LABELS).map((allegation) => (
                <option key={allegation} value={allegation}>
                  {ALLEGATION_LABELS[allegation]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Days to reply
            </label>
            <input
              type="number"
              min="1"
              max="30"
              value={form.respondByDays}
              onChange={(event) => setForm({ ...form, respondByDays: event.target.value })}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-slate-600 mb-1">
              What was observed
            </label>
            <textarea
              rows={4}
              value={form.narrative}
              onChange={(event) => setForm({ ...form, narrative: event.target.value })}
              placeholder="What actually happened, in enough detail that the student can answer it"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            />
            <p className="text-xs text-slate-400 mt-1">
              An observation, not a verdict — the student has to be able to reply to it.
            </p>
          </div>

          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-slate-300 text-white rounded-lg text-sm font-medium"
            >
              Open case
            </button>
          </div>
        </form>
      )}

      {/* ---- the caller's own cases ---- */}
      {tab === 'mine' && (
        <>
          {myCases.length === 0 ? (
            <p className="text-sm text-slate-500">No integrity case has been opened about you.</p>
          ) : (
            <div className="space-y-3">
              {myCases.map((record) => {
                const answered = Boolean(record.studentResponse?.submittedAt);
                const canReply = ['open', 'awaiting-response', 'under-review'].includes(
                  record.status
                );

                return (
                  <div key={record._id} className="border border-slate-100 rounded-2xl p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="font-semibold text-slate-800">
                          {record.caseRef}
                          <span className="text-slate-400 font-normal">
                            {' '}
                            · {ALLEGATION_LABELS[record.allegation] || record.allegation}
                          </span>
                        </div>
                        <div className="text-xs text-slate-500 mt-1">
                          {record.examTitle} · reply by {formatDate(record.respondByDate)}
                        </div>
                      </div>
                      {statusChip(record.status)}
                    </div>

                    <p className="text-sm text-slate-700 mt-3 whitespace-pre-line">
                      {record.narrative}
                    </p>

                    {record.evidence?.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {record.evidence.map((item, index) => (
                          <li key={index} className="text-xs text-slate-600">
                            <span className="font-semibold">{item.kind}</span> — {item.detail}
                          </li>
                        ))}
                      </ul>
                    )}

                    {answered && (
                      <div className="mt-3 bg-slate-50 rounded-xl p-3">
                        <div className="text-xs font-semibold text-slate-700">Your reply</div>
                        <p className="text-sm text-slate-700 mt-1 whitespace-pre-line">
                          {record.studentResponse.text}
                        </p>
                      </div>
                    )}

                    {!answered && canReply && (
                      <div className="mt-3">
                        <textarea
                          rows={3}
                          value={replyDrafts[record._id] || ''}
                          onChange={(event) =>
                            setReplyDrafts({ ...replyDrafts, [record._id]: event.target.value })
                          }
                          placeholder="Your account of what happened"
                          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => reply(record)}
                          className="mt-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium"
                        >
                          Send reply
                        </button>
                      </div>
                    )}

                    {record.outcome && (
                      <div className="mt-3 text-sm text-slate-700">
                        <span className="font-semibold">Outcome:</span>{' '}
                        {OUTCOME_LABELS[record.outcome] || record.outcome}
                        {record.scoreBeforeOutcome !== null &&
                          record.scoreAfterOutcome !== null && (
                            <span className="font-mono">
                              {' '}
                              · score {record.scoreBeforeOutcome} → {record.scoreAfterOutcome}
                            </span>
                          )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default IntegrityPanel;
