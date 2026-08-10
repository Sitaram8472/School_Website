import { useState, useEffect, useContext, useCallback } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * Community service hours.
 *
 * The one number at the top is verified hours against the requirement. Pending
 * hours are shown beside it, greyed and never added in, because a student who
 * has claimed forty hours and had six verified has six hours — and a page that
 * blurs those two is how the shortfall stays hidden until the final term.
 *
 * Staff land on the verification queue instead of the ledger. The queue carries
 * the supervisor's contact on the row so that checking an entry is a phone call
 * rather than a research project, and it greys out rows the viewer is not
 * allowed to sign off before they click.
 */

const CATEGORY_LABELS = {
  environment: 'Environment',
  education: 'Education',
  'elderly-care': 'Elderly care',
  'animal-welfare': 'Animal welfare',
  'community-kitchen': 'Community kitchen',
  fundraising: 'Fundraising',
  'health-camp': 'Health camp',
  'disaster-relief': 'Disaster relief',
  'school-service': 'School service',
  other: 'Other',
};

const STATUS_STYLES = {
  pending: 'bg-amber-100 text-amber-800',
  verified: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  withdrawn: 'bg-gray-200 text-gray-600',
};

const STATUS_LABELS = {
  pending: 'Awaiting verification',
  verified: 'Verified',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

const emptyEntry = {
  academicYear: '',
  activityTitle: '',
  organisation: '',
  category: 'environment',
  date: '',
  hours: 2,
  description: '',
  supervisorName: '',
  supervisorContact: '',
  evidenceUrl: '',
};

const todayKey = () => {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
};

const currentYear = () => {
  const now = new Date();
  const startYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
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

/**
 * Verified fills the bar; pending is drawn as a hatched extension beyond it so
 * it reads as "claimed, not counted" rather than as progress.
 */
const ProgressBar = ({ progress }) => {
  const verified = Math.min(progress.percentComplete, 100);
  const pendingShare = progress.requiredHours
    ? Math.min((progress.pendingHours / progress.requiredHours) * 100, 100 - verified)
    : 0;

  return (
    <div>
      <div className="flex h-4 bg-gray-100 rounded overflow-hidden">
        <div
          className={progress.requirementMet ? 'bg-green-600' : 'bg-blue-600'}
          style={{ width: `${verified}%` }}
        />
        <div
          className="bg-gray-300"
          style={{ width: `${pendingShare}%` }}
          title={`${progress.pendingHours} hours awaiting verification`}
        />
      </div>
      <div className="flex flex-wrap gap-4 mt-2 text-sm">
        <span className="font-semibold text-gray-800">
          {progress.verifiedHours} of {progress.requiredHours} hours verified
        </span>
        {progress.pendingHours > 0 && (
          <span className="text-gray-500">
            {progress.pendingHours} awaiting verification (not counted)
          </span>
        )}
        {progress.requirementMet ? (
          <span className="text-green-700 font-medium">Requirement met</span>
        ) : (
          <span className="text-gray-600">
            {progress.remainingHours} hours still needed
          </span>
        )}
      </div>
    </div>
  );
};

const ServiceHours = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isStaff = role === 'teacher' || role === 'admin';

  const [tab, setTab] = useState(isStaff ? 'queue' : 'mine');
  const [meta, setMeta] = useState(null);

  const [entries, setEntries] = useState([]);
  const [progress, setProgress] = useState(null);
  const [queue, setQueue] = useState([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    ...emptyEntry,
    academicYear: currentYear(),
    date: todayKey(),
  });
  const [saving, setSaving] = useState(false);

  const readError = (err, fallback) => err?.response?.data?.message || fallback;

  const clearMessages = () => {
    setError('');
    setNotice('');
  };

  const loadMeta = useCallback(async () => {
    try {
      const { data } = await api.get('/service-hours/meta');
      setMeta(data.data);
    } catch {
      // The form falls back to its own defaults.
    }
  }, []);

  const loadMine = useCallback(async () => {
    setLoading(true);
    try {
      const [entriesRes, progressRes] = await Promise.all([
        api.get('/service-hours/entries/mine'),
        api.get('/service-hours/progress/mine'),
      ]);
      setEntries(entriesRes.data.data || []);
      setProgress(progressRes.data.data);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load your service hours'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/service-hours/pending');
      setQueue(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the verification queue'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    if (tab === 'mine') loadMine();
    if (tab === 'queue') loadQueue();
  }, [tab, loadMine, loadQueue]);

  const submitEntry = async (event) => {
    event.preventDefault();
    setSaving(true);
    clearMessages();
    try {
      await api.post('/service-hours/entries', {
        ...form,
        hours: Number(form.hours),
      });
      setNotice('Submitted. It will count once a member of staff has verified it.');
      setShowForm(false);
      setForm({ ...emptyEntry, academicYear: currentYear(), date: todayKey() });
      loadMine();
    } catch (err) {
      setError(readError(err, 'Could not log those hours'));
    } finally {
      setSaving(false);
    }
  };

  const withdrawEntry = async (entryId) => {
    clearMessages();
    try {
      await api.patch(`/service-hours/entries/${entryId}/withdraw`);
      setNotice('Entry withdrawn.');
      loadMine();
    } catch (err) {
      setError(readError(err, 'Could not withdraw that entry'));
    }
  };

  const verifyEntry = async (entryId) => {
    clearMessages();
    try {
      const { data } = await api.patch(`/service-hours/entries/${entryId}/verify`);
      setNotice(data.message);
      loadQueue();
    } catch (err) {
      setError(readError(err, 'Could not verify that entry'));
    }
  };

  const rejectEntry = async (entryId) => {
    const reason = window.prompt('Why is this entry being rejected?');
    if (!reason) return;
    clearMessages();
    try {
      await api.patch(`/service-hours/entries/${entryId}/reject`, { reason });
      setNotice('Entry rejected. The student can correct and resubmit it.');
      loadQueue();
    } catch (err) {
      setError(readError(err, 'Could not reject that entry'));
    }
  };

  const categories = meta?.categories || Object.keys(CATEGORY_LABELS);

  const tabs = [
    ...(isStaff ? [{ key: 'queue', label: `Verification queue` }] : []),
    { key: 'mine', label: 'My hours' },
  ];

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-gray-800">Community service</h1>
        <p className="text-gray-600 mt-1">
          Hours count once a member of staff who was not involved in the activity
          has verified them.
        </p>
      </header>

      <div className="flex flex-wrap gap-2 mb-6 border-b border-gray-200">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => {
              setTab(entry.key);
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

        {tab === 'mine' && (
          <button
            type="button"
            onClick={() => {
              setShowForm((open) => !open);
              clearMessages();
            }}
            className="ml-auto mb-1 bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition"
          >
            {showForm ? 'Close' : 'Log hours'}
          </button>
        )}
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

      {tab === 'mine' && progress && (
        <section className="mb-6 p-4 rounded-lg border border-gray-200 bg-white">
          <ProgressBar progress={progress} />

          {progress.byCategory.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {progress.byCategory.map((row) => (
                <span
                  key={row.category}
                  className="px-2 py-1 rounded bg-gray-50 border border-gray-200 text-xs text-gray-600"
                >
                  {CATEGORY_LABELS[row.category] || row.category}: {row.verified}h
                  {row.pending > 0 && (
                    <span className="text-gray-400"> (+{row.pending} pending)</span>
                  )}
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      {showForm && tab === 'mine' && (
        <form
          onSubmit={submitEntry}
          className="mb-6 p-4 border border-gray-200 rounded-lg bg-gray-50 grid gap-3 md:grid-cols-3"
        >
          <label className="text-sm md:col-span-2">
            <span className="block text-gray-600 mb-1">What did you do?</span>
            <input
              type="text"
              value={form.activityTitle}
              onChange={(e) => setForm({ ...form, activityTitle: e.target.value })}
              placeholder="Weekend beach clean"
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Category</span>
            <select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            >
              {categories.map((category) => (
                <option key={category} value={category}>
                  {CATEGORY_LABELS[category] || category}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Organisation</span>
            <input
              type="text"
              value={form.organisation}
              onChange={(e) => setForm({ ...form, organisation: e.target.value })}
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Date</span>
            <input
              type="date"
              value={form.date}
              max={todayKey()}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">
              Hours (max {meta?.maxHoursPerEntry || 8})
            </span>
            <input
              type="number"
              step="0.5"
              min={meta?.minHours || 0.5}
              max={meta?.maxHoursPerEntry || 8}
              value={form.hours}
              onChange={(e) => setForm({ ...form, hours: e.target.value })}
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Supervisor name</span>
            <input
              type="text"
              value={form.supervisorName}
              onChange={(e) => setForm({ ...form, supervisorName: e.target.value })}
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Supervisor contact</span>
            <input
              type="text"
              value={form.supervisorContact}
              onChange={(e) =>
                setForm({ ...form, supervisorContact: e.target.value })
              }
              placeholder="Phone or email"
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Academic year</span>
            <input
              type="text"
              value={form.academicYear}
              onChange={(e) => setForm({ ...form, academicYear: e.target.value })}
              placeholder="2026-27"
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>

          <label className="text-sm md:col-span-3">
            <span className="block text-gray-600 mb-1">
              Describe the work (this is what the verifier reads)
            </span>
            <textarea
              rows={3}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>

          <div className="md:col-span-3">
            <button
              type="submit"
              disabled={saving}
              className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-60 transition"
            >
              {saving ? 'Submitting…' : 'Submit for verification'}
            </button>
          </div>
        </form>
      )}

      {loading && <p className="text-gray-500">Loading…</p>}

      {tab === 'mine' && !loading && (
        <section className="space-y-3">
          {entries.length === 0 && (
            <p className="text-gray-500">You have not logged any hours yet.</p>
          )}

          {entries.map((entry) => (
            <article
              key={entry._id}
              className="border border-gray-200 rounded-lg p-4 bg-white"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium text-gray-800">
                  {entry.activityTitle}
                </span>
                <span className="text-sm text-gray-500">{entry.organisation}</span>
                <span className="text-sm text-gray-500">{entry.date}</span>
                <span className="font-semibold text-gray-700">{entry.hours}h</span>
                <span className="ml-auto">
                  <StatusChip status={entry.status} />
                </span>
              </div>

              {entry.rejectionReason && (
                <p className="mt-2 text-sm text-red-700">
                  Rejected: {entry.rejectionReason} — edit the entry to resubmit it.
                </p>
              )}

              {entry.verifiedBy?.name && (
                <p className="mt-2 text-sm text-green-700">
                  Verified by {entry.verifiedBy.name}
                </p>
              )}

              {['pending', 'rejected'].includes(entry.status) && (
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => withdrawEntry(entry._id)}
                    className="text-sm px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
                  >
                    Withdraw
                  </button>
                </div>
              )}
            </article>
          ))}
        </section>
      )}

      {tab === 'queue' && !loading && (
        <section className="space-y-3">
          {queue.length === 0 && (
            <p className="text-gray-500">Nothing waiting for verification.</p>
          )}

          {queue.map((entry) => (
            <article
              key={entry._id}
              className={`border rounded-lg p-4 ${
                entry.verifiabilityError
                  ? 'border-gray-200 bg-gray-50 opacity-75'
                  : 'border-gray-200 bg-white'
              }`}
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium text-gray-800">
                  {entry.student?.name || 'Unknown student'}
                </span>
                <span className="text-sm text-gray-600">{entry.activityTitle}</span>
                <span className="text-sm text-gray-500">{entry.organisation}</span>
                <span className="text-sm text-gray-500">{entry.date}</span>
                <span className="font-semibold text-gray-700">{entry.hours}h</span>
                {entry.waitingDays > 0 && (
                  <span
                    className={`text-xs ${
                      entry.waitingDays > 14 ? 'text-red-600 font-medium' : 'text-gray-400'
                    }`}
                  >
                    waiting {entry.waitingDays}d
                  </span>
                )}
              </div>

              <p className="mt-2 text-sm text-gray-600">{entry.description}</p>

              <p className="mt-2 text-sm text-gray-500">
                Supervisor: {entry.supervisorName} · {entry.supervisorContact}
              </p>

              {entry.verifiabilityError ? (
                <p className="mt-3 text-sm text-amber-700">
                  {entry.verifiabilityError}
                </p>
              ) : (
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => verifyEntry(entry._id)}
                    className="text-sm px-3 py-1 rounded bg-green-600 text-white hover:bg-green-700"
                  >
                    Verify {entry.hours}h
                  </button>
                  <button
                    type="button"
                    onClick={() => rejectEntry(entry._id)}
                    className="text-sm px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
                  >
                    Reject
                  </button>
                </div>
              )}
            </article>
          ))}
        </section>
      )}
    </div>
  );
};

export default ServiceHours;
