import { useState, useEffect, useCallback, useMemo, useContext } from 'react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';

/**
 * Conduct ledger — recording, the class view, and appeals.
 *
 * The form pulls its points band from the server catalogue rather than
 * hard-coding one, so the bound a teacher sees is the same bound the server
 * enforces. If the school retunes the catalogue, this form follows without a
 * frontend change.
 */

const TIER_STYLES = {
  none: 'bg-green-100 text-green-700',
  'verbal-warning': 'bg-yellow-100 text-yellow-800',
  'parent-informed': 'bg-orange-100 text-orange-800',
  'counselling-referral': 'bg-red-100 text-red-700',
  'disciplinary-review': 'bg-red-200 text-red-900',
};

const STATUS_STYLES = {
  active: 'bg-blue-100 text-blue-700',
  appealed: 'bg-amber-100 text-amber-800',
  upheld: 'bg-slate-200 text-slate-700',
  overturned: 'bg-gray-200 text-gray-500 line-through',
  expunged: 'bg-gray-200 text-gray-400 line-through',
};

const emptyForm = {
  student: '',
  studentName: '',
  className: '',
  type: 'demerit',
  category: 'late-arrival',
  points: 1,
  description: '',
  occurredOn: new Date().toISOString().split('T')[0],
  location: '',
};

const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '';

const ConductPanel = () => {
  const { user } = useContext(AuthContext);
  const isAdmin = (user?.role || user?.user?.role) === 'admin';

  const [catalogue, setCatalogue] = useState([]);
  const [meta, setMeta] = useState(null);
  const [stats, setStats] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [classQuery, setClassQuery] = useState('');
  const [classLedger, setClassLedger] = useState([]);
  const [appeals, setAppeals] = useState([]);
  const [tab, setTab] = useState('record');
  const [expanded, setExpanded] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 5000);
  };

  const loadCatalogue = useCallback(async () => {
    try {
      const res = await api.get('/conduct/catalogue');
      setCatalogue(res.data.data || []);
      setMeta({
        tiers: res.data.tiers,
        appealWindowDays: res.data.appealWindowDays,
        rollingWindowDays: res.data.rollingWindowDays,
      });
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the conduct catalogue.');
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const res = await api.get('/conduct/stats');
      setStats(res.data.stats);
    } catch (err) {
      console.error(err);
    }
  }, []);

  const loadAppeals = useCallback(async () => {
    try {
      const res = await api.get('/conduct/appeals');
      setAppeals(res.data.data || []);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    loadCatalogue();
    loadStats();
    loadAppeals();
  }, [loadCatalogue, loadStats, loadAppeals]);

  // The band for the currently selected category, straight from the server.
  const band = useMemo(
    () => catalogue.find((entry) => entry.value === form.category) || null,
    [catalogue, form.category]
  );

  const categoriesForType = useMemo(
    () => catalogue.filter((entry) => entry.type === form.type),
    [catalogue, form.type]
  );

  // Switching merit/demerit must also move the category, or the form would sit
  // in a state the server is guaranteed to reject.
  const switchType = (type) => {
    const first = catalogue.find((entry) => entry.type === type);
    setForm({
      ...form,
      type,
      category: first ? first.value : '',
      points: first ? first.min : 1,
    });
  };

  const switchCategory = (category) => {
    const next = catalogue.find((entry) => entry.value === category);
    setForm({ ...form, category, points: next ? next.min : form.points });
  };

  const record = async (event) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.post('/conduct', { ...form, points: Number(form.points) });
      const tier = res.data.intervention?.tier;
      flash(
        tier && tier !== 'none'
          ? `${res.data.message} This student is now at "${res.data.intervention.label}" — ${res.data.intervention.reasons.join('; ')}.`
          : res.data.message
      );
      setForm({ ...emptyForm, className: form.className, type: form.type, category: form.category, points: band ? band.min : 1 });
      await Promise.all([loadStats(), classQuery ? loadClass() : Promise.resolve()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not record that entry.');
    } finally {
      setBusy(false);
    }
  };

  const loadClass = async () => {
    if (!classQuery.trim()) return;
    setError('');
    try {
      const res = await api.get(`/conduct/class/${encodeURIComponent(classQuery.trim())}`);
      setClassLedger(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load that class.');
    }
  };

  const decide = async (entry, decision) => {
    const note = window.prompt(
      decision === 'overturned'
        ? 'Why is this entry being overturned? The student will see this.'
        : 'Why does this entry stand? The student will see this.'
    );
    if (note === null) return;

    setBusy(true);
    setError('');
    try {
      const res = await api.patch(`/conduct/${entry._id}/appeal`, { decision, note });
      flash(res.data.message);
      await Promise.all([loadAppeals(), loadStats()]);
    } catch (err) {
      // A 403 here is the self-review guard doing its job.
      setError(err.response?.data?.message || 'Could not decide that appeal.');
    } finally {
      setBusy(false);
    }
  };

  const expunge = async (entry) => {
    const reason = window.prompt('Why is this entry being expunged?');
    if (!reason) return;
    setBusy(true);
    try {
      await api.patch(`/conduct/${entry._id}/expunge`, { reason });
      flash('Entry expunged. It stays on file but no longer counts or appears.');
      await Promise.all([loadStats(), classQuery ? loadClass() : Promise.resolve()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not expunge that entry.');
    } finally {
      setBusy(false);
    }
  };

  const notify = async (entry) => {
    setBusy(true);
    try {
      await api.patch(`/conduct/${entry._id}/notified`);
      flash('Recorded as notified.');
      if (classQuery) await loadClass();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not record that.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Entries', value: stats.total },
            { label: 'Merit share', value: stats.meritShare === null ? '—' : `${stats.meritShare}%` },
            { label: 'Open appeals', value: stats.openAppeals },
            { label: 'Need attention', value: stats.studentsAtOrAboveWarning },
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

      <div className="flex gap-2 bg-white rounded-xl p-1 shadow">
        {[
          { id: 'record', label: 'Record' },
          { id: 'class', label: 'Class ledger' },
          { id: 'appeals', label: `Appeals (${appeals.length})` },
        ].map((entry) => (
          <button
            key={entry.id}
            onClick={() => setTab(entry.id)}
            className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition ${
              tab === entry.id
                ? 'bg-purple-600 text-white shadow'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'record' && (
        <div className="bg-white rounded-2xl shadow p-6">
          <h3 className="text-xl font-bold text-gray-800 mb-1">⚖️ Record conduct</h3>
          <p className="text-sm text-gray-500 mb-4">
            Points come from the school catalogue, not from you — so a balance
            computed across teachers means something.
          </p>

          <form onSubmit={record} className="space-y-3">
            <div className="flex gap-2">
              {[
                { value: 'merit', label: 'Merit' },
                { value: 'demerit', label: 'Demerit' },
              ].map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  onClick={() => switchType(entry.value)}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition border ${
                    form.type === entry.value
                      ? entry.value === 'merit'
                        ? 'bg-green-50 border-green-400 text-green-700'
                        : 'bg-red-50 border-red-400 text-red-700'
                      : 'border-gray-300 text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  {entry.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <input
                type="text"
                required
                placeholder="Student id *"
                value={form.student}
                onChange={(e) => setForm({ ...form, student: e.target.value })}
                className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
              <input
                type="text"
                required
                placeholder="Student name *"
                value={form.studentName}
                onChange={(e) => setForm({ ...form, studentName: e.target.value })}
                className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
              <input
                type="text"
                placeholder="Class (e.g. 10A)"
                value={form.className}
                onChange={(e) => setForm({ ...form, className: e.target.value })}
                className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <select
                value={form.category}
                onChange={(e) => switchCategory(e.target.value)}
                className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              >
                {categoriesForType.map((entry) => (
                  <option key={entry.value} value={entry.value}>{entry.label}</option>
                ))}
              </select>

              <label className="text-xs text-gray-500">
                Points {band ? `(${band.min}–${band.max})` : ''}
                <input
                  type="number"
                  required
                  min={band ? band.min : 1}
                  max={band ? band.max : 15}
                  value={form.points}
                  onChange={(e) => setForm({ ...form, points: e.target.value })}
                  className="mt-1 w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </label>
            </div>

            {band && band.expiresAfterDays && (
              <p className="text-xs text-gray-400">
                This demerit stops counting after {band.expiresAfterDays} days.
                It stays on the record.
              </p>
            )}
            {band && band.type === 'merit' && (
              <p className="text-xs text-gray-400">Merits do not expire.</p>
            )}

            <textarea
              required
              rows={3}
              placeholder="What happened? *"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                type="date"
                required
                value={form.occurredOn}
                onChange={(e) => setForm({ ...form, occurredOn: e.target.value })}
                className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
              <input
                type="text"
                placeholder="Where"
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>

            <p className="text-xs text-gray-400 bg-gray-50 rounded-lg px-3 py-2">
              Entries cannot be edited afterwards. A student may appeal within{' '}
              {meta?.appealWindowDays ?? 14} days, and an entry made in error is
              overturned or expunged — the original stays visible either way.
            </p>

            <button
              type="submit"
              disabled={busy}
              className="bg-purple-600 hover:bg-purple-700 text-white px-5 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
            >
              {busy ? 'Recording...' : 'Record entry'}
            </button>
          </form>
        </div>
      )}

      {tab === 'class' && (
        <div className="bg-white rounded-2xl shadow p-6">
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              placeholder="Class name (e.g. 10A)"
              value={classQuery}
              onChange={(e) => setClassQuery(e.target.value)}
              className="flex-1 border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
            <button
              onClick={loadClass}
              className="bg-purple-600 hover:bg-purple-700 text-white px-5 py-2 rounded-lg text-sm transition"
            >
              Load
            </button>
          </div>

          {classLedger.length === 0 && (
            <p className="text-gray-400 text-sm text-center py-6">
              Enter a class name to see its ledger, sorted with whoever most
              needs attention first.
            </p>
          )}

          <div className="space-y-3">
            {classLedger.map((record) => {
              const isOpen = expanded === record.student;
              return (
                <div key={record.student} className="border border-gray-200 rounded-xl overflow-hidden">
                  <button
                    onClick={() => setExpanded(isOpen ? null : record.student)}
                    className="w-full text-left px-4 py-3 hover:bg-gray-50 transition"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-semibold text-gray-800 text-sm">
                          {record.studentName}
                        </p>
                        <p className="text-xs text-gray-400">
                          {record.balance.merit} merit &middot; {record.balance.demerit} demerit
                          {record.balance.expiredEntries > 0
                            ? ` · ${record.balance.expiredEntries} aged out`
                            : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-sm font-bold ${
                            record.balance.net < 0 ? 'text-red-600' : 'text-green-600'
                          }`}
                        >
                          {record.balance.net > 0 ? '+' : ''}{record.balance.net}
                        </span>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            TIER_STYLES[record.intervention.tier]
                          }`}
                        >
                          {record.intervention.label}
                        </span>
                      </div>
                    </div>
                  </button>

                  {isOpen && (
                    <div className="border-t border-gray-200 px-4 py-3 bg-gray-50 space-y-3">
                      {record.intervention.reasons.length > 0 && (
                        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                          <p className="text-xs text-amber-800">
                            Threshold reached: {record.intervention.reasons.join('; ')}.
                          </p>
                        </div>
                      )}

                      {record.entries.map((entry) => (
                        <div key={entry._id} className="bg-white rounded-lg p-3">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-mono text-xs text-gray-400">
                                  {entry.entryId}
                                </span>
                                <span
                                  className={`text-xs px-2 py-0.5 rounded-full ${
                                    STATUS_STYLES[entry.status]
                                  }`}
                                >
                                  {entry.status}
                                </span>
                                {entry.isExpired && entry.status !== 'overturned' && (
                                  <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
                                    aged out
                                  </span>
                                )}
                              </div>
                              <p className="text-sm font-semibold text-gray-800 mt-0.5">
                                {entry.categoryLabel}
                                <span
                                  className={
                                    entry.type === 'merit'
                                      ? 'text-green-600 ml-2'
                                      : 'text-red-600 ml-2'
                                  }
                                >
                                  {entry.type === 'merit' ? '+' : '−'}{entry.points}
                                </span>
                              </p>
                              <p className="text-sm text-gray-600">{entry.description}</p>
                              <p className="text-xs text-gray-400 mt-1">
                                {formatDate(entry.occurredOn)} &middot; {entry.recordedByName}
                                {entry.location ? ` · ${entry.location}` : ''}
                              </p>
                              {entry.appeal?.decisionNote && (
                                <p className="text-xs text-gray-500 mt-1">
                                  Appeal {entry.appeal.decision}: {entry.appeal.decisionNote}
                                </p>
                              )}
                            </div>
                          </div>

                          <div className="flex flex-wrap gap-2 mt-2">
                            {entry.type === 'demerit' && !entry.parentNotified && (
                              <button
                                onClick={() => notify(entry)}
                                disabled={busy}
                                className="text-xs bg-blue-100 text-blue-700 hover:bg-blue-200 px-3 py-1 rounded-full transition"
                              >
                                Mark family notified
                              </button>
                            )}
                            {entry.parentNotified && (
                              <span className="text-xs text-gray-400 px-1 py-1">
                                Family notified {formatDate(entry.parentNotifiedAt)}
                              </span>
                            )}
                            {isAdmin && entry.status !== 'expunged' && (
                              <button
                                onClick={() => expunge(entry)}
                                disabled={busy}
                                className="text-xs border border-red-200 text-red-600 hover:bg-red-50 px-3 py-1 rounded-full transition"
                              >
                                Expunge
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'appeals' && (
        <div className="bg-white rounded-2xl shadow p-6">
          <h3 className="text-xl font-bold text-gray-800 mb-4">Open appeals</h3>

          {appeals.length === 0 && (
            <p className="text-gray-400 text-sm text-center py-6">Nothing waiting.</p>
          )}

          <div className="space-y-3">
            {appeals.map((entry) => (
              <div key={entry._id} className="border border-gray-200 rounded-xl p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-mono text-xs text-gray-400">{entry.entryId}</span>
                    <p className="font-semibold text-gray-800 text-sm mt-0.5">
                      {entry.studentName}
                      {entry.className ? ` (${entry.className})` : ''} — {entry.categoryLabel},{' '}
                      {entry.points} points
                    </p>
                    <p className="text-sm text-gray-600 mt-1">{entry.description}</p>
                    <p className="text-xs text-gray-400">
                      Recorded by {entry.recordedByName} on {formatDate(entry.occurredOn)}
                    </p>
                  </div>
                </div>

                <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-3">
                  <p className="text-xs text-amber-700 font-semibold mb-1">
                    The student says
                  </p>
                  <p className="text-sm text-amber-900">{entry.appeal?.statement}</p>
                </div>

                {entry.canDecide ? (
                  <div className="flex flex-wrap gap-2 mt-3">
                    <button
                      onClick={() => decide(entry, 'overturned')}
                      disabled={busy}
                      className="text-xs bg-green-100 text-green-700 hover:bg-green-200 px-3 py-1 rounded-full transition"
                    >
                      Allow the appeal
                    </button>
                    <button
                      onClick={() => decide(entry, 'upheld')}
                      disabled={busy}
                      className="text-xs bg-slate-200 text-slate-700 hover:bg-slate-300 px-3 py-1 rounded-full transition"
                    >
                      Entry stands
                    </button>
                  </div>
                ) : (
                  <p className="text-xs text-gray-400 mt-3">
                    You recorded this entry, so somebody else has to decide the
                    appeal against it.
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ConductPanel;
