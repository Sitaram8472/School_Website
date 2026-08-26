import { useState, useEffect, useCallback, useContext, useMemo } from 'react';
import {
  BadgeCheck,
  AlertTriangle,
  CheckCircle2,
  CalendarClock,
  Search,
  ShieldQuestion,
} from 'lucide-react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * The credential register, sitting under the faculty cards.
 *
 * The cards above are a name, a photograph and a subject string. This is the
 * part that says whether the person is actually qualified to teach it, and
 * whether the certificates the school is required to keep current still are.
 *
 * Two things the UI has to get right, because they are the whole feature:
 *
 * **An unverified certificate must never look like a verified one.** The
 * difference between "this teacher says they hold a safeguarding check" and
 * "we have seen it" is the reason to keep a register at all, so it is a
 * distinct colour and a distinct word, not a subtitle.
 *
 * **Expiry is a date, not a status.** Every compliance chip is computed by the
 * server from today's date on the request that drew it. Nothing here is read
 * from a stored flag, so nothing here can be quietly out of date.
 */

const KIND_LABELS = {
  degree: 'Degree',
  'teaching-licence': 'Teaching licence',
  'subject-endorsement': 'Subject endorsement',
  'first-aid': 'First aid',
  'child-protection': 'Child protection',
  'lab-safety': 'Laboratory safety',
  other: 'Other',
};

const COMPLIANCE_LABELS = {
  valid: 'Valid',
  expiring: 'Expiring',
  expired: 'Expired',
  unverified: 'Not yet verified',
  'not-in-force': 'Not in force',
};

const COMPLIANCE_STYLES = {
  valid: 'bg-green-100 text-green-800',
  expiring: 'bg-amber-100 text-amber-900',
  expired: 'bg-red-100 text-red-800',
  unverified: 'bg-gray-200 text-gray-700',
  'not-in-force': 'bg-gray-100 text-gray-500',
};

const EMPTY_FORM = {
  kind: 'first-aid',
  title: '',
  issuer: '',
  reference: '',
  issuedOn: '',
  expiresOn: '',
  subjects: '',
};

const shortDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—';

const ComplianceChip = ({ compliance }) => (
  <span
    className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
      COMPLIANCE_STYLES[compliance.state] || 'bg-gray-200 text-gray-700'
    }`}
    title={compliance.reason}
  >
    {COMPLIANCE_LABELS[compliance.state] || compliance.state}
  </span>
);

const CredentialPanel = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';
  const isStaff = role === 'admin' || role === 'teacher';

  const [meta, setMeta] = useState(null);
  const [mine, setMine] = useState(null);
  const [expiring, setExpiring] = useState(null);
  const [register, setRegister] = useState([]);
  const [complianceFilter, setComplianceFilter] = useState('');

  const [subjectQuery, setSubjectQuery] = useState('');
  const [endorsed, setEndorsed] = useState(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [file, setFile] = useState(null);

  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState('');
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
      const res = await api.get('/teacher/credentials/meta');
      setMeta(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load the credential options.');
    }
  }, []);

  const loadMine = useCallback(async () => {
    try {
      const res = await api.get('/teacher/credentials/mine');
      setMine(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load your credentials.');
    }
  }, []);

  const loadExpiring = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await api.get('/teacher/credentials/expiring?days=90');
      setExpiring(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load the expiry report.');
    }
  }, [isAdmin]);

  const loadRegister = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const query = complianceFilter ? `?compliance=${complianceFilter}` : '';
      const res = await api.get(`/teacher/credentials${query}`);
      setRegister(res.data.data || []);
    } catch (err) {
      explain(err, 'Could not load the register.');
    }
  }, [isAdmin, complianceFilter]);

  useEffect(() => {
    if (!isStaff) return;
    setLoading(true);
    Promise.all([loadMeta(), loadMine(), loadExpiring()]).finally(() => setLoading(false));
  }, [isStaff, loadMeta, loadMine, loadExpiring]);

  useEffect(() => {
    loadRegister();
  }, [loadRegister]);

  const refreshAll = async () => {
    await Promise.all([loadMine(), loadExpiring(), loadRegister()]);
  };

  const submitCredential = async (event) => {
    event.preventDefault();
    setBusyId('new');
    setError('');

    try {
      // multipart, because the scanned certificate goes through the multer
      // pipeline already configured on the teacher route file.
      const payload = new FormData();
      Object.entries(form).forEach(([key, value]) => payload.append(key, value));
      if (file) payload.append('document', file);

      await api.post('/teacher/credentials', payload, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      flash('Certificate submitted. It counts as cover once an administrator has verified it.');
      setForm(EMPTY_FORM);
      setFile(null);
      setShowForm(false);
      await refreshAll();
    } catch (err) {
      explain(err, 'Could not submit that certificate.');
    } finally {
      setBusyId('');
    }
  };

  const renew = async (credential) => {
    const reference = window.prompt(
      `Renewing "${credential.title}". The existing certificate keeps its dates and is marked ` +
        'superseded, so the record of what you held before stays intact.\n\n' +
        'New certificate reference:',
      credential.reference
    );
    if (!reference) return;

    const issuedOn = window.prompt('New issue date (YYYY-MM-DD):');
    if (!issuedOn) return;

    const expiresOn = window.prompt('New expiry date (YYYY-MM-DD), or leave blank if it does not expire:');

    setBusyId(credential._id);
    setError('');
    try {
      await api.post(`/teacher/credentials/${credential._id}/renew`, {
        reference,
        issuedOn,
        expiresOn: expiresOn || '',
      });
      flash('Renewal submitted.');
      await refreshAll();
    } catch (err) {
      explain(err, 'Could not renew that certificate.');
    } finally {
      setBusyId('');
    }
  };

  const verify = async (credential) => {
    setBusyId(credential._id);
    setError('');
    try {
      await api.patch(`/teacher/credentials/${credential._id}/verify`, {});
      flash('Certificate verified.');
      await refreshAll();
    } catch (err) {
      explain(err, 'Could not verify that certificate.');
    } finally {
      setBusyId('');
    }
  };

  const reject = async (credential) => {
    const reason = window.prompt(`Why is "${credential.title}" being rejected?`);
    if (!reason) return;

    setBusyId(credential._id);
    setError('');
    try {
      await api.patch(`/teacher/credentials/${credential._id}/reject`, { reason });
      flash('Certificate rejected.');
      await refreshAll();
    } catch (err) {
      explain(err, 'Could not reject that certificate.');
    } finally {
      setBusyId('');
    }
  };

  const findEndorsed = async (event) => {
    event.preventDefault();
    if (!subjectQuery.trim()) return;

    setBusyId('endorsed');
    setError('');
    try {
      const res = await api.get('/teacher/credentials/endorsed', {
        params: { subject: subjectQuery.trim(), require: 'child-protection' },
      });
      setEndorsed(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not run that search.');
    } finally {
      setBusyId('');
    }
  };

  const gapLabels = useMemo(
    () => (mine?.gaps || []).map((kind) => KIND_LABELS[kind] || kind),
    [mine]
  );

  // The public faculty grid above is for visitors; the register is not.
  if (!isStaff) return null;

  const renderCredential = (credential, { actions = false } = {}) => (
    <li key={credential._id} className="border border-gray-200 rounded-lg p-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="font-medium text-gray-900 text-sm">{credential.title}</p>
          <p className="text-xs text-gray-600 mt-0.5">
            {KIND_LABELS[credential.kind] || credential.kind} · {credential.issuer} ·{' '}
            {credential.reference}
          </p>
          {isAdmin && credential.teacherName && (
            <p className="text-xs text-gray-500 mt-0.5">{credential.teacherName}</p>
          )}
          <p className="text-xs text-gray-500 mt-0.5">
            Issued {shortDate(credential.issuedOn)}
            {credential.expiresOn
              ? ` · expires ${shortDate(credential.expiresOn)}`
              : ' · does not expire'}
          </p>
          {credential.subjects?.length > 0 && (
            <p className="text-xs text-gray-500 mt-0.5">
              Endorsed for: {credential.subjects.join(', ')}
            </p>
          )}
          {credential.rejectionReason && (
            <p className="text-xs text-red-700 mt-1">Rejected: {credential.rejectionReason}</p>
          )}
          {credential.supersededBy && (
            <p className="text-xs text-gray-500 mt-1 italic">
              Superseded {shortDate(credential.supersededAt)} — kept on the record so cover on a
              past date can still be established.
            </p>
          )}
        </div>

        <div className="text-right shrink-0">
          <ComplianceChip compliance={credential.compliance} />
          <p className="text-[11px] text-gray-500 mt-1 max-w-[12rem]">
            {credential.compliance.reason}
          </p>
        </div>
      </div>

      {actions && (
        <div className="mt-2 flex flex-wrap gap-2">
          {isAdmin && credential.status === 'submitted' && (
            <>
              <button
                type="button"
                onClick={() => verify(credential)}
                disabled={busyId === credential._id}
                className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Verify
              </button>
              <button
                type="button"
                onClick={() => reject(credential)}
                disabled={busyId === credential._id}
                className="text-xs px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                Reject
              </button>
            </>
          )}

          {credential.isCurrent && credential.expiresOn && (
            <button
              type="button"
              onClick={() => renew(credential)}
              disabled={busyId === credential._id}
              className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Renew
            </button>
          )}
        </div>
      )}
    </li>
  );

  return (
    <section className="max-w-6xl mx-auto mt-10 bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
      <header className="flex items-start justify-between gap-4 flex-wrap mb-5">
        <div>
          <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
            <BadgeCheck size={20} className="text-blue-600" />
            Credential register
          </h2>
          <p className="text-sm text-gray-600 mt-1 max-w-2xl">
            What each member of staff is qualified to do, and until when. Every status below is
            worked out from today’s date when the page loads — nothing here is a flag somebody
            remembered to update.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowForm((open) => !open)}
          className="px-3 py-2 rounded-md border border-gray-300 text-sm font-medium hover:bg-gray-50 transition"
        >
          {showForm ? 'Close' : 'Add a certificate'}
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

      {/* --- submit ------------------------------------------------------ */}
      {showForm && (
        <form
          onSubmit={submitCredential}
          className="mb-6 rounded-xl border border-gray-200 bg-gray-50 p-4 grid gap-3 md:grid-cols-2"
        >
          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Kind</span>
            <select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            >
              {(meta?.kinds || []).map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABELS[kind] || kind}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Title</span>
            <input
              required
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Paediatric First Aid, Level 3"
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Issued by</span>
            <input
              required
              value={form.issuer}
              onChange={(e) => setForm({ ...form, issuer: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Certificate reference</span>
            <input
              required
              value={form.reference}
              onChange={(e) => setForm({ ...form, reference: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Issued on</span>
            <input
              required
              type="date"
              value={form.issuedOn}
              onChange={(e) => setForm({ ...form, issuedOn: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-700 mb-1">
              Expires on <span className="text-gray-500">(blank if it never does)</span>
            </span>
            <input
              type="date"
              value={form.expiresOn}
              onChange={(e) => setForm({ ...form, expiresOn: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>

          {form.kind === 'subject-endorsement' && (
            <label className="text-sm md:col-span-2">
              <span className="block text-gray-700 mb-1">
                Subjects <span className="text-gray-500">(comma separated)</span>
              </span>
              <input
                value={form.subjects}
                onChange={(e) => setForm({ ...form, subjects: e.target.value })}
                placeholder="Physics, Mathematics"
                className="w-full rounded border border-gray-300 px-3 py-2"
              />
            </label>
          )}

          <label className="text-sm md:col-span-2">
            <span className="block text-gray-700 mb-1">Scanned certificate</span>
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="w-full text-sm"
            />
          </label>

          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={busyId === 'new'}
              className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition disabled:opacity-60"
            >
              Submit certificate
            </button>
            <p className="text-xs text-gray-500 mt-2">
              A submitted certificate is a claim. It does not count as cover until an administrator
              other than you has checked it against the document.
            </p>
          </div>
        </form>
      )}

      {/* --- admin: what lapses next ------------------------------------- */}
      {isAdmin && expiring && (
        <div className="mb-8">
          <h3 className="text-sm font-semibold text-gray-800 mb-2 flex items-center gap-2">
            <CalendarClock size={16} className="text-amber-600" />
            Lapsing within {expiring.horizonDays} days
          </h3>

          {expiring.expired.length === 0 && expiring.expiring.length === 0 ? (
            <p className="text-sm text-gray-500">
              Nothing has lapsed and nothing is inside its warning window.
            </p>
          ) : (
            <ul className="space-y-2">
              {[...expiring.expired, ...expiring.expiring].map((credential) =>
                renderCredential(credential, { actions: true })
              )}
            </ul>
          )}
        </div>
      )}

      {/* --- my record --------------------------------------------------- */}
      <div className="mb-8">
        <h3 className="text-sm font-semibold text-gray-800 mb-2">Your record</h3>

        {gapLabels.length > 0 && (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-3">
            No verified, in-force certificate on file for: {gapLabels.join(', ')}.
          </p>
        )}

        {!mine || mine.credentials.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing on file yet.</p>
        ) : (
          <ul className="space-y-2">
            {mine.credentials.map((credential) => renderCredential(credential, { actions: true }))}
          </ul>
        )}
      </div>

      {/* --- who can teach what ------------------------------------------ */}
      <div className="mb-8">
        <h3 className="text-sm font-semibold text-gray-800 mb-2 flex items-center gap-2">
          <Search size={16} className="text-blue-600" />
          Who is endorsed for a subject?
        </h3>

        <form onSubmit={findEndorsed} className="flex gap-2 flex-wrap mb-3">
          <input
            value={subjectQuery}
            onChange={(e) => setSubjectQuery(e.target.value)}
            placeholder="Physics"
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={busyId === 'endorsed'}
            className="px-3 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60"
          >
            Search
          </button>
        </form>

        {endorsed && (
          <div className="text-sm">
            <p className="text-gray-700 mb-2">
              {endorsed.eligible.length} endorsed for {endorsed.subject} with current child
              protection
              {endorsed.blocked.length > 0 && `, ${endorsed.blocked.length} endorsed but not covered`}
              .
            </p>

            <ul className="space-y-1">
              {endorsed.eligible.map((row) => (
                <li key={`${row.teacher}-ok`} className="text-gray-800 text-xs">
                  ✓ {row.teacherName}
                </li>
              ))}
              {endorsed.blocked.map((row) => (
                <li key={`${row.teacher}-no`} className="text-amber-800 text-xs">
                  ⚠ {row.teacherName} — missing{' '}
                  {row.missing.map((kind) => KIND_LABELS[kind] || kind).join(', ')}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* --- admin: the whole register ----------------------------------- */}
      {isAdmin && (
        <div>
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
              <ShieldQuestion size={16} className="text-blue-600" />
              Full register
            </h3>

            <select
              value={complianceFilter}
              onChange={(e) => setComplianceFilter(e.target.value)}
              className="rounded border border-gray-300 px-2 py-1 text-sm"
            >
              <option value="">Any state</option>
              {Object.entries(COMPLIANCE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {register.length === 0 ? (
            <p className="text-sm text-gray-500">Nothing matches that filter.</p>
          ) : (
            <ul className="space-y-2">
              {register.map((credential) => renderCredential(credential, { actions: true }))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
};

export default CredentialPanel;
