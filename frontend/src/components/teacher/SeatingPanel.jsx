import { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../../utils/axios';

/**
 * Exam hall seating and invigilation.
 *
 * The grid is the point of this panel — a list of "roll 4412 -> C7" rows is
 * unreadable, and the thing you actually need to see is whether two people
 * writing the same paper ended up next to each other.
 */

const STATUS_STYLES = {
  draft: 'bg-gray-200 text-gray-600',
  allocated: 'bg-amber-100 text-amber-700',
  published: 'bg-green-100 text-green-700',
  locked: 'bg-blue-100 text-blue-700',
  cancelled: 'bg-red-100 text-red-700',
};

// Enough for a realistic subject mix; anything beyond falls back to grey.
const SUBJECT_COLOURS = [
  'bg-sky-100 text-sky-800 border-sky-300',
  'bg-rose-100 text-rose-800 border-rose-300',
  'bg-emerald-100 text-emerald-800 border-emerald-300',
  'bg-violet-100 text-violet-800 border-violet-300',
  'bg-amber-100 text-amber-800 border-amber-300',
  'bg-cyan-100 text-cyan-800 border-cyan-300',
  'bg-lime-100 text-lime-800 border-lime-300',
  'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-300',
];

const seatLabel = (row, column) => `${String.fromCharCode(65 + row)}${column + 1}`;

const defaultPlanForm = {
  examTitle: '',
  examDate: '',
  startTime: '09:00',
  endTime: '12:00',
  hallName: '',
  rows: 5,
  columns: 6,
  blockedSeats: '',
  notes: '',
};

const defaultCandidateForm = {
  studentName: '',
  rollNumber: '',
  subjectCode: '',
  className: '',
};

const SeatingPanel = () => {
  const [plans, setPlans] = useState([]);
  const [stats, setStats] = useState(null);
  const [selected, setSelected] = useState(null);
  const [planForm, setPlanForm] = useState(defaultPlanForm);
  const [candidateForm, setCandidateForm] = useState(defaultCandidateForm);
  const [bulkText, setBulkText] = useState('');
  const [invigilatorForm, setInvigilatorForm] = useState({
    teacher: '',
    teacherName: '',
    role: 'assistant',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 4000);
  };

  const loadPlans = useCallback(async () => {
    try {
      const res = await api.get('/seating/plans');
      setPlans(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load seating plans.');
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const res = await api.get('/seating/stats');
      setStats(res.data.stats);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    loadPlans();
    loadStats();
  }, [loadPlans, loadStats]);

  const refreshSelected = async (planId) => {
    const res = await api.get(`/seating/plans/${planId}`);
    setSelected(res.data.data);
    await Promise.all([loadPlans(), loadStats()]);
  };

  const run = async (work, successMessage) => {
    setBusy(true);
    setError('');
    try {
      const result = await work();
      if (successMessage) flash(successMessage);
      return result;
    } catch (err) {
      setError(err.response?.data?.message || 'That did not work.');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const createPlan = (event) => {
    event.preventDefault();
    return run(async () => {
      const res = await api.post('/seating/plans', {
        examTitle: planForm.examTitle,
        examDate: planForm.examDate,
        startTime: planForm.startTime,
        endTime: planForm.endTime,
        notes: planForm.notes,
        hall: {
          name: planForm.hallName,
          rows: Number(planForm.rows),
          columns: Number(planForm.columns),
          blockedSeats: planForm.blockedSeats
            .split(',')
            .map((label) => label.trim().toUpperCase())
            .filter(Boolean),
        },
      });
      setPlanForm(defaultPlanForm);
      setSelected(res.data.data);
      await Promise.all([loadPlans(), loadStats()]);
      flash(res.data.message);
    });
  };

  const addCandidate = (event) => {
    event.preventDefault();
    if (!selected) return undefined;
    return run(async () => {
      await api.post(`/seating/plans/${selected._id}/candidates`, {
        candidates: [candidateForm],
      });
      setCandidateForm(defaultCandidateForm);
      await refreshSelected(selected._id);
      flash('Candidate added.');
    });
  };

  /**
   * Pasting a class list is how this actually gets used. One candidate per
   * line: name, roll, subject, class.
   */
  const addBulk = () => {
    if (!selected || !bulkText.trim()) return undefined;

    const candidates = bulkText
      .split('\n')
      .map((line) => line.split(',').map((part) => part.trim()))
      .filter((parts) => parts.length >= 3 && parts[0])
      .map(([studentName, rollNumber, subjectCode, className]) => ({
        studentName,
        rollNumber,
        subjectCode,
        className: className || '',
      }));

    if (candidates.length === 0) {
      setError('Could not read any rows. Expected: name, roll number, subject code, class');
      return undefined;
    }

    return run(async () => {
      const res = await api.post(`/seating/plans/${selected._id}/candidates`, {
        candidates,
      });
      setBulkText('');
      await refreshSelected(selected._id);
      const skipped = res.data.skipped || [];
      flash(
        skipped.length > 0
          ? `${res.data.message} ${skipped.length} skipped.`
          : res.data.message
      );
    });
  };

  const allocate = (seed) =>
    run(async () => {
      const res = await api.post(`/seating/plans/${selected._id}/allocate`,
        seed === undefined ? {} : { seed });
      await refreshSelected(selected._id);
      flash(res.data.message);
    });

  const reallocate = () => {
    const entered = window.prompt(
      'Seed to allocate with. The same seed always produces the same plan — leave the existing one to reprint an identical copy.',
      String(selected?.allocationSeed ?? '')
    );
    if (entered === null) return undefined;
    const seed = Number.parseInt(entered, 10);
    return allocate(Number.isNaN(seed) ? undefined : seed);
  };

  const addInvigilator = (event) => {
    event.preventDefault();
    return run(async () => {
      await api.post(`/seating/plans/${selected._id}/invigilators`, invigilatorForm);
      setInvigilatorForm({ teacher: '', teacherName: '', role: 'assistant' });
      await refreshSelected(selected._id);
      flash('Invigilator assigned.');
    });
  };

  const removeInvigilator = (entry) =>
    run(async () => {
      await api.delete(`/seating/plans/${selected._id}/invigilators/${entry._id}`);
      await refreshSelected(selected._id);
      flash('Invigilator removed.');
    });

  const removeCandidate = (candidate) =>
    run(async () => {
      await api.delete(`/seating/plans/${selected._id}/candidates/${candidate._id}`);
      await refreshSelected(selected._id);
      flash(`${candidate.rollNumber} removed.`);
    });

  const lifecycle = (action) => {
    if (action === 'cancel') {
      const reason = window.prompt('Why is this plan being cancelled?');
      if (!reason) return undefined;
      return run(async () => {
        await api.patch(`/seating/plans/${selected._id}/cancel`, { reason });
        await refreshSelected(selected._id);
        flash('Plan cancelled.');
      });
    }
    return run(async () => {
      const res = await api.patch(`/seating/plans/${selected._id}/${action}`);
      await refreshSelected(selected._id);
      flash(res.data.message);
    });
  };

  // Stable subject -> colour mapping for the grid legend.
  const subjectColours = useMemo(() => {
    if (!selected) return {};
    const codes = [
      ...new Set(selected.candidates.map((candidate) => candidate.subjectCode)),
    ].sort();
    return Object.fromEntries(
      codes.map((code, index) => [code, SUBJECT_COLOURS[index % SUBJECT_COLOURS.length]])
    );
  }, [selected]);

  // Seat -> candidate, so the grid can be drawn row by row.
  const grid = useMemo(() => {
    if (!selected) return [];
    const bySeat = new Map();
    selected.candidates.forEach((candidate) => {
      if (candidate.seatLabel) bySeat.set(candidate.seatLabel, candidate);
    });
    const blocked = new Set(selected.hall.blockedSeats || []);

    return Array.from({ length: selected.hall.rows }, (_, row) =>
      Array.from({ length: selected.hall.columns }, (_, column) => {
        const label = seatLabel(row, column);
        return {
          label,
          row,
          column,
          blocked: blocked.has(label),
          candidate: bySeat.get(label) || null,
        };
      })
    );
  }, [selected]);

  // Same-subject neighbours, recomputed client-side so the offending seats can
  // be outlined rather than just counted.
  const clashingSeats = useMemo(() => {
    const clashes = new Set();
    grid.forEach((row) =>
      row.forEach((seat) => {
        if (!seat.candidate) return;
        const right = grid[seat.row]?.[seat.column + 1];
        const below = grid[seat.row + 1]?.[seat.column];
        [right, below].forEach((neighbour) => {
          if (
            neighbour?.candidate &&
            neighbour.candidate.subjectCode === seat.candidate.subjectCode
          ) {
            clashes.add(seat.label);
            clashes.add(neighbour.label);
          }
        });
      })
    );
    return clashes;
  }, [grid]);

  return (
    <div className="space-y-6">

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Plans', value: stats.totalPlans },
            { label: 'Seated', value: `${stats.seatedCandidates}/${stats.totalCandidates}` },
            { label: 'Hall use', value: `${stats.hallUtilisation}%` },
            { label: 'No chief', value: stats.plansWithoutChief },
          ].map((entry) => (
            <div key={entry.label} className="bg-white rounded-xl shadow p-4 text-center">
              <div className="text-xl font-bold text-gray-800">{entry.value}</div>
              <div className="text-xs text-gray-400 mt-1">{entry.label}</div>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-xl px-4 py-3">
          {success}
        </div>
      )}

      <div className="bg-white rounded-2xl shadow p-6">
        <h3 className="text-xl font-bold text-gray-800 mb-1">🪑 New seating plan</h3>
        <p className="text-sm text-gray-500 mb-4">
          Describe the hall. Usable seats are rows × columns minus anything you
          block off.
        </p>

        <form onSubmit={createPlan} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="text"
              required
              placeholder="Exam title *"
              value={planForm.examTitle}
              onChange={(e) => setPlanForm({ ...planForm, examTitle: e.target.value })}
              className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <input
              type="text"
              required
              placeholder="Hall name (e.g. Main Hall) *"
              value={planForm.hallName}
              onChange={(e) => setPlanForm({ ...planForm, hallName: e.target.value })}
              className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input
              type="date"
              required
              value={planForm.examDate}
              onChange={(e) => setPlanForm({ ...planForm, examDate: e.target.value })}
              className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <input
              type="time"
              required
              value={planForm.startTime}
              onChange={(e) => setPlanForm({ ...planForm, startTime: e.target.value })}
              className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <input
              type="time"
              required
              value={planForm.endTime}
              onChange={(e) => setPlanForm({ ...planForm, endTime: e.target.value })}
              className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <label className="text-xs text-gray-500">
              Rows
              <input
                type="number"
                min={1}
                max={26}
                value={planForm.rows}
                onChange={(e) => setPlanForm({ ...planForm, rows: e.target.value })}
                className="mt-1 w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </label>
            <label className="text-xs text-gray-500">
              Columns
              <input
                type="number"
                min={1}
                max={40}
                value={planForm.columns}
                onChange={(e) => setPlanForm({ ...planForm, columns: e.target.value })}
                className="mt-1 w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </label>
            <label className="text-xs text-gray-500 col-span-2 sm:col-span-1">
              Blocked seats
              <input
                type="text"
                placeholder="B3, C1"
                value={planForm.blockedSeats}
                onChange={(e) => setPlanForm({ ...planForm, blockedSeats: e.target.value })}
                className="mt-1 w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </label>
          </div>

          <button
            type="submit"
            disabled={busy}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
          >
            {busy ? 'Working...' : 'Create plan'}
          </button>
        </form>
      </div>

      <div className="bg-white rounded-2xl shadow p-6">
        <h3 className="text-xl font-bold text-gray-800 mb-4">Plans</h3>
        {plans.length === 0 && (
          <p className="text-gray-400 text-sm text-center py-6">No seating plans yet.</p>
        )}
        <div className="space-y-2">
          {plans.map((plan) => (
            <button
              key={plan._id}
              onClick={() => run(() => refreshSelected(plan._id))}
              className={`w-full text-left border rounded-xl px-4 py-3 transition ${
                selected?._id === plan._id
                  ? 'border-indigo-400 bg-indigo-50'
                  : 'border-gray-200 hover:bg-gray-50'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-gray-800 text-sm">{plan.examTitle}</p>
                  <p className="text-xs text-gray-400">
                    {plan.hall.name} &middot; {plan.examDate} &middot; {plan.startTime}-{plan.endTime}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-gray-500">
                    {plan.seatsUsed}/{plan.capacity}
                  </span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      STATUS_STYLES[plan.status] || 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {plan.status}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {selected && (
        <div className="bg-white rounded-2xl shadow p-6 space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-xl font-bold text-gray-800">{selected.examTitle}</h3>
              <p className="text-sm text-gray-500">
                {selected.hall.name} &middot; {selected.hall.rows}×{selected.hall.columns}
                {' '}&middot; {selected.capacity} usable seats
              </p>
              {selected.allocationSeed !== null && (
                <p className="text-xs text-gray-400 font-mono mt-1">
                  seed {selected.allocationSeed} — re-allocating with this seed
                  reproduces the plan exactly
                </p>
              )}
            </div>
            <span
              className={`text-xs px-3 py-1 rounded-full ${
                STATUS_STYLES[selected.status] || 'bg-gray-100 text-gray-600'
              }`}
            >
              {selected.status}
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            {selected.isEditable && (
              <>
                <button
                  onClick={() => allocate()}
                  disabled={busy || selected.candidates.length === 0}
                  className="text-sm bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 rounded-lg transition disabled:opacity-40"
                >
                  Allocate seats
                </button>
                {selected.allocationSeed !== null && (
                  <button
                    onClick={reallocate}
                    disabled={busy}
                    className="text-sm border border-indigo-300 text-indigo-600 hover:bg-indigo-50 px-4 py-1.5 rounded-lg transition"
                  >
                    Re-allocate with a seed
                  </button>
                )}
              </>
            )}
            {selected.status === 'allocated' && (
              <button
                onClick={() => lifecycle('publish')}
                disabled={busy}
                className="text-sm bg-green-600 hover:bg-green-700 text-white px-4 py-1.5 rounded-lg transition"
              >
                Publish
              </button>
            )}
            {selected.status === 'published' && (
              <button
                onClick={() => lifecycle('lock')}
                disabled={busy}
                className="text-sm bg-blue-600 hover:bg-blue-700 text-white px-4 py-1.5 rounded-lg transition"
              >
                Lock
              </button>
            )}
            {!['locked', 'cancelled'].includes(selected.status) && (
              <button
                onClick={() => lifecycle('cancel')}
                disabled={busy}
                className="text-sm border border-red-200 text-red-600 hover:bg-red-50 px-4 py-1.5 rounded-lg transition"
              >
                Cancel plan
              </button>
            )}
          </div>

          {(selected.adjacencyViolations?.horizontal > 0 ||
            selected.adjacencyViolations?.vertical > 0) && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
              <p className="text-sm text-amber-800">
                <strong>
                  {selected.adjacencyViolations.horizontal} side-by-side
                </strong>{' '}
                and{' '}
                <strong>{selected.adjacencyViolations.vertical} front-to-back</strong>{' '}
                same-subject pairs remain. With this many candidates on one paper
                the hall geometry does not allow them all to be separated —
                the affected seats are outlined below.
              </p>
            </div>
          )}

          {selected.candidates.some((candidate) => candidate.seatLabel) && (
            <div>
              <div className="flex flex-wrap gap-2 mb-3">
                {Object.entries(subjectColours).map(([code, classes]) => (
                  <span
                    key={code}
                    className={`text-xs px-2 py-0.5 rounded border ${classes}`}
                  >
                    {code}
                  </span>
                ))}
              </div>

              <div className="overflow-x-auto">
                <div className="inline-block min-w-full">
                  {grid.map((row, rowIndex) => (
                    <div key={rowIndex} className="flex gap-1 mb-1">
                      {row.map((seat) => (
                        <div
                          key={seat.label}
                          title={
                            seat.candidate
                              ? `${seat.label} · ${seat.candidate.studentName} · ${seat.candidate.rollNumber} · ${seat.candidate.subjectCode}`
                              : seat.blocked
                                ? `${seat.label} · blocked`
                                : `${seat.label} · empty`
                          }
                          className={`w-14 h-12 shrink-0 rounded border text-[10px] leading-tight flex flex-col items-center justify-center ${
                            seat.blocked
                              ? 'bg-gray-800 text-gray-400 border-gray-700'
                              : seat.candidate
                                ? `${subjectColours[seat.candidate.subjectCode] || 'bg-gray-100 text-gray-700 border-gray-300'} ${
                                    clashingSeats.has(seat.label) ? 'ring-2 ring-red-500' : ''
                                  }`
                                : 'bg-gray-50 text-gray-300 border-gray-200 border-dashed'
                          }`}
                        >
                          <span className="font-mono font-semibold">{seat.label}</span>
                          {seat.candidate && (
                            <span className="font-mono truncate w-full text-center px-0.5">
                              {seat.candidate.rollNumber}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="border-t border-gray-200 pt-5">
            <h4 className="font-semibold text-gray-700 mb-3">
              Invigilators ({selected.invigilators.length})
            </h4>

            <div className="space-y-2 mb-4">
              {selected.invigilators.length === 0 && (
                <p className="text-sm text-gray-400">
                  Nobody assigned. A plan needs a chief invigilator before it can
                  be published.
                </p>
              )}
              {selected.invigilators.map((entry) => (
                <div
                  key={entry._id}
                  className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-2"
                >
                  <span className="text-sm text-gray-700">
                    {entry.teacherName || entry.teacher}
                    <span className="text-xs text-gray-400 ml-2">{entry.role}</span>
                  </span>
                  {!['locked', 'cancelled'].includes(selected.status) && (
                    <button
                      onClick={() => removeInvigilator(entry)}
                      className="text-xs text-red-600 hover:text-red-700"
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>

            {!['locked', 'cancelled'].includes(selected.status) && (
              <form onSubmit={addInvigilator} className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                <input
                  type="text"
                  required
                  placeholder="Teacher id *"
                  value={invigilatorForm.teacher}
                  onChange={(e) =>
                    setInvigilatorForm({ ...invigilatorForm, teacher: e.target.value })
                  }
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <input
                  type="text"
                  placeholder="Name"
                  value={invigilatorForm.teacherName}
                  onChange={(e) =>
                    setInvigilatorForm({ ...invigilatorForm, teacherName: e.target.value })
                  }
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <select
                  value={invigilatorForm.role}
                  onChange={(e) =>
                    setInvigilatorForm({ ...invigilatorForm, role: e.target.value })
                  }
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="chief">Chief</option>
                  <option value="assistant">Assistant</option>
                  <option value="relief">Relief</option>
                </select>
                <button
                  type="submit"
                  disabled={busy}
                  className="bg-gray-800 hover:bg-gray-900 text-white text-sm rounded-lg px-4 py-2 transition disabled:opacity-50"
                >
                  Assign
                </button>
              </form>
            )}
          </div>

          {selected.isEditable && (
            <div className="border-t border-gray-200 pt-5">
              <h4 className="font-semibold text-gray-700 mb-3">
                Candidates ({selected.candidates.length})
              </h4>

              <form onSubmit={addCandidate} className="grid grid-cols-1 sm:grid-cols-5 gap-2 mb-4">
                <input
                  type="text"
                  required
                  placeholder="Name *"
                  value={candidateForm.studentName}
                  onChange={(e) =>
                    setCandidateForm({ ...candidateForm, studentName: e.target.value })
                  }
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <input
                  type="text"
                  required
                  placeholder="Roll *"
                  value={candidateForm.rollNumber}
                  onChange={(e) =>
                    setCandidateForm({ ...candidateForm, rollNumber: e.target.value })
                  }
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <input
                  type="text"
                  required
                  placeholder="Subject *"
                  value={candidateForm.subjectCode}
                  onChange={(e) =>
                    setCandidateForm({ ...candidateForm, subjectCode: e.target.value })
                  }
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <input
                  type="text"
                  placeholder="Class"
                  value={candidateForm.className}
                  onChange={(e) =>
                    setCandidateForm({ ...candidateForm, className: e.target.value })
                  }
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-lg px-4 py-2 transition disabled:opacity-50"
                >
                  Add
                </button>
              </form>

              <div className="mb-4">
                <textarea
                  rows={3}
                  placeholder={'Paste a list — one per line:\nAsha Menon, 4412, PHY, 12A'}
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  onClick={addBulk}
                  disabled={busy || !bulkText.trim()}
                  className="mt-2 text-sm border border-gray-300 text-gray-600 hover:bg-gray-50 px-4 py-1.5 rounded-lg transition disabled:opacity-40"
                >
                  Add pasted list
                </button>
              </div>

              <div className="max-h-64 overflow-y-auto space-y-1">
                {selected.candidates.map((candidate) => (
                  <div
                    key={candidate._id}
                    className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-1.5 text-sm"
                  >
                    <span className="text-gray-700 truncate">
                      <span className="font-mono text-xs text-gray-400 mr-2">
                        {candidate.rollNumber}
                      </span>
                      {candidate.studentName}
                      <span className="text-xs text-gray-400 ml-2">
                        {candidate.subjectCode}
                        {candidate.seatLabel ? ` → ${candidate.seatLabel}` : ''}
                      </span>
                    </span>
                    <button
                      onClick={() => removeCandidate(candidate)}
                      className="text-xs text-red-600 hover:text-red-700 shrink-0 ml-2"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SeatingPanel;
