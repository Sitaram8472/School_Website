import { useState, useEffect, useContext, useCallback, useMemo } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';
import CoverClaimPanel from '../components/substitutions/CoverClaimPanel';

/**
 * Staff absence and substitute cover.
 *
 * Two audiences on one page. An admin opens it to fill the gaps on today's
 * board; a teacher opens it to see what they have been asked to cover. Those
 * are different enough that they get different default tabs rather than one
 * compromise view.
 *
 * The availability list is fetched fresh every time the assign panel opens and
 * is never cached across periods. A teacher who was free thirty seconds ago may
 * have just been given the period before this one, and offering them again is
 * how the double booking gets made. The server refuses it either way — this
 * just avoids showing a name that is about to be rejected.
 */

const REASON_LABELS = {
  sick: 'Sick',
  personal: 'Personal',
  'official-duty': 'Official duty',
  training: 'Training',
  emergency: 'Emergency',
  other: 'Other',
};

const COVER_STATUS_STYLES = {
  unassigned: 'bg-red-100 text-red-700',
  declined: 'bg-orange-100 text-orange-700',
  assigned: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  'not-required': 'bg-gray-200 text-gray-600',
};

const COVER_STATUS_LABELS = {
  unassigned: 'Needs cover',
  declined: 'Declined',
  assigned: 'Assigned',
  completed: 'Taught',
  'not-required': 'No cover needed',
};

const ABSENCE_STATUS_STYLES = {
  pending: 'bg-amber-100 text-amber-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-200 text-gray-600',
};

const emptyPeriod = {
  periodLabel: '',
  startTime: '',
  endTime: '',
  className: '',
  subject: '',
  room: '',
  lessonPlan: '',
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
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
};

const SubstitutionBoard = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';

  const [tab, setTab] = useState(isAdmin ? 'board' : 'my-cover');
  const [boardDate, setBoardDate] = useState(todayKey());

  const [board, setBoard] = useState({ data: [], summary: null });
  const [myCover, setMyCover] = useState([]);
  const [myAbsences, setMyAbsences] = useState([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Assignment panel state.
  const [assigning, setAssigning] = useState(null);
  const [candidates, setCandidates] = useState({ available: [], busy: [] });
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [chosenSubstitute, setChosenSubstitute] = useState('');

  // Absence form state.
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ date: todayKey(), reason: 'sick', details: '' });
  const [periods, setPeriods] = useState([{ ...emptyPeriod }]);
  const [submitting, setSubmitting] = useState(false);

  const flash = useCallback((message) => {
    setNotice(message);
    setTimeout(() => setNotice(''), 4000);
  }, []);

  const loadBoard = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await api.get('/substitutions/board', { params: { date: boardDate } });
      setBoard({ data: res.data.data || [], summary: res.data.summary || null });
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the cover board.');
    }
  }, [isAdmin, boardDate]);

  const loadMyCover = useCallback(async () => {
    try {
      const res = await api.get('/substitutions/my-cover');
      setMyCover(res.data.data || []);
    } catch (err) {
      console.error(err);
    }
  }, []);

  const loadMyAbsences = useCallback(async () => {
    try {
      const res = await api.get('/substitutions/absences/mine');
      setMyAbsences(res.data.data || []);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await Promise.all([loadBoard(), loadMyCover(), loadMyAbsences()]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadBoard, loadMyCover, loadMyAbsences]);

  const uncovered = useMemo(
    () =>
      board.data.filter(
        (row) => row.coverStatus === 'unassigned' || row.coverStatus === 'declined'
      ),
    [board.data]
  );

  const settled = useMemo(
    () =>
      board.data.filter(
        (row) => row.coverStatus !== 'unassigned' && row.coverStatus !== 'declined'
      ),
    [board.data]
  );

  // --- Absence form --------------------------------------------------------

  const updatePeriod = (index, field, value) => {
    setPeriods((current) =>
      current.map((period, i) => (i === index ? { ...period, [field]: value } : period))
    );
  };

  const addPeriod = () => {
    setPeriods((current) =>
      current.length >= 12 ? current : [...current, { ...emptyPeriod }]
    );
  };

  const removePeriod = (index) => {
    setPeriods((current) =>
      current.length === 1 ? current : current.filter((_, i) => i !== index)
    );
  };

  const submitAbsence = async (event) => {
    event.preventDefault();

    const incomplete = periods.some(
      (period) =>
        !period.periodLabel.trim() ||
        !period.startTime ||
        !period.endTime ||
        !period.className.trim() ||
        !period.subject.trim()
    );
    if (incomplete) {
      setError('Every period needs a label, a start and end time, a class and a subject.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      await api.post('/substitutions/absences', { ...form, periods });
      flash('Absence recorded. The periods are on the cover board.');
      setShowForm(false);
      setPeriods([{ ...emptyPeriod }]);
      setForm({ date: todayKey(), reason: 'sick', details: '' });
      await Promise.all([loadMyAbsences(), loadBoard()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not record that absence.');
    } finally {
      setSubmitting(false);
    }
  };

  const cancelAbsence = async (absenceId) => {
    setError('');
    try {
      await api.patch(`/substitutions/absences/${absenceId}/cancel`, {
        cancelReason: 'Able to attend after all.',
      });
      flash('Absence cancelled.');
      await Promise.all([loadMyAbsences(), loadBoard(), loadMyCover()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not cancel that absence.');
    }
  };

  // --- Assignment ----------------------------------------------------------

  const openAssign = async (row) => {
    setAssigning(row);
    setChosenSubstitute('');
    setCandidates({ available: [], busy: [] });
    setCandidatesLoading(true);
    setError('');
    try {
      const res = await api.get('/substitutions/available', {
        params: { date: boardDate, startTime: row.startTime, endTime: row.endTime },
      });
      setCandidates({ available: res.data.data || [], busy: res.data.busy || [] });
    } catch (err) {
      setError(err.response?.data?.message || 'Could not work out who is free.');
    } finally {
      setCandidatesLoading(false);
    }
  };

  const confirmAssign = async () => {
    if (!assigning || !chosenSubstitute) return;
    setError('');
    try {
      await api.patch(
        `/substitutions/absences/${assigning.absenceId}/periods/${assigning.periodId}/assign`,
        { substitute: chosenSubstitute }
      );
      flash('Cover assigned.');
      setAssigning(null);
      await Promise.all([loadBoard(), loadMyCover()]);
    } catch (err) {
      // A 409 here is the interesting case: somebody filled this period, or took
      // this substitute, between the panel opening and the button being pressed.
      // Reload so the board stops showing a gap that is gone.
      setError(err.response?.data?.message || 'Could not assign that cover.');
      if (err.response?.status === 409) {
        await loadBoard();
        setAssigning(null);
      }
    }
  };

  const releaseCover = async (row) => {
    setError('');
    try {
      await api.patch(
        `/substitutions/absences/${row.absenceId}/periods/${row.periodId}/release`
      );
      flash('Cover released.');
      await Promise.all([loadBoard(), loadMyCover()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not release that cover.');
      if (err.response?.status === 409) await loadBoard();
    }
  };

  const markNotRequired = async (row) => {
    const reason = window.prompt('Why does this period need no cover?');
    if (!reason) return;
    setError('');
    try {
      await api.patch(
        `/substitutions/absences/${row.absenceId}/periods/${row.periodId}/not-required`,
        { notRequiredReason: reason }
      );
      flash('Period marked as needing no cover.');
      await loadBoard();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not update that period.');
    }
  };

  // --- The substitute's actions --------------------------------------------

  const declineCover = async (row) => {
    const reason = window.prompt('Why can you not take this period?');
    if (!reason) return;
    setError('');
    try {
      await api.patch(
        `/substitutions/absences/${row.absenceId}/periods/${row.periodId}/decline`,
        { declineReason: reason }
      );
      flash('Declined. The period is back on the board.');
      await Promise.all([loadMyCover(), loadBoard()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not decline that period.');
    }
  };

  const completeCover = async (row) => {
    setError('');
    try {
      await api.patch(
        `/substitutions/absences/${row.absenceId}/periods/${row.periodId}/complete`
      );
      flash('Marked as taught.');
      await Promise.all([loadMyCover(), loadBoard()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not update that period.');
    }
  };

  // --- Render --------------------------------------------------------------

  const tabs = [
    ...(isAdmin ? [{ id: 'board', label: 'Cover board' }] : []),
    { id: 'my-cover', label: 'My cover' },
    { id: 'my-absences', label: 'My absences' },
  ];

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-gray-500">
        Loading the cover board...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="bg-gradient-to-r from-slate-700 to-slate-900 rounded-2xl p-6 mb-6 text-white">
          <h1 className="text-2xl font-bold">Substitute cover</h1>
          <p className="text-slate-200 mt-1 text-sm">
            Who is away, which classes that leaves, and who is standing in front of them.
          </p>
          {isAdmin && board.summary && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5">
              {[
                { label: 'Staff absent', value: board.summary.absentStaff },
                { label: 'Periods', value: board.summary.periods },
                { label: 'Covered', value: board.summary.covered },
                { label: 'Still uncovered', value: board.summary.uncovered },
              ].map((stat) => (
                <div key={stat.label} className="bg-white/15 rounded-xl p-4 text-center">
                  <div className="text-2xl font-bold">{stat.value}</div>
                  <div className="text-xs text-slate-200 mt-1">{stat.label}</div>
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

        {/* Payment for cover sits on the page where the cover itself is, because
            a teacher looking at what they covered is the person who wants it. */}
        <CoverClaimPanel />

        <div className="flex flex-wrap gap-2 mb-6 bg-white rounded-xl p-1 shadow">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setTab(entry.id)}
              className={`flex-1 min-w-[120px] py-2 px-4 rounded-lg text-sm font-medium transition ${
                tab === entry.id
                  ? 'bg-slate-800 text-white shadow'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {/* ---------------------------------------------------------------- */}
        {tab === 'board' && isAdmin && (
          <div className="space-y-6">
            <div className="bg-white rounded-xl shadow p-4 flex flex-wrap items-end gap-4">
              <label className="text-sm">
                <span className="block text-gray-500 mb-1">Date</span>
                <input
                  type="date"
                  value={boardDate}
                  onChange={(event) => setBoardDate(event.target.value)}
                  className="border rounded-lg px-3 py-2"
                />
              </label>
              <button
                onClick={loadBoard}
                className="bg-slate-800 text-white text-sm px-4 py-2 rounded-lg hover:bg-slate-700"
              >
                Refresh
              </button>
            </div>

            <section>
              <h2 className="text-lg font-semibold text-red-700 mb-3">
                Needs cover ({uncovered.length})
              </h2>
              {uncovered.length === 0 ? (
                <div className="bg-white rounded-xl shadow p-6 text-sm text-gray-500">
                  Nothing uncovered on {formatDate(boardDate)}.
                </div>
              ) : (
                <div className="space-y-3">
                  {uncovered.map((row) => (
                    <div
                      key={row.periodId}
                      className="bg-white rounded-xl shadow p-4 border-l-4 border-red-500"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold">
                              {row.startTime}–{row.endTime}
                            </span>
                            <span className="text-sm text-gray-600">{row.periodLabel}</span>
                            <span
                              className={`text-xs px-2 py-0.5 rounded-full ${
                                COVER_STATUS_STYLES[row.coverStatus]
                              }`}
                            >
                              {COVER_STATUS_LABELS[row.coverStatus]}
                            </span>
                            {row.lateNotice && (
                              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                                Late notice
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-gray-700 mt-1">
                            {row.className} · {row.subject}
                            {row.room ? ` · ${row.room}` : ''}
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            Covering for {row.staffName} ({REASON_LABELS[row.reason]})
                          </div>
                          {row.declineReason && (
                            <div className="text-xs text-orange-700 mt-1">
                              Declined: {row.declineReason}
                            </div>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => openAssign(row)}
                            className="text-sm bg-slate-800 text-white px-3 py-1.5 rounded-lg hover:bg-slate-700"
                          >
                            Assign
                          </button>
                          <button
                            onClick={() => markNotRequired(row)}
                            className="text-sm border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50"
                          >
                            No cover needed
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h2 className="text-lg font-semibold text-gray-700 mb-3">
                Settled ({settled.length})
              </h2>
              {settled.length === 0 ? (
                <div className="bg-white rounded-xl shadow p-6 text-sm text-gray-500">
                  Nothing assigned yet.
                </div>
              ) : (
                <div className="bg-white rounded-xl shadow overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-left text-gray-600">
                      <tr>
                        <th className="px-4 py-3">Time</th>
                        <th className="px-4 py-3">Class</th>
                        <th className="px-4 py-3">Absent</th>
                        <th className="px-4 py-3">Covered by</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3" />
                      </tr>
                    </thead>
                    <tbody>
                      {settled.map((row) => (
                        <tr key={row.periodId} className="border-t">
                          <td className="px-4 py-3 whitespace-nowrap">
                            {row.startTime}–{row.endTime}
                          </td>
                          <td className="px-4 py-3">
                            {row.className}
                            <span className="text-gray-500"> · {row.subject}</span>
                          </td>
                          <td className="px-4 py-3">{row.staffName}</td>
                          <td className="px-4 py-3">
                            {row.substituteName || (
                              <span className="text-gray-500">
                                {row.notRequiredReason || '—'}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`text-xs px-2 py-0.5 rounded-full ${
                                COVER_STATUS_STYLES[row.coverStatus]
                              }`}
                            >
                              {COVER_STATUS_LABELS[row.coverStatus]}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            {row.coverStatus === 'assigned' && (
                              <button
                                onClick={() => releaseCover(row)}
                                className="text-xs text-red-600 hover:underline"
                              >
                                Release
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {tab === 'my-cover' && (
          <div className="space-y-3">
            {myCover.length === 0 ? (
              <div className="bg-white rounded-xl shadow p-6 text-sm text-gray-500">
                You have not been asked to cover anything.
              </div>
            ) : (
              myCover.map((row) => (
                <div key={row.periodId} className="bg-white rounded-xl shadow p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold">{formatDate(row.date)}</span>
                        <span>
                          {row.startTime}–{row.endTime}
                        </span>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            COVER_STATUS_STYLES[row.coverStatus]
                          }`}
                        >
                          {COVER_STATUS_LABELS[row.coverStatus]}
                        </span>
                      </div>
                      <div className="text-sm text-gray-700 mt-1">
                        {row.className} · {row.subject}
                        {row.room ? ` · ${row.room}` : ''}
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        Standing in for {row.absentTeacher}
                      </div>
                      {row.lessonPlan && (
                        <div className="mt-3 bg-gray-50 rounded-lg p-3 text-sm text-gray-700 whitespace-pre-wrap">
                          {row.lessonPlan}
                        </div>
                      )}
                    </div>
                    {row.coverStatus === 'assigned' && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => completeCover(row)}
                          className="text-sm bg-green-600 text-white px-3 py-1.5 rounded-lg hover:bg-green-500"
                        >
                          Taught it
                        </button>
                        <button
                          onClick={() => declineCover(row)}
                          className="text-sm border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50"
                        >
                          Decline
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {tab === 'my-absences' && (
          <div className="space-y-4">
            <button
              onClick={() => setShowForm((current) => !current)}
              className="bg-slate-800 text-white text-sm px-4 py-2 rounded-lg hover:bg-slate-700"
            >
              {showForm ? 'Close' : 'Report an absence'}
            </button>

            {showForm && (
              <form onSubmit={submitAbsence} className="bg-white rounded-xl shadow p-5 space-y-4">
                <div className="grid sm:grid-cols-3 gap-4">
                  <label className="text-sm">
                    <span className="block text-gray-500 mb-1">Date</span>
                    <input
                      type="date"
                      required
                      value={form.date}
                      onChange={(event) => setForm({ ...form, date: event.target.value })}
                      className="w-full border rounded-lg px-3 py-2"
                    />
                  </label>
                  <label className="text-sm">
                    <span className="block text-gray-500 mb-1">Reason</span>
                    <select
                      value={form.reason}
                      onChange={(event) => setForm({ ...form, reason: event.target.value })}
                      className="w-full border rounded-lg px-3 py-2"
                    >
                      {Object.entries(REASON_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm sm:col-span-1">
                    <span className="block text-gray-500 mb-1">Details (optional)</span>
                    <input
                      type="text"
                      value={form.details}
                      onChange={(event) => setForm({ ...form, details: event.target.value })}
                      className="w-full border rounded-lg px-3 py-2"
                    />
                  </label>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-gray-700">
                      Periods that need covering
                    </h3>
                    <button
                      type="button"
                      onClick={addPeriod}
                      className="text-xs text-slate-700 hover:underline"
                    >
                      + Add period
                    </button>
                  </div>

                  <div className="space-y-3">
                    {periods.map((period, index) => (
                      <div key={index} className="border rounded-lg p-3 space-y-3">
                        <div className="grid sm:grid-cols-5 gap-3">
                          <input
                            type="text"
                            placeholder="Period 3"
                            value={period.periodLabel}
                            onChange={(event) =>
                              updatePeriod(index, 'periodLabel', event.target.value)
                            }
                            className="border rounded-lg px-3 py-2 text-sm"
                          />
                          <input
                            type="time"
                            value={period.startTime}
                            onChange={(event) =>
                              updatePeriod(index, 'startTime', event.target.value)
                            }
                            className="border rounded-lg px-3 py-2 text-sm"
                          />
                          <input
                            type="time"
                            value={period.endTime}
                            onChange={(event) =>
                              updatePeriod(index, 'endTime', event.target.value)
                            }
                            className="border rounded-lg px-3 py-2 text-sm"
                          />
                          <input
                            type="text"
                            placeholder="Class 8B"
                            value={period.className}
                            onChange={(event) =>
                              updatePeriod(index, 'className', event.target.value)
                            }
                            className="border rounded-lg px-3 py-2 text-sm"
                          />
                          <input
                            type="text"
                            placeholder="Physics"
                            value={period.subject}
                            onChange={(event) =>
                              updatePeriod(index, 'subject', event.target.value)
                            }
                            className="border rounded-lg px-3 py-2 text-sm"
                          />
                        </div>
                        <div className="grid sm:grid-cols-4 gap-3">
                          <input
                            type="text"
                            placeholder="Room (optional)"
                            value={period.room}
                            onChange={(event) => updatePeriod(index, 'room', event.target.value)}
                            className="border rounded-lg px-3 py-2 text-sm"
                          />
                          <input
                            type="text"
                            placeholder="What should the class do?"
                            value={period.lessonPlan}
                            onChange={(event) =>
                              updatePeriod(index, 'lessonPlan', event.target.value)
                            }
                            className="border rounded-lg px-3 py-2 text-sm sm:col-span-2"
                          />
                          {periods.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removePeriod(index)}
                              className="text-xs text-red-600 hover:underline"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="bg-slate-800 text-white text-sm px-4 py-2 rounded-lg hover:bg-slate-700 disabled:opacity-50"
                >
                  {submitting ? 'Recording...' : 'Record absence'}
                </button>
              </form>
            )}

            {myAbsences.length === 0 ? (
              <div className="bg-white rounded-xl shadow p-6 text-sm text-gray-500">
                You have not reported any absences.
              </div>
            ) : (
              myAbsences.map((absence) => (
                <div key={absence._id} className="bg-white rounded-xl shadow p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold">{formatDate(absence.date)}</span>
                        <span className="text-sm text-gray-600">
                          {REASON_LABELS[absence.reason]}
                        </span>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            ABSENCE_STATUS_STYLES[absence.status]
                          }`}
                        >
                          {absence.status}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        {absence.coveredCount} of {absence.periodCount} periods covered
                        {absence.uncoveredCount > 0 && (
                          <span className="text-red-600">
                            {' '}
                            · {absence.uncoveredCount} still open
                          </span>
                        )}
                      </div>
                      <div className="mt-2 space-y-1">
                        {(absence.periods || []).map((period) => (
                          <div key={period._id} className="text-sm text-gray-700">
                            <span className="text-gray-500">
                              {period.startTime}–{period.endTime}
                            </span>{' '}
                            {period.className} · {period.subject} —{' '}
                            <span className="text-gray-600">
                              {period.substituteName || COVER_STATUS_LABELS[period.coverStatus]}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                    {absence.status !== 'cancelled' && !absence.isPast && (
                      <button
                        onClick={() => cancelAbsence(absence._id)}
                        className="text-sm border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* Assign panel ---------------------------------------------------- */}
        {assigning && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-6">
              <h3 className="text-lg font-semibold">
                Cover {assigning.periodLabel} · {assigning.className}
              </h3>
              <p className="text-sm text-gray-500 mt-1">
                {formatDate(boardDate)} · {assigning.startTime}–{assigning.endTime} ·{' '}
                {assigning.subject}
              </p>

              {candidatesLoading ? (
                <p className="text-sm text-gray-500 mt-6">Working out who is free...</p>
              ) : (
                <>
                  <div className="mt-5 space-y-2">
                    {candidates.available.length === 0 && (
                      <p className="text-sm text-red-600">
                        Nobody is free in that window. Release another period first.
                      </p>
                    )}
                    {candidates.available.map((person) => (
                      <label
                        key={person._id}
                        className={`flex items-center justify-between border rounded-lg px-3 py-2 cursor-pointer ${
                          chosenSubstitute === person._id
                            ? 'border-slate-800 bg-slate-50'
                            : 'border-gray-200'
                        }`}
                      >
                        <span className="flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name="substitute"
                            value={person._id}
                            checked={chosenSubstitute === person._id}
                            onChange={() => setChosenSubstitute(person._id)}
                          />
                          {person.name}
                        </span>
                        <span className="text-xs text-gray-500">
                          {person.coverPeriodsToday} cover today
                        </span>
                      </label>
                    ))}
                  </div>

                  {candidates.busy.length > 0 && (
                    <details className="mt-4">
                      <summary className="text-xs text-gray-500 cursor-pointer">
                        {candidates.busy.length} unavailable
                      </summary>
                      <ul className="mt-2 space-y-1">
                        {candidates.busy.map((person) => (
                          <li key={person._id} className="text-xs text-gray-500">
                            {person.name} — {person.reason}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              )}

              <div className="flex justify-end gap-2 mt-6">
                <button
                  onClick={() => setAssigning(null)}
                  className="text-sm border border-gray-300 px-4 py-2 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmAssign}
                  disabled={!chosenSubstitute}
                  className="text-sm bg-slate-800 text-white px-4 py-2 rounded-lg hover:bg-slate-700 disabled:opacity-50"
                >
                  Assign
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SubstitutionBoard;
