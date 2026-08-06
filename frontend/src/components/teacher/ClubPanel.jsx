import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Sparkles,
  Plus,
  X,
  AlertCircle,
  CheckCircle2,
  Users,
  CalendarDays,
  ClipboardCheck,
  Trophy,
} from 'lucide-react';
import api from '../../utils/axios';

const CATEGORIES = [
  'sports',
  'arts',
  'music',
  'technology',
  'literary',
  'science',
  'social-service',
  'other',
];

const EMPTY_CLUB = {
  name: '',
  category: 'other',
  description: '',
  meetingDay: '',
  meetingTime: '',
  venue: '',
  capacity: 25,
  eligibleClasses: '',
  requiresApproval: false,
};

const EMPTY_SESSION = { title: '', scheduledFor: '', durationMinutes: 60, venue: '', agenda: '' };

const STATUS_TONES = {
  open: 'bg-green-100 text-green-700',
  closed: 'bg-amber-100 text-amber-800',
  archived: 'bg-gray-200 text-gray-600',
};

const formatDateTime = (value) =>
  value
    ? new Date(value).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

/** Value for a datetime-local input, in the browser's own timezone. */
const toLocalInputValue = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
};

const ClubPanel = () => {
  const [clubs, setClubs] = useState([]);
  const [stats, setStats] = useState(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_CLUB);
  const [editingId, setEditingId] = useState(null);

  const [detail, setDetail] = useState(null);
  const [sessionForm, setSessionForm] = useState(EMPTY_SESSION);
  const [showSessionForm, setShowSessionForm] = useState(false);

  // sessionId -> { studentId: present }
  const [attendanceDraft, setAttendanceDraft] = useState(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 4000);
  };

  const loadClubs = useCallback(async () => {
    try {
      const res = await api.get('/clubs', { params: { limit: 100 } });
      setClubs(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load clubs.');
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const res = await api.get('/clubs/stats');
      setStats(res.data.data);
    } catch (err) {
      console.error('Could not load club stats', err);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await Promise.all([loadClubs(), loadStats()]);
      setLoading(false);
    };
    load();
  }, [loadClubs, loadStats]);

  const openDetail = async (club) => {
    setError('');
    try {
      const res = await api.get(`/clubs/${club._id}`);
      setDetail(res.data.data);
      setShowSessionForm(false);
      setAttendanceDraft(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not open that club.');
    }
  };

  const refreshDetail = async () => {
    if (detail?.club?._id) await openDetail(detail.club);
    await Promise.all([loadClubs(), loadStats()]);
  };

  const handleSaveClub = async (event) => {
    event.preventDefault();
    setError('');

    if (form.name.trim().length < 3) {
      setError('Give the club a name of at least 3 characters.');
      return;
    }
    if (form.description.trim().length < 10) {
      setError('Describe the club in at least 10 characters.');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ...form,
        capacity: Number(form.capacity),
        meetingTime: form.meetingTime || undefined,
        eligibleClasses: form.eligibleClasses
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean),
      };

      if (editingId) {
        await api.put(`/clubs/${editingId}`, payload);
        flash('Club updated.');
      } else {
        await api.post('/clubs', payload);
        flash('Club created.');
      }

      setForm(EMPTY_CLUB);
      setEditingId(null);
      setShowForm(false);
      await Promise.all([loadClubs(), loadStats()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save the club.');
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (club) => {
    setEditingId(club._id);
    setForm({
      name: club.name || '',
      category: club.category || 'other',
      description: club.description || '',
      meetingDay: club.meetingDay || '',
      meetingTime: club.meetingTime || '',
      venue: club.venue || '',
      capacity: club.capacity || 25,
      eligibleClasses: (club.eligibleClasses || []).join(', '),
      requiresApproval: Boolean(club.requiresApproval),
    });
    setShowForm(true);
    setError('');
  };

  const handleDecision = async (membership, decision) => {
    setError('');
    try {
      await api.patch(`/clubs/memberships/${membership._id}/decision`, { decision });
      flash(decision === 'approve' ? 'Member approved.' : 'Request rejected.');
      await refreshDetail();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not record that decision.');
    }
  };

  const handleScheduleSession = async (event) => {
    event.preventDefault();
    setError('');

    if (!sessionForm.title.trim() || !sessionForm.scheduledFor) {
      setError('A session needs a title and a date.');
      return;
    }
    if (new Date(sessionForm.scheduledFor) < new Date()) {
      setError('That session date has already passed.');
      return;
    }

    setSaving(true);
    try {
      await api.post(`/clubs/${detail.club._id}/sessions`, {
        ...sessionForm,
        durationMinutes: Number(sessionForm.durationMinutes) || 60,
      });
      flash('Session scheduled.');
      setSessionForm(EMPTY_SESSION);
      setShowSessionForm(false);
      await refreshDetail();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not schedule that session.');
    } finally {
      setSaving(false);
    }
  };

  const handleCancelSession = async (session) => {
    if (!window.confirm(`Cancel "${session.title}"?`)) return;

    setError('');
    try {
      await api.patch(`/clubs/${detail.club._id}/sessions/${session._id}/cancel`, {});
      flash('Session cancelled.');
      await refreshDetail();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not cancel that session.');
    }
  };

  /** Opens the attendance grid, defaulting everyone to present. */
  const startAttendance = (session) => {
    const draft = {};
    activeMembers.forEach((member) => {
      const existing = (session.attendees || []).find(
        (a) => String(a.student) === String(member.student?._id || member.student)
      );
      draft[String(member.student?._id || member.student)] = existing ? existing.present : true;
    });
    setAttendanceDraft({ sessionId: session._id, marks: draft });
  };

  const submitAttendance = async () => {
    setError('');
    setSaving(true);
    try {
      const attendance = Object.entries(attendanceDraft.marks).map(([studentId, present]) => ({
        studentId,
        present,
      }));

      await api.post(
        `/clubs/${detail.club._id}/sessions/${attendanceDraft.sessionId}/attendance`,
        { attendance }
      );
      flash('Attendance recorded.');
      setAttendanceDraft(null);
      await refreshDetail();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not record attendance.');
    } finally {
      setSaving(false);
    }
  };

  const activeMembers = useMemo(
    () => (detail?.members || []).filter((m) => m.status === 'active'),
    [detail]
  );

  const pendingMembers = useMemo(
    () => (detail?.members || []).filter((m) => m.status === 'pending'),
    [detail]
  );

  if (loading) {
    return (
      <div className="bg-white rounded-2xl shadow p-10 flex justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-t-4 border-b-4 border-teal-500" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Clubs', value: stats.totalClubs },
            { label: 'Members', value: stats.activeMemberships },
            { label: 'Pending', value: stats.pendingRequests },
            { label: 'Full', value: stats.fullClubs },
          ].map((tile) => (
            <div key={tile.label} className="bg-white rounded-xl shadow p-4 text-center">
              <div className="text-xl font-bold text-gray-800">{tile.value}</div>
              <div className="text-xs text-gray-500 mt-1">{tile.label}</div>
            </div>
          ))}
        </div>
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

      <div className="flex items-center justify-between">
        <h3 className="font-bold text-gray-800 flex items-center gap-2">
          <Sparkles size={18} className="text-teal-500" /> Clubs
        </h3>
        <button
          onClick={() => {
            setForm(EMPTY_CLUB);
            setEditingId(null);
            setShowForm(!showForm);
            setError('');
          }}
          className="text-sm bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition flex items-center gap-1.5"
        >
          {showForm ? <X size={15} /> : <Plus size={15} />}
          {showForm ? 'Close' : 'New club'}
        </button>
      </div>

      {/* ---- Club form ---- */}
      {showForm && (
        <form onSubmit={handleSaveClub} className="bg-white rounded-2xl shadow p-6 space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Robotics Club"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
              <select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              >
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Description</label>
            <textarea
              rows="3"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Meeting day</label>
              <input
                value={form.meetingDay}
                onChange={(e) => setForm({ ...form, meetingDay: e.target.value })}
                placeholder="Friday"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Time</label>
              <input
                type="time"
                value={form.meetingTime}
                onChange={(e) => setForm({ ...form, meetingTime: e.target.value })}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Venue</label>
              <input
                value={form.venue}
                onChange={(e) => setForm({ ...form, venue: e.target.value })}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Capacity</label>
              <input
                type="number"
                min="1"
                value={form.capacity}
                onChange={(e) => setForm({ ...form, capacity: e.target.value })}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Eligible classes (comma separated, blank = everyone)
              </label>
              <input
                value={form.eligibleClasses}
                onChange={(e) => setForm({ ...form, eligibleClasses: e.target.value })}
                placeholder="9-A, 9-B, 10-A"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm text-gray-700 pb-2">
                <input
                  type="checkbox"
                  checked={form.requiresApproval}
                  onChange={(e) => setForm({ ...form, requiresApproval: e.target.checked })}
                />
                Requests need my approval
              </label>
            </div>
          </div>

          <button
            type="submit"
            disabled={saving}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm px-5 py-2.5 rounded-lg transition"
          >
            {saving ? 'Saving…' : editingId ? 'Update club' : 'Create club'}
          </button>
        </form>
      )}

      {/* ---- Club list ---- */}
      <div className="grid gap-3 sm:grid-cols-2">
        {clubs.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-10 bg-white rounded-2xl shadow sm:col-span-2">
            No clubs yet.
          </p>
        )}

        {clubs.map((club) => (
          <div key={club._id} className="bg-white rounded-2xl shadow p-5">
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="min-w-0">
                <p className="font-bold text-gray-800 truncate">{club.name}</p>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  {club.category} · {club.memberCount}/{club.capacity} members
                  {club.requiresApproval && ' · approval required'}
                </p>
              </div>
              <span
                className={`text-[11px] px-2 py-0.5 rounded-full shrink-0 ${
                  STATUS_TONES[club.status] || 'bg-gray-100 text-gray-600'
                }`}
              >
                {club.status}
              </span>
            </div>

            <div className="flex flex-wrap gap-2 mt-3">
              <button
                onClick={() => openDetail(club)}
                className="text-xs bg-teal-600 hover:bg-teal-700 text-white px-3 py-1.5 rounded-lg transition flex items-center gap-1"
              >
                <Users size={12} /> Manage
              </button>
              <button
                onClick={() => startEdit(club)}
                className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg transition"
              >
                Edit
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* ---- Club detail dialog ---- */}
      {detail && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h4 className="font-bold text-gray-800 text-lg">{detail.club.name}</h4>
                <p className="text-xs text-gray-500 mt-0.5">
                  {detail.club.memberCount}/{detail.club.capacity} members ·{' '}
                  {detail.club.meetingDay || 'no fixed day'}
                </p>
              </div>
              <button onClick={() => setDetail(null)}>
                <X size={18} className="text-gray-400 hover:text-gray-700" />
              </button>
            </div>

            {/* Pending requests */}
            {pendingMembers.length > 0 && (
              <div className="mb-5">
                <h5 className="text-sm font-semibold text-gray-700 mb-2">
                  Pending requests ({pendingMembers.length})
                </h5>
                <ul className="space-y-2">
                  {pendingMembers.map((member) => (
                    <li
                      key={member._id}
                      className="flex flex-wrap items-center justify-between gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-800">
                          {member.studentName || member.student?.name}
                        </p>
                        {member.motivation && (
                          <p className="text-[11px] text-gray-600 mt-0.5">{member.motivation}</p>
                        )}
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          onClick={() => handleDecision(member, 'approve')}
                          className="text-[11px] bg-green-600 hover:bg-green-700 text-white px-3 py-1 rounded-lg"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => handleDecision(member, 'reject')}
                          className="text-[11px] bg-gray-200 hover:bg-gray-300 text-gray-700 px-3 py-1 rounded-lg"
                        >
                          Reject
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Sessions */}
            <div className="mb-5">
              <div className="flex items-center justify-between mb-2">
                <h5 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
                  <CalendarDays size={14} /> Sessions
                </h5>
                <button
                  onClick={() => {
                    setShowSessionForm(!showSessionForm);
                    setSessionForm({
                      ...EMPTY_SESSION,
                      scheduledFor: toLocalInputValue(new Date(Date.now() + 24 * 60 * 60 * 1000)),
                      venue: detail.club.venue || '',
                    });
                  }}
                  className="text-xs text-blue-600 hover:underline flex items-center gap-1"
                >
                  <Plus size={12} /> Schedule
                </button>
              </div>

              {showSessionForm && (
                <form
                  onSubmit={handleScheduleSession}
                  className="bg-gray-50 rounded-xl p-4 space-y-3 mb-3"
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <input
                      value={sessionForm.title}
                      onChange={(e) => setSessionForm({ ...sessionForm, title: e.target.value })}
                      placeholder="Session title"
                      className="px-3 py-2 border border-gray-200 rounded-lg text-sm"
                    />
                    <input
                      type="datetime-local"
                      value={sessionForm.scheduledFor}
                      onChange={(e) =>
                        setSessionForm({ ...sessionForm, scheduledFor: e.target.value })
                      }
                      className="px-3 py-2 border border-gray-200 rounded-lg text-sm"
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <input
                      value={sessionForm.venue}
                      onChange={(e) => setSessionForm({ ...sessionForm, venue: e.target.value })}
                      placeholder="Venue"
                      className="px-3 py-2 border border-gray-200 rounded-lg text-sm"
                    />
                    <input
                      type="number"
                      min="10"
                      value={sessionForm.durationMinutes}
                      onChange={(e) =>
                        setSessionForm({ ...sessionForm, durationMinutes: e.target.value })
                      }
                      placeholder="Minutes"
                      className="px-3 py-2 border border-gray-200 rounded-lg text-sm"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={saving}
                    className="text-xs bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white px-4 py-2 rounded-lg"
                  >
                    {saving ? 'Saving…' : 'Schedule session'}
                  </button>
                </form>
              )}

              {(detail.club.sessions || []).length === 0 ? (
                <p className="text-xs text-gray-400">No sessions yet.</p>
              ) : (
                <ul className="space-y-2">
                  {[...detail.club.sessions]
                    .sort((a, b) => new Date(b.scheduledFor) - new Date(a.scheduledFor))
                    .map((session) => (
                      <li
                        key={session._id}
                        className="border border-gray-100 rounded-xl px-4 py-2.5"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="text-sm font-medium text-gray-800">
                              {session.title}
                              <span
                                className={`ml-2 text-[10px] px-2 py-0.5 rounded-full ${
                                  session.status === 'held'
                                    ? 'bg-green-100 text-green-700'
                                    : session.status === 'cancelled'
                                    ? 'bg-gray-200 text-gray-500'
                                    : 'bg-blue-100 text-blue-700'
                                }`}
                              >
                                {session.status}
                              </span>
                            </p>
                            <p className="text-[11px] text-gray-500 mt-0.5">
                              {formatDateTime(session.scheduledFor)}
                              {session.venue && ` · ${session.venue}`}
                              {session.attendees?.length > 0 &&
                                ` · ${session.attendees.filter((a) => a.present).length}/${
                                  session.attendees.length
                                } present`}
                            </p>
                          </div>

                          <div className="flex gap-2 shrink-0">
                            {session.status !== 'cancelled' && (
                              <button
                                onClick={() => startAttendance(session)}
                                className="text-[11px] text-teal-700 hover:underline flex items-center gap-1"
                              >
                                <ClipboardCheck size={11} /> Attendance
                              </button>
                            )}
                            {session.status === 'scheduled' && (
                              <button
                                onClick={() => handleCancelSession(session)}
                                className="text-[11px] text-red-600 hover:underline"
                              >
                                Cancel
                              </button>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                </ul>
              )}
            </div>

            {/* Attendance grid */}
            {attendanceDraft && (
              <div className="mb-5 border border-teal-200 bg-teal-50 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <h5 className="text-sm font-semibold text-teal-900">Mark attendance</h5>
                  <button onClick={() => setAttendanceDraft(null)}>
                    <X size={15} className="text-teal-700" />
                  </button>
                </div>

                {activeMembers.length === 0 ? (
                  <p className="text-xs text-teal-800">This club has no active members yet.</p>
                ) : (
                  <>
                    <div className="grid gap-2 sm:grid-cols-2 max-h-56 overflow-y-auto">
                      {activeMembers.map((member) => {
                        const id = String(member.student?._id || member.student);
                        const present = attendanceDraft.marks[id];

                        return (
                          <button
                            key={member._id}
                            onClick={() =>
                              setAttendanceDraft((prev) => ({
                                ...prev,
                                marks: { ...prev.marks, [id]: !prev.marks[id] },
                              }))
                            }
                            className={`text-left text-xs px-3 py-2 rounded-lg border transition ${
                              present
                                ? 'bg-green-100 border-green-300 text-green-800'
                                : 'bg-white border-gray-200 text-gray-500'
                            }`}
                          >
                            {present ? '✓' : '✗'}{' '}
                            {member.studentName || member.student?.name}
                            {member.className && (
                              <span className="text-[10px] opacity-70"> · {member.className}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>

                    <button
                      onClick={submitAttendance}
                      disabled={saving}
                      className="mt-3 text-xs bg-teal-600 hover:bg-teal-700 disabled:opacity-60 text-white px-4 py-2 rounded-lg"
                    >
                      {saving ? 'Saving…' : 'Save attendance'}
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Roster */}
            <div>
              <h5 className="text-sm font-semibold text-gray-700 mb-2">
                Members ({activeMembers.length})
              </h5>
              {activeMembers.length === 0 ? (
                <p className="text-xs text-gray-400">Nobody has joined yet.</p>
              ) : (
                <ul className="divide-y divide-gray-100 max-h-64 overflow-y-auto">
                  {activeMembers.map((member) => (
                    <li key={member._id} className="py-2 flex items-center justify-between">
                      <div>
                        <p className="text-sm text-gray-800">
                          {member.studentName || member.student?.name}
                          {member.role !== 'member' && (
                            <span className="ml-2 text-[10px] bg-teal-100 text-teal-800 px-2 py-0.5 rounded-full">
                              {member.role}
                            </span>
                          )}
                        </p>
                        <p className="text-[11px] text-gray-400">
                          {member.className || '—'}
                          {member.attendanceRate !== null &&
                            ` · ${member.attendanceRate}% attendance`}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {(detail.club.achievements || []).length > 0 && (
              <div className="mt-5">
                <h5 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1.5">
                  <Trophy size={14} className="text-amber-500" /> Achievements
                </h5>
                <ul className="space-y-1.5">
                  {detail.club.achievements.map((item) => (
                    <li key={item._id} className="text-xs text-gray-600">
                      <strong>{item.title}</strong>
                      {item.description && ` — ${item.description}`}
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

export default ClubPanel;
