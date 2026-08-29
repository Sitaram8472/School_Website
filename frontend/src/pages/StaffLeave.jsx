import { useState, useEffect, useContext, useCallback, useMemo } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * Staff leave — entitlement, requests and the balance between them.
 *
 * Two things on this page are deliberate.
 *
 * The balance cards show taken and remaining, with pending as its own figure
 * that is never subtracted from remaining. A request that has not been decided
 * is not leave that has been taken, and a page that pretends otherwise is how
 * somebody talks themselves out of leave they have.
 *
 * The request form prices itself before it is submitted. Pick the dates, and it
 * says "2.5 days, leaves 4.5 casual" — computed by the server against the
 * working calendar, not by this file. The refusal at approval time is the thing
 * this replaces, and it currently arrives a fortnight after the request.
 */

const TYPE_LABELS = {
  casual: 'Casual',
  sick: 'Sick',
  earned: 'Earned',
  maternity: 'Maternity',
  paternity: 'Paternity',
  bereavement: 'Bereavement',
  unpaid: 'Unpaid',
  study: 'Study',
  compensatory: 'Compensatory',
};

const STATUS_LABELS = {
  draft: 'Draft',
  submitted: 'Awaiting decision',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  withdrawn: 'Withdrawn',
};

const STATUS_STYLES = {
  draft: 'bg-slate-100 text-slate-700',
  submitted: 'bg-amber-100 text-amber-800',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-200 text-gray-600',
  withdrawn: 'bg-gray-200 text-gray-600',
};

const HALF_LABELS = {
  full: 'Full day',
  morning: 'Morning only',
  afternoon: 'Afternoon only',
};

const WEEKDAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' },
];

const todayKey = () => {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
};

const emptyRequest = {
  type: 'casual',
  startDate: todayKey(),
  endDate: todayKey(),
  startHalf: 'full',
  endHalf: 'full',
  reason: '',
  contactDuringLeave: '',
  medicalCertificateRef: '',
  coverRequired: false,
};

const emptyPeriod = {
  dayOfWeek: 1,
  periodLabel: '',
  startTime: '09:00',
  endTime: '09:45',
  className: '',
  subject: '',
  room: '',
  lessonPlan: '',
};

/** "2.5 days" reads better than "2.5", and "half a day" better than "0.5". */
const daysPhrase = (units) => {
  if (units === null || units === undefined) return '—';
  if (units === 0.5) return 'half a day';
  if (units === 1) return '1 day';
  return `${units} days`;
};

const StatusChip = ({ status }) => (
  <span
    className={`px-2 py-0.5 rounded text-xs font-medium ${
      STATUS_STYLES[status] || 'bg-gray-100 text-gray-600'
    }`}
  >
    {STATUS_LABELS[status] || status}
  </span>
);

/**
 * One leave type's ledger.
 *
 * Pending sits under the bar as its own number rather than inside it, because
 * the bar is "what you have used" and a pending request is not that.
 */
const BalanceCard = ({ line }) => {
  const granted = line.granted || 0;
  const usedPercent = granted ? Math.min((line.taken / granted) * 100, 100) : 0;
  const pendingPercent = granted ? Math.min((line.pending / granted) * 100, 100) : 0;

  return (
    <div className="border rounded-lg p-4 bg-white shadow-sm">
      <div className="flex items-baseline justify-between">
        <h3 className="font-semibold text-gray-800">
          {TYPE_LABELS[line.type] || line.type}
        </h3>
        {!line.metered && (
          <span className="text-xs text-gray-500" title="Not drawn from an allowance">
            unmetered
          </span>
        )}
      </div>

      {line.metered ? (
        <>
          <p className="mt-2 text-2xl font-bold text-gray-900">
            {line.remaining}
            <span className="text-sm font-normal text-gray-500"> of {granted} left</span>
          </p>

          <div className="mt-2 h-2 w-full rounded bg-gray-100 overflow-hidden flex">
            <div className="h-full bg-blue-500" style={{ width: `${usedPercent}%` }} />
            <div
              className="h-full bg-amber-300"
              style={{ width: `${Math.min(pendingPercent, 100 - usedPercent)}%` }}
            />
          </div>

          <dl className="mt-3 grid grid-cols-3 gap-2 text-xs text-gray-600">
            <div>
              <dt className="text-gray-400">Taken</dt>
              <dd className="font-medium text-gray-800">{line.taken}</dd>
            </div>
            <div>
              <dt className="text-gray-400">Pending</dt>
              <dd className="font-medium text-amber-700">{line.pending}</dd>
            </div>
            <div>
              <dt className="text-gray-400">Carried in</dt>
              <dd className="font-medium text-gray-800">{line.carriedIn}</dd>
            </div>
          </dl>

          {line.overdrawn > 0 && (
            <p className="mt-2 text-xs text-red-600">
              Overdrawn by {line.overdrawn} day(s)
            </p>
          )}
          {line.carryCap === 0 && line.remaining > 0 && (
            <p className="mt-2 text-xs text-gray-500">
              Nothing carries forward — {line.remaining} lapse(s) at year end
            </p>
          )}
        </>
      ) : (
        <p className="mt-2 text-2xl font-bold text-gray-900">
          {line.taken}
          <span className="text-sm font-normal text-gray-500"> taken</span>
        </p>
      )}
    </div>
  );
};

const StaffLeave = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';

  const [tab, setTab] = useState('mine');
  const [meta, setMeta] = useState(null);

  const [ledger, setLedger] = useState(null);
  const [requests, setRequests] = useState([]);
  const [queue, setQueue] = useState([]);
  const [calendar, setCalendar] = useState(null);
  const [calendarFrom, setCalendarFrom] = useState(todayKey());

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...emptyRequest });
  const [periods, setPeriods] = useState([]);
  const [periodDraft, setPeriodDraft] = useState({ ...emptyPeriod });
  const [preview, setPreview] = useState(null);

  const readError = (err, fallback) => err?.response?.data?.message || fallback;

  const clearMessages = () => {
    setError('');
    setNotice('');
  };

  const loadMeta = useCallback(async () => {
    try {
      const { data } = await api.get('/staff-leave/meta');
      setMeta(data.data);
    } catch {
      // The form falls back to its own defaults.
    }
  }, []);

  const loadMine = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/staff-leave/entitlements/mine');
      setLedger(data.data.ledger);
      setRequests(data.data.requests || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load your leave ledger'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/staff-leave/requests/pending');
      setQueue(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the approval queue'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCalendar = useCallback(async () => {
    setLoading(true);
    try {
      const from = calendarFrom;
      const to = new Date(Date.parse(`${from}T00:00:00`) + 27 * 86400000);
      const toKey = [
        to.getFullYear(),
        String(to.getMonth() + 1).padStart(2, '0'),
        String(to.getDate()).padStart(2, '0'),
      ].join('-');

      const { data } = await api.get('/staff-leave/requests/calendar', {
        params: { from, to: toKey },
      });
      setCalendar(data.data);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the absence calendar'));
    } finally {
      setLoading(false);
    }
  }, [calendarFrom]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    if (tab === 'mine') loadMine();
    if (tab === 'queue') loadQueue();
    if (tab === 'calendar') loadCalendar();
  }, [tab, loadMine, loadQueue, loadCalendar]);

  /**
   * Ask the server what this would cost. Debounced by the effect's dependency
   * list rather than by a timer — the request only fires when the fields it
   * depends on actually change.
   */
  useEffect(() => {
    if (!showForm || !form.startDate || !form.endDate) {
      setPreview(null);
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const { data } = await api.post('/staff-leave/requests/preview', {
          type: form.type,
          startDate: form.startDate,
          endDate: form.endDate,
          startHalf: form.startHalf,
          endHalf: form.endHalf,
        });
        if (!cancelled) setPreview(data.data);
      } catch {
        if (!cancelled) setPreview(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    showForm,
    form.type,
    form.startDate,
    form.endDate,
    form.startHalf,
    form.endHalf,
  ]);

  const addPeriod = () => {
    if (!periodDraft.periodLabel || !periodDraft.className || !periodDraft.subject) {
      setError('A cover period needs a label, a class and a subject');
      return;
    }
    setPeriods((current) => [...current, { ...periodDraft }]);
    setPeriodDraft({ ...emptyPeriod, dayOfWeek: periodDraft.dayOfWeek });
    setError('');
  };

  const removePeriod = (index) => {
    setPeriods((current) => current.filter((_, i) => i !== index));
  };

  const submitRequest = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      const { data } = await api.post('/staff-leave/requests', {
        ...form,
        coverPeriods: form.coverRequired ? periods : [],
      });
      setNotice(`${data.message}. Submit it when you are ready.`);
      setShowForm(false);
      setForm({ ...emptyRequest });
      setPeriods([]);
      setPreview(null);
      loadMine();
    } catch (err) {
      setError(readError(err, 'Could not save the request'));
    }
  };

  const submitForApproval = async (requestId) => {
    clearMessages();
    try {
      const { data } = await api.patch(`/staff-leave/requests/${requestId}/submit`);
      setNotice(data.message);
      loadMine();
    } catch (err) {
      setError(readError(err, 'Could not submit the request'));
    }
  };

  const cancelRequest = async (requestId, isApproved) => {
    const reason = window.prompt(
      isApproved ? 'Why is this leave being withdrawn?' : 'Cancel this draft? Add a note.'
    );
    if (reason === null) return;
    clearMessages();
    try {
      const { data } = await api.patch(`/staff-leave/requests/${requestId}/cancel`, {
        reason,
      });
      setNotice(data.message);
      loadMine();
    } catch (err) {
      setError(readError(err, 'Could not cancel the request'));
    }
  };

  const approve = async (requestId) => {
    clearMessages();
    try {
      const { data } = await api.patch(`/staff-leave/requests/${requestId}/approve`);
      setNotice(data.message);
      loadQueue();
    } catch (err) {
      setError(readError(err, 'Could not approve the request'));
    }
  };

  const reject = async (requestId) => {
    const reason = window.prompt('Why is this request being rejected?');
    if (!reason) return;
    clearMessages();
    try {
      await api.patch(`/staff-leave/requests/${requestId}/reject`, { reason });
      setNotice('Rejected.');
      loadQueue();
    } catch (err) {
      setError(readError(err, 'Could not reject the request'));
    }
  };

  const leaveTypes = meta?.leaveTypes || Object.keys(TYPE_LABELS);
  const unmetered = useMemo(() => new Set(meta?.unmeteredTypes || []), [meta]);

  const upcoming = useMemo(
    () =>
      requests
        .filter((r) => r.status === 'approved' && r.endDate >= todayKey())
        .sort((a, b) => (a.startDate < b.startDate ? -1 : 1)),
    [requests]
  );

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Leave</h1>
        <p className="mt-1 text-gray-600">
          Your entitlement, what you have taken, and what is left. Every figure here is
          worked out from your approved requests when the page loads — none of it is a
          stored total.
        </p>
      </header>

      <nav className="flex gap-2 border-b mb-6">
        {[
          { key: 'mine', label: 'My leave' },
          ...(isAdmin
            ? [
                { key: 'queue', label: 'Approvals' },
                { key: 'calendar', label: 'Who is out' },
              ]
            : []),
        ].map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => setTab(entry.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === entry.key
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {notice}
        </div>
      )}
      {loading && <p className="mb-4 text-sm text-gray-500">Loading…</p>}

      {tab === 'mine' && (
        <section>
          {ledger && (
            <>
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="text-lg font-semibold text-gray-800">
                  {ledger.academicYear}
                  {ledger.isClosed && (
                    <span className="ml-2 text-xs font-normal text-gray-500">
                      (year closed)
                    </span>
                  )}
                </h2>
                <button
                  type="button"
                  onClick={() => setShowForm((open) => !open)}
                  className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                  disabled={ledger.isClosed}
                >
                  {showForm ? 'Close' : 'Request leave'}
                </button>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {ledger.lines
                  .filter((line) => line.metered || line.taken > 0)
                  .map((line) => (
                    <BalanceCard key={line.type} line={line} />
                  ))}
              </div>

              {ledger.adjustmentReason && (
                <p className="mt-3 text-xs text-gray-500">
                  Opening adjustment of {ledger.openingAdjustment} day(s) on{' '}
                  {TYPE_LABELS[ledger.adjustmentType] || ledger.adjustmentType}:{' '}
                  {ledger.adjustmentReason}
                </p>
              )}
            </>
          )}

          {showForm && (
            <form
              onSubmit={submitRequest}
              className="mt-6 rounded-lg border bg-white p-5 shadow-sm"
            >
              <h3 className="font-semibold text-gray-800 mb-4">New request</h3>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="text-gray-600">Type</span>
                  <select
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={form.type}
                    onChange={(e) => setForm({ ...form, type: e.target.value })}
                  >
                    {leaveTypes.map((type) => (
                      <option key={type} value={type}>
                        {TYPE_LABELS[type] || type}
                        {unmetered.has(type) ? ' (unmetered)' : ''}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-sm">
                  <span className="text-gray-600">Contact while away</span>
                  <input
                    type="text"
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={form.contactDuringLeave}
                    onChange={(e) =>
                      setForm({ ...form, contactDuringLeave: e.target.value })
                    }
                    placeholder="Phone or email"
                  />
                </label>

                <label className="text-sm">
                  <span className="text-gray-600">From</span>
                  <input
                    type="date"
                    required
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={form.startDate}
                    onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                  />
                </label>

                <label className="text-sm">
                  <span className="text-gray-600">To</span>
                  <input
                    type="date"
                    required
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={form.endDate}
                    onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                  />
                </label>

                <label className="text-sm">
                  <span className="text-gray-600">First day</span>
                  <select
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={form.startHalf}
                    onChange={(e) => setForm({ ...form, startHalf: e.target.value })}
                  >
                    {Object.entries(HALF_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-sm">
                  <span className="text-gray-600">Last day</span>
                  <select
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={form.endHalf}
                    onChange={(e) => setForm({ ...form, endHalf: e.target.value })}
                  >
                    {Object.entries(HALF_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {form.type === 'sick' && (
                <label className="mt-4 block text-sm">
                  <span className="text-gray-600">
                    Medical certificate reference (needed over{' '}
                    {meta?.certificateThresholdDays ?? 3} days)
                  </span>
                  <input
                    type="text"
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={form.medicalCertificateRef}
                    onChange={(e) =>
                      setForm({ ...form, medicalCertificateRef: e.target.value })
                    }
                  />
                </label>
              )}

              <label className="mt-4 block text-sm">
                <span className="text-gray-600">Reason</span>
                <textarea
                  required
                  rows={2}
                  className="mt-1 w-full rounded border px-3 py-2"
                  value={form.reason}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                />
              </label>

              {/* The cost, stated before the request is raised. */}
              {preview && (
                <div
                  className={`mt-4 rounded border px-4 py-3 text-sm ${
                    preview.problem || preview.shortfall > 0 || preview.overlaps.length
                      ? 'border-amber-200 bg-amber-50 text-amber-900'
                      : 'border-blue-200 bg-blue-50 text-blue-900'
                  }`}
                >
                  {preview.problem ? (
                    <p>{preview.problem}</p>
                  ) : (
                    <>
                      <p className="font-medium">
                        {daysPhrase(preview.dayUnits)} — leaves {preview.remainingAfter}{' '}
                        {TYPE_LABELS[form.type] || form.type}
                      </p>
                      {preview.workingDays.length > 0 && (
                        <p className="mt-1 text-xs">
                          Working days counted: {preview.workingDays.join(', ')}
                        </p>
                      )}
                      {preview.shortfall > 0 && (
                        <p className="mt-1">
                          That is {preview.shortfall} day(s) more than you have. It will be
                          refused at approval unless the excess is raised as unpaid leave.
                        </p>
                      )}
                      {preview.overlaps.length > 0 && (
                        <p className="mt-1">
                          This overlaps leave already booked from{' '}
                          {preview.overlaps[0].startDate} to {preview.overlaps[0].endDate}.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}

              <label className="mt-4 flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={form.coverRequired}
                  onChange={(e) =>
                    setForm({ ...form, coverRequired: e.target.checked })
                  }
                />
                My lessons need cover
              </label>

              {form.coverRequired && (
                <div className="mt-3 rounded border bg-gray-50 p-4">
                  <p className="text-xs text-gray-600 mb-3">
                    List each lesson once, by weekday. Approval turns these into cover
                    requests on the substitute board for every working day of the leave.
                  </p>

                  {periods.length > 0 && (
                    <ul className="mb-3 space-y-1 text-sm">
                      {periods.map((period, index) => (
                        <li
                          key={`${period.periodLabel}-${index}`}
                          className="flex items-center justify-between rounded bg-white px-3 py-2 border"
                        >
                          <span>
                            {WEEKDAYS.find((d) => d.value === Number(period.dayOfWeek))
                              ?.label || period.dayOfWeek}{' '}
                            · {period.periodLabel} · {period.className} {period.subject} ·{' '}
                            {period.startTime}–{period.endTime}
                          </span>
                          <button
                            type="button"
                            onClick={() => removePeriod(index)}
                            className="text-xs text-red-600 hover:underline"
                          >
                            remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="grid gap-2 sm:grid-cols-3">
                    <select
                      className="rounded border px-2 py-1 text-sm"
                      value={periodDraft.dayOfWeek}
                      onChange={(e) =>
                        setPeriodDraft({
                          ...periodDraft,
                          dayOfWeek: Number(e.target.value),
                        })
                      }
                    >
                      {WEEKDAYS.map((day) => (
                        <option key={day.value} value={day.value}>
                          {day.label}
                        </option>
                      ))}
                    </select>
                    <input
                      className="rounded border px-2 py-1 text-sm"
                      placeholder="Period 3"
                      value={periodDraft.periodLabel}
                      onChange={(e) =>
                        setPeriodDraft({ ...periodDraft, periodLabel: e.target.value })
                      }
                    />
                    <input
                      className="rounded border px-2 py-1 text-sm"
                      placeholder="Room 12"
                      value={periodDraft.room}
                      onChange={(e) =>
                        setPeriodDraft({ ...periodDraft, room: e.target.value })
                      }
                    />
                    <input
                      type="time"
                      className="rounded border px-2 py-1 text-sm"
                      value={periodDraft.startTime}
                      onChange={(e) =>
                        setPeriodDraft({ ...periodDraft, startTime: e.target.value })
                      }
                    />
                    <input
                      type="time"
                      className="rounded border px-2 py-1 text-sm"
                      value={periodDraft.endTime}
                      onChange={(e) =>
                        setPeriodDraft({ ...periodDraft, endTime: e.target.value })
                      }
                    />
                    <input
                      className="rounded border px-2 py-1 text-sm"
                      placeholder="8B"
                      value={periodDraft.className}
                      onChange={(e) =>
                        setPeriodDraft({ ...periodDraft, className: e.target.value })
                      }
                    />
                    <input
                      className="rounded border px-2 py-1 text-sm sm:col-span-2"
                      placeholder="Physics"
                      value={periodDraft.subject}
                      onChange={(e) =>
                        setPeriodDraft({ ...periodDraft, subject: e.target.value })
                      }
                    />
                    <button
                      type="button"
                      onClick={addPeriod}
                      className="rounded bg-gray-800 px-3 py-1 text-sm text-white hover:bg-gray-900"
                    >
                      Add lesson
                    </button>
                  </div>

                  <textarea
                    rows={2}
                    className="mt-2 w-full rounded border px-3 py-2 text-sm"
                    placeholder="What should the substitute do with the class?"
                    value={periodDraft.lessonPlan}
                    onChange={(e) =>
                      setPeriodDraft({ ...periodDraft, lessonPlan: e.target.value })
                    }
                  />
                </div>
              )}

              <div className="mt-5 flex gap-2">
                <button
                  type="submit"
                  className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Save draft
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowForm(false);
                    setPreview(null);
                  }}
                  className="rounded border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {upcoming.length > 0 && (
            <div className="mt-6 rounded border border-green-200 bg-green-50 px-4 py-3">
              <p className="text-sm font-medium text-green-900">
                Booked: {upcoming[0].startDate} to {upcoming[0].endDate} —{' '}
                {daysPhrase(upcoming[0].dayUnits)} of{' '}
                {TYPE_LABELS[upcoming[0].type] || upcoming[0].type}
              </p>
            </div>
          )}

          <h3 className="mt-8 mb-3 font-semibold text-gray-800">My requests</h3>
          {requests.length === 0 ? (
            <p className="text-sm text-gray-500">Nothing raised this year.</p>
          ) : (
            <ul className="space-y-3">
              {requests.map((request) => (
                <li
                  key={request._id}
                  className="rounded-lg border bg-white p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-gray-900">
                        {TYPE_LABELS[request.type] || request.type} ·{' '}
                        {daysPhrase(request.dayUnits)}
                      </p>
                      <p className="text-sm text-gray-600">
                        {request.startDate}
                        {request.startHalf !== 'full' &&
                          ` (${HALF_LABELS[request.startHalf].toLowerCase()})`}{' '}
                        → {request.endDate}
                        {request.endHalf !== 'full' &&
                          ` (${HALF_LABELS[request.endHalf].toLowerCase()})`}
                      </p>
                    </div>
                    <StatusChip status={request.status} />
                  </div>

                  <p className="mt-2 text-sm text-gray-700">{request.reason}</p>

                  {request.coverRequired && (
                    <p className="mt-1 text-xs text-gray-500">
                      Cover on {request.datesNeedingCover?.length || 0} day(s)
                      {request.linkedAbsences?.length
                        ? ` · ${request.linkedAbsences.length} on the board`
                        : ''}
                    </p>
                  )}

                  {request.decisionNote && (
                    <p className="mt-1 text-xs text-gray-600 italic">
                      {request.decisionNote}
                    </p>
                  )}

                  <div className="mt-3 flex gap-2">
                    {request.status === 'draft' && (
                      <button
                        type="button"
                        onClick={() => submitForApproval(request._id)}
                        className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
                      >
                        Submit
                      </button>
                    )}
                    {['draft', 'submitted', 'approved'].includes(request.status) && (
                      <button
                        type="button"
                        onClick={() =>
                          cancelRequest(request._id, request.status === 'approved')
                        }
                        className="rounded border px-3 py-1 text-xs text-gray-700 hover:bg-gray-50"
                      >
                        {request.status === 'approved' ? 'Withdraw' : 'Cancel'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === 'queue' && isAdmin && (
        <section>
          <h2 className="mb-3 text-lg font-semibold text-gray-800">
            Awaiting a decision
          </h2>
          {queue.length === 0 ? (
            <p className="text-sm text-gray-500">Nothing is waiting.</p>
          ) : (
            <ul className="space-y-3">
              {queue.map((request) => (
                <li
                  key={request._id}
                  className={`rounded-lg border bg-white p-4 shadow-sm ${
                    request.wouldOverdraw ? 'border-amber-300' : ''
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-gray-900">
                        {request.staff?.name || request.staffName || 'Unnamed'} ·{' '}
                        {TYPE_LABELS[request.type] || request.type}
                      </p>
                      <p className="text-sm text-gray-600">
                        {request.startDate} → {request.endDate} ·{' '}
                        {daysPhrase(request.dayUnits)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-gray-500">Remaining</p>
                      <p
                        className={`text-lg font-bold ${
                          request.wouldOverdraw ? 'text-red-600' : 'text-gray-900'
                        }`}
                      >
                        {request.remaining}
                      </p>
                    </div>
                  </div>

                  <p className="mt-2 text-sm text-gray-700">{request.reason}</p>

                  {request.wouldOverdraw && (
                    <p className="mt-2 text-sm text-red-700">
                      This is more leave than remains. Approval will be refused — the
                      excess has to be re-raised as unpaid leave.
                    </p>
                  )}
                  {request.overlaps?.length > 0 && (
                    <p className="mt-1 text-sm text-amber-800">
                      Overlaps leave from {request.overlaps[0].startDate} to{' '}
                      {request.overlaps[0].endDate}.
                    </p>
                  )}
                  {request.medicalCertificateRef && (
                    <p className="mt-1 text-xs text-gray-500">
                      Certificate: {request.medicalCertificateRef}
                    </p>
                  )}

                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => approve(request._id)}
                      className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => reject(request._id)}
                      className="rounded border border-red-300 px-3 py-1 text-xs text-red-700 hover:bg-red-50"
                    >
                      Reject
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === 'calendar' && isAdmin && (
        <section>
          <div className="mb-3 flex items-center gap-3">
            <h2 className="text-lg font-semibold text-gray-800">Who is out</h2>
            <input
              type="date"
              className="rounded border px-3 py-1 text-sm"
              value={calendarFrom}
              onChange={(e) => setCalendarFrom(e.target.value)}
            />
            <span className="text-xs text-gray-500">four weeks from</span>
          </div>

          {!calendar || calendar.days.length === 0 ? (
            <p className="text-sm text-gray-500">Nobody is booked off in that window.</p>
          ) : (
            <ul className="space-y-2">
              {calendar.days.map((day) => (
                <li
                  key={day.date}
                  className="flex flex-wrap items-center gap-3 rounded border bg-white px-4 py-3"
                >
                  <span className="w-28 font-medium text-gray-800">{day.date}</span>
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${
                      day.count >= 3
                        ? 'bg-red-100 text-red-700'
                        : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {day.count} out
                  </span>
                  <span className="text-sm text-gray-600">
                    {day.people
                      .map(
                        (person) =>
                          `${person.staffName || 'Unnamed'}${
                            person.isPartial ? ' (half)' : ''
                          }${person.status === 'submitted' ? ' — pending' : ''}`
                      )
                      .join(', ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
};

export default StaffLeave;
