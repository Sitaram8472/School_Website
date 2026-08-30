import { useState, useEffect, useCallback, useContext, useMemo } from 'react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * Cover availability — working patterns, exclusions and load caps.
 *
 * For a teacher the panel leads with this week's load, not with the profile.
 * How many periods you have already covered against how many you can be asked
 * to is the number that turns a cap from a rejection into a protection, and it
 * has to be visible before somebody is asked rather than after they decline.
 *
 * For the office it is the eligibility list for the period being filled, with
 * the blocked people kept on screen and greyed rather than hidden. Hiding a
 * blocked teacher produces the phone call asking why they were not asked;
 * showing the reason answers it before it is made.
 */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const REASON_LABELS = {
  'part-time-contract': 'Part-time contract',
  'ppa-time': 'Planning time',
  'management-time': 'Management time',
  'external-commitment': 'External commitment',
  'phased-return': 'Phased return',
  'medical-restriction': 'Medical restriction',
  'exam-board-duty': 'Exam board duty',
  training: 'Training',
  safeguarding: 'Safeguarding',
  workload: 'Workload',
  personal: 'Personal',
  bereavement: 'Bereavement',
  study: 'Study',
  other: 'Other',
};

const label = (value) => REASON_LABELS[value] || value || '—';

const formatMinute = (minute) => {
  const safe = Math.max(0, Math.min(1440, Number(minute) || 0));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
};

const formatDate = (value) =>
  value
    ? new Date(`${value}T00:00:00`).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—';

const todayKey = () => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
};

const addDays = (dateKey, days) => {
  const date = new Date(`${dateKey}T00:00:00`);
  date.setDate(date.getDate() + days);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

/**
 * A cap drawn as a bar rather than as a fraction.
 *
 * "3 of 3" and a full bar say the same thing, but only one of them is legible
 * at a glance across twenty rows, which is how this list is actually read.
 */
const CapBar = ({ used, cap, unit }) => {
  const total = Math.max(1, Number(cap) || 0);
  const filled = Math.min(100, Math.round(((Number(used) || 0) / total) * 100));
  const tone = filled >= 100 ? 'bg-red-500' : filled >= 75 ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <div>
      <div className="flex items-baseline justify-between text-xs text-gray-600 mb-1">
        <span>
          {used} of {cap} {unit}
        </span>
        <span className={filled >= 100 ? 'text-red-600 font-medium' : 'text-gray-400'}>
          {filled >= 100 ? 'At the cap' : `${Math.max(0, cap - used)} left`}
        </span>
      </div>
      <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full ${tone} rounded-full transition-all`} style={{ width: `${filled}%` }} />
      </div>
    </div>
  );
};

const AvailabilityPanel = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isStaff = role === 'teacher' || role === 'admin';
  const isAdmin = role === 'admin';

  const [meta, setMeta] = useState(null);
  const [mine, setMine] = useState(null);

  const [date, setDate] = useState(todayKey);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('10:00');

  const [eligible, setEligible] = useState(null);
  const [load, setLoad] = useState(null);
  const [showBlocked, setShowBlocked] = useState(true);

  const [optOutUntil, setOptOutUntil] = useState('');
  const [optOutReason, setOptOutReason] = useState('workload');
  const [optOutNote, setOptOutNote] = useState('');

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 4000);
  };

  const explain = (err, fallback) =>
    setError(err?.response?.data?.message || err?.message || fallback);

  // ---- loading -------------------------------------------------------------

  const loadMeta = useCallback(async () => {
    if (!isStaff) return;
    try {
      const res = await api.get('/substitutions/availability/meta');
      setMeta(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load availability reference data.');
    }
  }, [isStaff]);

  const loadMine = useCallback(async () => {
    if (!isStaff) return;

    setLoading(true);
    try {
      const res = await api.get(`/substitutions/availability/mine?date=${date}`);
      setMine(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load your cover availability.');
    } finally {
      setLoading(false);
    }
  }, [isStaff, date]);

  const loadOffice = useCallback(async () => {
    if (!isAdmin) return;

    try {
      const [eligibleRes, loadRes] = await Promise.all([
        api.get(
          `/substitutions/availability/eligible?date=${date}&startTime=${startTime}&endTime=${endTime}`
        ),
        api.get(`/substitutions/availability/load?date=${date}`),
      ]);

      setEligible(eligibleRes.data || null);
      setLoad(loadRes.data.data || null);
    } catch (err) {
      explain(err, 'Could not work out who is eligible.');
    }
  }, [isAdmin, date, startTime, endTime]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    loadMine();
  }, [loadMine]);

  useEffect(() => {
    loadOffice();
  }, [loadOffice]);

  const maxOptOut = useMemo(
    () => addDays(todayKey(), meta?.maxOptOutDays || 14),
    [meta]
  );

  // ---- acting --------------------------------------------------------------

  const saveOptOut = async () => {
    if (!optOutUntil) {
      setError('Pick the date your opt-out should end.');
      return;
    }

    setError('');
    setBusy('opt-out');

    try {
      const res = await api.patch('/substitutions/availability/mine/opt-out', {
        untilDate: optOutUntil,
        reason: optOutReason,
        note: optOutNote,
      });

      flash(res.data.message || 'Opt-out recorded.');
      setOptOutNote('');
      loadMine();
      loadOffice();
    } catch (err) {
      explain(err, 'Could not record your opt-out.');
    } finally {
      setBusy('');
    }
  };

  const clearOptOut = async () => {
    setError('');
    setBusy('opt-out');

    try {
      const res = await api.delete('/substitutions/availability/mine/opt-out');
      flash(res.data.message || 'You are available for cover again.');
      loadMine();
      loadOffice();
    } catch (err) {
      explain(err, 'Could not clear your opt-out.');
    } finally {
      setBusy('');
    }
  };

  if (!isStaff) return null;

  const caps = mine?.caps;
  const optOut = mine?.optOut;

  return (
    <div className="bg-white rounded-xl shadow p-4 sm:p-6 mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Cover availability</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Working patterns, dated adjustments and how much cover anybody can be asked to take.
          </p>
        </div>

        <label className="text-sm">
          <span className="block text-xs text-gray-500 mb-1">Week of</span>
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value || todayKey())}
            className="border border-gray-200 rounded px-2 py-1 text-sm"
          />
        </label>
      </div>

      {error && (
        <div className="mb-4 text-sm bg-red-50 border border-red-100 text-red-700 rounded px-3 py-2">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 text-sm bg-emerald-50 border border-emerald-100 text-emerald-700 rounded px-3 py-2">
          {success}
        </div>
      )}

      {/* ---- the teacher's own week ---- */}
      <div className="border border-gray-100 rounded-lg p-4 mb-6">
        <h3 className="font-semibold text-gray-800 text-sm mb-3">Your cover this week</h3>

        {loading && !mine ? (
          <p className="text-sm text-gray-500">Working it out…</p>
        ) : (
          <>
            {caps && (
              <div className="grid gap-4 sm:grid-cols-2 mb-4">
                <CapBar
                  used={caps.dailyPeriodsUsed}
                  cap={caps.dailyPeriodsCap}
                  unit="periods today"
                />
                <CapBar
                  used={caps.weeklyPeriodsUsed}
                  cap={caps.weeklyPeriodsCap}
                  unit="periods this week"
                />
                <CapBar
                  used={caps.dailyMinutesUsed}
                  cap={caps.dailyMinutesCap}
                  unit="minutes today"
                />
                <CapBar
                  used={caps.weeklyMinutesUsed}
                  cap={caps.weeklyMinutesCap}
                  unit="minutes this week"
                />
              </div>
            )}

            {mine?.week && (
              <p className="text-xs text-gray-500 mb-3">
                Week of {formatDate(mine.week.from)} to {formatDate(mine.week.to)}. Counted from the
                cover actually on the board, so releasing a period gives the capacity back straight
                away.
              </p>
            )}

            {mine?.thisWeek?.length > 0 ? (
              <div className="overflow-x-auto mb-4">
                <table className="w-full text-sm min-w-[30rem]">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                      <th className="py-2 pr-2 font-medium">Date</th>
                      <th className="py-2 pr-2 font-medium">Period</th>
                      <th className="py-2 pr-2 font-medium">Class</th>
                      <th className="py-2 pr-2 font-medium">Time</th>
                      <th className="py-2 font-medium text-right">Minutes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mine.thisWeek.map((row) => (
                      <tr
                        key={`${row.absence}:${row.periodId}`}
                        className="border-b border-gray-50 last:border-0"
                      >
                        <td className="py-2 pr-2 text-gray-800">{formatDate(row.date)}</td>
                        <td className="py-2 pr-2 text-gray-600">{row.periodLabel}</td>
                        <td className="py-2 pr-2 text-gray-600">
                          {row.className}
                          {row.subject ? ` · ${row.subject}` : ''}
                        </td>
                        <td className="py-2 pr-2 text-gray-600">
                          {row.startTime}–{row.endTime}
                        </td>
                        <td className="py-2 text-right text-gray-800">{row.minutes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-gray-500 mb-4">No cover on the board for you this week.</p>
            )}

            {/* ---- the pattern the office has recorded ---- */}
            {mine?.profile?.weeklyBlocks?.length > 0 && (
              <div className="border-t border-gray-100 pt-4 mb-4">
                <p className="text-sm text-gray-800 mb-2">When you are not in school</p>
                <div className="flex flex-wrap gap-2">
                  {mine.profile.weeklyBlocks.map((block) => (
                    <span
                      key={block._id}
                      className="text-xs bg-gray-100 text-gray-700 rounded-full px-2.5 py-1"
                    >
                      {DAY_NAMES[block.dayOfWeek]} {formatMinute(block.startMinute)}–
                      {formatMinute(block.endMinute)}
                      {block.label ? ` · ${block.label}` : ''}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {mine?.profile?.exclusions?.length > 0 && (
              <div className="border-t border-gray-100 pt-4 mb-4">
                <p className="text-sm text-gray-800 mb-2">Dated adjustments</p>
                <ul className="space-y-1">
                  {mine.profile.exclusions.map((exclusion) => (
                    <li key={exclusion._id} className="text-xs text-gray-600">
                      {formatDate(exclusion.fromDate)} to {formatDate(exclusion.toDate)} ·{' '}
                      {label(exclusion.reason)}
                      {exclusion.startMinute !== null && exclusion.endMinute !== null
                        ? ` · ${formatMinute(exclusion.startMinute)}–${formatMinute(exclusion.endMinute)}`
                        : ' · all day'}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-gray-500 mt-2">
                  Recorded by the office. Every one of them has an end date, because an adjustment
                  with no end is one nobody reviews.
                </p>
              </div>
            )}

            {/* ---- the teacher's own no ---- */}
            <div className="border-t border-gray-100 pt-4">
              {optOut ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-gray-800">
                      You are opted out of cover until{' '}
                      <span className="font-medium">{formatDate(optOut.untilDate)}</span>.
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Reason recorded: {label(optOut.reason)}
                      {optOut.note ? ` — ${optOut.note}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busy === 'opt-out'}
                    onClick={clearOptOut}
                    className="text-sm px-3 py-1.5 border border-gray-200 rounded disabled:opacity-50"
                  >
                    I am available again
                  </button>
                </div>
              ) : (
                <div>
                  <p className="text-sm text-gray-800 mb-1">Opt out of cover for a while</p>
                  <p className="text-xs text-gray-500 mb-3">
                    A hard no the office cannot override. It has to end within{' '}
                    {meta?.maxOptOutDays || 14} days — anything longer is a dated exclusion, which
                    the office records for you.
                  </p>

                  <div className="grid gap-2 sm:grid-cols-3">
                    <label className="text-sm">
                      <span className="block text-xs text-gray-500 mb-1">Until</span>
                      <input
                        type="date"
                        value={optOutUntil}
                        min={todayKey()}
                        max={maxOptOut}
                        onChange={(event) => setOptOutUntil(event.target.value)}
                        className="w-full border border-gray-200 rounded px-2 py-1 text-sm"
                      />
                    </label>

                    <label className="text-sm">
                      <span className="block text-xs text-gray-500 mb-1">Reason</span>
                      <select
                        value={optOutReason}
                        onChange={(event) => setOptOutReason(event.target.value)}
                        className="w-full border border-gray-200 rounded px-2 py-1 text-sm"
                      >
                        {(meta?.optOutReasons || ['workload', 'personal', 'other']).map((entry) => (
                          <option key={entry} value={entry}>
                            {label(entry)}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="text-sm">
                      <span className="block text-xs text-gray-500 mb-1">Note (optional)</span>
                      <input
                        type="text"
                        value={optOutNote}
                        maxLength={300}
                        onChange={(event) => setOptOutNote(event.target.value)}
                        className="w-full border border-gray-200 rounded px-2 py-1 text-sm"
                      />
                    </label>
                  </div>

                  <button
                    type="button"
                    disabled={busy === 'opt-out'}
                    onClick={saveOptOut}
                    className="mt-3 text-sm px-3 py-1.5 bg-indigo-600 text-white rounded disabled:opacity-50"
                  >
                    Opt out
                  </button>
                </div>
              )}
            </div>

            {mine && !mine.hasProfile && (
              <p className="text-xs text-gray-500 mt-3">
                You have no working pattern recorded, so you count as full-time and available. Ask
                the office to add one if that is wrong.
              </p>
            )}
          </>
        )}
      </div>

      {/* ---- the office ---- */}
      {isAdmin && (
        <div className="space-y-6">
          <div className="border border-gray-100 rounded-lg p-4">
            <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
              <h3 className="font-semibold text-gray-800 text-sm">Who can take this period</h3>

              <div className="flex flex-wrap gap-2">
                <label className="text-sm">
                  <span className="block text-xs text-gray-500 mb-1">From</span>
                  <input
                    type="time"
                    value={startTime}
                    onChange={(event) => setStartTime(event.target.value)}
                    className="border border-gray-200 rounded px-2 py-1 text-sm"
                  />
                </label>
                <label className="text-sm">
                  <span className="block text-xs text-gray-500 mb-1">To</span>
                  <input
                    type="time"
                    value={endTime}
                    onChange={(event) => setEndTime(event.target.value)}
                    className="border border-gray-200 rounded px-2 py-1 text-sm"
                  />
                </label>
              </div>
            </div>

            {eligible?.data?.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[32rem]">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                      <th className="py-2 pr-2 font-medium">Teacher</th>
                      <th className="py-2 pr-2 font-medium text-right">Today</th>
                      <th className="py-2 pr-2 font-medium text-right">This week</th>
                      <th className="py-2 pr-2 font-medium text-right">Periods left</th>
                      <th className="py-2 font-medium text-right">Minutes left</th>
                    </tr>
                  </thead>
                  <tbody>
                    {eligible.data.map((person) => (
                      <tr key={person._id} className="border-b border-gray-50 last:border-0">
                        <td className="py-2 pr-2 text-gray-800">
                          {person.name}
                          {!person.hasProfile && (
                            <span className="ml-2 text-xs text-gray-400">no pattern recorded</span>
                          )}
                        </td>
                        <td className="py-2 pr-2 text-right text-gray-600">
                          {person.coverPeriodsToday}
                        </td>
                        <td className="py-2 pr-2 text-right text-gray-600">
                          {person.coverPeriodsThisWeek}
                        </td>
                        <td className="py-2 pr-2 text-right font-medium">
                          {person.weeklyPeriodsLeft}
                        </td>
                        <td className="py-2 text-right text-gray-600">
                          {person.weeklyMinutesLeft}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-gray-500">
                Nobody is eligible for that window. The list below says why.
              </p>
            )}

            <p className="text-xs text-gray-500 mt-2">
              Ordered by capacity left rather than by cover taken today, so a part-timer with one
              period left is offered after a full-timer with six.
            </p>
          </div>

          {(eligible?.blocked?.length > 0 || eligible?.busy?.length > 0) && (
            <div className="border border-gray-100 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-gray-800 text-sm">
                  Not available for this period
                </h3>
                <button
                  type="button"
                  onClick={() => setShowBlocked((value) => !value)}
                  className="text-xs text-indigo-600"
                >
                  {showBlocked ? 'Hide' : 'Show'}
                </button>
              </div>

              {showBlocked && (
                <div className="space-y-2">
                  {(eligible.blocked || []).map((person) => (
                    <div
                      key={person._id}
                      className="flex flex-wrap items-start justify-between gap-2 bg-gray-50 rounded px-3 py-2"
                    >
                      <div>
                        <p className="text-sm text-gray-800">{person.name}</p>
                        <ul className="text-xs text-gray-600 mt-0.5 list-disc list-inside">
                          {person.reasons.map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      </div>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          person.overridable
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-gray-200 text-gray-600'
                        }`}
                      >
                        {person.overridable ? 'Cap — can be overridden with a reason' : 'Hard block'}
                      </span>
                    </div>
                  ))}

                  {(eligible.busy || []).map((person) => (
                    <div
                      key={person._id}
                      className="flex flex-wrap items-start justify-between gap-2 bg-gray-50 rounded px-3 py-2"
                    >
                      <div>
                        <p className="text-sm text-gray-800">{person.name}</p>
                        <p className="text-xs text-gray-600 mt-0.5">{person.reason}</p>
                      </div>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-600">
                        Timetable clash
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <p className="text-xs text-gray-500 mt-3">
                Kept on screen on purpose. A teacher who is missing from the list without a reason
                is a phone call to the office; a teacher with one is an answer.
              </p>
            </div>
          )}

          {load?.rows?.length > 0 && (
            <div className="border border-gray-100 rounded-lg p-4">
              <h3 className="font-semibold text-gray-800 text-sm mb-1">
                Who is carrying cover, week of {formatDate(load.week.from)}
              </h3>
              <p className="text-xs text-gray-500 mb-3">
                {load.totalPeriods} period(s), {load.totalMinutes} minutes, {load.atCapCount} at the
                weekly cap.
              </p>

              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[34rem]">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                      <th className="py-2 pr-2 font-medium">Teacher</th>
                      <th className="py-2 pr-2 font-medium text-right">Contract</th>
                      <th className="py-2 pr-2 font-medium text-right">Periods</th>
                      <th className="py-2 pr-2 font-medium text-right">Minutes</th>
                      <th className="py-2 pr-2 font-medium text-right">Left</th>
                      <th className="py-2 font-medium text-right">Overrides</th>
                    </tr>
                  </thead>
                  <tbody>
                    {load.rows.map((row) => (
                      <tr key={row.staff} className="border-b border-gray-50 last:border-0">
                        <td className="py-2 pr-2 text-gray-800">
                          {row.name}
                          {row.optedOut && (
                            <span className="ml-2 text-xs text-amber-700">opted out</span>
                          )}
                        </td>
                        <td className="py-2 pr-2 text-right text-gray-600">
                          {row.contractFraction}
                        </td>
                        <td className="py-2 pr-2 text-right text-gray-800">{row.periodsThisWeek}</td>
                        <td className="py-2 pr-2 text-right text-gray-600">{row.minutesThisWeek}</td>
                        <td
                          className={`py-2 pr-2 text-right ${
                            row.atCap ? 'text-red-600 font-medium' : 'text-gray-600'
                          }`}
                        >
                          {row.weeklyPeriodsLeft}
                        </td>
                        <td
                          className={`py-2 text-right ${
                            row.overridesThisTerm > 0 ? 'text-amber-700' : 'text-gray-400'
                          }`}
                        >
                          {row.overridesThisTerm}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="text-xs text-gray-500 mt-2">
                The override column is the one worth watching. One on a snowy Tuesday is a school
                working; the same name eleven times in a term is a staffing problem.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default AvailabilityPanel;
