import { useState, useEffect, useCallback, useContext } from 'react';
import {
  Package,
  Truck,
  Search,
  MapPin,
  ClipboardCheck,
  ShieldAlert,
  CheckCircle2,
  RefreshCw,
} from 'lucide-react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * Requests for a printed prospectus.
 *
 * Three things share one panel because they are three views of one record:
 * the public request form, the "where is mine" box that takes a reference and
 * an email, and — for the admissions office — the fulfilment queue.
 *
 * The queue is deliberately here rather than on a separate admin screen. The
 * person packing a book is looking at the same address the family typed, and
 * splitting the two is how a queue ends up being worked from a spreadsheet.
 */

const STATUS_STYLES = {
  received: 'bg-amber-100 text-amber-800',
  packed: 'bg-blue-100 text-blue-700',
  dispatched: 'bg-indigo-100 text-indigo-700',
  delivered: 'bg-green-100 text-green-700',
  returned: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-200 text-gray-600',
};

const STATUS_LABELS = {
  received: 'Received',
  packed: 'Packed',
  dispatched: 'Dispatched',
  delivered: 'Delivered',
  returned: 'Returned to us',
  cancelled: 'Cancelled',
};

const CHANNEL_LABELS = {
  post: 'By post',
  courier: 'By courier',
  collect: 'Collect from reception',
  'email-only': 'Email me the PDF only',
};

const RELATIONSHIP_LABELS = {
  parent: 'Parent',
  guardian: 'Guardian',
  student: 'Student',
  agent: 'Education agent',
  other: 'Other',
};

const POSTAL_CHANNELS = ['post', 'courier'];

const EMPTY_FORM = {
  applicantName: '',
  email: '',
  phone: '',
  relationship: 'parent',
  studentName: '',
  gradeSought: '',
  academicYear: '',
  intakeTerm: '',
  channel: 'post',
  quantity: 1,
  address: { line1: '', line2: '', city: '', state: '', postcode: '', country: 'India' },
};

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—';

/**
 * A key that survives a retry.
 *
 * The whole point is that pressing the button twice sends the *same* one, so
 * it is minted when the form is first rendered and only replaced once a
 * request has actually been created. A duplicate here is a second book and its
 * postage, not just a second row.
 */
const mintRequestKey = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `pr-${crypto.randomUUID()}`;
  }
  return `pr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const ProspectusRequestPanel = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isOffice = role === 'staff' || role === 'admin';

  const [meta, setMeta] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [requestKey, setRequestKey] = useState(mintRequestKey);
  const [receipt, setReceipt] = useState(null);

  const [trackReference, setTrackReference] = useState('');
  const [trackEmail, setTrackEmail] = useState('');
  const [tracked, setTracked] = useState(null);

  const [queue, setQueue] = useState([]);
  const [summary, setSummary] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [trackError, setTrackError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 3500);
  };

  const explain = (err, fallback) =>
    err?.response?.data?.message || err?.message || fallback;

  useEffect(() => {
    let cancelled = false;

    api
      .get('/contact/prospectus/meta')
      .then((res) => {
        if (!cancelled) setMeta(res.data.data);
      })
      .catch(() => {
        // The form still works without the vocabulary; the selects just fall
        // back to the labels defined above.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const loadQueue = useCallback(async () => {
    if (!isOffice) return;

    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      if (search.trim()) params.q = search.trim();

      const [queueRes, summaryRes] = await Promise.all([
        api.get('/contact/prospectus', { params }),
        api.get('/contact/prospectus/summary'),
      ]);

      setQueue(queueRes.data.data || []);
      setSummary(summaryRes.data.data);
    } catch (err) {
      setError(explain(err, 'Could not load the fulfilment queue.'));
    }
  }, [isOffice, statusFilter, search]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  const needsAddress = POSTAL_CHANNELS.includes(form.channel);

  const setAddress = (field, value) =>
    setForm((current) => ({ ...current, address: { ...current.address, [field]: value } }));

  const submitRequest = async (event) => {
    event.preventDefault();
    setError('');

    if (!form.applicantName.trim() || !form.email.trim()) {
      setError('Your name and email address are both needed.');
      return;
    }

    if (needsAddress && !form.address.line1.trim()) {
      setError('A postal request needs a street address.');
      return;
    }

    setSubmitting(true);

    try {
      const { data } = await api.post('/contact/prospectus', {
        ...form,
        requestKey,
        quantity: Number(form.quantity) || 1,
        // A collection or email-only request has no business carrying a home
        // address, and the server refuses one, so it is not sent.
        address: needsAddress ? form.address : undefined,
      });

      setReceipt(data.data);
      setForm(EMPTY_FORM);
      setRequestKey(mintRequestKey());

      flash(
        data.duplicate
          ? 'We already had this request — nothing was sent twice.'
          : 'Request received.'
      );

      loadQueue();
    } catch (err) {
      setError(explain(err, 'Could not send the request.'));
    } finally {
      setSubmitting(false);
    }
  };

  const track = async (event) => {
    event.preventDefault();
    setTrackError('');
    setTracked(null);

    if (!trackReference.trim() || !trackEmail.trim()) {
      setTrackError('Both the reference and the email address are needed.');
      return;
    }

    try {
      const { data } = await api.get('/contact/prospectus/track', {
        params: { reference: trackReference.trim(), email: trackEmail.trim() },
      });

      setTracked(data.data);
    } catch (err) {
      setTrackError(explain(err, 'No request matches that reference and email address.'));
    }
  };

  const act = async (id, path, body, message) => {
    setBusyId(id);
    setError('');

    try {
      await api.patch(`/contact/prospectus/${id}/${path}`, body || {});
      flash(message);
      await loadQueue();
    } catch (err) {
      setError(explain(err, 'Could not update the request.'));
    } finally {
      setBusyId('');
    }
  };

  const dispatchRow = (row) => {
    const courier =
      row.channel === 'courier'
        ? window.prompt('Which courier?', row.courier || '')
        : (row.courier || '');
    if (courier === null) return;

    const trackingRef =
      row.channel === 'courier'
        ? window.prompt('Tracking reference:', row.trackingRef || '')
        : (row.trackingRef || '');
    if (trackingRef === null) return;

    act(row._id, 'dispatch', { courier, trackingRef }, 'Marked as dispatched.');
  };

  const returnRow = (row) => {
    const reason = window.prompt('Why has it come back? This is recorded.');
    if (reason === null) return;

    if (!reason.trim()) {
      setError('A return needs a reason.');
      return;
    }

    act(row._id, 'return', { reason }, 'Marked as returned.');
  };

  const cancelRow = (row) => {
    const reason = window.prompt('Why is this request being cancelled? This is recorded.');
    if (reason === null) return;

    if (!reason.trim()) {
      setError('A cancellation needs a reason.');
      return;
    }

    act(row._id, 'cancel', { reason }, 'Request cancelled.');
  };

  const channels = meta?.channels || Object.keys(CHANNEL_LABELS);
  const relationships = meta?.relationships || Object.keys(RELATIONSHIP_LABELS);
  const maxQuantity = meta?.maxQuantity ?? 5;

  return (
    <section className="max-w-5xl mx-auto px-4 py-12">
      <div className="mb-8 text-center">
        <h2 className="text-3xl font-bold text-slate-800 flex items-center justify-center gap-2">
          <Package className="text-blue-600" size={28} />
          Prefer the printed book?
        </h2>
        <p className="text-slate-600 mt-2 max-w-2xl mx-auto">
          Tell us where to send it and we will post a copy. You will get a reference you
          can use to check on it at any time.
        </p>
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

      {receipt && (
        <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4">
          <p className="font-semibold text-blue-900">
            Your reference is {receipt.reference}
          </p>
          <p className="text-sm text-blue-800">
            Keep it somewhere safe — you will need it together with your email address to
            check on the request below.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <form
          onSubmit={submitRequest}
          className="lg:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-xl border border-slate-200 bg-white p-6"
        >
          <label className="text-sm text-slate-700">
            Your name
            <input
              type="text"
              value={form.applicantName}
              onChange={(e) => setForm({ ...form, applicantName: e.target.value })}
              className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
              required
            />
          </label>

          <label className="text-sm text-slate-700">
            Email
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
              required
            />
          </label>

          <label className="text-sm text-slate-700">
            Phone
            <input
              type="tel"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
            />
          </label>

          <label className="text-sm text-slate-700">
            You are the
            <select
              value={form.relationship}
              onChange={(e) => setForm({ ...form, relationship: e.target.value })}
              className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
            >
              {relationships.map((value) => (
                <option key={value} value={value}>
                  {RELATIONSHIP_LABELS[value] || value}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm text-slate-700">
            Grade you are asking about
            <input
              type="text"
              value={form.gradeSought}
              onChange={(e) => setForm({ ...form, gradeSought: e.target.value })}
              placeholder="Grade 6"
              className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
            />
          </label>

          <label className="text-sm text-slate-700">
            Academic year
            <input
              type="text"
              value={form.academicYear}
              onChange={(e) => setForm({ ...form, academicYear: e.target.value })}
              placeholder="2026-27"
              className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
            />
          </label>

          <label className="text-sm text-slate-700">
            How should it reach you?
            <select
              value={form.channel}
              onChange={(e) => setForm({ ...form, channel: e.target.value })}
              className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
            >
              {channels.map((value) => (
                <option key={value} value={value}>
                  {CHANNEL_LABELS[value] || value}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm text-slate-700">
            Copies
            <input
              type="number"
              min="1"
              max={maxQuantity}
              value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
            />
          </label>

          {needsAddress && (
            <>
              <p className="sm:col-span-2 text-sm font-medium text-slate-700 flex items-center gap-2 mt-2">
                <MapPin size={16} className="text-blue-600" />
                Where should we send it?
              </p>

              <label className="text-sm text-slate-700 sm:col-span-2">
                Address
                <input
                  type="text"
                  value={form.address.line1}
                  onChange={(e) => setAddress('line1', e.target.value)}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
                  required
                />
              </label>

              <label className="text-sm text-slate-700 sm:col-span-2">
                Address line 2
                <input
                  type="text"
                  value={form.address.line2}
                  onChange={(e) => setAddress('line2', e.target.value)}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
                />
              </label>

              <label className="text-sm text-slate-700">
                City
                <input
                  type="text"
                  value={form.address.city}
                  onChange={(e) => setAddress('city', e.target.value)}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
                  required
                />
              </label>

              <label className="text-sm text-slate-700">
                Postcode
                <input
                  type="text"
                  value={form.address.postcode}
                  onChange={(e) => setAddress('postcode', e.target.value)}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
                  required
                />
              </label>

              <label className="text-sm text-slate-700">
                State
                <input
                  type="text"
                  value={form.address.state}
                  onChange={(e) => setAddress('state', e.target.value)}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
                />
              </label>

              <label className="text-sm text-slate-700">
                Country
                <input
                  type="text"
                  value={form.address.country}
                  onChange={(e) => setAddress('country', e.target.value)}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
                />
              </label>
            </>
          )}

          {!needsAddress && (
            <p className="sm:col-span-2 text-sm text-slate-500">
              We will not ask for your address for this option, and we do not keep one.
            </p>
          )}

          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={submitting}
              className="w-full sm:w-auto px-6 py-3 rounded-xl bg-blue-600 text-white font-bold hover:bg-blue-700 disabled:opacity-60"
            >
              {submitting ? 'Sending…' : 'Request a printed copy'}
            </button>
          </div>
        </form>

        <form
          onSubmit={track}
          className="rounded-xl border border-slate-200 bg-white p-6 h-fit"
        >
          <h3 className="font-semibold text-slate-800 flex items-center gap-2 mb-3">
            <Search size={18} className="text-blue-600" />
            Track a request
          </h3>

          <label className="text-sm text-slate-700 block mb-3">
            Reference
            <input
              type="text"
              value={trackReference}
              onChange={(e) => setTrackReference(e.target.value)}
              placeholder="PR/2026-27/0001"
              className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
            />
          </label>

          <label className="text-sm text-slate-700 block mb-4">
            Email you used
            <input
              type="email"
              value={trackEmail}
              onChange={(e) => setTrackEmail(e.target.value)}
              className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
            />
          </label>

          <button
            type="submit"
            className="w-full px-4 py-2 rounded-md border border-blue-600 text-blue-700 font-medium hover:bg-blue-50"
          >
            Check status
          </button>

          {trackError && <p className="mt-3 text-sm text-red-700">{trackError}</p>}

          {tracked && (
            <div className="mt-4 border-t border-slate-200 pt-4 text-sm text-slate-700 space-y-1">
              <p className="flex items-center gap-2">
                <span
                  className={`px-2 py-1 rounded text-xs font-medium ${
                    STATUS_STYLES[tracked.status] || 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {STATUS_LABELS[tracked.status] || tracked.status}
                </span>
              </p>
              <p>Requested {formatDate(tracked.requestedAt)}</p>
              {tracked.dispatchedAt && <p>Dispatched {formatDate(tracked.dispatchedAt)}</p>}
              {tracked.trackingRef && (
                <p>
                  {tracked.courier || 'Courier'} reference{' '}
                  <span className="font-mono">{tracked.trackingRef}</span>
                </p>
              )}
              {tracked.deliveredAt && <p>Delivered {formatDate(tracked.deliveredAt)}</p>}
              {tracked.returnedAt && <p>Returned to us {formatDate(tracked.returnedAt)}</p>}
            </div>
          )}
        </form>
      </div>

      {isOffice && (
        <div className="mt-12 border-t border-slate-200 pt-8">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <h3 className="text-xl font-semibold text-slate-800 flex items-center gap-2">
              <ClipboardCheck size={20} className="text-blue-600" />
              Fulfilment queue
              {summary ? (
                <span className="text-sm font-normal text-slate-500">
                  {summary.outstanding} outstanding
                </span>
              ) : null}
            </h3>

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Reference, name or email"
                className="border border-slate-300 rounded-md px-3 py-2 text-sm"
              />

              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="border border-slate-300 rounded-md px-3 py-2 text-sm"
              >
                <option value="">Every status</option>
                {(meta?.statuses || Object.keys(STATUS_LABELS)).map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status] || status}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={loadQueue}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 text-sm"
              >
                <RefreshCw size={15} />
                Refresh
              </button>
            </div>
          </div>

          {summary && summary.byGrade.length > 0 && (
            <div className="mb-5 flex flex-wrap gap-2">
              {summary.byGrade.slice(0, 8).map((row) => (
                <span
                  key={row.key}
                  className="px-3 py-1 rounded-full bg-slate-100 text-slate-700 text-xs"
                >
                  {row.key}: {row.copies} {row.copies === 1 ? 'copy' : 'copies'}
                </span>
              ))}
            </div>
          )}

          <div className="space-y-3">
            {queue.length ? (
              queue.map((row) => (
                <div
                  key={row._id}
                  className="border border-slate-200 rounded-lg p-4 bg-white"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-800">
                        <span className="font-mono text-sm text-slate-500 mr-2">
                          {row.reference}
                        </span>
                        {row.applicantName}
                      </p>
                      <p className="text-sm text-slate-500">
                        {row.email} · {CHANNEL_LABELS[row.channel] || row.channel} ·{' '}
                        {row.quantity} {row.quantity === 1 ? 'copy' : 'copies'}
                        {row.gradeSought ? ` · ${row.gradeSought}` : ''}
                      </p>
                      {row.address?.line1 && (
                        <p className="text-sm text-slate-600 mt-1">
                          {[row.address.line1, row.address.city, row.address.postcode]
                            .filter(Boolean)
                            .join(', ')}
                        </p>
                      )}
                      {row.trackingRef && (
                        <p className="text-sm text-slate-600 mt-1">
                          <Truck size={14} className="inline mr-1" />
                          {row.courier} {row.trackingRef}
                        </p>
                      )}
                      {row.returnReason && (
                        <p className="text-sm text-red-700 mt-1">
                          Returned: {row.returnReason}
                        </p>
                      )}
                    </div>

                    <span
                      className={`px-2 py-1 rounded text-xs font-medium whitespace-nowrap ${
                        STATUS_STYLES[row.status] || 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {STATUS_LABELS[row.status] || row.status}
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {row.nextStatuses.includes('packed') && (
                      <button
                        type="button"
                        disabled={busyId === row._id}
                        onClick={() => act(row._id, 'pack', {}, 'Marked as packed.')}
                        className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
                      >
                        Pack
                      </button>
                    )}

                    {row.nextStatuses.includes('dispatched') && (
                      <button
                        type="button"
                        disabled={busyId === row._id}
                        onClick={() => dispatchRow(row)}
                        className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60"
                      >
                        Dispatch
                      </button>
                    )}

                    {row.nextStatuses.includes('delivered') && (
                      <button
                        type="button"
                        disabled={busyId === row._id}
                        onClick={() => act(row._id, 'deliver', {}, 'Marked as delivered.')}
                        className="px-3 py-1.5 text-sm rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-60"
                      >
                        Delivered
                      </button>
                    )}

                    {row.nextStatuses.includes('returned') && (
                      <button
                        type="button"
                        disabled={busyId === row._id}
                        onClick={() => returnRow(row)}
                        className="px-3 py-1.5 text-sm rounded-md border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-60"
                      >
                        Came back
                      </button>
                    )}

                    {row.nextStatuses.includes('cancelled') && (
                      <button
                        type="button"
                        disabled={busyId === row._id}
                        onClick={() => cancelRow(row)}
                        className="px-3 py-1.5 text-sm rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-slate-500">Nothing in the queue.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
};

export default ProspectusRequestPanel;
