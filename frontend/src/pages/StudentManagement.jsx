import React from "react";
import { Download } from "lucide-react";
import { saveAs } from "file-saver";

const StudentManagement = () => {
  const students = [
    {
      id: 1,
      name: "Rahul Sharma",
      email: "rahul@example.com",
      class: "10A",
      attendance: "92%",
    },
    {
      id: 2,
      name: "Priya Singh",
      email: "priya@example.com",
      class: "10B",
      attendance: "95%",
    },
    {
      id: 3,
      name: "Aman Verma",
      email: "aman@example.com",
      class: "9A",
      attendance: "89%",
    },
  ];

  const exportCSV = () => {
    const headers = ["Name", "Email", "Class", "Attendance"];

    const rows = students.map((student) => [
      student.name,
      student.email,
      student.class,
      student.attendance,
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((row) => row.join(",")),
    ].join("\n");

    const blob = new Blob([csvContent], {
      type: "text/csv;charset=utf-8;",
    });

    saveAs(blob, "students.csv");
  };

  return (
    <div className="min-h-screen bg-gray-100 p-6">
      <div className="max-w-6xl mx-auto bg-white rounded-2xl shadow-lg p-6">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-bold text-blue-700">
            Student Management
          </h1>

          <button
            onClick={exportCSV}
            className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition"
          >
            <Download size={18} />
            Export CSV
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border border-gray-300">
            <thead className="bg-blue-600 text-white">
              <tr>
                <th className="p-3 border">Name</th>
                <th className="p-3 border">Email</th>
                <th className="p-3 border">Class</th>
                <th className="p-3 border">Attendance</th>
              </tr>
            </thead>

            <tbody>
              {students.map((student) => (
                <tr key={student.id} className="text-center">
                  <td className="p-3 border">{student.name}</td>
                  <td className="p-3 border">{student.email}</td>
                  <td className="p-3 border">{student.class}</td>
                  <td className="p-3 border">{student.attendance}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default StudentManagement;