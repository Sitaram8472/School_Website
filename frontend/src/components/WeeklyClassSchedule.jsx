import React from "react";

export default function WeeklyClassSchedule() {
const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
  });
const schedule = [
  {
    day: "Monday",
    subject: "Mathematics",
    teacher: "Mr. Sharma",
    time: "09:00 AM - 10:00 AM",
  },
  {
    day: "Tuesday",
    subject: "Physics",
    teacher: "Mrs. Patel",
    time: "10:00 AM - 11:00 AM",
  },
  {
    day: "Wednesday",
    subject: "Chemistry",
    teacher: "Mr. Mehta",
    time: "11:00 AM - 12:00 PM",
  },
  {
    day: "Thursday",
    subject: "English",
    teacher: "Mrs. Shah",
    time: "09:00 AM - 10:00 AM",
  },
  {
    day: "Friday",
    subject: "Computer Science",
    teacher: "Mr. Joshi",
    time: "01:00 PM - 02:00 PM",
  },
];
   return (
    <div className="bg-white rounded-3xl shadow-2xl p-8 mb-10">
      <h2 className="text-3xl font-bold text-blue-700 mb-6">
        📅 Weekly Class Schedule
      </h2>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        {schedule.map((item) => (
          <div
            key={item.day}
            className={`rounded-2xl p-5 shadow-lg transition ${
              today === item.day
                ? "bg-blue-100 border-2 border-blue-600"
                : "bg-white hover:shadow-xl"
            }`}
          >
            <h3 className="text-xl font-bold">{item.day}</h3>

            <p className="mt-2">📚 {item.subject}</p>

            <p>👨‍🏫 {item.teacher}</p>

            <p>🕒 {item.time}</p>

            {today === item.day && (
              <span className="inline-block mt-3 bg-blue-600 text-white px-3 py-1 rounded-full text-sm">
                Today
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}