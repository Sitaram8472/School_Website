import React, { useState, useEffect, useContext, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CalendarOff, Paperclip, Send, Undo2, AlertCircle } from 'lucide-react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';

const LEAVE_TYPES = [
  { value: 'sick', label: '🤒 Sick leave' },
  { value: 'casual', label: '🏖️ Casual leave' },
  { value: 'emergency', label: '🚨 Emergency' },
  { value: 'event', label: '🎉 School / family event' },
  { value: 'other', label: '📄 Other' },
];

const STATUS_STYLES = {
  pending: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-200 text-gray-600',
  withdrawn: 'bg-slate-100 text-slate-500',
};

const EMPTY_FORM = {
  type: 'sick',
  reason: '',
  fromDate: '',
  toDate: '',
  isHalfDay: false,
  className: '',
  contactDuringLeave: '',
};

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Inclusive day count between two ISO dates, matching what the server derives,
 * so the form can preview the number before submitting.
 */
const countDays = (from, to, isHalfDay) => {
  if (!from || !to) return 0;
  if (isHalfDay) return 0.5;

  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  if (end < start) return 0;

  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((end - start) / msPerDay) + 1;
};

const LeaveRequests = () => {
  const { user } = useContext(AuthContext);
  const displayName = user?.name || user?.user?.name || 'Student';

  const [requests, setRequests] = useState([]);
  const [summary, setSummary] = useState({
    approvedDays: 0,
    pendingDays: 0,
    rejectedCount: 0,
    requestCount: 0,
  });

  const [form, setForm] = useState(EMPTY_FORM);
  const [files, setFiles] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [statusFilter, setStatusFilter] = useState('All');

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/leaves/me', { params: { limit: 50 } });
      setRequests(res.data.data || []);
      setSummary(res.data.summary || summary);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load your leave requests right now.');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  const dayCount = useMemo(
    () => countDays(form.fromDate, form.toDate, form.isHalfDay),
    [form.fromDate, form.toDate, form.isHalfDay]
  );

  const visibleRequests = useMemo(
    () =>
      statusFilter === 'All'
        ? requests
        : requests.filter((request) => request.status === statusFilter.toLowerCase()),
    [requests, statusFilter]
  );

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');

    if (!form.fromDate || !form.toDate) {
      setError('Pick the dates you will be away.');
      return;
    }
    if (new Date(form.toDate) < new Date(form.fromDate)) {
      setError('The end date cannot be before the start date.');
      return;
    }
    if (form.reason.trim().length < 10) {
      setError('Give at least 10 characters explaining the reason.');
      return;
    }

    setSubmitting(true);
    try {
      const payload = new FormData();
      Object.entries(form).forEach(([key, value]) => payload.append(key, value));
      files.forEach((file) => payload.append('files', file));

      await api.post('/leaves', payload, { headers: { 'Content-Type': 'multipart/form-data' } });

      setSuccess('Your leave request has been submitted for approval.');
      setTimeout(() => setSuccess(''), 4000);
      setForm(EMPTY_FORM);
      setFiles([]);
      setShowForm(false);
      fetchRequests();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not submit your request.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleWithdraw = async (request) => {
    if (!window.confirm('Withdraw this leave request?')) return;
    try {
      const res = await api.patch(`/leaves/${request._id}/withdraw`);
      setRequests((prev) => prev.map((item) => (item._id === request._id ? res.data.data : item)));
      setSuccess('Request withdrawn.');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not withdraw this request.');
    }
  };

  return (
    <div
      className="min-h-screen p-4 sm:p-6"
      style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
    >
      {/* Header */}
      <div className="bg-gradient-to-r from-rose-700 to-pink-700 text-white rounded-3xl p-8 shadow-2xl mb-8">
        <Link to="/student" className="inline-flex items-center gap-2 text-rose-100 hover:text-white text-sm">
          <ArrowLeft size={16} /> Back to dashboard
        </Link>

        <div className="flex flex-wrap items-center justify-between gap-4 mt-4">
          <div className="flex items-center gap-4">
            <div className="bg-white text-rose-700 p-4 rounded-full shadow-lg">
              <CalendarOff size={30} />
            </div>
            <div>
              <h1 className="text-2xl sm:text-4xl font-bold">Leave Requests</h1>
              <p className="text-rose-100 mt-1">
                Apply for time off and track approvals, {displayName}.
              </p>
            </div>
          </div>

          <button
            onClick={() => setShowForm((prev) => !prev)}
            className="bg-white text-rose-700 px-6 py-3 rounded-xl font-bold shadow-lg hover:bg-rose-50 transition"
          >
            {showForm ? 'Close form' : '+ Apply for leave'}
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
          {[
            { label: 'Requests filed', value: summary.requestCount },
            { label: 'Approved days', value: summary.approvedDays },
            { label: 'Days awaiting approval', value: summary.pendingDays },
            { label: 'Rejected', value: summary.rejectedCount },
          ].map((tile) => (
            <div key={tile.label} className="bg-white/15 rounded-2xl p-4">
              <div className="text-xl font-bold">{tile.value}</div>
              <div className="text-xs text-rose-100 mt-1">{tile.label}</div>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-100 text-red-700 rounded-2xl p-4 mb-6 flex items-center gap-2">
          <AlertCircle size={18} />
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-100 text-green-700 rounded-2xl p-4 mb-6">
          {success}
        </div>
      )}

      {/* Application form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="bg-white rounded-3xl shadow-xl p-6 md:p-8 mb-8">
          <h2 className="text-2xl font-bold text-gray-800 mb-6">New leave request</h2>

          <div className="grid md:grid-cols-3 gap-4">
            <label className="text-sm text-gray-600">
              Type of leave
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}
                className="mt-1 w-full border rounded-xl px-4 py-2.5 text-gray-700"
              >
                {LEAVE_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-sm text-gray-600">
              From
              <input
                type="date"
                min={todayIso()}
                value={form.fromDate}
                onChange={(e) =>
                  setForm({
                    ...form,
                    fromDate: e.target.value,
                    // Keep the range valid as soon as the start moves past the end.
                    toDate: form.toDate && form.toDate < e.target.value ? e.target.value : form.toDate,
                  })
                }
                className="mt-1 w-full border rounded-xl px-4 py-2.5 text-gray-700"
              />
            </label>

            <label className="text-sm text-gray-600">
              To
              <input
                type="date"
                min={form.fromDate || todayIso()}
                value={form.toDate}
                onChange={(e) => setForm({ ...form, toDate: e.target.value })}
                className="mt-1 w-full border rounded-xl px-4 py-2.5 text-gray-700"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-6 mt-4">
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input
                type="checkbox"
                checked={form.isHalfDay}
                onChange={(e) =>
                  setForm({
                    ...form,
                    isHalfDay: e.target.checked,
                    toDate: e.target.checked ? form.fromDate : form.toDate,
                  })
                }
              />
              Half day only
            </label>

            {dayCount > 0 && (
              <span className="text-sm font-semibold text-rose-700 bg-rose-50 px-4 py-1.5 rounded-full">
                {dayCount} day{dayCount === 1 ? '' : 's'}
              </span>
            )}
          </div>

          <label className="text-sm text-gray-600 block mt-4">
            Reason
            <textarea
              rows={4}
              placeholder="Explain why you need this leave (at least 10 characters)..."
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              className="mt-1 w-full border rounded-xl px-4 py-3 text-gray-700 resize-y"
            />
            <span className="text-xs text-gray-400">{form.reason.trim().length}/1000 characters</span>
          </label>

          <div className="grid md:grid-cols-2 gap-4 mt-4">
            <label className="text-sm text-gray-600">
              Class (optional)
              <input
                type="text"
                placeholder="Class 10"
                value={form.className}
                onChange={(e) => setForm({ ...form, className: e.target.value })}
                className="mt-1 w-full border rounded-xl px-4 py-2.5 text-gray-700"
              />
            </label>

            <label className="text-sm text-gray-600">
              Contact while away (optional)
              <input
                type="text"
                placeholder="Phone number or email"
                value={form.contactDuringLeave}
                onChange={(e) => setForm({ ...form, contactDuringLeave: e.target.value })}
                className="mt-1 w-full border rounded-xl px-4 py-2.5 text-gray-700"
              />
            </label>
          </div>

          <label className="text-sm text-gray-600 block mt-4">
            Supporting document (optional)
            <input
              type="file"
              multiple
              onChange={(e) => setFiles(Array.from(e.target.files || []))}
              className="mt-1 block text-sm text-gray-500"
            />
            {files.length > 0 && (
              <span className="text-xs text-gray-500">{files.length} file(s) attached</span>
            )}
          </label>

          <div className="flex flex-wrap gap-3 mt-6">
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 bg-rose-600 hover:bg-rose-700 text-white px-6 py-3 rounded-xl font-semibold transition disabled:opacity-50"
            >
              <Send size={16} />
              {submitting ? 'Submitting...' : 'Submit request'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setForm(EMPTY_FORM);
              }}
              className="text-gray-500 hover:text-gray-700 px-4 py-3 text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* History */}
      <div className="bg-white rounded-3xl shadow-xl p-6 md:p-8">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <h2 className="text-2xl font-bold text-gray-800">My requests</h2>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border rounded-xl px-4 py-2.5 text-sm text-gray-700"
          >
            {['All', 'Pending', 'Approved', 'Rejected', 'Withdrawn', 'Cancelled'].map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </div>

        {loading ? (
          <p className="text-gray-500 text-center py-12">Loading your requests...</p>
        ) : visibleRequests.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <CalendarOff size={40} className="mx-auto text-gray-300" />
            <p className="text-lg font-semibold mt-4">No leave requests here</p>
            <p className="text-sm mt-2">Use the button above to apply when you need time off.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {visibleRequests.map((request) => (
              <div key={request._id} className="border rounded-2xl p-5 hover:shadow-md transition">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-bold text-gray-800 capitalize">{request.type} leave</h3>
                      <span
                        className={`text-xs px-3 py-1 rounded-full ${
                          STATUS_STYLES[request.status] || STATUS_STYLES.pending
                        }`}
                      >
                        {request.status}
                      </span>
                    </div>

                    <div className="flex flex-wrap gap-3 mt-2 text-sm text-gray-500">
                      <span>
                        {formatDate(request.fromDate)} → {formatDate(request.toDate)}
                      </span>
                      <span>
                        {request.totalDays} day{request.totalDays === 1 ? '' : 's'}
                        {request.isHalfDay && ' (half day)'}
                      </span>
                    </div>

                    <p className="text-sm text-gray-600 mt-3 whitespace-pre-wrap">{request.reason}</p>

                    {request.attachments?.length > 0 && (
                      <div className="flex flex-wrap gap-3 mt-3">
                        {request.attachments.map((file) => (
                          <a
                            key={file.fileUrl}
                            href={`http://localhost:5000${file.fileUrl}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                          >
                            <Paperclip size={12} /> {file.fileName}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>

                  {request.status === 'pending' && (
                    <button
                      onClick={() => handleWithdraw(request)}
                      className="inline-flex items-center gap-1 text-gray-500 hover:text-red-600 text-xs shrink-0"
                    >
                      <Undo2 size={13} /> Withdraw
                    </button>
                  )}
                </div>

                {(request.status === 'approved' ||
                  request.status === 'rejected' ||
                  request.status === 'cancelled') && (
                  <div
                    className={`mt-4 rounded-xl p-4 ${
                      request.status === 'approved'
                        ? 'bg-green-50 border border-green-100'
                        : 'bg-red-50 border border-red-100'
                    }`}
                  >
                    <p className="text-xs text-gray-500">
                      {request.status} by {request.reviewedBy?.name || request.reviewerName || 'staff'} on{' '}
                      {formatDate(request.reviewedAt)}
                    </p>
                    {request.reviewComment && (
                      <p className="text-sm text-gray-700 mt-1">{request.reviewComment}</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default LeaveRequests;
