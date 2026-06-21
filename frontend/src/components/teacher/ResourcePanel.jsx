import { useState, useEffect } from 'react';
import api from '../../utils/axios';

const ResourcePanel = () => {
  const [resources, setResources] = useState([]);
  const [form, setForm] = useState({ title: '', subject: '', targetClass: '' });
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const fetchResources = async () => {
    try {
      const res = await api.get('/teacher/resources');
      setResources(res.data.resources);
    } catch (err) { console.error(err); }
  };

  useEffect(() => { fetchResources(); }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file || !form.title || !form.subject) {
      setError('File, title, and subject are required.');
      return;
    }
    setLoading(true);
    setError('');
    const formData = new FormData();
    formData.append('file', file);
    formData.append('title', form.title);
    formData.append('subject', form.subject);
    formData.append('targetClass', form.targetClass);

    try {
      await api.post('/teacher/resources', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setSuccess('Resource uploaded!');
      setForm({ title: '', subject: '', targetClass: '' });
      setFile(null);
      fetchResources();
    } catch (err) {
      setError(err.response?.data?.message || 'Upload failed.');
    } finally {
      setLoading(false);
      setTimeout(() => setSuccess(''), 3000);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this resource?')) return;
    try {
      await api.delete(`/teacher/resources/${id}`);
      setResources(resources.filter(r => r._id !== id));
    } catch { alert('Failed to delete.'); }
  };

  return (
    <div className="bg-white rounded-2xl shadow p-6 mb-6">
      <h3 className="text-xl font-bold text-gray-800 mb-4">📁 Resource Upload</h3>

      <form onSubmit={handleSubmit} className="mb-6 space-y-3">
        <input
          type="text"
          placeholder="Resource title *"
          value={form.title}
          onChange={e => setForm({ ...form, title: e.target.value })}
          className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <input
          type="text"
          placeholder="Subject *"
          value={form.subject}
          onChange={e => setForm({ ...form, subject: e.target.value })}
          className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <input
          type="text"
          placeholder="Target class (optional)"
          value={form.targetClass}
          onChange={e => setForm({ ...form, targetClass: e.target.value })}
          className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <input
          type="file"
          accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.ppt,.pptx"
          onChange={e => setFile(e.target.files[0])}
          className="w-full text-sm text-gray-500"
        />
        {error && <p className="text-red-500 text-sm">{error}</p>}
        {success && <p className="text-green-600 text-sm">{success}</p>}
        <button
          type="submit"
          disabled={loading}
          className="bg-green-600 hover:bg-green-700 text-white px-5 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
        >
          {loading ? 'Uploading...' : 'Upload Resource'}
        </button>
      </form>

      {resources.length === 0 ? (
        <p className="text-gray-400 text-sm text-center py-4">No resources uploaded yet.</p>
      ) : (
        <div className="space-y-3">
          {resources.map(r => (
            <div key={r._id} className="flex items-center justify-between bg-gray-50 rounded-xl p-4">
              <div>
                <p className="font-semibold text-gray-800 text-sm">{r.title}</p>
                <p className="text-gray-400 text-xs">{r.subject} · {r.fileType?.toUpperCase()}</p>
              </div>
              <div className="flex gap-3 ml-4 shrink-0">
                <a
                  href={`http://localhost:5000${r.fileUrl}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-500 hover:text-blue-700 text-xs"
                >
                  View
                </a>
                <button
                  onClick={() => handleDelete(r._id)}
                  className="text-red-400 hover:text-red-600 text-xs"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ResourcePanel;
