import { useState, useEffect } from 'react';
import api from '../../utils/axios';

const DEFAULT_STUDENTS = [
  'Student 1', 'Student 2', 'Student 3', 'Student 4', 'Student 5',
];

const AttendancePanel = () => {
  const [records, setRecords] = useState([]);
  const [className, setClassName] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [students, setStudents] = useState(
    DEFAULT_STUDENTS.map(name => ({ studentName: name, status: 'Present' }))
  );
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  const fetchRecords = async () => {
    try {
      const res = await api.get('/teacher/attendance');
      setRecords(res.data.records);
    } catch (err) { console.error(err); }
  };

  useEffect(() => { fetchRecords(); }, []);

  const toggleStatus = (index) => {
    const updated = [...students];
    updated[index].status = updated[index].status === 'Present' ? 'Absent' : 'Present';
    setStudents(updated);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!className || !date) {
      setError('Class name and date are required.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await api.post('/teacher/attendance', { className, date, records: students });
      setSuccess('Attendance marked successfully!');
      setClassName('');
      fetchRecords();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save attendance.');
    } finally {
      setLoading(false);
      setTimeout(() => setSuccess(''), 3000);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow p-6 mb-6">
      <h3 className="text-xl font-bold text-gray-800 mb-4">🗓️ Attendance Marking</h3>

      <form onSubmit={handleSubmit} className="mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <input
            type="text"
            placeholder="Class name (e.g. Class 10A) *"
            value={className}
            onChange={e => setClassName(e.target.value)}
            className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="space-y-2 mb-4">
          {students.map((s, i) => (
            <div key={i} className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-2">
              <span className="text-sm text-gray-700">{s.studentName}</span>
              <button
                type="button"
                onClick={() => toggleStatus(i)}
                className={`text-xs font-semibold px-3 py-1 rounded-full transition ${
                  s.status === 'Present'
                    ? 'bg-green-100 text-green-700 hover:bg-green-200'
                    : 'bg-red-100 text-red-700 hover:bg-red-200'
                }`}
              >
                {s.status}
              </button>
            </div>
          ))}
        </div>

        {error && <p className="text-red-500 text-sm mb-2">{error}</p>}
        {success && <p className="text-green-600 text-sm mb-2">{success}</p>}

        <button
          type="submit"
          disabled={loading}
          className="bg-purple-600 hover:bg-purple-700 text-white px-5 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
        >
          {loading ? 'Saving...' : 'Mark Attendance'}
        </button>
      </form>

      {records.length > 0 && (
        <div>
          <h4 className="font-semibold text-gray-700 mb-3 text-sm">Previous Records</h4>
          <div className="space-y-2">
            {records.slice(0, 5).map(r => (
              <div key={r._id} className="bg-gray-50 rounded-lg px-4 py-2 text-sm">
                <span className="font-medium">{r.className}</span>
                <span className="text-gray-400 mx-2">·</span>
                <span className="text-gray-500">{r.date}</span>
                <span className="text-gray-400 mx-2">·</span>
                <span className="text-gray-500">
                  {r.records.filter(s => s.status === 'Present').length}/
                  {r.records.length} Present
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default AttendancePanel;
