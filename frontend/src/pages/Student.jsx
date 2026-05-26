import React, { useContext } from "react";
import { AuthContext } from "../context/AuthContext";
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

const Student = () => {
  const { user } = useContext(AuthContext);
  const displayName = user?.user?.name || user?.name || "Deepali";

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
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-700 to-indigo-700 text-white rounded-3xl p-8 shadow-2xl mb-10">
        <div className="flex items-center gap-4">
          <div className="bg-white text-blue-700 p-4 rounded-full shadow-lg">
            <User size={32} />
          </div>

          <div>
            <h1 className="text-4xl font-bold">
              Welcome Back, {displayName} 👋
            </h1>

            <p className="text-blue-100 mt-2 text-lg">
              Here’s your academic dashboard overview.
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
              <h2 className="text-3xl font-bold">92%</h2>
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
              <h2 className="text-3xl font-bold">4</h2>
              <p className="text-gray-500">Notifications</p>
            </div>
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

      {/* Study Materials */}
      <div className="bg-white rounded-3xl shadow-2xl p-8">
        <h2 className="text-3xl font-bold text-blue-700 mb-6">
          Study Materials
        </h2>

        <div className="space-y-5">
          {resources.map((resource) => (
            <div
              key={resource.id}
              className="flex items-center justify-between border rounded-2xl p-5 hover:shadow-2xl hover:-translate-y-1 transition duration-300 bg-gradient-to-r from-white to-blue-50"
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