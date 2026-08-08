import { useState, useEffect, useContext, useCallback, useMemo } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * Facility and room booking.
 *
 * The availability view is the reason anybody opens this page: pick a date and
 * a window, and every room answers yes or no in one screen. Everything else —
 * the request form, the approval queue, the register — hangs off that.
 *
 * Each room is drawn as a day bar with its booked intervals laid over it. The
 * bar is positioned from the facility's own opening and closing minutes rather
 * than a fixed 24-hour scale, so a hall open 07:00–19:00 uses the whole width
 * instead of half of it.
 */

const CATEGORY_LABELS = {
  auditorium: 'Auditorium',
  laboratory: 'Laboratory',
  sports: 'Sports',
  classroom: 'Classroom',
  library: 'Library',
  seminar: 'Seminar room',
  other: 'Other',
};

const BOOKING_STATUS_STYLES = {
  pending: 'bg-amber-100 text-amber-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-200 text-gray-600',
  completed: 'bg-blue-100 text-blue-700',
};

const emptyBookingForm = {
  title: '',
  purpose: '',
  startTime: '',
  endTime: '',
  expectedAttendance: 1,
  setupNotes: '',
};

const emptyFacilityForm = {
  name: '',
  code: '',
  category: 'classroom',
  building: '',
  floor: '',
  capacity: 30,
  openingTime: '07:00',
  closingTime: '19:00',
  bufferMinutes: 0,
  requiresApproval: false,
  minBookingMinutes: 30,
  maxBookingMinutes: 240,
  maxAdvanceDays: 90,
  notes: '',
};

const todayKey = () => {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
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

const toMinutes = (time) => {
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time || '')) return null;
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

/** A booked interval drawn as a percentage of the room's own opening hours. */
const barGeometry = (facility, booking) => {
  const span = facility.closingMinute ?? toMinutes(facility.closingTime);
  const open = facility.openingMinute ?? toMinutes(facility.openingTime);
  const total = Math.max(1, span - open);
  const left = ((booking.startMinute - open) / total) * 100;
  const width = ((booking.endMinute - booking.startMinute) / total) * 100;
  return {
    left: `${Math.max(0, Math.min(100, left))}%`,
    width: `${Math.max(1, Math.min(100, width))}%`,
  };
};

const FacilityBooking = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isStaff = role === 'teacher' || role === 'admin';
  const isAdmin = role === 'admin';

  const [tab, setTab] = useState('availability');
  const [date, setDate] = useState(todayKey());
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [minCapacity, setMinCapacity] = useState('');

  const [availability, setAvailability] = useState([]);
  const [myBookings, setMyBookings] = useState([]);
  const [pending, setPending] = useState([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [booking, setBooking] = useState(null);
  const [bookingForm, setBookingForm] = useState(emptyBookingForm);
  const [submitting, setSubmitting] = useState(false);

  const [showFacilityForm, setShowFacilityForm] = useState(false);
  const [facilityForm, setFacilityForm] = useState(emptyFacilityForm);

  const flash = useCallback((message) => {
    setNotice(message);
    setTimeout(() => setNotice(''), 4000);
  }, []);

  const loadAvailability = useCallback(async () => {
    try {
      const params = { date };
      if (startTime && endTime) {
        params.startTime = startTime;
        params.endTime = endTime;
      }
      if (categoryFilter) params.category = categoryFilter;
      if (minCapacity) params.minCapacity = minCapacity;

      const res = await api.get('/facilities/availability', { params });
      setAvailability(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load availability.');
    }
  }, [date, startTime, endTime, categoryFilter, minCapacity]);

  const loadMyBookings = useCallback(async () => {
    try {
      const res = await api.get('/facilities/my-bookings');
      setMyBookings(res.data.data || []);
    } catch (err) {
      console.error(err);
    }
  }, []);

  const loadPending = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await api.get('/facilities/pending');
      setPending(res.data.data || []);
    } catch (err) {
      console.error(err);
    }
  }, [isAdmin]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await Promise.all([loadAvailability(), loadMyBookings(), loadPending()]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAvailability, loadMyBookings, loadPending]);

  const hasWindow = useMemo(
    () => Boolean(startTime && endTime && toMinutes(endTime) > toMinutes(startTime)),
    [startTime, endTime]
  );

  // --- Booking -------------------------------------------------------------

  const openBooking = (facility, presetWindow) => {
    setBooking(facility);
    setBookingForm({
      ...emptyBookingForm,
      startTime: presetWindow?.startTime || startTime || '',
      endTime: presetWindow?.endTime || endTime || '',
    });
    setError('');
  };

  const submitBooking = async (event) => {
    event.preventDefault();
    if (!booking) return;

    if (toMinutes(bookingForm.endTime) <= toMinutes(bookingForm.startTime)) {
      setError('The end time has to be after the start time.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const res = await api.post(`/facilities/${booking._id}/bookings`, {
        ...bookingForm,
        date,
        expectedAttendance: Number(bookingForm.expectedAttendance) || 1,
      });
      flash(res.data.message);
      setBooking(null);
      setBookingForm(emptyBookingForm);
      await Promise.all([loadAvailability(), loadMyBookings(), loadPending()]);
    } catch (err) {
      // A 409 is the interesting case: somebody took the window between the
      // page rendering and this request. Reload so the grid stops showing a gap
      // that is gone.
      setError(err.response?.data?.message || 'Could not book that room.');
      if (err.response?.status === 409) await loadAvailability();
    } finally {
      setSubmitting(false);
    }
  };

  const cancelBooking = async (row) => {
    const reason = window.prompt('Why is the booking being cancelled? (optional)') ?? '';
    setError('');
    try {
      await api.patch(`/facilities/${row.facilityId}/bookings/${row.bookingId}/cancel`, {
        cancelReason: reason || null,
      });
      flash('Booking cancelled. The window is free again.');
      await Promise.all([loadAvailability(), loadMyBookings(), loadPending()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not cancel that booking.');
    }
  };

  const decide = async (row, approve) => {
    setError('');
    try {
      if (approve) {
        await api.patch(`/facilities/${row.facilityId}/bookings/${row.bookingId}/approve`);
        flash('Approved.');
      } else {
        const reason = window.prompt('Why is the request being turned down?');
        if (!reason) return;
        await api.patch(`/facilities/${row.facilityId}/bookings/${row.bookingId}/reject`, {
          rejectionReason: reason,
        });
        flash('Rejected and the window freed.');
      }
      await Promise.all([loadPending(), loadAvailability()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not record that decision.');
    }
  };

  const submitFacility = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await api.post('/facilities', facilityForm);
      flash(`${facilityForm.name} added to the register.`);
      setShowFacilityForm(false);
      setFacilityForm(emptyFacilityForm);
      await loadAvailability();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not add that facility.');
    } finally {
      setSubmitting(false);
    }
  };

  // --- Render --------------------------------------------------------------

  const tabs = [
    { id: 'availability', label: 'Availability' },
    { id: 'mine', label: 'My bookings' },
    ...(isAdmin ? [{ id: 'approvals', label: `Approvals (${pending.length})` }] : []),
  ];

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-gray-500">
        Loading rooms...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="bg-gradient-to-r from-indigo-600 to-violet-700 rounded-2xl p-6 mb-6 text-white">
          <h1 className="text-2xl font-bold">Rooms and facilities</h1>
          <p className="text-indigo-100 mt-1 text-sm">
            What is free, when — and a booking that cannot collide with another one.
          </p>
        </div>

        {notice && (
          <div className="mb-4 rounded-lg bg-green-100 text-green-800 px-4 py-3 text-sm">
            {notice}
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-lg bg-red-100 text-red-800 px-4 py-3 text-sm">
            {error}
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-6 bg-white rounded-xl p-1 shadow">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setTab(entry.id)}
              className={`flex-1 min-w-[130px] py-2 px-4 rounded-lg text-sm font-medium transition ${
                tab === entry.id
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {/* ---------------------------------------------------------------- */}
        {tab === 'availability' && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl shadow p-4 flex flex-wrap items-end gap-4">
              <label className="text-sm">
                <span className="block text-gray-500 mb-1">Date</span>
                <input
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                  className="border rounded-lg px-3 py-2"
                />
              </label>
              <label className="text-sm">
                <span className="block text-gray-500 mb-1">From</span>
                <input
                  type="time"
                  value={startTime}
                  onChange={(event) => setStartTime(event.target.value)}
                  className="border rounded-lg px-3 py-2"
                />
              </label>
              <label className="text-sm">
                <span className="block text-gray-500 mb-1">To</span>
                <input
                  type="time"
                  value={endTime}
                  onChange={(event) => setEndTime(event.target.value)}
                  className="border rounded-lg px-3 py-2"
                />
              </label>
              <label className="text-sm">
                <span className="block text-gray-500 mb-1">Type</span>
                <select
                  value={categoryFilter}
                  onChange={(event) => setCategoryFilter(event.target.value)}
                  className="border rounded-lg px-3 py-2"
                >
                  <option value="">Any</option>
                  {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="block text-gray-500 mb-1">Seats at least</span>
                <input
                  type="number"
                  min="1"
                  value={minCapacity}
                  onChange={(event) => setMinCapacity(event.target.value)}
                  className="border rounded-lg px-3 py-2 w-28"
                />
              </label>
              {isAdmin && (
                <button
                  onClick={() => setShowFacilityForm((current) => !current)}
                  className="ml-auto text-sm border border-gray-300 px-4 py-2 rounded-lg hover:bg-gray-50"
                >
                  {showFacilityForm ? 'Close' : 'Add a facility'}
                </button>
              )}
            </div>

            {showFacilityForm && isAdmin && (
              <form
                onSubmit={submitFacility}
                className="bg-white rounded-xl shadow p-5 grid sm:grid-cols-3 gap-4"
              >
                {[
                  { field: 'name', label: 'Name', type: 'text', required: true },
                  { field: 'code', label: 'Code', type: 'text', required: true },
                  { field: 'building', label: 'Building', type: 'text', required: false },
                  { field: 'floor', label: 'Floor', type: 'text', required: false },
                  { field: 'capacity', label: 'Capacity', type: 'number', required: true },
                  { field: 'openingTime', label: 'Opens', type: 'time', required: true },
                  { field: 'closingTime', label: 'Closes', type: 'time', required: true },
                  { field: 'bufferMinutes', label: 'Setup buffer (min)', type: 'number', required: false },
                  { field: 'minBookingMinutes', label: 'Shortest booking', type: 'number', required: false },
                  { field: 'maxBookingMinutes', label: 'Longest booking', type: 'number', required: false },
                  { field: 'maxAdvanceDays', label: 'Book ahead (days)', type: 'number', required: false },
                ].map((input) => (
                  <label key={input.field} className="text-sm">
                    <span className="block text-gray-500 mb-1">{input.label}</span>
                    <input
                      type={input.type}
                      required={input.required}
                      value={facilityForm[input.field]}
                      onChange={(event) =>
                        setFacilityForm({ ...facilityForm, [input.field]: event.target.value })
                      }
                      className="w-full border rounded-lg px-3 py-2"
                    />
                  </label>
                ))}

                <label className="text-sm">
                  <span className="block text-gray-500 mb-1">Type</span>
                  <select
                    value={facilityForm.category}
                    onChange={(event) =>
                      setFacilityForm({ ...facilityForm, category: event.target.value })
                    }
                    className="w-full border rounded-lg px-3 py-2"
                  >
                    {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-2 text-sm mt-6">
                  <input
                    type="checkbox"
                    checked={facilityForm.requiresApproval}
                    onChange={(event) =>
                      setFacilityForm({
                        ...facilityForm,
                        requiresApproval: event.target.checked,
                      })
                    }
                  />
                  Needs approval
                </label>

                <div className="sm:col-span-3">
                  <button
                    type="submit"
                    disabled={submitting}
                    className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-500 disabled:opacity-50"
                  >
                    {submitting ? 'Adding...' : 'Add facility'}
                  </button>
                </div>
              </form>
            )}

            {availability.length === 0 ? (
              <div className="bg-white rounded-xl shadow p-6 text-sm text-gray-500">
                No facilities match those filters.
              </div>
            ) : (
              availability.map((facility) => (
                <div key={facility._id} className="bg-white rounded-xl shadow p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold">{facility.name}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                          {CATEGORY_LABELS[facility.category]}
                        </span>
                        <span className="text-xs text-gray-500">
                          {facility.capacity} seats
                        </span>
                        {facility.requiresApproval && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                            Needs approval
                          </span>
                        )}
                        {hasWindow && (
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full ${
                              facility.free
                                ? 'bg-green-100 text-green-700'
                                : 'bg-red-100 text-red-700'
                            }`}
                          >
                            {facility.free ? 'Free' : 'Taken'}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        {facility.building || 'Main site'} · open {facility.openingTime}–
                        {facility.closingTime}
                        {facility.bufferMinutes > 0 &&
                          ` · ${facility.bufferMinutes} min setup held either side`}
                      </div>
                      {hasWindow && facility.reason && (
                        <div className="text-xs text-gray-600 mt-1">{facility.reason}</div>
                      )}
                    </div>

                    {isStaff && (
                      <button
                        onClick={() => openBooking(facility)}
                        disabled={hasWindow && !facility.free}
                        className="text-sm bg-indigo-600 text-white px-3 py-1.5 rounded-lg hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Book
                      </button>
                    )}
                  </div>

                  {/* Day bar */}
                  <div className="relative h-8 bg-gray-100 rounded-lg mt-3 overflow-hidden">
                    {facility.booked.map((slot) => (
                      <div
                        key={slot.bookingId}
                        title={`${slot.startTime}–${slot.endTime} ${slot.title}`}
                        style={barGeometry(facility, slot)}
                        className={`absolute top-0 h-full ${
                          slot.status === 'pending' ? 'bg-amber-400/70' : 'bg-indigo-500/80'
                        }`}
                      />
                    ))}
                  </div>

                  {facility.freeWindows?.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-3">
                      {facility.freeWindows.map((window) => (
                        <button
                          key={`${window.startMinute}-${window.endMinute}`}
                          onClick={() => isStaff && openBooking(facility, window)}
                          disabled={!isStaff}
                          className="text-xs border border-gray-200 rounded-full px-3 py-1 hover:bg-gray-50 disabled:cursor-default"
                        >
                          free {window.startTime}–{window.endTime}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {tab === 'mine' && (
          <div className="space-y-3">
            {myBookings.length === 0 ? (
              <div className="bg-white rounded-xl shadow p-6 text-sm text-gray-500">
                You have not booked any rooms.
              </div>
            ) : (
              myBookings.map((row) => (
                <div key={row.bookingId} className="bg-white rounded-xl shadow p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold">{row.title}</span>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            BOOKING_STATUS_STYLES[row.status]
                          }`}
                        >
                          {row.status}
                        </span>
                        <span className="text-xs text-gray-400">{row.reference}</span>
                      </div>
                      <div className="text-sm text-gray-600 mt-1">
                        {row.facilityName}
                        {row.building ? ` · ${row.building}` : ''}
                      </div>
                      <div className="text-sm text-gray-500 mt-1">
                        {formatDate(row.date)} · {row.startTime}–{row.endTime} ·{' '}
                        {row.expectedAttendance} expected
                      </div>
                      {row.rejectionReason && (
                        <div className="text-xs text-red-600 mt-1">
                          Turned down: {row.rejectionReason}
                        </div>
                      )}
                      {row.cancelReason && (
                        <div className="text-xs text-gray-500 mt-1">
                          Cancelled: {row.cancelReason}
                        </div>
                      )}
                    </div>
                    {(row.status === 'pending' || row.status === 'approved') && (
                      <button
                        onClick={() => cancelBooking(row)}
                        className="text-sm border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {tab === 'approvals' && isAdmin && (
          <div className="space-y-3">
            {pending.length === 0 ? (
              <div className="bg-white rounded-xl shadow p-6 text-sm text-gray-500">
                Nothing is waiting on a decision.
              </div>
            ) : (
              pending.map((row) => (
                <div key={row.bookingId} className="bg-white rounded-xl shadow p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold">{row.title}</span>
                        <span className="text-xs text-gray-400">{row.reference}</span>
                      </div>
                      <div className="text-sm text-gray-600 mt-1">
                        {row.facilityName} · {formatDate(row.date)} · {row.startTime}–
                        {row.endTime}
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        {row.requesterName} · {row.expectedAttendance} expected
                      </div>
                      {row.purpose && (
                        <p className="text-sm text-gray-600 mt-2">{row.purpose}</p>
                      )}
                      {row.setupNotes && (
                        <p className="text-xs text-gray-500 mt-1">Setup: {row.setupNotes}</p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => decide(row, true)}
                        className="text-sm bg-green-600 text-white px-3 py-1.5 rounded-lg hover:bg-green-500"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => decide(row, false)}
                        className="text-sm border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50"
                      >
                        Turn down
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* Booking form ---------------------------------------------------- */}
        {booking && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
            <form
              onSubmit={submitBooking}
              className="bg-white rounded-2xl shadow-xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-6 space-y-4"
            >
              <div>
                <h3 className="text-lg font-semibold">Book {booking.name}</h3>
                <p className="text-sm text-gray-500">
                  {formatDate(date)} · open {booking.openingTime}–{booking.closingTime}
                  {booking.bufferMinutes > 0 &&
                    ` · ${booking.bufferMinutes} min setup is held either side of your slot`}
                </p>
              </div>

              <label className="text-sm block">
                <span className="block text-gray-500 mb-1">What is it for?</span>
                <input
                  type="text"
                  required
                  value={bookingForm.title}
                  onChange={(event) =>
                    setBookingForm({ ...bookingForm, title: event.target.value })
                  }
                  className="w-full border rounded-lg px-3 py-2"
                />
              </label>

              <div className="grid grid-cols-3 gap-3">
                <label className="text-sm">
                  <span className="block text-gray-500 mb-1">From</span>
                  <input
                    type="time"
                    required
                    value={bookingForm.startTime}
                    onChange={(event) =>
                      setBookingForm({ ...bookingForm, startTime: event.target.value })
                    }
                    className="w-full border rounded-lg px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="block text-gray-500 mb-1">To</span>
                  <input
                    type="time"
                    required
                    value={bookingForm.endTime}
                    onChange={(event) =>
                      setBookingForm({ ...bookingForm, endTime: event.target.value })
                    }
                    className="w-full border rounded-lg px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="block text-gray-500 mb-1">People</span>
                  <input
                    type="number"
                    min="1"
                    max={booking.capacity}
                    value={bookingForm.expectedAttendance}
                    onChange={(event) =>
                      setBookingForm({
                        ...bookingForm,
                        expectedAttendance: event.target.value,
                      })
                    }
                    className="w-full border rounded-lg px-3 py-2"
                  />
                </label>
              </div>

              <label className="text-sm block">
                <span className="block text-gray-500 mb-1">Details (optional)</span>
                <textarea
                  rows={2}
                  value={bookingForm.purpose}
                  onChange={(event) =>
                    setBookingForm({ ...bookingForm, purpose: event.target.value })
                  }
                  className="w-full border rounded-lg px-3 py-2"
                />
              </label>

              <label className="text-sm block">
                <span className="block text-gray-500 mb-1">
                  Setup needed (chairs, projector, sound)
                </span>
                <input
                  type="text"
                  value={bookingForm.setupNotes}
                  onChange={(event) =>
                    setBookingForm({ ...bookingForm, setupNotes: event.target.value })
                  }
                  className="w-full border rounded-lg px-3 py-2"
                />
              </label>

              {booking.requiresApproval && (
                <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
                  This room needs approval. The slot is held for you while the request is
                  decided.
                </p>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setBooking(null)}
                  className="text-sm border border-gray-300 px-4 py-2 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="text-sm bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-500 disabled:opacity-50"
                >
                  {submitting ? 'Booking...' : 'Book it'}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};

export default FacilityBooking;
