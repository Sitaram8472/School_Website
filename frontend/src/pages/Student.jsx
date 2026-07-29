import React, { useContext } from "react";
import { AuthContext } from "../context/AuthContext";
import { getUserRole } from "../utils/permissions";
import {
  BookOpen,
  ClipboardCheck,
  Download,
  Bell,
  User,
  CheckSquare,
  FileText
} from "lucide-react";
import { Link } from "react-router-dom";
import api from "../utils/axios";

import physicsNotes from "../assets/prospectus/physics-notes.pdf";
import chemistryLab from "../assets/prospectus/chemistry-lab.pdf";
import mathFormulas from "../assets/prospectus/math-formulas.pdf";
import attendanceData from "../data/attendance";
import AttendanceAnalytics from "../components/AttendanceAnalytics";
import AssignmentStatistics from "../components/AssignmentStatistics";
import StudentPerformanceTracker from "../components/StudentPerformanceTracker";
const Student = () => {
  const { user } = useContext(AuthContext);
  const displayName = getUserRole(user) ? (user?.name || user?.user?.name || "Student") : "Student";
  const [exams, setExams] = React.useState([]);
  const [isGenerating, setIsGenerating] = React.useState(false);
  const [searchTerm, setSearchTerm] = React.useState("");
const [selectedSubject, setSelectedSubject] = React.useState("All");

  const handleDownloadReport = async () => {
    try {
      setIsGenerating(true);
      const studentId = user?.id || user?.user?._id || user?._id;
      if (!studentId) throw new Error("Student ID not found");

      const response = await api.get(`/reports/student/${studentId}`, {
        responseType: 'blob', // Important for file downloads
      });

      // Create blob link to download
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `Report_Card_${displayName.replace(/\s+/g, '_')}.pdf`);
      
      // Append to html link element page
      document.body.appendChild(link);
      
      // Start download
      link.click();
      
      // Clean up and remove the link
      link.parentNode.removeChild(link);
    } catch (error) {
      console.error("Error downloading report:", error);
      alert("Failed to generate report card. Please try again later.");
    } finally {
      setIsGenerating(false);
    }
  };

  React.useEffect(() => {
    const fetchExams = async () => {
      try {
        const res = await api.get('/exams');
        setExams(res.data.data);
      } catch (err) {
        console.error("Error fetching exams:", err);
      }
    };
    fetchExams();
  }, []);

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
    title: "Linear Algebra Assignment",
    subject: "Mathematics",
    dueDate: "2026-08-05",
     status:"Completed",
    details: "Complete Chapters 1 to 4 and submit the worksheet.",
    link: "#",
  },
  {
    id: 2,
    title: "Physics Lab Report",
    subject: "Physics",
    dueDate: "2026-08-02",
    status: "Pending",
    details: "Submit the optics experiment report.",
    link: "#",
  },
  {
    id: 3,
    title: "Chemistry Assignment",
    subject: "Chemistry",
    dueDate: "2026-08-01",
    status: "Pending",
    details: "Prepare organic chemistry notes.",
    link: "#",
  },
  {
    id: 4,
    title: "Programming Exercise",
    subject: "Computer Science",
    dueDate: "2026-08-08",
    status: "Overdue",
    details: "Complete React component exercises.",
    link: "#",
 },
];
const getAssignmentStatus = (dueDate) => {
  const today = new Date();
  const due = new Date(dueDate);

  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);

  const diff = Math.ceil((due - today) / (1000 * 60 * 60 * 24));

  if (diff < 0) return "Overdue";
  if (diff === 0) return "Due Today";
  return "Upcoming";
};

const getDaysRemaining = (dueDate) => {
  const today = new Date();
  const due = new Date(dueDate);

  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);

  return Math.ceil((due - today) / (1000 * 60 * 60 * 24));
};

const filteredAssignments = assignments
  .filter(
    (assignment) =>
      (selectedSubject === "All" ||
        assignment.subject === selectedSubject) &&
      assignment.title
        .toLowerCase()
        .includes(searchTerm.toLowerCase())
  )
  .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

const subjects = [
  "All",
  ...new Set(assignments.map((a) => a.subject)),
];
// Student Performance Data
const performanceData = [
  {
    subject: "Mathematics",
    marks: 92,
    percentage: 92,
    grade: "A+",
    trend: "+5%",
  },
  {
    subject: "Physics",
    marks: 84,
    percentage: 84,
    grade: "A",
    trend: "+3%",
  },
  {
    subject: "Chemistry",
    marks: 76,
    percentage: 76,
    grade: "B+",
    trend: "-2%",
  },
  {
    subject: "Computer Science",
    marks: 95,
    percentage: 95,
    grade: "A+",
    trend: "+7%",
  },
];


// 👇 Your existing code continues here



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
          
          <div className="ml-auto">
            <button 
              onClick={handleDownloadReport} 
              disabled={isGenerating}
              className={`flex items-center gap-2 bg-white text-blue-700 px-6 py-3 rounded-xl font-bold shadow-lg transition duration-300 ${isGenerating ? 'opacity-75 cursor-not-allowed' : 'hover:bg-blue-50 hover:shadow-xl hover:-translate-y-1'}`}
            >
              <FileText size={20} />
              {isGenerating ? "Generating PDF..." : "Download Report Card"}
            </button>
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
<AttendanceAnalytics
  overallAttendance={monthlyAttendancePercentage}
  subjects={attendanceData.subjectAttendance}
/>
<AssignmentStatistics assignments={assignments} />
<StudentPerformanceTracker performanceData={performanceData} />
     {/* Assignment Submission Deadline Tracker */}
<div className="bg-white rounded-3xl shadow-2xl p-8 mb-10">
  <h2 className="text-3xl font-bold text-blue-700 mb-6">
    Assignment Submission Deadline Tracker
  </h2>

  {/* Search & Filter */}
  <div className="flex flex-col md:flex-row gap-4 mb-6">
    <input
      type="text"
      placeholder="Search assignments..."
      value={searchTerm}
      onChange={(e) => setSearchTerm(e.target.value)}
      className="border rounded-xl p-3 flex-1"
    />

    <select
      value={selectedSubject}
      onChange={(e) => setSelectedSubject(e.target.value)}
      className="border rounded-xl p-3"
    >
      {subjects.map((subject) => (
        <option key={subject} value={subject}>
          {subject}
        </option>
      ))}
    </select>
  </div>

  <div className="grid md:grid-cols-2 gap-6">
    {filteredAssignments.map((assignment) => {
      const status = getAssignmentStatus(assignment.dueDate);
      const days = getDaysRemaining(assignment.dueDate);

      return (
        <div
          key={assignment.id}
          className="border rounded-2xl p-5 bg-gradient-to-br from-white to-blue-50 hover:shadow-xl transition"
        >
          <h3 className="text-2xl font-bold">
            {assignment.title}
          </h3>

          <p className="mt-2">
            <strong>Subject:</strong> {assignment.subject}
          </p>

          <p>
  <strong>Due:</strong>{" "}
  {new Date(assignment.dueDate).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  })}
</p>

          <p className="mt-2 text-gray-600">
            {assignment.details}
          </p>

          <p className="mt-3 font-semibold">
            {days > 0
              ? `⏳ ${days} Days Left`
              : days === 0
              ? "⏰ Due Today"
              : `⚠️ ${Math.abs(days)} Days Overdue`}
          </p>

          <span
            className={`inline-block mt-3 px-4 py-1 rounded-full text-white ${
              status === "Upcoming"
                ? "bg-green-600"
                : status === "Due Today"
                ? "bg-yellow-500"
                : "bg-red-600"
            }`}
          >
            {status}
          </span>

          <div className="mt-5">
            <a
              href={assignment.link}
              className="bg-blue-600 text-white px-5 py-2 rounded-xl hover:bg-blue-700"
            >
              View Details
            </a>
          </div>
        </div>
      );
    })}
  </div>
</div>

      {/* Available Exams */}
      <div className="bg-white rounded-3xl shadow-2xl p-8 mb-10">
        <h2 className="text-3xl font-bold text-blue-700 mb-6 flex items-center gap-3">
          <CheckSquare /> Available Exams
        </h2>

        <div className="grid md:grid-cols-2 gap-6">
          {exams.length > 0 ? exams.map((exam) => (
            <div
              key={exam._id}
              className="border rounded-2xl p-5 hover:shadow-2xl hover:-translate-y-1 transition duration-300 bg-gradient-to-br from-white to-blue-50 flex flex-col justify-between"
            >
              <div>
                <h3 className="text-2xl font-bold text-gray-800">{exam.title}</h3>
                <p className="text-gray-500 mt-2 text-lg">Course: {exam.course?.name || "General"}</p>
                <div className="text-blue-600 mt-3 font-semibold flex gap-4">
                  <span>⏱ {exam.timeLimit} mins</span>
                  <span>❓ {exam.questions.length} Questions</span>
                </div>
              </div>
              <Link
                to={`/student/exam/${exam._id}`}
                className="mt-6 text-center bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded-xl transition duration-300 shadow-md"
              >
                Take Exam
              </Link>
            </div>
          )) : (
            <div className="col-span-2 text-center text-gray-500 py-6 text-lg">
              No exams available right now. Check back later!
            </div>
          )}
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