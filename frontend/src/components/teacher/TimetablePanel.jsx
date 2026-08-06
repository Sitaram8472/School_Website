import { useState, useEffect, useCallback } from 'react';
import api from '../../utils/axios';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const PERIOD_TYPES = ['lecture', 'lab', 'activity', 'break', 'exam'];

const EMPTY_TIMETABLE = {
  className: '',
  section: 'A',
  academicYear: '',
  notes: '',
};

const EMPTY_PERIOD = {
  day: 'Monday',
  periodNumber: 1,
  subject: '',
  teacherName: '',
  startTime: '09:00',
  endTime: '10:00',
  room: '',
  type: 'lecture',
};

const TYPE_STYLES = {
  lecture: 'bg-blue-100 text-blue-700',
  lab: 'bg-purple-100 text-purple-700',
  activity: 'bg-amber-100 text-amber-700',
  break: 'bg-gray-100 text-gray-600',
  exam: 'bg-red-100 text-red-700',
};

const toMinutes = (time) => {
  const [hours, minutes] = String(time).split(':').map(Number);
  return hours * 60 + minutes;
};

/**
 * Teacher-side timetable builder: create a grid for a class, add periods day by
 * day, and publish it so students see it.
 */
const TimetablePanel = () => {
  const [timetables, setTimetables] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(EMPTY_TIMETABLE);
  const [periodForm, setPeriodForm] = useState(EMPTY_PERIOD);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const selected = timetables.find((t) => t._id === selectedId) || null;

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 3000);
  };

  const fetchTimetables = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/timetables');
      setTimetables(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load timetables.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTimetables();
  }, [fetchTimetables]);

  const replaceTimetable = (updated) => {
    setTimetables((prev) => prev.map((t) => (t._id === updated._id ? updated : t)));
  };

  const handleCreate = async (event) => {
    event.preventDefault();
    setError('');

    if (!form.className.trim() || !form.academicYear.trim()) {
      setError('Class name and academic year are required.');
      return;
    }

    try {
      const res = await api.post('/timetables', form);
      setTimetables((prev) => [res.data.data, ...prev]);
      setSelectedId(res.data.data._id);
      setForm(EMPTY_TIMETABLE);
      flash('Timetable created. Add periods to it below.');
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to create timetable.');
    }
  };

  /**
   * Check for a clash locally before asking the server, so an obvious mistake
   * is reported instantly instead of after a round trip.
   */
  const localClash = () => {
    if (!selected) return null;
    const start = toMinutes(periodForm.startTime);
    const end = toMinutes(periodForm.endTime);

    if (end <= start) return { message: 'The period ends before it starts.' };

    const conflict = selected.periods.find(
      (period) =>
        period.day === periodForm.day &&
        start < toMinutes(period.endTime) &&
        end > toMinutes(period.startTime)
    );

    return conflict
      ? { message: `Clashes with ${conflict.subject} (${conflict.startTime}-${conflict.endTime}).` }
      : null;
  };

  const handleAddPeriod = async (event) => {
    event.preventDefault();
    setError('');

    if (!selected) {
      setError('Select a timetable first.');
      return;
    }
    if (!periodForm.subject.trim()) {
      setError('Subject is required.');
      return;
    }

    const clash = localClash();
    if (clash) {
      setError(clash.message);
      return;
    }

    try {
      const res = await api.post(`/timetables/${selected._id}/periods`, periodForm);
      replaceTimetable(res.data.data);
      setPeriodForm((prev) => ({
        ...prev,
        subject: '',
        room: '',
        periodNumber: Number(prev.periodNumber) + 1,
      }));
      flash('Period added.');
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to add period.');
    }
  };

  const handleRemovePeriod = async (periodId) => {
    try {
      const res = await api.delete(`/timetables/${selected._id}/periods/${periodId}`);
      replaceTimetable(res.data.data);
      flash('Period removed.');
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to remove period.');
    }
  };

  const handlePublish = async (timetable) => {
    const action = timetable.isActive ? 'deactivate' : 'activate';
    try {
      const res = await api.patch(`/timetables/${timetable._id}/${action}`);
      // Activating one deactivates its siblings, so refetch rather than patch.
      await fetchTimetables();
      flash(res.data.message);
    } catch (err) {
      setError(err.response?.data?.message || `Failed to ${action} timetable.`);
    }
  };

  const handleDelete = async (timetable) => {
    if (!window.confirm(`Delete the timetable for ${timetable.className}-${timetable.section}?`)) return;
    try {
      await api.delete(`/timetables/${timetable._id}`);
      setTimetables((prev) => prev.filter((t) => t._id !== timetable._id));
      if (selectedId === timetable._id) setSelectedId(null);
      flash('Timetable deleted.');
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to delete timetable.');
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow p-6 mb-6">
      <h3 className="text-xl font-bold text-gray-800 mb-4">🗓️ Timetable Management</h3>

      {/* Create */}
      <form onSubmit={handleCreate} className="grid md:grid-cols-4 gap-3 mb-6">
        <input
          type="text"
          placeholder="Class, e.g. Class 10 *"
          value={form.className}
          onChange={(e) => setForm({ ...form, className: e.target.value })}
          className="border border-gray-300 rounded-lg px-4 py-2 text-sm"
        />
        <input
          type="text"
          placeholder="Section"
          value={form.section}
          onChange={(e) => setForm({ ...form, section: e.target.value })}
          className="border border-gray-300 rounded-lg px-4 py-2 text-sm"
        />
        <input
          type="text"
          placeholder="Academic year, e.g. 2025-26 *"
          value={form.academicYear}
          onChange={(e) => setForm({ ...form, academicYear: e.target.value })}
          className="border border-gray-300 rounded-lg px-4 py-2 text-sm"
        />
        <button
          type="submit"
          className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-4 py-2 text-sm font-medium transition"
        >
          + New timetable
        </button>
      </form>

      {error && <p className="text-red-500 text-sm mb-3">{error}</p>}
      {success && <p className="text-green-600 text-sm mb-3">{success}</p>}

      {/* Timetable list */}
      {loading ? (
        <p className="text-gray-400 text-sm text-center py-6">Loading timetables...</p>
      ) : timetables.length === 0 ? (
        <p className="text-gray-400 text-sm text-center py-6">
          No timetables yet. Create one above to get started.
        </p>
      ) : (
        <div className="space-y-2 mb-6">
          {timetables.map((timetable) => (
            <div
              key={timetable._id}
              className={`rounded-xl p-4 border transition cursor-pointer ${
                selectedId === timetable._id
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 bg-gray-50 hover:border-gray-300'
              }`}
              onClick={() => setSelectedId(timetable._id)}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-semibold text-gray-800 text-sm">
                    {timetable.className} — {timetable.section}
                    {timetable.isActive && (
                      <span className="ml-2 text-[11px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                        live
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {timetable.academicYear} · {timetable.periods.length} period(s)
                  </p>
                </div>

                <div className="flex gap-3 shrink-0">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePublish(timetable);
                    }}
                    className={`text-xs font-medium ${
                      timetable.isActive
                        ? 'text-orange-600 hover:text-orange-800'
                        : 'text-green-600 hover:text-green-800'
                    }`}
                  >
                    {timetable.isActive ? 'Unpublish' : 'Publish'}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(timetable);
                    }}
                    className="text-red-400 hover:text-red-600 text-xs"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Period editor */}
      {selected && (
        <div className="border-t border-gray-200 pt-6">
          <p className="text-sm font-semibold text-gray-700 mb-3">
            Periods for {selected.className}-{selected.section}
          </p>

          <form onSubmit={handleAddPeriod} className="grid md:grid-cols-4 gap-3 mb-5">
            <select
              value={periodForm.day}
              onChange={(e) => setPeriodForm({ ...periodForm, day: e.target.value })}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              {DAYS.map((day) => (
                <option key={day} value={day}>
                  {day}
                </option>
              ))}
            </select>

            <input
              type="number"
              min="1"
              max="15"
              placeholder="Period #"
              value={periodForm.periodNumber}
              onChange={(e) => setPeriodForm({ ...periodForm, periodNumber: e.target.value })}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />

            <input
              type="text"
              placeholder="Subject *"
              value={periodForm.subject}
              onChange={(e) => setPeriodForm({ ...periodForm, subject: e.target.value })}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />

            <select
              value={periodForm.type}
              onChange={(e) => setPeriodForm({ ...periodForm, type: e.target.value })}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              {PERIOD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>

            <input
              type="time"
              value={periodForm.startTime}
              onChange={(e) => setPeriodForm({ ...periodForm, startTime: e.target.value })}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />

            <input
              type="time"
              value={periodForm.endTime}
              onChange={(e) => setPeriodForm({ ...periodForm, endTime: e.target.value })}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />

            <input
              type="text"
              placeholder="Room"
              value={periodForm.room}
              onChange={(e) => setPeriodForm({ ...periodForm, room: e.target.value })}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />

            <button
              type="submit"
              className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-4 py-2 text-sm font-medium transition"
            >
              + Add period
            </button>
          </form>

          {selected.periods.length === 0 ? (
            <p className="text-gray-400 text-sm text-center py-4">
              No periods on this timetable yet.
            </p>
          ) : (
            <div className="space-y-4">
              {DAYS.map((day) => {
                const periods = selected.periods
                  .filter((period) => period.day === day)
                  .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));

                if (periods.length === 0) return null;

                return (
                  <div key={day}>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                      {day}
                    </p>
                    <div className="space-y-2">
                      {periods.map((period) => (
                        <div
                          key={period._id}
                          className="flex flex-wrap items-center justify-between gap-2 bg-gray-50 rounded-lg px-4 py-2.5"
                        >
                          <div className="flex flex-wrap items-center gap-3">
                            <span className="text-xs text-gray-400 w-6">#{period.periodNumber}</span>
                            <span className="text-sm font-medium text-gray-800">{period.subject}</span>
                            <span
                              className={`text-[11px] px-2 py-0.5 rounded-full ${
                                TYPE_STYLES[period.type] || TYPE_STYLES.lecture
                              }`}
                            >
                              {period.type}
                            </span>
                            <span className="text-xs text-gray-500">
                              {period.startTime} – {period.endTime}
                            </span>
                            {period.room && <span className="text-xs text-gray-400">📍 {period.room}</span>}
                          </div>

                          <button
                            onClick={() => handleRemovePeriod(period._id)}
                            className="text-red-400 hover:text-red-600 text-xs"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default TimetablePanel;
