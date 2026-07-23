import React from "react";

const AttendanceAnalytics = ({ overallAttendance, subjects }) => {
  const monthlyAttendance = overallAttendance;

  return (
    <div className="bg-white rounded-3xl shadow-2xl p-8 mb-10">
      <h2 className="text-3xl font-bold text-blue-700 mb-8">
        Attendance Analytics Dashboard
      </h2>

      <div className="mb-10">
        <div className="flex justify-between mb-2">
          <span className="font-semibold">Overall Attendance</span>
          <span className="font-bold text-blue-700">
            {monthlyAttendance}%
          </span>
        </div>

        <div className="w-full bg-gray-200 rounded-full h-5">
          <div
            className="bg-blue-600 h-5 rounded-full"
            style={{ width: `${monthlyAttendance}%` }}
          />
        </div>
      </div>

      <h3 className="text-2xl font-bold mb-5">
        Subject-wise Attendance
      </h3>

      <div className="space-y-5">
       {subjects.map((subject) => (
  <div key={subject.subject}>
    <div className="flex justify-between mb-2">
      <span>{subject.subject}</span>
      <span>{subject.attendance}%</span>
    </div>
            <div className="w-full bg-gray-200 rounded-full h-4">
              <div
                className={`h-4 rounded-full ${
                  subject.attendance < 75
                    ? "bg-red-500"
                    : "bg-green-500"
                }`}
                style={{ width: `${subject.attendance}%` }}
              />
            </div>

            {subject.attendance < 75 && (
              <p className="text-red-600 text-sm mt-1 font-semibold">
                ⚠ Low Attendance
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default AttendanceAnalytics;