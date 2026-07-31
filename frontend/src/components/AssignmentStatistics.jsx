import React from "react";

const AssignmentStatistics = ({ assignments }) => {
  const totalAssignments = assignments.length;

  const completedAssignments = assignments.filter(
    (a) => a.status === "Completed"
  ).length;

  const pendingAssignments = assignments.filter(
    (a) => a.status === "Pending"
  ).length;

  const overdueAssignments = assignments.filter(
    (a) => a.status === "Overdue"
  ).length;

  const completionPercentage =
    totalAssignments === 0
      ? 0
      : Math.round((completedAssignments / totalAssignments) * 100);

  return (
    <div className="bg-white rounded-3xl shadow-2xl p-8 mb-10">
      <h2 className="text-3xl font-bold text-blue-700 mb-6">
        📊 Assignment Completion Statistics
      </h2>

      {/* Statistics Cards */}
      <div className="grid md:grid-cols-4 gap-6">

        <div className="bg-blue-50 rounded-2xl p-6 text-center shadow">
          <h3 className="text-lg font-semibold">Total</h3>
          <p className="text-4xl font-bold text-blue-700">
            {totalAssignments}
          </p>
        </div>

        <div className="bg-green-50 rounded-2xl p-6 text-center shadow">
          <h3 className="text-lg font-semibold">Completed</h3>
          <p className="text-4xl font-bold text-green-700">
            {completedAssignments}
          </p>
        </div>

        <div className="bg-yellow-50 rounded-2xl p-6 text-center shadow">
          <h3 className="text-lg font-semibold">Pending</h3>
          <p className="text-4xl font-bold text-yellow-700">
            {pendingAssignments}
          </p>
        </div>

        <div className="bg-red-50 rounded-2xl p-6 text-center shadow">
          <h3 className="text-lg font-semibold">Overdue</h3>
          <p className="text-4xl font-bold text-red-700">
            {overdueAssignments}
          </p>
        </div>

      </div>

      {/* Progress */}
      <div className="mt-8">
        <div className="flex justify-between mb-2">
          <span className="font-semibold">
            Assignment Completion
          </span>

          <span className="font-bold">
            {completionPercentage}%
          </span>
        </div>

        <div className="w-full bg-gray-200 rounded-full h-5">
          <div
            className="bg-blue-600 h-5 rounded-full"
            style={{
              width: `${completionPercentage}%`,
            }}
          ></div>
        </div>
      </div>

    </div>
  );
};

export default AssignmentStatistics;