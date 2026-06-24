import React, { useState } from "react";
import Calendar from "react-calendar";
import "react-calendar/dist/Calendar.css";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

import events from "../data/events";

const roles = ["student", "teacher", "staff"];

const getDaysLeft = (eventDate) => {
  const today = new Date();
  const targetDate = new Date(eventDate);

  const difference = targetDate - today;

  return Math.ceil(difference / (1000 * 60 * 60 * 24));
};

const EventCalendar = () => {
  const [date, setDate] = useState(new Date());
  const [currentRole, setCurrentRole] = useState("student");

  const filteredEvents = events.filter((event) => event.role === currentRole);
  const selectedDate = date.toISOString().split("T")[0];

  const selectedDateEvents = filteredEvents.filter(
    (event) => event.date === selectedDate,
  );

  const upcomingEvent = filteredEvents.find((event) => getDaysLeft(event.date) >= 0);

  const exportPDF = () => {
    const doc = new jsPDF();
    autoTable(doc, {
      head: [["Title", "Date", "Role", "Description"]],
      body: filteredEvents.map((event) => [
        event.title,
        event.date,
        event.role,
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

      <div className="text-center mb-8 sm:mb-12">
        <p className="text-xl font-semibold text-gray-700">
          Total Upcoming Events: {filteredEvents.length}
        </p>
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
        Events on {selectedDate}
      </h2>

      {/* Event Cards - Fixed Section */}
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
                <span className="bg-blue-100 text-blue-700 text-sm px-4 py-1 rounded-full capitalize">
                  {event.role}
                </span>
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
              No events scheduled for this date.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default EventCalendar;
