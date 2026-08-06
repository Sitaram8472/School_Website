import { useState, useEffect, useCallback } from 'react';
import api from '../../utils/axios';

const EMPTY_FORM = {
  title: '',
  description: '',
  instructions: '',
  subject: '',
  targetClass: 'All Classes',
  dueDate: '',
  maxPoints: 100,
  allowLateSubmission: true,
};

const STATUS_STYLES = {
  draft: 'bg-gray-100 text-gray-600',
  published: 'bg-green-100 text-green-700',
  closed: 'bg-orange-100 text-orange-700',
  archived: 'bg-slate-100 text-slate-500',
};

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—';

const formatDateTimeLocal = (value) => {
  if (!value) return '';
  const date = new Date(value);
  // <input type="datetime-local"> needs a local-time string without the zone.
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
};

const AssignmentPanel = () => {
  const [assignments, setAssignments] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [files, setFiles] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Submission drawer
  const [openAssignment, setOpenAssignment] = useState(null);
  const [submissions, setSubmissions] = useState([]);
  const [stats, setStats] = useState(null);
  const [gradeDraft, setGradeDraft] = useState({});

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 3000);
  };

  const fetchAssignments = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      if (search.trim()) params.search = search.trim();

      const res = await api.get('/assignments/mine', { params });
      setAssignments(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load assignments.');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search]);

  useEffect(() => {
    const timer = setTimeout(fetchAssignments, 300);
    return () => clearTimeout(timer);
  }, [fetchAssignments]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setFiles([]);
    setEditingId(null);
  };

  const buildPayload = () => {
    const payload = new FormData();
    Object.entries(form).forEach(([key, value]) => payload.append(key, value));
    files.forEach((file) => payload.append('files', file));
    return payload;
  };

  const handleSubmit = async (event, publishNow = false) => {
    event.preventDefault();
    setError('');

    if (!form.title.trim() || !form.description.trim() || !form.subject.trim() || !form.dueDate) {
      setError('Title, description, subject and due date are required.');
      return;
    }

    setSaving(true);
    try {
      if (editingId) {
        await api.put(`/assignments/${editingId}`, buildPayload(), {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        flash('Assignment updated.');
      } else {
        const payload = buildPayload();
        payload.append('status', publishNow ? 'published' : 'draft');
        await api.post('/assignments', payload, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        flash(publishNow ? 'Assignment published.' : 'Draft saved.');
      }
      resetForm();
      fetchAssignments();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save assignment.');
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (assignment) => {
    setEditingId(assignment._id);
    setForm({
      title: assignment.title,
      description: assignment.description,
      instructions: assignment.instructions || '',
      subject: assignment.subject,
      targetClass: assignment.targetClass || 'All Classes',
      dueDate: formatDateTimeLocal(assignment.dueDate),
      maxPoints: assignment.maxPoints,
      allowLateSubmission: assignment.allowLateSubmission,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleStatusChange = async (assignment, status) => {
    try {
      await api.patch(`/assignments/${assignment._id}/status`, { status });
      flash(`Assignment ${status}.`);
      fetchAssignments();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to update status.');
    }
  };

  const handleDelete = async (assignment) => {
    if (!window.confirm(`Delete "${assignment.title}"? Submissions are preserved.`)) return;
    try {
      await api.delete(`/assignments/${assignment._id}`);
      setAssignments((prev) => prev.filter((a) => a._id !== assignment._id));
      flash('Assignment deleted.');
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to delete assignment.');
    }
  };

  const openSubmissions = async (assignment) => {
    if (openAssignment?._id === assignment._id) {
      setOpenAssignment(null);
      return;
    }
    setOpenAssignment(assignment);
    setSubmissions([]);
    setStats(null);
    try {
      const [submissionRes, statsRes] = await Promise.all([
        api.get(`/assignments/${assignment._id}/submissions`),
        api.get(`/assignments/${assignment._id}/stats`),
      ]);
      setSubmissions(submissionRes.data.data || []);
      setStats(statsRes.data.data || null);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load submissions.');
    }
  };

  const handleGrade = async (submission) => {
    const draft = gradeDraft[submission._id] || {};
    if (draft.grade === undefined || draft.grade === '') {
      setError('Enter a grade before saving.');
      return;
    }
    try {
      const res = await api.patch(`/assignments/submissions/${submission._id}/grade`, {
        grade: Number(draft.grade),
        feedback: draft.feedback || '',
      });
      setSubmissions((prev) => prev.map((s) => (s._id === submission._id ? { ...s, ...res.data.data } : s)));
      flash('Grade saved.');
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save grade.');
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow p-6 mb-6">
      <h3 className="text-xl font-bold text-gray-800 mb-4">📝 Assignment Management</h3>

      {/* ---- Create / edit form ---- */}
      <form onSubmit={(e) => handleSubmit(e, false)} className="mb-6 space-y-3">
        <div className="grid md:grid-cols-2 gap-3">
          <input
            type="text"
            placeholder="Assignment title *"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="text"
            placeholder="Subject *"
            value={form.subject}
            onChange={(e) => setForm({ ...form, subject: e.target.value })}
            className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <textarea
          placeholder="Description *"
          rows={3}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
        />

        <textarea
          placeholder="Instructions for students (optional)"
          rows={2}
          value={form.instructions}
          onChange={(e) => setForm({ ...form, instructions: e.target.value })}
          className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
        />

        <div className="grid md:grid-cols-3 gap-3">
          <label className="text-xs text-gray-500">
            Due date *
            <input
              type="datetime-local"
              value={form.dueDate}
              onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
              className="mt-1 w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>
          <label className="text-xs text-gray-500">
            Maximum points
            <input
              type="number"
              min="1"
              max="1000"
              value={form.maxPoints}
              onChange={(e) => setForm({ ...form, maxPoints: e.target.value })}
              className="mt-1 w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>
          <label className="text-xs text-gray-500">
            Target class
            <input
              type="text"
              value={form.targetClass}
              onChange={(e) => setForm({ ...form, targetClass: e.target.value })}
              className="mt-1 w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={form.allowLateSubmission}
              onChange={(e) => setForm({ ...form, allowLateSubmission: e.target.checked })}
              className="rounded"
            />
            Accept late submissions
          </label>

          <input
            type="file"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files || []))}
            className="text-xs text-gray-500"
          />
        </div>

        {error && <p className="text-red-500 text-sm">{error}</p>}
        {success && <p className="text-green-600 text-sm">{success}</p>}

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={saving}
            className="bg-gray-600 hover:bg-gray-700 text-white px-5 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
          >
            {saving ? 'Saving...' : editingId ? 'Save changes' : 'Save as draft'}
          </button>

          {!editingId && (
            <button
              type="button"
              onClick={(e) => handleSubmit(e, true)}
              disabled={saving}
              className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
            >
              Publish now
            </button>
          )}

          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              className="text-gray-500 hover:text-gray-700 px-4 py-2 text-sm"
            >
              Cancel
            </button>
          )}
        </div>
      </form>

      {/* ---- Filters ---- */}
      <div className="flex flex-wrap gap-3 mb-4">
        <input
          type="text"
          placeholder="Search assignments..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-[180px] border border-gray-300 rounded-lg px-4 py-2 text-sm"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="border border-gray-300 rounded-lg px-4 py-2 text-sm"
        >
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="closed">Closed</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      {/* ---- List ---- */}
      {loading ? (
        <p className="text-gray-400 text-sm text-center py-6">Loading assignments...</p>
      ) : assignments.length === 0 ? (
        <p className="text-gray-400 text-sm text-center py-6">
          No assignments yet. Create your first one above.
        </p>
      ) : (
        <div className="space-y-3">
          {assignments.map((assignment) => (
            <div key={assignment._id} className="bg-gray-50 rounded-xl p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-gray-800 text-sm">{assignment.title}</p>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        STATUS_STYLES[assignment.status] || STATUS_STYLES.draft
                      }`}
                    >
                      {assignment.status}
                    </span>
                    {assignment.isOverdue && assignment.status === 'published' && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                        past due
                      </span>
                    )}
                  </div>

                  <p className="text-gray-500 text-xs mt-1 line-clamp-2">{assignment.description}</p>

                  <div className="flex flex-wrap gap-3 mt-2 text-xs text-gray-500">
                    <span>📚 {assignment.subject}</span>
                    <span>🏫 {assignment.targetClass}</span>
                    <span>📅 Due {formatDate(assignment.dueDate)}</span>
                    <span>🎯 {assignment.maxPoints} pts</span>
                    <span>
                      📥 {assignment.submissionCount} submitted · {assignment.gradedCount} graded
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 shrink-0">
                  <button
                    onClick={() => openSubmissions(assignment)}
                    className="text-blue-600 hover:text-blue-800 text-xs"
                  >
                    {openAssignment?._id === assignment._id ? 'Hide' : 'Submissions'}
                  </button>
                  <button
                    onClick={() => handleEdit(assignment)}
                    className="text-gray-500 hover:text-gray-700 text-xs"
                  >
                    Edit
                  </button>
                  {assignment.status !== 'published' && (
                    <button
                      onClick={() => handleStatusChange(assignment, 'published')}
                      className="text-green-600 hover:text-green-800 text-xs"
                    >
                      Publish
                    </button>
                  )}
                  {assignment.status === 'published' && (
                    <button
                      onClick={() => handleStatusChange(assignment, 'closed')}
                      className="text-orange-600 hover:text-orange-800 text-xs"
                    >
                      Close
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(assignment)}
                    className="text-red-400 hover:text-red-600 text-xs"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {/* ---- Submission drawer ---- */}
              {openAssignment?._id === assignment._id && (
                <div className="mt-4 border-t border-gray-200 pt-4">
                  {stats && (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                      {[
                        { label: 'Submitted', value: stats.totalSubmissions },
                        { label: 'Late', value: stats.lateSubmissions },
                        { label: 'Awaiting grade', value: stats.pendingGrading },
                        {
                          label: 'Average',
                          value: stats.averageGrade === null ? '—' : `${stats.averageGrade}/${stats.maxPoints}`,
                        },
                      ].map((tile) => (
                        <div key={tile.label} className="bg-white rounded-lg p-3 text-center border border-gray-100">
                          <div className="text-lg font-bold text-gray-800">{tile.value}</div>
                          <div className="text-[11px] text-gray-500 mt-0.5">{tile.label}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {submissions.length === 0 ? (
                    <p className="text-gray-400 text-xs text-center py-3">No submissions yet.</p>
                  ) : (
                    <div className="space-y-3">
                      {submissions.map((submission) => (
                        <div key={submission._id} className="bg-white rounded-lg p-3 border border-gray-100">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <p className="text-sm font-medium text-gray-800">
                              {submission.student?.name || submission.studentName || 'Student'}
                              {submission.status === 'late' && (
                                <span className="ml-2 text-[11px] bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
                                  late
                                </span>
                              )}
                              {submission.status === 'graded' && (
                                <span className="ml-2 text-[11px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                                  {submission.grade}/{assignment.maxPoints}
                                </span>
                              )}
                            </p>
                            <span className="text-[11px] text-gray-400">
                              {formatDate(submission.submittedAt)}
                            </span>
                          </div>

                          {submission.submissionText && (
                            <p className="text-xs text-gray-600 mt-2 whitespace-pre-wrap">
                              {submission.submissionText}
                            </p>
                          )}

                          {submission.attachments?.length > 0 && (
                            <div className="flex flex-wrap gap-2 mt-2">
                              {submission.attachments.map((file) => (
                                <a
                                  key={file.fileUrl}
                                  href={`http://localhost:5000${file.fileUrl}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-[11px] text-blue-600 hover:underline"
                                >
                                  📎 {file.fileName}
                                </a>
                              ))}
                            </div>
                          )}

                          <div className="flex flex-wrap items-center gap-2 mt-3">
                            <input
                              type="number"
                              min="0"
                              max={assignment.maxPoints}
                              placeholder="Grade"
                              defaultValue={submission.grade ?? ''}
                              onChange={(e) =>
                                setGradeDraft((prev) => ({
                                  ...prev,
                                  [submission._id]: { ...prev[submission._id], grade: e.target.value },
                                }))
                              }
                              className="w-24 border border-gray-300 rounded-lg px-3 py-1.5 text-xs"
                            />
                            <input
                              type="text"
                              placeholder="Feedback (optional)"
                              defaultValue={submission.feedback || ''}
                              onChange={(e) =>
                                setGradeDraft((prev) => ({
                                  ...prev,
                                  [submission._id]: { ...prev[submission._id], feedback: e.target.value },
                                }))
                              }
                              className="flex-1 min-w-[160px] border border-gray-300 rounded-lg px-3 py-1.5 text-xs"
                            />
                            <button
                              onClick={() => handleGrade(submission)}
                              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-1.5 rounded-lg text-xs"
                            >
                              Save grade
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default AssignmentPanel;
