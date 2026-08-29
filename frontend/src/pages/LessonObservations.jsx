import { useState, useEffect, useContext, useCallback, useMemo } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * Lesson observation and teaching appraisal.
 *
 * The page opens on **About me**, which is the tab a teacher cares about, and
 * an unshared observation there says so in words: it is listed, it is dated,
 * and it carries "feedback not yet shared" rather than an empty row that looks
 * like the record is broken. Silence about the gate reads as a bug; stating it
 * reads as a process.
 *
 * **My actions** is the tab that exists because the paper version has no
 * equivalent. Every agreed action the teacher owns, from every observation,
 * overdue first — which is the follow-up that currently never happens.
 *
 * The rubric panel puts the previous cycle's score beside each domain, because
 * "3 last term, 3 this term" is the only thing an appraisal cycle is actually
 * for and the Word document cannot show it.
 */

const CYCLE_LABELS = {
  autumn: 'Autumn',
  spring: 'Spring',
  summer: 'Summer',
  induction: 'Induction',
  'follow-up': 'Follow-up',
  'learning-walk': 'Learning walk',
};

const STATUS_LABELS = {
  scheduled: 'Scheduled',
  observed: 'Observed — not yet shared',
  'feedback-shared': 'Feedback shared',
  acknowledged: 'Acknowledged',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

const STATUS_STYLES = {
  scheduled: 'bg-gray-100 text-gray-700',
  observed: 'bg-amber-100 text-amber-800',
  'feedback-shared': 'bg-blue-100 text-blue-700',
  acknowledged: 'bg-emerald-100 text-emerald-800',
  closed: 'bg-green-100 text-green-700',
  cancelled: 'bg-gray-200 text-gray-500',
};

const ACTION_STATUS_LABELS = {
  open: 'Open',
  'in-progress': 'In progress',
  completed: 'Completed',
  'carried-forward': 'Carried forward',
};

const FALLBACK_DOMAIN_LABELS = {
  planning: 'Planning and preparation',
  'subject-knowledge': 'Subject knowledge',
  questioning: 'Questioning and explanation',
  differentiation: 'Differentiation and challenge',
  'assessment-for-learning': 'Assessment for learning',
  'behaviour-management': 'Behaviour and climate',
  'pupil-engagement': 'Pupil engagement',
  'use-of-resources': 'Use of resources and time',
};

const FALLBACK_SCORE_LABELS = {
  1: 'Needs development',
  2: 'Developing',
  3: 'Secure',
  4: 'Exemplary',
};

const shortDate = (value) => (value ? new Date(value).toLocaleDateString() : '—');

const StatusChip = ({ status }) => (
  <span
    className={`px-2 py-0.5 rounded text-xs font-medium ${
      STATUS_STYLES[status] || 'bg-gray-100 text-gray-700'
    }`}
  >
    {STATUS_LABELS[status] || status}
  </span>
);

const ScoreBadge = ({ score }) => {
  if (!Number.isFinite(score)) {
    return <span className="text-xs text-gray-400">not scored</span>;
  }
  const tone =
    score >= 3.5
      ? 'bg-green-100 text-green-700'
      : score >= 2.5
        ? 'bg-blue-100 text-blue-700'
        : score >= 1.5
          ? 'bg-amber-100 text-amber-800'
          : 'bg-red-100 text-red-700';
  return (
    <span className={`px-2 py-0.5 rounded text-sm font-semibold ${tone}`}>{score.toFixed(1)}</span>
  );
};

const OverdueChip = ({ days }) => {
  if (!days) return null;
  return (
    <span className="px-2 py-0.5 rounded text-xs font-semibold bg-red-100 text-red-700">
      {days} {days === 1 ? 'day' : 'days'} overdue
    </span>
  );
};

/**
 * Movement between the first and latest scored observation of a domain. An
 * appraisal cycle that cannot show this is a filing exercise.
 */
const MovementChip = ({ change }) => {
  if (change === undefined || change === null || change === 0) {
    return <span className="text-xs text-gray-400">no change</span>;
  }
  const up = change > 0;
  return (
    <span
      className={`text-xs font-medium ${up ? 'text-green-700' : 'text-amber-700'}`}
    >
      {up ? '▲' : '▼'} {Math.abs(change)}
    </span>
  );
};

const LessonObservations = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';
  const isStaff = role === 'teacher' || role === 'staff' || role === 'admin';

  const [tab, setTab] = useState('mine');
  const [meta, setMeta] = useState(null);

  const [mine, setMine] = useState([]);
  const [byMe, setByMe] = useState([]);
  const [actions, setActions] = useState([]);
  const [history, setHistory] = useState(null);
  const [teachers, setTeachers] = useState([]);
  const [stats, setStats] = useState(null);
  const [detail, setDetail] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleForm, setScheduleForm] = useState({
    observeeId: '',
    cycle: 'autumn',
    subject: '',
    yearGroup: '',
    scheduledFor: '',
    focusAreas: [],
  });

  // The scoring panel: a map of domain key -> { score, strengths, developmentPoints }
  const [rubric, setRubric] = useState({});
  const [observedAt, setObservedAt] = useState('');

  const [actionForm, setActionForm] = useState({ description: '', dueBy: '', supportOffered: '' });
  const [responseText, setResponseText] = useState('');

  const readError = (err, fallback) => err?.response?.data?.message || fallback;

  const clearMessages = () => {
    setError('');
    setNotice('');
  };

  const domainLabels = meta?.domainLabels || FALLBACK_DOMAIN_LABELS;
  const domainKeys = meta?.domainKeys || Object.keys(FALLBACK_DOMAIN_LABELS);
  const scoreLabels = meta?.scoreLabels || FALLBACK_SCORE_LABELS;
  const cycles = meta?.cycles || Object.keys(CYCLE_LABELS);

  const loadMeta = useCallback(async () => {
    try {
      const { data } = await api.get('/observations/meta');
      setMeta(data.data);
    } catch {
      // The forms fall back to their own labels.
    }
  }, []);

  const loadMine = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/observations/mine');
      setMine(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load your observations'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadByMe = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/observations/by-me');
      setByMe(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load your observations'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadActions = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/observations/actions/mine');
      setActions(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load your agreed actions'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    if (!user?._id) return;
    try {
      const { data } = await api.get(`/observations/history/${user._id}`);
      setHistory(data.data);
    } catch {
      setHistory(null);
    }
  }, [user]);

  const loadTeachers = useCallback(async () => {
    try {
      const { data } = await api.get('/observations/teachers');
      setTeachers(data.data || []);
    } catch {
      setTeachers([]);
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const { data } = await api.get('/observations/stats');
      setStats(data.data);
    } catch {
      setStats(null);
    }
  }, []);

  const loadDetail = useCallback(async (observationId) => {
    try {
      const { data } = await api.get(`/observations/${observationId}`);
      setDetail(data.data);
      setResponseText(data.data.observeeResponse || '');

      // Seed the rubric panel from whatever is already recorded, so an
      // observer editing a draft does not start from a blank grid.
      const seeded = {};
      for (const domain of data.data.domains || []) {
        seeded[domain.key] = {
          score: domain.score ?? '',
          strengths: domain.strengths || '',
          developmentPoints: domain.developmentPoints || '',
        };
      }
      setRubric(seeded);
      setObservedAt(
        data.data.observedAt ? new Date(data.data.observedAt).toISOString().slice(0, 10) : ''
      );
    } catch (err) {
      setError(readError(err, 'Could not load that observation'));
    }
  }, []);

  useEffect(() => {
    loadMeta();
    loadMine();
    loadActions();
    loadHistory();
    loadTeachers();
    if (isAdmin) loadStats();
  }, [loadMeta, loadMine, loadActions, loadHistory, loadTeachers, loadStats, isAdmin]);

  useEffect(() => {
    if (tab === 'by-me') loadByMe();
  }, [tab, loadByMe]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadMine(), loadByMe(), loadActions(), loadHistory()]);
    if (isAdmin) await loadStats();
  }, [loadMine, loadByMe, loadActions, loadHistory, loadStats, isAdmin]);

  const overdueActions = useMemo(() => actions.filter((row) => row.daysOverdue > 0), [actions]);
  const awaitingFeedback = useMemo(() => mine.filter((row) => row.awaitingFeedback), [mine]);

  /** The previous scored value for a domain, for the "3 last term" column. */
  const previousScoreFor = useCallback(
    (key) => {
      if (!history || !history.movement || !history.movement[key]) return null;
      return history.movement[key].latest;
    },
    [history]
  );

  // -- actions ---------------------------------------------------------------

  const submitSchedule = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      const { data } = await api.post('/observations', scheduleForm);
      setNotice(data.message || 'Observation scheduled');
      setScheduleOpen(false);
      setScheduleForm({
        observeeId: '',
        cycle: 'autumn',
        subject: '',
        yearGroup: '',
        scheduledFor: '',
        focusAreas: [],
      });
      setTab('by-me');
      await refreshAll();
    } catch (err) {
      setError(readError(err, 'Could not schedule the observation'));
    }
  };

  const submitRubric = async (event) => {
    event.preventDefault();
    if (!detail) return;
    clearMessages();

    const domains = Object.entries(rubric)
      .filter(([, value]) => value.score !== '' || value.strengths || value.developmentPoints)
      .map(([key, value]) => ({
        key,
        score: value.score === '' ? undefined : Number(value.score),
        strengths: value.strengths,
        developmentPoints: value.developmentPoints,
      }));

    if (!domains.length) {
      setError('Score or comment on at least one domain');
      return;
    }

    try {
      const { data } = await api.patch(`/observations/${detail._id}/record`, {
        domains,
        observedAt: observedAt || undefined,
      });
      setDetail(data.data);
      setNotice(data.message || 'Recorded');
      await refreshAll();
    } catch (err) {
      setError(readError(err, 'Could not record the observation'));
    }
  };

  const share = async () => {
    if (!detail) return;
    clearMessages();
    try {
      const { data } = await api.patch(`/observations/${detail._id}/share`, {});
      setDetail(data.data);
      setNotice(data.message || 'Feedback shared');
      await refreshAll();
    } catch (err) {
      // The refusals — no scored domain, no agreed action — arrive here and
      // are shown verbatim, because they say what to do next.
      setError(readError(err, 'Could not share the feedback'));
    }
  };

  const acknowledge = async () => {
    if (!detail) return;
    clearMessages();
    try {
      const { data } = await api.patch(`/observations/${detail._id}/acknowledge`, {
        response: responseText,
      });
      setDetail(data.data);
      setNotice('Acknowledged');
      await refreshAll();
    } catch (err) {
      setError(readError(err, 'Could not acknowledge the observation'));
    }
  };

  const submitAction = async (event) => {
    event.preventDefault();
    if (!detail) return;
    clearMessages();
    try {
      const { data } = await api.post(`/observations/${detail._id}/actions`, actionForm);
      setDetail(data.data);
      setNotice('Action agreed');
      setActionForm({ description: '', dueBy: '', supportOffered: '' });
      await refreshAll();
    } catch (err) {
      setError(readError(err, 'Could not add the action'));
    }
  };

  const completeAction = async (observationId, actionId) => {
    const evidence = window.prompt('What did you do?');
    if (!evidence) return;
    clearMessages();
    try {
      await api.patch(`/observations/${observationId}/actions/${actionId}`, {
        status: 'completed',
        evidence,
      });
      setNotice('Action completed');
      await refreshAll();
      if (detail && detail._id === observationId) await loadDetail(observationId);
    } catch (err) {
      setError(readError(err, 'Could not complete the action'));
    }
  };

  const closeObservation = async () => {
    if (!detail) return;
    clearMessages();
    try {
      const { data } = await api.patch(`/observations/${detail._id}/close`, {});
      setDetail(data.data);
      setNotice('Observation closed');
      await refreshAll();
    } catch (err) {
      setError(readError(err, 'Could not close the observation'));
    }
  };

  if (!isStaff) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-semibold text-gray-800">Lesson observations</h1>
        <p className="mt-3 text-gray-600">
          Lesson observations are a record of teaching practice and are held between a teacher and
          their observer.
        </p>
      </div>
    );
  }

  const tabs = [
    { key: 'mine', label: `About me${awaitingFeedback.length ? ` (${awaitingFeedback.length})` : ''}` },
    { key: 'actions', label: `My actions${overdueActions.length ? ` (${overdueActions.length})` : ''}` },
    { key: 'by-me', label: 'By me' },
    { key: 'progress', label: 'My progress' },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">Lesson observations</h1>
          <p className="mt-1 text-sm text-gray-600 max-w-2xl">
            Scores become visible to the teacher when the observer shares them, which is the point
            at which the conversation has happened. Every agreed action carries an owner and a
            date, and is checked before the observation can be closed.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setScheduleOpen((open) => !open)}
          className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition"
        >
          {scheduleOpen ? 'Close' : 'Schedule an observation'}
        </button>
      </header>

      {isAdmin && stats && (
        <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="text-xs uppercase tracking-wide text-gray-500">Observations</div>
            <div className="mt-1 text-2xl font-semibold text-gray-800">{stats.total}</div>
          </div>
          <div
            className={`rounded-lg border p-4 ${
              stats.meanSharingLagDays > 14 ? 'border-amber-200 bg-amber-50' : 'border-gray-200 bg-white'
            }`}
          >
            <div className="text-xs uppercase tracking-wide text-gray-500">Mean days to share</div>
            <div className="mt-1 text-2xl font-semibold text-gray-800">
              {stats.meanSharingLagDays ?? '—'}
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="text-xs uppercase tracking-wide text-gray-500">Actions completed</div>
            <div className="mt-1 text-2xl font-semibold text-gray-800">
              {stats.actions.completionRate === null ? '—' : `${stats.actions.completionRate}%`}
            </div>
          </div>
          <div
            className={`rounded-lg border p-4 ${
              stats.actions.overdue ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-white'
            }`}
          >
            <div className="text-xs uppercase tracking-wide text-gray-500">Actions overdue</div>
            <div className="mt-1 text-2xl font-semibold text-gray-800">{stats.actions.overdue}</div>
          </div>
        </div>
      )}

      {(error || notice) && (
        <div
          className={`mt-4 rounded-md px-4 py-3 text-sm ${
            error
              ? 'bg-red-50 text-red-700 border border-red-200'
              : 'bg-green-50 text-green-700 border border-green-200'
          }`}
        >
          {error || notice}
        </div>
      )}

      {scheduleOpen && (
        <form
          onSubmit={submitSchedule}
          className="mt-6 rounded-lg border border-gray-200 bg-white p-5 grid grid-cols-1 md:grid-cols-3 gap-4"
        >
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Teacher</span>
            <select
              required
              value={scheduleForm.observeeId}
              onChange={(e) => setScheduleForm({ ...scheduleForm, observeeId: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            >
              <option value="">Choose a colleague…</option>
              {teachers.map((person) => (
                <option key={person._id} value={person._id}>
                  {person.name} ({person.role})
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Cycle</span>
            <select
              value={scheduleForm.cycle}
              onChange={(e) => setScheduleForm({ ...scheduleForm, cycle: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            >
              {cycles.map((key) => (
                <option key={key} value={key}>
                  {CYCLE_LABELS[key] || key}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Date</span>
            <input
              required
              type="date"
              value={scheduleForm.scheduledFor}
              onChange={(e) => setScheduleForm({ ...scheduleForm, scheduledFor: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Subject</span>
            <input
              value={scheduleForm.subject}
              onChange={(e) => setScheduleForm({ ...scheduleForm, subject: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Year group</span>
            <input
              value={scheduleForm.yearGroup}
              onChange={(e) => setScheduleForm({ ...scheduleForm, yearGroup: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>
          <div className="md:col-span-3">
            <span className="block text-sm text-gray-600 mb-2">
              Focus areas — agreed with the teacher before the lesson, not after
            </span>
            <div className="flex flex-wrap gap-2">
              {domainKeys.map((key) => {
                const on = scheduleForm.focusAreas.includes(key);
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() =>
                      setScheduleForm({
                        ...scheduleForm,
                        focusAreas: on
                          ? scheduleForm.focusAreas.filter((entry) => entry !== key)
                          : [...scheduleForm.focusAreas, key],
                      })
                    }
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${
                      on
                        ? 'border-blue-500 bg-blue-50 text-blue-700'
                        : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {domainLabels[key] || key}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="md:col-span-3 flex justify-end">
            <button
              type="submit"
              className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition"
            >
              Schedule
            </button>
          </div>
        </form>
      )}

      <nav className="mt-8 flex flex-wrap gap-2 border-b border-gray-200">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => {
              setTab(entry.key);
              clearMessages();
            }}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
              tab === entry.key
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {loading && <p className="mt-6 text-sm text-gray-500">Loading…</p>}

      {tab === 'mine' && (
        <section className="mt-6 space-y-3">
          {mine.length === 0 && !loading ? (
            <p className="text-sm text-gray-500">No observations of your teaching are recorded.</p>
          ) : (
            mine.map((row) => (
              <article key={row._id} className="rounded-lg border border-gray-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-gray-800">
                      {CYCLE_LABELS[row.cycle] || row.cycle} · {row.academicYear}
                    </h3>
                    <p className="text-xs text-gray-500">
                      {row.subject || 'Subject not stated'}
                      {row.yearGroup ? ` · ${row.yearGroup}` : ''} ·{' '}
                      {row.observedAt ? shortDate(row.observedAt) : shortDate(row.scheduledFor)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {row.scoresVisible && <ScoreBadge score={row.overallScore} />}
                    <StatusChip status={row.status} />
                  </div>
                </div>

                {/* Stating the gate. A blank record reads as a bug; this reads
                    as a process. */}
                {row.awaitingFeedback ? (
                  <p className="mt-3 rounded bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                    Feedback has not been shared yet. Scores become visible once your observer has
                    talked them through with you.
                  </p>
                ) : (
                  <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-gray-600">
                    <span>{row.scoredDomainCount} domains scored</span>
                    <span>·</span>
                    <span>
                      {row.openActionCount} open action{row.openActionCount === 1 ? '' : 's'}
                    </span>
                    {row.acknowledgedAt && <span>· acknowledged {shortDate(row.acknowledgedAt)}</span>}
                    <button
                      type="button"
                      onClick={() => loadDetail(row._id)}
                      className="text-blue-600 hover:underline"
                    >
                      Open
                    </button>
                  </div>
                )}
              </article>
            ))
          )}
        </section>
      )}

      {tab === 'actions' && (
        <section className="mt-6 space-y-3">
          {overdueActions.length > 0 && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {overdueActions.length === 1
                ? 'One agreed action is past its date.'
                : `${overdueActions.length} agreed actions are past their date.`}
            </div>
          )}
          {actions.length === 0 && !loading ? (
            <p className="text-sm text-gray-500">You have no agreed actions.</p>
          ) : (
            actions.map((row) => (
              <article
                key={row.actionId}
                className="rounded-lg border border-gray-200 bg-white p-4 flex flex-wrap items-start justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="text-sm text-gray-800">{row.description}</p>
                  <p className="mt-1 text-xs text-gray-500">
                    {CYCLE_LABELS[row.cycle] || row.cycle} · {row.observerName || 'observer'} · due{' '}
                    {shortDate(row.dueBy)}
                  </p>
                  {row.supportOffered && (
                    <p className="mt-1 text-xs text-blue-700">Support: {row.supportOffered}</p>
                  )}
                  {row.evidence && <p className="mt-1 text-xs text-gray-500">{row.evidence}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <OverdueChip days={row.daysOverdue} />
                  <span className="text-xs text-gray-500">
                    {ACTION_STATUS_LABELS[row.status] || row.status}
                  </span>
                  {row.status !== 'completed' && row.status !== 'carried-forward' && (
                    <button
                      type="button"
                      onClick={() => completeAction(row.observationId, row.actionId)}
                      className="px-3 py-1.5 rounded border border-green-300 text-green-700 text-xs font-medium hover:bg-green-50 transition"
                    >
                      Mark done
                    </button>
                  )}
                </div>
              </article>
            ))
          )}
        </section>
      )}

      {tab === 'by-me' && (
        <section className="mt-6 space-y-3">
          {byMe.length === 0 && !loading ? (
            <p className="text-sm text-gray-500">You have not observed anybody yet.</p>
          ) : (
            byMe.map((row) => (
              <article key={row._id} className="rounded-lg border border-gray-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-gray-800">{row.observeeName}</h3>
                    <p className="text-xs text-gray-500">
                      {CYCLE_LABELS[row.cycle] || row.cycle} · {row.subject || 'subject not stated'} ·{' '}
                      {row.observedAt ? shortDate(row.observedAt) : shortDate(row.scheduledFor)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <ScoreBadge score={row.overallScore} />
                    <StatusChip status={row.status} />
                    <button
                      type="button"
                      onClick={() => loadDetail(row._id)}
                      className="text-sm text-blue-600 hover:underline"
                    >
                      Open
                    </button>
                  </div>
                </div>
                {/* The server's own reason, shown before the button is pressed
                    rather than after the round trip. */}
                {row.shareBlockedReason && row.status !== 'cancelled' && !row.isShared && (
                  <p className="mt-2 text-xs text-amber-700">{row.shareBlockedReason}</p>
                )}
              </article>
            ))
          )}
        </section>
      )}

      {tab === 'progress' && (
        <section className="mt-6">
          {!history || !history.timeline.length ? (
            <p className="text-sm text-gray-500">
              No shared observations yet, so there is nothing to compare.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Domain</th>
                    <th className="px-4 py-3">First</th>
                    <th className="px-4 py-3">Latest</th>
                    <th className="px-4 py-3">Movement</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {domainKeys.map((key) => {
                    const row = history.movement[key];
                    return (
                      <tr key={key}>
                        <td className="px-4 py-3 text-gray-800">{domainLabels[key] || key}</td>
                        <td className="px-4 py-3 text-gray-600">{row ? row.first : '—'}</td>
                        <td className="px-4 py-3 text-gray-600">{row ? row.latest : '—'}</td>
                        <td className="px-4 py-3">
                          {row ? <MovementChip change={row.change} /> : <span className="text-xs text-gray-400">one observation only</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {detail && (
        <section className="mt-8 rounded-lg border border-gray-200 bg-white p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-gray-800">
                {detail.observeeName || 'Observation'} · {CYCLE_LABELS[detail.cycle] || detail.cycle}
              </h2>
              <p className="text-xs text-gray-500">
                {detail.subject || 'Subject not stated'} · observer{' '}
                {detail.observerName || 'unknown'} ·{' '}
                {detail.observedAt ? shortDate(detail.observedAt) : shortDate(detail.scheduledFor)}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <StatusChip status={detail.status} />
                {detail.scoresVisible && <ScoreBadge score={detail.overallScore} />}
                {detail.sharingLagDays !== null && detail.sharingLagDays !== undefined && (
                  <span className="text-xs text-gray-500">
                    shared {detail.sharingLagDays} days after the lesson
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setDetail(null)}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Close
            </button>
          </div>

          {detail.awaitingFeedback && (
            <p className="mt-4 rounded bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
              This observation has been carried out but the feedback has not been shared. There is
              nothing to read yet, and that is deliberate — the scores come with the conversation.
            </p>
          )}

          {detail.scoresVisible && (
            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              <div>
                <h3 className="text-sm font-semibold text-gray-700">Rubric</h3>
                {detail.status === 'scheduled' || detail.status === 'observed' ? (
                  <form onSubmit={submitRubric} className="mt-3 space-y-4">
                    <label className="block text-sm">
                      <span className="block text-gray-600 mb-1">Observed on</span>
                      <input
                        type="date"
                        value={observedAt}
                        onChange={(e) => setObservedAt(e.target.value)}
                        className="rounded border border-gray-300 px-3 py-2"
                      />
                    </label>
                    {domainKeys.map((key) => {
                      const value = rubric[key] || {};
                      const previous = previousScoreFor(key);
                      return (
                        <div key={key} className="rounded border border-gray-200 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-sm font-medium text-gray-800">
                              {domainLabels[key] || key}
                            </span>
                            {/* Last cycle's score beside this one — the whole
                                point of running a cycle. */}
                            {previous !== null && (
                              <span className="text-xs text-gray-500">last time: {previous}</span>
                            )}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {[1, 2, 3, 4].map((score) => (
                              <button
                                key={score}
                                type="button"
                                onClick={() =>
                                  setRubric({
                                    ...rubric,
                                    [key]: {
                                      ...value,
                                      score: String(value.score) === String(score) ? '' : score,
                                    },
                                  })
                                }
                                className={`px-3 py-1.5 rounded text-xs font-medium border transition ${
                                  String(value.score) === String(score)
                                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                                    : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                                }`}
                              >
                                {score} · {scoreLabels[score]}
                              </button>
                            ))}
                          </div>
                          <textarea
                            rows={2}
                            value={value.strengths || ''}
                            onChange={(e) =>
                              setRubric({
                                ...rubric,
                                [key]: { ...value, strengths: e.target.value },
                              })
                            }
                            placeholder="What worked"
                            className="mt-2 w-full rounded border border-gray-300 px-3 py-2 text-sm"
                          />
                          <textarea
                            rows={2}
                            value={value.developmentPoints || ''}
                            onChange={(e) =>
                              setRubric({
                                ...rubric,
                                [key]: { ...value, developmentPoints: e.target.value },
                              })
                            }
                            placeholder="What to develop"
                            className="mt-2 w-full rounded border border-gray-300 px-3 py-2 text-sm"
                          />
                        </div>
                      );
                    })}
                    <button
                      type="submit"
                      className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition"
                    >
                      Save the record
                    </button>
                  </form>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {(detail.domains || []).map((domain) => (
                      <li key={domain.key} className="rounded border border-gray-200 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-gray-800">
                            {domainLabels[domain.key] || domain.key}
                          </span>
                          <ScoreBadge score={domain.score} />
                        </div>
                        {domain.strengths && (
                          <p className="mt-1 text-xs text-green-800">{domain.strengths}</p>
                        )}
                        {domain.developmentPoints && (
                          <p className="mt-1 text-xs text-amber-800">{domain.developmentPoints}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="space-y-6">
                <div>
                  <h3 className="text-sm font-semibold text-gray-700">Agreed actions</h3>
                  <ul className="mt-2 space-y-2">
                    {(detail.agreedActions || []).map((action) => (
                      <li key={action._id} className="rounded border border-gray-200 p-3 text-sm">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <span className="text-gray-800">{action.description}</span>
                          <OverdueChip days={action.daysOverdue} />
                        </div>
                        <p className="mt-1 text-xs text-gray-500">
                          due {shortDate(action.dueBy)} ·{' '}
                          {ACTION_STATUS_LABELS[action.status] || action.status}
                        </p>
                        {action.supportOffered && (
                          <p className="mt-1 text-xs text-blue-700">
                            Support: {action.supportOffered}
                          </p>
                        )}
                      </li>
                    ))}
                    {(detail.agreedActions || []).length === 0 && (
                      <li className="text-xs text-gray-500">Nothing agreed yet.</li>
                    )}
                  </ul>

                  {detail.observerName && detail.status !== 'closed' && (
                    <form onSubmit={submitAction} className="mt-3 space-y-2">
                      <textarea
                        required
                        rows={2}
                        value={actionForm.description}
                        onChange={(e) =>
                          setActionForm({ ...actionForm, description: e.target.value })
                        }
                        placeholder="What will be done differently?"
                        className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                      />
                      <div className="flex flex-wrap gap-2">
                        <input
                          required
                          type="date"
                          value={actionForm.dueBy}
                          onChange={(e) => setActionForm({ ...actionForm, dueBy: e.target.value })}
                          className="rounded border border-gray-300 px-3 py-2 text-sm"
                        />
                        <input
                          value={actionForm.supportOffered}
                          onChange={(e) =>
                            setActionForm({ ...actionForm, supportOffered: e.target.value })
                          }
                          placeholder="Support offered"
                          className="flex-1 min-w-[10rem] rounded border border-gray-300 px-3 py-2 text-sm"
                        />
                        <button
                          type="submit"
                          className="px-4 py-2 rounded-md border border-blue-300 text-blue-700 text-sm font-medium hover:bg-blue-50 transition"
                        >
                          Agree
                        </button>
                      </div>
                    </form>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  {!detail.isShared && detail.status !== 'cancelled' && (
                    <button
                      type="button"
                      onClick={share}
                      className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition"
                    >
                      Share the feedback
                    </button>
                  )}
                  {detail.isShared && detail.status !== 'closed' && (
                    <button
                      type="button"
                      onClick={closeObservation}
                      className="px-4 py-2 rounded-md border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 transition"
                    >
                      Close
                    </button>
                  )}
                </div>

                {detail.isShared && !detail.acknowledgedAt && (
                  <div>
                    <h3 className="text-sm font-semibold text-gray-700">Your response</h3>
                    <textarea
                      rows={3}
                      value={responseText}
                      onChange={(e) => setResponseText(e.target.value)}
                      placeholder="Anything you want on the record"
                      className="mt-2 w-full rounded border border-gray-300 px-3 py-2 text-sm"
                    />
                    <button
                      type="button"
                      onClick={acknowledge}
                      className="mt-2 px-4 py-2 rounded-md bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 transition"
                    >
                      Acknowledge
                    </button>
                    <p className="mt-1 text-xs text-gray-500">
                      Only you can acknowledge this — it is the record that the conversation
                      happened.
                    </p>
                  </div>
                )}

                {detail.moderation && (
                  <div className="rounded border border-gray-200 p-3 text-sm">
                    <h3 className="text-sm font-semibold text-gray-700">Moderation</h3>
                    <p className="mt-1 text-gray-700">
                      Agreed score {detail.moderation.agreedScore}
                      {detail.moderation.variance ? ` (${detail.moderation.variance > 0 ? '+' : ''}${detail.moderation.variance} against the observer)` : ''}
                    </p>
                    {detail.moderation.varianceNote && (
                      <p className="mt-1 text-xs text-gray-500">{detail.moderation.varianceNote}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
};

export default LessonObservations;
