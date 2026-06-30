import { useState, useEffect } from 'react';
import api from '../../utils/axios';

const NoticePanel = () => {
  const [notices, setNotices] = useState([]);
  const [form, setForm] = useState({ title: '', content: '', targetClass: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const fetchNotices = async () => {
    try {
      const res = await api.get('/teacher/notices');
      setNotices(res.data.notices);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => { fetchNotices(); }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.title || !form.content) {
      setError('Title and content are required.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await api.post('/teacher/notices', form);
      setSuccess('Notice posted successfully!');
      setForm({ title: '', content: '', targetClass: '' });
      fetchNotices();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to post notice.');
    } finally {
      setLoading(false);
      setTimeout(() => setSuccess(''), 3000);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this notice?')) return;
    try {
      await api.delete(`/teacher/notices/${id}`);
      setNotices(notices.filter(n => n._id !== id));
    } catch {
      alert('Failed to delete notice.');
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow p-6 mb-6">
      <h3 className="text-xl font-bold text-gray-800 mb-4">📢 Notice Management</h3>

      <form onSubmit={handleSubmit} className="mb-6 space-y-3">
        <input
          type="text"
          placeholder="Notice title *"
          value={form.title}
          onChange={e => setForm({ ...form, title: e.target.value })}
          className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <textarea
          placeholder="Notice content *"
          value={form.content}
          onChange={e => setForm({ ...form, content: e.target.value })}
          rows={3}
          className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <input
          type="text"
          placeholder="Target class (optional, e.g. Class 10)"
          value={form.targetClass}
          onChange={e => setForm({ ...form, targetClass: e.target.value })}
          className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {error && <p className="text-red-500 text-sm">{error}</p>}
        {success && <p className="text-green-600 text-sm">{success}</p>}
        <button
          type="submit"
          disabled={loading}
          className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
        >
          {loading ? 'Posting...' : '+ Post Notice'}
        </button>
      </form>

      {notices.length === 0 ? (
        <p className="text-gray-400 text-sm text-center py-4">No notices posted yet.</p>
      ) : (
        <div className="space-y-3">
          {notices.map(notice => (
            <div key={notice._id} className="flex items-start justify-between bg-gray-50 rounded-xl p-4">
              <div>
                <p className="font-semibold text-gray-800 text-sm">{notice.title}</p>
                <p className="text-gray-500 text-xs mt-1">{notice.content}</p>
                {notice.targetClass && (
                  <span className="inline-block mt-2 text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                    {notice.targetClass}
                  </span>
                )}
              </div>
              <button
                onClick={() => handleDelete(notice._id)}
                className="text-red-400 hover:text-red-600 text-xs ml-4 shrink-0"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default NoticePanel;
