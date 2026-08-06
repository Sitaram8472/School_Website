import React, { useState, useEffect, useCallback, useMemo, useContext } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Sparkles,
  Search,
  Users,
  MapPin,
  CalendarDays,
  AlertCircle,
  CheckCircle2,
  Clock,
  Trophy,
} from 'lucide-react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';

const CATEGORIES = [
  { value: '', label: 'All' },
  { value: 'sports', label: 'Sports' },
  { value: 'arts', label: 'Arts' },
  { value: 'music', label: 'Music' },
  { value: 'technology', label: 'Technology' },
  { value: 'literary', label: 'Literary' },
  { value: 'science', label: 'Science' },
  { value: 'social-service', label: 'Social service' },
  { value: 'other', label: 'Other' },
];

const CATEGORY_TONES = {
  sports: 'bg-green-100 text-green-700',
  arts: 'bg-pink-100 text-pink-700',
  music: 'bg-purple-100 text-purple-700',
  technology: 'bg-blue-100 text-blue-700',
  literary: 'bg-amber-100 text-amber-800',
  science: 'bg-cyan-100 text-cyan-700',
  'social-service': 'bg-rose-100 text-rose-700',
  other: 'bg-gray-100 text-gray-700',
};

const formatDateTime = (value) =>
  value
    ? new Date(value).toLocaleString('en-GB', {
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

const fillTone = (rate) => (rate >= 100 ? 'bg-red-500' : rate >= 80 ? 'bg-amber-500' : 'bg-green-500');

const Clubs = () => {
  const { user } = useContext(AuthContext);
  const displayName = user?.name || user?.user?.name || 'Student';

  const [clubs, setClubs] = useState([]);
  const [myClubs, setMyClubs] = useState([]);
  const [upcoming, setUpcoming] = useState([]);

  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [joinTarget, setJoinTarget] = useState(null);
  const [joinForm, setJoinForm] = useState({ className: '', motivation: '' });

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 4000);
  };

  const loadClubs = useCallback(async () => {
    try {
      const params = { limit: 60 };
      if (category) params.category = category;
      if (search.trim()) params.search = search.trim();

      const res = await api.get('/clubs', { params });
      setClubs(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the club directory.');
    }
  }, [category, search]);

  const loadMyClubs = useCallback(async () => {
    try {
      const res = await api.get('/clubs/me');
      setMyClubs(res.data.data || []);
      setUpcoming(res.data.upcomingSessions || []);
    } catch (err) {
      console.error('Could not load your clubs', err);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await Promise.all([loadClubs(), loadMyClubs()]);
      setLoading(false);
    };
    load();
  }, [loadClubs, loadMyClubs]);

  const refresh = () => Promise.all([loadClubs(), loadMyClubs()]);

  const handleJoin = async (event) => {
    event.preventDefault();
    setError('');
    setBusy(true);

    try {
      const res = await api.post(`/clubs/${joinTarget._id}/join`, joinForm);
      flash(res.data.message || 'Joined.');
      setJoinTarget(null);
      setJoinForm({ className: '', motivation: '' });
      await refresh();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not join that club.');
    } finally {
      setBusy(false);
    }
  };

  const handleLeave = async (club) => {
    if (!window.confirm(`Leave "${club.name}"?`)) return;

    setError('');
    try {
      await api.patch(`/clubs/${club._id}/leave`, { reason: 'Left from the clubs page' });
      flash(`You have left "${club.name}".`);
      await refresh();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not leave that club.');
    }
  };

  const activeMemberships = useMemo(
    () => myClubs.filter((m) => m.status === 'active'),
    [myClubs]
  );

  const pendingMemberships = useMemo(
    () => myClubs.filter((m) => m.status === 'pending'),
    [myClubs]
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-t-4 border-b-4 border-teal-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="max-w-5xl mx-auto px-4 py-8">
        <Link
          to="/student"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4"
        >
          <ArrowLeft size={16} /> Back to dashboard
        </Link>

        <div className="bg-gradient-to-r from-teal-500 to-emerald-600 rounded-2xl p-6 mb-6 text-white">
          <div className="flex items-center gap-3">
            <Sparkles size={30} />
            <div>
              <h1 className="text-2xl font-bold">Clubs &amp; Activities</h1>
              <p className="text-teal-50 text-sm mt-0.5">
                {displayName} · {activeMemberships.length} club
                {activeMemberships.length === 1 ? '' : 's'} joined
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-5 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {success && (
          <div className="mb-5 flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-xl text-sm">
            <CheckCircle2 size={16} />
            <span>{success}</span>
          </div>
        )}

        {/* ---- Upcoming sessions ---- */}
        {upcoming.length > 0 && (
          <div className="bg-white rounded-2xl shadow p-5 mb-6">
            <h3 className="font-bold text-gray-800 mb-3 text-sm flex items-center gap-2">
              <CalendarDays size={16} className="text-teal-500" /> Your next sessions
            </h3>
            <ul className="space-y-2">
              {upcoming.slice(0, 5).map((session) => (
                <li
                  key={`${session.clubId}-${session.sessionId}`}
                  className="flex flex-wrap items-center justify-between gap-2 border border-gray-100 rounded-xl px-4 py-2.5"
                >
                  <div>
                    <p className="text-sm font-semibold text-gray-800">{session.title}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {session.clubName}
                      {session.venue && ` · ${session.venue}`}
                    </p>
                  </div>
                  <span className="text-xs text-teal-700 bg-teal-50 px-2.5 py-1 rounded-full flex items-center gap-1">
                    <Clock size={11} /> {formatDateTime(session.scheduledFor)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ---- Pending requests ---- */}
        {pendingMemberships.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 mb-6">
            <h3 className="font-bold text-amber-800 mb-2 text-sm">Awaiting approval</h3>
            <p className="text-xs text-amber-700">
              {pendingMemberships.map((m) => m.club?.name || m.clubName).join(', ')}
            </p>
          </div>
        )}

        {/* ---- Filters ---- */}
        <div className="flex flex-wrap gap-3 mb-5">
          <div className="relative flex-1 min-w-[220px]">
            <Search size={16} className="absolute left-3 top-2.5 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search clubs…"
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400"
            />
          </div>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 text-sm"
          >
            {CATEGORIES.map((cat) => (
              <option key={cat.value} value={cat.value}>
                {cat.label}
              </option>
            ))}
          </select>
        </div>

        {/* ---- Directory ---- */}
        <div className="grid gap-4 sm:grid-cols-2">
          {clubs.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-12 bg-white rounded-2xl shadow sm:col-span-2">
              No clubs match that search.
            </p>
          )}

          {clubs.map((club) => {
            const membership = club.myMembership;
            const isMember = membership?.status === 'active';
            const isPending = membership?.status === 'pending';
            const full = club.memberCount >= club.capacity;

            return (
              <div key={club._id} className="bg-white rounded-2xl shadow p-5 flex flex-col">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <h3 className="font-bold text-gray-800">{club.name}</h3>
                  <span
                    className={`text-[11px] px-2 py-0.5 rounded-full shrink-0 ${
                      CATEGORY_TONES[club.category] || 'bg-gray-100 text-gray-700'
                    }`}
                  >
                    {club.category}
                  </span>
                </div>

                <p className="text-xs text-gray-600 line-clamp-3 grow">{club.description}</p>

                <div className="text-[11px] text-gray-500 mt-3 space-y-1">
                  {club.meetingDay && (
                    <p className="flex items-center gap-1.5">
                      <CalendarDays size={11} /> {club.meetingDay}
                      {club.meetingTime && ` at ${club.meetingTime}`}
                    </p>
                  )}
                  {club.venue && (
                    <p className="flex items-center gap-1.5">
                      <MapPin size={11} /> {club.venue}
                    </p>
                  )}
                  <p className="flex items-center gap-1.5">
                    <Users size={11} /> Run by {club.coordinatorName || 'the school'}
                  </p>
                  {(club.achievements || []).length > 0 && (
                    <p className="flex items-center gap-1.5 text-amber-700">
                      <Trophy size={11} /> {club.achievements.length} achievement(s)
                    </p>
                  )}
                </div>

                <div className="mt-3">
                  <div className="flex justify-between text-[11px] text-gray-500 mb-1">
                    <span>
                      {club.memberCount}/{club.capacity} members
                    </span>
                    <span>{club.fillRate}%</span>
                  </div>
                  <div className="h-1.5 w-full bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${fillTone(club.fillRate)}`}
                      style={{ width: `${Math.min(club.fillRate, 100)}%` }}
                    />
                  </div>
                </div>

                <div className="mt-4">
                  {isMember ? (
                    <button
                      onClick={() => handleLeave(club)}
                      className="w-full text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 rounded-lg transition"
                    >
                      Leave club
                    </button>
                  ) : isPending ? (
                    <button
                      disabled
                      className="w-full text-xs bg-amber-100 text-amber-800 py-2 rounded-lg cursor-default"
                    >
                      Awaiting approval
                    </button>
                  ) : club.status !== 'open' ? (
                    <button
                      disabled
                      className="w-full text-xs bg-gray-100 text-gray-400 py-2 rounded-lg cursor-not-allowed"
                    >
                      Not accepting members
                    </button>
                  ) : full && !club.requiresApproval ? (
                    <button
                      disabled
                      className="w-full text-xs bg-gray-100 text-gray-400 py-2 rounded-lg cursor-not-allowed"
                    >
                      Full
                    </button>
                  ) : (
                    <button
                      onClick={() => setJoinTarget(club)}
                      className="w-full text-xs bg-teal-600 hover:bg-teal-700 text-white py-2 rounded-lg transition"
                    >
                      {club.requiresApproval ? 'Request to join' : 'Join club'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* ---- Join dialog ---- */}
        {joinTarget && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
            <form
              onSubmit={handleJoin}
              className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-4"
            >
              <div>
                <h4 className="font-bold text-gray-800">Join {joinTarget.name}</h4>
                <p className="text-xs text-gray-500 mt-1">
                  {joinTarget.requiresApproval
                    ? 'The coordinator will review your request.'
                    : 'You will be added straight away.'}
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Your class</label>
                <input
                  value={joinForm.className}
                  onChange={(e) => setJoinForm({ ...joinForm, className: e.target.value })}
                  placeholder="Class 9-A"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                />
                {(joinTarget.eligibleClasses || []).length > 0 && (
                  <p className="text-[11px] text-gray-400 mt-1">
                    Open to: {joinTarget.eligibleClasses.join(', ')}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Why do you want to join? (optional)
                </label>
                <textarea
                  rows="3"
                  value={joinForm.motivation}
                  onChange={(e) => setJoinForm({ ...joinForm, motivation: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                />
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setJoinTarget(null)}
                  className="flex-1 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 py-2.5 rounded-lg transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="flex-1 text-sm bg-teal-600 hover:bg-teal-700 disabled:opacity-60 text-white py-2.5 rounded-lg transition"
                >
                  {busy ? 'Sending…' : 'Confirm'}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};

export default Clubs;
