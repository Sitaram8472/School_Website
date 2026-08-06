import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Search,
  Plus,
  Trash2,
  ShieldAlert,
  Wallet,
  Receipt,
  AlertTriangle,
  Check,
  RefreshCw,
} from 'lucide-react';
import api from '../../utils/axios';

const ALLERGEN_LABELS = {
  nuts: 'Nuts',
  dairy: 'Dairy',
  gluten: 'Gluten',
  egg: 'Egg',
  soy: 'Soy',
  shellfish: 'Shellfish',
  fish: 'Fish',
  sesame: 'Sesame',
};

const MEAL_TYPES = ['breakfast', 'lunch', 'snack', 'dinner'];
const TOPUP_METHODS = ['cash', 'upi', 'card', 'bank-transfer', 'cheque', 'online'];

const money = (value, currency = 'INR') =>
  `${currency === 'INR' ? '₹' : `${currency} `}${Number(value || 0).toLocaleString('en-IN')}`;

const today = () => new Date().toISOString().slice(0, 10);

const inAMonth = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/**
 * A key that is stable for one attempt but different for the next.
 *
 * The counter tablet drops connections. Without this, a request that timed out
 * after the server committed it gets retried by a human pressing the button
 * again and the student pays twice; with it the server recognises the replay
 * and returns the original entry.
 */
const newIdempotencyKey = () =>
  `ctr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const emptyPlan = () => ({
  name: '',
  description: '',
  mealTypes: ['lunch'],
  allergens: [],
  vegetarian: false,
  price: '',
  cycle: 'monthly',
  validFrom: today(),
  validTo: inAMonth(),
  capacity: 0,
  status: 'draft',
});

/**
 * The counter and office panel: publish meal plans, and take money on a
 * student's prepaid account.
 */
const CafeteriaAdminPanel = () => {
  const [tab, setTab] = useState('counter');

  const [plans, setPlans] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [summary, setSummary] = useState(null);
  const [selected, setSelected] = useState(null);

  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [planForm, setPlanForm] = useState(emptyPlan());
  const [chargeForm, setChargeForm] = useState({ amount: '', description: '', mealPlanId: '' });
  const [topUpForm, setTopUpForm] = useState({ amount: '', method: 'cash', reference: '' });

  const loadPlans = useCallback(async () => {
    const res = await api.get('/cafeteria/plans');
    setPlans(res.data.data || []);
  }, []);

  const loadAccounts = useCallback(async (term) => {
    const res = await api.get('/cafeteria/accounts', {
      params: term ? { search: term } : {},
    });
    setAccounts(res.data.data || []);
  }, []);

  const loadSummary = useCallback(async () => {
    const res = await api.get('/cafeteria/summary');
    setSummary(res.data.summary);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await Promise.all([loadPlans(), loadAccounts(''), loadSummary()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the cafeteria data.');
    } finally {
      setLoading(false);
    }
  }, [loadPlans, loadAccounts, loadSummary]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * Reload the selected account after any money movement, so the balance shown
   * to the person at the counter is the one the server actually holds.
   */
  const reselect = useCallback(async (accountId) => {
    const res = await api.get(`/cafeteria/accounts/${accountId}`);
    setSelected(res.data.data);
  }, []);

  const runSearch = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      await loadAccounts(search.trim());
    } catch (err) {
      setError(err.response?.data?.message || 'Search failed.');
    } finally {
      setLoading(false);
    }
  };

  const openAccount = async (account) => {
    setError('');
    setNotice('');
    try {
      await reselect(account._id);
      setChargeForm({ amount: '', description: '', mealPlanId: '' });
      setTopUpForm({ amount: '', method: 'cash', reference: '' });
    } catch (err) {
      setError(err.response?.data?.message || 'Could not open that account.');
    }
  };

  const submitCharge = async (event) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await api.post(`/cafeteria/accounts/${selected._id}/charge`, {
        amount: Number(chargeForm.amount),
        description: chargeForm.description || undefined,
        mealPlanId: chargeForm.mealPlanId || undefined,
        idempotencyKey: newIdempotencyKey(),
      });
      setSelected(res.data.data);
      setChargeForm({ amount: '', description: '', mealPlanId: '' });
      setNotice(res.data.message);
      await loadAccounts(search.trim());
    } catch (err) {
      setError(err.response?.data?.message || 'The charge was refused.');
    } finally {
      setBusy(false);
    }
  };

  const submitTopUp = async (event) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await api.post(`/cafeteria/accounts/${selected._id}/topup`, {
        amount: Number(topUpForm.amount),
        method: topUpForm.method,
        reference: topUpForm.reference || undefined,
        idempotencyKey: newIdempotencyKey(),
      });
      setSelected(res.data.data);
      setTopUpForm({ amount: '', method: 'cash', reference: '' });
      setNotice(res.data.message);
      await loadAccounts(search.trim());
    } catch (err) {
      setError(err.response?.data?.message || 'The top-up failed.');
    } finally {
      setBusy(false);
    }
  };

  const refund = async (entry) => {
    if (!selected) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await api.post(`/cafeteria/accounts/${selected._id}/refund`, {
        entryId: entry._id,
        reason: 'Counter correction',
        idempotencyKey: newIdempotencyKey(),
      });
      setSelected(res.data.data);
      setNotice(res.data.message);
    } catch (err) {
      setError(err.response?.data?.message || 'The refund failed.');
    } finally {
      setBusy(false);
    }
  };

  const submitPlan = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.post('/cafeteria/plans', {
        ...planForm,
        price: Number(planForm.price),
        capacity: Number(planForm.capacity) || 0,
      });
      setPlanForm(emptyPlan());
      setNotice('Meal plan created.');
      await loadPlans();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not create the plan.');
    } finally {
      setBusy(false);
    }
  };

  const setPlanStatus = async (plan, status) => {
    setBusy(true);
    setError('');
    try {
      await api.put(`/cafeteria/plans/${plan._id}`, { status });
      await loadPlans();
      setNotice(`"${plan.name}" is now ${status}.`);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not update the plan.');
    } finally {
      setBusy(false);
    }
  };

  const removePlan = async (plan) => {
    setBusy(true);
    setError('');
    try {
      await api.delete(`/cafeteria/plans/${plan._id}`);
      await loadPlans();
      setNotice(`"${plan.name}" deleted.`);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not delete the plan.');
    } finally {
      setBusy(false);
    }
  };

  const togglePlanField = (field, value) => {
    setPlanForm((current) => ({
      ...current,
      [field]: current[field].includes(value)
        ? current[field].filter((item) => item !== value)
        : [...current[field], value],
    }));
  };

  /**
   * Plans this student must not be sold. Computed here so the counter's plan
   * dropdown can disable them, rather than relying on the server's refusal as
   * the first point at which anybody notices.
   */
  const unsafeForSelected = useMemo(() => {
    const flags = selected?.dietaryFlags || [];
    if (flags.length === 0) return new Set();
    return new Set(
      plans
        .filter((plan) => (plan.allergens || []).some((allergen) => flags.includes(allergen)))
        .map((plan) => plan._id)
    );
  }, [plans, selected]);

  const chargeEntries = useMemo(
    () => (selected?.ledger || []).filter((entry) => entry.type === 'charge').slice(0, 8),
    [selected]
  );

  const tabs = [
    { id: 'counter', label: 'Counter' },
    { id: 'plans', label: 'Meal plans' },
    { id: 'summary', label: 'Summary' },
  ];

  return (
    <div className="bg-white rounded-2xl shadow-lg p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-800">Cafeteria</h2>
          <p className="text-sm text-gray-500">Meal plans and prepaid canteen accounts</p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="flex gap-2 mb-6 bg-gray-100 rounded-xl p-1">
        {tabs.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition ${
              tab === item.id ? 'bg-orange-600 text-white shadow' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-start gap-3 bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 mb-5">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      {notice && (
        <div className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl p-4 mb-5">
          <Check size={18} className="mt-0.5 shrink-0" />
          <span className="text-sm">{notice}</span>
        </div>
      )}

      {/* ---- Counter ---- */}
      {tab === 'counter' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1">
            <form onSubmit={runSearch} className="flex gap-2 mb-4">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search student"
                className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-400"
              />
              <button
                type="submit"
                className="bg-gray-800 hover:bg-gray-900 text-white px-3 rounded-lg"
                aria-label="Search"
              >
                <Search size={16} />
              </button>
            </form>

            <div className="space-y-2 max-h-[520px] overflow-y-auto">
              {accounts.length === 0 && (
                <p className="text-sm text-gray-400 py-4">No accounts found.</p>
              )}
              {accounts.map((account) => (
                <button
                  key={account._id}
                  onClick={() => openAccount(account)}
                  className={`w-full text-left border rounded-xl p-3 transition ${
                    selected?._id === account._id
                      ? 'border-orange-500 bg-orange-50'
                      : 'border-gray-200 hover:border-orange-300'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm text-gray-800">
                      {account.studentName || 'Unnamed student'}
                    </span>
                    <span className="text-sm font-semibold">{money(account.balance)}</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">{account.className || '—'}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="lg:col-span-2">
            {!selected && (
              <div className="border border-dashed border-gray-300 rounded-2xl p-12 text-center text-gray-400 text-sm">
                Pick a student to take a payment.
              </div>
            )}

            {selected && (
              <div className="space-y-5">
                {/* Allergen banner first — before the balance, before anything
                    else. It is the only thing on this card that can hurt
                    somebody. */}
                {selected.dietaryFlags.length > 0 ? (
                  <div className="bg-rose-600 text-white rounded-2xl p-5">
                    <div className="flex items-center gap-2 font-semibold">
                      <ShieldAlert size={20} /> Allergens declared
                    </div>
                    <div className="flex flex-wrap gap-2 mt-3">
                      {selected.dietaryFlags.map((flag) => (
                        <span
                          key={flag}
                          className="px-3 py-1 rounded-full bg-white/25 text-sm font-medium"
                        >
                          {ALLERGEN_LABELS[flag] || flag}
                        </span>
                      ))}
                    </div>
                    {selected.dietaryNotes && (
                      <p className="text-sm text-rose-50 mt-3">{selected.dietaryNotes}</p>
                    )}
                  </div>
                ) : (
                  <div className="bg-gray-50 border border-gray-200 rounded-2xl p-4 text-sm text-gray-500">
                    No allergens declared for this student.
                  </div>
                )}

                <div className="flex items-center justify-between border border-gray-200 rounded-2xl p-5">
                  <div>
                    <div className="font-semibold text-gray-800">{selected.studentName}</div>
                    <div className="text-xs text-gray-500">{selected.className || '—'}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold">{money(selected.balance, selected.currency)}</div>
                    <div className="text-xs text-gray-500">
                      {selected.remainingToday === null
                        ? 'No daily cap'
                        : `${money(selected.remainingToday)} left today`}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  {/* Charge */}
                  <form onSubmit={submitCharge} className="border border-gray-200 rounded-2xl p-5 space-y-3">
                    <h3 className="font-semibold text-sm flex items-center gap-2 text-gray-800">
                      <Receipt size={16} className="text-rose-600" /> Take a payment
                    </h3>
                    <input
                      type="number"
                      min="1"
                      required
                      value={chargeForm.amount}
                      onChange={(e) => setChargeForm({ ...chargeForm, amount: e.target.value })}
                      placeholder="Amount"
                      className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-400"
                    />
                    <select
                      value={chargeForm.mealPlanId}
                      onChange={(e) => setChargeForm({ ...chargeForm, mealPlanId: e.target.value })}
                      className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-400"
                    >
                      <option value="">No plan (à la carte)</option>
                      {plans.map((plan) => (
                        <option key={plan._id} value={plan._id} disabled={unsafeForSelected.has(plan._id)}>
                          {plan.name}
                          {unsafeForSelected.has(plan._id) ? ' — unsafe for this student' : ''}
                        </option>
                      ))}
                    </select>
                    <input
                      value={chargeForm.description}
                      onChange={(e) => setChargeForm({ ...chargeForm, description: e.target.value })}
                      placeholder="What was bought"
                      className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-400"
                    />
                    <button
                      type="submit"
                      disabled={busy}
                      className="w-full bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-sm py-2 rounded-lg transition"
                    >
                      {busy ? 'Working…' : 'Charge'}
                    </button>
                  </form>

                  {/* Top up */}
                  <form onSubmit={submitTopUp} className="border border-gray-200 rounded-2xl p-5 space-y-3">
                    <h3 className="font-semibold text-sm flex items-center gap-2 text-gray-800">
                      <Wallet size={16} className="text-emerald-600" /> Top up
                    </h3>
                    <input
                      type="number"
                      min="1"
                      required
                      value={topUpForm.amount}
                      onChange={(e) => setTopUpForm({ ...topUpForm, amount: e.target.value })}
                      placeholder="Amount"
                      className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-400"
                    />
                    <select
                      value={topUpForm.method}
                      onChange={(e) => setTopUpForm({ ...topUpForm, method: e.target.value })}
                      className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-400"
                    >
                      {TOPUP_METHODS.map((method) => (
                        <option key={method} value={method}>
                          {method}
                        </option>
                      ))}
                    </select>
                    <input
                      value={topUpForm.reference}
                      onChange={(e) => setTopUpForm({ ...topUpForm, reference: e.target.value })}
                      placeholder="Reference (optional)"
                      className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-400"
                    />
                    <button
                      type="submit"
                      disabled={busy}
                      className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm py-2 rounded-lg transition"
                    >
                      {busy ? 'Working…' : 'Add funds'}
                    </button>
                  </form>
                </div>

                {chargeEntries.length > 0 && (
                  <div className="border border-gray-200 rounded-2xl p-5">
                    <h3 className="font-semibold text-sm text-gray-800 mb-3">Recent charges</h3>
                    <ul className="space-y-2">
                      {chargeEntries.map((entry) => (
                        <li
                          key={entry._id}
                          className="flex items-center justify-between text-sm border-b border-gray-50 last:border-0 pb-2"
                        >
                          <div>
                            <div className="text-gray-700">{entry.description}</div>
                            <div className="text-xs text-gray-400">
                              {new Date(entry.occurredAt).toLocaleString('en-GB')}
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="font-medium">{money(entry.amount)}</span>
                            <button
                              onClick={() => refund(entry)}
                              disabled={busy}
                              className="text-xs text-orange-600 hover:text-orange-700 disabled:opacity-50"
                            >
                              Refund
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---- Plans ---- */}
      {tab === 'plans' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <form onSubmit={submitPlan} className="lg:col-span-1 border border-gray-200 rounded-2xl p-5 space-y-3">
            <h3 className="font-semibold text-sm flex items-center gap-2 text-gray-800">
              <Plus size={16} /> New plan
            </h3>
            <input
              required
              value={planForm.name}
              onChange={(e) => setPlanForm({ ...planForm, name: e.target.value })}
              placeholder="Plan name"
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-400"
            />
            <textarea
              rows={2}
              value={planForm.description}
              onChange={(e) => setPlanForm({ ...planForm, description: e.target.value })}
              placeholder="Description"
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-400"
            />

            <div>
              <div className="text-xs text-gray-500 mb-1.5">Meals covered</div>
              <div className="flex flex-wrap gap-1.5">
                {MEAL_TYPES.map((meal) => (
                  <button
                    key={meal}
                    type="button"
                    onClick={() => togglePlanField('mealTypes', meal)}
                    className={`px-2.5 py-1 rounded-full text-xs border transition ${
                      planForm.mealTypes.includes(meal)
                        ? 'bg-orange-600 text-white border-orange-600'
                        : 'bg-white text-gray-600 border-gray-300'
                    }`}
                  >
                    {meal}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="text-xs text-gray-500 mb-1.5">Allergens present</div>
              <div className="flex flex-wrap gap-1.5">
                {Object.keys(ALLERGEN_LABELS).map((allergen) => (
                  <button
                    key={allergen}
                    type="button"
                    onClick={() => togglePlanField('allergens', allergen)}
                    className={`px-2.5 py-1 rounded-full text-xs border transition ${
                      planForm.allergens.includes(allergen)
                        ? 'bg-rose-600 text-white border-rose-600'
                        : 'bg-white text-gray-600 border-gray-300'
                    }`}
                  >
                    {ALLERGEN_LABELS[allergen]}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <input
                type="number"
                min="0"
                required
                value={planForm.price}
                onChange={(e) => setPlanForm({ ...planForm, price: e.target.value })}
                placeholder="Price"
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-400"
              />
              <input
                type="number"
                min="0"
                value={planForm.capacity}
                onChange={(e) => setPlanForm({ ...planForm, capacity: e.target.value })}
                placeholder="Capacity (0 = any)"
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-400"
              />
              <input
                type="date"
                required
                value={planForm.validFrom}
                onChange={(e) => setPlanForm({ ...planForm, validFrom: e.target.value })}
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-400"
              />
              <input
                type="date"
                required
                value={planForm.validTo}
                onChange={(e) => setPlanForm({ ...planForm, validTo: e.target.value })}
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-400"
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input
                type="checkbox"
                checked={planForm.vegetarian}
                onChange={(e) => setPlanForm({ ...planForm, vegetarian: e.target.checked })}
              />
              Vegetarian
            </label>

            <button
              type="submit"
              disabled={busy}
              className="w-full bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white text-sm py-2 rounded-lg transition"
            >
              {busy ? 'Saving…' : 'Create as draft'}
            </button>
          </form>

          <div className="lg:col-span-2 space-y-3">
            {plans.length === 0 && <p className="text-sm text-gray-400">No plans yet.</p>}
            {plans.map((plan) => (
              <div key={plan._id} className="border border-gray-200 rounded-2xl p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-gray-800">{plan.name}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {money(plan.price, plan.currency)} · {plan.cycle} ·{' '}
                      {(plan.mealTypes || []).join(', ')}
                    </div>
                    {(plan.allergens || []).length > 0 && (
                      <div className="flex items-center gap-1.5 text-xs text-rose-600 mt-1.5">
                        <ShieldAlert size={12} />
                        {plan.allergens.map((a) => ALLERGEN_LABELS[a] || a).join(', ')}
                      </div>
                    )}
                  </div>
                  <div className="text-right">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        plan.status === 'active'
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {plan.status}
                    </span>
                    <div className="text-xs text-gray-400 mt-1">
                      {plan.subscriberCount} subscriber(s)
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3 mt-3 pt-3 border-t border-gray-50">
                  {plan.status !== 'active' && (
                    <button
                      onClick={() => setPlanStatus(plan, 'active')}
                      disabled={busy}
                      className="text-xs text-emerald-600 hover:text-emerald-700 disabled:opacity-50"
                    >
                      Publish
                    </button>
                  )}
                  {plan.status === 'active' && (
                    <button
                      onClick={() => setPlanStatus(plan, 'paused')}
                      disabled={busy}
                      className="text-xs text-amber-600 hover:text-amber-700 disabled:opacity-50"
                    >
                      Pause
                    </button>
                  )}
                  <button
                    onClick={() => setPlanStatus(plan, 'retired')}
                    disabled={busy}
                    className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
                  >
                    Retire
                  </button>
                  {plan.subscriberCount === 0 && (
                    <button
                      onClick={() => removePlan(plan)}
                      disabled={busy}
                      className="text-xs text-red-600 hover:text-red-700 disabled:opacity-50 inline-flex items-center gap-1 ml-auto"
                    >
                      <Trash2 size={12} /> Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---- Summary ---- */}
      {tab === 'summary' && summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: 'Accounts', value: summary.accounts },
            { label: 'Float held', value: money(summary.floatHeld), hint: 'Owed back to families' },
            { label: 'Lifetime spend', value: money(summary.lifetimeSpend) },
            { label: 'Low balance', value: summary.lowBalanceAccounts },
            { label: 'With allergens', value: summary.accountsWithAllergens },
            { label: 'Average balance', value: money(summary.averageBalance) },
            { label: 'Active plans', value: summary.activePlans },
            { label: 'Subscriptions', value: summary.totalSubscriptions },
          ].map((card) => (
            <div key={card.label} className="border border-gray-200 rounded-2xl p-5">
              <div className="text-xs uppercase tracking-wide text-gray-400">{card.label}</div>
              <div className="text-2xl font-bold text-gray-800 mt-1">{card.value}</div>
              {card.hint && <div className="text-xs text-gray-400 mt-1">{card.hint}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default CafeteriaAdminPanel;
