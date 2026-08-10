import { useState, useEffect, useContext, useCallback } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * Syllabus coverage.
 *
 * The important design decision on this page is that planned and actual are
 * drawn on the same axis, one above the other. The gap between two bars is
 * legible at a glance in a way that "63%" is not, and the whole feature exists
 * to make that gap visible in October rather than February.
 *
 * The log-a-lesson control is inline on the unit row and takes three fields. A
 * teacher logging lessons at 16:20 on a Friday will use a control that takes
 * four seconds and will not use one that takes thirty.
 */

const HEALTH_STYLES = {
  ahead: 'bg-emerald-100 text-emerald-800',
  'on-track': 'bg-green-100 text-green-700',
  slipping: 'bg-amber-100 text-amber-800',
  behind: 'bg-red-100 text-red-700',
  empty: 'bg-gray-100 text-gray-600',
};

const HEALTH_LABELS = {
  ahead: 'Ahead',
  'on-track': 'On track',
  slipping: 'Slipping',
  behind: 'Behind',
  empty: 'No units yet',
};

const UNIT_STATUS_STYLES = {
  'not-started': 'bg-gray-100 text-gray-600',
  'in-progress': 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  deferred: 'bg-orange-100 text-orange-700',
};

const UNIT_STATUS_LABELS = {
  'not-started': 'Not started',
  'in-progress': 'Teaching',
  completed: 'Complete',
  deferred: 'Deferred',
};

const emptyPlan = {
  className: '',
  subject: '',
  academicYear: '',
  termStartDate: '',
  termEndDate: '',
};

const emptyUnit = {
  title: '',
  plannedPeriods: 4,
  plannedStartDate: '',
  plannedEndDate: '',
};

const todayKey = () => {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
};

const currentYear = () => {
  const now = new Date();
  const startYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
};

const HealthChip = ({ health }) => (
  <span
    className={`px-2 py-0.5 rounded text-xs font-medium ${
      HEALTH_STYLES[health] || 'bg-gray-100 text-gray-700'
    }`}
  >
    {HEALTH_LABELS[health] || health}
  </span>
);

/**
 * Two bars on one axis: what the calendar expects, and what has been taught.
 * The expected bar is drawn as an outline so it reads as a target rather than
 * as a second quantity.
 */
const CoverageBars = ({ progress }) => {
  const actual = Math.min(progress.coveragePercent, 100);
  const expected = Math.min(progress.expectedPercent, 100);

  return (
    <div className="w-full">
      <div className="relative h-3 bg-gray-100 rounded overflow-hidden">
        <div
          className={`h-full ${
            progress.health === 'behind'
              ? 'bg-red-500'
              : progress.health === 'slipping'
                ? 'bg-amber-500'
                : 'bg-green-500'
          }`}
          style={{ width: `${actual}%` }}
        />
        <div
          className="absolute top-0 h-full border-r-2 border-gray-700"
          style={{ width: `${expected}%` }}
          title={`Expected by today: ${progress.expectedPercent}%`}
        />
      </div>
      <div className="flex justify-between text-xs text-gray-500 mt-1">
        <span>
          {progress.periodsTaught} of {progress.plannedPeriods} periods taught (
          {progress.coveragePercent}%)
        </span>
        <span>
          expected {progress.expectedPercent}%
          {progress.lagPercent > 0 && (
            <span className="text-red-600 font-medium">
              {' '}
              · {progress.lagPercent} behind
            </span>
          )}
        </span>
      </div>
    </div>
  );
};

const SyllabusTracker = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';

  const [tab, setTab] = useState('mine');
  const [plans, setPlans] = useState([]);
  const [overview, setOverview] = useState(null);
  const [detail, setDetail] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [showPlanForm, setShowPlanForm] = useState(false);
  const [planForm, setPlanForm] = useState({
    ...emptyPlan,
    academicYear: currentYear(),
  });
  const [unitForm, setUnitForm] = useState(emptyUnit);
  const [showUnitForm, setShowUnitForm] = useState(false);

  // Which unit's "log a lesson" row is open, and what is typed into it.
  const [logFor, setLogFor] = useState(null);
  const [logForm, setLogForm] = useState({
    date: todayKey(),
    periods: 1,
    topic: '',
  });

  const readError = (err, fallback) => err?.response?.data?.message || fallback;

  const clearMessages = () => {
    setError('');
    setNotice('');
  };

  const loadMine = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/syllabus/plans/mine');
      setPlans(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load your plans'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/syllabus/overview');
      setOverview(data.data);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the overview'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (planId) => {
    try {
      const { data } = await api.get(`/syllabus/plans/${planId}`);
      setDetail(data.data);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load that plan'));
    }
  }, []);

  useEffect(() => {
    if (tab === 'mine') loadMine();
    if (tab === 'overview') loadOverview();
  }, [tab, loadMine, loadOverview]);

  const toggleExpand = (planId) => {
    if (expandedId === planId) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(planId);
    setDetail(null);
    loadDetail(planId);
  };

  const refreshOpenPlan = (data) => {
    setDetail(data);
    if (tab === 'mine') loadMine();
    if (tab === 'overview') loadOverview();
  };

  const createPlan = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      await api.post('/syllabus/plans', planForm);
      setNotice('Plan created. Add its units, then activate it.');
      setShowPlanForm(false);
      setPlanForm({ ...emptyPlan, academicYear: currentYear() });
      loadMine();
    } catch (err) {
      setError(readError(err, 'Could not create the plan'));
    }
  };

  const addUnit = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      const { data } = await api.post(
        `/syllabus/plans/${expandedId}/units`,
        unitForm
      );
      setNotice('Unit added.');
      setUnitForm(emptyUnit);
      setShowUnitForm(false);
      refreshOpenPlan(data.data);
    } catch (err) {
      setError(readError(err, 'Could not add the unit'));
    }
  };

  const activatePlan = async (planId) => {
    clearMessages();
    try {
      const { data } = await api.patch(`/syllabus/plans/${planId}/activate`);
      setNotice('Plan activated.');
      refreshOpenPlan(data.data);
    } catch (err) {
      setError(readError(err, 'Could not activate the plan'));
    }
  };

  const logLesson = async (unitId) => {
    clearMessages();
    try {
      const { data } = await api.post(
        `/syllabus/plans/${expandedId}/units/${unitId}/sessions`,
        { ...logForm, periods: Number(logForm.periods) }
      );
      setNotice('Lesson logged.');
      setLogFor(null);
      setLogForm({ date: todayKey(), periods: 1, topic: '' });
      refreshOpenPlan(data.data);
    } catch (err) {
      setError(readError(err, 'Could not log the lesson'));
    }
  };

  const completeUnit = async (unitId) => {
    clearMessages();
    try {
      const { data } = await api.patch(
        `/syllabus/plans/${expandedId}/units/${unitId}/complete`
      );
      setNotice('Unit marked complete.');
      refreshOpenPlan(data.data);
    } catch (err) {
      setError(readError(err, 'Could not complete the unit'));
    }
  };

  const deferUnit = async (unitId) => {
    const reason = window.prompt('Why is this unit being deferred?');
    if (!reason) return;
    clearMessages();
    try {
      const { data } = await api.patch(
        `/syllabus/plans/${expandedId}/units/${unitId}/defer`,
        { reason }
      );
      setNotice('Unit deferred. It stays in the plan and in the total.');
      refreshOpenPlan(data.data);
    } catch (err) {
      setError(readError(err, 'Could not defer the unit'));
    }
  };

  const tabs = [
    { key: 'mine', label: 'My plans' },
    ...(isAdmin ? [{ key: 'overview', label: 'School overview' }] : []),
  ];

  const rows = tab === 'overview' ? overview?.plans || [] : plans;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-gray-800">Syllabus coverage</h1>
        <p className="text-gray-600 mt-1">
          Coverage is calculated from the lessons logged against each unit, and
          compared with where the scheme of work says today ought to be.
        </p>
      </header>

      <div className="flex flex-wrap gap-2 mb-6 border-b border-gray-200">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => {
              setTab(entry.key);
              setExpandedId(null);
              setDetail(null);
              clearMessages();
            }}
            className={`px-4 py-2 -mb-px border-b-2 font-medium transition ${
              tab === entry.key
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {entry.label}
          </button>
        ))}

        {tab === 'mine' && (
          <button
            type="button"
            onClick={() => {
              setShowPlanForm((open) => !open);
              clearMessages();
            }}
            className="ml-auto mb-1 bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition"
          >
            {showPlanForm ? 'Close' : 'New plan'}
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 p-3 rounded bg-green-50 border border-green-200 text-green-700">
          {notice}
        </div>
      )}

      {tab === 'overview' && overview && (
        <div className="mb-5 p-4 rounded-lg bg-gray-50 border border-gray-200 flex flex-wrap gap-6">
          <div>
            <span className="block text-2xl font-bold text-gray-800">
              {overview.total}
            </span>
            <span className="text-sm text-gray-600">active plans</span>
          </div>
          <div>
            <span
              className={`block text-2xl font-bold ${
                overview.needingAttention ? 'text-red-600' : 'text-green-600'
              }`}
            >
              {overview.needingAttention}
            </span>
            <span className="text-sm text-gray-600">slipping or behind</span>
          </div>
          <p className="text-sm text-gray-500 self-center max-w-md">
            Sorted worst first. A plan counts as behind once it is{' '}
            {overview.thresholds.behind} percentage points under where the
            calendar puts it.
          </p>
        </div>
      )}

      {showPlanForm && (
        <form
          onSubmit={createPlan}
          className="mb-6 p-4 border border-gray-200 rounded-lg bg-gray-50 grid gap-3 md:grid-cols-3"
        >
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Class</span>
            <input
              type="text"
              value={planForm.className}
              onChange={(e) =>
                setPlanForm({ ...planForm, className: e.target.value })
              }
              placeholder="9B"
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Subject</span>
            <input
              type="text"
              value={planForm.subject}
              onChange={(e) => setPlanForm({ ...planForm, subject: e.target.value })}
              placeholder="Physics"
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Academic year</span>
            <input
              type="text"
              value={planForm.academicYear}
              onChange={(e) =>
                setPlanForm({ ...planForm, academicYear: e.target.value })
              }
              placeholder="2026-27"
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Term starts</span>
            <input
              type="date"
              value={planForm.termStartDate}
              onChange={(e) =>
                setPlanForm({ ...planForm, termStartDate: e.target.value })
              }
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Term ends</span>
            <input
              type="date"
              value={planForm.termEndDate}
              onChange={(e) =>
                setPlanForm({ ...planForm, termEndDate: e.target.value })
              }
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>
          <div className="md:col-span-3">
            <button
              type="submit"
              className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition"
            >
              Create plan
            </button>
          </div>
        </form>
      )}

      {loading && <p className="text-gray-500">Loading…</p>}

      {!loading && rows.length === 0 && (
        <p className="text-gray-500">
          {tab === 'mine'
            ? 'You have no syllabus plans yet.'
            : 'No active plans in the school.'}
        </p>
      )}

      <div className="space-y-3">
        {rows.map((plan) => (
          <article
            key={plan._id}
            className="border border-gray-200 rounded-lg bg-white overflow-hidden"
          >
            <button
              type="button"
              onClick={() => toggleExpand(plan._id)}
              className="w-full text-left p-4 hover:bg-gray-50 transition"
            >
              <div className="flex flex-wrap items-center gap-3 mb-2">
                <span className="font-semibold text-gray-800">
                  {plan.className} · {plan.subject}
                </span>
                <span className="text-sm text-gray-500">{plan.academicYear}</span>
                {plan.teacher?.name && (
                  <span className="text-sm text-gray-500">{plan.teacher.name}</span>
                )}
                <span className="ml-auto flex items-center gap-2">
                  {plan.status !== 'active' && (
                    <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">
                      {plan.status}
                    </span>
                  )}
                  <HealthChip health={plan.progress.health} />
                </span>
              </div>
              <CoverageBars progress={plan.progress} />
            </button>

            {expandedId === plan._id && (
              <div className="border-t border-gray-200 p-4 bg-gray-50">
                {!detail && <p className="text-gray-500 text-sm">Loading units…</p>}

                {detail && (
                  <>
                    <div className="flex flex-wrap gap-2 mb-4">
                      {detail.status === 'draft' && (
                        <button
                          type="button"
                          onClick={() => activatePlan(detail._id)}
                          className="text-sm px-3 py-1 rounded bg-green-600 text-white hover:bg-green-700"
                        >
                          Activate plan
                        </button>
                      )}
                      {detail.status !== 'archived' && (
                        <button
                          type="button"
                          onClick={() => setShowUnitForm((open) => !open)}
                          className="text-sm px-3 py-1 rounded border border-gray-300 bg-white hover:bg-gray-100"
                        >
                          {showUnitForm ? 'Close' : 'Add unit'}
                        </button>
                      )}
                      {detail.progress.unitsOverrunning > 0 && (
                        <span className="text-sm text-amber-700 self-center">
                          {detail.progress.unitsOverrunning}{' '}
                          {detail.progress.unitsOverrunning === 1 ? 'unit is' : 'units are'}{' '}
                          taking longer than planned
                        </span>
                      )}
                    </div>

                    {showUnitForm && (
                      <form
                        onSubmit={addUnit}
                        className="mb-4 p-3 rounded bg-white border border-gray-200 grid gap-3 md:grid-cols-4"
                      >
                        <label className="text-sm md:col-span-2">
                          <span className="block text-gray-600 mb-1">Unit title</span>
                          <input
                            type="text"
                            value={unitForm.title}
                            onChange={(e) =>
                              setUnitForm({ ...unitForm, title: e.target.value })
                            }
                            className="border border-gray-300 rounded px-3 py-1.5 w-full"
                          />
                        </label>
                        <label className="text-sm">
                          <span className="block text-gray-600 mb-1">Periods</span>
                          <input
                            type="number"
                            min="1"
                            value={unitForm.plannedPeriods}
                            onChange={(e) =>
                              setUnitForm({
                                ...unitForm,
                                plannedPeriods: Number(e.target.value),
                              })
                            }
                            className="border border-gray-300 rounded px-3 py-1.5 w-full"
                          />
                        </label>
                        <label className="text-sm">
                          <span className="block text-gray-600 mb-1">Planned start</span>
                          <input
                            type="date"
                            value={unitForm.plannedStartDate}
                            onChange={(e) =>
                              setUnitForm({
                                ...unitForm,
                                plannedStartDate: e.target.value,
                              })
                            }
                            className="border border-gray-300 rounded px-3 py-1.5 w-full"
                          />
                        </label>
                        <label className="text-sm">
                          <span className="block text-gray-600 mb-1">Planned end</span>
                          <input
                            type="date"
                            value={unitForm.plannedEndDate}
                            onChange={(e) =>
                              setUnitForm({
                                ...unitForm,
                                plannedEndDate: e.target.value,
                              })
                            }
                            className="border border-gray-300 rounded px-3 py-1.5 w-full"
                          />
                        </label>
                        <div className="md:col-span-4">
                          <button
                            type="submit"
                            className="bg-blue-600 text-white px-4 py-1.5 rounded hover:bg-blue-700 text-sm"
                          >
                            Add unit
                          </button>
                        </div>
                      </form>
                    )}

                    <ul className="space-y-2">
                      {detail.units.map((unit) => (
                        <li
                          key={unit._id}
                          className="p-3 rounded bg-white border border-gray-200"
                        >
                          <div className="flex flex-wrap items-center gap-3">
                            <span className="text-gray-400 text-sm w-6">
                              {unit.orderIndex + 1}
                            </span>
                            <span className="font-medium text-gray-800">
                              {unit.title}
                            </span>
                            <span
                              className={`px-2 py-0.5 rounded text-xs ${
                                UNIT_STATUS_STYLES[unit.status]
                              }`}
                            >
                              {UNIT_STATUS_LABELS[unit.status]}
                            </span>
                            <span
                              className={`text-sm ${
                                unit.isOverrunning ? 'text-amber-700 font-medium' : 'text-gray-500'
                              }`}
                            >
                              {unit.periodsTaught} / {unit.plannedPeriods} periods
                            </span>

                            {detail.status !== 'archived' && (
                              <span className="ml-auto flex gap-2">
                                {unit.status !== 'completed' && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setLogFor(logFor === unit._id ? null : unit._id)
                                    }
                                    className="text-sm px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                                  >
                                    Log a lesson
                                  </button>
                                )}
                                {unit.status === 'in-progress' && (
                                  <button
                                    type="button"
                                    onClick={() => completeUnit(unit._id)}
                                    className="text-sm px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
                                  >
                                    Complete
                                  </button>
                                )}
                                {['not-started', 'in-progress'].includes(unit.status) && (
                                  <button
                                    type="button"
                                    onClick={() => deferUnit(unit._id)}
                                    className="text-sm px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
                                  >
                                    Defer
                                  </button>
                                )}
                              </span>
                            )}
                          </div>

                          {unit.deferralReason && (
                            <p className="text-sm text-orange-700 mt-2">
                              Deferred: {unit.deferralReason}
                            </p>
                          )}

                          {logFor === unit._id && (
                            <div className="mt-3 flex flex-wrap gap-3 items-end">
                              <label className="text-sm">
                                <span className="block text-gray-600 mb-1">Date</span>
                                <input
                                  type="date"
                                  value={logForm.date}
                                  onChange={(e) =>
                                    setLogForm({ ...logForm, date: e.target.value })
                                  }
                                  className="border border-gray-300 rounded px-3 py-1.5"
                                />
                              </label>
                              <label className="text-sm">
                                <span className="block text-gray-600 mb-1">Periods</span>
                                <input
                                  type="number"
                                  min="1"
                                  value={logForm.periods}
                                  onChange={(e) =>
                                    setLogForm({ ...logForm, periods: e.target.value })
                                  }
                                  className="border border-gray-300 rounded px-3 py-1.5 w-20"
                                />
                              </label>
                              <label className="text-sm grow">
                                <span className="block text-gray-600 mb-1">Topic</span>
                                <input
                                  type="text"
                                  value={logForm.topic}
                                  onChange={(e) =>
                                    setLogForm({ ...logForm, topic: e.target.value })
                                  }
                                  className="border border-gray-300 rounded px-3 py-1.5 w-full"
                                />
                              </label>
                              <button
                                type="button"
                                onClick={() => logLesson(unit._id)}
                                className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700"
                              >
                                Log
                              </button>
                            </div>
                          )}

                          {unit.sessions.length > 0 && (
                            <details className="mt-2">
                              <summary className="text-sm text-gray-500 cursor-pointer">
                                {unit.sessions.length} logged{' '}
                                {unit.sessions.length === 1 ? 'lesson' : 'lessons'}
                              </summary>
                              <ul className="mt-2 space-y-1 text-sm text-gray-600">
                                {unit.sessions.map((session) => (
                                  <li key={session._id}>
                                    {session.date} — {session.periods}{' '}
                                    {session.periods === 1 ? 'period' : 'periods'} —{' '}
                                    {session.topic}
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
                        </li>
                      ))}
                    </ul>

                    {detail.units.length === 0 && (
                      <p className="text-gray-500 text-sm">
                        No units yet. Add the scheme of work before activating the plan.
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
};

export default SyllabusTracker;
