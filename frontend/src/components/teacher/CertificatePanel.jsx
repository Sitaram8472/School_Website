import { useState, useEffect, useCallback, useContext } from 'react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';

/**
 * Office-side certificate queue.
 *
 * The flow is deliberately two-step at the end: approve, then issue. Approving
 * says the office is satisfied the document can be written; issuing is the
 * moment a serial number is burned and the certificate becomes something a
 * third party can verify. Collapsing them would mean every approval consumed a
 * serial, including the ones later rejected.
 */

const STATUS_STYLES = {
  submitted: 'bg-gray-100 text-gray-700',
  'under-review': 'bg-blue-100 text-blue-700',
  'info-required': 'bg-amber-100 text-amber-800',
  approved: 'bg-indigo-100 text-indigo-700',
  issued: 'bg-green-100 text-green-700',
  collected: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-200 text-gray-500',
  revoked: 'bg-red-200 text-red-800',
};

const STATUS_FILTERS = [
  '', 'submitted', 'under-review', 'info-required', 'approved',
  'issued', 'collected', 'rejected', 'revoked',
];

const formatDateTime = (value) =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

const CertificatePanel = () => {
  const { user } = useContext(AuthContext);
  const isAdmin = (user?.role || user?.user?.role) === 'admin';

  const [requests, setRequests] = useState([]);
  const [stats, setStats] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [noteText, setNoteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 5000);
  };

  const load = useCallback(async () => {
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      if (search.trim()) params.search = search.trim();
      const res = await api.get('/certificates/queue', { params });
      setRequests(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the queue.');
    }
  }, [statusFilter, search]);

  const loadStats = useCallback(async () => {
    try {
      const res = await api.get('/certificates/stats');
      setStats(res.data.stats);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadStats(); }, [loadStats]);

  const act = async (request, path, body, message) => {
    setBusy(true);
    setError('');
    try {
      const res = await api.patch(`/certificates/${request._id}/${path}`, body || {});
      flash(message || res.data.message);
      await Promise.all([load(), loadStats()]);
    } catch (err) {
      // 409s here are the interesting ones — an illegal transition, or a
      // second issue attempt on an already-issued certificate.
      setError(err.response?.data?.message || 'That action was refused.');
    } finally {
      setBusy(false);
    }
  };

  const askAndAct = (request, path, prompt, field) => {
    const value = window.prompt(prompt);
    if (!value) return;
    act(request, path, { [field]: value });
  };

  const addNote = async (request, isInternal) => {
    if (!noteText.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/certificates/${request._id}/remarks`, {
        body: noteText,
        isInternal,
      });
      setNoteText('');
      flash(isInternal ? 'Internal note added.' : 'Reply sent to the student.');
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not add that note.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Open', value: stats.open },
            { label: 'Issued', value: stats.issued + stats.collected },
            { label: 'Revoked', value: stats.revoked },
            {
              label: 'Avg turnaround',
              value: stats.averageTurnaroundHours === null
                ? '—'
                : `${stats.averageTurnaroundHours}h`,
            },
          ].map((entry) => (
            <div key={entry.label} className="bg-white rounded-xl shadow p-4 text-center">
              <div className="text-xl font-bold text-gray-800">{entry.value}</div>
              <div className="text-xs text-gray-400 mt-1">{entry.label}</div>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-xl px-4 py-3">
          {success}
        </div>
      )}

      <div className="bg-white rounded-2xl shadow p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h3 className="text-xl font-bold text-gray-800">📄 Document requests</h3>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Reference, name or roll"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
            >
              {STATUS_FILTERS.map((value) => (
                <option key={value || 'all'} value={value}>
                  {value || 'All statuses'}
                </option>
              ))}
            </select>
          </div>
        </div>

        {requests.length === 0 && (
          <p className="text-gray-400 text-sm text-center py-6">Nothing in the queue.</p>
        )}

        <div className="space-y-3">
          {requests.map((request) => {
            const isOpen = expanded === request._id;
            return (
              <div key={request._id} className="border border-gray-200 rounded-xl overflow-hidden">
                <button
                  onClick={() => { setExpanded(isOpen ? null : request._id); setNoteText(''); }}
                  className="w-full text-left px-4 py-3 hover:bg-gray-50 transition"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-xs text-gray-400">
                          {request.requestNumber}
                        </span>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            STATUS_STYLES[request.status] || 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {request.status}
                        </span>
                      </div>
                      <p className="font-semibold text-gray-800 text-sm mt-0.5">
                        {request.typeLabel} — {request.studentName}
                        {request.className ? ` (${request.className})` : ''}
                      </p>
                      <p className="text-xs text-gray-400">
                        {request.deliveryMode} &middot; {request.copies} cop
                        {request.copies === 1 ? 'y' : 'ies'} &middot;{' '}
                        {formatDateTime(request.createdAt)}
                      </p>
                    </div>
                    {request.serialNumber && (
                      <span className="font-mono text-xs text-green-700 shrink-0">
                        {request.serialNumber}
                      </span>
                    )}
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-gray-200 px-4 py-4 bg-gray-50 space-y-4">
                    <div>
                      <p className="text-xs text-gray-400 uppercase tracking-wide">Purpose</p>
                      <p className="text-sm text-gray-700">{request.purpose}</p>
                    </div>

                    {request.deliveryMode === 'post' && request.postalAddress && (
                      <div>
                        <p className="text-xs text-gray-400 uppercase tracking-wide">
                          Postal address
                        </p>
                        <p className="text-sm text-gray-700 whitespace-pre-line">
                          {request.postalAddress}
                        </p>
                      </div>
                    )}

                    {request.serialNumber && (
                      <div className="bg-white border border-green-200 rounded-lg p-3 text-sm space-y-1">
                        <div className="flex justify-between gap-2">
                          <span className="text-gray-500">Serial</span>
                          <span className="font-mono text-gray-800">{request.serialNumber}</span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span className="text-gray-500">Issued by</span>
                          <span className="text-gray-800">
                            {request.issuedByName} on {formatDateTime(request.issuedAt)}
                          </span>
                        </div>
                        {request.validUntil && (
                          <div className="flex justify-between gap-2">
                            <span className="text-gray-500">Valid until</span>
                            <span className="text-gray-800">
                              {formatDateTime(request.validUntil)}
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2">
                      {request.status === 'submitted' && (
                        <button
                          onClick={() => act(request, 'review')}
                          disabled={busy}
                          className="text-xs bg-blue-100 text-blue-700 hover:bg-blue-200 px-3 py-1 rounded-full transition"
                        >
                          Take up for review
                        </button>
                      )}
                      {['submitted', 'under-review'].includes(request.status) && (
                        <button
                          onClick={() =>
                            askAndAct(request, 'request-info', 'What do you need from the student?', 'question')
                          }
                          disabled={busy}
                          className="text-xs bg-amber-100 text-amber-800 hover:bg-amber-200 px-3 py-1 rounded-full transition"
                        >
                          Ask for information
                        </button>
                      )}
                      {request.status === 'under-review' && (
                        <button
                          onClick={() => act(request, 'approve')}
                          disabled={busy}
                          className="text-xs bg-indigo-100 text-indigo-700 hover:bg-indigo-200 px-3 py-1 rounded-full transition"
                        >
                          Approve
                        </button>
                      )}
                      {request.status === 'approved' && (
                        <button
                          onClick={() => act(request, 'issue')}
                          disabled={busy}
                          className="text-xs bg-green-600 text-white hover:bg-green-700 px-3 py-1 rounded-full transition"
                        >
                          Issue &amp; allot serial
                        </button>
                      )}
                      {request.status === 'issued' && (
                        <button
                          onClick={() => act(request, 'collected')}
                          disabled={busy}
                          className="text-xs bg-emerald-100 text-emerald-700 hover:bg-emerald-200 px-3 py-1 rounded-full transition"
                        >
                          Mark collected
                        </button>
                      )}
                      {['submitted', 'under-review', 'info-required', 'approved'].includes(
                        request.status
                      ) && (
                        <button
                          onClick={() =>
                            askAndAct(request, 'reject', 'Why is this being rejected? The student will see this.', 'reason')
                          }
                          disabled={busy}
                          className="text-xs bg-red-100 text-red-700 hover:bg-red-200 px-3 py-1 rounded-full transition"
                        >
                          Reject
                        </button>
                      )}
                      {isAdmin && ['issued', 'collected'].includes(request.status) && (
                        <button
                          onClick={() =>
                            askAndAct(request, 'revoke', 'Why is this certificate being revoked?', 'reason')
                          }
                          disabled={busy}
                          className="text-xs bg-red-200 text-red-800 hover:bg-red-300 px-3 py-1 rounded-full transition"
                        >
                          Revoke
                        </button>
                      )}
                    </div>

                    {request.remarks?.length > 0 && (
                      <div>
                        <p className="text-xs text-gray-400 uppercase tracking-wide mb-2">
                          Remarks
                        </p>
                        <div className="space-y-2">
                          {request.remarks.map((remark) => (
                            <div
                              key={remark._id}
                              className={`rounded-lg px-3 py-2 ${
                                remark.isInternal
                                  ? 'bg-yellow-50 border border-yellow-200'
                                  : 'bg-white'
                              }`}
                            >
                              <p className="text-sm text-gray-700">{remark.body}</p>
                              <p className="text-xs text-gray-400 mt-1">
                                {remark.authorName} &middot; {formatDateTime(remark.at)}
                                {remark.isInternal && (
                                  <span className="ml-2 text-yellow-700 font-medium">
                                    internal — the student cannot see this
                                  </span>
                                )}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div>
                      <textarea
                        rows={2}
                        placeholder="Add a remark"
                        value={noteText}
                        onChange={(e) => setNoteText(e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
                      />
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => addNote(request, false)}
                          disabled={busy || !noteText.trim()}
                          className="text-xs bg-slate-800 text-white hover:bg-slate-900 px-3 py-1.5 rounded-lg transition disabled:opacity-40"
                        >
                          Reply to student
                        </button>
                        <button
                          onClick={() => addNote(request, true)}
                          disabled={busy || !noteText.trim()}
                          className="text-xs border border-yellow-300 text-yellow-800 hover:bg-yellow-50 px-3 py-1.5 rounded-lg transition disabled:opacity-40"
                        >
                          Internal note
                        </button>
                      </div>
                    </div>

                    {request.auditTrail?.length > 0 && (
                      <details className="text-xs text-gray-500">
                        <summary className="cursor-pointer hover:text-gray-700">
                          Audit trail ({request.auditTrail.length})
                        </summary>
                        <div className="mt-2 space-y-1 font-mono">
                          {request.auditTrail.map((entry, index) => (
                            <div key={index}>
                              {formatDateTime(entry.at)} — {entry.action}
                              {entry.performedByName ? ` by ${entry.performedByName}` : ''}
                              {entry.detail ? ` (${entry.detail})` : ''}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default CertificatePanel;
