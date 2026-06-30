import React, { useState, useContext } from "react";
import { AuthContext } from "../context/AuthContext";
import { teachers } from "../data/Teachers";
import AttendanceManager from "../components/AttendanceManager";
import TeacherCard from "../components/TeacherCard";
import API from "../utils/axios";
import { hasPermission, getUserRole } from "../utils/permissions";
import { BookOpen, Calendar, Send, Sparkles, CheckCircle2, AlertCircle } from "lucide-react";

export default function Teacher() {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const canCreateNotice = hasPermission(role, "create_notice");
  const canManageAttendance = hasPermission(role, "manage_attendance");
  const teacherName = user?.name || user?.user?.name;

  // Notice form state
  const [noticeData, setNoticeData] = useState({
    title: "",
    category: "General",
    content: "",
  });
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  const handleInputChange = (e) => {
    setNoticeData({ ...noticeData, [e.target.name]: e.target.value });
  };

  const handlePostNotice = async (e) => {
    e.preventDefault();
    setSuccess("");
    setError("");

    if (!noticeData.title.trim() || !noticeData.content.trim()) {
      setError("Please fill in all fields.");
      return;
    }

    try {
      setLoading(true);
      await API.post("/notices", noticeData);
      setSuccess("Notice published successfully! It is now live on the homepage Notice Board.");
      setNoticeData({ title: "", category: "General", content: "" });
    } catch (err) {
      console.error(err);
      setError("Failed to publish notice. Please ensure your backend is running.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-[var(--bg-primary)] py-16 animate-in fade-in duration-500 min-h-screen">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        
        {/* ========================================== */}
        {/* TEACHER DASHBOARD VIEW (AUTHENTICATED ONLY) */}
        {/* ========================================== */}
        {canCreateNotice && (
          <div className="mb-20">
            {/* Dashboard Header */}
            <div className="bg-gradient-to-r from-slate-900 via-blue-900 to-slate-900 text-white rounded-3xl p-8 shadow-2xl mb-10 relative overflow-hidden">
              <div className="absolute top-0 right-0 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl"></div>
              <div className="relative z-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                <div>
                  <div className="flex items-center gap-2 text-blue-400 font-bold mb-2">
                    <Sparkles size={16} />
                    <span className="uppercase tracking-widest text-xs">Faculty Portal</span>
                  </div>
                  <h1 className="text-3xl font-extrabold">
                    Welcome Back, Prof. {teacherName} 🎓
                  </h1>
                  <p className="text-slate-300 mt-1">
                    Manage classes, create announcements, and coordinate STEM projects.
                  </p>
                </div>
                <div className="flex gap-4">
                  <div className="bg-white/10 backdrop-blur-md px-4 py-2 rounded-xl text-center border border-white/10">
                    <span className="block text-2xl font-bold">42</span>
                    <span className="text-[10px] text-slate-300 uppercase font-semibold">Students</span>
                  </div>
                  <div className="bg-white/10 backdrop-blur-md px-4 py-2 rounded-xl text-center border border-white/10">
                    <span className="block text-2xl font-bold">4</span>
                    <span className="text-[10px] text-slate-300 uppercase font-semibold">Classes</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Dashboard Workspace */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              {/* Notice Posting Form */}
              <div className="lg:col-span-2 bg-white rounded-3xl border border-slate-200 shadow-sm p-8">
                <h2 className="text-2xl font-bold text-slate-900 mb-6 flex items-center gap-2">
                  <BookOpen className="text-blue-600" />
                  Publish New Notice
                </h2>

                <form onSubmit={handlePostNotice} className="space-y-5">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    <div>
                      <label className="block text-sm font-semibold text-slate-700 mb-2">Notice Title</label>
                      <input
                        type="text"
                        name="title"
                        value={noticeData.title}
                        onChange={handleInputChange}
                        placeholder="e.g. Science Lab Timings"
                        className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition-all"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-slate-700 mb-2">Category</label>
                      <select
                        name="category"
                        value={noticeData.category}
                        onChange={handleInputChange}
                        className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition-all"
                      >
                        <option value="General">General</option>
                        <option value="Academic">Academic</option>
                        <option value="Holiday">Holiday</option>
                        <option value="Events">Events</option>
                        <option value="Excellence">Excellence</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-2">Notice Details</label>
                    <textarea
                      name="content"
                      rows="4"
                      value={noticeData.content}
                      onChange={handleInputChange}
                      placeholder="Write your announcement details here..."
                      className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition-all resize-none"
                    ></textarea>
                  </div>

                  {error && (
                    <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl">
                      <AlertCircle size={20} />
                      <p className="text-sm">{error}</p>
                    </div>
                  )}

                  {success && (
                    <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 p-4 rounded-xl">
                      <CheckCircle2 size={20} />
                      <p className="text-sm">{success}</p>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-xl transition-all flex items-center justify-center gap-2 shadow-lg disabled:opacity-50"
                  >
                    <Send size={18} />
                    {loading ? "Publishing..." : "Post Announcement"}
                  </button>
                </form>
              </div>

              {/* Class Schedule / Updates */}
              <div className="bg-[var(--card-bg)] rounded-3xl border border-slate-200 shadow-sm p-8 flex flex-col justify-between">
                <div>
                  <h2 className="text-2xl font-bold text-[var(--text-primary)] mb-6 flex items-center gap-2">
                    <Calendar className="text-blue-600" />
                    Today's Schedule
                  </h2>
                  <div className="space-y-4">
                    {[
                      { time: "09:00 AM", sub: "Quantum Physics", room: "Lab 3A" },
                      { time: "11:30 AM", sub: "AP Calculus", room: "Hall B" },
                      { time: "02:00 PM", sub: "Mentorship Session", room: "Office 204" },
                    ].map((sched, idx) => (
                      <div key={idx} className="flex gap-4 p-3 bg-[var(--bg-secondary)] rounded-xl border border-slate-100">
                        <div className="text-xs font-bold text-blue-600 bg-blue-50 p-2 rounded-lg flex items-center justify-center min-w-[75px]">
                          {sched.time}
                        </div>
                        <div>
                          <h4 className="font-bold text-sm text-[var(--text-primary)]">{sched.sub}</h4>
                          <span className="text-xs text-slate-500">{sched.room}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="pt-6 border-t border-slate-100 mt-6">
                  <div className="text-xs text-slate-400 text-center font-medium">
                    EduStream Academy Faculty Portal &copy; 2026
                  </div>
                </div>
              </div>
            </div>
            
            {/* Divider */}
            <div className="w-full h-px bg-[var(--border-color)] my-16"></div>
          </div>
        )}

        {/* ========================================== */}
        {/* PUBLIC FACULTY DIRECTORY VIEW              */}
        {/* ========================================== */}
        
        {/* Header */}
        <div className="text-center mb-20">
          <h2 className="text-4xl font-bold text-[var(--text-primary)] mb-6">
            World-Class Educators
          </h2>
          <div className="w-24 h-1.5 bg-blue-600 mx-auto rounded-full mb-6"></div>
          <p className="text-slate-500 max-w-2xl mx-auto text-lg leading-relaxed">
            Our faculty members bring a wealth of practical experience, scholastic integrity, and academic rigor to every classroom.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-10">
          {teachers.map((teacher) => (
            <TeacherCard key={teacher.id} teacher={teacher} />
          ))}
        </div>
        {canManageAttendance && <AttendanceManager />}
      </div>
    </div>
  );
}
