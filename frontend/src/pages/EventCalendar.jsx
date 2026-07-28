import React, { useState } from "react";
import Calendar from "react-calendar";
import "react-calendar/dist/Calendar.css";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

import events from "../data/events";

const categories = [
  { label: "All", value: "All", icon: "📋" },
  { label: "Exams", value: "Exam", icon: "📚" },
  { label: "Holidays", value: "Holiday", icon: "🎉" },
  { label: "Assignments", value: "Assignment", icon: "📝" },
  { label: "Workshops", value: "Workshop", icon: "🎤" },
  { label: "School Events", value: "School Event", icon: "📅" },
  { label: "Competitions", value: "Competition", icon: "🏆" },
];
const roles = ["student", "teacher", "staff"];

const getDaysLeft = (eventDate) => {
  const today = new Date();
  const targetDate = new Date(eventDate);

  const difference = targetDate - today;

  return Math.ceil(difference / (1000 * 60 * 60 * 24));
};

const formatDateForComparison = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(date.getDate()).padStart(2, "0")}`;

const EventCalendar = () => {
  const [date, setDate] = useState(new Date());
  const [currentRole, setCurrentRole] = useState("student");
  const [selectedCategory, setSelectedCategory] = useState("All");

  const filteredEvents = events.filter(
  (event) =>
    event.role === currentRole &&
    (selectedCategory === "All" ||
      event.category === selectedCategory),
);

  const selectedDate = formatDateForComparison(date);

  const selectedDateEvents = filteredEvents.filter(
    (event) => event.date === selectedDate,
  );

  const formattedSelectedDate = date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  const displayRole =
    currentRole.charAt(0).toUpperCase() + currentRole.slice(1);

  const upcomingEvent = filteredEvents.find(
    (event) => getDaysLeft(event.date) >= 0,
  );

  const exportPDF = () => {
    const doc = new jsPDF();
    autoTable(doc, {
      head: [["Title", "Date", "Role", "Category", "Description"]],
      body: filteredEvents.map((event) => [
        event.title,
        event.date,
        event.role,
         event.category,
        event.description,
      ]),
    });
    doc.save("events.pdf");
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 px-6 py-10">
      {/* Heading */}
      <h1 className="text-3xl sm:text-5xl font-bold text-center text-blue-700 mb-4">
        Event Calendar
      </h1>

      <p className="text-center text-gray-600 text-lg mb-10">
        View upcoming events, deadlines, and important schedules
      </p>

      <div className="flex justify-center mb-8">
        <button
          onClick={exportPDF}
          className="bg-green-600 text-white px-6 py-3 rounded-xl font-semibold shadow-lg hover:bg-green-700 transition"
        >
          Export to PDF
        </button>
      </div>

      {/* Role Buttons */}
      <div className="flex justify-center gap-4 mb-16 flex-wrap">
        {roles.map((role) => (
          <button
            key={role}
            onClick={() => setCurrentRole(role)}
            className={`px-8 py-3 rounded-full font-semibold text-lg transition-all duration-300 cursor-pointer ${
              currentRole === role
                ? "bg-blue-600 text-white shadow-xl scale-105"
                : "bg-white text-gray-700 border border-gray-300 hover:bg-blue-50"
            }`}
          >
            {role.charAt(0).toUpperCase() + role.slice(1)}
          </button>
        ))}
      </div>
            {/* Category Filter Buttons */}
      <div className="flex justify-center gap-3 mb-10 flex-wrap">
        {categories.map((category) => (
          <button
            key={category.value}
            onClick={() => setSelectedCategory(category.value)}
            className={`px-5 py-2 rounded-full font-medium transition-all duration-300 ${
              selectedCategory === category.value
                ? "bg-green-600 text-white shadow-lg"
                : "bg-white text-gray-700 border border-gray-300 hover:bg-green-50"
            }`}
          >
            {category.icon} {category.label}
          </button>
        ))}
      </div>

      <div className="text-center mb-8 sm:mb-12">
        <p className="text-xl font-semibold text-gray-700">
          Total Upcoming Events: {filteredEvents.length}
        </p>
      </div>

      {/* Current View Summary */}
      <div className="w-full max-w-4xl mx-auto bg-white border border-blue-100 rounded-3xl shadow-xl p-6 mb-12">
        <h2 className="text-2xl font-bold text-blue-700 mb-4">
          Current View
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-gray-700">
          <p>
            <span className="font-semibold">Selected Role:</span> {displayRole}
          </p>

          <p>
            <span className="font-semibold">Selected Date:</span>{" "}
            {formattedSelectedDate}
          </p>

          <p>
            <span className="font-semibold">Events on Selected Date:</span>{" "}
            {selectedDateEvents.length}
          </p>

          <p>
            <span className="font-semibold">Total Events for Role:</span>{" "}
            {filteredEvents.length}
          </p>
        </div>
      </div>

      {upcomingEvent && (
        <div className="max-w-4xl mx-auto mb-12 sm:mb-16">
          <div className="bg-gradient-to-r from-yellow-100 to-orange-100 border-l-4 border-yellow-500 p-6 rounded-2xl shadow-lg">
            <h2 className="text-2xl font-bold text-yellow-800 mb-2">
              🌟 Upcoming Event
            </h2>
            <h3 className="text-xl font-semibold text-gray-800">
              {upcomingEvent.title}
            </h3>
            <p className="text-gray-600 mt-1">📅 {upcomingEvent.date}</p>
            <p className="text-gray-700 mt-2">{upcomingEvent.description}</p>
            <div className="mt-4 inline-block bg-red-500 text-white px-4 py-2 rounded-full font-bold">
              ⏳ {getDaysLeft(upcomingEvent.date)} Days Remaining
            </div>
          </div>
        </div>
      )}

      {/* Calendar Section */}
      <div className="flex justify-center mb-16 sm:mb-32 mt-8 sm:mt-12">
        <div className="bg-white p-4 sm:p-8 rounded-3xl shadow-2xl border border-blue-100 sm:scale-125 sm:origin-top">
          <Calendar onChange={setDate} value={date} />
        </div>
      </div>

      <h2 className="text-2xl font-semibold mb-6 text-gray-700">
        Events on {formattedSelectedDate}
      </h2>

      {/* Event Cards */}
      <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-3">
        {selectedDateEvents.length > 0 ? (
          selectedDateEvents.map((event) => (
            <div
              key={event.id}
              className="bg-white rounded-3xl shadow-xl p-6 hover:scale-105 transition-all duration-300 border border-gray-100"
            >
              {/* Card Header */}
              <div className="flex flex-wrap justify-between items-start gap-2 mb-4">
  <h2 className="text-2xl font-bold text-gray-800">
    {event.title}
  </h2>

  <div className="flex gap-2">
    <span className="bg-blue-100 text-blue-700 text-sm px-4 py-1 rounded-full capitalize">
      {event.role}
    </span>

    <span className="bg-green-100 text-green-700 text-sm px-4 py-1 rounded-full">
      {event.category}
    </span>
  </div>
</div>

              <p className="text-gray-500 mb-3 text-lg">📅 {event.date}</p>

              <p className="text-gray-700 leading-relaxed">
                {event.description}
              </p>
            </div>
          ))
        ) : (
          <div className="col-span-full text-center py-10">
            <p className="text-gray-500 text-lg">
              No events found for {displayRole} on {formattedSelectedDate}.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default EventCalendar;