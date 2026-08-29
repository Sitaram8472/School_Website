import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Bus,
  Plus,
  Trash2,
  Users,
  AlertCircle,
  CheckCircle2,
  X,
  MapPin,
  GripVertical,
} from 'lucide-react';
import api from '../../utils/axios';

const EMPTY_STOP = { name: '', landmark: '', pickupTime: '07:30', dropTime: '15:30' };

const EMPTY_ROUTE = {
  routeCode: '',
  routeName: '',
  description: '',
  vehicle: { registrationNumber: '', model: '', capacity: 40 },
  driver: { name: '', phone: '', licenseNumber: '' },
  attendant: { name: '', phone: '' },
  operatingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  farePerMonth: 0,
  stops: [{ ...EMPTY_STOP }, { ...EMPTY_STOP, name: 'School Campus' }],
};

const ALL_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const STATUS_STYLES = {
  active: 'bg-green-100 text-green-700',
  suspended: 'bg-yellow-100 text-yellow-800',
  retired: 'bg-gray-200 text-gray-600',
};

const occupancyTone = (rate) =>
  rate >= 95 ? 'bg-red-500' : rate >= 75 ? 'bg-amber-500' : 'bg-green-500';

const TransportPanel = () => {
  const [routes, setRoutes] = useState([]);
  const [summary, setSummary] = useState(null);
  const [roster, setRoster] = useState(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_ROUTE);
  const [editingId, setEditingId] = useState(null);

  const [assignTarget, setAssignTarget] = useState(null);
  const [assignForm, setAssignForm] = useState({
    studentId: '',
    className: '',
    pickupStop: '',
    dropStop: '',
    direction: 'both',
  });

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 4000);
  };

  const loadRoutes = useCallback(async () => {
    try {
      const res = await api.get('/transport/routes', { params: { limit: 100 } });
      setRoutes(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load routes.');
    }
  }, []);

  const loadSummary = useCallback(async () => {
    try {
      const res = await api.get('/transport/summary');
      setSummary(res.data.data);
    } catch (err) {
      console.error('Could not load the transport summary', err);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await Promise.all([loadRoutes(), loadSummary()]);
      setLoading(false);
    };
    load();
  }, [loadRoutes, loadSummary]);

  const refresh = async () => {
    await Promise.all([loadRoutes(), loadSummary()]);
  };

  // ---- Stop list editing -------------------------------------------------
  // Sequences are never edited by hand here; the server renumbers from array
  // order on save, so moving a row is all the UI has to do.

  const updateStop = (index, field, value) => {
    setForm((prev) => {
      const stops = [...prev.stops];
      stops[index] = { ...stops[index], [field]: value };
      return { ...prev, stops };
    });
  };

  const addStop = () => {
    setForm((prev) => ({ ...prev, stops: [...prev.stops, { ...EMPTY_STOP }] }));
  };

  const removeStop = (index) => {
    setForm((prev) => {
      if (prev.stops.length <= 2) return prev;
      return { ...prev, stops: prev.stops.filter((_, i) => i !== index) };
    });
  };

  const moveStop = (index, delta) => {
    setForm((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.stops.length) return prev;
      const stops = [...prev.stops];
      [stops[index], stops[target]] = [stops[target], stops[index]];
      return { ...prev, stops };
    });
  };

  const toggleDay = (day) => {
    setForm((prev) => ({
      ...prev,
      operatingDays: prev.operatingDays.includes(day)
        ? prev.operatingDays.filter((d) => d !== day)
        : [...prev.operatingDays, day],
    }));
  };

  // ---- Save --------------------------------------------------------------

  const validateForm = () => {
    if (!form.routeCode.trim()) return 'Give the route a code, e.g. R-04.';
    if (!form.routeName.trim()) return 'Give the route a name.';
    if (!form.driver.name.trim() || !form.driver.phone.trim())
      return "The driver's name and phone number are required.";
    if (!form.vehicle.registrationNumber.trim()) return 'The vehicle registration number is required.';
    if (Number(form.vehicle.capacity) < 1) return 'Capacity must be at least 1.';

    const named = form.stops.filter((s) => s.name.trim());
    if (named.length < 2) return 'A route needs at least two named stops.';

    const duplicates = new Set(named.map((s) => s.name.trim().toLowerCase()));
    if (duplicates.size !== named.length) return 'Two stops share the same name.';

    return '';
  };

  const handleSave = async (event) => {
    event.preventDefault();
    setError('');

    const problem = validateForm();
    if (problem) {
      setError(problem);
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ...form,
        farePerMonth: Number(form.farePerMonth) || 0,
        vehicle: { ...form.vehicle, capacity: Number(form.vehicle.capacity) },
        stops: form.stops
          .filter((s) => s.name.trim())
          .map((stop, index) => ({ ...stop, sequence: index + 1 })),
      };

      if (editingId) {
        // Route details and the stop list are two endpoints — the second one
        // refuses edits that would strand an assigned student.
        await api.put(`/transport/routes/${editingId}`, payload);
        await api.put(`/transport/routes/${editingId}/stops`, { stops: payload.stops });
        flash('Route updated.');
      } else {
        await api.post('/transport/routes', payload);
        flash('Route created.');
      }

      setForm(EMPTY_ROUTE);
      setEditingId(null);
      setShowForm(false);
      await refresh();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save the route.');
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (route) => {
    setEditingId(route._id);
    setForm({
      routeCode: route.routeCode || '',
      routeName: route.routeName || '',
      description: route.description || '',
      vehicle: {
        registrationNumber: route.vehicle?.registrationNumber || '',
        model: route.vehicle?.model || '',
        capacity: route.vehicle?.capacity || 40,
      },
      driver: {
        name: route.driver?.name || '',
        phone: route.driver?.phone || '',
        licenseNumber: route.driver?.licenseNumber || '',
      },
      attendant: {
        name: route.attendant?.name || '',
        phone: route.attendant?.phone || '',
      },
      operatingDays: route.operatingDays || [],
      farePerMonth: route.farePerMonth || 0,
      stops: [...(route.stops || [])]
        .sort((a, b) => a.sequence - b.sequence)
        .map((s) => ({
          name: s.name,
          landmark: s.landmark || '',
          pickupTime: s.pickupTime,
          dropTime: s.dropTime,
        })),
    });
    setShowForm(true);
    setError('');
  };

  const handleStatusChange = async (route, status) => {
    setError('');
    try {
      await api.put(`/transport/routes/${route._id}`, { status });
      flash(`Route ${route.routeCode} is now ${status}.`);
      await refresh();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not change the route status.');
    }
  };

  const openRoster = async (route) => {
    setError('');
    try {
      const res = await api.get(`/transport/routes/${route._id}/roster`);
      setRoster(res.data.data);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the roster.');
    }
  };

  const handleAssign = async (event) => {
    event.preventDefault();
    setError('');

    if (!assignForm.studentId.trim()) {
      setError('Paste the student id you want to assign.');
      return;
    }
    if (!assignForm.pickupStop || !assignForm.dropStop) {
      setError('Pick both a boarding stop and a drop stop.');
      return;
    }

    setSaving(true);
    try {
      await api.post('/transport/assignments', {
        ...assignForm,
        routeId: assignTarget._id,
      });
      flash('Student assigned to the route.');
      setAssignTarget(null);
      setAssignForm({
        studentId: '',
        className: '',
        pickupStop: '',
        dropStop: '',
        direction: 'both',
      });
      await refresh();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not assign that student.');
    } finally {
      setSaving(false);
    }
  };

  const handleCancelAssignment = async (assignment) => {
    if (!window.confirm(`Remove ${assignment.studentName || 'this student'} from the route?`)) return;

    setError('');
    try {
      await api.patch(`/transport/assignments/${assignment._id}/cancel`, {
        reason: 'Removed from the route by the transport office',
      });
      flash('Assignment cancelled and the seat freed.');
      if (roster) await openRoster({ _id: assignment.route });
      await refresh();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not cancel that assignment.');
    }
  };

  const assignStops = useMemo(
    () => (assignTarget ? [...(assignTarget.stops || [])].sort((a, b) => a.sequence - b.sequence) : []),
    [assignTarget]
  );

  if (loading) {
    return (
      <div className="bg-white rounded-2xl shadow p-10 flex justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-t-4 border-b-4 border-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ---- Fleet summary ---- */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Active routes', value: summary.activeRoutes },
            { label: 'Riders', value: summary.totalOccupied },
            { label: 'Seats free', value: summary.seatsFree },
            { label: 'Fleet load', value: `${summary.fleetOccupancyRate}%` },
          ].map((tile) => (
            <div key={tile.label} className="bg-white rounded-xl shadow p-4 text-center">
              <div className="text-xl font-bold text-gray-800">{tile.value}</div>
              <div className="text-xs text-gray-500 mt-1">{tile.label}</div>
            </div>
          ))}
        </div>
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

      <div className="flex items-center justify-between">
        <h3 className="font-bold text-gray-800 flex items-center gap-2">
          <Bus size={18} className="text-amber-500" /> Bus routes
        </h3>
        <button
          onClick={() => {
            setForm(EMPTY_ROUTE);
            setEditingId(null);
            setShowForm(!showForm);
            setError('');
          }}
          className="text-sm bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition flex items-center gap-1.5"
        >
          {showForm ? <X size={15} /> : <Plus size={15} />}
          {showForm ? 'Close' : 'New route'}
        </button>
      </div>

      {/* ---- Route form ---- */}
      {showForm && (
        <form onSubmit={handleSave} className="bg-white rounded-2xl shadow p-6 space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Route code</label>
              <input
                value={form.routeCode}
                onChange={(e) => setForm({ ...form, routeCode: e.target.value.toUpperCase() })}
                disabled={Boolean(editingId)}
                placeholder="R-04"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm disabled:bg-gray-100"
              />
              {editingId && (
                <p className="text-[11px] text-gray-400 mt-1">
                  The code is fixed once assignments point at it.
                </p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Route name</label>
              <input
                value={form.routeName}
                onChange={(e) => setForm({ ...form, routeName: e.target.value })}
                placeholder="Sector 12 – Civil Lines – School"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Vehicle number</label>
              <input
                value={form.vehicle.registrationNumber}
                onChange={(e) =>
                  setForm({
                    ...form,
                    vehicle: { ...form.vehicle, registrationNumber: e.target.value.toUpperCase() },
                  })
                }
                placeholder="MP04 AB 1234"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Model</label>
              <input
                value={form.vehicle.model}
                onChange={(e) =>
                  setForm({ ...form, vehicle: { ...form.vehicle, model: e.target.value } })
                }
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Capacity</label>
              <input
                type="number"
                min="1"
                value={form.vehicle.capacity}
                onChange={(e) =>
                  setForm({ ...form, vehicle: { ...form.vehicle, capacity: e.target.value } })
                }
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Driver name</label>
              <input
                value={form.driver.name}
                onChange={(e) =>
                  setForm({ ...form, driver: { ...form.driver, name: e.target.value } })
                }
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Driver phone</label>
              <input
                value={form.driver.phone}
                onChange={(e) =>
                  setForm({ ...form, driver: { ...form.driver, phone: e.target.value } })
                }
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Fare / month (₹)</label>
              <input
                type="number"
                min="0"
                value={form.farePerMonth}
                onChange={(e) => setForm({ ...form, farePerMonth: e.target.value })}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-2">Operating days</label>
            <div className="flex flex-wrap gap-2">
              {ALL_DAYS.map((day) => (
                <button
                  type="button"
                  key={day}
                  onClick={() => toggleDay(day)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                    form.operatingDays.includes(day)
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  {day}
                </button>
              ))}
            </div>
          </div>

          {/* ---- Stops ---- */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-gray-600">
                Stops (in the order the bus reaches them)
              </label>
              <button
                type="button"
                onClick={addStop}
                className="text-xs text-blue-600 hover:underline flex items-center gap-1"
              >
                <Plus size={13} /> Add stop
              </button>
            </div>

            <div className="space-y-2">
              {form.stops.map((stop, index) => (
                <div
                  key={index}
                  className="grid grid-cols-12 gap-2 items-center bg-gray-50 rounded-lg p-2"
                >
                  <div className="col-span-1 flex flex-col items-center text-gray-400">
                    <button
                      type="button"
                      onClick={() => moveStop(index, -1)}
                      className="text-[10px] hover:text-gray-700"
                    >
                      ▲
                    </button>
                    <GripVertical size={12} />
                    <button
                      type="button"
                      onClick={() => moveStop(index, 1)}
                      className="text-[10px] hover:text-gray-700"
                    >
                      ▼
                    </button>
                  </div>
                  <input
                    value={stop.name}
                    onChange={(e) => updateStop(index, 'name', e.target.value)}
                    placeholder={`Stop ${index + 1}`}
                    className="col-span-4 px-2 py-1.5 border border-gray-200 rounded text-sm"
                  />
                  <input
                    value={stop.landmark}
                    onChange={(e) => updateStop(index, 'landmark', e.target.value)}
                    placeholder="Landmark"
                    className="col-span-3 px-2 py-1.5 border border-gray-200 rounded text-sm"
                  />
                  <input
                    type="time"
                    value={stop.pickupTime}
                    onChange={(e) => updateStop(index, 'pickupTime', e.target.value)}
                    className="col-span-2 px-2 py-1.5 border border-gray-200 rounded text-sm"
                  />
                  <input
                    type="time"
                    value={stop.dropTime}
                    onChange={(e) => updateStop(index, 'dropTime', e.target.value)}
                    className="col-span-1 px-1 py-1.5 border border-gray-200 rounded text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => removeStop(index)}
                    disabled={form.stops.length <= 2}
                    className="col-span-1 text-gray-400 hover:text-red-500 disabled:opacity-30"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <button
            type="submit"
            disabled={saving}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm px-5 py-2.5 rounded-lg transition"
          >
            {saving ? 'Saving…' : editingId ? 'Update route' : 'Create route'}
          </button>
        </form>
      )}

      {/* ---- Route list ---- */}
      <div className="space-y-3">
        {routes.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-10 bg-white rounded-2xl shadow">
            No routes yet. Create the first one above.
          </p>
        )}

        {routes.map((route) => {
          const capacity = route.vehicle?.capacity || 0;
          const occupied = route.seatsOccupied || 0;
          const rate = capacity ? Math.round((occupied / capacity) * 100) : 0;

          return (
            <div key={route._id} className="bg-white rounded-2xl shadow p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-semibold bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">
                      {route.routeCode}
                    </span>
                    <span
                      className={`text-[11px] px-2 py-0.5 rounded-full ${
                        STATUS_STYLES[route.status] || 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {route.status}
                    </span>
                  </div>
                  <p className="font-semibold text-gray-800 mt-1.5">{route.routeName}</p>
                  <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1">
                    <MapPin size={12} /> {(route.stops || []).length} stops · {route.driver?.name} ·{' '}
                    {route.vehicle?.registrationNumber}
                  </p>
                </div>

                <div className="w-44">
                  <div className="flex justify-between text-xs text-gray-500 mb-1">
                    <span>{rate}% full</span>
                    <span>
                      {occupied}/{capacity}
                    </span>
                  </div>
                  <div className="h-2 w-full bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${occupancyTone(rate)} transition-all`}
                      style={{ width: `${Math.min(rate, 100)}%` }}
                    />
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 mt-4">
                <button
                  onClick={() => setAssignTarget(route)}
                  className="text-xs bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded-lg transition"
                >
                  Assign student
                </button>
                <button
                  onClick={() => openRoster(route)}
                  className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg transition flex items-center gap-1"
                >
                  <Users size={13} /> Roster
                </button>
                <button
                  onClick={() => startEdit(route)}
                  className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg transition"
                >
                  Edit
                </button>
                {route.status === 'active' ? (
                  <button
                    onClick={() => handleStatusChange(route, 'suspended')}
                    className="text-xs bg-yellow-100 hover:bg-yellow-200 text-yellow-800 px-3 py-1.5 rounded-lg transition"
                  >
                    Suspend
                  </button>
                ) : (
                  <button
                    onClick={() => handleStatusChange(route, 'active')}
                    className="text-xs bg-green-100 hover:bg-green-200 text-green-800 px-3 py-1.5 rounded-lg transition"
                  >
                    Resume
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ---- Assign dialog ---- */}
      {assignTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <form
            onSubmit={handleAssign}
            className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-gray-800">
                Assign to {assignTarget.routeCode}
              </h4>
              <button type="button" onClick={() => setAssignTarget(null)}>
                <X size={18} className="text-gray-400 hover:text-gray-700" />
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Student id</label>
              <input
                value={assignForm.studentId}
                onChange={(e) => setAssignForm({ ...assignForm, studentId: e.target.value })}
                placeholder="Paste the student's user id"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Class</label>
                <input
                  value={assignForm.className}
                  onChange={(e) => setAssignForm({ ...assignForm, className: e.target.value })}
                  placeholder="Class 8-B"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Direction</label>
                <select
                  value={assignForm.direction}
                  onChange={(e) => setAssignForm({ ...assignForm, direction: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                >
                  <option value="both">Pickup &amp; drop</option>
                  <option value="pickup-only">Pickup only</option>
                  <option value="drop-only">Drop only</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Boarding stop</label>
                <select
                  value={assignForm.pickupStop}
                  onChange={(e) => setAssignForm({ ...assignForm, pickupStop: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                >
                  <option value="">Select…</option>
                  {assignStops.map((stop) => (
                    <option key={stop._id || stop.sequence} value={stop.name}>
                      {stop.sequence}. {stop.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Drop stop</label>
                <select
                  value={assignForm.dropStop}
                  onChange={(e) => setAssignForm({ ...assignForm, dropStop: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                >
                  <option value="">Select…</option>
                  {assignStops.map((stop) => (
                    <option key={stop._id || stop.sequence} value={stop.name}>
                      {stop.sequence}. {stop.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <p className="text-[11px] text-gray-400">
              {assignTarget.seatsOccupied}/{assignTarget.vehicle?.capacity} seats taken. The server
              re-checks capacity before saving, so a full bus is refused even if this number is
              stale.
            </p>

            <button
              type="submit"
              disabled={saving}
              className="w-full bg-green-600 hover:bg-green-700 disabled:opacity-60 text-white text-sm py-2.5 rounded-lg transition"
            >
              {saving ? 'Assigning…' : 'Assign student'}
            </button>
          </form>
        </div>
      )}

      {/* ---- Roster dialog ---- */}
      {roster && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h4 className="font-bold text-gray-800">
                  {roster.route.routeCode} · {roster.route.routeName}
                </h4>
                <p className="text-xs text-gray-500 mt-0.5">
                  {roster.totalRiders} rider(s) · driver {roster.route.driver?.name} ·{' '}
                  {roster.route.driver?.phone}
                </p>
              </div>
              <button onClick={() => setRoster(null)}>
                <X size={18} className="text-gray-400 hover:text-gray-700" />
              </button>
            </div>

            <div className="space-y-4">
              {roster.byStop.map((block) => (
                <div key={block.stop}>
                  <div className="flex items-center justify-between bg-gray-50 px-3 py-2 rounded-lg">
                    <p className="text-sm font-semibold text-gray-700">{block.stop}</p>
                    <p className="text-xs text-gray-500">
                      {block.pickupTime} · {block.riders.length} rider(s)
                    </p>
                  </div>

                  {block.riders.length === 0 ? (
                    <p className="text-xs text-gray-400 px-3 py-2">Nobody boards here yet.</p>
                  ) : (
                    <ul className="divide-y divide-gray-100">
                      {block.riders.map((rider) => (
                        <li
                          key={rider._id}
                          className="flex items-center justify-between px-3 py-2"
                        >
                          <div>
                            <p className="text-sm text-gray-800">
                              {rider.studentName || rider.student?.name}
                            </p>
                            <p className="text-[11px] text-gray-400">
                              {rider.className || '—'} · drops at {rider.dropStop}
                            </p>
                          </div>
                          <button
                            onClick={() => handleCancelAssignment(rider)}
                            className="text-[11px] text-red-600 hover:underline"
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TransportPanel;
