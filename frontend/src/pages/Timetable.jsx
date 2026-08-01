import React, { useState, useEffect, useContext, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CalendarDays, Clock, MapPin, Printer, AlertCircle } from 'lucide-react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const TYPE_STYLES = {
  lecture: 'border-blue-400 bg-blue-50',
  lab: 'border-purple-400 bg-purple-50',
  activity: 'border-amber-400 bg-amber-50',
  break: 'border-gray-300 bg-gray-50',
  exam: 'border-red-400 bg-red-50',
};

const toMinutes = (time) => {
  const [hours, minutes] = String(time).split(':').map(Number);
  return hours * 60 + minutes;
};

const todayName = () => DAYS[(new Date().getDay() + 6) % 7] || 'Monday';

/**
 * 24-hour "14:30" rendered as "2:30 PM" — friendlier for a school notice board.
 */
const to12Hour = (time) => {
  const [hours, minutes] = String(time).split(':').map(Number);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const displayHour = hours % 12 === 0 ? 12 : hours % 12;
  return `${displayHour}:${String(minutes).padStart(2, '0')} ${suffix}`;
};

const Timetable = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isTeacher = role === 'teacher' || role === 'admin';

  const [timetable, setTimetable] = useState(null);
  const [teacherPeriods, setTeacherPeriods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedDay, setSelectedDay] = useState(todayName());
  const [now, setNow] = useState(new Date());

  const fetchTimetable = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/timetables/me');

      if (res.data.scope === 'teacher') {
        setTeacherPeriods(res.data.data?.periods || []);
      } else {
        setTimetable(res.data.data);
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the timetable right now.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTimetable();
  }, [fetchTimetable]);

  // Re-tick every minute so the "happening now" highlight stays accurate on a
  // screen left open in a classroom all day.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  const periods = useMemo(
    () => (isTeacher ? teacherPeriods : timetable?.periods || []),
    [isTeacher, teacherPeriods, timetable]
  );

  const periodsByDay = useMemo(() => {
    const map = new Map(DAYS.map((day) => [day, []]));
    periods.forEach((period) => {
      if (map.has(period.day)) map.get(period.day).push(period);
    });
    map.forEach((list) => list.sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime)));
    return map;
  }, [periods]);

  const currentPeriodId = useMemo(() => {
    const day = DAYS[(now.getDay() + 6) % 7];
    const minutesNow = now.getHours() * 60 + now.getMinutes();

    const running = (periodsByDay.get(day) || []).find(
      (period) => toMinutes(period.startTime) <= minutesNow && minutesNow < toMinutes(period.endTime)
    );
    return running?._id || null;
  }, [periodsByDay, now]);

  const weeklyStats = useMemo(() => {
    const subjects = new Set(periods.filter((p) => p.type !== 'break').map((p) => p.subject));
    const totalMinutes = periods
      .filter((p) => p.type !== 'break')
      .reduce((sum, p) => sum + (toMinutes(p.endTime) - toMinutes(p.startTime)), 0);

    return {
      periodCount: periods.length,
      subjectCount: subjects.size,
      weeklyHours: Math.round((totalMinutes / 60) * 10) / 10,
      busiestDay:
        DAYS.reduce(
          (best, day) =>
            (periodsByDay.get(day) || []).length > (periodsByDay.get(best) || []).length ? day : best,
          DAYS[0]
        ) || '—',
    };
  }, [periods, periodsByDay]);

  const renderPeriodCard = (period, compact = false) => {
    const isNow = period._id === currentPeriodId;

    return (
      <div
        key={period._id}
        className={`rounded-2xl border-l-4 p-4 transition ${
          TYPE_STYLES[period.type] || TYPE_STYLES.lecture
        } ${isNow ? 'ring-2 ring-blue-500 shadow-lg' : 'hover:shadow-md'}`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-bold text-gray-800 truncate">{period.subject}</p>
            <p className="text-xs text-gray-500 mt-1 flex items-center gap-1">
              <Clock size={12} />
              {to12Hour(period.startTime)} – {to12Hour(period.endTime)}
            </p>
          </div>
          <span className="text-xs text-gray-400 shrink-0">#{period.periodNumber}</span>
        </div>

        {!compact && (
          <div className="flex flex-wrap gap-3 mt-3 text-xs text-gray-500">
            {period.teacherName && <span>👨‍🏫 {period.teacherName}</span>}
            {period.room && (
              <span className="flex items-center gap-1">
                <MapPin size={11} /> {period.room}
              </span>
            )}
            {period.className && (
              <span className="font-medium text-gray-600">
                {period.className}-{period.section}
              </span>
            )}
          </div>
        )}

        {isNow && (
          <span className="inline-block mt-3 bg-blue-600 text-white text-[11px] px-3 py-1 rounded-full">
            Happening now
          </span>
        )}
      </div>
    );
  };

  return (
    <div
      className="min-h-screen p-4 sm:p-6"
      style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
    >
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .print-grid { display: grid !important; grid-template-columns: repeat(3, 1fr) !important; }
        }
      `}</style>

      {/* Header */}
      <div className="bg-gradient-to-r from-indigo-700 to-purple-700 text-white rounded-3xl p-8 shadow-2xl mb-8">
        <Link
          to={isTeacher ? '/teacher/dashboard' : '/student'}
          className="no-print inline-flex items-center gap-2 text-indigo-100 hover:text-white text-sm"
        >
          <ArrowLeft size={16} /> Back to dashboard
        </Link>

        <div className="flex items-center gap-4 mt-4">
          <div className="bg-white text-indigo-700 p-4 rounded-full shadow-lg">
            <CalendarDays size={30} />
          </div>
          <div>
            <h1 className="text-2xl sm:text-4xl font-bold">
              {isTeacher ? 'My Teaching Schedule' : 'Class Timetable'}
            </h1>
            <p className="text-indigo-100 mt-1">
              {isTeacher
                ? 'Every period you teach across all live class timetables.'
                : timetable
                ? `${timetable.className} — Section ${timetable.section} · ${timetable.academicYear}`
                : 'No timetable published for your class yet.'}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
          {[
            { label: 'Periods / week', value: weeklyStats.periodCount },
            { label: 'Subjects', value: weeklyStats.subjectCount },
            { label: 'Hours / week', value: weeklyStats.weeklyHours },
            { label: 'Busiest day', value: weeklyStats.busiestDay },
          ].map((tile) => (
            <div key={tile.label} className="bg-white/15 rounded-2xl p-4">
              <div className="text-xl font-bold">{tile.value}</div>
              <div className="text-xs text-indigo-100 mt-1">{tile.label}</div>
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

      {loading ? (
        <div className="bg-white rounded-3xl shadow-xl p-12 text-center text-gray-500">
          Loading the timetable...
        </div>
      ) : periods.length === 0 ? (
        <div className="bg-white rounded-3xl shadow-xl p-12 text-center text-gray-500">
          <CalendarDays size={40} className="mx-auto text-gray-300" />
          <p className="text-lg font-semibold mt-4">Nothing scheduled yet</p>
          <p className="text-sm mt-2">
            {isTeacher
              ? 'Build and publish a timetable from the Timetable tab on your dashboard.'
              : 'Your class timetable will appear here once a teacher publishes it.'}
          </p>
        </div>
      ) : (
        <>
          {/* Mobile: single-day picker */}
          <div className="lg:hidden bg-white rounded-3xl shadow-xl p-6 mb-6">
            <div className="flex gap-2 overflow-x-auto pb-2 no-print">
              {DAYS.map((day) => (
                <button
                  key={day}
                  onClick={() => setSelectedDay(day)}
                  className={`px-4 py-2 rounded-xl text-sm font-medium whitespace-nowrap transition ${
                    selectedDay === day ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {day.slice(0, 3)}
                </button>
              ))}
            </div>

            <div className="space-y-3 mt-4">
              {(periodsByDay.get(selectedDay) || []).length === 0 ? (
                <p className="text-gray-400 text-sm text-center py-6">No classes on {selectedDay}.</p>
              ) : (
                (periodsByDay.get(selectedDay) || []).map((period) => renderPeriodCard(period))
              )}
            </div>
          </div>

          {/* Desktop: full week grid */}
          <div className="hidden lg:block bg-white rounded-3xl shadow-xl p-8">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-bold text-gray-800">Weekly overview</h2>
              <button
                onClick={() => window.print()}
                className="no-print inline-flex items-center gap-2 border border-gray-300 text-gray-600 hover:bg-gray-50 px-4 py-2 rounded-xl text-sm transition"
              >
                <Printer size={16} /> Print
              </button>
            </div>

            <div className="grid grid-cols-6 gap-4 print-grid">
              {DAYS.map((day) => {
                const dayPeriods = periodsByDay.get(day) || [];
                const isToday = day === todayName();

                return (
                  <div key={day}>
                    <div
                      className={`text-center rounded-xl py-2 mb-3 text-sm font-bold ${
                        isToday ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {day}
                    </div>

                    <div className="space-y-3">
                      {dayPeriods.length === 0 ? (
                        <p className="text-gray-300 text-xs text-center py-4">—</p>
                      ) : (
                        dayPeriods.map((period) => renderPeriodCard(period, true))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default Timetable;
