import React, { useState, useEffect, useCallback } from 'react';
import {
  ShieldCheck,
  X,
  Mail,
  Phone,
  Linkedin,
  RefreshCw,
  AlertTriangle,
  Check,
  BarChart3,
} from 'lucide-react';
import api from '../../utils/axios';

const AREA_LABELS = {
  'career-guidance': 'Career guidance',
  'higher-studies': 'Higher studies',
  'entrance-exams': 'Entrance exams',
  internships: 'Internships',
  entrepreneurship: 'Entrepreneurship',
  research: 'Research',
  sports: 'Sports',
  arts: 'Arts',
};

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

/**
 * The office's verification queue.
 *
 * A profile sits here until somebody at the school confirms the person is who
 * they say they are. Until then it is invisible to every student, which is the
 * whole reason the queue exists — the alternative is an unverified stranger's
 * contact details in front of a child.
 */
const AlumniVerificationPanel = ({ onChanged }) => {
  const [pending, setPending] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState('');
  const [showStats, setShowStats] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [pendingRes, statsRes] = await Promise.all([
        api.get('/alumni/profiles/pending'),
        api.get('/alumni/stats'),
      ]);
      setPending(pendingRes.data.data || []);
      setStats(statsRes.data.stats);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the verification queue.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const decide = async (profile, decision, rejectionReason) => {
    setBusyId(profile._id);
    setError('');
    setNotice('');
    try {
      const res = await api.patch(`/alumni/profiles/${profile._id}/verify`, {
        decision,
        reason: rejectionReason,
      });
      setNotice(res.data.message);
      setRejecting(null);
      setReason('');
      await load();
      if (onChanged) await onChanged();
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

  return (
    <div className="bg-white rounded-2xl shadow p-6">
      <div className="flex items-center justify-between mb-1">
        <h2 className="font-semibold text-gray-800 flex items-center gap-2">
          <ShieldCheck size={18} className="text-violet-600" />
          Verification queue
          {pending.length > 0 && (
            <span className="bg-amber-100 text-amber-800 text-xs font-medium px-2 py-0.5 rounded-full">
              {pending.length}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setShowStats((current) => !current)}
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700"
          >
            <BarChart3 size={15} /> {showStats ? 'Hide' : 'Stats'}
          </button>
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>
      <p className="text-xs text-gray-500 mb-5">
        Nothing here is visible to students until it is approved.
      </p>

      {error && (
        <div className="flex items-start gap-3 bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 mb-4">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      {notice && (
        <div className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl p-4 mb-4">
          <Check size={18} className="mt-0.5 shrink-0" />
          <span className="text-sm">{notice}</span>
        </div>
      )}

      {showStats && stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          {[
            { label: 'Verified', value: stats.verified },
            { label: 'Awaiting review', value: stats.pending },
            { label: 'Mentors', value: stats.mentorsAvailable },
            { label: 'Places used', value: `${stats.seatsTaken}/${stats.seatsOffered}` },
            { label: 'Requests open', value: stats.requestsPending },
            { label: 'Mentorships live', value: stats.requestsAccepted },
            { label: 'Completed', value: stats.requestsCompleted },
            {
              label: 'Acceptance rate',
              value: stats.acceptanceRate === null ? '—' : `${stats.acceptanceRate}%`,
            },
          ].map((card) => (
            <div key={card.label} className="border border-gray-200 rounded-xl p-4">
              <div className="text-xs uppercase tracking-wide text-gray-400">{card.label}</div>
              <div className="text-xl font-bold text-gray-800 mt-1">{card.value}</div>
            </div>
          ))}
        </div>
      )}

      {loading && <p className="text-sm text-gray-400 py-4">Loading…</p>}

      {!loading && pending.length === 0 && (
        <p className="text-sm text-gray-400 py-4">Nothing waiting for review.</p>
      )}

      <div className="space-y-4">
        {pending.map((profile) => (
          <div key={profile._id} className="border border-gray-200 rounded-2xl p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold text-gray-800">{profile.fullName}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  Class of {profile.graduationYear}
                  {profile.graduatingClass ? ` · ${profile.graduatingClass}` : ''} · submitted{' '}
                  {formatDate(profile.createdAt)}
                </div>
              </div>
              <span className="bg-amber-100 text-amber-800 text-xs font-medium px-2.5 py-1 rounded-full whitespace-nowrap">
                pending
              </span>
            </div>

            {(profile.currentRole || profile.organisation) && (
              <div className="text-sm text-gray-700 mt-3">
                {profile.currentRole}
                {profile.organisation ? ` at ${profile.organisation}` : ''}
              </div>
            )}

            {profile.bio && <p className="text-sm text-gray-600 mt-2">{profile.bio}</p>}

            {/* Staff see the contact details in full — checking them is the
                verification. */}
            <div className="flex flex-wrap items-center gap-4 mt-3 text-xs text-gray-500">
              {profile.contactEmail && (
                <span className="inline-flex items-center gap-1.5">
                  <Mail size={13} /> {profile.contactEmail}
                </span>
              )}
              {profile.contactPhone && (
                <span className="inline-flex items-center gap-1.5">
                  <Phone size={13} /> {profile.contactPhone}
                </span>
              )}
              {profile.linkedinUrl && (
                <a
                  href={profile.linkedinUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-violet-700 hover:text-violet-800"
                >
                  <Linkedin size={13} /> LinkedIn
                </a>
              )}
            </div>

            {profile.willingToMentor && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                <span className="px-2 py-0.5 rounded-full text-xs bg-violet-50 text-violet-700">
                  Offers {profile.mentorCapacity} place(s)
                </span>
                {profile.mentorshipAreas.map((area) => (
                  <span
                    key={area}
                    className="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600"
                  >
                    {AREA_LABELS[area] || area}
                  </span>
                ))}
              </div>
            )}

            <div className="flex items-center gap-3 mt-4 pt-4 border-t border-gray-100">
              <button
                onClick={() => decide(profile, 'verified')}
                disabled={busyId === profile._id}
                className="inline-flex items-center gap-1.5 bg-violet-700 hover:bg-violet-800 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg transition"
              >
                <Check size={15} /> Approve
              </button>
              <button
                onClick={() => {
                  setRejecting(profile);
                  setReason('');
                }}
                disabled={busyId === profile._id}
                className="inline-flex items-center gap-1.5 text-sm text-rose-600 hover:text-rose-700 disabled:opacity-50"
              >
                <X size={15} /> Reject
              </button>
            </div>

            {rejecting?._id === profile._id && (
              <form onSubmit={submitRejection} className="mt-4 space-y-2">
                <textarea
                  required
                  rows={2}
                  maxLength={400}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why is this being rejected? The alumnus will see this."
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-rose-400"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={busyId === profile._id}
                    className="bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg"
                  >
                    Confirm rejection
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

export default AlumniVerificationPanel;
