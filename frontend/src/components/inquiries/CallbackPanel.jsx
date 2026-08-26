import { useState, useEffect, useCallback, useContext } from 'react';
import {
  PhoneCall,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Inbox,
  BarChart3,
} from 'lucide-react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * The follow-up queue, on the page that fills it.
 *
 * The form above sends an enquiry and, until now, that was the end of it: no
 * status, no assignee, no reply recorded, and no route by which anyone could
 * read one back. This is the other half.
 *
 * The queue leads with **untouched and already late** rather than with the
 * newest, because an enquiry nobody has opened does not appear in a list of
 * callbacks — it has no callback — and those are precisely the ones being
 * dropped. Every deadline shown is measured from when the parent asked, so an
 * enquiry that sat over a weekend reads late here even though nobody has done
 * anything wrong yet.
 *
 * Invisible to the public visitors this page exists for.
 */

const STATUS_LABELS = {
  open: 'Open',
  scheduled: 'Scheduled',
  completed: 'Completed',
  unreachable: 'Unreachable',
  closed: 'Closed',
};

const STATUS_STYLES = {
  open: 'bg-amber-100 text-amber-900',
  scheduled: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  unreachable: 'bg-gray-200 text-gray-600',
  closed: 'bg-green-100 text-green-700',
};

const ATTEMPT_LABELS = {
  spoke: 'Spoke to them',
  'no-answer': 'No answer',
  engaged: 'Engaged',
  'wrong-number': 'Wrong number',
  'left-message': 'Left a message',
  'call-back-later': 'Asked to call back later',
};

const OUTCOME_LABELS = {
  'information-provided': 'Information provided',
  'application-started': 'Application started',
  'visit-booked': 'Visit booked',
  'not-interested': 'Not interested',
  'out-of-scope': 'Not something we do',
  duplicate: 'Duplicate',
};

const shortDateTime = (value) =>
  value
    ? new Date(value).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

const describeRemaining = (hours) => {
  if (hours === null || hours === undefined) return '';
  if (hours < 0) return `${Math.abs(Math.round(hours))}h over`;
  if (hours < 1) return 'due within the hour';
  return `${Math.round(hours)}h left`;
};

const StatusChip = ({ status }) => (
  <span
    className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
      STATUS_STYLES[status] || 'bg-gray-200 text-gray-700'
    }`}
  >
    {STATUS_LABELS[status] || status}
  </span>
);

const CallbackPanel = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isStaff = role === 'admin' || role === 'staff';

  const [meta, setMeta] = useState(null);
  const [inquiries, setInquiries] = useState([]);
  const [stateFilter, setStateFilter] = useState('overdue');
  const [stats, setStats] = useState(null);
  const [showStats, setShowStats] = useState(false);

  const [busyId, setBusyId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 3500);
  };

  const explain = (err, fallback) =>
    setError(err?.response?.data?.message || err?.message || fallback);

  const loadMeta = useCallback(async () => {
    try {
      const res = await api.get('/inquiries/meta');
      setMeta(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load the callback options.');
    }
  }, []);

  const loadInquiries = useCallback(async () => {
    try {
      const query = stateFilter ? `?state=${stateFilter}` : '';
      const res = await api.get(`/inquiries${query}`);
      setInquiries(res.data.data || []);
    } catch (err) {
      explain(err, 'Could not load the enquiries.');
    }
  }, [stateFilter]);

  const loadStats = useCallback(async () => {
    try {
      const res = await api.get('/inquiries/stats');
      setStats(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load the response statistics.');
    }
  }, []);

  useEffect(() => {
    if (!isStaff) return;
    setLoading(true);
    loadMeta().finally(() => setLoading(false));
  }, [isStaff, loadMeta]);

  useEffect(() => {
    if (!isStaff) return;
    loadInquiries();
  }, [isStaff, loadInquiries]);

  const openCallback = async (inquiry) => {
    const phone = window.prompt(
      `Opening a callback for ${inquiry.name}. The deadline is measured from when they ` +
        'asked, so it will not reset now.\n\nTheir phone number, if you have it:'
    );
    if (phone === null) return;

    setBusyId(inquiry._id);
    setError('');
    try {
      await api.post('/inquiries/callbacks', { inquiryId: inquiry._id, phone });
      flash('Callback opened.');
      await loadInquiries();
    } catch (err) {
      explain(err, 'Could not open a callback for that enquiry.');
    } finally {
      setBusyId('');
    }
  };

  const recordAttempt = async (callback, outcome) => {
    setBusyId(callback._id);
    setError('');
    try {
      await api.post(`/inquiries/callbacks/${callback._id}/attempts`, { outcome });
      flash('Attempt recorded.');
      await loadInquiries();
    } catch (err) {
      explain(err, 'Could not record that attempt.');
    } finally {
      setBusyId('');
    }
  };

  const closeCallback = async (callback) => {
    const outcome = window.prompt(
      `How did it end?\n\n${Object.entries(OUTCOME_LABELS)
        .map(([value, label]) => `${value} — ${label}`)
        .join('\n')}`,
      'information-provided'
    );
    if (!outcome) return;

    const note = window.prompt('Anything worth recording?') || '';

    setBusyId(callback._id);
    setError('');
    try {
      await api.patch(`/inquiries/callbacks/${callback._id}/close`, { outcome, note });
      flash('Callback closed.');
      await loadInquiries();
    } catch (err) {
      explain(err, 'Could not close that callback.');
    } finally {
      setBusyId('');
    }
  };

  const markUnreachable = async (callback) => {
    setBusyId(callback._id);
    setError('');
    try {
      await api.patch(`/inquiries/callbacks/${callback._id}/unreachable`, {});
      flash('Marked unreachable.');
      await loadInquiries();
    } catch (err) {
      explain(err, 'Could not mark that unreachable.');
    } finally {
      setBusyId('');
    }
  };

  const reopen = async (callback) => {
    setBusyId(callback._id);
    setError('');
    try {
      await api.post(`/inquiries/callbacks/${callback._id}/reopen`);
      flash('Reopened as a new callback — the first one keeps its own record.');
      await loadInquiries();
    } catch (err) {
      explain(err, 'Could not reopen that callback.');
    } finally {
      setBusyId('');
    }
  };

  const toggleStats = async () => {
    setShowStats((open) => !open);
    if (!stats) await loadStats();
  };

  if (!isStaff) return null;

  const renderCallback = (callback) => (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <StatusChip status={callback.status} />
          {callback.outcome && (
            <span className="ml-2 text-xs text-gray-600">
              {OUTCOME_LABELS[callback.outcome] || callback.outcome}
            </span>
          )}
          <p className="text-xs text-gray-600 mt-1">
            {callback.attemptCount} attempt{callback.attemptCount === 1 ? '' : 's'} across{' '}
            {callback.distinctAttemptDays} day
            {callback.distinctAttemptDays === 1 ? '' : 's'}
            {callback.firstResponseHours !== null && (
              <> · first reply after {callback.firstResponseHours}h</>
            )}
          </p>
        </div>

        {callback.isOpen && (
          <span
            className={`text-xs font-medium flex items-center gap-1 ${
              callback.overdue ? 'text-red-700' : 'text-gray-600'
            }`}
          >
            <Clock size={12} />
            {describeRemaining(callback.hoursRemaining)}
          </span>
        )}
      </div>

      {callback.attempts.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {callback.attempts.map((attempt) => (
            <li key={attempt._id} className="text-xs text-gray-600">
              {shortDateTime(attempt.at)} — {ATTEMPT_LABELS[attempt.outcome] || attempt.outcome}
              {attempt.byName && ` (${attempt.byName})`}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        {callback.isOpen && (
          <>
            <button
              type="button"
              onClick={() => recordAttempt(callback, 'no-answer')}
              disabled={busyId === callback._id}
              className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-white disabled:opacity-50"
            >
              No answer
            </button>
            <button
              type="button"
              onClick={() => recordAttempt(callback, 'spoke')}
              disabled={busyId === callback._id}
              className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-white disabled:opacity-50"
            >
              Spoke to them
            </button>
            <button
              type="button"
              onClick={() => closeCallback(callback)}
              disabled={busyId === callback._id}
              className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Close
            </button>

            {/* Disabled *and* explained. Offering a button the server will
                refuse is how staff learn to distrust the interface. */}
            <button
              type="button"
              onClick={() => markUnreachable(callback)}
              disabled={busyId === callback._id || Boolean(callback.unreachableBlockedReason)}
              title={callback.unreachableBlockedReason || 'Give up on reaching them'}
              className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-white disabled:opacity-40"
            >
              Unreachable
            </button>
          </>
        )}

        {!callback.isOpen && (
          <button
            type="button"
            onClick={() => reopen(callback)}
            disabled={busyId === callback._id}
            className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-white disabled:opacity-50"
          >
            They came back — reopen
          </button>
        )}
      </div>

      {callback.isOpen && callback.unreachableBlockedReason && (
        <p className="text-xs text-gray-500 mt-2">{callback.unreachableBlockedReason}.</p>
      )}
    </div>
  );

  return (
    <section className="mt-12 bg-white rounded-2xl shadow-sm border border-gray-200 p-6 text-left">
      <header className="flex items-start justify-between gap-4 flex-wrap mb-5">
        <div>
          <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
            <PhoneCall size={20} className="text-blue-600" />
            Enquiry follow-up
          </h2>
          <p className="text-sm text-gray-600 mt-1 max-w-2xl">
            Every deadline here is counted from the moment the family sent the form, across
            working hours — not from when somebody in the office opened it.
          </p>
        </div>

        <button
          type="button"
          onClick={toggleStats}
          className="px-3 py-2 rounded-md border border-gray-300 text-sm font-medium hover:bg-gray-50 transition flex items-center gap-2"
        >
          <BarChart3 size={16} />
          {showStats ? 'Hide' : 'Response times'}
        </button>
      </header>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="mb-4 flex items-start gap-2 rounded-md bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-800">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      {loading && <p className="text-sm text-gray-500">Loading…</p>}

      {/* --- response times ---------------------------------------------- */}
      {showStats && stats && (
        <div className="mb-6 rounded-xl border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-800 mb-2">
            Time to first reply, by department
          </h3>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-gray-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">Department</th>
                  <th className="py-2 pr-4 font-medium">Enquiries</th>
                  <th className="py-2 pr-4 font-medium">Median first reply</th>
                  <th className="py-2 pr-4 font-medium">Never attempted</th>
                  <th className="py-2 pr-4 font-medium">Breached</th>
                </tr>
              </thead>
              <tbody>
                {stats.byDepartment.map((row) => (
                  <tr key={row.department} className="border-t border-gray-100">
                    <td className="py-2 pr-4">{row.department}</td>
                    <td className="py-2 pr-4">{row.total}</td>
                    <td className="py-2 pr-4">
                      {row.medianFirstResponseHours === null
                        ? '—'
                        : `${row.medianFirstResponseHours}h`}
                    </td>
                    <td className="py-2 pr-4">
                      <span className={row.neverAttempted > 0 ? 'text-red-700 font-medium' : ''}>
                        {row.neverAttempted}
                      </span>
                    </td>
                    <td className="py-2 pr-4">{row.breached}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {stats.neverPickedUp.length > 0 && (
            <p className="text-xs text-red-800 mt-3">
              Never picked up at all:{' '}
              {stats.neverPickedUp.map((row) => `${row.department} (${row.count})`).join(', ')}.
            </p>
          )}

          <p className="text-xs text-gray-500 mt-2">{stats.note}</p>
        </div>
      )}

      {/* --- the queue ---------------------------------------------------- */}
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
          <Inbox size={16} className="text-blue-600" />
          Enquiries
        </h3>

        <select
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value)}
          className="rounded border border-gray-300 px-2 py-1 text-sm"
        >
          <option value="overdue">Late or untouched</option>
          <option value="untouched">Nobody has opened these</option>
          <option value="open">Currently being handled</option>
          <option value="">Everything</option>
        </select>
      </div>

      {inquiries.length === 0 ? (
        <p className="text-sm text-gray-500">
          Nothing matches that filter — which for “late or untouched” is the answer you want.
        </p>
      ) : (
        <ul className="space-y-4">
          {inquiries.map((inquiry) => (
            <li key={inquiry._id} className="border border-gray-200 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="font-medium text-gray-900">
                    {inquiry.name}
                    <span className="ml-2 text-xs font-normal text-gray-500">
                      {inquiry.department}
                    </span>
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {inquiry.email} · asked {shortDateTime(inquiry.createdAt)}
                  </p>
                  <p className="text-sm text-gray-700 mt-2">{inquiry.message}</p>
                </div>

                {inquiry.untouched && (
                  <span
                    className={`text-xs font-medium px-2 py-1 rounded ${
                      inquiry.lateAndUntouched
                        ? 'bg-red-100 text-red-800'
                        : 'bg-amber-100 text-amber-900'
                    }`}
                  >
                    {inquiry.lateAndUntouched
                      ? `Nobody has opened this — due ${shortDateTime(inquiry.wouldBeDueBy)}`
                      : `Not yet opened — due ${shortDateTime(inquiry.wouldBeDueBy)}`}
                  </span>
                )}
              </div>

              {inquiry.untouched ? (
                <button
                  type="button"
                  onClick={() => openCallback(inquiry)}
                  disabled={busyId === inquiry._id}
                  className="mt-3 text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  Take this one
                </button>
              ) : (
                inquiry.callbacks.map((callback) => (
                  <div key={callback._id}>{renderCallback(callback)}</div>
                ))
              )}
            </li>
          ))}
        </ul>
      )}

      {meta && (
        <p className="text-xs text-gray-500 mt-4">
          Response targets: {Object.entries(meta.departmentSlaHours)
            .map(([department, hours]) => `${department} ${hours}h`)
            .join(' · ')}
          . Counted between {meta.workingDay.start}:00 and {meta.workingDay.end}:00, Monday to
          Saturday.
        </p>
      )}
    </section>
  );
};

export default CallbackPanel;
