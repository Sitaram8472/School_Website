import { useState, useEffect, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import NoticePanel from '../components/teacher/NoticePanel';
import ResourcePanel from '../components/teacher/ResourcePanel';
import AttendancePanel from '../components/teacher/AttendancePanel';

const TeacherDashboard = () => {
  const [stats, setStats] = useState(null);
  const [activeTab, setActiveTab] = useState('notices');
  const navigate = useNavigate();
  const { user, logout } = useContext(AuthContext);

  // user from AuthContext is the full login response: { token, user: { id, name, email, role } }
  const userInfo = user?.user;

  useEffect(() => {
    if (!user || userInfo?.role !== 'teacher') {
      navigate('/login');
    }
  }, [user]);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await api.get('/teacher/stats');
        setStats(res.data.stats);
      } catch (err) { console.error(err); }
    };
    if (userInfo?.role === 'teacher') fetchStats();
  }, [userInfo]);

  const tabs = [
    { id: 'notices',    label: 'Notices' },
    { id: 'resources',  label: 'Resources' },
    { id: 'attendance', label: 'Attendance' },
  ];

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="max-w-5xl mx-auto px-4 py-8">

        {/* Welcome Header */}
        <div className="bg-gradient-to-r from-blue-600 to-indigo-700 rounded-2xl p-6 mb-6 text-white">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold">
                Welcome, {userInfo?.name || 'Teacher'}!
              </h1>
              <p className="text-blue-100 mt-1 text-sm">Teacher Dashboard — EduStream Academy</p>
            </div>
            <button
              onClick={() => { logout(); navigate('/'); }}
              className="text-xs bg-white/20 hover:bg-white/30 text-white px-4 py-2 rounded-lg transition"
            >
              Logout
            </button>
          </div>

          {stats && (
            <div className="grid grid-cols-3 gap-4 mt-5">
              {[
                { label: 'Notices Posted',     value: stats.noticesPosted },
                { label: 'Resources Uploaded', value: stats.resourcesUploaded },
                { label: 'Attendance Records', value: stats.attendanceRecords },
              ].map(s => (
                <div key={s.label} className="bg-white/15 rounded-xl p-4 text-center">
                  <div className="text-2xl font-bold">{s.value}</div>
                  <div className="text-xs text-blue-100 mt-1">{s.label}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Tab Navigation */}
        <div className="flex gap-2 mb-6 bg-white rounded-xl p-1 shadow">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition ${
                activeTab === tab.id
                  ? 'bg-blue-600 text-white shadow'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'notices'    && <NoticePanel />}
        {activeTab === 'resources'  && <ResourcePanel />}
        {activeTab === 'attendance' && <AttendancePanel />}
      </div>
    </div>
  );
};

export default TeacherDashboard;
