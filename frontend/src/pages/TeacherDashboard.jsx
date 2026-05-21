import React from "react";
import {
  Users,
  Bell,
  ClipboardList,
  CalendarDays,
  User,
} from "lucide-react";

const TeacherDashboard = () => {
  const notifications = [
    "Staff meeting scheduled for Monday",
    "Upload student marks before Friday",
    "Science exhibition next week",
  ];

  const classes = [
    {
      id: 1,
      subject: "Mathematics",
      students: 45,
    },
    {
      id: 2,
      subject: "Physics",
      students: 38,
    },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-100 p-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-indigo-700 to-blue-700 text-white rounded-3xl p-8 shadow-2xl mb-10">
        <div className="flex items-center gap-4">
          <div className="bg-white text-indigo-700 p-4 rounded-full">
            <User size={32} />
          </div>

          <div>
            <h1 className="text-4xl font-bold">
              Welcome Back, Teacher 👩‍🏫
            </h1>

            <p className="text-indigo-100 mt-2">
              Manage classes, notifications, and academic activities.
            </p>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid md:grid-cols-3 gap-6 mb-10">
        <div className="bg-white rounded-3xl p-6 shadow-xl">
          <div className="flex items-center gap-4">
            <div className="bg-blue-100 text-blue-700 p-3 rounded-full">
              <Users />
            </div>

            <div>
              <h2 className="text-3xl font-bold">83</h2>
              <p className="text-gray-500">Total Students</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-3xl p-6 shadow-xl">
          <div className="flex items-center gap-4">
            <div className="bg-green-100 text-green-700 p-3 rounded-full">
              <ClipboardList />
            </div>

            <div>
              <h2 className="text-3xl font-bold">12</h2>
              <p className="text-gray-500">Assignments Checked</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-3xl p-6 shadow-xl">
          <div className="flex items-center gap-4">
            <div className="bg-yellow-100 text-yellow-700 p-3 rounded-full">
              <Bell />
            </div>

            <div>
              <h2 className="text-3xl font-bold">5</h2>
              <p className="text-gray-500">Notifications</p>
            </div>
          </div>
        </div>
      </div>

      {/* Classes */}
      <div className="bg-white rounded-3xl shadow-2xl p-8 mb-10">
        <h2 className="text-3xl font-bold text-indigo-700 mb-6">
          Assigned Classes
        </h2>

        <div className="grid md:grid-cols-2 gap-6">
          {classes.map((item) => (
            <div
              key={item.id}
              className="border rounded-2xl p-5 hover:shadow-2xl transition bg-gradient-to-r from-white to-indigo-50"
            >
              <h3 className="text-2xl font-bold text-gray-800">
                {item.subject}
              </h3>

              <p className="text-gray-500 mt-3">
                Students: {item.students}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Notifications */}
      <div className="bg-white rounded-3xl shadow-2xl p-8">
        <h2 className="text-3xl font-bold text-indigo-700 mb-6">
          Upcoming Tasks & Notifications
        </h2>

        <div className="space-y-4">
          {notifications.map((note, index) => (
            <div
              key={index}
              className="flex items-center gap-4 border rounded-2xl p-5 bg-gradient-to-r from-white to-blue-50"
            >
              <CalendarDays className="text-indigo-600" />

              <p className="text-gray-700 font-medium">
                {note}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default TeacherDashboard;