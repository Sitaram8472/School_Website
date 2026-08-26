import { useState, useEffect, useCallback, useContext, useMemo } from 'react';
import { Target, AlertTriangle, CheckCircle2, Lock, TrendingUp, EyeOff } from 'lucide-react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * Targets, sitting under the charts they judge.
 *
 * The charts above answer what happened. This answers whether it was good, and
 * it can only do that because the expectation was written down first — so the
 * form refuses a period that has already ended, and says why rather than
 * greying a field out.
 *
 * Two things are shown that a plain percentage would hide. **Pace**: a target
 * 40% through its window at 30% of its value is behind, and that is worth
 * saying in March rather than in July. And **where the number came from** —
 * `derived` while the period runs, `certified` once it has closed — because a
 * closed target's figure is deliberately frozen and a reader should know they
 * are looking at a record rather than a live count.
 */

const STATUS_LABELS = {
  draft: 'Draft',
  live: 'Live',
  closed: 'Closed',
  abandoned: 'Abandoned',
};

const STATUS_STYLES = {
  draft: 'bg-gray-200 text-gray-700',
  live: 'bg-blue-100 text-blue-700',
  closed: 'bg-green-100 text-green-700',
  abandoned: 'bg-gray-200 text-gray-500',
};

const DIRECTION_LABELS = {
  'at-least': 'at least',
  'at-most': 'at most',
};

const EMPTY_FORM = {
  metric: 'logins',
  scopeKind: 'school',
  role: 'student',
  label: '',
  rationale: '',
  periodStart: '',
  periodEnd: '',
  targetValue: '',
  direction: 'at-least',
  minimumCohort: '5',
};

const shortDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—';

const percent = (value) =>
  value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;

const StatusChip = ({ status }) => (
  <span
    className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
      STATUS_STYLES[status] || 'bg-gray-200 text-gray-700'
    }`}
  >
    {STATUS_LABELS[status] || status}
  </span>
);

/**
 * The bar that carries the whole judgement.
 *
 * Two marks, not one: how far the number has got, and where it should have got
 * to by today. The gap between them is the thing worth seeing, and it is
 * invisible on a bar that only draws attainment.
 */
const PaceBar = ({ result, direction }) => {
  if (result.suppressed) return null;

  const attained = Math.min(Math.max(result.attainment || 0, 0), 1.5);
  const width = `${Math.min(attained * 100, 100)}%`;
  const marker = result.pace ? `${Math.min(result.pace.elapsedFraction * 100, 100)}%` : null;

  const tone = result.met
    ? 'bg-green-500'
    : result.pace && !result.pace.onTrack
      ? 'bg-amber-500'
      : 'bg-blue-500';

  return (
    <div className="mt-2">
      <div className="relative h-2 rounded-full bg-gray-200 overflow-visible">
        <div className={`h-2 rounded-full ${tone}`} style={{ width }} />
        {marker && (
          <div
            className="absolute top-[-3px] h-4 w-0.5 bg-gray-700"
            style={{ left: marker }}
            title="Where this should have reached by today"
          />
        )}
      </div>
      <p className="text-xs text-gray-500 mt-1">
        {percent(result.attainment)} of target
        {result.pace && (
          <>
            {' · '}
            {Math.round(result.pace.elapsedFraction * 100)}% through the period
            {' · '}
            <span className={result.pace.onTrack ? 'text-green-700' : 'text-amber-700 font-medium'}>
              {result.pace.onTrack ? 'on track' : 'behind pace'}
            </span>
          </>
        )}
        {direction === 'at-most' && ' · lower is better'}
      </p>
    </div>
  );
};

const KpiTargetPanel = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';

  const [meta, setMeta] = useState(null);
  const [scoreboard, setScoreboard] = useState(null);
  const [targets, setTargets] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 3500);
  };

  const explain = (err, fallback) =>
    setError(err?.response?.data?.message || err?.message || fallback);

  const loadMeta = useCallback(async () => {
    try {
      const res = await api.get('/analytics/targets/meta');
      setMeta(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load the target options.');
    }
  }, []);

  const loadScoreboard = useCallback(async () => {
    try {
      const res = await api.get('/analytics/targets/scoreboard');
      setScoreboard(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load the scoreboard.');
    }
  }, []);

  const loadTargets = useCallback(async () => {
    try {
      const query = statusFilter ? `?status=${statusFilter}` : '';
      const res = await api.get(`/analytics/targets${query}`);
      setTargets(res.data.data || []);
    } catch (err) {
      explain(err, 'Could not load the targets.');
    }
  }, [statusFilter]);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadMeta(), loadScoreboard()]).finally(() => setLoading(false));
  }, [loadMeta, loadScoreboard]);

  useEffect(() => {
    loadTargets();
  }, [loadTargets]);

  const refreshAll = async () => {
    await Promise.all([loadScoreboard(), loadTargets()]);
  };

  const createTarget = async (event) => {
    event.preventDefault();
    setBusyId('new');
    setError('');

    try {
      await api.post('/analytics/targets', {
        ...form,
        targetValue: Number(form.targetValue),
        minimumCohort: Number(form.minimumCohort),
        activate: true,
      });

      flash('Target set.');
      setForm(EMPTY_FORM);
      setShowForm(false);
      await refreshAll();
    } catch (err) {
      explain(err, 'Could not set that target.');
    } finally {
      setBusyId('');
    }
  };

  const certify = async (target) => {
    const note = window.prompt(
      `Certifying "${target.label}" freezes its result permanently. ` +
        'A corrected figure would have to be a new target that supersedes this one.\n\n' +
        'Anything to note about the variance?',
      ''
    );
    if (note === null) return;

    setBusyId(target._id);
    setError('');
    try {
      await api.patch(`/analytics/targets/${target._id}/certify`, { note });
      flash('Result certified and frozen.');
      await refreshAll();
    } catch (err) {
      explain(err, 'Could not certify that target.');
    } finally {
      setBusyId('');
    }
  };

  const abandon = async (target) => {
    const reason = window.prompt(`Why is "${target.label}" being abandoned?`);
    if (!reason) return;

    setBusyId(target._id);
    setError('');
    try {
      await api.patch(`/analytics/targets/${target._id}/abandon`, { reason });
      flash('Target abandoned.');
      await refreshAll();
    } catch (err) {
      explain(err, 'Could not abandon that target.');
    } finally {
      setBusyId('');
    }
  };

  const metricLabel = useMemo(() => {
    const map = {};
    (meta?.metrics || []).forEach((metric) => {
      map[metric.key] = metric.label;
    });
    return map;
  }, [meta]);

  const describeScope = (target) =>
    target.scope?.kind === 'role' ? `${target.scope.role}s` : 'school-wide';

  const renderTarget = (target) => {
    const { result } = target;

    return (
      <li key={target._id} className="border border-gray-200 rounded-xl p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <p className="font-medium text-gray-900">{target.label}</p>
            <p className="text-xs text-gray-600 mt-0.5">
              {metricLabel[target.metric] || target.metric} · {describeScope(target)} ·{' '}
              {DIRECTION_LABELS[target.direction]} {target.targetValue.toLocaleString('en-IN')}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              {shortDate(target.periodStart)} — {shortDate(target.periodEnd)}
            </p>
          </div>

          <div className="text-right shrink-0">
            <StatusChip status={target.status} />
            <p className="text-lg font-semibold text-gray-900 mt-1">
              {result.suppressed ? '—' : (result.actual ?? 0).toLocaleString('en-IN')}
            </p>
            <p className="text-[11px] text-gray-500 flex items-center gap-1 justify-end">
              {result.sourced === 'certified' ? (
                <>
                  <Lock size={10} /> certified
                </>
              ) : (
                <>
                  <TrendingUp size={10} /> live count
                </>
              )}
            </p>
          </div>
        </div>

        {result.suppressed ? (
          <p className="mt-2 text-xs text-gray-600 flex items-start gap-1">
            <EyeOff size={12} className="mt-0.5 shrink-0" />
            {result.suppressionReason}
          </p>
        ) : (
          <PaceBar result={result} direction={target.direction} />
        )}

        {target.rationale && (
          <p className="mt-2 text-xs text-gray-600 italic">“{target.rationale}”</p>
        )}

        {target.varianceNote && (
          <p className="mt-2 text-xs text-gray-700">
            <span className="font-medium">On certification:</span> {target.varianceNote}
          </p>
        )}

        {target.abandonReason && (
          <p className="mt-2 text-xs text-gray-600">
            <span className="font-medium">Abandoned:</span> {target.abandonReason}
          </p>
        )}

        {isAdmin && target.status === 'live' && (
          <div className="mt-3 flex flex-wrap gap-2">
            {result.awaitingCertification && (
              <button
                type="button"
                onClick={() => certify(target)}
                disabled={busyId === target._id}
                className="text-xs px-2 py-1 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
              >
                Certify the result
              </button>
            )}

            <button
              type="button"
              onClick={() => abandon(target)}
              disabled={busyId === target._id}
              className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Abandon
            </button>
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="mt-8 bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
      <header className="flex items-start justify-between gap-4 flex-wrap mb-5">
        <div>
          <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
            <Target size={20} className="text-blue-600" />
            Targets
          </h2>
          <p className="text-sm text-gray-600 mt-1 max-w-2xl">
            The charts above say what happened. A target says what was expected, written down
            before the period began. Once a period closes its result is frozen onto the record, so
            the judgement survives the event log being trimmed.
          </p>
        </div>

        {isAdmin && (
          <button
            type="button"
            onClick={() => setShowForm((open) => !open)}
            className="px-3 py-2 rounded-md border border-gray-300 text-sm font-medium hover:bg-gray-50 transition"
          >
            {showForm ? 'Close' : 'Set a target'}
          </button>
        )}
      </header>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="mb-4 flex items-start gap-2 rounded-md bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-800">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      {loading && <p className="text-sm text-gray-500">Loading…</p>}

      {/* --- counts ------------------------------------------------------ */}
      {scoreboard && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          <div className="rounded-xl bg-blue-50 border border-blue-200 px-4 py-3">
            <p className="text-xs text-blue-800">Live targets</p>
            <p className="text-2xl font-semibold text-blue-900">{scoreboard.counts.live}</p>
          </div>
          <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
            <p className="text-xs text-amber-800">Behind pace</p>
            <p className="text-2xl font-semibold text-amber-900">{scoreboard.counts.behind}</p>
          </div>
          <div className="rounded-xl bg-gray-50 border border-gray-200 px-4 py-3">
            <p className="text-xs text-gray-700">Period ended, not yet certified</p>
            <p className="text-2xl font-semibold text-gray-900">
              {scoreboard.counts.awaitingCertification}
            </p>
          </div>
        </div>
      )}

      {/* --- the form ---------------------------------------------------- */}
      {isAdmin && showForm && (
        <form
          onSubmit={createTarget}
          className="mb-6 rounded-xl border border-gray-200 bg-gray-50 p-4 grid gap-3 md:grid-cols-2"
        >
          <label className="text-sm md:col-span-2">
            <span className="block text-gray-700 mb-1">What is this target called?</span>
            <input
              required
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder="Student logins, Michaelmas term"
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Metric</span>
            <select
              value={form.metric}
              onChange={(e) => setForm({ ...form, metric: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            >
              {(meta?.metrics || []).map((metric) => (
                <option key={metric.key} value={metric.key}>
                  {metric.label}
                  {metric.distinct ? ' (distinct people)' : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Scope</span>
            <select
              value={form.scopeKind}
              onChange={(e) => setForm({ ...form, scopeKind: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            >
              <option value="school">School-wide</option>
              <option value="role">One role</option>
            </select>
          </label>

          {form.scopeKind === 'role' && (
            <label className="text-sm">
              <span className="block text-gray-700 mb-1">Role</span>
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                className="w-full rounded border border-gray-300 px-3 py-2"
              >
                {(meta?.roles || []).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Direction</span>
            <select
              value={form.direction}
              onChange={(e) => setForm({ ...form, direction: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            >
              <option value="at-least">At least — more is better</option>
              <option value="at-most">At most — less is better</option>
            </select>
          </label>

          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Target value</span>
            <input
              required
              type="number"
              min="0"
              value={form.targetValue}
              onChange={(e) => setForm({ ...form, targetValue: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Suppress below this many people</span>
            <input
              type="number"
              min="0"
              value={form.minimumCohort}
              onChange={(e) => setForm({ ...form, minimumCohort: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Period starts</span>
            <input
              required
              type="date"
              value={form.periodStart}
              onChange={(e) => setForm({ ...form, periodStart: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Period ends</span>
            <input
              required
              type="date"
              value={form.periodEnd}
              onChange={(e) => setForm({ ...form, periodEnd: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="text-sm md:col-span-2">
            <span className="block text-gray-700 mb-1">
              Why this number? <span className="text-gray-500">(read back at review)</span>
            </span>
            <textarea
              rows={2}
              value={form.rationale}
              onChange={(e) => setForm({ ...form, rationale: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={busyId === 'new'}
              className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition disabled:opacity-60"
            >
              Set the target
            </button>
            <p className="text-xs text-gray-500 mt-2">
              A period that has already ended will be refused — a target written once the result is
              known is a description, not an expectation. Once live, the value and the window
              cannot be edited.
            </p>
          </div>
        </form>
      )}

      {/* --- needs attention --------------------------------------------- */}
      {scoreboard && scoreboard.needsAttention.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-800 mb-2">Needs attention</h3>
          <ul className="space-y-3">{scoreboard.needsAttention.map(renderTarget)}</ul>
        </div>
      )}

      {/* --- everything --------------------------------------------------- */}
      <div>
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <h3 className="text-sm font-semibold text-gray-800">All targets</h3>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1 text-sm"
          >
            <option value="">All statuses</option>
            {(meta?.statuses || []).map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status] || status}
              </option>
            ))}
          </select>
        </div>

        {targets.length === 0 ? (
          <p className="text-sm text-gray-500">
            No targets yet. Until one is set, every figure above is being read against a remembered
            number.
          </p>
        ) : (
          <ul className="space-y-3">{targets.map(renderTarget)}</ul>
        )}
      </div>
    </section>
  );
};

export default KpiTargetPanel;
