import { useState, useEffect, useContext, useCallback, useMemo } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * Physical asset register.
 *
 * For a member of staff the page is one question — what am I holding, and is
 * any of it late. That is the whole of their relationship with the register,
 * and anything more is a reason not to open it.
 *
 * For an admin it leads with the two lists that do not exist today: what is
 * overdue, and what is broken. The register itself is third, because a table
 * of four hundred rows is a thing you search rather than a thing you read.
 *
 * Book value sits beside purchase cost everywhere it appears. The gap between
 * the two is the number the insurance schedule gets wrong, and showing them
 * apart is how it stays wrong.
 */

const CATEGORY_LABELS = {
  'it-equipment': 'IT equipment',
  'lab-equipment': 'Lab equipment',
  furniture: 'Furniture',
  sports: 'Sports',
  music: 'Music',
  library: 'Library',
  av: 'AV',
  kitchen: 'Kitchen',
  maintenance: 'Maintenance',
  vehicle: 'Vehicle',
  other: 'Other',
};

const STATUS_LABELS = {
  'in-store': 'In store',
  assigned: 'Out',
  'in-maintenance': 'In maintenance',
  retired: 'Retired',
  lost: 'Lost',
  'written-off': 'Written off',
};

const STATUS_STYLES = {
  'in-store': 'bg-gray-100 text-gray-700',
  assigned: 'bg-blue-100 text-blue-700',
  'in-maintenance': 'bg-amber-100 text-amber-800',
  retired: 'bg-slate-200 text-slate-600',
  lost: 'bg-red-100 text-red-700',
  'written-off': 'bg-red-50 text-red-600',
};

const CONDITION_LABELS = {
  new: 'New',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  unserviceable: 'Unserviceable',
};

const SEVERITY_STYLES = {
  critical: 'bg-red-100 text-red-700',
  major: 'bg-orange-100 text-orange-800',
  moderate: 'bg-amber-100 text-amber-800',
  minor: 'bg-gray-100 text-gray-600',
};

const FAULT_STATUS_LABELS = {
  reported: 'Reported',
  triaged: 'Triaged',
  'with-vendor': 'With vendor',
  resolved: 'Resolved',
  unrepairable: 'Unrepairable',
};

const money = (value) =>
  value === null || value === undefined
    ? '—'
    : `₹${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const shortDate = (value) => (value ? new Date(value).toLocaleDateString() : '—');

const StatusChip = ({ status }) => (
  <span
    className={`px-2 py-0.5 rounded text-xs font-medium ${
      STATUS_STYLES[status] || 'bg-gray-100 text-gray-700'
    }`}
  >
    {STATUS_LABELS[status] || status}
  </span>
);

/** "11 days overdue" gets acted on. A due date does not. */
const OverdueChip = ({ days }) => {
  if (!days) return null;
  return (
    <span className="px-2 py-0.5 rounded text-xs font-semibold bg-red-100 text-red-700">
      {days} {days === 1 ? 'day' : 'days'} overdue
    </span>
  );
};

/**
 * Cost and book value together. Apart, the first one is the number people
 * quote and it has been wrong since 2019.
 */
const ValuePair = ({ cost, bookValue }) => (
  <div className="text-right">
    <div className="text-sm font-semibold text-gray-800">{money(bookValue)}</div>
    <div className="text-xs text-gray-400 line-through">{money(cost)}</div>
  </div>
);

const StatTile = ({ label, value, tone = 'default' }) => {
  const tones = {
    default: 'border-gray-200 bg-white',
    warn: 'border-amber-200 bg-amber-50',
    bad: 'border-red-200 bg-red-50',
  };
  return (
    <div className={`rounded-lg border p-4 ${tones[tone]}`}>
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-800">{value}</div>
    </div>
  );
};

const AssetRegister = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';
  const isStaff = role === 'teacher' || role === 'staff' || role === 'admin';

  const [tab, setTab] = useState('mine');
  const [meta, setMeta] = useState(null);

  const [mine, setMine] = useState([]);
  const [register, setRegister] = useState([]);
  const [overdue, setOverdue] = useState([]);
  const [faults, setFaults] = useState([]);
  const [stats, setStats] = useState(null);
  const [holders, setHolders] = useState([]);
  const [detail, setDetail] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [filters, setFilters] = useState({ search: '', category: '', status: 'active' });

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    assetTag: '',
    name: '',
    category: 'it-equipment',
    serialNumber: '',
    manufacturer: '',
    model: '',
    purchaseDate: '',
    purchaseCost: '',
    usefulLifeYears: '',
    salvageValue: '',
    homeLocation: '',
    condition: 'good',
  });

  const [custodyForm, setCustodyForm] = useState({
    mode: 'issue',
    holderId: '',
    location: '',
    purpose: '',
    dueBack: '',
    conditionOut: 'good',
    conditionIn: 'good',
    note: '',
  });

  const [faultForm, setFaultForm] = useState({ fault: '', severity: 'moderate' });

  const readError = (err, fallback) => err?.response?.data?.message || fallback;

  const clearMessages = () => {
    setError('');
    setNotice('');
  };

  const loadMeta = useCallback(async () => {
    try {
      const { data } = await api.get('/assets/meta');
      setMeta(data.data);
    } catch {
      // The forms fall back to their own labels.
    }
  }, []);

  const loadMine = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/assets/mine');
      setMine(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load your equipment'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRegister = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.search) params.set('search', filters.search);
      if (filters.category) params.set('category', filters.category);
      if (filters.status) params.set('status', filters.status);
      const { data } = await api.get(`/assets?${params.toString()}`);
      setRegister(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the register'));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  const loadOverdue = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/assets/overdue');
      setOverdue(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load overdue equipment'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFaults = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/assets/maintenance');
      setFaults(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the maintenance queue'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const { data } = await api.get('/assets/stats');
      setStats(data.data);
    } catch {
      setStats(null);
    }
  }, []);

  const loadHolders = useCallback(async () => {
    try {
      const { data } = await api.get('/assets/holders');
      setHolders(data.data || []);
    } catch {
      setHolders([]);
    }
  }, []);

  const loadDetail = useCallback(async (assetId) => {
    try {
      const { data } = await api.get(`/assets/${assetId}`);
      setDetail(data.data);
    } catch (err) {
      setError(readError(err, 'Could not load that asset'));
    }
  }, []);

  useEffect(() => {
    loadMeta();
    loadMine();
    if (isAdmin) {
      loadStats();
      loadHolders();
    }
  }, [loadMeta, loadMine, loadStats, loadHolders, isAdmin]);

  useEffect(() => {
    if (tab === 'register' && isAdmin) loadRegister();
    if (tab === 'overdue' && isAdmin) loadOverdue();
    if (tab === 'faults' && isAdmin) loadFaults();
    if (tab === 'mine') loadMine();
  }, [tab, isAdmin, loadRegister, loadOverdue, loadFaults, loadMine]);

  const refreshAll = useCallback(async () => {
    await loadMine();
    if (!isAdmin) return;
    await Promise.all([loadStats(), loadRegister(), loadOverdue(), loadFaults()]);
  }, [isAdmin, loadMine, loadStats, loadRegister, loadOverdue, loadFaults]);

  const overdueMine = useMemo(() => mine.filter((row) => row.daysOverdue > 0), [mine]);

  // -- actions ---------------------------------------------------------------

  const submitCreate = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      const payload = { ...createForm };
      ['purchaseCost', 'usefulLifeYears', 'salvageValue'].forEach((key) => {
        if (payload[key] === '') delete payload[key];
      });
      const { data } = await api.post('/assets', payload);
      setNotice(`${data.data.assetTag} registered`);
      setCreateOpen(false);
      setCreateForm((form) => ({ ...form, assetTag: '', name: '', serialNumber: '' }));
      await refreshAll();
    } catch (err) {
      setError(readError(err, 'Could not register the asset'));
    }
  };

  const submitCustody = async (event) => {
    event.preventDefault();
    if (!detail) return;
    clearMessages();

    const { mode } = custodyForm;
    try {
      const body =
        mode === 'return'
          ? { conditionIn: custodyForm.conditionIn, note: custodyForm.note }
          : {
              holderId: custodyForm.holderId,
              location: custodyForm.location,
              purpose: custodyForm.purpose,
              dueBack: custodyForm.dueBack || undefined,
              conditionOut: custodyForm.conditionOut,
              conditionIn: custodyForm.conditionIn,
              note: custodyForm.note,
            };

      const { data } = await api.post(`/assets/${detail._id}/${mode}`, body);
      setDetail(data.data);
      setNotice(data.message || 'Done');
      setCustodyForm((form) => ({ ...form, note: '', purpose: '' }));
      await refreshAll();
    } catch (err) {
      // The single-custody refusal arrives here, and it names the current
      // holder. Showing it verbatim is the point.
      setError(readError(err, 'Could not update custody'));
    }
  };

  const submitFault = async (event) => {
    event.preventDefault();
    if (!detail) return;
    clearMessages();
    try {
      const { data } = await api.post(`/assets/${detail._id}/maintenance`, faultForm);
      setDetail(data.data);
      setNotice(data.message || 'Fault recorded');
      setFaultForm({ fault: '', severity: 'moderate' });
      await refreshAll();
    } catch (err) {
      setError(readError(err, 'Could not record the fault'));
    }
  };

  const resolveFault = async (assetId, faultId, status) => {
    const resolution = window.prompt(
      status === 'resolved' ? 'What was done?' : 'Why is it unrepairable?'
    );
    if (!resolution) return;
    clearMessages();
    try {
      await api.patch(`/assets/${assetId}/maintenance/${faultId}`, { status, resolution });
      setNotice('Fault closed');
      await refreshAll();
      if (detail && detail._id === assetId) await loadDetail(assetId);
    } catch (err) {
      setError(readError(err, 'Could not close the fault'));
    }
  };

  // -- render helpers --------------------------------------------------------

  const categories = meta?.categories || Object.keys(CATEGORY_LABELS);
  const conditions = meta?.conditions || Object.keys(CONDITION_LABELS);
  const severities = meta?.faultSeverities || ['minor', 'moderate', 'major', 'critical'];

  const tabs = isAdmin
    ? [
        { key: 'mine', label: 'My equipment' },
        { key: 'overdue', label: `Overdue${overdue.length ? ` (${overdue.length})` : ''}` },
        { key: 'faults', label: `Maintenance${faults.length ? ` (${faults.length})` : ''}` },
        { key: 'register', label: 'Register' },
      ]
    : [{ key: 'mine', label: 'My equipment' }];

  if (!isStaff) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-semibold text-gray-800">Asset register</h1>
        <p className="mt-3 text-gray-600">
          The equipment register is for staff. If you have been given a school device, it is
          recorded against the member of staff responsible for it.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">Asset register</h1>
          <p className="mt-1 text-sm text-gray-600 max-w-2xl">
            Every item is in exactly one person&apos;s hands at a time, and the register knows
            whose. Book value is worked out from the purchase date on every read, so the figure
            beside each asset is today&apos;s rather than August&apos;s.
          </p>
        </div>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setCreateOpen((open) => !open)}
            className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition"
          >
            {createOpen ? 'Close' : 'Register an asset'}
          </button>
        )}
      </header>

      {isAdmin && stats && (
        <div className="mt-6 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatTile label="Assets" value={stats.total} />
          <StatTile label="Out" value={stats.out} />
          <StatTile label="Overdue" value={stats.overdue} tone={stats.overdue ? 'bad' : 'default'} />
          <StatTile
            label="Open faults"
            value={stats.openFaults}
            tone={stats.openFaults ? 'warn' : 'default'}
          />
          <StatTile label="Book value" value={money(stats.totalBookValue)} />
          <StatTile label="Depreciated" value={money(stats.totalDepreciated)} />
        </div>
      )}

      {(error || notice) && (
        <div
          className={`mt-4 rounded-md px-4 py-3 text-sm ${
            error ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-green-50 text-green-700 border border-green-200'
          }`}
        >
          {error || notice}
        </div>
      )}

      {createOpen && isAdmin && (
        <form
          onSubmit={submitCreate}
          className="mt-6 rounded-lg border border-gray-200 bg-white p-5 grid grid-cols-1 md:grid-cols-3 gap-4"
        >
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Asset tag</span>
            <input
              required
              value={createForm.assetTag}
              onChange={(e) => setCreateForm({ ...createForm, assetTag: e.target.value })}
              placeholder="IT/LAP/0041"
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>
          <label className="text-sm md:col-span-2">
            <span className="block text-gray-600 mb-1">Name</span>
            <input
              required
              value={createForm.name}
              onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
              placeholder="Dell Latitude 5420"
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Category</span>
            <select
              value={createForm.category}
              onChange={(e) => setCreateForm({ ...createForm, category: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            >
              {categories.map((key) => (
                <option key={key} value={key}>
                  {CATEGORY_LABELS[key] || key}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Serial number</span>
            <input
              value={createForm.serialNumber}
              onChange={(e) => setCreateForm({ ...createForm, serialNumber: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Home location</span>
            <input
              value={createForm.homeLocation}
              onChange={(e) => setCreateForm({ ...createForm, homeLocation: e.target.value })}
              placeholder="IT store"
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Purchase date</span>
            <input
              required
              type="date"
              value={createForm.purchaseDate}
              onChange={(e) => setCreateForm({ ...createForm, purchaseDate: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Purchase cost</span>
            <input
              required
              type="number"
              min="0"
              value={createForm.purchaseCost}
              onChange={(e) => setCreateForm({ ...createForm, purchaseCost: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">
              Useful life (years)
              <span className="text-gray-400"> — left blank uses the category default</span>
            </span>
            <input
              type="number"
              min="1"
              max="50"
              value={createForm.usefulLifeYears}
              onChange={(e) => setCreateForm({ ...createForm, usefulLifeYears: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>
          <div className="md:col-span-3 flex justify-end">
            <button
              type="submit"
              className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition"
            >
              Register
            </button>
          </div>
        </form>
      )}

      <nav className="mt-8 flex flex-wrap gap-2 border-b border-gray-200">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => {
              setTab(entry.key);
              clearMessages();
            }}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
              tab === entry.key
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {loading && <p className="mt-6 text-sm text-gray-500">Loading…</p>}

      {tab === 'mine' && (
        <section className="mt-6">
          {overdueMine.length > 0 && (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {overdueMine.length === 1
                ? 'One item you are holding is past its due-back date.'
                : `${overdueMine.length} items you are holding are past their due-back date.`}
            </div>
          )}

          {mine.length === 0 && !loading ? (
            <p className="text-sm text-gray-500">
              You are not currently holding any school equipment.
            </p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {mine.map((row) => (
                <article
                  key={row._id}
                  className="rounded-lg border border-gray-200 bg-white p-4 flex flex-col gap-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold text-gray-800">{row.name}</h3>
                      <p className="text-xs text-gray-500 font-mono">{row.assetTag}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <StatusChip status={row.status} />
                      <OverdueChip days={row.daysOverdue} />
                    </div>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600">
                    <div>
                      <dt className="text-gray-400">Since</dt>
                      <dd>{shortDate(row.currentHolder?.issuedAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-gray-400">Due back</dt>
                      <dd>{shortDate(row.currentHolder?.dueBack)}</dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-gray-400">Where</dt>
                      <dd>{row.currentHolder?.location || '—'}</dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    onClick={() => {
                      loadDetail(row._id);
                      setFaultForm({ fault: '', severity: 'moderate' });
                    }}
                    className="self-start text-sm text-blue-600 hover:underline"
                  >
                    Open / report a fault
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'overdue' && isAdmin && (
        <section className="mt-6">
          {overdue.length === 0 && !loading ? (
            <p className="text-sm text-gray-500">Nothing is past its due-back date.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Asset</th>
                    <th className="px-4 py-3">Holder</th>
                    <th className="px-4 py-3">Due back</th>
                    <th className="px-4 py-3">Overdue</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {overdue.map((row) => (
                    <tr key={row._id}>
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-800">{row.name}</div>
                        <div className="text-xs font-mono text-gray-500">{row.assetTag}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        {row.currentHolder?.holderName || '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {shortDate(row.currentHolder?.dueBack)}
                      </td>
                      <td className="px-4 py-3">
                        <OverdueChip days={row.daysOverdue} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            loadDetail(row._id);
                            setCustodyForm((form) => ({ ...form, mode: 'return' }));
                          }}
                          className="text-sm text-blue-600 hover:underline"
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === 'faults' && isAdmin && (
        <section className="mt-6 space-y-3">
          {faults.length === 0 && !loading ? (
            <p className="text-sm text-gray-500">No open faults.</p>
          ) : (
            faults.map((row) => (
              <article
                key={`${row.assetId}-${row.faultId}`}
                className="rounded-lg border border-gray-200 bg-white p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-gray-800">{row.assetName}</h3>
                      <span className="text-xs font-mono text-gray-500">{row.assetTag}</span>
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${
                          SEVERITY_STYLES[row.severity] || 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {row.severity}
                      </span>
                      <span className="text-xs text-gray-500">
                        {FAULT_STATUS_LABELS[row.status] || row.status}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-gray-700">{row.fault}</p>
                    {/* The repair count is the retire-it signal, so it sits next
                        to the fault rather than three clicks away. */}
                    <p className="mt-1 text-xs text-gray-500">
                      Repair {row.repairCount} for this asset · {money(row.totalRepairCost)} spent
                      so far · book value {money(row.netBookValue)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => resolveFault(row.assetId, row.faultId, 'resolved')}
                      className="px-3 py-1.5 rounded border border-green-300 text-green-700 text-xs font-medium hover:bg-green-50 transition"
                    >
                      Resolved
                    </button>
                    <button
                      type="button"
                      onClick={() => resolveFault(row.assetId, row.faultId, 'unrepairable')}
                      className="px-3 py-1.5 rounded border border-red-300 text-red-700 text-xs font-medium hover:bg-red-50 transition"
                    >
                      Unrepairable
                    </button>
                  </div>
                </div>
              </article>
            ))
          )}
        </section>
      )}

      {tab === 'register' && isAdmin && (
        <section className="mt-6">
          <div className="flex flex-wrap gap-3 mb-4">
            <input
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              placeholder="Tag, name or serial"
              className="rounded border border-gray-300 px-3 py-2 text-sm"
            />
            <select
              value={filters.category}
              onChange={(e) => setFilters({ ...filters, category: e.target.value })}
              className="rounded border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">All categories</option>
              {categories.map((key) => (
                <option key={key} value={key}>
                  {CATEGORY_LABELS[key] || key}
                </option>
              ))}
            </select>
            <select
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              className="rounded border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="active">In use</option>
              <option value="">Everything</option>
              {Object.keys(STATUS_LABELS).map((key) => (
                <option key={key} value={key}>
                  {STATUS_LABELS[key]}
                </option>
              ))}
            </select>
          </div>

          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-3">Asset</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Held by</th>
                  <th className="px-4 py-3 text-right">Book / cost</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {register.map((row) => (
                  <tr key={row._id}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-800">{row.name}</div>
                      <div className="text-xs font-mono text-gray-500">{row.assetTag}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {CATEGORY_LABELS[row.category] || row.category}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col items-start gap-1">
                        <StatusChip status={row.status} />
                        <OverdueChip days={row.daysOverdue} />
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {row.currentHolder?.holderName || '—'}
                    </td>
                    <td className="px-4 py-3">
                      <ValuePair cost={row.purchaseCost} bookValue={row.netBookValue} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          loadDetail(row._id);
                          setCustodyForm((form) => ({
                            ...form,
                            mode: row.isOut ? 'return' : 'issue',
                          }));
                        }}
                        className="text-sm text-blue-600 hover:underline"
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
                {register.length === 0 && !loading && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-sm text-gray-500">
                      Nothing matches those filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {detail && (
        <section className="mt-8 rounded-lg border border-gray-200 bg-white p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-gray-800">{detail.name}</h2>
              <p className="text-xs font-mono text-gray-500">{detail.assetTag}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <StatusChip status={detail.status} />
                <span className="text-xs text-gray-500">
                  {CONDITION_LABELS[detail.condition] || detail.condition}
                </span>
                <OverdueChip days={detail.daysOverdue} />
              </div>
            </div>
            <div className="flex items-start gap-4">
              <ValuePair cost={detail.purchaseCost} bookValue={detail.netBookValue} />
              <button
                type="button"
                onClick={() => setDetail(null)}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                Close
              </button>
            </div>
          </div>

          <p className="mt-2 text-xs text-gray-500">
            Bought {shortDate(detail.purchaseDate)} · {detail.ageYears} years old ·{' '}
            {detail.usefulLifeYears}-year life · {detail.repairCount} repair
            {detail.repairCount === 1 ? '' : 's'}
          </p>

          <div className="mt-5 grid gap-6 lg:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-gray-700">Custody chain</h3>
              <ol className="mt-2 space-y-2">
                {[...(detail.custody || [])].reverse().map((row) => (
                  <li
                    key={row._id}
                    className={`rounded border px-3 py-2 text-xs ${
                      row.returnedAt ? 'border-gray-200 bg-gray-50' : 'border-blue-200 bg-blue-50'
                    }`}
                  >
                    <div className="flex flex-wrap justify-between gap-2">
                      <span className="font-medium text-gray-800">
                        {row.holderName || row.holder?.name || 'Unknown holder'}
                      </span>
                      <span className="text-gray-500">
                        {shortDate(row.issuedAt)} → {row.returnedAt ? shortDate(row.returnedAt) : 'still out'}
                      </span>
                    </div>
                    {row.location && <div className="text-gray-500">{row.location}</div>}
                    {/* A difference between the two conditions is the only
                        evidence damage happened on somebody's watch. */}
                    {row.conditionIn && row.conditionOut && row.conditionIn !== row.conditionOut && (
                      <div className="mt-1 text-amber-700">
                        Went out {CONDITION_LABELS[row.conditionOut]}, came back{' '}
                        {CONDITION_LABELS[row.conditionIn]}
                      </div>
                    )}
                    {row.note && <div className="mt-1 text-gray-500">{row.note}</div>}
                  </li>
                ))}
                {(detail.custody || []).length === 0 && (
                  <li className="text-xs text-gray-500">Never issued.</li>
                )}
              </ol>
            </div>

            <div className="space-y-6">
              {isAdmin && !detail.disposal && (
                <form onSubmit={submitCustody} className="space-y-3">
                  <h3 className="text-sm font-semibold text-gray-700">Custody</h3>
                  <div className="flex flex-wrap gap-2">
                    {['issue', 'transfer', 'return'].map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setCustodyForm({ ...custodyForm, mode })}
                        className={`px-3 py-1.5 rounded text-xs font-medium border transition ${
                          custodyForm.mode === mode
                            ? 'border-blue-500 bg-blue-50 text-blue-700'
                            : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        {mode[0].toUpperCase() + mode.slice(1)}
                      </button>
                    ))}
                  </div>

                  {custodyForm.mode !== 'return' && (
                    <>
                      <label className="block text-sm">
                        <span className="block text-gray-600 mb-1">Issue to</span>
                        <select
                          required
                          value={custodyForm.holderId}
                          onChange={(e) =>
                            setCustodyForm({ ...custodyForm, holderId: e.target.value })
                          }
                          className="w-full rounded border border-gray-300 px-3 py-2"
                        >
                          <option value="">Choose a member of staff…</option>
                          {holders.map((person) => (
                            <option key={person._id} value={person._id}>
                              {person.name} ({person.role})
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="grid grid-cols-2 gap-3">
                        <label className="block text-sm">
                          <span className="block text-gray-600 mb-1">Where</span>
                          <input
                            value={custodyForm.location}
                            onChange={(e) =>
                              setCustodyForm({ ...custodyForm, location: e.target.value })
                            }
                            className="w-full rounded border border-gray-300 px-3 py-2"
                          />
                        </label>
                        <label className="block text-sm">
                          <span className="block text-gray-600 mb-1">Due back</span>
                          <input
                            type="date"
                            value={custodyForm.dueBack}
                            onChange={(e) =>
                              setCustodyForm({ ...custodyForm, dueBack: e.target.value })
                            }
                            className="w-full rounded border border-gray-300 px-3 py-2"
                          />
                        </label>
                      </div>
                    </>
                  )}

                  <label className="block text-sm">
                    <span className="block text-gray-600 mb-1">
                      {custodyForm.mode === 'issue' ? 'Condition going out' : 'Condition on handover'}
                    </span>
                    <select
                      value={
                        custodyForm.mode === 'issue'
                          ? custodyForm.conditionOut
                          : custodyForm.conditionIn
                      }
                      onChange={(e) =>
                        setCustodyForm({
                          ...custodyForm,
                          [custodyForm.mode === 'issue' ? 'conditionOut' : 'conditionIn']:
                            e.target.value,
                        })
                      }
                      className="w-full rounded border border-gray-300 px-3 py-2"
                    >
                      {conditions.map((key) => (
                        <option key={key} value={key}>
                          {CONDITION_LABELS[key] || key}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block text-sm">
                    <span className="block text-gray-600 mb-1">Note</span>
                    <input
                      value={custodyForm.note}
                      onChange={(e) => setCustodyForm({ ...custodyForm, note: e.target.value })}
                      className="w-full rounded border border-gray-300 px-3 py-2"
                    />
                  </label>

                  <button
                    type="submit"
                    className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition"
                  >
                    {custodyForm.mode === 'issue'
                      ? 'Issue'
                      : custodyForm.mode === 'transfer'
                        ? 'Transfer'
                        : 'Return to store'}
                  </button>
                </form>
              )}

              <form onSubmit={submitFault} className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-700">Report a fault</h3>
                <textarea
                  required
                  rows={2}
                  value={faultForm.fault}
                  onChange={(e) => setFaultForm({ ...faultForm, fault: e.target.value })}
                  placeholder="What is wrong with it?"
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                />
                <div className="flex flex-wrap items-center gap-3">
                  <select
                    value={faultForm.severity}
                    onChange={(e) => setFaultForm({ ...faultForm, severity: e.target.value })}
                    className="rounded border border-gray-300 px-3 py-2 text-sm"
                  >
                    {severities.map((key) => (
                      <option key={key} value={key}>
                        {key}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-md border border-amber-300 text-amber-800 text-sm font-medium hover:bg-amber-50 transition"
                  >
                    Report
                  </button>
                </div>
                {faultForm.severity === 'critical' && (
                  <p className="text-xs text-red-600">
                    A critical fault withdraws the asset from use immediately and returns it to
                    store.
                  </p>
                )}
              </form>

              {(detail.maintenance || []).length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-gray-700">Fault history</h3>
                  <ul className="mt-2 space-y-2">
                    {[...detail.maintenance].reverse().map((fault) => (
                      <li key={fault._id} className="rounded border border-gray-200 px-3 py-2 text-xs">
                        <div className="flex flex-wrap justify-between gap-2">
                          <span
                            className={`px-2 py-0.5 rounded font-medium ${
                              SEVERITY_STYLES[fault.severity] || 'bg-gray-100 text-gray-600'
                            }`}
                          >
                            {fault.severity}
                          </span>
                          <span className="text-gray-500">
                            {FAULT_STATUS_LABELS[fault.status] || fault.status} ·{' '}
                            {shortDate(fault.reportedAt)}
                          </span>
                        </div>
                        <p className="mt-1 text-gray-700">{fault.fault}</p>
                        {fault.resolution && (
                          <p className="mt-1 text-gray-500">{fault.resolution}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
};

export default AssetRegister;
