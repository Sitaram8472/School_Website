import { useState, useEffect, useContext, useCallback } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * Emergency drills and safety incidents.
 *
 * Two very different jobs on one page.
 *
 * A class teacher standing on a field at 09:12 gets one thing: the roll call
 * form for their class, submittable in about four taps. Nothing else on that
 * view is usable in the rain, so nothing else is on it.
 *
 * The coordinator gets the live board — classes still to report, names still
 * missing, and a clock running from the alarm. The close button is disabled
 * whenever the server says somebody is unaccounted for, and the reason is
 * printed underneath it rather than hidden in an error toast, because the point
 * is not to stop the click but to show what has to happen first.
 */

const EVENT_TYPE_LABELS = {
  'fire-drill': 'Fire drill',
  'earthquake-drill': 'Earthquake drill',
  'lockdown-drill': 'Lockdown drill',
  'evacuation-drill': 'Evacuation drill',
  'real-incident': 'Real incident',
};

const INCIDENT_CATEGORIES = [
  'fire',
  'gas-leak',
  'chemical-spill',
  'structural',
  'medical-emergency',
  'intrusion',
  'weather',
  'other',
];

const STATUS_STYLES = {
  planned: 'bg-gray-200 text-gray-600',
  'in-progress': 'bg-red-100 text-red-700',
  reconciled: 'bg-amber-100 text-amber-700',
  closed: 'bg-green-100 text-green-700',
  cancelled: 'bg-gray-200 text-gray-600',
};

const SEVERITIES = ['info', 'minor', 'major', 'critical'];

const emptyEventForm = {
  eventType: 'fire-drill',
  incidentCategory: 'fire',
  title: '',
  date: '',
  assemblyPoints: '',
};

const emptyRollCall = {
  className: '',
  assemblyPoint: '',
  expectedCount: '',
  presentCount: '',
  absentPreAuthorised: 0,
  unaccounted: '',
  notes: '',
};

const todayKey = () => {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
};

const formatDate = (value) => {
  if (!value) return '';
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
};

const formatDuration = (seconds) => {
  if (seconds === null || seconds === undefined) return '—';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
};

const SafetyDrills = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';

  const [tab, setTab] = useState('live');
  const [events, setEvents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [board, setBoard] = useState(null);
  const [stats, setStats] = useState(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [showEventForm, setShowEventForm] = useState(false);
  const [eventForm, setEventForm] = useState({ ...emptyEventForm, date: todayKey() });

  const [rollCall, setRollCall] = useState(emptyRollCall);
  const [submitting, setSubmitting] = useState(false);

  const [observation, setObservation] = useState({ severity: 'minor', area: '', note: '' });
  const [action, setAction] = useState({ description: '', ownerName: '', dueDate: '' });

  const flash = useCallback((message) => {
    setNotice(message);
    setTimeout(() => setNotice(''), 4000);
  }, []);

  const loadEvents = useCallback(async () => {
    try {
      const res = await api.get('/safety/events');
      setEvents(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load safety events.');
    }
  }, []);

  const loadStats = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await api.get('/safety/stats');
      setStats(res.data.stats);
    } catch (err) {
      console.error(err);
    }
  }, [isAdmin]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await Promise.all([loadEvents(), loadStats()]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadEvents, loadStats]);

  const openEvent = useCallback(
    async (event) => {
      setError('');
      try {
        const res = await api.get(`/safety/events/${event._id}`);
        setSelected(res.data.data);
        setRollCall({ ...emptyRollCall });

        // The board is coordinator-only; a class teacher opening an event gets
        // the roll call form and nothing else, which is the correct amount of
        // screen for them.
        try {
          const boardRes = await api.get(`/safety/events/${event._id}/board`);
          setBoard(boardRes.data);
        } catch {
          setBoard(null);
        }
      } catch (err) {
        setError(err.response?.data?.message || 'Could not open that event.');
      }
    },
    []
  );

  const refreshSelected = useCallback(async () => {
    if (!selected) return;
    await openEvent({ _id: selected._id });
    await loadEvents();
  }, [selected, openEvent, loadEvents]);

  // --- Events --------------------------------------------------------------

  const createEvent = async (submitEvent) => {
    submitEvent.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const payload = {
        ...eventForm,
        assemblyPoints: eventForm.assemblyPoints
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
      };
      if (payload.eventType !== 'real-incident') delete payload.incidentCategory;

      const res = await api.post('/safety/events', payload);
      flash(res.data.message);
      setShowEventForm(false);
      setEventForm({ ...emptyEventForm, date: todayKey() });
      await loadEvents();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not open that event.');
    } finally {
      setSubmitting(false);
    }
  };

  const startEvent = async (event) => {
    setError('');
    try {
      await api.patch(`/safety/events/${event._id}/start`);
      flash('Alarm raised. The clock is running.');
      await loadEvents();
      await openEvent(event);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not start that event.');
    }
  };

  const submitRollCall = async (submitEvent) => {
    submitEvent.preventDefault();
    if (!selected) return;

    setSubmitting(true);
    setError('');
    try {
      const names = rollCall.unaccounted
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((studentName) => ({ studentName }));

      const res = await api.post(`/safety/events/${selected._id}/roll-calls`, {
        ...rollCall,
        expectedCount: Number(rollCall.expectedCount),
        presentCount: Number(rollCall.presentCount),
        absentPreAuthorised: Number(rollCall.absentPreAuthorised) || 0,
        unaccounted: names,
      });
      flash(res.data.message);
      setRollCall({ ...emptyRollCall });
      await refreshSelected();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not record that roll call.');
    } finally {
      setSubmitting(false);
    }
  };

  const resolveEntry = async (row) => {
    const note = window.prompt(
      `What happened to ${row.studentName}? This note is the record.`
    );
    if (!note) return;
    setError('');
    try {
      const res = await api.patch(
        `/safety/events/${selected._id}/roll-calls/${row.rollCallId}/unaccounted/${row.entryId}/resolve`,
        { resolutionNote: note }
      );
      flash(res.data.message);
      await refreshSelected();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not record that resolution.');
    }
  };

  const soundAllClear = async () => {
    setError('');
    try {
      const res = await api.patch(`/safety/events/${selected._id}/all-clear`);
      flash(res.data.message);
      await refreshSelected();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not sound the all-clear.');
    }
  };

  const closeEvent = async () => {
    const closureNote = window.prompt('Closure note — what happened, and what came out of it?');
    if (!closureNote) return;
    setError('');
    try {
      const res = await api.patch(`/safety/events/${selected._id}/close`, { closureNote });
      flash(res.data.message);
      await refreshSelected();
      await loadStats();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not close that event.');
    }
  };

  const addObservation = async (submitEvent) => {
    submitEvent.preventDefault();
    setError('');
    try {
      await api.post(`/safety/events/${selected._id}/observations`, observation);
      setObservation({ severity: 'minor', area: '', note: '' });
      flash('Observation recorded.');
      await refreshSelected();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not record that observation.');
    }
  };

  const addAction = async (submitEvent) => {
    submitEvent.preventDefault();
    setError('');
    try {
      await api.post(`/safety/events/${selected._id}/actions`, action);
      setAction({ description: '', ownerName: '', dueDate: '' });
      flash('Action added.');
      await refreshSelected();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not add that action.');
    }
  };

  const completeAction = async (entry) => {
    const completionNote = window.prompt('What was done?');
    if (!completionNote) return;
    setError('');
    try {
      await api.patch(`/safety/events/${selected._id}/actions/${entry._id}`, {
        status: 'completed',
        completionNote,
      });
      flash('Action closed.');
      await refreshSelected();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not update that action.');
    }
  };

  // --- Render --------------------------------------------------------------

  const live = events.filter(
    (event) => event.status === 'in-progress' || event.status === 'reconciled'
  );
  const planned = events.filter((event) => event.status === 'planned');
  const history = events.filter(
    (event) => event.status === 'closed' || event.status === 'cancelled'
  );

  const tabs = [
    { id: 'live', label: `Live (${live.length})` },
    { id: 'planned', label: `Planned (${planned.length})` },
    { id: 'history', label: 'History' },
  ];

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-gray-500">
        Loading safety records...
      </div>
    );
  }

  const list = tab === 'live' ? live : tab === 'planned' ? planned : history;

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="bg-gradient-to-r from-red-600 to-rose-700 rounded-2xl p-6 mb-6 text-white">
          <h1 className="text-2xl font-bold">Drills and safety incidents</h1>
          <p className="text-red-100 mt-1 text-sm">
            A drill is not over because the bell stopped. It is over when everybody has been
            accounted for.
          </p>
          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5">
              {[
                { label: 'Events this year', value: stats.events },
                {
                  label: 'Median evacuation',
                  value: formatDuration(stats.medianEvacuationSeconds),
                },
                { label: 'Open actions', value: stats.openActions },
                { label: 'Overdue actions', value: stats.overdueActions },
              ].map((stat) => (
                <div key={stat.label} className="bg-white/15 rounded-xl p-4 text-center">
                  <div className="text-xl font-bold">{stat.value}</div>
                  <div className="text-xs text-red-100 mt-1">{stat.label}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {notice && (
          <div className="mb-4 rounded-lg bg-green-100 text-green-800 px-4 py-3 text-sm">
            {notice}
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-lg bg-red-100 text-red-800 px-4 py-3 text-sm">
            {error}
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-6 bg-white rounded-xl p-1 shadow">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setTab(entry.id)}
              className={`flex-1 min-w-[110px] py-2 px-4 rounded-lg text-sm font-medium transition ${
                tab === entry.id
                  ? 'bg-red-600 text-white shadow'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {isAdmin && (
          <div className="mb-4">
            <button
              onClick={() => setShowEventForm((current) => !current)}
              className="bg-red-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-red-500"
            >
              {showEventForm ? 'Close' : 'Schedule a drill / open an incident'}
            </button>
          </div>
        )}

        {showEventForm && isAdmin && (
          <form onSubmit={createEvent} className="bg-white rounded-xl shadow p-5 grid sm:grid-cols-2 gap-4 mb-6">
            <label className="text-sm">
              <span className="block text-gray-500 mb-1">Type</span>
              <select
                value={eventForm.eventType}
                onChange={(event) =>
                  setEventForm({ ...eventForm, eventType: event.target.value })
                }
                className="w-full border rounded-lg px-3 py-2"
              >
                {Object.entries(EVENT_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            {eventForm.eventType === 'real-incident' && (
              <label className="text-sm">
                <span className="block text-gray-500 mb-1">Category</span>
                <select
                  value={eventForm.incidentCategory}
                  onChange={(event) =>
                    setEventForm({ ...eventForm, incidentCategory: event.target.value })
                  }
                  className="w-full border rounded-lg px-3 py-2"
                >
                  {INCIDENT_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="text-sm">
              <span className="block text-gray-500 mb-1">Title</span>
              <input
                type="text"
                required
                value={eventForm.title}
                onChange={(event) => setEventForm({ ...eventForm, title: event.target.value })}
                className="w-full border rounded-lg px-3 py-2"
              />
            </label>

            <label className="text-sm">
              <span className="block text-gray-500 mb-1">Date</span>
              <input
                type="date"
                required
                value={eventForm.date}
                onChange={(event) => setEventForm({ ...eventForm, date: event.target.value })}
                className="w-full border rounded-lg px-3 py-2"
              />
            </label>

            <label className="text-sm sm:col-span-2">
              <span className="block text-gray-500 mb-1">
                Assembly points (comma separated)
              </span>
              <input
                type="text"
                value={eventForm.assemblyPoints}
                onChange={(event) =>
                  setEventForm({ ...eventForm, assemblyPoints: event.target.value })
                }
                className="w-full border rounded-lg px-3 py-2"
              />
            </label>

            <div className="sm:col-span-2">
              <button
                type="submit"
                disabled={submitting}
                className="bg-red-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-red-500 disabled:opacity-50"
              >
                {submitting ? 'Opening...' : 'Open'}
              </button>
            </div>
          </form>
        )}

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Event list --------------------------------------------------- */}
          <div className="space-y-3">
            {list.length === 0 ? (
              <div className="bg-white rounded-xl shadow p-6 text-sm text-gray-500">
                Nothing here.
              </div>
            ) : (
              list.map((event) => (
                <button
                  key={event._id}
                  onClick={() => openEvent(event)}
                  className={`w-full text-left bg-white rounded-xl shadow p-4 hover:shadow-md transition ${
                    selected?._id === event._id ? 'ring-2 ring-red-500' : ''
                  }`}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold">{event.title}</span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        STATUS_STYLES[event.status]
                      }`}
                    >
                      {event.status}
                    </span>
                  </div>
                  <div className="text-sm text-gray-600 mt-1">
                    {EVENT_TYPE_LABELS[event.eventType]} · {formatDate(event.date)}
                  </div>
                  {event.outstandingCount > 0 && (
                    <div className="text-sm font-medium text-red-700 mt-1">
                      {event.outstandingCount} unaccounted for
                    </div>
                  )}
                  {event.status === 'planned' && isAdmin && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(clickEvent) => {
                        clickEvent.stopPropagation();
                        startEvent(event);
                      }}
                      onKeyDown={(keyEvent) => {
                        if (keyEvent.key === 'Enter') {
                          keyEvent.stopPropagation();
                          startEvent(event);
                        }
                      }}
                      className="inline-block mt-2 text-xs bg-red-600 text-white px-3 py-1.5 rounded-lg hover:bg-red-500"
                    >
                      Raise the alarm
                    </span>
                  )}
                </button>
              ))
            )}
          </div>

          {/* Detail ------------------------------------------------------- */}
          <div className="lg:col-span-2 space-y-4">
            {!selected ? (
              <div className="bg-white rounded-xl shadow p-6 text-sm text-gray-500">
                Pick an event to see its roll calls.
              </div>
            ) : (
              <>
                {/* Board */}
                {board && (
                  <div className="bg-white rounded-xl shadow p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h2 className="text-lg font-semibold">{board.event.title}</h2>
                        <p className="text-sm text-gray-500">
                          {EVENT_TYPE_LABELS[board.event.eventType]} ·{' '}
                          {board.event.alarmRaisedAt
                            ? `alarm at ${new Date(board.event.alarmRaisedAt).toLocaleTimeString()}`
                            : 'not started'}
                        </p>
                      </div>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          STATUS_STYLES[board.event.status]
                        }`}
                      >
                        {board.event.status}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
                      {[
                        { label: 'Classes in', value: board.summary.classesReported },
                        {
                          label: 'Still to report',
                          value: board.summary.classListProvided
                            ? board.summary.awaitingReport
                            : '—',
                        },
                        {
                          label: 'Evacuation',
                          value: formatDuration(board.event.evacuationSeconds),
                        },
                        { label: 'Unaccounted', value: board.summary.outstanding },
                      ].map((stat) => (
                        <div
                          key={stat.label}
                          className={`rounded-lg p-3 text-center ${
                            stat.label === 'Unaccounted' && board.summary.outstanding > 0
                              ? 'bg-red-100'
                              : 'bg-gray-50'
                          }`}
                        >
                          <div className="text-xl font-bold">{stat.value}</div>
                          <div className="text-xs text-gray-500">{stat.label}</div>
                        </div>
                      ))}
                    </div>

                    {board.unaccounted.length > 0 && (
                      <div className="mt-5">
                        <h3 className="text-sm font-semibold text-red-700 mb-2">
                          Unaccounted for
                        </h3>
                        <div className="space-y-2">
                          {board.unaccounted.map((row) => (
                            <div
                              key={row.entryId}
                              className="flex items-center justify-between border border-red-200 bg-red-50 rounded-lg px-3 py-2"
                            >
                              <div>
                                <div className="font-medium">{row.studentName}</div>
                                <div className="text-xs text-gray-600">
                                  {row.className}
                                  {row.assemblyPoint ? ` · ${row.assemblyPoint}` : ''}
                                  {row.note ? ` · ${row.note}` : ''}
                                </div>
                              </div>
                              <button
                                onClick={() => resolveEntry(row)}
                                className="text-xs bg-red-600 text-white px-3 py-1.5 rounded-lg hover:bg-red-500"
                              >
                                Account for
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="mt-5 flex flex-wrap gap-2 items-center">
                      <button
                        onClick={soundAllClear}
                        disabled={Boolean(board.closureBlockedBecause) || !!board.event.allClearAt}
                        className="text-sm bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Sound all clear
                      </button>
                      {isAdmin && (
                        <button
                          onClick={closeEvent}
                          disabled={Boolean(board.closureBlockedBecause)}
                          className="text-sm border border-gray-300 px-4 py-2 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Close event
                        </button>
                      )}
                    </div>
                    {board.closureBlockedBecause && (
                      <p className="text-xs text-red-700 mt-2">
                        {board.closureBlockedBecause}
                      </p>
                    )}

                    {board.rollCalls.length > 0 && (
                      <div className="mt-5 overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50 text-left text-gray-600">
                            <tr>
                              <th className="px-3 py-2">Class</th>
                              <th className="px-3 py-2">Expected</th>
                              <th className="px-3 py-2">Present</th>
                              <th className="px-3 py-2">Authorised</th>
                              <th className="px-3 py-2">Missing</th>
                              <th className="px-3 py-2">Reported by</th>
                            </tr>
                          </thead>
                          <tbody>
                            {board.rollCalls.map((row) => (
                              <tr key={row.rollCallId} className="border-t">
                                <td className="px-3 py-2">{row.className}</td>
                                <td className="px-3 py-2">{row.expectedCount}</td>
                                <td className="px-3 py-2">{row.presentCount}</td>
                                <td className="px-3 py-2">{row.absentPreAuthorised}</td>
                                <td
                                  className={`px-3 py-2 font-medium ${
                                    row.outstanding > 0 ? 'text-red-700' : 'text-gray-500'
                                  }`}
                                >
                                  {row.outstanding}
                                </td>
                                <td className="px-3 py-2 text-gray-500">
                                  {row.reporterName}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {/* Roll call form */}
                {(selected.status === 'in-progress' || selected.status === 'reconciled') && (
                  <form onSubmit={submitRollCall} className="bg-white rounded-xl shadow p-5 space-y-4">
                    <h3 className="font-semibold">Report my class</h3>
                    <div className="grid sm:grid-cols-2 gap-4">
                      <label className="text-sm">
                        <span className="block text-gray-500 mb-1">Class</span>
                        <input
                          type="text"
                          required
                          value={rollCall.className}
                          onChange={(event) =>
                            setRollCall({ ...rollCall, className: event.target.value })
                          }
                          className="w-full border rounded-lg px-3 py-2"
                        />
                      </label>
                      <label className="text-sm">
                        <span className="block text-gray-500 mb-1">Assembly point</span>
                        <input
                          type="text"
                          value={rollCall.assemblyPoint}
                          onChange={(event) =>
                            setRollCall({ ...rollCall, assemblyPoint: event.target.value })
                          }
                          className="w-full border rounded-lg px-3 py-2"
                        />
                      </label>
                      <label className="text-sm">
                        <span className="block text-gray-500 mb-1">On the register</span>
                        <input
                          type="number"
                          min="0"
                          required
                          value={rollCall.expectedCount}
                          onChange={(event) =>
                            setRollCall({ ...rollCall, expectedCount: event.target.value })
                          }
                          className="w-full border rounded-lg px-3 py-2"
                        />
                      </label>
                      <label className="text-sm">
                        <span className="block text-gray-500 mb-1">Standing here</span>
                        <input
                          type="number"
                          min="0"
                          required
                          value={rollCall.presentCount}
                          onChange={(event) =>
                            setRollCall({ ...rollCall, presentCount: event.target.value })
                          }
                          className="w-full border rounded-lg px-3 py-2"
                        />
                      </label>
                      <label className="text-sm">
                        <span className="block text-gray-500 mb-1">
                          Known absent today
                        </span>
                        <input
                          type="number"
                          min="0"
                          value={rollCall.absentPreAuthorised}
                          onChange={(event) =>
                            setRollCall({
                              ...rollCall,
                              absentPreAuthorised: event.target.value,
                            })
                          }
                          className="w-full border rounded-lg px-3 py-2"
                        />
                      </label>
                      <label className="text-sm">
                        <span className="block text-gray-500 mb-1">
                          Names not here (comma separated)
                        </span>
                        <input
                          type="text"
                          value={rollCall.unaccounted}
                          onChange={(event) =>
                            setRollCall({ ...rollCall, unaccounted: event.target.value })
                          }
                          className="w-full border rounded-lg px-3 py-2"
                        />
                      </label>
                    </div>
                    <p className="text-xs text-gray-500">
                      The names have to match the arithmetic: register minus present minus
                      known absent. The server will say so if they do not.
                    </p>
                    <button
                      type="submit"
                      disabled={submitting}
                      className="bg-red-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-red-500 disabled:opacity-50"
                    >
                      {submitting ? 'Sending...' : 'Send roll call'}
                    </button>
                  </form>
                )}

                {/* Observations and actions */}
                {selected.status !== 'planned' && (
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="bg-white rounded-xl shadow p-5">
                      <h3 className="font-semibold mb-3">Observations</h3>
                      <div className="space-y-2 mb-4">
                        {(selected.observations || []).length === 0 && (
                          <p className="text-sm text-gray-500">Nothing recorded.</p>
                        )}
                        {(selected.observations || []).map((entry) => (
                          <div key={entry._id} className="text-sm border rounded-lg px-3 py-2">
                            <span
                              className={`text-xs px-2 py-0.5 rounded-full mr-2 ${
                                entry.severity === 'critical' || entry.severity === 'major'
                                  ? 'bg-red-100 text-red-700'
                                  : 'bg-gray-100 text-gray-600'
                              }`}
                            >
                              {entry.severity}
                            </span>
                            {entry.note}
                            {entry.area && (
                              <span className="text-gray-500"> — {entry.area}</span>
                            )}
                          </div>
                        ))}
                      </div>
                      <form onSubmit={addObservation} className="space-y-2">
                        <select
                          value={observation.severity}
                          onChange={(event) =>
                            setObservation({ ...observation, severity: event.target.value })
                          }
                          className="w-full border rounded-lg px-3 py-2 text-sm"
                        >
                          {SEVERITIES.map((value) => (
                            <option key={value} value={value}>
                              {value}
                            </option>
                          ))}
                        </select>
                        <input
                          type="text"
                          placeholder="Area"
                          value={observation.area}
                          onChange={(event) =>
                            setObservation({ ...observation, area: event.target.value })
                          }
                          className="w-full border rounded-lg px-3 py-2 text-sm"
                        />
                        <input
                          type="text"
                          required
                          placeholder="What did you see?"
                          value={observation.note}
                          onChange={(event) =>
                            setObservation({ ...observation, note: event.target.value })
                          }
                          className="w-full border rounded-lg px-3 py-2 text-sm"
                        />
                        <button
                          type="submit"
                          className="text-sm border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50"
                        >
                          Record
                        </button>
                      </form>
                    </div>

                    <div className="bg-white rounded-xl shadow p-5">
                      <h3 className="font-semibold mb-3">Follow-up actions</h3>
                      <div className="space-y-2 mb-4">
                        {(selected.actions || []).length === 0 && (
                          <p className="text-sm text-gray-500">Nothing raised.</p>
                        )}
                        {(selected.actions || []).map((entry) => (
                          <div
                            key={entry._id}
                            className="text-sm border rounded-lg px-3 py-2 flex items-start justify-between gap-2"
                          >
                            <div>
                              <div>{entry.description}</div>
                              <div className="text-xs text-gray-500">
                                {entry.ownerName || 'unassigned'}
                                {entry.dueDate ? ` · due ${formatDate(entry.dueDate)}` : ''} ·{' '}
                                {entry.status}
                              </div>
                            </div>
                            {(entry.status === 'open' || entry.status === 'in-progress') && (
                              <button
                                onClick={() => completeAction(entry)}
                                className="text-xs text-green-700 hover:underline whitespace-nowrap"
                              >
                                Done
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                      <form onSubmit={addAction} className="space-y-2">
                        <input
                          type="text"
                          required
                          placeholder="What needs doing?"
                          value={action.description}
                          onChange={(event) =>
                            setAction({ ...action, description: event.target.value })
                          }
                          className="w-full border rounded-lg px-3 py-2 text-sm"
                        />
                        <input
                          type="text"
                          placeholder="Owner"
                          value={action.ownerName}
                          onChange={(event) =>
                            setAction({ ...action, ownerName: event.target.value })
                          }
                          className="w-full border rounded-lg px-3 py-2 text-sm"
                        />
                        <input
                          type="date"
                          value={action.dueDate}
                          onChange={(event) =>
                            setAction({ ...action, dueDate: event.target.value })
                          }
                          className="w-full border rounded-lg px-3 py-2 text-sm"
                        />
                        <button
                          type="submit"
                          className="text-sm border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50"
                        >
                          Add action
                        </button>
                      </form>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SafetyDrills;
