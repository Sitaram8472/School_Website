import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Building2,
  Plus,
  X,
  AlertCircle,
  CheckCircle2,
  Search,
  BedDouble,
  ArrowLeftRight,
  Wrench,
} from 'lucide-react';
import api from '../../utils/axios';

const EMPTY_ROOM = {
  block: '',
  roomNumber: '',
  floor: 0,
  hostelType: 'boys',
  roomType: 'double',
  capacity: 2,
  monthlyRent: 0,
  wardenName: '',
  wardenPhone: '',
  amenities: [],
  notes: '',
};

const AMENITY_CHOICES = ['Wi-Fi', 'Attached bath', 'Study table', 'Almirah', 'Fan', 'Heater', 'Balcony'];

const ROOM_STATUS_STYLES = {
  available: 'bg-green-100 text-green-700',
  full: 'bg-amber-100 text-amber-800',
  maintenance: 'bg-orange-100 text-orange-800',
  closed: 'bg-gray-200 text-gray-600',
};

const rateTone = (rate) =>
  rate >= 100 ? 'bg-red-500' : rate >= 75 ? 'bg-amber-500' : 'bg-green-500';

const HostelPanel = () => {
  const [rooms, setRooms] = useState([]);
  const [summary, setSummary] = useState(null);
  const [boarders, setBoarders] = useState([]);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_ROOM);
  const [editingId, setEditingId] = useState(null);

  const [allocateTarget, setAllocateTarget] = useState(null);
  const [allocateForm, setAllocateForm] = useState({
    studentId: '',
    bedNumber: '',
    className: '',
    guardianName: '',
    guardianPhone: '',
  });

  const [transferTarget, setTransferTarget] = useState(null);
  const [transferForm, setTransferForm] = useState({ toRoomId: '', bedNumber: '', reason: '' });

  const [blockFilter, setBlockFilter] = useState('All');
  const [search, setSearch] = useState('');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 4000);
  };

  const loadRooms = useCallback(async () => {
    try {
      const res = await api.get('/hostel/rooms', { params: { limit: 200 } });
      setRooms(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load rooms.');
    }
  }, []);

  const loadSummary = useCallback(async () => {
    try {
      const res = await api.get('/hostel/summary');
      setSummary(res.data.data);
    } catch (err) {
      console.error('Could not load the occupancy summary', err);
    }
  }, []);

  const loadBoarders = useCallback(async () => {
    try {
      const res = await api.get('/hostel/boarders', { params: { limit: 300 } });
      setBoarders(res.data.data || []);
    } catch (err) {
      console.error('Could not load the boarder list', err);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await Promise.all([loadRooms(), loadSummary(), loadBoarders()]);
      setLoading(false);
    };
    load();
  }, [loadRooms, loadSummary, loadBoarders]);

  const refresh = () => Promise.all([loadRooms(), loadSummary(), loadBoarders()]);

  const blocks = useMemo(() => {
    const set = new Set(rooms.map((room) => room.block).filter(Boolean));
    return ['All', ...[...set].sort()];
  }, [rooms]);

  const visibleRooms = useMemo(() => {
    const needle = search.trim().toLowerCase();

    return rooms.filter((room) => {
      if (blockFilter !== 'All' && room.block !== blockFilter) return false;
      if (!needle) return true;
      return (
        room.roomNumber?.toLowerCase().includes(needle) ||
        room.block?.toLowerCase().includes(needle) ||
        (room.beds || []).some((bed) => bed.occupantName?.toLowerCase().includes(needle))
      );
    });
  }, [rooms, blockFilter, search]);

  const toggleAmenity = (item) => {
    setForm((prev) => ({
      ...prev,
      amenities: prev.amenities.includes(item)
        ? prev.amenities.filter((a) => a !== item)
        : [...prev.amenities, item],
    }));
  };

  const handleSaveRoom = async (event) => {
    event.preventDefault();
    setError('');

    if (!form.block.trim() || !form.roomNumber.trim()) {
      setError('A room needs both a block and a room number.');
      return;
    }
    if (Number(form.capacity) < 1) {
      setError('Capacity must be at least 1.');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ...form,
        floor: Number(form.floor) || 0,
        capacity: Number(form.capacity),
        monthlyRent: Number(form.monthlyRent) || 0,
      };

      if (editingId) {
        await api.put(`/hostel/rooms/${editingId}`, payload);
        flash('Room updated.');
      } else {
        await api.post('/hostel/rooms', payload);
        flash('Room created with its beds.');
      }

      setForm(EMPTY_ROOM);
      setEditingId(null);
      setShowForm(false);
      await refresh();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save the room.');
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (room) => {
    setEditingId(room._id);
    setForm({
      block: room.block || '',
      roomNumber: room.roomNumber || '',
      floor: room.floor || 0,
      hostelType: room.hostelType || 'boys',
      roomType: room.roomType || 'double',
      capacity: room.capacity || 2,
      monthlyRent: room.monthlyRent || 0,
      wardenName: room.wardenName || '',
      wardenPhone: room.wardenPhone || '',
      amenities: room.amenities || [],
      notes: room.notes || '',
    });
    setShowForm(true);
    setError('');
  };

  const handleAllocate = async (event) => {
    event.preventDefault();
    setError('');

    if (!allocateForm.studentId.trim() || !allocateForm.bedNumber) {
      setError('A student id and a bed are both required.');
      return;
    }

    setSaving(true);
    try {
      await api.post('/hostel/allocations', {
        ...allocateForm,
        roomId: allocateTarget._id,
      });
      flash('Bed allocated.');
      setAllocateTarget(null);
      setAllocateForm({
        studentId: '',
        bedNumber: '',
        className: '',
        guardianName: '',
        guardianPhone: '',
      });
      await refresh();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not allocate that bed.');
    } finally {
      setSaving(false);
    }
  };

  const handleTransfer = async (event) => {
    event.preventDefault();
    setError('');

    if (!transferForm.toRoomId || !transferForm.bedNumber) {
      setError('Pick a destination room and bed.');
      return;
    }

    setSaving(true);
    try {
      await api.post('/hostel/allocations/transfer', {
        studentId: transferTarget.student?._id || transferTarget.student,
        ...transferForm,
      });
      flash('Student transferred. The old allocation is kept as history.');
      setTransferTarget(null);
      setTransferForm({ toRoomId: '', bedNumber: '', reason: '' });
      await refresh();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not transfer that student.');
    } finally {
      setSaving(false);
    }
  };

  const handleVacate = async (allocation) => {
    if (!window.confirm(`Vacate ${allocation.studentName || 'this student'}'s bed?`)) return;

    setError('');
    try {
      await api.patch(`/hostel/allocations/${allocation._id}/vacate`, {
        reason: 'Vacated by the warden',
      });
      flash('Bed vacated.');
      await refresh();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not vacate that bed.');
    }
  };

  const handleMaintenance = async (room) => {
    const next = room.status === 'maintenance' ? 'available' : 'maintenance';
    setError('');
    try {
      await api.put(`/hostel/rooms/${room._id}`, { status: next });
      flash(`${room.block}-${room.roomNumber} is now ${next}.`);
      await refresh();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not change the room status.');
    }
  };

  const transferDestinations = useMemo(
    () => rooms.filter((room) => room.status !== 'closed' && room.bedsAvailable > 0),
    [rooms]
  );

  const selectedTransferRoom = useMemo(
    () => rooms.find((room) => room._id === transferForm.toRoomId),
    [rooms, transferForm.toRoomId]
  );

  if (loading) {
    return (
      <div className="bg-white rounded-2xl shadow p-10 flex justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-t-4 border-b-4 border-purple-500" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ---- Summary ---- */}
      {summary && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Rooms', value: summary.totalRooms },
              { label: 'Boarders', value: summary.activeBoarders },
              { label: 'Beds free', value: summary.totalFree },
              { label: 'Occupied', value: `${summary.occupancyRate}%` },
            ].map((tile) => (
              <div key={tile.label} className="bg-white rounded-xl shadow p-4 text-center">
                <div className="text-xl font-bold text-gray-800">{tile.value}</div>
                <div className="text-xs text-gray-500 mt-1">{tile.label}</div>
              </div>
            ))}
          </div>

          {summary.byBlock?.length > 0 && (
            <div className="bg-white rounded-2xl shadow p-5">
              <h4 className="text-sm font-semibold text-gray-700 mb-3">Occupancy by block</h4>
              <div className="space-y-3">
                {summary.byBlock.map((block) => (
                  <div key={block.block}>
                    <div className="flex justify-between text-xs text-gray-600 mb-1">
                      <span className="font-medium">
                        Block {block.block}{' '}
                        <span className="text-gray-400 capitalize">({block.hostelType})</span>
                      </span>
                      <span>
                        {block.occupied}/{block.capacity} · {block.free} free
                      </span>
                    </div>
                    <div className="h-2 w-full bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full ${rateTone(block.occupancyRate)} transition-all`}
                        style={{ width: `${Math.min(block.occupancyRate, 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-xl text-sm">
          <CheckCircle2 size={16} />
          <span>{success}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-bold text-gray-800 flex items-center gap-2">
          <Building2 size={18} className="text-purple-500" /> Rooms
        </h3>
        <button
          onClick={() => {
            setForm(EMPTY_ROOM);
            setEditingId(null);
            setShowForm(!showForm);
            setError('');
          }}
          className="text-sm bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition flex items-center gap-1.5"
        >
          {showForm ? <X size={15} /> : <Plus size={15} />}
          {showForm ? 'Close' : 'New room'}
        </button>
      </div>

      {/* ---- Room form ---- */}
      {showForm && (
        <form onSubmit={handleSaveRoom} className="bg-white rounded-2xl shadow p-6 space-y-5">
          <div className="grid gap-4 sm:grid-cols-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Block</label>
              <input
                value={form.block}
                onChange={(e) => setForm({ ...form, block: e.target.value.toUpperCase() })}
                disabled={Boolean(editingId)}
                placeholder="A"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm disabled:bg-gray-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Room number</label>
              <input
                value={form.roomNumber}
                onChange={(e) => setForm({ ...form, roomNumber: e.target.value.toUpperCase() })}
                disabled={Boolean(editingId)}
                placeholder="101"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm disabled:bg-gray-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Floor</label>
              <input
                type="number"
                min="0"
                value={form.floor}
                onChange={(e) => setForm({ ...form, floor: e.target.value })}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Hostel</label>
              <select
                value={form.hostelType}
                onChange={(e) => setForm({ ...form, hostelType: e.target.value })}
                disabled={Boolean(editingId)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm disabled:bg-gray-100"
              >
                <option value="boys">Boys</option>
                <option value="girls">Girls</option>
              </select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Room type</label>
              <select
                value={form.roomType}
                onChange={(e) => setForm({ ...form, roomType: e.target.value })}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              >
                <option value="single">Single</option>
                <option value="double">Double</option>
                <option value="triple">Triple</option>
                <option value="dormitory">Dormitory</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Capacity</label>
              <input
                type="number"
                min="1"
                value={form.capacity}
                onChange={(e) => setForm({ ...form, capacity: e.target.value })}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
              <p className="text-[11px] text-gray-400 mt-1">Beds are created automatically.</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Rent / month (₹)</label>
              <input
                type="number"
                min="0"
                value={form.monthlyRent}
                onChange={(e) => setForm({ ...form, monthlyRent: e.target.value })}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Warden</label>
              <input
                value={form.wardenName}
                onChange={(e) => setForm({ ...form, wardenName: e.target.value })}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-2">Amenities</label>
            <div className="flex flex-wrap gap-2">
              {AMENITY_CHOICES.map((item) => (
                <button
                  type="button"
                  key={item}
                  onClick={() => toggleAmenity(item)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                    form.amenities.includes(item)
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          <button
            type="submit"
            disabled={saving}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm px-5 py-2.5 rounded-lg transition"
          >
            {saving ? 'Saving…' : editingId ? 'Update room' : 'Create room'}
          </button>
        </form>
      )}

      {/* ---- Filters ---- */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={16} className="absolute left-3 top-2.5 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search room or boarder…"
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 text-sm"
          />
        </div>
        <select
          value={blockFilter}
          onChange={(e) => setBlockFilter(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-200 text-sm"
        >
          {blocks.map((block) => (
            <option key={block} value={block}>
              {block === 'All' ? 'All blocks' : `Block ${block}`}
            </option>
          ))}
        </select>
      </div>

      {/* ---- Room grid ---- */}
      <div className="grid gap-3 sm:grid-cols-2">
        {visibleRooms.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-10 bg-white rounded-2xl shadow sm:col-span-2">
            No rooms match those filters.
          </p>
        )}

        {visibleRooms.map((room) => (
          <div key={room._id} className="bg-white rounded-2xl shadow p-5">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <p className="font-bold text-gray-800">
                  {room.block}-{room.roomNumber}
                </p>
                <p className="text-xs text-gray-500 capitalize mt-0.5">
                  {room.roomType} · {room.hostelType} · floor {room.floor}
                </p>
              </div>
              <span
                className={`text-[11px] px-2 py-0.5 rounded-full ${
                  ROOM_STATUS_STYLES[room.status] || 'bg-gray-100 text-gray-600'
                }`}
              >
                {room.status}
              </span>
            </div>

            <div className="flex flex-wrap gap-1.5 mb-3">
              {(room.beds || []).map((bed) => (
                <span
                  key={bed._id || bed.bedNumber}
                  title={bed.occupantName || bed.blockedReason || 'Vacant'}
                  className={`text-[11px] px-2 py-1 rounded-md border ${
                    bed.status === 'occupied'
                      ? 'bg-purple-50 border-purple-200 text-purple-800'
                      : bed.status === 'blocked'
                      ? 'bg-orange-50 border-orange-200 text-orange-700'
                      : 'bg-gray-50 border-dashed border-gray-200 text-gray-400'
                  }`}
                >
                  <BedDouble size={10} className="inline mr-1" />
                  {bed.bedNumber}
                  {bed.occupantName ? ` · ${bed.occupantName.split(' ')[0]}` : ''}
                </span>
              ))}
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setAllocateTarget(room)}
                disabled={room.bedsAvailable === 0 || room.status === 'maintenance'}
                className="text-xs bg-green-600 hover:bg-green-700 disabled:opacity-40 text-white px-3 py-1.5 rounded-lg transition"
              >
                Allocate
              </button>
              <button
                onClick={() => startEdit(room)}
                className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg transition"
              >
                Edit
              </button>
              <button
                onClick={() => handleMaintenance(room)}
                className="text-xs bg-orange-100 hover:bg-orange-200 text-orange-800 px-3 py-1.5 rounded-lg transition flex items-center gap-1"
              >
                <Wrench size={12} />
                {room.status === 'maintenance' ? 'Reopen' : 'Maintenance'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* ---- Boarder list ---- */}
      <div className="bg-white rounded-2xl shadow p-5">
        <h4 className="text-sm font-semibold text-gray-700 mb-3">
          Current boarders ({boarders.length})
        </h4>

        {boarders.length === 0 ? (
          <p className="text-sm text-gray-400 py-4 text-center">Nobody is allocated a bed yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 max-h-80 overflow-y-auto">
            {boarders.map((entry) => (
              <li key={entry._id} className="py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-gray-800 truncate">
                    {entry.studentName || entry.student?.name}
                  </p>
                  <p className="text-[11px] text-gray-400">
                    {entry.roomLabel} · Bed {entry.bedNumber}
                    {entry.className && ` · ${entry.className}`}
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => setTransferTarget(entry)}
                    className="text-[11px] text-blue-600 hover:underline flex items-center gap-1"
                  >
                    <ArrowLeftRight size={11} /> Transfer
                  </button>
                  <button
                    onClick={() => handleVacate(entry)}
                    className="text-[11px] text-red-600 hover:underline"
                  >
                    Vacate
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---- Allocate dialog ---- */}
      {allocateTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <form
            onSubmit={handleAllocate}
            className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-gray-800">
                Allocate in {allocateTarget.block}-{allocateTarget.roomNumber}
              </h4>
              <button type="button" onClick={() => setAllocateTarget(null)}>
                <X size={18} className="text-gray-400 hover:text-gray-700" />
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Student id</label>
              <input
                value={allocateForm.studentId}
                onChange={(e) => setAllocateForm({ ...allocateForm, studentId: e.target.value })}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Bed</label>
                <select
                  value={allocateForm.bedNumber}
                  onChange={(e) => setAllocateForm({ ...allocateForm, bedNumber: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                >
                  <option value="">Select…</option>
                  {(allocateTarget.beds || [])
                    .filter((bed) => bed.status === 'vacant')
                    .map((bed) => (
                      <option key={bed.bedNumber} value={bed.bedNumber}>
                        Bed {bed.bedNumber}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Class</label>
                <input
                  value={allocateForm.className}
                  onChange={(e) => setAllocateForm({ ...allocateForm, className: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Guardian</label>
                <input
                  value={allocateForm.guardianName}
                  onChange={(e) =>
                    setAllocateForm({ ...allocateForm, guardianName: e.target.value })
                  }
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Guardian phone</label>
                <input
                  value={allocateForm.guardianPhone}
                  onChange={(e) =>
                    setAllocateForm({ ...allocateForm, guardianPhone: e.target.value })
                  }
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="w-full bg-green-600 hover:bg-green-700 disabled:opacity-60 text-white text-sm py-2.5 rounded-lg transition"
            >
              {saving ? 'Allocating…' : 'Allocate bed'}
            </button>
          </form>
        </div>
      )}

      {/* ---- Transfer dialog ---- */}
      {transferTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <form
            onSubmit={handleTransfer}
            className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <div>
                <h4 className="font-bold text-gray-800">Transfer boarder</h4>
                <p className="text-xs text-gray-500 mt-0.5">
                  {transferTarget.studentName} · currently {transferTarget.roomLabel}/
                  {transferTarget.bedNumber}
                </p>
              </div>
              <button type="button" onClick={() => setTransferTarget(null)}>
                <X size={18} className="text-gray-400 hover:text-gray-700" />
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Move to room</label>
              <select
                value={transferForm.toRoomId}
                onChange={(e) =>
                  setTransferForm({ ...transferForm, toRoomId: e.target.value, bedNumber: '' })
                }
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              >
                <option value="">Select a room with a free bed…</option>
                {transferDestinations.map((room) => (
                  <option key={room._id} value={room._id}>
                    {room.block}-{room.roomNumber} ({room.bedsAvailable} free · {room.hostelType})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Bed</label>
              <select
                value={transferForm.bedNumber}
                onChange={(e) => setTransferForm({ ...transferForm, bedNumber: e.target.value })}
                disabled={!selectedTransferRoom}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm disabled:bg-gray-100"
              >
                <option value="">Select…</option>
                {(selectedTransferRoom?.beds || [])
                  .filter((bed) => bed.status === 'vacant')
                  .map((bed) => (
                    <option key={bed.bedNumber} value={bed.bedNumber}>
                      Bed {bed.bedNumber}
                    </option>
                  ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Reason</label>
              <input
                value={transferForm.reason}
                onChange={(e) => setTransferForm({ ...transferForm, reason: e.target.value })}
                placeholder="Why is the student moving?"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>

            <button
              type="submit"
              disabled={saving}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm py-2.5 rounded-lg transition"
            >
              {saving ? 'Transferring…' : 'Transfer'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
};

export default HostelPanel;
