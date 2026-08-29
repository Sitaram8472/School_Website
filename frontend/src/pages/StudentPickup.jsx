import { useState, useEffect, useContext, useCallback, useMemo } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * Authorised pickup and student release.
 *
 * The gate screen is the reason this page exists, and it is built around three
 * decisions.
 *
 * Restricted names appear first, in red, above everything else. Sorting them to
 * the bottom or hiding them behind a tab is how a barred person gets waved
 * through by somebody working down a list with a queue behind them.
 *
 * An authorisation that is not usable right now is still shown, greyed, with
 * the reason — "expired on 12 Sep", "Tuesdays and Thursdays only". A name that
 * simply vanishes from the list looks like a mistake in the software, and the
 * person at the gate rings the office instead of reading the reason.
 *
 * Recording a release asks how the person was verified, and choosing "override"
 * demands a reason and a named approver before the button does anything. The
 * child goes home either way; the difference is whether the school can say what
 * happened.
 */

const RELATIONSHIP_LABELS = {
  parent: 'Parent',
  guardian: 'Guardian',
  grandparent: 'Grandparent',
  sibling: 'Sibling',
  relative: 'Relative',
  neighbour: 'Neighbour',
  driver: 'Driver',
  staff: 'Staff',
  other: 'Other',
};

const RELEASE_TYPE_LABELS = {
  'end-of-day': 'End of day',
  'early-collection': 'Early collection',
  emergency: 'Emergency',
  activity: 'Activity',
  medical: 'Medical',
};

const VERIFICATION_LABELS = {
  code: 'Quoted the code',
  'photo-id': 'Showed photo ID',
  'known-to-staff': 'Known to staff',
  override: 'Override — no valid authorisation',
};

const STATUS_STYLES = {
  pending: 'bg-amber-100 text-amber-800',
  active: 'bg-green-100 text-green-700',
  suspended: 'bg-orange-100 text-orange-800',
  revoked: 'bg-gray-200 text-gray-600',
  expired: 'bg-gray-200 text-gray-600',
};

const SCOPE_LABELS = {
  standing: 'Standing',
  'date-range': 'Between dates',
  'single-day': 'One day only',
};

const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

const todayKey = () => {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
};

const emptyAuthorisation = {
  student: '',
  studentName: '',
  guardianName: '',
  relationship: 'grandparent',
  phone: '',
  altPhone: '',
  idType: 'other',
  idLastFour: '',
  scope: 'single-day',
  validFrom: todayKey(),
  validUntil: '',
  daysOfWeek: [],
  notBefore: '',
  notAfter: '',
  notes: '',
};

const emptyRelease = {
  type: 'end-of-day',
  verifiedBy: 'known-to-staff',
  verificationCode: '',
  overrideReason: '',
  overrideApprovedBy: '',
  expectedReturn: '',
  collectedByName: '',
  notes: '',
};

const timeOfDay = (iso) => {
  if (!iso) return '';
  const date = new Date(iso);
  return [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
  ].join(':');
};

/** A collector, as the gate sees them. Red first, grey when unusable. */
const CollectorCard = ({ row, onRelease, canRelease }) => {
  if (row.isRestricted) {
    return (
      <li className="rounded-lg border-2 border-red-400 bg-red-50 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-bold text-red-800">{row.guardianName}</p>
            <p className="text-sm text-red-700">
              {RELATIONSHIP_LABELS[row.relationship] || row.relationship}
            </p>
          </div>
          <span className="rounded bg-red-600 px-2 py-0.5 text-xs font-bold uppercase text-white">
            Must not collect
          </span>
        </div>
        <p className="mt-2 text-sm text-red-800">{row.restrictionNote}</p>
      </li>
    );
  }

  const usable = row.validity.valid;

  return (
    <li
      className={`rounded-lg border p-4 ${
        usable ? 'border-green-300 bg-white' : 'border-gray-200 bg-gray-50 opacity-75'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          {row.photoUrl ? (
            <img
              src={row.photoUrl}
              alt=""
              className="h-12 w-12 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gray-200 text-sm font-semibold text-gray-600">
              {row.guardianName.slice(0, 2).toUpperCase()}
            </div>
          )}
          <div>
            <p className="font-semibold text-gray-900">{row.guardianName}</p>
            <p className="text-sm text-gray-600">
              {RELATIONSHIP_LABELS[row.relationship] || row.relationship}
              {row.phoneMasked && ` · ${row.phoneMasked}`}
              {row.idLastFour && ` · ${row.idType} ••${row.idLastFour}`}
            </p>
            <p className="mt-1 text-xs text-gray-500">{row.windowPhrase}</p>
          </div>
        </div>

        <span
          className={`rounded px-2 py-0.5 text-xs font-medium ${
            usable ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-600'
          }`}
        >
          {usable ? 'May collect' : row.validity.state}
        </span>
      </div>

      {!usable && (
        <p className="mt-2 text-sm text-gray-700">{row.validity.reason}</p>
      )}

      {usable && canRelease && (
        <button
          type="button"
          onClick={() => onRelease(row)}
          className="mt-3 rounded bg-green-600 px-3 py-1 text-sm font-medium text-white hover:bg-green-700"
        >
          Release to {row.guardianName.split(' ')[0]}
        </button>
      )}
    </li>
  );
};

const StudentPickup = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';
  const isStaff = ['teacher', 'staff', 'admin'].includes(role);

  const [tab, setTab] = useState(isStaff ? 'gate' : 'mine');
  const [meta, setMeta] = useState(null);

  const [studentId, setStudentId] = useState('');
  const [lookup, setLookup] = useState(null);

  const [openReleases, setOpenReleases] = useState([]);
  const [todaysReleases, setTodaysReleases] = useState([]);
  const [pending, setPending] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [mine, setMine] = useState([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [releaseFor, setReleaseFor] = useState(null);
  const [releaseForm, setReleaseForm] = useState({ ...emptyRelease });

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...emptyAuthorisation });

  const readError = (err, fallback) => err?.response?.data?.message || fallback;

  const clearMessages = () => {
    setError('');
    setNotice('');
  };

  const loadMeta = useCallback(async () => {
    try {
      const { data } = await api.get('/pickup/meta');
      setMeta(data.data);
    } catch {
      // The form falls back to its own labels.
    }
  }, []);

  const loadOpen = useCallback(async () => {
    if (!isStaff) return;
    try {
      const { data } = await api.get('/pickup/releases/open');
      setOpenReleases(data.data || []);
    } catch {
      // The strip simply does not appear.
    }
  }, [isStaff]);

  const loadToday = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/pickup/releases/today');
      setTodaysReleases(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, "Could not load today's releases"));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPending = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/pickup/authorisations/pending');
      setPending(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the approval queue'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOverrides = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/pickup/releases/overrides');
      setOverrides(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the override report'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMine = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/pickup/authorisations/mine');
      setMine(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load your authorisations'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    loadOpen();
  }, [loadOpen]);

  useEffect(() => {
    if (tab === 'today') loadToday();
    if (tab === 'pending') loadPending();
    if (tab === 'overrides') loadOverrides();
    if (tab === 'mine') loadMine();
  }, [tab, loadToday, loadPending, loadOverrides, loadMine]);

  const lookupStudent = async (event) => {
    event.preventDefault();
    clearMessages();
    setLookup(null);
    try {
      const { data } = await api.get(`/pickup/students/${studentId.trim()}/collectors`);
      setLookup(data.data);
    } catch (err) {
      setError(readError(err, 'Could not look that student up'));
    }
  };

  const beginRelease = (row) => {
    setReleaseFor(row);
    setReleaseForm({
      ...emptyRelease,
      collectedByName: row.guardianName,
      verifiedBy: row.hasCode ? 'code' : 'known-to-staff',
    });
  };

  const beginOverride = () => {
    setReleaseFor({ override: true });
    setReleaseForm({ ...emptyRelease, verifiedBy: 'override' });
  };

  const submitRelease = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      const { data } = await api.post('/pickup/releases', {
        student: lookup ? studentId.trim() : undefined,
        authorisation: releaseFor?.override ? undefined : releaseFor?._id,
        relationship: releaseFor?.relationship,
        ...releaseForm,
        overrideApprovedBy: releaseForm.overrideApprovedBy || undefined,
      });
      setNotice(data.message);
      setReleaseFor(null);
      setReleaseForm({ ...emptyRelease });
      loadOpen();
      if (lookup) {
        const refreshed = await api.get(
          `/pickup/students/${studentId.trim()}/collectors`
        );
        setLookup(refreshed.data.data);
      }
    } catch (err) {
      setError(readError(err, 'Could not record the release'));
    }
  };

  const recordReturn = async (releaseId) => {
    clearMessages();
    try {
      await api.patch(`/pickup/releases/${releaseId}/return`);
      setNotice('Return recorded.');
      loadOpen();
      if (tab === 'today') loadToday();
    } catch (err) {
      setError(readError(err, 'Could not record the return'));
    }
  };

  const approveAuthorisation = async (id) => {
    clearMessages();
    try {
      const { data } = await api.patch(`/pickup/authorisations/${id}/approve`);
      setNotice(data.message);
      loadPending();
    } catch (err) {
      setError(readError(err, 'Could not approve that authorisation'));
    }
  };

  const revokeAuthorisation = async (id) => {
    const reason = window.prompt('Why is this being revoked? It cannot be undone.');
    if (!reason) return;
    clearMessages();
    try {
      const { data } = await api.patch(`/pickup/authorisations/${id}/revoke`, { reason });
      setNotice(data.message);
      loadPending();
      loadMine();
    } catch (err) {
      setError(readError(err, 'Could not revoke that authorisation'));
    }
  };

  const submitAuthorisation = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      const { data } = await api.post('/pickup/authorisations', {
        ...form,
        validUntil: form.validUntil || undefined,
        notBefore: form.notBefore || undefined,
        notAfter: form.notAfter || undefined,
        idLastFour: form.idLastFour || undefined,
        altPhone: form.altPhone || undefined,
      });
      setNotice(data.message);
      setShowForm(false);
      setForm({ ...emptyAuthorisation });
      loadMine();
    } catch (err) {
      setError(readError(err, 'Could not record that authorisation'));
    }
  };

  const toggleDay = (value) => {
    setForm((current) => ({
      ...current,
      daysOfWeek: current.daysOfWeek.includes(value)
        ? current.daysOfWeek.filter((d) => d !== value)
        : [...current.daysOfWeek, value],
    }));
  };

  const overdueCount = useMemo(
    () => openReleases.filter((release) => release.isOverdue).length,
    [openReleases]
  );

  const releaseTypes = meta?.releaseTypes || Object.keys(RELEASE_TYPE_LABELS);
  const verificationMethods = meta?.verificationMethods || Object.keys(VERIFICATION_LABELS);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Pickup &amp; release</h1>
        <p className="mt-1 text-gray-600">
          Who may collect a child, until when, and the record that they did. Every
          permission states its own expiry, and the gate checks it at the moment somebody
          is standing there.
        </p>
      </header>

      {/* Open collections stay visible on every tab. A child who is still out is
          not something you should have to navigate to. */}
      {isStaff && openReleases.length > 0 && (
        <div
          className={`mb-5 rounded border px-4 py-3 ${
            overdueCount > 0
              ? 'border-red-300 bg-red-50 text-red-800'
              : 'border-amber-200 bg-amber-50 text-amber-900'
          }`}
        >
          <p className="text-sm font-semibold">
            {openReleases.length} child(ren) currently out
            {overdueCount > 0 && ` — ${overdueCount} past the expected return`}
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {openReleases.slice(0, 5).map((release) => (
              <li key={release._id} className="flex items-center gap-2">
                <span className={release.isOverdue ? 'font-semibold' : ''}>
                  {release.student?.name || release.studentName || 'Unnamed'} — with{' '}
                  {release.collectedByName}, out since {timeOfDay(release.releasedAt)}
                  {release.expectedReturn && `, due back ${release.expectedReturn}`}
                </span>
                <button
                  type="button"
                  onClick={() => recordReturn(release._id)}
                  className="rounded border border-current px-2 py-0.5 text-xs"
                >
                  back now
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <nav className="flex flex-wrap gap-2 border-b mb-6">
        {[
          ...(isStaff
            ? [
                { key: 'gate', label: 'Gate' },
                { key: 'today', label: 'Today' },
                { key: 'pending', label: 'Approvals' },
              ]
            : []),
          { key: 'mine', label: 'My children' },
          ...(isAdmin ? [{ key: 'overrides', label: 'Overrides' }] : []),
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

      {tab === 'gate' && isStaff && (
        <section>
          <form onSubmit={lookupStudent} className="mb-5 flex flex-wrap gap-2">
            <input
              className="flex-1 min-w-[240px] rounded border px-3 py-2 text-sm"
              placeholder="Student id"
              value={studentId}
              onChange={(e) => setStudentId(e.target.value)}
              required
            />
            <button
              type="submit"
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Look up
            </button>
          </form>

          {lookup && (
            <>
              {lookup.hasRestrictions && (
                <div className="mb-4 rounded border-2 border-red-400 bg-red-50 px-4 py-3">
                  <p className="font-bold text-red-800">
                    This child has {lookup.restricted.length} restriction(s). Read them
                    before releasing to anybody.
                  </p>
                </div>
              )}

              <p className="mb-3 text-sm text-gray-500">
                Checked for {lookup.date} at {lookup.time}
              </p>

              <ul className="space-y-3">
                {[...lookup.restricted, ...lookup.valid, ...lookup.unusable].map((row) => (
                  <CollectorCard
                    key={row._id}
                    row={row}
                    canRelease={isStaff}
                    onRelease={beginRelease}
                  />
                ))}
              </ul>

              {lookup.valid.length === 0 && (
                <div className="mt-4 rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  <p>
                    Nobody currently on file may collect this child. If somebody is at the
                    gate, record an override — it needs a reason and a named approver, and
                    it appears in Monday's report.
                  </p>
                  <button
                    type="button"
                    onClick={beginOverride}
                    className="mt-2 rounded border border-amber-400 px-3 py-1 text-sm font-medium text-amber-900 hover:bg-amber-100"
                  >
                    Record an override
                  </button>
                </div>
              )}
            </>
          )}

          {releaseFor && (
            <form
              onSubmit={submitRelease}
              className="mt-5 rounded-lg border bg-white p-5 shadow-sm"
            >
              <h3 className="mb-3 font-semibold text-gray-800">
                {releaseFor.override
                  ? 'Override release'
                  : `Release to ${releaseFor.guardianName}`}
              </h3>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="text-gray-600">Kind of release</span>
                  <select
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={releaseForm.type}
                    onChange={(e) =>
                      setReleaseForm({ ...releaseForm, type: e.target.value })
                    }
                  >
                    {releaseTypes.map((type) => (
                      <option key={type} value={type}>
                        {RELEASE_TYPE_LABELS[type] || type}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-sm">
                  <span className="text-gray-600">How were they verified?</span>
                  <select
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={releaseForm.verifiedBy}
                    onChange={(e) =>
                      setReleaseForm({ ...releaseForm, verifiedBy: e.target.value })
                    }
                    disabled={releaseFor.override}
                  >
                    {verificationMethods.map((method) => (
                      <option key={method} value={method}>
                        {VERIFICATION_LABELS[method] || method}
                      </option>
                    ))}
                  </select>
                </label>

                {releaseForm.verifiedBy === 'code' && (
                  <label className="text-sm">
                    <span className="text-gray-600">Code they quoted</span>
                    <input
                      className="mt-1 w-full rounded border px-3 py-2 font-mono uppercase"
                      value={releaseForm.verificationCode}
                      onChange={(e) =>
                        setReleaseForm({
                          ...releaseForm,
                          verificationCode: e.target.value,
                        })
                      }
                      required
                    />
                  </label>
                )}

                {['early-collection', 'medical', 'activity'].includes(
                  releaseForm.type
                ) && (
                  <label className="text-sm">
                    <span className="text-gray-600">Expected back</span>
                    <input
                      type="time"
                      className="mt-1 w-full rounded border px-3 py-2"
                      value={releaseForm.expectedReturn}
                      onChange={(e) =>
                        setReleaseForm({
                          ...releaseForm,
                          expectedReturn: e.target.value,
                        })
                      }
                    />
                  </label>
                )}
              </div>

              {releaseForm.verifiedBy === 'override' && (
                <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-4">
                  <p className="text-sm text-amber-900">
                    This release is not covered by an authorisation. It needs a reason and
                    a named approver, and it will appear in the override report.
                  </p>
                  <input
                    className="mt-2 w-full rounded border px-3 py-2 text-sm"
                    placeholder="Who is collecting?"
                    value={releaseForm.collectedByName}
                    onChange={(e) =>
                      setReleaseForm({
                        ...releaseForm,
                        collectedByName: e.target.value,
                      })
                    }
                    required
                  />
                  <textarea
                    rows={2}
                    className="mt-2 w-full rounded border px-3 py-2 text-sm"
                    placeholder="Why was the child released without a valid authorisation?"
                    value={releaseForm.overrideReason}
                    onChange={(e) =>
                      setReleaseForm({ ...releaseForm, overrideReason: e.target.value })
                    }
                    required
                  />
                  <input
                    className="mt-2 w-full rounded border px-3 py-2 text-sm"
                    placeholder="User id of the member of staff who approved it"
                    value={releaseForm.overrideApprovedBy}
                    onChange={(e) =>
                      setReleaseForm({
                        ...releaseForm,
                        overrideApprovedBy: e.target.value,
                      })
                    }
                    required
                  />
                </div>
              )}

              <div className="mt-4 flex gap-2">
                <button
                  type="submit"
                  className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
                >
                  Record release
                </button>
                <button
                  type="button"
                  onClick={() => setReleaseFor(null)}
                  className="rounded border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      {tab === 'today' && isStaff && (
        <section>
          <h2 className="mb-3 text-lg font-semibold text-gray-800">
            Released today ({todaysReleases.length})
          </h2>
          {todaysReleases.length === 0 ? (
            <p className="text-sm text-gray-500">Nobody has left yet.</p>
          ) : (
            <ul className="space-y-2">
              {todaysReleases.map((release) => (
                <li
                  key={release._id}
                  className={`rounded border bg-white px-4 py-3 text-sm ${
                    release.isOverride ? 'border-amber-300' : ''
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-gray-900">
                      {release.student?.name || release.studentName || 'Unnamed'}
                    </span>
                    <span className="text-xs text-gray-500">
                      {timeOfDay(release.releasedAt)} ·{' '}
                      {RELEASE_TYPE_LABELS[release.type] || release.type}
                    </span>
                  </div>
                  <p className="mt-1 text-gray-700">
                    with {release.collectedByName} ·{' '}
                    {VERIFICATION_LABELS[release.verifiedBy] || release.verifiedBy}
                  </p>
                  {release.isOverride && (
                    <p className="mt-1 text-xs text-amber-800">
                      Override: {release.overrideReason}
                    </p>
                  )}
                  {release.status === 'open' && (
                    <button
                      type="button"
                      onClick={() => recordReturn(release._id)}
                      className="mt-2 rounded border px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50"
                    >
                      Record return
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === 'pending' && isStaff && (
        <section>
          <h2 className="mb-3 text-lg font-semibold text-gray-800">
            Waiting for approval
          </h2>
          {pending.length === 0 ? (
            <p className="text-sm text-gray-500">Nothing is waiting.</p>
          ) : (
            <ul className="space-y-3">
              {pending.map((row) => (
                <li key={row._id} className="rounded-lg border bg-white p-4 shadow-sm">
                  <p className="font-medium text-gray-900">
                    {row.guardianName} —{' '}
                    {RELATIONSHIP_LABELS[row.relationship] || row.relationship} of{' '}
                    {row.student?.name || row.studentName}
                  </p>
                  <p className="text-sm text-gray-600">
                    {SCOPE_LABELS[row.scope] || row.scope} · {row.windowPhrase}
                  </p>
                  <p className="text-xs text-gray-500">
                    {row.phoneMasked}
                    {row.idLastFour && ` · ${row.idType} ••${row.idLastFour}`} · requested
                    by {row.requestedBy?.name || 'unknown'}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => approveAuthorisation(row._id)}
                      className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => revokeAuthorisation(row._id)}
                      className="rounded border border-red-300 px-3 py-1 text-xs text-red-700 hover:bg-red-50"
                    >
                      Refuse
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === 'overrides' && isAdmin && (
        <section>
          <h2 className="mb-1 text-lg font-semibold text-gray-800">Override report</h2>
          <p className="mb-3 text-sm text-gray-600">
            Every child released without a valid authorisation, with the reason and the
            person who approved it. This is the gap between the rule and the car park.
          </p>
          {overrides.length === 0 ? (
            <p className="text-sm text-gray-500">No overrides recorded.</p>
          ) : (
            <ul className="space-y-2">
              {overrides.map((release) => (
                <li
                  key={release._id}
                  className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm"
                >
                  <p className="font-medium text-amber-900">
                    {release.date} — {release.student?.name || release.studentName} to{' '}
                    {release.collectedByName}
                  </p>
                  <p className="mt-1 text-amber-800">{release.overrideReason}</p>
                  <p className="mt-1 text-xs text-amber-700">
                    Released by {release.releasedBy?.name || 'unknown'} · approved by{' '}
                    {release.overrideApprovedBy?.name || 'unknown'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === 'mine' && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-800">
              People who may collect
            </h2>
            <button
              type="button"
              onClick={() => setShowForm((open) => !open)}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              {showForm ? 'Close' : 'Add somebody'}
            </button>
          </div>

          {showForm && (
            <form
              onSubmit={submitAuthorisation}
              className="mb-6 rounded-lg border bg-white p-5 shadow-sm"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="text-gray-600">Child (user id)</span>
                  <input
                    required
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={form.student}
                    onChange={(e) => setForm({ ...form, student: e.target.value })}
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Their name</span>
                  <input
                    required
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={form.guardianName}
                    onChange={(e) => setForm({ ...form, guardianName: e.target.value })}
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Relationship</span>
                  <select
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={form.relationship}
                    onChange={(e) => setForm({ ...form, relationship: e.target.value })}
                  >
                    {Object.entries(RELATIONSHIP_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Phone</span>
                  <input
                    required
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">How long for?</span>
                  <select
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={form.scope}
                    onChange={(e) => setForm({ ...form, scope: e.target.value })}
                  >
                    {Object.entries(SCOPE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">From</span>
                  <input
                    type="date"
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={form.validFrom}
                    onChange={(e) => setForm({ ...form, validFrom: e.target.value })}
                  />
                </label>
                {form.scope === 'date-range' && (
                  <label className="text-sm">
                    <span className="text-gray-600">Until</span>
                    <input
                      type="date"
                      className="mt-1 w-full rounded border px-3 py-2"
                      value={form.validUntil}
                      onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
                    />
                  </label>
                )}
                <label className="text-sm">
                  <span className="text-gray-600">ID last four digits</span>
                  <input
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={form.idLastFour}
                    onChange={(e) => setForm({ ...form, idLastFour: e.target.value })}
                    maxLength={4}
                  />
                </label>
              </div>

              {form.scope !== 'single-day' && (
                <div className="mt-3">
                  <span className="text-sm text-gray-600">
                    Only on these days (leave empty for any)
                  </span>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {WEEKDAYS.map((day) => (
                      <button
                        key={day.value}
                        type="button"
                        onClick={() => toggleDay(day.value)}
                        className={`rounded border px-3 py-1 text-xs ${
                          form.daysOfWeek.includes(day.value)
                            ? 'border-blue-500 bg-blue-50 text-blue-700'
                            : 'text-gray-600'
                        }`}
                      >
                        {day.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-4 flex gap-2">
                <button
                  type="submit"
                  className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Request
                </button>
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="rounded border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {mine.length === 0 ? (
            <p className="text-sm text-gray-500">Nobody is on file yet.</p>
          ) : (
            <ul className="space-y-3">
              {mine.map((row) => (
                <li key={row._id} className="rounded-lg border bg-white p-4 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-gray-900">
                        {row.guardianName} —{' '}
                        {RELATIONSHIP_LABELS[row.relationship] || row.relationship}
                      </p>
                      <p className="text-sm text-gray-600">
                        for {row.student?.name || row.studentName || 'your child'}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">{row.windowPhrase}</p>
                    </div>
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${
                        STATUS_STYLES[row.status] || 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {row.status}
                    </span>
                  </div>

                  {row.verificationCode && (
                    <p className="mt-2 text-sm text-gray-700">
                      Verification code:{' '}
                      <span className="font-mono font-bold tracking-widest">
                        {row.verificationCode}
                      </span>{' '}
                      — the gate will ask for this.
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
};

export default StudentPickup;
