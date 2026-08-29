import { useState, useEffect, useCallback, useContext, useMemo } from 'react';
import {
  CalendarClock,
  AlarmClock,
  Timer,
  ShieldAlert,
  Plus,
  RefreshCw,
  CheckCircle2,
  Ban,
} from 'lucide-react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * Appeal windows on the calendar.
 *
 * The panel is built around one thing a student could not previously find out:
 * the date their right to appeal a particular exam runs out. It leads with the
 * windows that are open and the hours left in each, because a countdown is the
 * only form of a deadline anybody acts on.
 *
 * Staff get the same list with the create, publish and extend controls folded
 * into it, deliberately in the same place rather than on a separate admin
 * screen — the person extending a window is looking at the countdown when they
 * decide to.
 */

const STATE_STYLES = {
  open: 'bg-green-100 text-green-700',
  scheduled: 'bg-blue-100 text-blue-700',
  expired: 'bg-gray-200 text-gray-600',
  closed: 'bg-gray-200 text-gray-600',
  cancelled: 'bg-red-100 text-red-700',
  draft: 'bg-amber-100 text-amber-800',
};

const STATE_LABELS = {
  open: 'Open now',
  scheduled: 'Opens later',
  expired: 'Closed',
  closed: 'Closed',
  cancelled: 'Cancelled',
  draft: 'Draft',
};

const ASSESSMENT_LABELS = {
  'class-test': 'Class test',
  'unit-test': 'Unit test',
  'mid-term': 'Mid-term',
  terminal: 'Terminal exam',
  'board-practice': 'Board practice',
  other: 'Other',
};

const EMPTY_FORM = {
  exam: '',
  resultsPublishedAt: '',
  opensAt: '',
  closesAt: '',
  graceHours: 0,
  assessmentType: 'other',
  academicYear: '',
  maxAppealsPerStudent: 1,
  instructions: '',
};

const formatDateTime = (value) =>
  value
    ? new Date(value).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

/**
 * A countdown a person can read.
 *
 * Hours are what matters on the last day and days are what matters before it,
 * so the unit changes rather than the number growing to three figures.
 */
const formatRemaining = (hours) => {
  if (hours === null || hours === undefined) return '—';
  if (hours <= 0) return 'closed';
  if (hours < 48) return `${Math.round(hours)} hours left`;
  return `${Math.floor(hours / 24)} days left`;
};

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in local time, not an ISO string. */
const toLocalInput = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
};

const AppealWindowCalendar = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isStaff = role === 'teacher' || role === 'admin';
  const isAdmin = role === 'admin';

  const [calendar, setCalendar] = useState(null);
  const [meta, setMeta] = useState(null);
  const [manageRows, setManageRows] = useState([]);
  const [exams, setExams] = useState([]);

  const [showManage, setShowManage] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 3500);
  };

  const explain = (err, fallback) =>
    err?.response?.data?.message || err?.message || fallback;

  const loadCalendar = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const [calendarRes, metaRes] = await Promise.all([
        api.get('/appeals/windows/calendar'),
        api.get('/appeals/windows/meta'),
      ]);

      setCalendar(calendarRes.data.data);
      setMeta(metaRes.data.data);
    } catch (err) {
      setError(explain(err, 'Could not load appeal windows.'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadManage = useCallback(async () => {
    if (!isStaff) return;

    try {
      const [listRes, examRes] = await Promise.all([
        api.get('/appeals/windows'),
        api.get('/appeals/windows/exams'),
      ]);

      setManageRows(listRes.data.data || []);
      setExams(examRes.data.data || []);
    } catch (err) {
      setError(explain(err, 'Could not load the window list.'));
    }
  }, [isStaff]);

  useEffect(() => {
    // The calendar is only meaningful to somebody with a session; the routes
    // behind it sit under the appeals router's blanket `protect`.
    if (user) loadCalendar();
  }, [user, loadCalendar]);

  useEffect(() => {
    if (showManage) loadManage();
  }, [showManage, loadManage]);

  const openWindows = calendar?.open || [];
  const upcoming = calendar?.upcoming || [];
  const recentlyClosed = calendar?.recentlyClosed || [];

  // The window closing soonest, which is the only one worth putting at the top
  // of the page. The server already sorts by closing time, so this is the head.
  const closingNext = openWindows[0] || null;

  const availableExams = useMemo(
    () => exams.filter((exam) => !exam.existingWindowStatus),
    [exams]
  );

  const startForm = () => {
    const now = new Date();
    const defaultDays = meta?.defaultWindowDays || 14;

    setForm({
      ...EMPTY_FORM,
      resultsPublishedAt: toLocalInput(now),
      opensAt: toLocalInput(now),
      closesAt: toLocalInput(new Date(now.getTime() + defaultDays * 86400000)),
    });
    setShowForm(true);
  };

  const submitForm = async (event) => {
    event.preventDefault();
    setError('');

    if (!form.exam) {
      setError('Choose the exam this window applies to.');
      return;
    }

    setBusyId('create');

    try {
      await api.post('/appeals/windows', {
        ...form,
        graceHours: Number(form.graceHours) || 0,
        maxAppealsPerStudent: Number(form.maxAppealsPerStudent) || 1,
      });

      flash('Window drafted. Publish it when the dates are right.');
      setShowForm(false);
      setForm(EMPTY_FORM);
      await Promise.all([loadManage(), loadCalendar()]);
    } catch (err) {
      setError(explain(err, 'Could not create the window.'));
    } finally {
      setBusyId('');
    }
  };

  const publish = async (id) => {
    setBusyId(id);
    setError('');

    try {
      await api.patch(`/appeals/windows/${id}/publish`);
      flash('Window published. Students can see the deadline now.');
      await Promise.all([loadManage(), loadCalendar()]);
    } catch (err) {
      setError(explain(err, 'Could not publish the window.'));
    } finally {
      setBusyId('');
    }
  };

  const extend = async (id) => {
    const days = window.prompt('Extend by how many days?', '7');
    if (days === null) return;

    const reason = window.prompt('Why is it being extended? This is recorded.');
    if (reason === null) return;

    if (!reason.trim()) {
      setError('An extension needs a reason.');
      return;
    }

    setBusyId(id);
    setError('');

    try {
      await api.patch(`/appeals/windows/${id}/extend`, { days: Number(days), reason });
      flash('Window extended for the whole cohort.');
      await Promise.all([loadManage(), loadCalendar()]);
    } catch (err) {
      setError(explain(err, 'Could not extend the window.'));
    } finally {
      setBusyId('');
    }
  };

  const cancel = async (id) => {
    const reason = window.prompt('Why is this window being cancelled? This is recorded.');
    if (reason === null) return;

    if (!reason.trim()) {
      setError('A cancellation needs a reason.');
      return;
    }

    setBusyId(id);
    setError('');

    try {
      await api.patch(`/appeals/windows/${id}/cancel`, { reason });
      flash('Window cancelled.');
      await Promise.all([loadManage(), loadCalendar()]);
    } catch (err) {
      setError(explain(err, 'Could not cancel the window.'));
    } finally {
      setBusyId('');
    }
  };

  // Nothing here means anything to a visitor who is not signed in, and the
  // routes would 401 anyway, so the section stays off the page entirely.
  if (!user) return null;

  const renderRow = (row) => (
    <div
      key={row._id}
      className="border border-slate-200 rounded-lg p-4 bg-white flex flex-col gap-2"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-slate-800">{row.examTitle || 'Untitled exam'}</p>
          <p className="text-sm text-slate-500">
            {row.courseName || 'No course'} ·{' '}
            {ASSESSMENT_LABELS[row.assessmentType] || row.assessmentType}
          </p>
        </div>

        <span
          className={`px-2 py-1 rounded text-xs font-medium whitespace-nowrap ${
            STATE_STYLES[row.state] || 'bg-gray-100 text-gray-600'
          }`}
        >
          {STATE_LABELS[row.state] || row.state}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm text-slate-600">
        <span>Opens {formatDateTime(row.opensAt)}</span>
        <span>Closes {formatDateTime(row.effectiveClosesAt)}</span>
        <span className={row.state === 'open' ? 'text-green-700 font-medium' : ''}>
          <Timer size={14} className="inline mr-1" />
          {formatRemaining(row.hoursRemaining)}
        </span>
      </div>

      {row.graceHours > 0 && (
        <p className="text-xs text-slate-500">
          Includes {row.graceHours} hours of grace after the stated closing time.
        </p>
      )}

      {row.extensionCount > 0 && (
        <p className="text-xs text-amber-700">
          Extended {row.extensionCount} {row.extensionCount === 1 ? 'time' : 'times'}.
        </p>
      )}

      {row.instructions && <p className="text-sm text-slate-600">{row.instructions}</p>}

      {row.cancellationReason && (
        <p className="text-sm text-red-700">Cancelled: {row.cancellationReason}</p>
      )}
    </div>
  );

  return (
    <section className="max-w-6xl mx-auto px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2 text-slate-800">
            <CalendarClock className="text-blue-600" size={24} />
            Exam appeal deadlines
          </h2>
          <p className="text-slate-500 text-sm mt-1">
            When you can ask for a paper to be looked at again, and until when.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={loadCalendar}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50"
          >
            <RefreshCw size={16} />
            Refresh
          </button>

          {isStaff && (
            <button
              type="button"
              onClick={() => setShowManage((open) => !open)}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-slate-800 text-white hover:bg-slate-700"
            >
              {showManage ? 'Hide' : 'Manage'} windows
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md bg-red-50 border border-red-200 p-3 text-red-700">
          <ShieldAlert size={18} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="mb-4 flex items-start gap-2 rounded-md bg-green-50 border border-green-200 p-3 text-green-700">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      {closingNext && (
        <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4 flex items-start gap-3">
          <AlarmClock className="text-blue-600 mt-0.5 shrink-0" size={20} />
          <div>
            <p className="font-semibold text-blue-900">
              Closing next: {closingNext.examTitle || 'Untitled exam'}
            </p>
            <p className="text-sm text-blue-800">
              {formatRemaining(closingNext.hoursRemaining)} — closes{' '}
              {formatDateTime(closingNext.effectiveClosesAt)}.
            </p>
          </div>
        </div>
      )}

      {loading && <p className="text-slate-500">Loading deadlines…</p>}

      {!loading && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div>
            <h3 className="font-semibold text-slate-700 mb-3">Open now</h3>
            <div className="space-y-3">
              {openWindows.length ? (
                openWindows.map(renderRow)
              ) : (
                <p className="text-sm text-slate-500">
                  Nothing is open for appeal at the moment.
                </p>
              )}
            </div>
          </div>

          <div>
            <h3 className="font-semibold text-slate-700 mb-3">Opening soon</h3>
            <div className="space-y-3">
              {upcoming.length ? (
                upcoming.map(renderRow)
              ) : (
                <p className="text-sm text-slate-500">Nothing scheduled yet.</p>
              )}
            </div>
          </div>

          <div>
            <h3 className="font-semibold text-slate-700 mb-3">Recently closed</h3>
            <div className="space-y-3">
              {recentlyClosed.length ? (
                recentlyClosed.map(renderRow)
              ) : (
                <p className="text-sm text-slate-500">Nothing has closed this week.</p>
              )}
            </div>
          </div>
        </div>
      )}

      <p className="mt-6 text-xs text-slate-500">
        Where an exam has no published window, appeals stay open for{' '}
        {meta?.defaultWindowDays ?? 14} days from the result, as they always have.
      </p>

      {isStaff && showManage && (
        <div className="mt-8 border-t border-slate-200 pt-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <h3 className="text-lg font-semibold text-slate-800">All windows</h3>

            <button
              type="button"
              onClick={startForm}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-700"
            >
              <Plus size={16} />
              New window
            </button>
          </div>

          {showForm && (
            <form
              onSubmit={submitForm}
              className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4 rounded-lg border border-slate-200 p-4 bg-slate-50"
            >
              <label className="text-sm text-slate-700 md:col-span-2">
                Exam
                <select
                  value={form.exam}
                  onChange={(e) => setForm({ ...form, exam: e.target.value })}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
                >
                  <option value="">Choose an exam…</option>
                  {availableExams.map((exam) => (
                    <option key={exam._id} value={exam._id}>
                      {exam.title} {exam.courseName ? `— ${exam.courseName}` : ''}
                    </option>
                  ))}
                </select>
                {!availableExams.length && (
                  <span className="text-xs text-slate-500">
                    Every exam already has a live window.
                  </span>
                )}
              </label>

              <label className="text-sm text-slate-700">
                Results published at
                <input
                  type="datetime-local"
                  value={form.resultsPublishedAt}
                  onChange={(e) => setForm({ ...form, resultsPublishedAt: e.target.value })}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
                />
              </label>

              <label className="text-sm text-slate-700">
                Assessment type
                <select
                  value={form.assessmentType}
                  onChange={(e) => setForm({ ...form, assessmentType: e.target.value })}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
                >
                  {(meta?.assessmentTypes || []).map((type) => (
                    <option key={type} value={type}>
                      {ASSESSMENT_LABELS[type] || type}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-sm text-slate-700">
                Opens at
                <input
                  type="datetime-local"
                  value={form.opensAt}
                  onChange={(e) => setForm({ ...form, opensAt: e.target.value })}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
                />
              </label>

              <label className="text-sm text-slate-700">
                Closes at
                <input
                  type="datetime-local"
                  value={form.closesAt}
                  onChange={(e) => setForm({ ...form, closesAt: e.target.value })}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
                />
              </label>

              <label className="text-sm text-slate-700">
                Grace hours
                <input
                  type="number"
                  min="0"
                  max={meta?.maxGraceHours ?? 72}
                  value={form.graceHours}
                  onChange={(e) => setForm({ ...form, graceHours: e.target.value })}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
                />
              </label>

              <label className="text-sm text-slate-700">
                Appeals allowed per student
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={form.maxAppealsPerStudent}
                  onChange={(e) =>
                    setForm({ ...form, maxAppealsPerStudent: e.target.value })
                  }
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
                />
              </label>

              <label className="text-sm text-slate-700 md:col-span-2">
                Instructions for students
                <textarea
                  rows="2"
                  value={form.instructions}
                  onChange={(e) => setForm({ ...form, instructions: e.target.value })}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
                  placeholder="What a student should attach, who to ask first, and so on."
                />
              </label>

              <div className="md:col-span-2 flex gap-3">
                <button
                  type="submit"
                  disabled={busyId === 'create'}
                  className="px-4 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
                >
                  {busyId === 'create' ? 'Saving…' : 'Save draft'}
                </button>

                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="px-4 py-2 rounded-md border border-slate-300 text-slate-600 hover:bg-white"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          <div className="space-y-3">
            {manageRows.length ? (
              manageRows.map((row) => (
                <div
                  key={row._id}
                  className="border border-slate-200 rounded-lg p-4 bg-white"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-800">
                        {row.examTitle || 'Untitled exam'}
                      </p>
                      <p className="text-sm text-slate-500">
                        {row.courseName || 'No course'} · closes{' '}
                        {formatDateTime(row.effectiveClosesAt)} ·{' '}
                        {formatRemaining(row.hoursRemaining)}
                      </p>
                    </div>

                    <span
                      className={`px-2 py-1 rounded text-xs font-medium ${
                        STATE_STYLES[row.state] || 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {STATE_LABELS[row.state] || row.state}
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {row.status === 'draft' && (
                      <button
                        type="button"
                        disabled={busyId === row._id}
                        onClick={() => publish(row._id)}
                        className="px-3 py-1.5 text-sm rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-60"
                      >
                        Publish
                      </button>
                    )}

                    {row.status === 'published' && (
                      <button
                        type="button"
                        disabled={busyId === row._id}
                        onClick={() => extend(row._id)}
                        className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
                      >
                        Extend
                      </button>
                    )}

                    {isAdmin && row.status !== 'cancelled' && row.status !== 'closed' && (
                      <button
                        type="button"
                        disabled={busyId === row._id}
                        onClick={() => cancel(row._id)}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-60"
                      >
                        <Ban size={14} />
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-slate-500">No windows have been created yet.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
};

export default AppealWindowCalendar;
