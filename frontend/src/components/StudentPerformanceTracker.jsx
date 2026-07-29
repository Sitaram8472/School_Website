import React from "react";

const StudentPerformanceTracker = ({ performanceData }) => {
  return (
    <div className="bg-white rounded-3xl shadow-2xl p-8 mb-10">
      <h2 className="text-3xl font-bold text-blue-700 mb-6">
        📈 Student Performance Progress Tracker
      </h2>

      <div className="grid md:grid-cols-2 gap-6">
        {performanceData.map((subject, index) => (
          <div
            key={index}
            className="border rounded-2xl p-6 bg-gradient-to-br from-white to-blue-50 shadow hover:shadow-xl transition"
          >
            <h3 className="text-2xl font-bold text-gray-800 mb-4">
              {subject.subject}
            </h3>

            <div className="space-y-2">
              <p>
                <strong>Current Marks:</strong> {subject.marks}/100
              </p>

              <p>
                <strong>Percentage:</strong> {subject.percentage}%
              </p>

              <p>
                <strong>Grade:</strong> {subject.grade}
              </p>

              <p>
                <strong>Improvement:</strong>{" "}
                <span
                  className={`font-semibold ${
                    subject.trend.startsWith("+")
                      ? "text-green-600"
                      : "text-red-600"
                  }`}
                >
                  {subject.trend}
                </span>
              </p>
            </div>

            {/* Progress Bar */}
            <div className="mt-5">
              <div className="w-full bg-gray-200 rounded-full h-4">
                <div
                  className="bg-blue-600 h-4 rounded-full"
                  style={{ width: `${subject.percentage}%` }}
                ></div>
              </div>

              <p className="text-right text-sm mt-2 font-semibold">
                {subject.percentage}%
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default StudentPerformanceTracker;