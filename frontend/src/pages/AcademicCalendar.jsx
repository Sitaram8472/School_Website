import { useState, useEffect, useContext, useCallback, useMemo } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * The academic calendar.
 *
 * The month grid colours each day by its resolved classification and puts the
 * reason on the day itself. A parent looking at the 14th wants to know *why* it
 * is closed, and "Closed" alone sends them to the office to ask.
 *
 * The shortfall panel shows days lost to unplanned closures against days
 * recovered by working Saturdays. That pair is the decision — whether another
 * make-up day is needed — and neither number alone answers it.
 *
 * Nothing on this page adds or subtracts anything. Every figure comes from the
 * server's day walk, which classifies each date exactly once.
 */

const TERM_LABELS = {
  'term-1': 'Term 1',
  'term-2': 'Term 2',
  'term-3': 'Term 3',
  'summer-session': 'Summer session',
};

const EXCEPTION_LABELS = {
  holiday: 'Holiday',
  closure: 'Unplanned closure',
  'working-day': 'Working day',
  'exam-block': 'Exam block',
  event: 'Event',
};

/** One colour per resolved bucket. The legend and the grid read from this. */
const DAY_STYLES = {
  instructional: { cell: 'bg-white text-gray-800 border-gray-200', label: 'Teaching' },
  'school-day': { cell: 'bg-indigo-50 text-indigo-800 border-indigo-200', label: 'Open, no teaching' },
  'weekly-off': { cell: 'bg-gray-100 text-gray-400 border-gray-200', label: 'Weekly closure' },
  holiday: { cell: 'bg-amber-50 text-amber-800 border-amber-200', label: 'Holiday' },
  closure: { cell: 'bg-red-50 text-red-700 border-red-200', label: 'Unplanned closure' },
};

const STATUS_STYLES = {
  draft: 'bg-gray-100 text-gray-600',
  published: 'bg-green-100 text-green-700',
  archived: 'bg-slate-200 text-slate-600',
};

const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const shortDate = (value) => (value ? new Date(value).toLocaleDateString() : '—');

const monthTitle = (monthKey) => {
  const [year, month] = monthKey.split('-');
  return new Date(Date.UTC(Number(year), Number(month) - 1, 1)).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

const StatTile = ({ label, value, tone = 'default', hint }) => {
  const tones = {
    default: 'border-gray-200 bg-white',
    warn: 'border-amber-200 bg-amber-50',
    bad: 'border-red-200 bg-red-50',
    good: 'border-green-200 bg-green-50',
  };
  return (
    <div className={`rounded-lg border p-4 ${tones[tone]}`}>
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-800">{value}</div>
      {hint && <div className="mt-1 text-xs text-gray-500">{hint}</div>}
    </div>
  );
};

/**
 * A month of the term as a 7-column grid.
 *
 * Days before the term starts are blank rather than absent, so the weekday
 * columns line up — a grid where the 1st drifts left is a grid people misread.
 */
const MonthGrid = ({ monthKey, days }) => {
  const cells = useMemo(() => {
    const byKey = new Map(days.map((day) => [day.dayKey, day]));
    const [year, month] = monthKey.split('-').map(Number);
    const first = new Date(Date.UTC(year, month - 1, 1));
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

    const out = [];
    for (let i = 0; i < first.getUTCDay(); i += 1) out.push(null);
    for (let d = 1; d <= daysInMonth; d += 1) {
      const key = `${monthKey}-${String(d).padStart(2, '0')}`;
      out.push({ dayNumber: d, day: byKey.get(key) || null });
    }
    return out;
  }, [monthKey, days]);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-gray-800">{monthTitle(monthKey)}</h3>
      <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[10px] uppercase text-gray-400">
        {WEEKDAY_INITIALS.map((initial, index) => (
          <div key={`${initial}-${index}`}>{initial}</div>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((cell, index) => {
          if (!cell) return <div key={`pad-${index}`} />;
          if (!cell.day) {
            return (
              <div
                key={cell.dayNumber}
                className="rounded border border-dashed border-gray-100 p-1 text-center text-xs text-gray-300"
                title="Outside the term"
              >
                {cell.dayNumber}
              </div>
            );
          }
          const style = DAY_STYLES[cell.day.kind] || DAY_STYLES.instructional;
          return (
            <div
              key={cell.dayNumber}
              className={`rounded border p-1 text-center ${style.cell}`}
              title={cell.day.reason || style.label}
            >
              <div className="text-xs font-medium">{cell.dayNumber}</div>
              {/* The reason on the day itself — the difference between a
                  calendar and a list of closures. */}
              {cell.day.reason && (
                <div className="mt-0.5 truncate text-[9px] leading-tight opacity-80">
                  {cell.day.reason}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const AcademicCalendar = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';

  const [meta, setMeta] = useState(null);
  const [terms, setTerms] = useState([]);
  const [current, setCurrent] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [days, setDays] = useState([]);
  const [sessionSummary, setSessionSummary] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [tab, setTab] = useState('calendar');

  const [termForm, setTermForm] = useState({
    session: '',
    name: 'term-1',
    label: '',
    startDate: '',
    endDate: '',
    statutoryTarget: '',
    weeklyOffDays: [0],
  });

  const [exceptionForm, setExceptionForm] = useState({
    date: '',
    endDate: '',
    kind: 'holiday',
    title: '',
    note: '',
  });

  const readError = (err, fallback) => err?.response?.data?.message || fallback;

  const clearMessages = () => {
    setError('');
    setNotice('');
  };

  const loadMeta = useCallback(async () => {
    try {
      const { data } = await api.get('/academic-calendar/meta');
      setMeta(data.data);
    } catch {
      // The forms fall back to their own labels.
    }
  }, []);

  const loadTerms = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/academic-calendar/terms');
      setTerms(data.data || []);
      setError('');
      return data.data || [];
    } catch (err) {
      setError(readError(err, 'Could not load the calendar'));
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCurrent = useCallback(async () => {
    try {
      const { data } = await api.get('/academic-calendar/terms/current');
      setCurrent(data.data);
      return data.data;
    } catch {
      setCurrent(null);
      return null;
    }
  }, []);

  const loadTerm = useCallback(async (termId) => {
    if (!termId) return;
    setLoading(true);
    try {
      const [detailRes, daysRes] = await Promise.all([
        api.get(`/academic-calendar/terms/${termId}`),
        api.get(`/academic-calendar/terms/${termId}/days`),
      ]);
      setDetail(detailRes.data.data);
      setDays(daysRes.data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load that term'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSession = useCallback(async (session) => {
    if (!session) return;
    try {
      const { data } = await api.get(`/academic-calendar/session/${session}/summary`);
      setSessionSummary(data.data);
    } catch {
      setSessionSummary(null);
    }
  }, []);

  useEffect(() => {
    loadMeta();
    (async () => {
      const list = await loadTerms();
      const today = await loadCurrent();
      const initial = today?._id || (list[0] && list[0]._id);
      if (initial) {
        setSelectedId(initial);
        await loadTerm(initial);
      }
    })();
  }, [loadMeta, loadTerms, loadCurrent, loadTerm]);

  useEffect(() => {
    if (detail?.session) loadSession(detail.session);
  }, [detail, loadSession]);

  const months = useMemo(() => {
    const seen = [];
    for (const day of days) {
      const key = day.dayKey.slice(0, 7);
      if (!seen.includes(key)) seen.push(key);
    }
    return seen;
  }, [days]);

  const summary = detail?.summary;

  // -- actions ---------------------------------------------------------------

  const submitTerm = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      const payload = { ...termForm };
      if (payload.statutoryTarget === '') delete payload.statutoryTarget;
      const { data } = await api.post('/academic-calendar/terms', payload);
      setNotice(data.message || 'Term created');
      await loadTerms();
      setSelectedId(data.data._id);
      await loadTerm(data.data._id);
      setTab('calendar');
    } catch (err) {
      // The overlap refusal names the term it collides with.
      setError(readError(err, 'Could not create the term'));
    }
  };

  const submitException = async (event) => {
    event.preventDefault();
    if (!detail) return;
    clearMessages();
    try {
      const payload = { ...exceptionForm };
      if (!payload.endDate) delete payload.endDate;
      const { data } = await api.post(
        `/academic-calendar/terms/${detail._id}/exceptions`,
        payload
      );
      // The server says what the row actually changed, including "nothing".
      setNotice(data.message);
      setExceptionForm({ date: '', endDate: '', kind: 'holiday', title: '', note: '' });
      await loadTerm(detail._id);
      await loadTerms();
    } catch (err) {
      setError(readError(err, 'Could not add the exception'));
    }
  };

  const removeException = async (exceptionId) => {
    if (!detail) return;
    clearMessages();
    try {
      const { data } = await api.delete(
        `/academic-calendar/terms/${detail._id}/exceptions/${exceptionId}`
      );
      setNotice(data.message);
      await loadTerm(detail._id);
      await loadTerms();
    } catch (err) {
      setError(readError(err, 'Could not remove the exception'));
    }
  };

  const setStatus = async (status) => {
    if (!detail) return;
    clearMessages();
    try {
      const { data } = await api.patch(`/academic-calendar/terms/${detail._id}/status`, {
        status,
      });
      setNotice(data.message);
      await loadTerm(detail._id);
      await loadTerms();
    } catch (err) {
      setError(readError(err, 'Could not change the status'));
    }
  };

  // -- render ----------------------------------------------------------------

  const exceptionKinds = meta?.exceptionKinds || Object.keys(EXCEPTION_LABELS);

  const tabs = [
    { key: 'calendar', label: 'Calendar' },
    { key: 'year', label: 'The year' },
    ...(isAdmin ? [{ key: 'admin', label: 'Edit' }] : []),
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <header>
        <h1 className="text-2xl font-semibold text-gray-800">Academic calendar</h1>
        <p className="mt-1 text-sm text-gray-600 max-w-2xl">
          Every day of the term is classified once — teaching, open but not teaching, or closed —
          and the counts are worked out from that classification each time they are read. A
          holiday declared on a Sunday changes nothing, because a Sunday was never counted.
        </p>
      </header>

      {current && (
        <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          Today is in <strong>{current.label || TERM_LABELS[current.name]}</strong> —{' '}
          {current.today?.kind === 'instructional'
            ? 'a teaching day'
            : current.today?.reason || DAY_STYLES[current.today?.kind]?.label || 'closed'}
          . {current.instructionalDaysRemaining} teaching day
          {current.instructionalDaysRemaining === 1 ? '' : 's'} left this term.
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

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <label className="text-sm">
          <span className="mr-2 text-gray-600">Term</span>
          <select
            value={selectedId}
            onChange={(e) => {
              setSelectedId(e.target.value);
              loadTerm(e.target.value);
            }}
            className="rounded border border-gray-300 px-3 py-2"
          >
            <option value="">Choose a term…</option>
            {terms.map((term) => (
              <option key={term._id} value={term._id}>
                {term.session} · {term.label || TERM_LABELS[term.name] || term.name}
                {term.status !== 'published' ? ` (${term.status})` : ''}
              </option>
            ))}
          </select>
        </label>
        {detail && (
          <span
            className={`px-2 py-0.5 rounded text-xs font-medium ${
              STATUS_STYLES[detail.status] || 'bg-gray-100 text-gray-700'
            }`}
          >
            {detail.status}
          </span>
        )}
        {detail && (
          <span className="text-xs text-gray-500">
            {shortDate(detail.startDate)} — {shortDate(detail.endDate)}
          </span>
        )}
      </div>

      {summary && (
        <div className="mt-4 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatTile label="Teaching days" value={summary.instructionalDays} />
          <StatTile
            label="School days"
            value={summary.schoolDays}
            hint={summary.examBlockDays ? `${summary.examBlockDays} in exams` : undefined}
          />
          <StatTile label="Holidays" value={summary.holidays} />
          <StatTile
            label="Unplanned closures"
            value={summary.unplannedClosures}
            tone={summary.unplannedClosures ? 'bad' : 'default'}
          />
          <StatTile
            label="Recovered"
            value={summary.recoveredByWorkingDays}
            tone={summary.recoveredByWorkingDays ? 'good' : 'default'}
            hint="Working days against the weekly pattern"
          />
          <StatTile
            label="Shortfall"
            value={summary.shortfall === null ? 'not set' : summary.shortfall}
            tone={summary.shortfall ? 'warn' : 'default'}
            hint={
              summary.statutoryTarget
                ? `against ${summary.statutoryTarget} apportioned`
                : 'no target apportioned to this term'
            }
          />
        </div>
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

      {tab === 'calendar' && (
        <section className="mt-6">
          <div className="flex flex-wrap gap-3 text-xs">
            {Object.entries(DAY_STYLES).map(([key, style]) => (
              <span key={key} className="flex items-center gap-1.5">
                <span className={`inline-block h-3 w-3 rounded border ${style.cell}`} />
                {style.label}
              </span>
            ))}
          </div>

          {months.length === 0 && !loading ? (
            <p className="mt-4 text-sm text-gray-500">Choose a term to see its calendar.</p>
          ) : (
            <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {months.map((monthKey) => (
                <MonthGrid key={monthKey} monthKey={monthKey} days={days} />
              ))}
            </div>
          )}

          {detail && (detail.exceptions || []).length > 0 && (
            <div className="mt-6">
              <h3 className="text-sm font-semibold text-gray-700">Exceptions</h3>
              <ul className="mt-2 space-y-2">
                {detail.exceptions.map((exception) => (
                  <li
                    key={exception._id}
                    className="rounded border border-gray-200 bg-white px-3 py-2 text-sm flex flex-wrap items-center justify-between gap-2"
                  >
                    <div>
                      <span className="font-medium text-gray-800">{exception.title}</span>
                      <span className="ml-2 text-xs text-gray-500">
                        {EXCEPTION_LABELS[exception.kind] || exception.kind} ·{' '}
                        {shortDate(exception.date)}
                        {exception.endDate ? ` — ${shortDate(exception.endDate)}` : ''}
                      </span>
                      {exception.note && (
                        <p className="text-xs text-gray-500">{exception.note}</p>
                      )}
                    </div>
                    {isAdmin && detail.status !== 'archived' && (
                      <button
                        type="button"
                        onClick={() => removeException(exception._id)}
                        className="text-xs text-red-600 hover:underline"
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {tab === 'year' && (
        <section className="mt-6">
          {!sessionSummary ? (
            <p className="text-sm text-gray-500">Choose a term to see its session.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatTile
                  label="Teaching days"
                  value={sessionSummary.totals.instructionalDays}
                  hint={`against ${sessionSummary.totals.annualTarget} required`}
                />
                <StatTile
                  label="Shortfall"
                  value={sessionSummary.totals.shortfall}
                  tone={
                    sessionSummary.totals.complete && sessionSummary.totals.shortfall
                      ? 'bad'
                      : 'default'
                  }
                  hint={
                    sessionSummary.totals.complete
                      ? undefined
                      : `only ${sessionSummary.totals.termsRecorded} term(s) recorded`
                  }
                />
                <StatTile
                  label="Days lost"
                  value={sessionSummary.totals.unplannedClosures}
                  tone={sessionSummary.totals.unplannedClosures ? 'bad' : 'default'}
                  hint="Unplanned closures"
                />
                <StatTile
                  label="Days recovered"
                  value={sessionSummary.totals.recoveredByWorkingDays}
                  tone={sessionSummary.totals.recoveredByWorkingDays ? 'good' : 'default'}
                  hint="Working days added"
                />
              </div>

              {/* The pair that decides whether another make-up day is needed.
                  Neither number answers it alone. */}
              {sessionSummary.totals.unplannedClosures >
                sessionSummary.totals.recoveredByWorkingDays && (
                <p className="mt-4 rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  {sessionSummary.totals.unplannedClosures} day
                  {sessionSummary.totals.unplannedClosures === 1 ? '' : 's'} lost to unplanned
                  closures, {sessionSummary.totals.recoveredByWorkingDays} recovered. A further{' '}
                  {sessionSummary.totals.unplannedClosures -
                    sessionSummary.totals.recoveredByWorkingDays}{' '}
                  working day
                  {sessionSummary.totals.unplannedClosures -
                    sessionSummary.totals.recoveredByWorkingDays ===
                  1
                    ? ''
                    : 's'}{' '}
                  would put the year back where it was planned.
                </p>
              )}

              <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200 bg-white">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                    <tr>
                      <th className="px-4 py-3">Term</th>
                      <th className="px-4 py-3">Dates</th>
                      <th className="px-4 py-3 text-right">Teaching</th>
                      <th className="px-4 py-3 text-right">Open</th>
                      <th className="px-4 py-3 text-right">Closed</th>
                      <th className="px-4 py-3 text-right">Shortfall</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {sessionSummary.terms.map((term) => (
                      <tr key={term._id}>
                        <td className="px-4 py-3 text-gray-800">
                          {term.label || TERM_LABELS[term.name] || term.name}
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          {shortDate(term.startDate)} — {shortDate(term.endDate)}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-800">
                          {term.summary.instructionalDays}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-600">
                          {term.summary.schoolDays}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-600">
                          {term.summary.holidays + term.summary.unplannedClosures}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {term.summary.shortfall === null ? (
                            <span className="text-xs text-gray-400">not set</span>
                          ) : (
                            <span
                              className={
                                term.summary.shortfall ? 'text-amber-700 font-medium' : 'text-gray-600'
                              }
                            >
                              {term.summary.shortfall}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}

      {tab === 'admin' && isAdmin && (
        <section className="mt-6 grid gap-6 lg:grid-cols-2">
          <form onSubmit={submitTerm} className="rounded-lg border border-gray-200 bg-white p-5 space-y-4">
            <h3 className="text-sm font-semibold text-gray-700">New term</h3>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">
                <span className="block text-gray-600 mb-1">Session</span>
                <input
                  required
                  value={termForm.session}
                  onChange={(e) => setTermForm({ ...termForm, session: e.target.value })}
                  placeholder="2026-27"
                  className="w-full rounded border border-gray-300 px-3 py-2"
                />
              </label>
              <label className="text-sm">
                <span className="block text-gray-600 mb-1">Term</span>
                <select
                  value={termForm.name}
                  onChange={(e) => setTermForm({ ...termForm, name: e.target.value })}
                  className="w-full rounded border border-gray-300 px-3 py-2"
                >
                  {(meta?.termNames || Object.keys(TERM_LABELS)).map((key) => (
                    <option key={key} value={key}>
                      {TERM_LABELS[key] || key}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="block text-gray-600 mb-1">Starts</span>
                <input
                  required
                  type="date"
                  value={termForm.startDate}
                  onChange={(e) => setTermForm({ ...termForm, startDate: e.target.value })}
                  className="w-full rounded border border-gray-300 px-3 py-2"
                />
              </label>
              <label className="text-sm">
                <span className="block text-gray-600 mb-1">Ends</span>
                <input
                  required
                  type="date"
                  value={termForm.endDate}
                  onChange={(e) => setTermForm({ ...termForm, endDate: e.target.value })}
                  className="w-full rounded border border-gray-300 px-3 py-2"
                />
              </label>
              <label className="text-sm col-span-2">
                <span className="block text-gray-600 mb-1">
                  Teaching days apportioned to this term
                  <span className="text-gray-400">
                    {' '}
                    — the annual requirement is {meta?.annualStatutoryTarget ?? 190}
                  </span>
                </span>
                <input
                  type="number"
                  min="0"
                  value={termForm.statutoryTarget}
                  onChange={(e) => setTermForm({ ...termForm, statutoryTarget: e.target.value })}
                  className="w-full rounded border border-gray-300 px-3 py-2"
                />
              </label>
            </div>

            <div>
              <span className="block text-sm text-gray-600 mb-2">Weekly closures</span>
              <div className="flex flex-wrap gap-2">
                {WEEKDAY_NAMES.map((name, index) => {
                  const on = termForm.weeklyOffDays.includes(index);
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() =>
                        setTermForm({
                          ...termForm,
                          weeklyOffDays: on
                            ? termForm.weeklyOffDays.filter((d) => d !== index)
                            : [...termForm.weeklyOffDays, index],
                        })
                      }
                      className={`px-3 py-1.5 rounded text-xs font-medium border transition ${
                        on
                          ? 'border-gray-500 bg-gray-100 text-gray-800'
                          : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      {name.slice(0, 3)}
                    </button>
                  );
                })}
              </div>
            </div>

            <button
              type="submit"
              className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition"
            >
              Create as draft
            </button>
          </form>

          {detail && detail.status !== 'archived' && (
            <div className="space-y-4">
              <form
                onSubmit={submitException}
                className="rounded-lg border border-gray-200 bg-white p-5 space-y-4"
              >
                <h3 className="text-sm font-semibold text-gray-700">
                  Add an exception to {detail.label || TERM_LABELS[detail.name]}
                </h3>
                <label className="block text-sm">
                  <span className="block text-gray-600 mb-1">Kind</span>
                  <select
                    value={exceptionForm.kind}
                    onChange={(e) => setExceptionForm({ ...exceptionForm, kind: e.target.value })}
                    className="w-full rounded border border-gray-300 px-3 py-2"
                  >
                    {exceptionKinds.map((key) => (
                      <option key={key} value={key}>
                        {EXCEPTION_LABELS[key] || key}
                      </option>
                    ))}
                  </select>
                  {exceptionForm.kind === 'working-day' && (
                    <span className="mt-1 block text-xs text-gray-500">
                      Opens the school on a day the weekly pattern closes — the make-up Saturday.
                    </span>
                  )}
                  {exceptionForm.kind === 'exam-block' && (
                    <span className="mt-1 block text-xs text-gray-500">
                      Open but not teaching. Counts as a school day and not as a teaching day.
                    </span>
                  )}
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-sm">
                    <span className="block text-gray-600 mb-1">From</span>
                    <input
                      required
                      type="date"
                      value={exceptionForm.date}
                      onChange={(e) => setExceptionForm({ ...exceptionForm, date: e.target.value })}
                      className="w-full rounded border border-gray-300 px-3 py-2"
                    />
                  </label>
                  <label className="text-sm">
                    <span className="block text-gray-600 mb-1">
                      To <span className="text-gray-400">— optional</span>
                    </span>
                    <input
                      type="date"
                      value={exceptionForm.endDate}
                      onChange={(e) =>
                        setExceptionForm({ ...exceptionForm, endDate: e.target.value })
                      }
                      className="w-full rounded border border-gray-300 px-3 py-2"
                    />
                  </label>
                </div>
                <label className="block text-sm">
                  <span className="block text-gray-600 mb-1">Title</span>
                  <input
                    required
                    value={exceptionForm.title}
                    onChange={(e) => setExceptionForm({ ...exceptionForm, title: e.target.value })}
                    placeholder="Half term"
                    className="w-full rounded border border-gray-300 px-3 py-2"
                  />
                </label>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition"
                >
                  Add
                </button>
              </form>

              <div className="rounded-lg border border-gray-200 bg-white p-5">
                <h3 className="text-sm font-semibold text-gray-700">Status</h3>
                <div className="mt-3 flex flex-wrap gap-2">
                  {detail.status !== 'published' && (
                    <button
                      type="button"
                      onClick={() => setStatus('published')}
                      className="px-3 py-1.5 rounded bg-green-600 text-white text-xs font-medium hover:bg-green-700 transition"
                    >
                      Publish
                    </button>
                  )}
                  {detail.status !== 'draft' && (
                    <button
                      type="button"
                      onClick={() => setStatus('archived')}
                      className="px-3 py-1.5 rounded border border-gray-300 text-gray-700 text-xs font-medium hover:bg-gray-50 transition"
                    >
                      Archive
                    </button>
                  )}
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  A draft term is visible to admins only. Publishing is what makes it the answer
                  everybody else gets.
                </p>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
};

export default AcademicCalendar;
