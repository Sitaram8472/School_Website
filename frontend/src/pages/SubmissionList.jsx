import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../utils/axios';
import { ArrowLeft, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';

const SubmissionList = () => {
  const { examId } = useParams();
  const navigate = useNavigate();
  const [submissions, setSubmissions] = useState([]);
  const [exam, setExam] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchSubmissions = async () => {
      try {
        const [subRes, examRes] = await Promise.all([
          api.get(`/submissions/exam/${examId}`),
          api.get(`/exams/${examId}`)
        ]);
        setSubmissions(subRes.data.data);
        setExam(examRes.data.data);
      } catch (err) {
        console.error("Failed to fetch submissions", err);
      } finally {
        setLoading(false);
      }
    };
    fetchSubmissions();
  }, [examId]);

  if (loading) return <div className="p-10 text-center text-lg text-gray-500">Loading submissions...</div>;

  return (
    <div className="max-w-6xl mx-auto p-6 my-8">
      <button
        onClick={() => navigate('/teacher/dashboard')}
        className="flex items-center text-blue-600 hover:text-blue-800 mb-6 transition"
      >
        <ArrowLeft className="w-4 h-4 mr-1" /> Back to Dashboard
      </button>

      <div className="bg-white rounded-2xl shadow-xl overflow-hidden border border-gray-100">
        <div className="bg-gradient-to-r from-blue-700 to-indigo-800 p-6 text-white">
          <h2 className="text-2xl font-bold">{exam?.title || 'Exam'} Submissions</h2>
          <p className="text-blue-100 mt-1 opacity-80">Total Submissions: {submissions.length}</p>
        </div>

        <div className="p-0 overflow-x-auto">
          {submissions.length > 0 ? (
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 text-gray-600 text-sm uppercase tracking-wider border-b">
                  <th className="p-4 font-semibold">Student Name</th>
                  <th className="p-4 font-semibold">Email</th>
                  <th className="p-4 font-semibold text-center">Score</th>
                  <th className="p-4 font-semibold text-center">Anti-Cheat Warnings</th>
                  <th className="p-4 font-semibold">Submitted At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {submissions.map((sub) => (
                  <tr key={sub._id} className="hover:bg-blue-50/50 transition">
                    <td className="p-4 font-medium text-gray-800">{sub.student?.name || 'Unknown'}</td>
                    <td className="p-4 text-gray-500 text-sm">{sub.student?.email || 'N/A'}</td>
                    <td className="p-4 text-center font-bold text-blue-600 bg-blue-50/30">
                      {sub.score} / {exam?.questions.length || 0}
                    </td>
                    <td className="p-4 text-center">
                      {sub.cheatWarnings > 0 ? (
                        <span className="inline-flex items-center gap-1 px-3 py-1 bg-red-100 text-red-700 rounded-full text-xs font-bold">
                          <AlertTriangle className="w-3 h-3" /> {sub.cheatWarnings} Warnings
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-3 py-1 bg-green-100 text-green-700 rounded-full text-xs font-medium">
                          <CheckCircle className="w-3 h-3" /> Clean
                        </span>
                      )}
                    </td>
                    <td className="p-4 text-sm text-gray-500">
                      {new Date(sub.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="p-12 text-center text-gray-500 flex flex-col items-center">
              <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
                <XCircle className="w-8 h-8 text-gray-400" />
              </div>
              <h3 className="text-xl font-medium text-gray-700 mb-1">No submissions yet</h3>
              <p>Students have not taken this exam yet.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SubmissionList;
