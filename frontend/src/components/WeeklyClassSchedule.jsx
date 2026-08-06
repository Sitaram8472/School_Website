import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../utils/axios";

/**
 * Shown only when no timetable has been published yet (or the API is
 * unreachable), so the dashboard never renders an empty hole.
 */
const SAMPLE_SCHEDULE = [
  {
    _id: "sample-mon",
    day: "Monday",
    subject: "Mathematics",
    teacherName: "Mr. Sharma",
    startTime: "09:00",
    endTime: "10:00",
  },
  {
    _id: "sample-tue",
    day: "Tuesday",
    subject: "Physics",
    teacherName: "Mrs. Patel",
    startTime: "10:00",
    endTime: "11:00",
  },
  {
    _id: "sample-wed",
    day: "Wednesday",
    subject: "Chemistry",
    teacherName: "Mr. Mehta",
    startTime: "11:00",
    endTime: "12:00",
  },
  {
    _id: "sample-thu",
    day: "Thursday",
    subject: "English",
    teacherName: "Mrs. Shah",
    startTime: "09:00",
    endTime: "10:00",
  },
  {
    _id: "sample-fri",
    day: "Friday",
    subject: "Computer Science",
    teacherName: "Mr. Joshi",
    startTime: "13:00",
    endTime: "14:00",
  },
];

const DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const toMinutes = (time) => {
  const [hours, minutes] = String(time).split(":").map(Number);
  return hours * 60 + minutes;
};

const to12Hour = (time) => {
  const [hours, minutes] = String(time).split(":").map(Number);
  const suffix = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 === 0 ? 12 : hours % 12;
  return `${displayHour}:${String(minutes).padStart(2, "0")} ${suffix}`;
};

export default function WeeklyClassSchedule() {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long" });

  const [periods, setPeriods] = useState([]);
  const [usingSample, setUsingSample] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const fetchTimetable = async () => {
      try {
        const res = await api.get("/timetables/me");
        const fetched = res.data?.data?.periods || [];

        if (cancelled) return;

        if (fetched.length > 0) {
          setPeriods(fetched);
          setUsingSample(false);
        } else {
          setPeriods(SAMPLE_SCHEDULE);
          setUsingSample(true);
        }
      } catch {
        // A signed-out visitor or an offline backend still gets a readable card.
        if (!cancelled) {
          setPeriods(SAMPLE_SCHEDULE);
          setUsingSample(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchTimetable();
    return () => {
      cancelled = true;
    };
  }, []);

  // One card per weekday showing that day's first few periods.
  const grouped = DAY_ORDER.map((day) => ({
    day,
    items: periods
      .filter((period) => period.day === day)
      .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime)),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="bg-white rounded-3xl shadow-2xl p-8 mb-10">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <h2 className="text-3xl font-bold text-blue-700">📅 Weekly Class Schedule</h2>

        <Link
          to="/timetable"
          className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl font-semibold transition"
        >
          Full timetable
        </Link>
      </div>

      {usingSample && !loading && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-100 rounded-xl px-4 py-3 mb-6">
          Showing a sample week — no timetable has been published for your class yet.
        </p>
      )}

      {loading ? (
        <p className="text-gray-500 text-center py-8">Loading your schedule...</p>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {grouped.map(({ day, items }) => (
            <div
              key={day}
              className={`rounded-2xl p-5 shadow-lg transition ${
                today === day ? "bg-blue-100 border-2 border-blue-600" : "bg-white hover:shadow-xl"
              }`}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold">{day}</h3>
                {today === day && (
                  <span className="bg-blue-600 text-white px-3 py-0.5 rounded-full text-xs">Today</span>
                )}
              </div>

              <div className="mt-3 space-y-3">
                {items.slice(0, 4).map((period) => (
                  <div key={period._id} className="border-l-2 border-blue-300 pl-3">
                    <p className="font-medium">📚 {period.subject}</p>
                    {period.teacherName && <p className="text-sm text-gray-600">👨‍🏫 {period.teacherName}</p>}
                    <p className="text-sm text-gray-500">
                      🕒 {to12Hour(period.startTime)} - {to12Hour(period.endTime)}
                    </p>
                    {period.room && <p className="text-sm text-gray-500">📍 {period.room}</p>}
                  </div>
                ))}

                {items.length > 4 && (
                  <p className="text-xs text-gray-400">+{items.length - 4} more period(s)</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
