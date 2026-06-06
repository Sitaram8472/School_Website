import React, { useState } from "react";

const AttendanceManager = () => {
  const [attendance, setAttendance] = useState({
    Rahul: "Present",
    Priya: "Present",
  });

  const saveAttendance = () => {
    localStorage.setItem("attendanceRecords", JSON.stringify(attendance));

    alert("Attendance Saved Successfully!");
  };
  return (
    <div className="bg-white rounded-3xl p-8 shadow-lg mt-10">
      <h2 className="text-3xl font-bold text-blue-700 mb-6">
        Attendance Management
      </h2>

      <div className="space-y-4">
        <div className="flex justify-between items-center border p-4 rounded-xl">
          <span className="font-medium">Rahul</span>

          <select
            className="border rounded-lg px-3 py-2"
            value={attendance.Rahul}
            onChange={(e) =>
              setAttendance({ ...attendance, Rahul: e.target.value })
            }
          >
            <option>Present</option>
            <option>Absent</option>
          </select>
        </div>

        <div className="flex justify-between items-center border p-4 rounded-xl">
          <span className="font-medium">Priya</span>

          <select
            className="border rounded-lg px-3 py-2"
            value={attendance.Priya}
            onChange={(e) =>
              setAttendance({
                ...attendance,
                Rahul: e.target.value,
              })
            }
          >
            <option>Present</option>
            <option>Absent</option>
          </select>
        </div>

        <button
          onClick={saveAttendance}
          className="bg-blue-600 text-white px-6 py-3 rounded-xl hover:bg-blue-700"
        >
          Save Attendance
        </button>
      </div>
    </div>
  );
};

export default AttendanceManager;
