import React, { useState, useEffect, useContext, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, DoorOpen, AlertTriangle, Check, Clock, UserCheck } from 'lucide-react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';
import GateDeskPanel from '../components/visitors/GateDeskPanel';

const PURPOSE_LABELS = {
  'parent-meeting': 'Parent meeting',
  'admission-enquiry': 'Admission enquiry',
  delivery: 'Delivery',
  maintenance: 'Maintenance',
  official: 'Official',
  event: 'Event',
  'student-pickup': 'Student pickup',
  medical: 'Medical',
  other: 'Other',
};

const formatTime = (value) =>
  value
    ? new Date(value).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

/**
 * Gate desk.
 *
 * Security and office staff get the full desk. A teacher gets only the visits
 * waiting on their approval — the point of the approval step is that a visitor
 * cannot write a teacher's name in a book and walk in, so the teacher has to
 * see the request before the person arrives.
 */
const VisitorDesk = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isGate = role === 'admin' || role === 'staff';

  const [approvals, setApprovals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState('');

  const loadApprovals = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/visitors/my-approvals');
      setApprovals(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load your pending approvals.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isGate) loadApprovals();
    else setLoading(false);
  }, [isGate, loadApprovals]);

  const decide = async (pass, decision, note) => {
    setBusyId(pass._id);
    setError('');
    setNotice('');
    try {
      const res = await api.patch(`/visitors/passes/${pass._id}/approve`, { decision, note });
      setNotice(res.data.message);
      setRejecting(null);
      setReason('');
      await loadApprovals();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not record that decision.');
    } finally {
      setBusyId(null);
    }
  };

  const submitRejection = async (event) => {
    event.preventDefault();
    if (!rejecting) return;
    await decide(rejecting, 'rejected', reason);
  };

  if (isGate) {
    return (
      <div
        className="min-h-screen p-4 sm:p-6"
        style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
      >
        <div className="max-w-6xl mx-auto">
          <Link
            to="/teacher/dashboard"
            className="inline-flex items-center gap-2 text-sm text-slate-600 hover:text-slate-800 mb-4"
          >
            <ArrowLeft size={16} /> Back to dashboard
          </Link>
          <GateDeskPanel />
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen p-4 sm:p-6"
      style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
    >
      {/* Header */}
      <div className="bg-gradient-to-r from-slate-800 to-slate-600 text-white rounded-3xl p-8 shadow-2xl mb-8">
        <Link
          to="/teacher/dashboard"
          className="inline-flex items-center gap-2 text-slate-200 hover:text-white text-sm"
        >
          <ArrowLeft size={16} /> Back to dashboard
        </Link>

        <div className="flex items-center gap-4 mt-4">
          <div className="bg-white text-slate-800 p-4 rounded-full shadow-lg">
            <DoorOpen size={28} />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Visitors for me</h1>
            <p className="text-slate-200 mt-1">
              Nobody is let through to you until you have said yes
            </p>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto space-y-5">
        {error && (
          <div className="flex items-start gap-3 bg-red-50 border border-red-200 text-red-700 rounded-xl p-4">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <span className="text-sm">{error}</span>
          </div>
        )}

        {notice && (
          <div className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl p-4">
            <Check size={18} className="mt-0.5 shrink-0" />
            <span className="text-sm">{notice}</span>
          </div>
        )}

        {loading && <div className="text-center py-12 text-gray-500">Loading…</div>}

        {!loading && approvals.length === 0 && (
          <div className="bg-white rounded-2xl shadow p-12 text-center text-gray-400 text-sm">
            Nobody is waiting on your approval.
          </div>
        )}

        {approvals.map((pass) => (
          <div key={pass._id} className="bg-white rounded-2xl shadow p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold text-gray-800">{pass.visitorName}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {pass.organisation || 'No organisation given'} · badge {pass.badgeNumber}
                </div>
              </div>
              <span className="bg-amber-100 text-amber-800 text-xs font-medium px-2.5 py-1 rounded-full whitespace-nowrap">
                awaiting you
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 mt-4 text-xs">
              <div>
                <span className="text-gray-400">Purpose</span>
                <div className="font-medium text-gray-700">
                  {PURPOSE_LABELS[pass.purpose] || pass.purpose}
                </div>
              </div>
              <div>
                <span className="text-gray-400">Registered</span>
                <div className="font-medium text-gray-700">{formatTime(pass.createdAt)}</div>
              </div>
              <div>
                <span className="text-gray-400">Expected stay</span>
                <div className="font-medium text-gray-700 inline-flex items-center gap-1">
                  <Clock size={12} /> {pass.expectedDurationMinutes} min
                </div>
              </div>
              <div>
                <span className="text-gray-400">Party size</span>
                <div className="font-medium text-gray-700">{1 + (pass.accompanyingCount || 0)}</div>
              </div>
            </div>

            {pass.purposeNote && (
              <p className="text-sm text-gray-600 mt-3 bg-gray-50 rounded-lg p-3">
                {pass.purposeNote}
              </p>
            )}

            <div className="flex items-center gap-3 mt-4 pt-4 border-t border-gray-100">
              <button
                onClick={() => decide(pass, 'approved')}
                disabled={busyId === pass._id}
                className="inline-flex items-center gap-1.5 bg-slate-800 hover:bg-slate-900 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg transition"
              >
                <UserCheck size={15} /> Approve
              </button>
              <button
                onClick={() => {
                  setRejecting(pass);
                  setReason('');
                }}
                disabled={busyId === pass._id}
                className="text-sm text-rose-600 hover:text-rose-700 disabled:opacity-50"
              >
                Refuse
              </button>
            </div>

            {rejecting?._id === pass._id && (
              <form onSubmit={submitRejection} className="mt-4 space-y-2">
                <textarea
                  required
                  rows={2}
                  maxLength={300}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why? The gate will read this to the visitor."
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-rose-400"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={busyId === pass._id}
                    className="bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg"
                  >
                    Confirm refusal
                  </button>
                  <button
                    type="button"
                    onClick={() => setRejecting(null)}
                    className="text-sm text-gray-600 hover:text-gray-800 px-3"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default VisitorDesk;
