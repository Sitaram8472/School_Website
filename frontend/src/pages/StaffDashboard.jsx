import React from "react";
import {
  Bell,
  Briefcase,
  CalendarCheck,
  ClipboardCheck,
  User,
} from "lucide-react";

const StaffDashboard = () => {
  const notifications = [
    "Administrative meeting on Wednesday",
    "Update inventory records",
    "Submit monthly maintenance report",
  ];

  const tasks = [
    {
      id: 1,
      title: "Campus Maintenance",
      status: "In Progress",
    },
    {
      id: 2,
      title: "Library Inventory Update",
      status: "Pending",
    },
  ];

  return (
    <div className="min-h-screen bg-slate-100 p-6">
      
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-3xl p-8 shadow-xl mb-10">
        <div className="flex items-center gap-4">
          
          <div className="bg-white text-blue-600 p-4 rounded-full">
            <User size={32} />
          </div>

          <div>
            <h1 className="text-4xl font-bold">
              Welcome Back, Staff 👨‍💼
            </h1>

            <p className="text-blue-100 mt-2 text-lg">
              Manage administrative tasks and campus operations efficiently.
            </p>
          </div>

        </div>
      </div>

      {/* Stats */}
      <div className="grid md:grid-cols-3 gap-6 mb-10">

        <div className="bg-white rounded-3xl p-6 shadow-lg hover:shadow-2xl transition">
          <div className="flex items-center gap-4">
            
            <div className="bg-blue-100 text-blue-600 p-3 rounded-full">
              <Briefcase />
            </div>

            <div>
              <h2 className="text-3xl font-bold text-slate-800">14</h2>
              <p className="text-gray-500">Pending Tasks</p>
            </div>

          </div>
        </div>

        <div className="bg-white rounded-3xl p-6 shadow-lg hover:shadow-2xl transition">
          <div className="flex items-center gap-4">

            <div className="bg-indigo-100 text-indigo-600 p-3 rounded-full">
              <ClipboardCheck />
            </div>

            <div>
              <h2 className="text-3xl font-bold text-slate-800">9</h2>
              <p className="text-gray-500">Completed Reports</p>
            </div>

          </div>
        </div>

        <div className="bg-white rounded-3xl p-6 shadow-lg hover:shadow-2xl transition">
          <div className="flex items-center gap-4">

            <div className="bg-yellow-100 text-yellow-600 p-3 rounded-full">
              <Bell />
            </div>

            <div>
              <h2 className="text-3xl font-bold text-slate-800">3</h2>
              <p className="text-gray-500">Notifications</p>
            </div>

          </div>
        </div>

      </div>

      {/* Tasks Section */}
      <div className="bg-white rounded-3xl shadow-xl p-8 mb-10">

        <h2 className="text-3xl font-bold text-blue-600 mb-6">
          Assigned Tasks
        </h2>

        <div className="grid md:grid-cols-2 gap-6">

          {tasks.map((task) => (
            <div
              key={task.id}
              className="border border-slate-200 rounded-2xl p-5 hover:shadow-xl transition bg-slate-50"
            >
              <h3 className="text-2xl font-bold text-slate-800">
                {task.title}
              </h3>

              <p className="text-gray-500 mt-3">
                Status: {task.status}
              </p>
            </div>
          ))}

        </div>
      </div>

      {/* Notifications */}
      <div className="bg-white rounded-3xl shadow-xl p-8">

        <h2 className="text-3xl font-bold text-blue-600 mb-6">
          Notifications & Updates
        </h2>

        <div className="space-y-4">

          {notifications.map((note, index) => (
            <div
              key={index}
              className="flex items-center gap-4 border border-slate-200 rounded-2xl p-5 bg-slate-50 hover:shadow-lg transition"
            >
              <CalendarCheck className="text-blue-600" />

              <p className="text-slate-700 font-medium">
                {note}
              </p>
            </div>
          ))}

        </div>
      </div>

    </div>
  );
};

export default StaffDashboard;