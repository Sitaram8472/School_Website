import { useState, useEffect, useCallback } from 'react';
import api from '../../utils/axios';

/**
 * Teacher-side view of parent-teacher meeting slots.
 *
 * Publishing a run of back-to-back slots is the common case — a PTM afternoon
 * is fifteen twenty-minute windows — so the form takes a duration and a repeat
 * count and the server lays them out.
 */

const PURPOSES = [
  { value: 'ptm', label: 'Parent-teacher meeting' },
  { value: 'academic-concern', label: 'Academic concern' },
  { value: 'counselling', label: 'Counselling' },
  { value: 'admission', label: 'Admission' },
  { value: 'general', label: 'General' },
];

const SLOT_STATUS_STYLES = {
  open: 'bg-teal-100 text-teal-700',
  full: 'bg-blue-100 text-blue-700',
  closed: 'bg-gray-200 text-gray-600',
  cancelled: 'bg-red-100 text-red-700',
  completed: 'bg-green-100 text-green-700',
};

const defaultForm = {
  title: 'Term meeting',
  purpose: 'ptm',
  mode: 'in-person',
  location: '',
  date: '',
  startTime: '16:00',
  endTime: '16:20',
  capacity: 1,
  repeat: 1,
  notesForParents: '',
};

const formatDate = (value) => {
  if (!value) return '';
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
};

const MeetingPanel = () => {
  const [slots, setSlots] = useState([]);
  const [stats, setStats] = useState(null);
  const [form, setForm] = useState(defaultForm);
  const [expanded, setExpanded] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 4000);
  };

  const loadSlots = useCallback(async () => {
    try {
      const params = statusFilter ? { status: statusFilter } : {};
      const res = await api.get('/meetings/slots/mine', { params });
      setSlots(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load your slots.');
    }
  }, [statusFilter]);

  const loadStats = useCallback(async () => {
    try {
      const res = await api.get('/meetings/stats');
      setStats(res.data.stats);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => { loadSlots(); }, [loadSlots]);
  useEffect(() => { loadStats(); }, [loadStats]);

  const publish = async (event) => {
    event.preventDefault();
    setError('');

    if (!form.date || !form.location.trim()) {
      setError('Date and location are required.');
      return;
    }

    setLoading(true);
    try {
      const res = await api.post('/meetings/slots', {
        ...form,
        capacity: Number(form.capacity),
        repeat: Number(form.repeat),
      });
      flash(res.data.message);
      setForm({ ...defaultForm, date: form.date, location: form.location });
      await Promise.all([loadSlots(), loadStats()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not publish those slots.');
    } finally {
      setLoading(false);
    }
  };

  const cancelSlot = async (slot) => {
    const reason = window.prompt(
      'Why is this slot being cancelled? Families who booked will see this.'
    );
    if (!reason) return;

    try {
      await api.patch(`/meetings/slots/${slot._id}/cancel`, { reason });
      flash('Slot cancelled and the families released.');
      await Promise.all([loadSlots(), loadStats()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not cancel that slot.');
    }
  };

  const deleteSlot = async (slot) => {
    try {
      await api.delete(`/meetings/slots/${slot._id}`);
      flash('Slot deleted.');
      await Promise.all([loadSlots(), loadStats()]);
    } catch (err) {
      // The server refuses to delete a slot with live bookings; surface that
      // rather than swallowing it, because the alternative action (cancel with
      // a reason) is the one the teacher actually wants.
      setError(err.response?.data?.message || 'Could not delete that slot.');
    }
  };

  const toggleClosed = async (slot) => {
    try {
      await api.patch(`/meetings/slots/${slot._id}`, {
        closed: slot.status !== 'closed',
      });
      await loadSlots();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not update that slot.');
    }
  };

  const markAttendance = async (slot, booking, status) => {
    try {
      await api.patch(
        `/meetings/slots/${slot._id}/bookings/${booking._id}/attendance`,
        { status }
      );
      flash(`Marked as ${status}.`);
      await Promise.all([loadSlots(), loadStats()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not record attendance.');
    }
  };

  const recordOutcome = async (slot, booking) => {
    const outcomeNote = window.prompt(
      'What was agreed? The family can read this.',
      booking.outcomeNote || ''
    );
    if (!outcomeNote) return;

    try {
      await api.patch(
        `/meetings/slots/${slot._id}/bookings/${booking._id}/outcome`,
        { outcomeNote }
      );
      flash('Outcome recorded.');
      await loadSlots();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not record the outcome.');
    }
  };

  const cancelBooking = async (slot, booking) => {
    const reason = window.prompt('Why is this booking being cancelled?');
    if (!reason) return;

    try {
      await api.patch(
        `/meetings/slots/${slot._id}/bookings/${booking._id}/cancel`,
        { reason }
      );
      flash('Booking cancelled and the seat released.');
      await Promise.all([loadSlots(), loadStats()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not cancel that booking.');
    }
  };

  return (
    <div className="space-y-6">

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Slots', value: stats.totalSlots },
            { label: 'Seats booked', value: `${stats.seatsBooked}/${stats.seatsOffered}` },
            { label: 'Utilisation', value: `${stats.utilisation}%` },
            {
              label: 'Attendance',
              value: stats.attendanceRate === null ? '—' : `${stats.attendanceRate}%`,
            },
          ].map((entry) => (
            <div key={entry.label} className="bg-white rounded-xl shadow p-4 text-center">
              <div className="text-xl font-bold text-gray-800">{entry.value}</div>
              <div className="text-xs text-gray-400 mt-1">{entry.label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="bg-white rounded-2xl shadow p-6">
        <h3 className="text-xl font-bold text-gray-800 mb-1">📅 Publish meeting slots</h3>
        <p className="text-sm text-gray-500 mb-4">
          Set one window and a repeat count to lay out a whole afternoon of
          back-to-back slots.
        </p>

        <form onSubmit={publish} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="text"
              required
              placeholder="Title (e.g. Term 1 PTM) *"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
            <select
              value={form.purpose}
              onChange={(e) => setForm({ ...form, purpose: e.target.value })}
              className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
            >
              {PURPOSES.map((purpose) => (
                <option key={purpose.value} value={purpose.value}>{purpose.label}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <select
              value={form.mode}
              onChange={(e) => setForm({ ...form, mode: e.target.value })}
              className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
            >
              <option value="in-person">In person</option>
              <option value="online">Online</option>
            </select>
            <input
              type="text"
              required
              placeholder={form.mode === 'online' ? 'Meeting link *' : 'Room *'}
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <input
              type="date"
              required
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
            <input
              type="time"
              required
              value={form.startTime}
              onChange={(e) => setForm({ ...form, startTime: e.target.value })}
              className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
            <input
              type="time"
              required
              value={form.endTime}
              onChange={(e) => setForm({ ...form, endTime: e.target.value })}
              className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-gray-500">
              Seats per slot
              <input
                type="number"
                min={1}
                max={20}
                value={form.capacity}
                onChange={(e) => setForm({ ...form, capacity: e.target.value })}
                className="mt-1 w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </label>
            <label className="text-xs text-gray-500">
              Repeat back-to-back
              <input
                type="number"
                min={1}
                max={30}
                value={form.repeat}
                onChange={(e) => setForm({ ...form, repeat: e.target.value })}
                className="mt-1 w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </label>
          </div>

          <textarea
            rows={2}
            placeholder="Anything families should know before booking (optional)"
            value={form.notesForParents}
            onChange={(e) => setForm({ ...form, notesForParents: e.target.value })}
            className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
          />

          {error && <p className="text-red-600 text-sm">{error}</p>}
          {success && <p className="text-green-600 text-sm">{success}</p>}

          <button
            type="submit"
            disabled={loading}
            className="bg-teal-600 hover:bg-teal-700 text-white px-5 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
          >
            {loading ? 'Publishing...' : 'Publish'}
          </button>
        </form>
      </div>

      <div className="bg-white rounded-2xl shadow p-6">
        <div className="flex items-center justify-between mb-4 gap-3">
          <h3 className="text-xl font-bold text-gray-800">Your slots</h3>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
          >
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="full">Full</option>
            <option value="closed">Closed</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>

        {slots.length === 0 && (
          <p className="text-gray-400 text-sm text-center py-6">
            You have not published any meeting slots yet.
          </p>
        )}

        <div className="space-y-3">
          {slots.map((slot) => {
            const live = (slot.bookings || []).filter((b) =>
              ['booked', 'attended', 'no-show'].includes(b.status)
            );
            const isOpen = expanded === slot._id;

            return (
              <div key={slot._id} className="border border-gray-200 rounded-xl overflow-hidden">
                <button
                  onClick={() => setExpanded(isOpen ? null : slot._id)}
                  className="w-full text-left px-4 py-3 hover:bg-gray-50 transition"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-sm font-semibold text-gray-800">
                          {slot.startTime}-{slot.endTime}
                        </span>
                        <span className="text-sm text-gray-500">{formatDate(slot.date)}</span>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            SLOT_STATUS_STYLES[slot.status] || 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {slot.status}
                        </span>
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {slot.title} &middot; {slot.location}
                      </p>
                    </div>
                    <span className="text-sm font-semibold text-gray-700 shrink-0">
                      {slot.bookedCount}/{slot.capacity} booked
                    </span>
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-gray-200 px-4 py-3 bg-gray-50">
                    {live.length === 0 ? (
                      <p className="text-sm text-gray-400">Nobody has booked this slot yet.</p>
                    ) : (
                      <div className="space-y-3">
                        {live.map((booking) => (
                          <div key={booking._id} className="bg-white rounded-lg p-3 shadow-sm">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-sm font-semibold text-gray-800">
                                  {booking.guardianName}
                                  <span className="text-gray-400 font-normal">
                                    {' '}for {booking.studentName}
                                    {booking.className ? ` (${booking.className})` : ''}
                                  </span>
                                </p>
                                <p className="font-mono text-xs text-gray-400">
                                  {booking.reference}
                                  {booking.contactNumber ? ` · ${booking.contactNumber}` : ''}
                                </p>
                                <p className="text-sm text-gray-600 mt-1">{booking.agenda}</p>
                                {booking.outcomeNote && (
                                  <p className="text-sm text-green-700 mt-1">
                                    Outcome: {booking.outcomeNote}
                                  </p>
                                )}
                              </div>
                              <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full shrink-0">
                                {booking.status}
                              </span>
                            </div>

                            <div className="flex flex-wrap gap-2 mt-3">
                              {booking.status === 'booked' && (
                                <>
                                  <button
                                    onClick={() => markAttendance(slot, booking, 'attended')}
                                    className="text-xs bg-green-100 text-green-700 hover:bg-green-200 px-3 py-1 rounded-full transition"
                                  >
                                    Attended
                                  </button>
                                  <button
                                    onClick={() => markAttendance(slot, booking, 'no-show')}
                                    className="text-xs bg-amber-100 text-amber-700 hover:bg-amber-200 px-3 py-1 rounded-full transition"
                                  >
                                    No-show
                                  </button>
                                  <button
                                    onClick={() => cancelBooking(slot, booking)}
                                    className="text-xs bg-red-100 text-red-700 hover:bg-red-200 px-3 py-1 rounded-full transition"
                                  >
                                    Cancel booking
                                  </button>
                                </>
                              )}
                              {['attended', 'no-show'].includes(booking.status) && (
                                <button
                                  onClick={() => recordOutcome(slot, booking)}
                                  className="text-xs bg-blue-100 text-blue-700 hover:bg-blue-200 px-3 py-1 rounded-full transition"
                                >
                                  {booking.outcomeNote ? 'Edit outcome' : 'Record outcome'}
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {!['cancelled', 'completed'].includes(slot.status) && (
                      <div className="flex flex-wrap gap-2 mt-4 pt-3 border-t border-gray-200">
                        <button
                          onClick={() => toggleClosed(slot)}
                          className="text-xs border border-gray-300 text-gray-600 hover:bg-white px-3 py-1 rounded-full transition"
                        >
                          {slot.status === 'closed' ? 'Reopen booking' : 'Close booking'}
                        </button>
                        <button
                          onClick={() => cancelSlot(slot)}
                          className="text-xs border border-red-200 text-red-600 hover:bg-red-50 px-3 py-1 rounded-full transition"
                        >
                          Cancel slot
                        </button>
                        {slot.bookedCount === 0 && (
                          <button
                            onClick={() => deleteSlot(slot)}
                            className="text-xs border border-gray-300 text-gray-500 hover:bg-white px-3 py-1 rounded-full transition"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    )}

                    {slot.cancelReason && (
                      <p className="text-sm text-red-600 mt-3">
                        Cancelled: {slot.cancelReason}
                      </p>
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

export default MeetingPanel;
