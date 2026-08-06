import React, { useState, useEffect, useCallback, useContext } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  ShieldAlert,
  Plus,
  X,
  AlertCircle,
  CheckCircle2,
  EyeOff,
  MessageSquare,
  Send,
  Star,
  RotateCcw,
} from 'lucide-react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';

const CATEGORIES = [
  { value: 'academic', label: 'Academic' },
  { value: 'bullying', label: 'Bullying' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'infrastructure', label: 'Infrastructure' },
  { value: 'transport', label: 'Transport' },
  { value: 'hostel', label: 'Hostel' },
  { value: 'fee', label: 'Fees' },
  { value: 'discipline', label: 'Discipline' },
  { value: 'other', label: 'Other' },
];

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
  low: 'text-gray-500',
  medium: 'text-blue-600',
  high: 'text-orange-600',
  critical: 'text-red-600',
};

// The lifecycle a reporter sees. The full set includes rejected, which is shown
// separately when it happens rather than as a step on the happy path.
const TIMELINE = ['open', 'acknowledged', 'in-progress', 'resolved', 'closed'];

const EMPTY_FORM = {
  category: 'academic',
  subject: '',
  description: '',
  priority: 'medium',
  isAnonymous: false,
  className: '',
};

const formatDateTime = (value) =>
  value
    ? new Date(value).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

const Grievances = () => {
  const { user } = useContext(AuthContext);
  const displayName = user?.name || user?.user?.name || 'Student';

  const [tickets, setTickets] = useState([]);
  const [summary, setSummary] = useState({ total: 0, open: 0, resolved: 0, closed: 0 });

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const [expanded, setExpanded] = useState(null);
  const [replyBody, setReplyBody] = useState('');

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 5000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/grievances/me');
      setTickets(res.data.data || []);
      setSummary(res.data.summary || summary);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load your tickets right now.');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');

    if (form.subject.trim().length < 5) {
      setError('Give the ticket a subject of at least 5 characters.');
      return;
    }
    if (form.description.trim().length < 20) {
      setError('Describe what happened in at least 20 characters.');
      return;
    }

    setBusy(true);
    try {
      const res = await api.post('/grievances', form);
      flash(res.data.message || 'Your ticket has been raised.');
      setForm(EMPTY_FORM);
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not raise that ticket.');
    } finally {
      setBusy(false);
    }
  };

  const openTicket = async (ticket) => {
    if (expanded?._id === ticket._id) {
      setExpanded(null);
      return;
    }

    setError('');
    try {
      const res = await api.get(`/grievances/${ticket._id}`);
      setExpanded(res.data.data);
      setReplyBody('');
    } catch (err) {
      setError(err.response?.data?.message || 'Could not open that ticket.');
    }
  };

  const handleReply = async (event) => {
    event.preventDefault();
    if (!replyBody.trim()) return;

    setBusy(true);
    setError('');
    try {
      const res = await api.post(`/grievances/${expanded._id}/comments`, { body: replyBody });
      setExpanded(res.data.data);
      setReplyBody('');
      flash('Reply posted.');
    } catch (err) {
      setError(err.response?.data?.message || 'Could not post that reply.');
    } finally {
      setBusy(false);
    }
  };

  const handleRate = async (ticket, rating) => {
    setError('');
    try {
      const res = await api.patch(`/grievances/${ticket._id}/rate`, { rating });
      setExpanded(res.data.data);
      flash('Thanks for the feedback.');
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save that rating.');
    }
  };

  const handleReopen = async (ticket) => {
    const reason = window.prompt('Why are you reopening this ticket?');
    if (!reason) return;

    setError('');
    try {
      const res = await api.patch(`/grievances/${ticket._id}/reopen`, { reason });
      setExpanded(res.data.data);
      flash('Ticket reopened.');
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not reopen that ticket.');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-t-4 border-b-4 border-slate-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="max-w-3xl mx-auto px-4 py-8">
        <Link
          to="/student"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4"
        >
          <ArrowLeft size={16} /> Back to dashboard
        </Link>

        <div className="bg-gradient-to-r from-slate-700 to-slate-900 rounded-2xl p-6 mb-6 text-white">
          <div className="flex items-center gap-3">
            <ShieldAlert size={30} />
            <div>
              <h1 className="text-2xl font-bold">Grievance Redressal</h1>
              <p className="text-slate-300 text-sm mt-0.5">
                {displayName} · {summary.open} open · {summary.total} total
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-5 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {success && (
          <div className="mb-5 flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-xl text-sm">
            <CheckCircle2 size={16} />
            <span>{success}</span>
          </div>
        )}

        <button
          onClick={() => {
            setShowForm(!showForm);
            setError('');
          }}
          className="w-full mb-5 text-sm bg-slate-800 hover:bg-slate-900 text-white py-3 rounded-xl transition flex items-center justify-center gap-2"
        >
          {showForm ? <X size={16} /> : <Plus size={16} />}
          {showForm ? 'Close' : 'Raise a complaint'}
        </button>

        {/* ---- Raise form ---- */}
        {showForm && (
          <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow p-6 space-y-4 mb-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
                <select
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                >
                  {CATEGORIES.map((cat) => (
                    <option key={cat.value} value={cat.value}>
                      {cat.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Priority</label>
                <select
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Subject</label>
              <input
                value={form.subject}
                onChange={(e) => setForm({ ...form, subject: e.target.value })}
                placeholder="A short summary"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                What happened?
              </label>
              <textarea
                rows="5"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Include when it happened and who was involved, if you are comfortable doing so."
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
              <p className="text-[11px] text-gray-400 mt-1">
                {form.description.trim().length}/20 characters minimum
              </p>
            </div>

            {/* The anonymity toggle explains exactly what it does — an ambiguous
                promise here is worse than none. */}
            <label
              className={`flex items-start gap-3 rounded-xl px-4 py-3 cursor-pointer border transition ${
                form.isAnonymous
                  ? 'bg-slate-50 border-slate-300'
                  : 'bg-white border-gray-200 hover:border-gray-300'
              }`}
            >
              <input
                type="checkbox"
                checked={form.isAnonymous}
                onChange={(e) => setForm({ ...form, isAnonymous: e.target.checked })}
                className="mt-0.5"
              />
              <span>
                <span className="text-sm font-semibold text-gray-800 flex items-center gap-1.5">
                  <EyeOff size={14} /> Submit anonymously
                </span>
                <span className="block text-[11px] text-gray-500 mt-1 leading-relaxed">
                  Your name and class are hidden from the teachers and staff who handle this
                  ticket. You can still track it and read replies here. School administrators
                  retain access to your identity so that a serious safety report can be acted on —
                  we would rather tell you that than imply otherwise.
                </span>
              </span>
            </label>

            {!form.isAnonymous && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Your class</label>
                <input
                  value={form.className}
                  onChange={(e) => setForm({ ...form, className: e.target.value })}
                  placeholder="Class 9-A"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full bg-slate-800 hover:bg-slate-900 disabled:opacity-60 text-white text-sm py-2.5 rounded-lg transition"
            >
              {busy ? 'Submitting…' : 'Submit ticket'}
            </button>
          </form>
        )}

        {/* ---- Ticket list ---- */}
        <div className="space-y-3">
          {tickets.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-12 bg-white rounded-2xl shadow">
              You have not raised any tickets.
            </p>
          )}

          {tickets.map((ticket) => {
            const isOpen = expanded?._id === ticket._id;
            const detail = isOpen ? expanded : ticket;

            return (
              <div key={ticket._id} className="bg-white rounded-2xl shadow overflow-hidden">
                <button
                  onClick={() => openTicket(ticket)}
                  className="w-full text-left px-5 py-4 hover:bg-gray-50 transition"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[11px] font-mono text-gray-400">{ticket.ticketId}</p>
                      <p className="font-semibold text-gray-800 mt-0.5">{ticket.subject}</p>
                      <p className="text-xs text-gray-500 mt-1">
                        {ticket.category} ·{' '}
                        <span className={PRIORITY_STYLES[ticket.priority]}>{ticket.priority}</span>
                        {ticket.isAnonymous && (
                          <span className="ml-2 inline-flex items-center gap-1 text-slate-500">
                            <EyeOff size={11} /> anonymous
                          </span>
                        )}
                      </p>
                    </div>
                    <span
                      className={`text-[11px] px-2.5 py-1 rounded-full shrink-0 ${
                        STATUS_STYLES[ticket.status] || 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {ticket.status}
                    </span>
                  </div>
                </button>

                {isOpen && (
                  <div className="px-5 pb-5 border-t border-gray-100">
                    {/* Status timeline */}
                    {detail.status !== 'rejected' && (
                      <div className="flex items-center gap-1 my-4">
                        {TIMELINE.map((step, index) => {
                          const reached = TIMELINE.indexOf(detail.status) >= index;
                          return (
                            <React.Fragment key={step}>
                              <div className="flex flex-col items-center">
                                <div
                                  className={`w-2.5 h-2.5 rounded-full ${
                                    reached ? 'bg-slate-700' : 'bg-gray-200'
                                  }`}
                                />
                                <span
                                  className={`text-[9px] mt-1 ${
                                    reached ? 'text-slate-700' : 'text-gray-300'
                                  }`}
                                >
                                  {step}
                                </span>
                              </div>
                              {index < TIMELINE.length - 1 && (
                                <div
                                  className={`flex-1 h-0.5 mb-4 ${
                                    TIMELINE.indexOf(detail.status) > index
                                      ? 'bg-slate-700'
                                      : 'bg-gray-200'
                                  }`}
                                />
                              )}
                            </React.Fragment>
                          );
                        })}
                      </div>
                    )}

                    <p className="text-sm text-gray-700 whitespace-pre-line mt-3">
                      {detail.description}
                    </p>

                    <p className="text-[11px] text-gray-400 mt-3">
                      Raised {formatDateTime(detail.createdAt)}
                      {detail.assignedToName && ` · handled by ${detail.assignedToName}`}
                      {detail.escalationLevel > 0 &&
                        ` · escalated to level ${detail.escalationLevel}`}
                    </p>

                    {detail.resolution && (
                      <div className="mt-4 bg-green-50 border border-green-200 rounded-xl px-4 py-3">
                        <p className="text-xs font-semibold text-green-800">Resolution</p>
                        <p className="text-sm text-green-900 mt-1 whitespace-pre-line">
                          {detail.resolution}
                        </p>
                        <p className="text-[11px] text-green-600 mt-1.5">
                          {formatDateTime(detail.resolvedAt)}
                        </p>
                      </div>
                    )}

                    {/* Replies */}
                    <div className="mt-4">
                      <p className="text-xs font-semibold text-gray-600 mb-2 flex items-center gap-1.5">
                        <MessageSquare size={13} /> Replies ({(detail.comments || []).length})
                      </p>

                      {(detail.comments || []).length === 0 ? (
                        <p className="text-xs text-gray-400">No replies yet.</p>
                      ) : (
                        <ul className="space-y-2">
                          {detail.comments.map((comment) => (
                            <li
                              key={comment._id}
                              className="bg-gray-50 rounded-xl px-4 py-2.5"
                            >
                              <p className="text-[11px] font-semibold text-gray-600">
                                {comment.authorName || 'School'}
                                <span className="font-normal text-gray-400 ml-2">
                                  {formatDateTime(comment.createdAt)}
                                </span>
                              </p>
                              <p className="text-sm text-gray-700 mt-1 whitespace-pre-line">
                                {comment.body}
                              </p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    {/* Reply box */}
                    {!['closed', 'rejected'].includes(detail.status) && (
                      <form onSubmit={handleReply} className="mt-3 flex gap-2">
                        <input
                          value={replyBody}
                          onChange={(e) => setReplyBody(e.target.value)}
                          placeholder="Add a follow-up…"
                          className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm"
                        />
                        <button
                          type="submit"
                          disabled={busy || !replyBody.trim()}
                          className="bg-slate-800 hover:bg-slate-900 disabled:opacity-40 text-white px-4 rounded-lg transition"
                        >
                          <Send size={15} />
                        </button>
                      </form>
                    )}

                    {/* Rate / reopen */}
                    {['resolved', 'closed'].includes(detail.status) && (
                      <div className="mt-4 flex flex-wrap items-center gap-4">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-gray-500">
                            {detail.satisfactionRating ? 'You rated' : 'Rate this:'}
                          </span>
                          {[1, 2, 3, 4, 5].map((star) => (
                            <button
                              key={star}
                              onClick={() => handleRate(detail, star)}
                              disabled={Boolean(detail.satisfactionRating)}
                              className="disabled:cursor-default"
                            >
                              <Star
                                size={16}
                                className={
                                  (detail.satisfactionRating || 0) >= star
                                    ? 'text-amber-400 fill-amber-400'
                                    : 'text-gray-300'
                                }
                              />
                            </button>
                          ))}
                        </div>

                        {detail.status === 'resolved' && (
                          <button
                            onClick={() => handleReopen(detail)}
                            className="text-xs text-blue-600 hover:underline flex items-center gap-1"
                          >
                            <RotateCcw size={12} /> Not actually resolved? Reopen
                          </button>
                        )}
                      </div>
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

export default Grievances;
