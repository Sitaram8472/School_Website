import { useState, useEffect, useContext, useCallback } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * Emergency broadcasts.
 *
 * For everybody, the page has one job: unacknowledged alerts at the top, in
 * severity colour, with one button. During an incident nothing else on the
 * screen is worth a pixel.
 *
 * For a coordinator, the response bar is recomputed from the receipts on every
 * poll and never accumulated, so the outstanding figure cannot drift away from
 * the list during the twenty minutes it matters. The reconcile control reports
 * what it escalated, which means pressing it twice visibly does nothing the
 * second time — the point of it being idempotent.
 */

const SEVERITY_STYLES = {
  information: 'border-slate-300 bg-slate-50',
  advisory: 'border-blue-300 bg-blue-50',
  urgent: 'border-amber-400 bg-amber-50',
  emergency: 'border-red-500 bg-red-50',
};

const SEVERITY_CHIPS = {
  information: 'bg-slate-200 text-slate-700',
  advisory: 'bg-blue-100 text-blue-700',
  urgent: 'bg-amber-100 text-amber-800',
  emergency: 'bg-red-100 text-red-700',
};

const STATE_LABELS = {
  pending: 'Awaiting your acknowledgement',
  acknowledged: 'Acknowledged',
  'acknowledged-late': 'Acknowledged late',
  escalated: 'Escalated — still unanswered',
  'escalated-acknowledged': 'Acknowledged after escalation',
};

const STATE_STYLES = {
  pending: 'bg-amber-100 text-amber-800',
  acknowledged: 'bg-green-100 text-green-700',
  'acknowledged-late': 'bg-orange-100 text-orange-700',
  escalated: 'bg-red-100 text-red-700',
  'escalated-acknowledged': 'bg-teal-100 text-teal-800',
};

const emptyBroadcast = {
  title: '',
  body: '',
  severity: 'urgent',
  roles: ['teacher', 'staff'],
  channels: ['in-app'],
  acknowledgeWithinMinutes: 30,
  escalateAfterMinutes: 45,
  escalationNote: '',
};

const formatTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
};

/**
 * The dispatch key. Generated once when the form opens, so pressing send twice
 * on a bad connection sends the same broadcast rather than a second one.
 */
const newDispatchKey = () => {
  const now = new Date();
  const stamp = now.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  return `alert-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
};

const SeverityChip = ({ severity }) => (
  <span
    className={`px-2 py-0.5 rounded text-xs font-medium ${
      SEVERITY_CHIPS[severity] || 'bg-gray-100 text-gray-600'
    }`}
  >
    {severity}
  </span>
);

/** Acknowledged, outstanding, escalated — counted, never accumulated. */
const ResponseBar = ({ counts }) => {
  if (!counts) return null;
  const total = counts.recipients || 1;
  const ackPct = Math.round((counts.acknowledged / total) * 100);

  return (
    <div>
      <div className="flex h-3 w-full rounded overflow-hidden bg-gray-100">
        <div className="bg-green-600" style={{ width: `${ackPct}%` }} />
        <div
          className="bg-red-500"
          style={{ width: `${Math.round((counts.byState.escalated / total) * 100)}%` }}
        />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600 mt-2">
        <span className="font-medium text-gray-800">
          {counts.acknowledged} of {counts.recipients} acknowledged
        </span>
        <span>{counts.outstanding} outstanding</span>
        <span>{counts.byState.escalated} escalated and unanswered</span>
        <span>{counts.byState['acknowledged-late']} late</span>
      </div>
    </div>
  );
};

const EmergencyAlerts = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isStaff = role === 'admin' || role === 'staff';
  const isAdmin = role === 'admin';

  const [tab, setTab] = useState('mine');
  const [meta, setMeta] = useState(null);

  const [mine, setMine] = useState({ outstanding: [], all: [] });
  const [broadcasts, setBroadcasts] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [receipts, setReceipts] = useState([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...emptyBroadcast });
  const [dispatchKey, setDispatchKey] = useState(newDispatchKey());

  const readError = (err, fallback) => err?.response?.data?.message || fallback;

  const clearMessages = () => {
    setError('');
    setNotice('');
  };

  const loadMeta = useCallback(async () => {
    try {
      const { data } = await api.get('/broadcasts/meta');
      setMeta(data.data);
    } catch {
      // The compose form falls back to its own defaults.
    }
  }, []);

  const loadMine = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/broadcasts/mine');
      setMine(data.data || { outstanding: [], all: [] });
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load your alerts'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBroadcasts = useCallback(async () => {
    if (!isStaff) return;
    setLoading(true);
    try {
      const { data } = await api.get('/broadcasts');
      setBroadcasts(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load broadcasts'));
    } finally {
      setLoading(false);
    }
  }, [isStaff]);

  const loadDetail = useCallback(
    async (id) => {
      if (!id) return;
      setLoading(true);
      try {
        const { data } = await api.get(`/broadcasts/${id}`);
        setDetail(data.data);
        if (isAdmin && data.data.broadcast.status !== 'draft') {
          const receiptRes = await api.get(`/broadcasts/${id}/receipts`);
          setReceipts(receiptRes.data.data || []);
        }
        setError('');
      } catch (err) {
        setError(readError(err, 'Could not load the broadcast'));
      } finally {
        setLoading(false);
      }
    },
    [isAdmin]
  );

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    if (tab === 'mine') loadMine();
    if (tab === 'sent') loadBroadcasts();
  }, [tab, loadMine, loadBroadcasts]);

  useEffect(() => {
    if (openId) loadDetail(openId);
  }, [openId, loadDetail]);

  const acknowledge = async (receiptId) => {
    clearMessages();
    try {
      const { data } = await api.patch(`/broadcasts/receipts/${receiptId}/acknowledge`);
      setNotice(data.message);
      loadMine();
    } catch (err) {
      setError(readError(err, 'Could not acknowledge the alert'));
    }
  };

  const submitBroadcast = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      const { data } = await api.post('/broadcasts', {
        title: form.title,
        body: form.body,
        severity: form.severity,
        channels: form.channels,
        audience: { roles: form.roles, activeOnly: true },
        acknowledgeWithinMinutes: Number(form.acknowledgeWithinMinutes),
        escalateAfterMinutes: Number(form.escalateAfterMinutes),
        escalationNote: form.escalationNote,
        dispatchKey,
      });
      setNotice(data.alreadyExists ? 'That draft already existed; opening it.' : 'Draft saved.');
      setShowForm(false);
      setForm({ ...emptyBroadcast });
      setDispatchKey(newDispatchKey());
      setOpenId(data.data._id);
      setTab('sent');
      loadBroadcasts();
    } catch (err) {
      setError(readError(err, 'Could not save the broadcast'));
    }
  };

  const dispatch = async () => {
    const confirmed = window.confirm(
      'Dispatch this to everybody in the audience?\n\nSending again later is safe — the dispatch key means nobody receives it twice.'
    );
    if (!confirmed) return;

    clearMessages();
    try {
      const { data } = await api.post(`/broadcasts/${openId}/dispatch`);
      setNotice(data.message);
      loadDetail(openId);
      loadBroadcasts();
    } catch (err) {
      setError(readError(err, 'Could not dispatch the broadcast'));
    }
  };

  const reconcile = async () => {
    clearMessages();
    try {
      const { data } = await api.post(`/broadcasts/${openId}/reconcile`);
      setNotice(data.message);
      loadDetail(openId);
    } catch (err) {
      setError(readError(err, 'Could not escalate the outstanding receipts'));
    }
  };

  const closeBroadcast = async () => {
    const outstanding = detail?.counts?.outstanding || 0;
    let note = '';
    if (outstanding > 0) {
      note =
        window.prompt(
          `${outstanding} people have not acknowledged. Why is this being closed anyway?`
        ) || '';
      if (!note) return;
    }

    clearMessages();
    try {
      const { data } = await api.patch(`/broadcasts/${openId}/close`, { note });
      setNotice(data.message);
      loadDetail(openId);
      loadBroadcasts();
    } catch (err) {
      setError(readError(err, 'Could not close the broadcast'));
    }
  };

  const toggle = (list, value) =>
    list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

  const broadcast = detail?.broadcast;
  const severities = meta?.severities || Object.keys(SEVERITY_CHIPS);
  const channels = meta?.channels || ['in-app'];
  const audienceRoles = meta?.audienceRoles || ['student', 'teacher', 'staff', 'admin'];

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Alerts</h1>
        <p className="text-gray-600 mt-1">
          An emergency message with no acknowledgement is a message the school hopes was read. Every
          figure on this page is counted from the receipts.
        </p>
      </header>

      <div className="flex gap-2 mb-6 border-b">
        <button
          type="button"
          onClick={() => setTab('mine')}
          className={`px-4 py-2 text-sm font-medium border-b-2 ${
            tab === 'mine'
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          My alerts
          {mine.outstanding.length > 0 && (
            <span className="ml-2 px-1.5 py-0.5 rounded bg-red-600 text-white text-xs">
              {mine.outstanding.length}
            </span>
          )}
        </button>
        {isStaff && (
          <button
            type="button"
            onClick={() => setTab('sent')}
            className={`px-4 py-2 text-sm font-medium border-b-2 ${
              tab === 'sent'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Broadcasts
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded bg-red-50 text-red-700 border border-red-200">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 px-4 py-3 rounded bg-green-50 text-green-700 border border-green-200">
          {notice}
        </div>
      )}
      {loading && <p className="text-gray-500 mb-4">Loading…</p>}

      {tab === 'mine' && (
        <section className="space-y-4">
          {mine.outstanding.length === 0 && !loading && (
            <p className="text-gray-500">Nothing is waiting on you.</p>
          )}

          {mine.outstanding.map((receipt) => (
            <article
              key={receipt._id}
              className={`rounded-lg border-2 p-5 ${
                SEVERITY_STYLES[receipt.broadcast?.severity] || 'border-gray-200 bg-white'
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">
                    {receipt.broadcast?.title}
                  </h2>
                  <p className="text-xs text-gray-500">
                    {receipt.broadcast?.ref} · sent {formatTime(receipt.deliveredAt)}
                  </p>
                </div>
                <SeverityChip severity={receipt.broadcast?.severity} />
              </div>

              <p className="text-gray-800 mt-3 whitespace-pre-line">{receipt.broadcast?.body}</p>

              <div className="flex items-center gap-3 mt-4">
                <button
                  type="button"
                  onClick={() => acknowledge(receipt._id)}
                  className="px-5 py-2.5 rounded bg-gray-900 text-white text-sm font-semibold hover:bg-black"
                >
                  I have read this
                </button>
                <span
                  className={`px-2 py-0.5 rounded text-xs font-medium ${
                    STATE_STYLES[receipt.state]
                  }`}
                >
                  {STATE_LABELS[receipt.state]}
                </span>
                {receipt.dueAt && (
                  <span className="text-xs text-gray-500">
                    asked for by {formatTime(receipt.dueAt)}
                  </span>
                )}
              </div>
            </article>
          ))}

          {mine.all.length > mine.outstanding.length && (
            <div className="pt-4">
              <h2 className="text-sm font-semibold text-gray-700 mb-2">Earlier alerts</h2>
              <div className="space-y-2">
                {mine.all
                  .filter((receipt) => !mine.outstanding.some((live) => live._id === receipt._id))
                  .map((receipt) => (
                    <div
                      key={receipt._id}
                      className="bg-white rounded border px-4 py-3 flex items-center justify-between gap-4"
                    >
                      <div>
                        <p className="text-sm font-medium text-gray-900">
                          {receipt.broadcast?.title}
                        </p>
                        <p className="text-xs text-gray-500">
                          {formatTime(receipt.deliveredAt)}
                        </p>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${
                          STATE_STYLES[receipt.state]
                        }`}
                      >
                        {STATE_LABELS[receipt.state]}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </section>
      )}

      {tab === 'sent' && isStaff && !openId && (
        <section>
          <div className="mb-4">
            <button
              type="button"
              onClick={() => {
                setShowForm((open) => !open);
                setDispatchKey(newDispatchKey());
              }}
              className="px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
            >
              {showForm ? 'Cancel' : 'Compose'}
            </button>
          </div>

          {showForm && (
            <form onSubmit={submitBroadcast} className="bg-white rounded-lg border p-5 mb-6">
              <label className="text-sm block mb-4">
                <span className="text-gray-600">Title</span>
                <input
                  required
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  className="mt-1 w-full border rounded px-3 py-2"
                />
              </label>

              <label className="text-sm block mb-4">
                <span className="text-gray-600">What has happened, and what to do</span>
                <textarea
                  required
                  rows="4"
                  value={form.body}
                  onChange={(e) => setForm({ ...form, body: e.target.value })}
                  className="mt-1 w-full border rounded px-3 py-2"
                />
              </label>

              <div className="grid md:grid-cols-3 gap-4">
                <label className="text-sm">
                  <span className="text-gray-600">Severity</span>
                  <select
                    value={form.severity}
                    onChange={(e) => setForm({ ...form, severity: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  >
                    {severities.map((severity) => (
                      <option key={severity} value={severity}>
                        {severity}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Acknowledge within (minutes)</span>
                  <input
                    type="number"
                    min="1"
                    value={form.acknowledgeWithinMinutes}
                    onChange={(e) =>
                      setForm({ ...form, acknowledgeWithinMinutes: e.target.value })
                    }
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Escalate after (minutes)</span>
                  <input
                    type="number"
                    min="1"
                    value={form.escalateAfterMinutes}
                    onChange={(e) => setForm({ ...form, escalateAfterMinutes: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
              </div>

              <div className="mt-4">
                <p className="text-sm text-gray-600 mb-2">Who this goes to</p>
                <div className="flex flex-wrap gap-3">
                  {audienceRoles.map((audienceRole) => (
                    <label key={audienceRole} className="text-sm flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={form.roles.includes(audienceRole)}
                        onChange={() => setForm({ ...form, roles: toggle(form.roles, audienceRole) })}
                      />
                      {audienceRole}
                    </label>
                  ))}
                </div>
              </div>

              <div className="mt-4">
                <p className="text-sm text-gray-600 mb-2">Channels intended</p>
                <div className="flex flex-wrap gap-3">
                  {channels.map((channel) => (
                    <label key={channel} className="text-sm flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={form.channels.includes(channel)}
                        onChange={() =>
                          setForm({ ...form, channels: toggle(form.channels, channel) })
                        }
                      />
                      {channel}
                    </label>
                  ))}
                </div>
              </div>

              <p className="text-xs text-gray-500 mt-4 font-mono">dispatch key {dispatchKey}</p>
              <p className="text-xs text-gray-500">
                The key is what makes sending twice safe. It is fixed when this form opens and does
                not change if the request has to be retried.
              </p>

              <button
                type="submit"
                className="mt-4 px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
              >
                Save draft
              </button>
            </form>
          )}

          <div className="space-y-3">
            {broadcasts.map((item) => (
              <button
                key={item._id}
                type="button"
                onClick={() => setOpenId(item._id)}
                className="w-full text-left bg-white rounded-lg border p-4 hover:border-blue-400"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <p className="font-semibold text-gray-900">
                      {item.ref ? `${item.ref} · ` : ''}
                      {item.title}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      {item.status} · {formatTime(item.dispatchedAt || item.createdAt)}
                    </p>
                    {item.counts && (
                      <div className="mt-3">
                        <ResponseBar counts={item.counts} />
                      </div>
                    )}
                  </div>
                  <SeverityChip severity={item.severity} />
                </div>
              </button>
            ))}
            {broadcasts.length === 0 && !loading && (
              <p className="text-gray-500">Nothing has been sent yet.</p>
            )}
          </div>
        </section>
      )}

      {tab === 'sent' && isStaff && openId && broadcast && (
        <section>
          <button
            type="button"
            onClick={() => {
              setOpenId(null);
              setDetail(null);
              setReceipts([]);
            }}
            className="text-sm text-blue-700 mb-4"
          >
            ← All broadcasts
          </button>

          <div
            className={`rounded-lg border-2 p-5 mb-6 ${
              SEVERITY_STYLES[broadcast.severity] || 'border-gray-200 bg-white'
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">{broadcast.title}</h2>
                <p className="text-xs text-gray-500">
                  {broadcast.ref || 'Draft'} · {broadcast.status} ·{' '}
                  {formatTime(broadcast.dispatchedAt)}
                </p>
              </div>
              <SeverityChip severity={broadcast.severity} />
            </div>

            <p className="text-gray-800 mt-3 whitespace-pre-line">{broadcast.body}</p>

            {broadcast.supersedes && (
              <p className="mt-3 text-sm text-blue-800">
                This corrects an earlier broadcast, which stays on the record as what people were
                told first.
              </p>
            )}

            {detail.intact === false && (
              <p className="mt-3 text-sm text-red-700">
                This broadcast does not match what was dispatched.
              </p>
            )}
          </div>

          {detail.counts && (
            <div className="bg-white rounded-lg border p-5 mb-6">
              <h3 className="font-semibold text-gray-900 mb-3">Response</h3>
              <ResponseBar counts={detail.counts} />
            </div>
          )}

          <div className="flex flex-wrap gap-2 mb-6">
            {broadcast.status === 'draft' && (
              <button
                type="button"
                onClick={dispatch}
                className="px-4 py-2 rounded bg-red-600 text-white text-sm font-semibold hover:bg-red-700"
              >
                Dispatch
              </button>
            )}
            {broadcast.status === 'dispatched' && (
              <>
                <button
                  type="button"
                  onClick={dispatch}
                  className="px-4 py-2 rounded border text-sm font-medium hover:bg-gray-50"
                >
                  Re-send to anyone missed
                </button>
                <button
                  type="button"
                  onClick={reconcile}
                  className="px-4 py-2 rounded border text-sm font-medium hover:bg-gray-50"
                >
                  Escalate the outstanding
                </button>
                <button
                  type="button"
                  onClick={closeBroadcast}
                  className="px-4 py-2 rounded bg-gray-900 text-white text-sm font-medium hover:bg-black"
                >
                  Close incident
                </button>
              </>
            )}
          </div>

          {broadcast.status === 'closed' && broadcast.outstandingAtClose > 0 && (
            <div className="mb-6 px-4 py-3 rounded bg-amber-50 text-amber-800 border border-amber-200">
              Closed with {broadcast.outstandingAtClose} unacknowledged.{' '}
              {broadcast.closureNote}
            </div>
          )}

          {isAdmin && receipts.length > 0 && (
            <div className="bg-white rounded-lg border overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="text-left px-4 py-2">Recipient</th>
                    <th className="text-left px-4 py-2">Role</th>
                    <th className="text-left px-4 py-2">State</th>
                    <th className="text-left px-4 py-2">Answered</th>
                  </tr>
                </thead>
                <tbody>
                  {receipts.map((receipt) => (
                    <tr key={receipt._id} className="border-t">
                      <td className="px-4 py-2">{receipt.recipient?.name || '—'}</td>
                      <td className="px-4 py-2 text-gray-500">{receipt.recipient?.role}</td>
                      <td className="px-4 py-2">
                        <span
                          className={`px-2 py-0.5 rounded text-xs font-medium ${
                            STATE_STYLES[receipt.state]
                          }`}
                        >
                          {STATE_LABELS[receipt.state]}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-gray-500">
                        {formatTime(receipt.acknowledgedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
};

export default EmergencyAlerts;
