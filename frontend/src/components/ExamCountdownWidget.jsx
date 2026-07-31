import React, { useEffect, useState } from "react";
import { CalendarDays, Clock, BookOpen } from "lucide-react";

export default function ExamCountdownWidget({ exams = [] }) {
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  // Upcoming exams only
  const upcomingExams = exams
    .filter((exam) => {
      const examDate = new Date(exam.examDate || exam.date);
      return examDate > currentTime;
    })
    .sort(
      (a, b) =>
        new Date(a.examDate || a.date) -
        new Date(b.examDate || b.date)
    );

  if (upcomingExams.length === 0) {
    return (
      <div className="bg-white rounded-3xl shadow-2xl p-8 mb-10">
        <h2 className="text-3xl font-bold text-blue-700 mb-6">
          ⏳ Exam Countdown
        </h2>

        <p className="text-gray-500">
          No upcoming exams available.
        </p>
      </div>
    );
  }

  const nearestExam = upcomingExams[0];

  return (
    <div className="bg-white rounded-3xl shadow-2xl p-8 mb-10">
      <h2 className="text-3xl font-bold text-blue-700 mb-8">
        ⏳ Exam Countdown
      </h2>

      <div className="grid md:grid-cols-2 gap-6">
        {upcomingExams.map((exam) => {
          const examDate = new Date(exam.examDate || exam.date);

          const difference = examDate - currentTime;

          const days = Math.floor(
            difference / (1000 * 60 * 60 * 24)
          );

          const hours = Math.floor(
            (difference % (1000 * 60 * 60 * 24)) /
              (1000 * 60 * 60)
          );

          const minutes = Math.floor(
            (difference % (1000 * 60 * 60)) /
              (1000 * 60)
          );

          const isNearest =
            (exam._id || exam.id) ===
            (nearestExam._id || nearestExam.id);

          return (
            <div
              key={exam._id || exam.id}
              className={`rounded-2xl p-6 border transition shadow-md ${
                isNearest
                  ? "border-blue-600 bg-blue-50"
                  : "border-gray-200 bg-white"
              }`}
            >
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-2xl font-bold text-gray-800">
                  {exam.title}
                </h3>

                {isNearest && (
                  <span className="bg-blue-600 text-white px-3 py-1 rounded-full text-sm">
                    Next Exam
                  </span>
                )}
              </div>

              <p className="flex items-center gap-2 text-gray-700 mb-2">
                <BookOpen size={18} />
                {exam.course?.name || "General"}
              </p>

              <p className="flex items-center gap-2 text-gray-700 mb-2">
                <CalendarDays size={18} />
                {examDate.toLocaleDateString()}
              </p>

              <p className="flex items-center gap-2 text-gray-700 mb-4">
                <Clock size={18} />
                {examDate.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>

              <div className="bg-white rounded-xl p-4 border">
                <p className="text-blue-700 font-bold text-lg">
                  ⏳ {days} Days {hours} Hours {minutes} Minutes
                </p>
              </div>

              {days <= 3 && (
                <div className="mt-4">
                  <span className="bg-red-100 text-red-700 px-4 py-2 rounded-full text-sm font-semibold">
                    ⚠️ Upcoming Soon
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}