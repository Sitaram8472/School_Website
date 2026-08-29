import React, { useState, useEffect, useCallback, useContext } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  BedDouble,
  Building2,
  Phone,
  User,
  AlertCircle,
  Users,
  History,
  Wifi,
} from 'lucide-react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';

const STATUS_STYLES = {
  active: 'bg-green-100 text-green-700',
  vacated: 'bg-gray-200 text-gray-600',
  transferred: 'bg-blue-100 text-blue-700',
};

const ROOM_STATUS_STYLES = {
  available: 'bg-green-100 text-green-700',
  full: 'bg-amber-100 text-amber-800',
  maintenance: 'bg-orange-100 text-orange-800',
  closed: 'bg-gray-200 text-gray-600',
};

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—';

/**
 * Renders the room's beds as a small grid so a boarder can see, literally,
 * which bed is theirs and who is next to them.
 */
const BedGrid = ({ beds = [], myBedNumber }) => (
  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
    {beds.map((bed) => {
      const isMine = bed.bedNumber === myBedNumber;

      return (
        <div
          key={bed._id || bed.bedNumber}
          className={`rounded-xl border p-3 text-center ${
            isMine
              ? 'border-purple-400 bg-purple-50'
              : bed.status === 'occupied'
              ? 'border-gray-200 bg-gray-50'
              : bed.status === 'blocked'
              ? 'border-orange-200 bg-orange-50'
              : 'border-dashed border-gray-200 bg-white'
          }`}
        >
          <BedDouble
            size={18}
            className={`mx-auto mb-1.5 ${
              isMine
                ? 'text-purple-600'
                : bed.status === 'occupied'
                ? 'text-gray-500'
                : bed.status === 'blocked'
                ? 'text-orange-500'
                : 'text-gray-300'
            }`}
          />
          <p className="text-sm font-semibold text-gray-800">Bed {bed.bedNumber}</p>
          <p className="text-[11px] text-gray-500 mt-0.5 truncate">
            {isMine ? 'You' : bed.occupantName || (bed.status === 'blocked' ? 'Blocked' : 'Vacant')}
          </p>
        </div>
      );
    })}
  </div>
);

const HostelRoom = () => {
  const { user } = useContext(AuthContext);
  const displayName = user?.name || user?.user?.name || 'Student';

  const [allocated, setAllocated] = useState(false);
  const [details, setDetails] = useState(null);
  const [history, setHistory] = useState([]);
  const [summary, setSummary] = useState(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadMyRoom = useCallback(async () => {
    try {
      const res = await api.get('/hostel/me');
      setAllocated(Boolean(res.data.allocated));
      setDetails(res.data.data);
      setHistory(res.data.history || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load your hostel details right now.');
    }
  }, []);

  const loadSummary = useCallback(async () => {
    try {
      const res = await api.get('/hostel/summary');
      setSummary(res.data.data);
    } catch {
      // Only wardens can read the summary. A boarder getting a 403 here is
      // expected, not an error worth showing them.
      setSummary(null);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await Promise.all([loadMyRoom(), loadSummary()]);
      setLoading(false);
    };
    load();
  }, [loadMyRoom, loadSummary]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-t-4 border-b-4 border-purple-500" />
      </div>
    );
  }

  const allocation = details?.allocation;
  const room = details?.room;
  const roommates = details?.roommates || [];

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <Link
          to="/student"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4"
        >
          <ArrowLeft size={16} /> Back to dashboard
        </Link>

        <div className="bg-gradient-to-r from-purple-600 to-fuchsia-700 rounded-2xl p-6 mb-6 text-white">
          <div className="flex items-center gap-3">
            <Building2 size={30} />
            <div>
              <h1 className="text-2xl font-bold">Hostel</h1>
              <p className="text-purple-100 text-sm mt-0.5">
                {displayName} · your room, your bed, your warden
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

        {allocated && allocation && room ? (
          <>
            <div className="bg-white rounded-2xl shadow p-6 mb-6">
              <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
                <div>
                  <span className="inline-block text-xs font-semibold bg-purple-100 text-purple-800 px-2.5 py-1 rounded-full">
                    Block {room.block}
                  </span>
                  <h2 className="text-2xl font-bold text-gray-800 mt-2">
                    Room {room.roomNumber}
                    <span className="text-base font-medium text-gray-400 ml-2">
                      · Bed {allocation.bedNumber}
                    </span>
                  </h2>
                  <p className="text-sm text-gray-500 mt-1 capitalize">
                    {room.roomType} · {room.hostelType} hostel · floor {room.floor}
                  </p>
                </div>
                <span
                  className={`text-xs font-medium px-3 py-1 rounded-full ${
                    ROOM_STATUS_STYLES[room.status] || 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {room.status}
                </span>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 mb-5">
                <div className="rounded-xl bg-gray-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-gray-400 mb-2">Warden</p>
                  <p className="font-semibold text-gray-800 flex items-center gap-2 text-sm">
                    <User size={14} /> {room.wardenName || 'Not assigned'}
                  </p>
                  {room.wardenPhone && (
                    <a
                      href={`tel:${room.wardenPhone}`}
                      className="text-sm text-blue-600 hover:underline flex items-center gap-2 mt-1"
                    >
                      <Phone size={14} /> {room.wardenPhone}
                    </a>
                  )}
                </div>

                <div className="rounded-xl bg-gray-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-gray-400 mb-2">Stay</p>
                  <p className="text-sm text-gray-700">
                    Since {formatDate(allocation.allocatedFrom)}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {allocation.nightsStayed} night(s)
                    {room.monthlyRent > 0 && ` · ₹${room.monthlyRent}/month`}
                  </p>
                </div>
              </div>

              {(room.amenities || []).length > 0 && (
                <div className="mb-5">
                  <p className="text-xs uppercase tracking-wide text-gray-400 mb-2">Amenities</p>
                  <div className="flex flex-wrap gap-2">
                    {room.amenities.map((item) => (
                      <span
                        key={item}
                        className="text-xs bg-purple-50 text-purple-700 px-2.5 py-1 rounded-full flex items-center gap-1"
                      >
                        <Wifi size={11} /> {item}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <p className="text-xs uppercase tracking-wide text-gray-400 mb-3">
                  Room layout ({room.occupiedBeds}/{room.capacity} beds taken)
                </p>
                <BedGrid beds={room.beds || []} myBedNumber={allocation.bedNumber} />
              </div>
            </div>

            {roommates.length > 0 && (
              <div className="bg-white rounded-2xl shadow p-6 mb-6">
                <h3 className="font-bold text-gray-800 mb-4 flex items-center gap-2">
                  <Users size={18} className="text-purple-500" /> Roommates
                </h3>
                <ul className="divide-y divide-gray-100">
                  {roommates.map((mate) => (
                    <li key={mate.bedNumber} className="py-2.5 flex items-center justify-between">
                      <span className="text-sm text-gray-800">{mate.name || 'Unnamed'}</span>
                      <span className="text-xs text-gray-400">Bed {mate.bedNumber}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <div className="bg-white rounded-2xl shadow p-8 mb-6 text-center">
            <BedDouble size={40} className="mx-auto text-gray-300 mb-3" />
            <h2 className="font-bold text-gray-800 text-lg">You do not have a hostel room</h2>
            <p className="text-sm text-gray-500 mt-1 max-w-md mx-auto">
              If you are a boarder, contact the hostel warden's office to be allocated a bed.
            </p>

            {summary && (
              <div className="mt-6 grid grid-cols-3 gap-3 max-w-md mx-auto">
                <div className="bg-gray-50 rounded-xl p-3">
                  <div className="text-lg font-bold text-gray-800">{summary.totalFree}</div>
                  <div className="text-[11px] text-gray-500">Beds free</div>
                </div>
                <div className="bg-gray-50 rounded-xl p-3">
                  <div className="text-lg font-bold text-gray-800">{summary.totalRooms}</div>
                  <div className="text-[11px] text-gray-500">Rooms</div>
                </div>
                <div className="bg-gray-50 rounded-xl p-3">
                  <div className="text-lg font-bold text-gray-800">{summary.occupancyRate}%</div>
                  <div className="text-[11px] text-gray-500">Occupied</div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ---- Allocation history ---- */}
        {history.length > 0 && (
          <div className="bg-white rounded-2xl shadow p-6">
            <h3 className="font-bold text-gray-800 mb-4 flex items-center gap-2">
              <History size={18} className="text-purple-500" /> Your allocation history
            </h3>
            <ul className="space-y-3">
              {history.map((entry) => (
                <li
                  key={entry._id}
                  className="flex flex-wrap items-center justify-between gap-2 border border-gray-100 rounded-xl px-4 py-3"
                >
                  <div>
                    <p className="text-sm font-semibold text-gray-800">
                      {entry.roomLabel} · Bed {entry.bedNumber}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {formatDate(entry.allocatedFrom)} → {formatDate(entry.allocatedTo) }
                      {entry.vacateReason && ` · ${entry.vacateReason}`}
                    </p>
                  </div>
                  <span
                    className={`text-[11px] px-2.5 py-1 rounded-full ${
                      STATUS_STYLES[entry.status] || 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {entry.status}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
};

export default HostelRoom;
