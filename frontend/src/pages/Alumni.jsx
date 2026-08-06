import React, { useState, useEffect, useContext, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  GraduationCap,
  Search,
  BadgeCheck,
  Mail,
  Linkedin,
  Users,
  Clock,
  AlertTriangle,
  Check,
  Send,
} from 'lucide-react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';
import AlumniVerificationPanel from '../components/alumni/AlumniVerificationPanel';

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

const REQUEST_STYLES = {
  pending: 'bg-amber-100 text-amber-800',
  accepted: 'bg-emerald-100 text-emerald-700',
  declined: 'bg-rose-100 text-rose-700',
  completed: 'bg-blue-100 text-blue-700',
  withdrawn: 'bg-gray-100 text-gray-600',
};

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

/**
 * Alumni network. Everyone signed in can browse the verified directory and ask
 * a willing alumnus for mentorship; admins and office staff also get the
 * verification queue, because an unverified profile never reaches the directory.
 */
const Alumni = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isStaff = role === 'admin' || role === 'staff';

  const [profiles, setProfiles] = useState([]);
  const [myRequests, setMyRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const [filters, setFilters] = useState({ search: '', industry: '', area: '', mentorsOnly: false });
  const [requesting, setRequesting] = useState(null);
  const [requestForm, setRequestForm] = useState({ area: 'career-guidance', message: '' });

  const loadDirectory = useCallback(async (activeFilters) => {
    const params = {};
    if (activeFilters.search) params.search = activeFilters.search;
    if (activeFilters.industry) params.industry = activeFilters.industry;
    if (activeFilters.area) params.area = activeFilters.area;
    if (activeFilters.mentorsOnly) params.mentorsOnly = 'true';

    const [directoryRes, requestsRes] = await Promise.all([
      api.get('/alumni/profiles', { params }),
      api.get('/alumni/my-requests'),
    ]);
    setProfiles(directoryRes.data.data || []);
    setMyRequests(requestsRes.data.data || []);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await loadDirectory(filters);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the alumni directory.');
    } finally {
      setLoading(false);
    }
  }, [loadDirectory, filters]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const applyFilters = (event) => {
    event.preventDefault();
    // `refresh` is keyed on `filters`, so changing state re-runs the query.
    setFilters((current) => ({ ...current }));
  };

  const submitRequest = async (event) => {
    event.preventDefault();
    if (!requesting) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await api.post(`/alumni/profiles/${requesting._id}/mentorship`, requestForm);
      setNotice(res.data.message);
      setRequesting(null);
      setRequestForm({ area: 'career-guidance', message: '' });
      await loadDirectory(filters);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not send that request.');
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (request) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.patch(
        `/alumni/profiles/${request.profileId}/mentorship/${request._id}/withdraw`
      );
      setNotice('Request withdrawn.');
      await loadDirectory(filters);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not withdraw that request.');
    } finally {
      setBusy(false);
    }
  };

  const complete = async (request) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.patch(
        `/alumni/profiles/${request.profileId}/mentorship/${request._id}/complete`
      );
      setNotice('Mentorship closed. Thank the mentor — their place is free again.');
      await loadDirectory(filters);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not close that mentorship.');
    } finally {
      setBusy(false);
    }
  };

  /** Requests that are still live, so the directory can grey those mentors out. */
  const liveRequestByProfile = useMemo(() => {
    const map = {};
    myRequests
      .filter((request) => ['pending', 'accepted'].includes(request.status))
      .forEach((request) => {
        map[request.profileId] = request;
      });
    return map;
  }, [myRequests]);

  const industries = useMemo(
    () => [...new Set(profiles.map((profile) => profile.industry).filter(Boolean))].sort(),
    [profiles]
  );

  return (
    <div
      className="min-h-screen p-4 sm:p-6"
      style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
    >
      {/* Header */}
      <div className="bg-gradient-to-r from-violet-700 to-indigo-700 text-white rounded-3xl p-8 shadow-2xl mb-8">
        <Link to="/student" className="inline-flex items-center gap-2 text-violet-100 hover:text-white text-sm">
          <ArrowLeft size={16} /> Back to dashboard
        </Link>

        <div className="flex items-center gap-4 mt-4">
          <div className="bg-white text-violet-700 p-4 rounded-full shadow-lg">
            <GraduationCap size={28} />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Alumni network</h1>
            <p className="text-violet-100 mt-1">
              Verified alumni offering guidance to current students
            </p>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto space-y-6">
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

        {isStaff && <AlumniVerificationPanel onChanged={refresh} />}

        {/* My requests */}
        {myRequests.length > 0 && (
          <div className="bg-white rounded-2xl shadow p-6">
            <h2 className="font-semibold text-gray-800 mb-4">My mentorship requests</h2>
            <div className="space-y-3">
              {myRequests.map((request) => (
                <div key={request._id} className="border border-gray-200 rounded-xl p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium text-gray-800">{request.mentorName}</div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {request.mentorRole}
                        {request.mentorOrganisation ? ` · ${request.mentorOrganisation}` : ''} · Class of{' '}
                        {request.graduationYear}
                      </div>
                      <div className="text-xs text-gray-400 mt-1">
                        {AREA_LABELS[request.area] || request.area} · asked {formatDate(request.requestedAt)}
                      </div>
                    </div>
                    <span
                      className={`px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap ${
                        REQUEST_STYLES[request.status] || REQUEST_STYLES.withdrawn
                      }`}
                    >
                      {request.status}
                    </span>
                  </div>

                  {request.responseMessage && (
                    <p className="text-sm text-gray-600 mt-3 bg-gray-50 rounded-lg p-3">
                      {request.responseMessage}
                    </p>
                  )}

                  {/* Contact details appear only once the mentor accepted. */}
                  {request.status === 'accepted' && (
                    <div className="flex flex-wrap items-center gap-4 mt-3 text-sm">
                      {request.contactEmail && (
                        <a
                          href={`mailto:${request.contactEmail}`}
                          className="inline-flex items-center gap-1.5 text-violet-700 hover:text-violet-800"
                        >
                          <Mail size={14} /> {request.contactEmail}
                        </a>
                      )}
                      {request.linkedinUrl && (
                        <a
                          href={request.linkedinUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 text-violet-700 hover:text-violet-800"
                        >
                          <Linkedin size={14} /> LinkedIn
                        </a>
                      )}
                      <button
                        onClick={() => complete(request)}
                        disabled={busy}
                        className="ml-auto text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
                      >
                        Mark complete
                      </button>
                    </div>
                  )}

                  {request.status === 'pending' && (
                    <button
                      onClick={() => withdraw(request)}
                      disabled={busy}
                      className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50 mt-3"
                    >
                      Withdraw
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Filters */}
        <form onSubmit={applyFilters} className="bg-white rounded-2xl shadow p-5">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <input
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              placeholder="Search by name"
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-400"
            />
            <select
              value={filters.industry}
              onChange={(e) => setFilters({ ...filters, industry: e.target.value })}
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-400"
            >
              <option value="">Any industry</option>
              {industries.map((industry) => (
                <option key={industry} value={industry}>
                  {industry}
                </option>
              ))}
            </select>
            <select
              value={filters.area}
              onChange={(e) => setFilters({ ...filters, area: e.target.value })}
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-400"
            >
              <option value="">Any topic</option>
              {Object.entries(AREA_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={filters.mentorsOnly}
                  onChange={(e) => setFilters({ ...filters, mentorsOnly: e.target.checked })}
                />
                Mentors only
              </label>
              <button
                type="submit"
                className="ml-auto bg-violet-700 hover:bg-violet-800 text-white px-3 py-2 rounded-lg"
                aria-label="Apply filters"
              >
                <Search size={16} />
              </button>
            </div>
          </div>
        </form>

        {loading && <div className="text-center py-12 text-gray-500">Loading the directory…</div>}

        {/* Directory */}
        {!loading && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {profiles.length === 0 && (
              <p className="text-sm text-gray-400 col-span-full py-8 text-center">
                No verified alumni match that search yet.
              </p>
            )}

            {profiles.map((profile) => {
              const live = liveRequestByProfile[profile._id];
              return (
                <div key={profile._id} className="bg-white rounded-2xl shadow p-5 flex flex-col">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold text-gray-800 flex items-center gap-1.5">
                        {profile.fullName}
                        <BadgeCheck size={15} className="text-violet-600" />
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        Class of {profile.graduationYear}
                      </div>
                    </div>
                  </div>

                  {(profile.currentRole || profile.organisation) && (
                    <div className="text-sm text-gray-700 mt-3">
                      {profile.currentRole}
                      {profile.organisation ? ` at ${profile.organisation}` : ''}
                    </div>
                  )}
                  {profile.industry && (
                    <div className="text-xs text-gray-500 mt-1">
                      {profile.industry}
                      {profile.city ? ` · ${profile.city}` : ''}
                    </div>
                  )}

                  {profile.bio && (
                    <p className="text-sm text-gray-600 mt-3 line-clamp-3">{profile.bio}</p>
                  )}

                  {profile.mentorshipAreas.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-3">
                      {profile.mentorshipAreas.map((area) => (
                        <span
                          key={area}
                          className="px-2 py-0.5 rounded-full text-xs bg-violet-50 text-violet-700"
                        >
                          {AREA_LABELS[area] || area}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="mt-auto pt-4">
                    {profile.willingToMentor ? (
                      <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-3">
                        <Users size={13} />
                        {profile.seatsLeft > 0
                          ? `${profile.seatsLeft} mentoring place(s) free`
                          : 'No places free right now'}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 text-xs text-gray-400 mb-3">
                        <Clock size={13} /> Not mentoring at the moment
                      </div>
                    )}

                    {live ? (
                      <div
                        className={`text-center text-xs font-medium py-2 rounded-lg ${
                          REQUEST_STYLES[live.status]
                        }`}
                      >
                        Request {live.status}
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setRequesting(profile);
                          setNotice('');
                          setError('');
                        }}
                        disabled={!profile.isAcceptingMentees}
                        className="w-full bg-violet-700 hover:bg-violet-800 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm py-2 rounded-lg transition"
                      >
                        Ask for mentorship
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Request dialog */}
      {requesting && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <form
            onSubmit={submitRequest}
            className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-lg space-y-4"
          >
            <div>
              <h3 className="font-semibold text-lg text-gray-800">Ask {requesting.fullName}</h3>
              <p className="text-xs text-gray-500 mt-1">
                They will see your name and class. Their contact details are shared with you only if
                they accept.
              </p>
            </div>

            <select
              value={requestForm.area}
              onChange={(e) => setRequestForm({ ...requestForm, area: e.target.value })}
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-400"
            >
              {Object.entries(AREA_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>

            <textarea
              required
              minLength={20}
              maxLength={800}
              rows={5}
              value={requestForm.message}
              onChange={(e) => setRequestForm({ ...requestForm, message: e.target.value })}
              placeholder="What would you like help with? At least 20 characters."
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-400"
            />

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={busy}
                className="flex-1 inline-flex items-center justify-center gap-2 bg-violet-700 hover:bg-violet-800 disabled:opacity-50 text-white text-sm py-2.5 rounded-lg transition"
              >
                <Send size={15} /> {busy ? 'Sending…' : 'Send request'}
              </button>
              <button
                type="button"
                onClick={() => setRequesting(null)}
                className="px-5 text-sm text-gray-600 hover:text-gray-800"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

export default Alumni;
