import React, { useState, useEffect, useMemo, useCallback, useContext } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Bus,
  MapPin,
  Clock,
  Phone,
  User,
  AlertCircle,
  Search,
  CircleDot,
} from 'lucide-react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';

const DIRECTION_LABELS = {
  both: 'Pickup & drop',
  'pickup-only': 'Morning pickup only',
  'drop-only': 'Afternoon drop only',
};

const STATUS_STYLES = {
  active: 'bg-green-100 text-green-700',
  suspended: 'bg-yellow-100 text-yellow-800',
  retired: 'bg-gray-200 text-gray-600',
};

const formatTime = (value) => {
  if (!value) return '—';
  const [hours, minutes] = value.split(':').map(Number);
  if (Number.isNaN(hours)) return value;
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${display}:${String(minutes).padStart(2, '0')} ${suffix}`;
};

/**
 * Occupancy bar shared by the assigned-route card and the catalogue. Colour
 * shifts from green to red so a nearly-full bus reads as one at a glance.
 */
const SeatMeter = ({ occupied = 0, capacity = 0 }) => {
  const pct = capacity ? Math.min(Math.round((occupied / capacity) * 100), 100) : 0;
  const tone = pct >= 95 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-green-500';

  return (
    <div>
      <div className="flex justify-between text-xs text-gray-500 mb-1">
        <span>Seats</span>
        <span>
          {occupied} / {capacity}
        </span>
      </div>
      <div className="h-2 w-full bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full ${tone} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
};

/**
 * The stop list rendered as a vertical timeline. `highlight` is the stop that
 * belongs to the viewing student, which is the one thing they actually came to
 * this page to find.
 */
const StopTimeline = ({ stops = [], highlightPickup, highlightDrop }) => {
  if (!stops.length) {
    return <p className="text-sm text-gray-400">No stops recorded for this route yet.</p>;
  }

  return (
    <ol className="relative border-l-2 border-dashed border-blue-200 ml-3">
      {stops.map((stop) => {
        const isPickup = stop.name === highlightPickup;
        const isDrop = stop.name === highlightDrop;
        const isMine = isPickup || isDrop;

        return (
          <li key={stop._id || stop.sequence} className="mb-5 ml-5">
            <span
              className={`absolute -left-[9px] flex items-center justify-center w-4 h-4 rounded-full ring-4 ring-white ${
                isMine ? 'bg-blue-600' : 'bg-gray-300'
              }`}
            />
            <div
              className={`rounded-xl px-4 py-3 border ${
                isMine ? 'border-blue-300 bg-blue-50' : 'border-gray-100 bg-white'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold text-gray-800 text-sm">
                    {stop.sequence}. {stop.name}
                    {isPickup && (
                      <span className="ml-2 text-[11px] bg-blue-600 text-white px-2 py-0.5 rounded-full">
                        Your pickup
                      </span>
                    )}
                    {isDrop && !isPickup && (
                      <span className="ml-2 text-[11px] bg-indigo-600 text-white px-2 py-0.5 rounded-full">
                        Your drop
                      </span>
                    )}
                  </p>
                  {stop.landmark && (
                    <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1">
                      <MapPin size={12} /> {stop.landmark}
                    </p>
                  )}
                </div>
                <div className="text-right text-xs text-gray-600">
                  <p className="flex items-center gap-1 justify-end">
                    <Clock size={12} /> Pickup {formatTime(stop.pickupTime)}
                  </p>
                  <p className="mt-0.5">Drop {formatTime(stop.dropTime)}</p>
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
};

const Transport = () => {
  const { user } = useContext(AuthContext);
  const displayName = user?.name || user?.user?.name || 'Student';

  const [myTransport, setMyTransport] = useState(null);
  const [assigned, setAssigned] = useState(false);
  const [routes, setRoutes] = useState([]);
  const [search, setSearch] = useState('');
  const [expandedRoute, setExpandedRoute] = useState(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadMyTransport = useCallback(async () => {
    try {
      const res = await api.get('/transport/me');
      setAssigned(Boolean(res.data.assigned));
      setMyTransport(res.data.data);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load your transport details right now.');
    }
  }, []);

  const loadRoutes = useCallback(async () => {
    try {
      const res = await api.get('/transport/routes', { params: { limit: 50 } });
      setRoutes(res.data.data || []);
    } catch (err) {
      // The catalogue is secondary information — a student with an assignment
      // still gets their card even if this call fails.
      console.error('Could not load the route catalogue', err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      await Promise.all([loadMyTransport(), loadRoutes()]);
      if (!cancelled) setLoading(false);
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [loadMyTransport, loadRoutes]);

  const visibleRoutes = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return routes;

    return routes.filter(
      (route) =>
        route.routeCode?.toLowerCase().includes(needle) ||
        route.routeName?.toLowerCase().includes(needle) ||
        (route.stops || []).some((stop) => stop.name?.toLowerCase().includes(needle))
    );
  }, [routes, search]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-t-4 border-b-4 border-blue-500" />
      </div>
    );
  }

  const assignment = myTransport?.assignment;
  const route = myTransport?.route;

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <Link
          to="/student"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4"
        >
          <ArrowLeft size={16} /> Back to dashboard
        </Link>

        <div className="bg-gradient-to-r from-amber-500 to-orange-600 rounded-2xl p-6 mb-6 text-white">
          <div className="flex items-center gap-3">
            <Bus size={30} />
            <div>
              <h1 className="text-2xl font-bold">School Transport</h1>
              <p className="text-amber-50 text-sm mt-0.5">
                {displayName} · your bus, your stop, your timings
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

        {assigned && assignment && route ? (
          <>
            {/* ---- The assigned bus ---- */}
            <div className="bg-white rounded-2xl shadow p-6 mb-6">
              <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
                <div>
                  <span className="inline-block text-xs font-semibold bg-amber-100 text-amber-800 px-2.5 py-1 rounded-full">
                    Route {route.routeCode}
                  </span>
                  <h2 className="text-xl font-bold text-gray-800 mt-2">{route.routeName}</h2>
                  <p className="text-sm text-gray-500 mt-1">
                    {DIRECTION_LABELS[assignment.direction] || assignment.direction} ·{' '}
                    {(route.operatingDays || []).join(', ')}
                  </p>
                </div>
                <span
                  className={`text-xs font-medium px-3 py-1 rounded-full ${
                    STATUS_STYLES[route.status] || 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {route.status}
                </span>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 mb-5">
                <div className="rounded-xl bg-gray-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-gray-400 mb-2">Driver</p>
                  <p className="font-semibold text-gray-800 flex items-center gap-2 text-sm">
                    <User size={14} /> {route.driver?.name || '—'}
                  </p>
                  <a
                    href={`tel:${route.driver?.phone}`}
                    className="text-sm text-blue-600 hover:underline flex items-center gap-2 mt-1"
                  >
                    <Phone size={14} /> {route.driver?.phone || '—'}
                  </a>
                  {route.attendant?.name && (
                    <p className="text-xs text-gray-500 mt-2">
                      Attendant: {route.attendant.name} {route.attendant.phone}
                    </p>
                  )}
                </div>

                <div className="rounded-xl bg-gray-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-gray-400 mb-2">Vehicle</p>
                  <p className="font-semibold text-gray-800 text-sm">
                    {route.vehicle?.registrationNumber || '—'}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">{route.vehicle?.model || 'Bus'}</p>
                  <div className="mt-3">
                    <SeatMeter
                      occupied={route.seatsOccupied}
                      capacity={route.vehicle?.capacity}
                    />
                  </div>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-blue-500 mb-1">Your pickup</p>
                  <p className="font-semibold text-gray-800">{assignment.pickupStop}</p>
                  <p className="text-sm text-blue-700 mt-1 flex items-center gap-1">
                    <Clock size={13} /> {formatTime(myTransport.myPickup?.pickupTime)}
                  </p>
                </div>
                <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-indigo-500 mb-1">Your drop</p>
                  <p className="font-semibold text-gray-800">{assignment.dropStop}</p>
                  <p className="text-sm text-indigo-700 mt-1 flex items-center gap-1">
                    <Clock size={13} /> {formatTime(myTransport.myDrop?.dropTime)}
                  </p>
                </div>
              </div>

              {assignment.monthlyFare > 0 && (
                <p className="text-xs text-gray-500 mt-4">
                  Monthly transport fare: ₹{assignment.monthlyFare}
                </p>
              )}
            </div>

            {/* ---- Full stop timeline ---- */}
            <div className="bg-white rounded-2xl shadow p-6">
              <h3 className="font-bold text-gray-800 mb-5 flex items-center gap-2">
                <CircleDot size={18} className="text-amber-500" />
                Route stops
              </h3>
              <StopTimeline
                stops={route.stops || []}
                highlightPickup={assignment.pickupStop}
                highlightDrop={assignment.dropStop}
              />
            </div>
          </>
        ) : (
          <>
            {/* ---- No assignment: show the catalogue ---- */}
            <div className="bg-white rounded-2xl shadow p-6 mb-6 text-center">
              <Bus size={40} className="mx-auto text-gray-300 mb-3" />
              <h2 className="font-bold text-gray-800 text-lg">
                You are not assigned to a school bus
              </h2>
              <p className="text-sm text-gray-500 mt-1 max-w-md mx-auto">
                Browse the routes below and speak to the transport office to be added. They will
                need your preferred boarding stop.
              </p>
            </div>

            <div className="relative mb-4">
              <Search size={16} className="absolute left-3 top-3 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by route, or by the stop nearest your home…"
                className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
            </div>

            <div className="space-y-3">
              {visibleRoutes.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-8">
                  No routes match that search.
                </p>
              )}

              {visibleRoutes.map((r) => (
                <div key={r._id} className="bg-white rounded-2xl shadow overflow-hidden">
                  <button
                    onClick={() => setExpandedRoute(expandedRoute === r._id ? null : r._id)}
                    className="w-full text-left px-5 py-4 hover:bg-gray-50 transition"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <span className="text-xs font-semibold bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">
                          {r.routeCode}
                        </span>
                        <p className="font-semibold text-gray-800 mt-1.5">{r.routeName}</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {(r.stops || []).length} stops · {r.operatingDays?.length || 0} days a week
                          {r.farePerMonth > 0 && ` · ₹${r.farePerMonth}/month`}
                        </p>
                      </div>
                      <div className="w-40">
                        <SeatMeter occupied={r.seatsOccupied} capacity={r.vehicle?.capacity} />
                      </div>
                    </div>
                  </button>

                  {expandedRoute === r._id && (
                    <div className="px-5 pb-5 pt-1 border-t border-gray-100">
                      <p className="text-xs text-gray-500 mb-4 mt-3">
                        Driver {r.driver?.name} · {r.driver?.phone} · Vehicle{' '}
                        {r.vehicle?.registrationNumber}
                      </p>
                      <StopTimeline stops={[...(r.stops || [])].sort((a, b) => a.sequence - b.sequence)} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default Transport;
