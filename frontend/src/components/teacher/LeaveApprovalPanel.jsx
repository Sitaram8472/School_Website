import { useState, useEffect, useCallback } from 'react';
import api from '../../utils/axios';

const LEAVE_TYPES = ['sick', 'casual', 'emergency', 'event', 'other'];

const STATUS_STYLES = {
  pending: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-200 text-gray-600',
  withdrawn: 'bg-slate-100 text-slate-500',
};

const TYPE_ICONS = {
  sick: '🤒',
  casual: '🏖️',
  emergency: '🚨',
  event: '🎉',
  other: '📄',
};

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

const dateRange = (request) =>
  request.fromDate === request.toDate ||
  new Date(request.fromDate).toDateString() === new Date(request.toDate).toDateString()
    ? formatDate(request.fromDate)
    : `${formatDate(request.fromDate)} → ${formatDate(request.toDate)}`;

/**
 * The approval queue a teacher works through: pending requests first, with an
 * expandable detail view and approve / reject controls.
 */
const LeaveApprovalPanel = () => {
  const [requests, setRequests] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [typeFilter, setTypeFilter] = useState('');
  const [classFilter, setClassFilter] = useState('');
  const [search, setSearch] = useState('');

  const [expandedId, setExpandedId] = useState(null);
  const [comments, setComments] = useState({});
  const [summaries, setSummaries] = useState({});
  const [deciding, setDeciding] = useState(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 3000);
  };

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { status: statusFilter, limit: 50 };
      if (typeFilter) params.type = typeFilter;
      if (classFilter.trim()) params.className = classFilter.trim();
      if (search.trim()) params.search = search.trim();

      const res = await api.get('/leaves', { params });
      setRequests(res.data.data || []);
      setPendingCount(res.data.pendingCount || 0);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load leave requests.');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter, classFilter, search]);

  useEffect(() => {
    const timer = setTimeout(fetchRequests, 300);
    return () => clearTimeout(timer);
  }, [fetchRequests]);

  /**
   * Pull the student's leave history the first time a request is expanded, so
   * the reviewer can see how much time off has already been approved.
   */
  const toggleExpand = async (request) => {
    if (expandedId === request._id) {
      setExpandedId(null);
      return;
    }

    setExpandedId(request._id);

    const studentId = request.student?._id || request.student;
    if (!studentId || summaries[studentId]) return;

    try {
      const res = await api.get(`/leaves/summary/student/${studentId}`);
      setSummaries((prev) => ({ ...prev, [studentId]: res.data.data }));
    } catch {
      // The summary is supplementary — a failure must not block the decision.
      setSummaries((prev) => ({ ...prev, [studentId]: null }));
    }
  };

  const handleDecision = async (request, decision) => {
    const comment = (comments[request._id] || '').trim();

    if (decision === 'rejected' && !comment) {
      setError('Add a comment explaining the rejection.');
      return;
    }

    setDeciding(request._id);
    setError('');
    try {
      const res = await api.patch(`/leaves/${request._id}/decision`, { decision, comment });
      flash(res.data.message);

      // A decided request leaves the pending queue entirely.
      if (statusFilter === 'pending') {
        setRequests((prev) => prev.filter((item) => item._id !== request._id));
        setPendingCount((prev) => Math.max(0, prev - 1));
      } else {
        setRequests((prev) => prev.map((item) => (item._id === request._id ? res.data.data : item)));
      }
      setExpandedId(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to record the decision.');
    } finally {
      setDeciding(null);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow p-6 mb-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h3 className="text-xl font-bold text-gray-800">🗓️ Leave Requests</h3>
        {pendingCount > 0 && (
          <span className="text-xs bg-yellow-100 text-yellow-800 px-3 py-1 rounded-full font-medium">
            {pendingCount} awaiting review
          </span>
        )}
      </div>

      {/* Filters */}
      <div className="grid md:grid-cols-4 gap-3 mb-5">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
        >
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="withdrawn">Withdrawn</option>
          <option value="cancelled">Cancelled</option>
        </select>

        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
        >
          <option value="">All types</option>
          {LEAVE_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>

        <input
          type="text"
          placeholder="Class, e.g. Class 10"
          value={classFilter}
          onChange={(e) => setClassFilter(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />

        <input
          type="text"
          placeholder="Search student..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />
      </div>

      {error && <p className="text-red-500 text-sm mb-3">{error}</p>}
      {success && <p className="text-green-600 text-sm mb-3">{success}</p>}

      {loading ? (
        <p className="text-gray-400 text-sm text-center py-6">Loading requests...</p>
      ) : requests.length === 0 ? (
        <p className="text-gray-400 text-sm text-center py-6">
          {statusFilter === 'pending'
            ? 'Nothing waiting for review. Nice.'
            : 'No requests match these filters.'}
        </p>
      ) : (
        <div className="space-y-3">
          {requests.map((request) => {
            const isExpanded = expandedId === request._id;
            const studentId = request.student?._id || request.student;
            const summary = summaries[studentId];

            return (
              <div key={request._id} className="bg-gray-50 rounded-xl p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <button
                    onClick={() => toggleExpand(request)}
                    className="text-left min-w-0 flex-1"
                    aria-expanded={isExpanded}
                  >
                    <p className="font-semibold text-gray-800 text-sm flex items-center gap-2 flex-wrap">
                      <span>{TYPE_ICONS[request.type] || '📄'}</span>
                      {request.student?.name || request.studentName}
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded-full ${
                          STATUS_STYLES[request.status] || STATUS_STYLES.pending
                        }`}
                      >
                        {request.status}
                      </span>
                    </p>

                    <div className="flex flex-wrap gap-3 mt-2 text-xs text-gray-500">
                      <span>{dateRange(request)}</span>
                      <span>
                        {request.totalDays} day{request.totalDays === 1 ? '' : 's'}
                        {request.isHalfDay && ' (half day)'}
                      </span>
                      <span className="capitalize">{request.type}</span>
                      {request.className && <span>🏫 {request.className}</span>}
                    </div>

                    {!isExpanded && (
                      <p className="text-xs text-gray-500 mt-2 line-clamp-1">{request.reason}</p>
                    )}
                  </button>

                  <span className="text-[11px] text-gray-400 shrink-0">
                    filed {formatDate(request.createdAt)}
                  </span>
                </div>

                {isExpanded && (
                  <div className="mt-4 border-t border-gray-200 pt-4">
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{request.reason}</p>

                    {request.contactDuringLeave && (
                      <p className="text-xs text-gray-500 mt-2">
                        Contact while away: {request.contactDuringLeave}
                      </p>
                    )}

                    {request.attachments?.length > 0 && (
                      <div className="flex flex-wrap gap-3 mt-3">
                        {request.attachments.map((file) => (
                          <a
                            key={file.fileUrl}
                            href={`http://localhost:5000${file.fileUrl}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-blue-600 hover:underline"
                          >
                            📎 {file.fileName}
                          </a>
                        ))}
                      </div>
                    )}

                    {summary && (
                      <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2">
                        {[
                          { label: 'Requests', value: summary.totalRequests },
                          { label: 'Approved days', value: summary.approvedDays },
                          { label: 'Pending', value: summary.pendingRequests },
                          { label: 'Rejected', value: summary.rejectedRequests },
                        ].map((tile) => (
                          <div
                            key={tile.label}
                            className="bg-white border border-gray-100 rounded-lg p-2.5 text-center"
                          >
                            <div className="text-base font-bold text-gray-800">{tile.value}</div>
                            <div className="text-[10px] text-gray-500 mt-0.5">{tile.label}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {request.status === 'pending' ? (
                      <div className="mt-4">
                        <input
                          type="text"
                          placeholder="Comment (required when rejecting)"
                          value={comments[request._id] || ''}
                          onChange={(e) =>
                            setComments((prev) => ({ ...prev, [request._id]: e.target.value }))
                          }
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                        />

                        <div className="flex flex-wrap gap-2 mt-3">
                          <button
                            onClick={() => handleDecision(request, 'approved')}
                            disabled={deciding === request._id}
                            className="bg-green-600 hover:bg-green-700 text-white px-5 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
                          >
                            {deciding === request._id ? 'Saving...' : 'Approve'}
                          </button>
                          <button
                            onClick={() => handleDecision(request, 'rejected')}
                            disabled={deciding === request._id}
                            className="bg-red-600 hover:bg-red-700 text-white px-5 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
                          >
                            Reject
                          </button>
                          <button
                            onClick={() => setExpandedId(null)}
                            className="text-gray-500 hover:text-gray-700 px-3 py-2 text-sm"
                          >
                            Close
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-4 bg-white border border-gray-100 rounded-lg p-3">
                        <p className="text-xs text-gray-500">
                          {request.status} by {request.reviewedBy?.name || request.reviewerName || 'staff'}{' '}
                          on {formatDate(request.reviewedAt)}
                        </p>
                        {request.reviewComment && (
                          <p className="text-sm text-gray-700 mt-1">{request.reviewComment}</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default LeaveApprovalPanel;
