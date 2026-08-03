import React, { useState, useEffect, useCallback } from 'react';
import {
  ShieldAlert,
  AlertCircle,
  CheckCircle2,
  Clock,
  EyeOff,
  Lock,
  Send,
  TrendingUp,
  X,
} from 'lucide-react';
import api from '../../utils/axios';

const STATUS_STYLES = {
  open: 'bg-blue-100 text-blue-700',
  acknowledged: 'bg-indigo-100 text-indigo-700',
  'in-progress': 'bg-amber-100 text-amber-800',
  escalated: 'bg-orange-100 text-orange-800',
  resolved: 'bg-green-100 text-green-700',
  closed: 'bg-gray-200 text-gray-600',
  rejected: 'bg-red-100 text-red-700',
};

const PRIORITY_STYLES = {
  low: 'bg-gray-100 text-gray-600',
  medium: 'bg-blue-100 text-blue-700',
  high: 'bg-orange-100 text-orange-800',
  critical: 'bg-red-100 text-red-700',
};

const CATEGORIES = [
  'academic',
  'bullying',
  'harassment',
  'infrastructure',
  'transport',
  'hostel',
  'fee',
  'discipline',
  'other',
];

const formatDateTime = (value) =>
  value
    ? new Date(value).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

/** Renders the SLA clock as a phrase rather than a raw hour count. */
const slaLabel = (ticket) => {
  if (!ticket.dueBy) return null;
  if (['resolved', 'closed', 'rejected'].includes(ticket.status)) return null;

  const hours = ticket.slaHoursRemaining;
  if (hours === null || hours === undefined) return null;
  if (hours < 0) return { text: `${Math.abs(hours)}h overdue`, tone: 'text-red-600 font-semibold' };
  if (hours <= 4) return { text: `${hours}h left`, tone: 'text-orange-600 font-semibold' };
  return { text: `${hours}h left`, tone: 'text-gray-400' };
};

const GrievancePanel = () => {
  const [tickets, setTickets] = useState([]);
  const [stats, setStats] = useState(null);
  const [detail, setDetail] = useState(null);

  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);

  const [commentBody, setCommentBody] = useState('');
  const [commentInternal, setCommentInternal] = useState(true);
  const [resolution, setResolution] = useState('');

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 4000);
  };

  const loadQueue = useCallback(async () => {
    try {
      const params = { limit: 100 };
      if (statusFilter) params.status = statusFilter;
      if (categoryFilter) params.category = categoryFilter;
      if (overdueOnly) params.overdue = 'true';

      const res = await api.get('/grievances/queue', { params });
      setTickets(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the queue.');
    }
  }, [statusFilter, categoryFilter, overdueOnly]);

  const loadStats = useCallback(async () => {
    try {
      const res = await api.get('/grievances/stats');
      setStats(res.data.data);
    } catch (err) {
      console.error('Could not load grievance stats', err);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await Promise.all([loadQueue(), loadStats()]);
      setLoading(false);
    };
    load();
  }, [loadQueue, loadStats]);

  const refresh = () => Promise.all([loadQueue(), loadStats()]);

  const openDetail = async (ticket) => {
    setError('');
    try {
      const res = await api.get(`/grievances/${ticket._id}`);
      setDetail(res.data.data);
      setCommentBody('');
      setResolution('');
    } catch (err) {
      setError(err.response?.data?.message || 'Could not open that ticket.');
    }
  };

  /** Every committee action follows the same shape, so they share one runner. */
  const act = async (path, payload, message) => {
    setBusy(true);
    setError('');
    try {
      const res = await api.patch(`/grievances/${detail._id}/${path}`, payload);
      setDetail(res.data.data);
      flash(message);
      await refresh();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not complete that action.');
    } finally {
      setBusy(false);
    }
  };

  const handleComment = async (event) => {
    event.preventDefault();
    if (!commentBody.trim()) return;

    setBusy(true);
    setError('');
    try {
      const res = await api.post(`/grievances/${detail._id}/comments`, {
        body: commentBody,
        isInternal: commentInternal,
      });
      setDetail(res.data.data);
      setCommentBody('');
      flash(commentInternal ? 'Internal note added.' : 'Reply sent to the reporter.');
    } catch (err) {
      setError(err.response?.data?.message || 'Could not add that comment.');
    } finally {
      setBusy(false);
    }
  };

  const handleResolve = async () => {
    if (!resolution.trim()) {
      setError('Say what was done — a resolution note is required.');
      return;
    }
    await act('resolve', { resolution }, 'Ticket resolved.');
  };

  const handleReject = async () => {
    const reason = window.prompt('Why is this being rejected? The reporter will see this.');
    if (!reason) return;
    await act('reject', { reason }, 'Ticket rejected.');
  };

  const handleEscalateOverdue = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.post('/grievances/escalate-overdue', {});
      flash(res.data.message);
      await refresh();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not run the escalation sweep.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded-2xl shadow p-10 flex justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-t-4 border-b-4 border-slate-500" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {stats && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Open', value: stats.open },
              { label: 'Overdue', value: stats.overdue },
              { label: 'Escalated', value: stats.escalated },
              {
                label: 'Avg resolve',
                value: stats.averageResolutionHours ? `${stats.averageResolutionHours}h` : '—',
              },
            ].map((tile) => (
              <div key={tile.label} className="bg-white rounded-xl shadow p-4 text-center">
                <div className="text-xl font-bold text-gray-800">{tile.value}</div>
                <div className="text-xs text-gray-500 mt-1">{tile.label}</div>
              </div>
            ))}
          </div>

          {stats.byCategory?.length > 0 && (
            <div className="bg-white rounded-2xl shadow p-5">
              <h4 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-1.5">
                <TrendingUp size={14} /> Open tickets by category
              </h4>
              <div className="space-y-2">
                {stats.byCategory.map((entry) => (
                  <div key={entry.category} className="flex items-center gap-3">
                    <span className="text-xs text-gray-600 w-32 capitalize">{entry.category}</span>
                    <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-slate-600"
                        style={{
                          width: `${(entry.total / stats.byCategory[0].total) * 100}%`,
                        }}
                      />
                    </div>
                    <span className="text-xs text-gray-400 w-16 text-right">
                      {entry.open}/{entry.total}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 mt-3">
                {stats.anonymousShare}% of tickets were raised anonymously
                {stats.averageRating && ` · average satisfaction ${stats.averageRating}/5`}
              </p>
            </div>
          )}
        </>
      )}

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-xl text-sm">
          <CheckCircle2 size={16} />
          <span>{success}</span>
        </div>
      )}

      {/* ---- Filters ---- */}
      <div className="flex flex-wrap gap-3 items-center">
        <h3 className="font-bold text-gray-800 flex items-center gap-2 mr-auto">
          <ShieldAlert size={18} className="text-slate-600" /> Redressal queue
        </h3>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-200 text-sm"
        >
          <option value="">Active tickets</option>
          <option value="open">Open</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="in-progress">In progress</option>
          <option value="escalated">Escalated</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
        </select>

        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-200 text-sm"
        >
          <option value="">All categories</option>
          {CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={(e) => setOverdueOnly(e.target.checked)}
          />
          Overdue only
        </label>

        <button
          onClick={handleEscalateOverdue}
          disabled={busy}
          className="text-xs bg-orange-100 hover:bg-orange-200 disabled:opacity-50 text-orange-800 px-3 py-2 rounded-lg transition"
        >
          Escalate overdue
        </button>
      </div>

      {/* ---- Queue ---- */}
      <div className="space-y-2">
        {tickets.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-10 bg-white rounded-2xl shadow">
            Nothing in the queue.
          </p>
        )}

        {tickets.map((ticket) => {
          const sla = slaLabel(ticket);

          return (
            <button
              key={ticket._id}
              onClick={() => openDetail(ticket)}
              className={`w-full text-left bg-white rounded-2xl shadow p-4 hover:shadow-md transition border-l-4 ${
                ticket.isOverdue
                  ? 'border-red-500'
                  : ticket.priority === 'critical'
                  ? 'border-orange-400'
                  : 'border-transparent'
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[11px] font-mono text-gray-400">
                    {ticket.ticketId}
                    {ticket.isAnonymous && (
                      <span className="ml-2 inline-flex items-center gap-1 text-slate-500">
                        <EyeOff size={10} /> anonymous
                      </span>
                    )}
                  </p>
                  <p className="font-semibold text-gray-800 mt-0.5 truncate">{ticket.subject}</p>
                  <p className="text-xs text-gray-500 mt-1">
                    {ticket.category} · {ticket.raisedByName || 'Anonymous'}
                    {ticket.assignedToName && ` · with ${ticket.assignedToName}`}
                  </p>
                </div>

                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <div className="flex gap-1.5">
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full ${
                        PRIORITY_STYLES[ticket.priority]
                      }`}
                    >
                      {ticket.priority}
                    </span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full ${
                        STATUS_STYLES[ticket.status] || 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {ticket.status}
                    </span>
                  </div>
                  {sla && (
                    <span className={`text-[11px] flex items-center gap-1 ${sla.tone}`}>
                      <Clock size={10} /> {sla.text}
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* ---- Detail dialog ---- */}
      {detail && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between mb-4">
              <div className="min-w-0">
                <p className="text-[11px] font-mono text-gray-400">{detail.ticketId}</p>
                <h4 className="font-bold text-gray-800 text-lg mt-0.5">{detail.subject}</h4>
                <p className="text-xs text-gray-500 mt-1">
                  {detail.category} ·{' '}
                  {detail.isAnonymous ? (
                    <span className="inline-flex items-center gap-1">
                      <EyeOff size={11} /> reporter hidden
                    </span>
                  ) : (
                    `${detail.raisedByName}${detail.className ? ` (${detail.className})` : ''}`
                  )}{' '}
                  · raised {formatDateTime(detail.createdAt)}
                </p>
              </div>
              <button onClick={() => setDetail(null)}>
                <X size={18} className="text-gray-400 hover:text-gray-700" />
              </button>
            </div>

            <div className="flex flex-wrap gap-2 mb-4">
              <span
                className={`text-[11px] px-2.5 py-1 rounded-full ${PRIORITY_STYLES[detail.priority]}`}
              >
                {detail.priority}
              </span>
              <span
                className={`text-[11px] px-2.5 py-1 rounded-full ${
                  STATUS_STYLES[detail.status] || 'bg-gray-100'
                }`}
              >
                {detail.status}
              </span>
              {detail.isOverdue && (
                <span className="text-[11px] px-2.5 py-1 rounded-full bg-red-100 text-red-700">
                  SLA breached
                </span>
              )}
              {detail.escalationLevel > 0 && (
                <span className="text-[11px] px-2.5 py-1 rounded-full bg-orange-100 text-orange-800">
                  escalation L{detail.escalationLevel}
                </span>
              )}
              {detail.reopenCount > 0 && (
                <span className="text-[11px] px-2.5 py-1 rounded-full bg-purple-100 text-purple-700">
                  reopened {detail.reopenCount}×
                </span>
              )}
            </div>

            <p className="text-sm text-gray-700 whitespace-pre-line bg-gray-50 rounded-xl p-4">
              {detail.description}
            </p>

            {/* ---- Actions ---- */}
            <div className="flex flex-wrap gap-2 mt-4">
              {detail.status === 'open' && (
                <button
                  onClick={() => act('acknowledge', {}, 'Acknowledged.')}
                  disabled={busy}
                  className="text-xs bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg"
                >
                  Acknowledge
                </button>
              )}
              {!['resolved', 'closed', 'rejected', 'escalated'].includes(detail.status) && (
                <button
                  onClick={() => act('escalate', {}, 'Escalated.')}
                  disabled={busy}
                  className="text-xs bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg"
                >
                  Escalate
                </button>
              )}
              {detail.status === 'resolved' && (
                <button
                  onClick={() => act('close', {}, 'Ticket closed.')}
                  disabled={busy}
                  className="text-xs bg-gray-700 hover:bg-gray-800 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg"
                >
                  Close
                </button>
              )}
              {!['resolved', 'closed', 'rejected'].includes(detail.status) && (
                <button
                  onClick={handleReject}
                  disabled={busy}
                  className="text-xs bg-red-100 hover:bg-red-200 disabled:opacity-50 text-red-700 px-3 py-1.5 rounded-lg"
                >
                  Reject
                </button>
              )}
            </div>

            {/* ---- Resolve ---- */}
            {!['resolved', 'closed', 'rejected'].includes(detail.status) && (
              <div className="mt-4 border border-green-200 bg-green-50 rounded-xl p-4">
                <label className="block text-xs font-semibold text-green-800 mb-1.5">
                  Resolution (the reporter will read this)
                </label>
                <textarea
                  rows="3"
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  placeholder="What was done about it?"
                  className="w-full px-3 py-2 border border-green-200 rounded-lg text-sm"
                />
                <button
                  onClick={handleResolve}
                  disabled={busy}
                  className="mt-2 text-xs bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg"
                >
                  {busy ? 'Saving…' : 'Mark resolved'}
                </button>
              </div>
            )}

            {detail.resolution && (
              <div className="mt-4 bg-green-50 border border-green-200 rounded-xl px-4 py-3">
                <p className="text-xs font-semibold text-green-800">Resolution</p>
                <p className="text-sm text-green-900 mt-1 whitespace-pre-line">
                  {detail.resolution}
                </p>
                {detail.satisfactionRating && (
                  <p className="text-[11px] text-green-600 mt-1.5">
                    Reporter rated this {detail.satisfactionRating}/5
                  </p>
                )}
              </div>
            )}

            {/* ---- Comments ---- */}
            <div className="mt-5">
              <p className="text-xs font-semibold text-gray-600 mb-2">
                Comments ({(detail.comments || []).length})
              </p>

              {(detail.comments || []).length === 0 ? (
                <p className="text-xs text-gray-400">No comments yet.</p>
              ) : (
                <ul className="space-y-2">
                  {detail.comments.map((comment) => (
                    <li
                      key={comment._id}
                      className={`rounded-xl px-4 py-2.5 ${
                        comment.isInternal
                          ? 'bg-amber-50 border border-amber-200'
                          : 'bg-gray-50'
                      }`}
                    >
                      <p className="text-[11px] font-semibold text-gray-600 flex items-center gap-1.5">
                        {comment.isInternal && <Lock size={10} className="text-amber-600" />}
                        {comment.authorName || 'Unknown'}
                        <span className="font-normal text-gray-400">
                          {formatDateTime(comment.createdAt)}
                        </span>
                        {comment.isInternal && (
                          <span className="text-amber-700 font-normal">
                            · internal, hidden from the reporter
                          </span>
                        )}
                      </p>
                      <p className="text-sm text-gray-700 mt-1 whitespace-pre-line">
                        {comment.body}
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              <form onSubmit={handleComment} className="mt-3 space-y-2">
                <div className="flex gap-2">
                  <input
                    value={commentBody}
                    onChange={(e) => setCommentBody(e.target.value)}
                    placeholder={commentInternal ? 'Internal note…' : 'Reply to the reporter…'}
                    className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm"
                  />
                  <button
                    type="submit"
                    disabled={busy || !commentBody.trim()}
                    className="bg-slate-800 hover:bg-slate-900 disabled:opacity-40 text-white px-4 rounded-lg transition"
                  >
                    <Send size={15} />
                  </button>
                </div>
                <label className="flex items-center gap-2 text-xs text-gray-600">
                  <input
                    type="checkbox"
                    checked={commentInternal}
                    onChange={(e) => setCommentInternal(e.target.checked)}
                  />
                  Internal note — the reporter never sees this
                </label>
              </form>
            </div>

            {/* ---- Audit trail ---- */}
            {(detail.auditTrail || []).length > 0 && (
              <div className="mt-5">
                <p className="text-xs font-semibold text-gray-600 mb-2">Audit trail</p>
                <ul className="space-y-1">
                  {detail.auditTrail.map((entry) => (
                    <li key={entry._id} className="text-[11px] text-gray-500">
                      {formatDateTime(entry.at)} · <strong>{entry.action}</strong>
                      {entry.fromStatus && ` ${entry.fromStatus} → ${entry.toStatus}`}
                      {entry.performedByName && ` · ${entry.performedByName}`}
                      {entry.note && ` · ${entry.note}`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default GrievancePanel;
