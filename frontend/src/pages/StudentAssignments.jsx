import React, { useState, useEffect, useCallback, useContext, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Upload, Paperclip, CheckCircle2, Clock, AlertTriangle } from 'lucide-react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';

const API_ORIGIN = 'http://localhost:5000';

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—';

const formatDateTime = (value) =>
  value
    ? new Date(value).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

/**
 * Human-readable deadline label. Uses whole days so "Due today" survives a
 * page left open past midnight better than an hour-based countdown would.
 */
const deadlineLabel = (assignment) => {
  const days = assignment.daysRemaining;
  if (days === null || days === undefined) return 'No deadline';
  if (days > 1) return `${days} days left`;
  if (days === 1) return '1 day left';
  if (days === 0) return 'Due today';
  return `${Math.abs(days)} days overdue`;
};

const deadlineTone = (assignment) => {
  const days = assignment.daysRemaining;
  if (days === null || days === undefined) return 'bg-gray-100 text-gray-600';
  if (days < 0) return 'bg-red-100 text-red-700';
  if (days === 0) return 'bg-yellow-100 text-yellow-800';
  if (days <= 2) return 'bg-orange-100 text-orange-700';
  return 'bg-green-100 text-green-700';
};

const SUBMISSION_BADGES = {
  'not-submitted': { label: 'Not submitted', className: 'bg-gray-100 text-gray-600' },
  submitted: { label: 'Submitted', className: 'bg-blue-100 text-blue-700' },
  late: { label: 'Submitted late', className: 'bg-orange-100 text-orange-700' },
  graded: { label: 'Graded', className: 'bg-green-100 text-green-700' },
  returned: { label: 'Returned', className: 'bg-purple-100 text-purple-700' },
};

const StudentAssignments = () => {
  const { user } = useContext(AuthContext);
  const displayName = user?.name || user?.user?.name || 'Student';

  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [search, setSearch] = useState('');
  const [subjectFilter, setSubjectFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');

  const [expandedId, setExpandedId] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [submitting, setSubmitting] = useState(null);

  const fetchAssignments = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { limit: 50 };
      if (search.trim()) params.search = search.trim();
      if (subjectFilter !== 'All') params.subject = subjectFilter;

      const res = await api.get('/assignments', { params });
      setAssignments(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load your assignments right now.');
    } finally {
      setLoading(false);
    }
  }, [search, subjectFilter]);

  useEffect(() => {
    const timer = setTimeout(fetchAssignments, 300);
    return () => clearTimeout(timer);
  }, [fetchAssignments]);

  const subjects = useMemo(
    () => ['All', ...new Set(assignments.map((a) => a.subject).filter(Boolean))],
    [assignments]
  );

  const visibleAssignments = useMemo(() => {
    if (statusFilter === 'All') return assignments;
    if (statusFilter === 'Pending') {
      return assignments.filter((a) => a.submissionStatus === 'not-submitted');
    }
    if (statusFilter === 'Submitted') {
      return assignments.filter((a) => ['submitted', 'late'].includes(a.submissionStatus));
    }
    return assignments.filter((a) => a.submissionStatus === 'graded');
  }, [assignments, statusFilter]);

  const summary = useMemo(() => {
    const pending = assignments.filter((a) => a.submissionStatus === 'not-submitted');
    return {
      total: assignments.length,
      pending: pending.length,
      overdue: pending.filter((a) => a.isOverdue).length,
      graded: assignments.filter((a) => a.submissionStatus === 'graded').length,
    };
  }, [assignments]);

  const updateDraft = (id, patch) =>
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const handleSubmit = async (assignment) => {
    const draft = drafts[assignment._id] || {};
    const text = (draft.text || '').trim();
    const files = draft.files || [];

    if (!text && files.length === 0) {
      setError('Write your answer or attach a file before submitting.');
      return;
    }

    setSubmitting(assignment._id);
    setError('');
    try {
      const payload = new FormData();
      payload.append('submissionText', text);
      files.forEach((file) => payload.append('files', file));

      const res = await api.post(`/assignments/${assignment._id}/submit`, payload, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      setAssignments((prev) =>
        prev.map((a) =>
          a._id === assignment._id
            ? { ...a, mySubmission: res.data.data, submissionStatus: res.data.data.status }
            : a
        )
      );
      setSuccess('Your submission has been recorded.');
      setTimeout(() => setSuccess(''), 3000);
      setExpandedId(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Submission failed. Please try again.');
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div
      className="min-h-screen p-4 sm:p-6"
      style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
    >
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-700 to-indigo-700 text-white rounded-3xl p-8 shadow-2xl mb-8">
        <Link to="/student" className="inline-flex items-center gap-2 text-blue-100 hover:text-white text-sm">
          <ArrowLeft size={16} /> Back to dashboard
        </Link>
        <h1 className="text-2xl sm:text-4xl font-bold mt-4">My Assignments</h1>
        <p className="text-blue-100 mt-2">
          Everything your teachers have set for you, {displayName}.
        </p>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
          {[
            { label: 'Total', value: summary.total },
            { label: 'Pending', value: summary.pending },
            { label: 'Overdue', value: summary.overdue },
            { label: 'Graded', value: summary.graded },
          ].map((tile) => (
            <div key={tile.label} className="bg-white/15 rounded-2xl p-4 text-center">
              <div className="text-2xl font-bold">{tile.value}</div>
              <div className="text-xs text-blue-100 mt-1">{tile.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-3xl shadow-xl p-6 mb-8">
        <div className="flex flex-col md:flex-row gap-4">
          <input
            type="text"
            placeholder="Search assignments..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border rounded-xl p-3 flex-1 text-gray-700"
          />
          <select
            value={subjectFilter}
            onChange={(e) => setSubjectFilter(e.target.value)}
            className="border rounded-xl p-3 text-gray-700"
          >
            {subjects.map((subject) => (
              <option key={subject} value={subject}>
                {subject}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border rounded-xl p-3 text-gray-700"
          >
            <option value="All">All</option>
            <option value="Pending">Pending</option>
            <option value="Submitted">Submitted</option>
            <option value="Graded">Graded</option>
          </select>
        </div>

        {error && <p className="text-red-600 text-sm mt-4">{error}</p>}
        {success && <p className="text-green-600 text-sm mt-4">{success}</p>}
      </div>

      {/* List */}
      {loading ? (
        <div className="bg-white rounded-3xl shadow-xl p-12 text-center text-gray-500">
          Loading your assignments...
        </div>
      ) : visibleAssignments.length === 0 ? (
        <div className="bg-white rounded-3xl shadow-xl p-12 text-center text-gray-500">
          <p className="text-lg font-semibold">Nothing here yet</p>
          <p className="text-sm mt-2">
            When a teacher publishes an assignment for your class it will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {visibleAssignments.map((assignment) => {
            const badge = SUBMISSION_BADGES[assignment.submissionStatus] || SUBMISSION_BADGES['not-submitted'];
            const submission = assignment.mySubmission;
            const draft = drafts[assignment._id] || {};
            const isExpanded = expandedId === assignment._id;
            const alreadyGraded = submission?.status === 'graded';

            return (
              <div key={assignment._id} className="bg-white rounded-3xl shadow-xl p-6 md:p-8">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="text-2xl font-bold text-gray-800">{assignment.title}</h2>
                    <div className="flex flex-wrap gap-2 mt-3">
                      <span className="text-xs px-3 py-1 rounded-full bg-blue-50 text-blue-700">
                        📚 {assignment.subject}
                      </span>
                      <span className="text-xs px-3 py-1 rounded-full bg-slate-100 text-slate-600">
                        🎯 {assignment.maxPoints} points
                      </span>
                      <span className={`text-xs px-3 py-1 rounded-full ${deadlineTone(assignment)}`}>
                        <Clock size={12} className="inline mr-1" />
                        {deadlineLabel(assignment)}
                      </span>
                      <span className={`text-xs px-3 py-1 rounded-full ${badge.className}`}>{badge.label}</span>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <p className="text-xs text-gray-400">Due</p>
                    <p className="font-semibold text-gray-700">{formatDate(assignment.dueDate)}</p>
                    <p className="text-xs text-gray-400 mt-1">by {assignment.teacherName || 'Teacher'}</p>
                  </div>
                </div>

                <p className="text-gray-600 mt-4 whitespace-pre-wrap">{assignment.description}</p>

                {assignment.instructions && (
                  <div className="mt-4 bg-blue-50 border border-blue-100 rounded-2xl p-4">
                    <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide">Instructions</p>
                    <p className="text-sm text-gray-700 mt-2 whitespace-pre-wrap">{assignment.instructions}</p>
                  </div>
                )}

                {assignment.attachments?.length > 0 && (
                  <div className="flex flex-wrap gap-3 mt-4">
                    {assignment.attachments.map((file) => (
                      <a
                        key={file.fileUrl}
                        href={`${API_ORIGIN}${file.fileUrl}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-2 text-sm text-blue-600 hover:underline"
                      >
                        <Paperclip size={14} /> {file.fileName}
                      </a>
                    ))}
                  </div>
                )}

                {/* Graded feedback */}
                {alreadyGraded && (
                  <div className="mt-5 bg-green-50 border border-green-100 rounded-2xl p-5">
                    <p className="flex items-center gap-2 font-bold text-green-800">
                      <CheckCircle2 size={18} />
                      Scored {submission.grade} / {assignment.maxPoints}
                    </p>
                    {submission.feedback && (
                      <p className="text-sm text-gray-700 mt-2">
                        <strong>Feedback:</strong> {submission.feedback}
                      </p>
                    )}
                    <p className="text-xs text-gray-500 mt-2">Graded {formatDateTime(submission.gradedAt)}</p>
                  </div>
                )}

                {/* Existing submission summary */}
                {submission && !alreadyGraded && (
                  <div className="mt-5 bg-slate-50 border border-slate-100 rounded-2xl p-5">
                    <p className="text-sm text-gray-700">
                      Submitted {formatDateTime(submission.submittedAt)}
                      {submission.revisionCount > 0 && ` · ${submission.revisionCount} revision(s)`}
                    </p>
                    {submission.submissionText && (
                      <p className="text-sm text-gray-600 mt-2 whitespace-pre-wrap">
                        {submission.submissionText}
                      </p>
                    )}
                  </div>
                )}

                {/* Late-submission warning */}
                {assignment.isOverdue && !submission && !assignment.allowLateSubmission && (
                  <p className="mt-5 flex items-center gap-2 text-sm text-red-600">
                    <AlertTriangle size={16} />
                    The deadline has passed and this assignment does not accept late submissions.
                  </p>
                )}

                {/* Submit form */}
                {!alreadyGraded && (assignment.allowLateSubmission || !assignment.isOverdue) && (
                  <div className="mt-5">
                    {!isExpanded ? (
                      <button
                        onClick={() => setExpandedId(assignment._id)}
                        className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-xl font-semibold transition"
                      >
                        <Upload size={18} />
                        {submission ? 'Update submission' : 'Submit assignment'}
                      </button>
                    ) : (
                      <div className="border rounded-2xl p-5 bg-gray-50">
                        <textarea
                          rows={5}
                          placeholder="Type your answer here..."
                          defaultValue={submission?.submissionText || ''}
                          onChange={(e) => updateDraft(assignment._id, { text: e.target.value })}
                          className="w-full border rounded-xl p-3 text-sm text-gray-700 resize-y"
                        />

                        <input
                          type="file"
                          multiple
                          onChange={(e) =>
                            updateDraft(assignment._id, { files: Array.from(e.target.files || []) })
                          }
                          className="mt-3 text-sm text-gray-500"
                        />

                        {draft.files?.length > 0 && (
                          <p className="text-xs text-gray-500 mt-2">
                            {draft.files.length} file(s) ready to upload
                          </p>
                        )}

                        {assignment.isOverdue && (
                          <p className="text-xs text-orange-600 mt-3">
                            This will be recorded as a late submission.
                          </p>
                        )}

                        <div className="flex gap-3 mt-4">
                          <button
                            onClick={() => handleSubmit(assignment)}
                            disabled={submitting === assignment._id}
                            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-xl font-semibold transition disabled:opacity-50"
                          >
                            {submitting === assignment._id ? 'Submitting...' : 'Confirm submission'}
                          </button>
                          <button
                            onClick={() => setExpandedId(null)}
                            className="text-gray-500 hover:text-gray-700 px-4 py-2.5 text-sm"
                          >
                            Cancel
                          </button>
                        </div>
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

export default StudentAssignments;
