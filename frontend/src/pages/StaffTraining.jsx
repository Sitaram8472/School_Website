import { useState, useEffect, useContext, useCallback } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';
import CohortPanel from '../components/training/CohortPanel';

/**
 * Staff professional development and certification.
 *
 * The certification chips are the reason to open this page. An expiry date on
 * its own is a date; a red chip saying "expired 40 days ago" is a thing that
 * gets acted on. Completed and planned hours are shown as two separate figures
 * and are never added together, because a total that mixes intent with
 * achievement is the spreadsheet this replaces.
 *
 * Admins get an Expiring tab, which is the compliance report the school
 * currently cannot produce in any form.
 */

const TYPE_LABELS = {
  workshop: 'Workshop',
  'online-course': 'Online course',
  conference: 'Conference',
  webinar: 'Webinar',
  'in-house': 'In-house',
  mentoring: 'Mentoring',
  certification: 'Certification',
};

const COMPETENCY_LABELS = {
  pedagogy: 'Pedagogy',
  assessment: 'Assessment',
  safeguarding: 'Safeguarding',
  'first-aid': 'First aid',
  'lab-safety': 'Lab safety',
  'fire-safety': 'Fire safety',
  inclusion: 'Inclusion',
  'digital-skills': 'Digital skills',
  leadership: 'Leadership',
  'subject-knowledge': 'Subject knowledge',
  other: 'Other',
};

const STATUS_STYLES = {
  planned: 'bg-slate-100 text-slate-700',
  'in-progress': 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  cancelled: 'bg-gray-200 text-gray-600',
};

const STATUS_LABELS = {
  planned: 'Planned',
  'in-progress': 'Under way',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const APPROVAL_STYLES = {
  'not-required': '',
  pending: 'bg-amber-100 text-amber-800',
  approved: 'bg-green-100 text-green-700',
  declined: 'bg-red-100 text-red-700',
};

const EXPIRY_STYLES = {
  valid: 'bg-green-100 text-green-700',
  'expiring-soon': 'bg-amber-100 text-amber-800',
  expired: 'bg-red-100 text-red-700',
  'not-applicable': 'bg-gray-100 text-gray-500',
};

const emptyRecord = {
  academicYear: '',
  title: '',
  provider: '',
  type: 'workshop',
  competency: 'pedagogy',
  startDate: '',
  endDate: '',
  creditHours: 6,
  isMandatory: false,
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

/** "expires in 40 days" / "expired 12 days ago" — the phrasing people act on. */
const expiryPhrase = (expiry) => {
  if (!expiry || expiry.daysRemaining === null) return 'No expiry';
  if (expiry.daysRemaining < 0) {
    return `Expired ${Math.abs(expiry.daysRemaining)} days ago`;
  }
  if (expiry.daysRemaining === 0) return 'Expires today';
  return `Expires in ${expiry.daysRemaining} days`;
};

const ExpiryChip = ({ expiry }) => (
  <span
    className={`px-2 py-0.5 rounded text-xs font-medium ${
      EXPIRY_STYLES[expiry?.state] || 'bg-gray-100 text-gray-600'
    }`}
    title={expiry?.expiresOn || ''}
  >
    {expiryPhrase(expiry)}
  </span>
);

const StaffTraining = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';

  const [tab, setTab] = useState('mine');
  const [meta, setMeta] = useState(null);

  const [records, setRecords] = useState([]);
  const [summary, setSummary] = useState(null);
  const [approvals, setApprovals] = useState([]);
  const [expiring, setExpiring] = useState(null);
  const [withinDays, setWithinDays] = useState(90);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...emptyRecord, academicYear: currentYear() });

  // Which record's certificate panel is open, and what is typed into it.
  const [certFor, setCertFor] = useState(null);
  const [certForm, setCertForm] = useState({
    reference: '',
    issuedOn: todayKey(),
    validMonths: '',
  });

  const readError = (err, fallback) => err?.response?.data?.message || fallback;

  const clearMessages = () => {
    setError('');
    setNotice('');
  };

  const loadMeta = useCallback(async () => {
    try {
      const { data } = await api.get('/staff-training/meta');
      setMeta(data.data);
    } catch {
      // The form falls back to its own defaults.
    }
  }, []);

  const loadMine = useCallback(async () => {
    setLoading(true);
    try {
      const [recordsRes, summaryRes] = await Promise.all([
        api.get('/staff-training/records/mine'),
        api.get('/staff-training/summary/mine'),
      ]);
      setRecords(recordsRes.data.data || []);
      setSummary(summaryRes.data.data);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load your training records'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadApprovals = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/staff-training/records', {
        params: { approvalStatus: 'pending' },
      });
      setApprovals(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the approval queue'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadExpiring = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/staff-training/expiring', {
        params: { withinDays },
      });
      setExpiring(data.data);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the expiry report'));
    } finally {
      setLoading(false);
    }
  }, [withinDays]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    if (tab === 'mine') loadMine();
    if (tab === 'approvals') loadApprovals();
    if (tab === 'expiring') loadExpiring();
  }, [tab, loadMine, loadApprovals, loadExpiring]);

  const submitRecord = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      await api.post('/staff-training/records', {
        ...form,
        creditHours: Number(form.creditHours),
      });
      setNotice('Record created. Hours count once you mark it complete.');
      setShowForm(false);
      setForm({ ...emptyRecord, academicYear: currentYear() });
      loadMine();
    } catch (err) {
      setError(readError(err, 'Could not create the record'));
    }
  };

  const completeRecord = async (recordId) => {
    clearMessages();
    try {
      const { data } = await api.patch(`/staff-training/records/${recordId}/complete`);
      setNotice(data.message);
      loadMine();
    } catch (err) {
      setError(readError(err, 'Could not complete the record'));
    }
  };

  const startRecord = async (recordId) => {
    clearMessages();
    try {
      await api.patch(`/staff-training/records/${recordId}/start`);
      setNotice('Marked as under way.');
      loadMine();
    } catch (err) {
      setError(readError(err, 'Could not start the record'));
    }
  };

  const saveCertificate = async (recordId) => {
    clearMessages();
    try {
      const { data } = await api.patch(
        `/staff-training/records/${recordId}/certificate`,
        {
          reference: certForm.reference,
          issuedOn: certForm.issuedOn,
          validMonths: certForm.validMonths === '' ? undefined : certForm.validMonths,
        }
      );
      setNotice(data.message);
      setCertFor(null);
      setCertForm({ reference: '', issuedOn: todayKey(), validMonths: '' });
      loadMine();
    } catch (err) {
      setError(readError(err, 'Could not record the certificate'));
    }
  };

  const approveRecord = async (recordId) => {
    clearMessages();
    try {
      const { data } = await api.patch(`/staff-training/records/${recordId}/approve`);
      setNotice(data.message);
      loadApprovals();
    } catch (err) {
      setError(readError(err, 'Could not approve the record'));
    }
  };

  const declineRecord = async (recordId) => {
    const reason = window.prompt('Why is this record being declined?');
    if (!reason) return;
    clearMessages();
    try {
      await api.patch(`/staff-training/records/${recordId}/decline`, { reason });
      setNotice('Record declined.');
      loadApprovals();
    } catch (err) {
      setError(readError(err, 'Could not decline the record'));
    }
  };

  const types = meta?.types || Object.keys(TYPE_LABELS);
  const competencies = meta?.competencies || Object.keys(COMPETENCY_LABELS);

  const tabs = [
    { key: 'mine', label: 'My record' },
    ...(isAdmin
      ? [
          { key: 'approvals', label: 'Approvals' },
          { key: 'expiring', label: 'Expiring' },
        ]
      : []),
  ];

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-gray-800">
          Professional development
        </h1>
        <p className="text-gray-600 mt-1">
          Hours count once training is completed. Certification expiry is
          calculated from the issue date, never typed in.
        </p>
      </header>

      {/* Sessions the school runs, as opposed to the records people keep of
          what they went to. Above the tabs, because taking a seat is the thing
          with a deadline on it. */}
      <CohortPanel />

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
            {entry.key === 'approvals' && approvals.length > 0 && (
              <span className="ml-2 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs">
                {approvals.length}
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
            {showForm ? 'Close' : 'Add training'}
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

      {tab === 'mine' && summary && (
        <section className="mb-6 p-4 rounded-lg border border-gray-200 bg-white">
          <div className="flex flex-wrap gap-8 items-start">
            <div>
              <span
                className={`block text-3xl font-bold ${
                  summary.requirementMet ? 'text-green-600' : 'text-gray-800'
                }`}
              >
                {summary.completedHours}
                <span className="text-lg text-gray-400"> / {summary.requiredHours}</span>
              </span>
              <span className="text-sm text-gray-600">hours completed this year</span>
            </div>
            <div>
              <span className="block text-3xl font-bold text-gray-400">
                {summary.plannedHours}
              </span>
              <span className="text-sm text-gray-600">
                hours planned (not counted)
              </span>
            </div>
            {(summary.expiredCount > 0 || summary.expiringSoonCount > 0) && (
              <div>
                <span className="block text-3xl font-bold text-red-600">
                  {summary.expiredCount + summary.expiringSoonCount}
                </span>
                <span className="text-sm text-gray-600">
                  certifications needing attention
                </span>
              </div>
            )}
          </div>

          {summary.certifications.length > 0 && (
            <div className="mt-4 pt-4 border-t border-gray-100">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">
                My certifications
              </h3>
              <div className="flex flex-wrap gap-2">
                {summary.certifications.map((cert) => (
                  <span
                    key={cert._id}
                    className="flex items-center gap-2 px-2 py-1 rounded border border-gray-200 bg-gray-50 text-xs"
                  >
                    <span className="text-gray-700">
                      {COMPETENCY_LABELS[cert.competency] || cert.competency}
                    </span>
                    <ExpiryChip expiry={cert} />
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {showForm && tab === 'mine' && (
        <form
          onSubmit={submitRecord}
          className="mb-6 p-4 border border-gray-200 rounded-lg bg-gray-50 grid gap-3 md:grid-cols-3"
        >
          <label className="text-sm md:col-span-2">
            <span className="block text-gray-600 mb-1">Title</span>
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Safeguarding refresher"
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Provider</span>
            <input
              type="text"
              value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value })}
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Type</span>
            <select
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            >
              {types.map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABELS[type] || type}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Competency</span>
            <select
              value={form.competency}
              onChange={(e) => setForm({ ...form, competency: e.target.value })}
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            >
              {competencies.map((competency) => (
                <option key={competency} value={competency}>
                  {COMPETENCY_LABELS[competency] || competency}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Credit hours</span>
            <input
              type="number"
              step="0.5"
              min="0.5"
              value={form.creditHours}
              onChange={(e) => setForm({ ...form, creditHours: e.target.value })}
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Starts</span>
            <input
              type="date"
              value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Ends</span>
            <input
              type="date"
              value={form.endDate}
              onChange={(e) => setForm({ ...form, endDate: e.target.value })}
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

          <label className="text-sm flex items-center gap-2 md:col-span-3">
            <input
              type="checkbox"
              checked={form.isMandatory}
              onChange={(e) => setForm({ ...form, isMandatory: e.target.checked })}
            />
            <span className="text-gray-600">
              Mandatory training — needs an admin&apos;s approval before it can be
              completed
            </span>
          </label>

          <div className="md:col-span-3">
            <button
              type="submit"
              className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition"
            >
              Add record
            </button>
          </div>
        </form>
      )}

      {loading && <p className="text-gray-500">Loading…</p>}

      {tab === 'mine' && !loading && (
        <section className="space-y-3">
          {records.length === 0 && (
            <p className="text-gray-500">No training records yet.</p>
          )}

          {records.map((record) => (
            <article
              key={record._id}
              className="border border-gray-200 rounded-lg p-4 bg-white"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium text-gray-800">{record.title}</span>
                <span className="text-sm text-gray-500">{record.provider}</span>
                <span className="text-sm text-gray-500">
                  {COMPETENCY_LABELS[record.competency] || record.competency}
                </span>
                <span className="text-sm font-semibold text-gray-700">
                  {record.creditHours}h
                </span>
                <span className="ml-auto flex items-center gap-2">
                  {record.approvalStatus !== 'not-required' && (
                    <span
                      className={`px-2 py-0.5 rounded text-xs ${
                        APPROVAL_STYLES[record.approvalStatus]
                      }`}
                    >
                      {record.approvalStatus}
                    </span>
                  )}
                  <span
                    className={`px-2 py-0.5 rounded text-xs ${
                      STATUS_STYLES[record.status]
                    }`}
                  >
                    {STATUS_LABELS[record.status]}
                  </span>
                  {record.expiry.state !== 'not-applicable' && (
                    <ExpiryChip expiry={record.expiry} />
                  )}
                </span>
              </div>

              <p className="mt-1 text-sm text-gray-500">
                {record.startDate} to {record.endDate}
                {!record.countsTowardTotal && record.status !== 'cancelled' && (
                  <span className="text-gray-400">
                    {' '}
                    · these hours do not count until the record is completed
                  </span>
                )}
              </p>

              {record.declineReason && (
                <p className="mt-2 text-sm text-red-700">
                  Declined: {record.declineReason}
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                {record.status === 'planned' && (
                  <button
                    type="button"
                    onClick={() => startRecord(record._id)}
                    className="text-sm px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
                  >
                    Mark under way
                  </button>
                )}
                {['planned', 'in-progress'].includes(record.status) && (
                  <button
                    type="button"
                    onClick={() => completeRecord(record._id)}
                    className="text-sm px-3 py-1 rounded bg-green-600 text-white hover:bg-green-700"
                  >
                    Complete
                  </button>
                )}
                {record.status !== 'cancelled' && (
                  <button
                    type="button"
                    onClick={() =>
                      setCertFor(certFor === record._id ? null : record._id)
                    }
                    className="text-sm px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
                  >
                    {record.certificate?.issuedOn
                      ? 'Update certificate'
                      : 'Record certificate'}
                  </button>
                )}
              </div>

              {certFor === record._id && (
                <div className="mt-3 p-3 rounded bg-gray-50 border border-gray-200 flex flex-wrap gap-3 items-end">
                  <label className="text-sm">
                    <span className="block text-gray-600 mb-1">Reference</span>
                    <input
                      type="text"
                      value={certForm.reference}
                      onChange={(e) =>
                        setCertForm({ ...certForm, reference: e.target.value })
                      }
                      className="border border-gray-300 rounded px-3 py-1.5"
                    />
                  </label>
                  <label className="text-sm">
                    <span className="block text-gray-600 mb-1">Issued on</span>
                    <input
                      type="date"
                      value={certForm.issuedOn}
                      onChange={(e) =>
                        setCertForm({ ...certForm, issuedOn: e.target.value })
                      }
                      className="border border-gray-300 rounded px-3 py-1.5"
                    />
                  </label>
                  <label className="text-sm">
                    <span className="block text-gray-600 mb-1">
                      Valid months (blank = standard)
                    </span>
                    <input
                      type="number"
                      min="1"
                      value={certForm.validMonths}
                      onChange={(e) =>
                        setCertForm({ ...certForm, validMonths: e.target.value })
                      }
                      placeholder={String(
                        meta?.defaultValidMonths?.[record.competency] || 36
                      )}
                      className="border border-gray-300 rounded px-3 py-1.5 w-40"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => saveCertificate(record._id)}
                    className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
                  >
                    Save
                  </button>
                  <p className="text-xs text-gray-500 w-full">
                    The expiry date is calculated from the issue date and the
                    validity period. It is not a field you can set.
                  </p>
                </div>
              )}
            </article>
          ))}
        </section>
      )}

      {tab === 'approvals' && !loading && (
        <section className="space-y-3">
          {approvals.length === 0 && (
            <p className="text-gray-500">Nothing waiting for approval.</p>
          )}

          {approvals.map((record) => (
            <article
              key={record._id}
              className="border border-gray-200 rounded-lg p-4 bg-white"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium text-gray-800">
                  {record.staff?.name || 'Unknown'}
                </span>
                <span className="text-sm text-gray-600">{record.title}</span>
                <span className="text-sm text-gray-500">{record.provider}</span>
                <span className="text-sm font-semibold text-gray-700">
                  {record.creditHours}h
                </span>
                <span className="text-sm text-gray-500">
                  {COMPETENCY_LABELS[record.competency] || record.competency}
                </span>
              </div>

              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => approveRecord(record._id)}
                  className="text-sm px-3 py-1 rounded bg-green-600 text-white hover:bg-green-700"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => declineRecord(record._id)}
                  className="text-sm px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
                >
                  Decline
                </button>
              </div>
            </article>
          ))}
        </section>
      )}

      {tab === 'expiring' && !loading && (
        <section>
          <label className="text-sm block mb-4">
            <span className="block text-gray-600 mb-1">Within</span>
            <select
              value={withinDays}
              onChange={(e) => setWithinDays(Number(e.target.value))}
              className="border border-gray-300 rounded px-3 py-1.5"
            >
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={180}>180 days</option>
              <option value={365}>a year</option>
            </select>
          </label>

          {expiring && expiring.expired.length > 0 && (
            <>
              <h2 className="text-lg font-semibold text-red-700 mb-2">
                Already expired ({expiring.expired.length})
              </h2>
              <ul className="space-y-2 mb-6">
                {expiring.expired.map((row) => (
                  <li
                    key={row._id}
                    className="p-3 rounded border border-red-200 bg-red-50 flex flex-wrap items-center gap-3"
                  >
                    <span className="font-medium text-gray-800">
                      {row.staff?.name || 'Unknown'}
                    </span>
                    <span className="text-sm text-gray-600">
                      {COMPETENCY_LABELS[row.competency] || row.competency}
                    </span>
                    <span className="text-sm text-gray-500">{row.title}</span>
                    {row.isMandatory && (
                      <span className="px-2 py-0.5 rounded text-xs bg-red-100 text-red-700">
                        mandatory
                      </span>
                    )}
                    <span className="ml-auto">
                      <ExpiryChip expiry={row.expiry} />
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {expiring && expiring.expiringSoon.length > 0 && (
            <>
              <h2 className="text-lg font-semibold text-amber-700 mb-2">
                Expiring soon ({expiring.expiringSoon.length})
              </h2>
              <ul className="space-y-2">
                {expiring.expiringSoon.map((row) => (
                  <li
                    key={row._id}
                    className="p-3 rounded border border-gray-200 bg-white flex flex-wrap items-center gap-3"
                  >
                    <span className="font-medium text-gray-800">
                      {row.staff?.name || 'Unknown'}
                    </span>
                    <span className="text-sm text-gray-600">
                      {COMPETENCY_LABELS[row.competency] || row.competency}
                    </span>
                    <span className="text-sm text-gray-500">{row.title}</span>
                    {row.isMandatory && (
                      <span className="px-2 py-0.5 rounded text-xs bg-amber-100 text-amber-800">
                        mandatory
                      </span>
                    )}
                    <span className="ml-auto">
                      <ExpiryChip expiry={row.expiry} />
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {expiring &&
            expiring.expired.length === 0 &&
            expiring.expiringSoon.length === 0 && (
              <p className="text-gray-500">
                Nothing lapses inside {withinDays} days.
              </p>
            )}
        </section>
      )}
    </div>
  );
};

export default StaffTraining;
