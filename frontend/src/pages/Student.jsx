import React, { useContext } from "react";
import { AuthContext } from "../context/AuthContext";
import { getUserRole } from "../utils/permissions";
import {
  BookOpen,
  ClipboardCheck,
  Download,
  Bell,
  User,
} from "lucide-react";

import physicsNotes from "../assets/prospectus/physics-notes.pdf";
import chemistryLab from "../assets/prospectus/chemistry-lab.pdf";
import mathFormulas from "../assets/prospectus/math-formulas.pdf";
import attendanceData from "../data/attendance";

const Student = () => {
  const { user } = useContext(AuthContext);
  const displayName = getUserRole(user) ? (user?.name || user?.user?.name || "Student") : "Student";

  const savedAttendance = JSON.parse(localStorage.getItem("attendanceRecords"));

  // Calculate attendance data with proper fallbacks
  const presentClasses = savedAttendance
    ? Object.values(savedAttendance).filter((status) => status === "Present").length
    : 0;

  const totalClasses = savedAttendance
    ? Object.keys(savedAttendance).length
    : 0;

  const attendancePercentage = totalClasses > 0 
    ? ((presentClasses / totalClasses) * 100).toFixed(0)
    : 0;
    
  const absentClasses = totalClasses - presentClasses;
  
  const monthlyAttendancePercentage = attendanceData?.monthlyReport
    ? ((attendanceData.monthlyReport.presentClasses / attendanceData.monthlyReport.totalClasses) * 100).toFixed(0)
    : 0;

  const assignments = [
    {
      id: 1,
      title: "Math Assignment",
      subject: "Mathematics",
      due: "25 May 2026",
    },
    {
      id: 2,
      title: "Science Project",
      subject: "Science",
      due: "28 May 2026",
    },
  ];

  const notifications = [
    {
      id: 1,
      title: "New Notice Released",
      message: "School annual function scheduled for June 15.",
      type: "notice",
    },
    {
      id: 2,
      title: "Assignment Reminder",
      message: "Math assignment due tomorrow.",
      type: "assignment",
    },
    {
      id: 3,
      title: "Event Alert",
      message: "Science exhibition registration is open.",
      type: "event",
    },
    {
      id: 4,
      title: "Parent Meeting Reminder",
      message: "Parent-teacher meeting will be held on June 20.",
      type: "parent",
    },
  ];

  const resources = [
    {
      id: 1,
      name: "Physics Notes",
      file: physicsNotes,
    },
    {
      id: 2,
      name: "Chemistry Lab Manual",
      file: chemistryLab,
    },
    {
      id: 3,
      name: "Math Formulas",
      file: mathFormulas,
    },
  ];

  return (
    <div
      className="min-h-screen p-4 sm:p-6 overflow-hidden"
      style={{
        background: "var(--bg-primary)",
        color: "var(--text-primary)",
      }}
    >
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-700 to-indigo-700 text-white rounded-3xl p-8 shadow-2xl mb-10">
        <div className="flex items-center gap-4">
          <div className="bg-white text-blue-700 p-4 rounded-full shadow-lg">
            <User size={32} />
          </div>

          <div>
            <h1 className="text-2xl sm:text-4xl font-bold">
              Welcome Back, {displayName} 👋
            </h1>

            <p className="text-blue-100 mt-2 text-lg">
              Here's your academic dashboard overview.
            </p>
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid md:grid-cols-3 gap-6 mb-10">
        <div className="bg-white rounded-3xl p-6 shadow-lg hover:shadow-2xl hover:-translate-y-1 transition duration-300">
          <div className="flex items-center gap-4">
            <div className="bg-blue-100 p-3 rounded-full text-blue-700">
              <BookOpen />
            </div>

            <div>
              <h2 className="text-3xl font-bold">8.9 CGPA</h2>
              <p className="text-gray-500">Current Grades</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-3xl p-6 shadow-lg hover:shadow-2xl hover:-translate-y-1 transition duration-300">
          <div className="flex items-center gap-4">
            <div className="bg-green-100 p-3 rounded-full text-green-700">
              <ClipboardCheck />
            </div>

            <div>
              <h2 className="text-3xl font-bold">{attendancePercentage}%</h2>
              <p className="text-gray-500">Attendance</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-3xl p-6 shadow-lg hover:shadow-2xl hover:-translate-y-1 transition duration-300">
          <div className="flex items-center gap-4">
            <div className="bg-yellow-100 p-3 rounded-full text-yellow-700">
              <Bell />
            </div>

            <div>
              <h2 className="text-3xl font-bold">{notifications.length}</h2>
              <p className="text-gray-500">Notifications</p>
            </div>
          </div>
        </div>
      </div>

      {/* Attendance Summary */}
      <div className="bg-white rounded-3xl shadow-2xl p-8 mb-10">
        <h2 className="text-3xl font-bold text-blue-700 mb-6">
          Attendance Summary
        </h2>

        <div className="grid md:grid-cols-4 gap-6">
          <div>
            <h3 className="text-xl font-semibold text-gray-700">
              Total Classes
            </h3>
            <p className="text-3xl font-bold">{totalClasses}</p>
          </div>

          <div>
            <h3 className="text-xl font-semibold text-gray-700">Present</h3>
            <p className="text-3xl font-bold text-green-600">
              {presentClasses}
            </p>
          </div>

          <div>
            <h3 className="text-xl font-semibold text-gray-700">Absent</h3>
            <p className="text-3xl font-bold text-red-600">{absentClasses}</p>
          </div>

          <div>
            <h3 className="text-xl font-semibold text-gray-700">
              Attendance %
            </h3>
            <p className="text-3xl font-bold text-blue-600">
              {attendancePercentage}%
            </p>
          </div>
        </div>
      </div>

      {/* Monthly Attendance Report */}
      <div className="bg-white rounded-3xl shadow-2xl p-8 mb-10">
        <h2 className="text-3xl font-bold text-blue-700 mb-6">
          Monthly Attendance Report
        </h2>

        <div className="grid md:grid-cols-4 gap-6">
          <div>
            <h3 className="text-xl font-semibold text-gray-700">Month</h3>
            <p className="text-2xl font-bold">
              {attendanceData?.monthlyReport?.month || "N/A"}
            </p>
          </div>

          <div>
            <h3 className="text-xl font-semibold text-gray-700">Present</h3>
            <p className="text-2xl font-bold text-green-600">
              {attendanceData?.monthlyReport?.presentClasses || 0}
            </p>
          </div>

          <div>
            <h3 className="text-xl font-semibold text-gray-700">
              Total Classes
            </h3>
            <p className="text-2xl font-bold">
              {attendanceData?.monthlyReport?.totalClasses || 0}
            </p>
          </div>

          <div>
            <h3 className="text-xl font-semibold text-gray-700">Percentage</h3>
            <p className="text-2xl font-bold text-blue-600">
              {monthlyAttendancePercentage}%
            </p>
          </div>
        </div>
      </div>

      {/* Assignments */}
      <div className="bg-white rounded-3xl shadow-2xl p-8 mb-10">
        <h2 className="text-3xl font-bold text-blue-700 mb-6">
          Upcoming Assignments
        </h2>

        <div className="grid md:grid-cols-2 gap-6">
          {assignments.map((assignment) => (
            <div
              key={assignment.id}
              className="border rounded-2xl p-5 hover:shadow-2xl hover:-translate-y-1 transition duration-300 bg-gradient-to-br from-white to-blue-50"
            >
              <h3 className="text-2xl font-bold text-gray-800">
                {assignment.title}
              </h3>

              <p className="text-gray-500 mt-2 text-lg">
                Subject: {assignment.subject}
              </p>

              <p className="text-red-500 mt-3 font-semibold">
                Due: {assignment.due}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Notification Center */}
      <div className="bg-white rounded-3xl shadow-2xl p-8 mb-10">
        <h2 className="text-3xl font-bold text-blue-700 mb-6">
          Notification Center
        </h2>

        <div className="space-y-4">
          {notifications.map((notification) => (
            <div
              key={notification.id}
              className="border rounded-2xl p-5 bg-gradient-to-r from-white to-blue-50 hover:shadow-xl transition duration-300"
            >
              <h3 className="text-xl font-bold text-gray-800">
                {notification.title}
              </h3>

              <p className="text-gray-600 mt-2">{notification.message}</p>

              <span className="text-sm text-blue-600 font-medium">
                {notification.type}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Study Materials */}
      <div className="bg-white rounded-3xl shadow-2xl p-8">
        <h2 className="text-3xl font-bold text-blue-700 mb-6">
          Study Materials
        </h2>

        <div className="space-y-5">
          {resources.map((resource) => (
            <div
              key={resource.id}
              className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border rounded-2xl p-5 hover:shadow-2xl hover:-translate-y-1 transition duration-300 bg-gradient-to-r from-white to-blue-50"
            >
              <p className="font-semibold text-gray-700 text-lg">
                {resource.name}
              </p>

              <a
                href={resource.file}
                download
                className="bg-blue-600 hover:bg-blue-700 hover:scale-105 text-white px-5 py-3 rounded-xl flex items-center gap-2 transition duration-300 shadow-lg"
              >
                <Download size={18} />
                Download
              </a>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Student;