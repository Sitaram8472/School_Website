import { useState, useEffect, useContext, useCallback } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';

/**
 * Parent-teacher meeting booking.
 *
 * Two halves: the slots you can still book, and the bookings you already hold.
 * Seat counts come from the server on every refresh rather than being adjusted
 * locally after a booking — the seat you think is free and the seat the
 * database thinks is free are allowed to disagree, and the server wins.
 */

const PURPOSE_LABELS = {
  ptm: 'Parent-teacher meeting',
  'academic-concern': 'Academic concern',
  counselling: 'Counselling',
  admission: 'Admission',
  general: 'General',
};

const BOOKING_STATUS_STYLES = {
  booked: 'bg-blue-100 text-blue-700',
  attended: 'bg-green-100 text-green-700',
  'no-show': 'bg-amber-100 text-amber-700',
  'cancelled-by-parent': 'bg-gray-200 text-gray-600',
  'cancelled-by-teacher': 'bg-red-100 text-red-700',
};

const BOOKING_STATUS_LABELS = {
  booked: 'Booked',
  attended: 'Attended',
  'no-show': 'Not attended',
  'cancelled-by-parent': 'Cancelled by you',
  'cancelled-by-teacher': 'Cancelled by teacher',
};

const emptyForm = {
  guardianName: '',
  studentName: '',
  className: '',
  contactNumber: '',
  agenda: '',
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

const MeetingBooking = () => {
  const { user } = useContext(AuthContext);

  const [slots, setSlots] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('browse');

  const [dateFilter, setDateFilter] = useState('');
  const [purposeFilter, setPurposeFilter] = useState('');
  const [availableOnly, setAvailableOnly] = useState(true);

  const [selectedSlot, setSelectedSlot] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const flash = useCallback((message) => {
    setNotice(message);
    setTimeout(() => setNotice(''), 4000);
  }, []);

  const loadSlots = useCallback(async () => {
    try {
      const params = {};
      if (dateFilter) params.date = dateFilter;
      if (purposeFilter) params.purpose = purposeFilter;
      if (availableOnly) params.availableOnly = 'true';

      const res = await api.get('/meetings/slots', { params });
      setSlots(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load meeting slots.');
    }
  }, [dateFilter, purposeFilter, availableOnly]);

  const loadBookings = useCallback(async () => {
    try {
      const res = await api.get('/meetings/my-bookings');
      setBookings(res.data.data || []);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await Promise.all([loadSlots(), loadBookings()]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadSlots, loadBookings]);

  const openBookingForm = (slot) => {
    setSelectedSlot(slot);
    setForm({
      ...emptyForm,
      // A sensible default the family can correct — most bookings are made by
      // the account holder for their own child.
      guardianName: user?.name || '',
    });
    setError('');
  };

  const submitBooking = async (event) => {
    event.preventDefault();
    if (!selectedSlot) return;

    if (form.agenda.trim().length < 10) {
      setError('Please describe what you would like to discuss (at least 10 characters).');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const res = await api.post(`/meetings/slots/${selectedSlot._id}/book`, form);
      flash(`Booked. Your reference is ${res.data.reference}.`);
      setSelectedSlot(null);
      setForm(emptyForm);
      await Promise.all([loadSlots(), loadBookings()]);
      setTab('mine');
    } catch (err) {
      // A 409 here is the interesting case: somebody else took the last seat
      // between the page rendering and this request. Reload so the list stops
      // showing a seat that is gone.
      setError(err.response?.data?.message || 'Could not book that slot.');
      if (err.response?.status === 409) await loadSlots();
    } finally {
      setSubmitting(false);
    }
  };

  const cancelBooking = async (booking) => {
    setError('');
    try {
      await api.patch(`/meetings/slots/${booking.slotId}/bookings/${booking._id}/cancel`);
      flash('Booking cancelled. The seat is back in the pool.');
      await Promise.all([loadSlots(), loadBookings()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not cancel that booking.');
    }
  };

  const byDate = slots.reduce((groups, slot) => {
    (groups[slot.date] = groups[slot.date] || []).push(slot);
    return groups;
  }, {});

  const activeBookings = bookings.filter((b) => b.status === 'booked');

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="max-w-5xl mx-auto px-4 py-8">

        <div className="bg-gradient-to-r from-teal-600 to-cyan-700 rounded-2xl p-6 mb-6 text-white">
          <h1 className="text-2xl font-bold">Parent-Teacher Meetings</h1>
          <p className="text-teal-50 mt-1 text-sm">
            Book a time with a teacher. Seats are limited and released the moment
            somebody cancels.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-5">
            <div className="bg-white/15 rounded-xl p-4 text-center">
              <div className="text-2xl font-bold">{slots.length}</div>
              <div className="text-xs text-teal-50 mt-1">Slots listed</div>
            </div>
            <div className="bg-white/15 rounded-xl p-4 text-center">
              <div className="text-2xl font-bold">{activeBookings.length}</div>
              <div className="text-xs text-teal-50 mt-1">Your bookings</div>
            </div>
            <div className="bg-white/15 rounded-xl p-4 text-center col-span-2 sm:col-span-1">
              <div className="text-2xl font-bold">
                {slots.reduce((sum, slot) => sum + (slot.seatsLeft || 0), 0)}
              </div>
              <div className="text-xs text-teal-50 mt-1">Seats free</div>
            </div>
          </div>
        </div>

        <div className="flex gap-2 mb-6 bg-white rounded-xl p-1 shadow">
          {[
            { id: 'browse', label: 'Available slots' },
            { id: 'mine', label: `My bookings (${activeBookings.length})` },
          ].map((entry) => (
            <button
              key={entry.id}
              onClick={() => setTab(entry.id)}
              className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition ${
                tab === entry.id
                  ? 'bg-teal-600 text-white shadow'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {notice && (
          <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-xl px-4 py-3 mb-4">
            {notice}
          </div>
        )}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3 mb-4">
            {error}
          </div>
        )}

        {loading && (
          <div className="bg-white rounded-2xl shadow p-8 text-center text-gray-400 text-sm">
            Loading meeting slots...
          </div>
        )}

        {!loading && tab === 'browse' && (
          <>
            <div className="bg-white rounded-2xl shadow p-4 mb-6">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <input
                  type="date"
                  value={dateFilter}
                  onChange={(e) => setDateFilter(e.target.value)}
                  className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
                <select
                  value={purposeFilter}
                  onChange={(e) => setPurposeFilter(e.target.value)}
                  className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                >
                  <option value="">All purposes</option>
                  {Object.entries(PURPOSE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                <label className="flex items-center gap-2 text-sm text-gray-600 px-1">
                  <input
                    type="checkbox"
                    checked={availableOnly}
                    onChange={(e) => setAvailableOnly(e.target.checked)}
                    className="rounded"
                  />
                  Only slots with seats
                </label>
              </div>
            </div>

            {Object.keys(byDate).length === 0 && (
              <div className="bg-white rounded-2xl shadow p-8 text-center">
                <p className="text-gray-500 text-sm">
                  No meeting slots match those filters.
                </p>
                <p className="text-gray-400 text-xs mt-1">
                  Teachers publish slots ahead of each meeting round.
                </p>
              </div>
            )}

            {Object.entries(byDate).map(([date, daySlots]) => (
              <div key={date} className="mb-6">
                <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                  {formatDate(date)}
                </h2>
                <div className="space-y-3">
                  {daySlots.map((slot) => {
                    const mine = (slot.bookings || []).find((b) => b.status === 'booked');
                    const blocked = slot.unavailableReason;
                    return (
                      <div
                        key={slot._id}
                        className={`bg-white rounded-2xl shadow p-5 border-l-4 ${
                          mine
                            ? 'border-blue-500'
                            : blocked
                              ? 'border-gray-300'
                              : 'border-teal-500'
                        }`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono text-sm font-semibold text-gray-800">
                                {slot.startTime} - {slot.endTime}
                              </span>
                              <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                                {PURPOSE_LABELS[slot.purpose] || slot.purpose}
                              </span>
                              {slot.mode === 'online' && (
                                <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">
                                  Online
                                </span>
                              )}
                            </div>
                            <h3 className="font-semibold text-gray-800 mt-1">{slot.title}</h3>
                            <p className="text-sm text-gray-500">
                              {slot.teacherName || 'Teacher'} &middot; {slot.location}
                            </p>
                            {slot.notesForParents && (
                              <p className="text-xs text-gray-400 mt-1">{slot.notesForParents}</p>
                            )}
                          </div>

                          <div className="text-right shrink-0">
                            <div
                              className={`text-sm font-semibold ${
                                slot.seatsLeft > 0 ? 'text-teal-600' : 'text-gray-400'
                              }`}
                            >
                              {slot.seatsLeft} of {slot.capacity} free
                            </div>
                            {mine ? (
                              <span className="inline-block mt-2 text-xs bg-blue-100 text-blue-700 px-3 py-1 rounded-full">
                                Booked &middot; {mine.reference}
                              </span>
                            ) : blocked ? (
                              <p className="text-xs text-gray-400 mt-2 max-w-[12rem]">{blocked}</p>
                            ) : (
                              <button
                                onClick={() => openBookingForm(slot)}
                                className="mt-2 bg-teal-600 hover:bg-teal-700 text-white text-sm px-4 py-1.5 rounded-lg transition"
                              >
                                Book
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </>
        )}

        {!loading && tab === 'mine' && (
          <div className="space-y-3">
            {bookings.length === 0 && (
              <div className="bg-white rounded-2xl shadow p-8 text-center text-gray-500 text-sm">
                You have not booked any meetings yet.
              </div>
            )}
            {bookings.map((booking) => (
              <div key={booking._id} className="bg-white rounded-2xl shadow p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs text-gray-400">{booking.reference}</span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          BOOKING_STATUS_STYLES[booking.status] || 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {BOOKING_STATUS_LABELS[booking.status] || booking.status}
                      </span>
                    </div>
                    <h3 className="font-semibold text-gray-800 mt-1">{booking.title}</h3>
                    <p className="text-sm text-gray-500">
                      {booking.teacherName} &middot; {formatDate(booking.date)}, {booking.startTime}
                      {' '}&middot; {booking.location}
                    </p>
                    <p className="text-sm text-gray-600 mt-2">
                      <span className="text-gray-400">For:</span> {booking.studentName}
                      {booking.className ? ` (${booking.className})` : ''}
                    </p>
                    <p className="text-sm text-gray-600 mt-1">
                      <span className="text-gray-400">Agenda:</span> {booking.agenda}
                    </p>
                    {booking.cancelReason && (
                      <p className="text-sm text-red-600 mt-2">
                        Reason: {booking.cancelReason}
                      </p>
                    )}
                    {booking.outcomeNote && (
                      <div className="mt-3 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                        <p className="text-xs font-semibold text-green-700 mb-1">
                          Outcome recorded by the teacher
                        </p>
                        <p className="text-sm text-green-800">{booking.outcomeNote}</p>
                      </div>
                    )}
                  </div>

                  {booking.status === 'booked' && (
                    <div className="shrink-0 text-right">
                      {booking.canCancel ? (
                        <button
                          onClick={() => cancelBooking(booking)}
                          className="text-sm text-red-600 hover:text-red-700 border border-red-200 hover:bg-red-50 px-4 py-1.5 rounded-lg transition"
                        >
                          Cancel
                        </button>
                      ) : (
                        <p className="text-xs text-gray-400 max-w-[12rem]">
                          Too close to the meeting to cancel here — please contact
                          the teacher.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {selectedSlot && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
              <div className="p-6">
                <h3 className="text-lg font-bold text-gray-800">Book this slot</h3>
                <p className="text-sm text-gray-500 mt-1">
                  {selectedSlot.teacherName} &middot; {formatDate(selectedSlot.date)},{' '}
                  {selectedSlot.startTime}-{selectedSlot.endTime} &middot; {selectedSlot.location}
                </p>

                <form onSubmit={submitBooking} className="mt-5 space-y-3">
                  <input
                    type="text"
                    required
                    placeholder="Name of the parent or guardian attending *"
                    value={form.guardianName}
                    onChange={(e) => setForm({ ...form, guardianName: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                  />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <input
                      type="text"
                      required
                      placeholder="Student name *"
                      value={form.studentName}
                      onChange={(e) => setForm({ ...form, studentName: e.target.value })}
                      className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                    />
                    <input
                      type="text"
                      placeholder="Class (e.g. 10A)"
                      value={form.className}
                      onChange={(e) => setForm({ ...form, className: e.target.value })}
                      className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                    />
                  </div>
                  <input
                    type="tel"
                    placeholder="Contact number (optional)"
                    value={form.contactNumber}
                    onChange={(e) => setForm({ ...form, contactNumber: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                  />
                  <div>
                    <textarea
                      required
                      rows={4}
                      placeholder="What would you like to discuss? *"
                      value={form.agenda}
                      onChange={(e) => setForm({ ...form, agenda: e.target.value })}
                      className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                    />
                    <p className="text-xs text-gray-400 mt-1">
                      {form.agenda.length}/500 &middot; A sentence is enough. It lets
                      the teacher come prepared.
                    </p>
                  </div>

                  {error && <p className="text-red-600 text-sm">{error}</p>}

                  <div className="flex gap-2 pt-2">
                    <button
                      type="submit"
                      disabled={submitting}
                      className="flex-1 bg-teal-600 hover:bg-teal-700 text-white text-sm py-2 rounded-lg transition disabled:opacity-50"
                    >
                      {submitting ? 'Booking...' : 'Confirm booking'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setSelectedSlot(null); setError(''); }}
                      className="px-5 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-lg transition"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default MeetingBooking;
