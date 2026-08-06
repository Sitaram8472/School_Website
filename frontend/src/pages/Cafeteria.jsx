import React, { useState, useEffect, useContext, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Wallet,
  UtensilsCrossed,
  AlertTriangle,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  CalendarClock,
  Check,
} from 'lucide-react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';
import CafeteriaAdminPanel from '../components/cafeteria/CafeteriaAdminPanel';

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

const ENTRY_STYLES = {
  topup: { label: 'Top-up', tone: 'text-emerald-700 bg-emerald-50', sign: '+' },
  charge: { label: 'Purchase', tone: 'text-rose-700 bg-rose-50', sign: '−' },
  refund: { label: 'Refund', tone: 'text-emerald-700 bg-emerald-50', sign: '+' },
  reversal: { label: 'Reversal', tone: 'text-emerald-700 bg-emerald-50', sign: '+' },
  adjustment: { label: 'Adjustment', tone: 'text-slate-700 bg-slate-100', sign: '' },
};

const money = (value, currency = 'INR') =>
  `${currency === 'INR' ? '₹' : `${currency} `}${Number(value || 0).toLocaleString('en-IN')}`;

const formatDateTime = (value) =>
  value
    ? new Date(value).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

/**
 * Cafeteria portal. Students see their prepaid balance, what they have spent
 * and the allergens they have declared; admin and office staff get the counter
 * panel instead.
 */
const Cafeteria = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isStaff = role === 'admin' || role === 'staff';
  const displayName = user?.name || user?.user?.name || 'Student';

  const [account, setAccount] = useState(null);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingDiet, setEditingDiet] = useState(false);
  const [draftFlags, setDraftFlags] = useState([]);
  const [draftNotes, setDraftNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const loadAccount = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [accountRes, plansRes] = await Promise.all([
        api.get('/cafeteria/account/me'),
        api.get('/cafeteria/plans'),
      ]);
      const data = accountRes.data.data;
      setAccount(data);
      setDraftFlags(data.dietaryFlags || []);
      setDraftNotes(data.dietaryNotes || '');
      setPlans(plansRes.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load your canteen account right now.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isStaff) loadAccount();
    else setLoading(false);
  }, [isStaff, loadAccount]);

  const toggleFlag = (allergen) => {
    setDraftFlags((current) =>
      current.includes(allergen)
        ? current.filter((item) => item !== allergen)
        : [...current, allergen]
    );
  };

  const saveDietary = async () => {
    if (!account) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const res = await api.patch(`/cafeteria/accounts/${account._id}/dietary`, {
        dietaryFlags: draftFlags,
        dietaryNotes: draftNotes,
      });
      setAccount(res.data.data);
      setEditingDiet(false);
      setNotice('Allergen declarations saved. The counter will see these before every sale.');
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save your dietary flags.');
    } finally {
      setSaving(false);
    }
  };

  const spendThisMonth = useMemo(() => {
    if (!account?.ledger) return 0;
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    return account.ledger
      .filter((entry) => entry.type === 'charge' && new Date(entry.occurredAt) >= start)
      .reduce((total, entry) => total + entry.amount, 0);
  }, [account]);

  const activeSubscriptions = useMemo(
    () => (account?.subscriptions || []).filter((item) => item.status === 'active'),
    [account]
  );

  /**
   * Plans the student has flagged an allergen for. Surfaced on the menu so the
   * refusal at the counter is never the first time they hear about it.
   */
  const unsafePlanIds = useMemo(() => {
    const flags = account?.dietaryFlags || [];
    if (flags.length === 0) return new Set();
    return new Set(
      plans
        .filter((plan) => (plan.allergens || []).some((allergen) => flags.includes(allergen)))
        .map((plan) => plan._id)
    );
  }, [plans, account]);

  if (isStaff) {
    return (
      <div
        className="min-h-screen p-4 sm:p-6"
        style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
      >
        <div className="max-w-6xl mx-auto">
          <Link
            to="/teacher/dashboard"
            className="inline-flex items-center gap-2 text-sm text-orange-600 hover:text-orange-700 mb-4"
          >
            <ArrowLeft size={16} /> Back to dashboard
          </Link>
          <CafeteriaAdminPanel />
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen p-4 sm:p-6"
      style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
    >
      {/* Header */}
      <div className="bg-gradient-to-r from-orange-600 to-amber-600 text-white rounded-3xl p-8 shadow-2xl mb-8">
        <Link to="/student" className="inline-flex items-center gap-2 text-orange-100 hover:text-white text-sm">
          <ArrowLeft size={16} /> Back to dashboard
        </Link>

        <div className="flex items-center gap-4 mt-4">
          <div className="bg-white text-orange-600 p-4 rounded-full shadow-lg">
            <UtensilsCrossed size={28} />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Canteen account</h1>
            <p className="text-orange-100 mt-1">{displayName}</p>
          </div>
        </div>

        {account && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-8">
            <div className="bg-white/15 rounded-2xl p-5">
              <div className="flex items-center gap-2 text-orange-100 text-xs uppercase tracking-wide">
                <Wallet size={14} /> Balance
              </div>
              <div className="text-3xl font-bold mt-2">{money(account.balance, account.currency)}</div>
              {account.isLow && (
                <div className="text-xs text-amber-100 mt-1">Running low — please top up.</div>
              )}
            </div>
            <div className="bg-white/15 rounded-2xl p-5">
              <div className="flex items-center gap-2 text-orange-100 text-xs uppercase tracking-wide">
                <TrendingDown size={14} /> Spent this month
              </div>
              <div className="text-3xl font-bold mt-2">{money(spendThisMonth, account.currency)}</div>
            </div>
            <div className="bg-white/15 rounded-2xl p-5">
              <div className="flex items-center gap-2 text-orange-100 text-xs uppercase tracking-wide">
                <CalendarClock size={14} /> Left today
              </div>
              <div className="text-3xl font-bold mt-2">
                {account.remainingToday === null
                  ? 'No cap'
                  : money(account.remainingToday, account.currency)}
              </div>
              {account.dailySpendLimit > 0 && (
                <div className="text-xs text-orange-100 mt-1">
                  Daily limit {money(account.dailySpendLimit, account.currency)}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="max-w-6xl mx-auto">
        {error && (
          <div className="flex items-start gap-3 bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 mb-6">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <span className="text-sm">{error}</span>
          </div>
        )}

        {notice && (
          <div className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl p-4 mb-6">
            <Check size={18} className="mt-0.5 shrink-0" />
            <span className="text-sm">{notice}</span>
          </div>
        )}

        {loading && (
          <div className="text-center py-16 text-gray-500">Loading your canteen account…</div>
        )}

        {!loading && account && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Allergens */}
            <div className="lg:col-span-1 space-y-6">
              <div className="bg-white rounded-2xl shadow p-6">
                <div className="flex items-center justify-between mb-1">
                  <h2 className="font-semibold flex items-center gap-2 text-gray-800">
                    <ShieldAlert size={18} className="text-rose-600" /> Allergens
                  </h2>
                  {!editingDiet && (
                    <button
                      onClick={() => setEditingDiet(true)}
                      className="text-xs text-orange-600 hover:text-orange-700 font-medium"
                    >
                      Edit
                    </button>
                  )}
                </div>
                <p className="text-xs text-gray-500 mb-4">
                  The counter is blocked from selling you anything containing these.
                </p>

                {!editingDiet && (
                  <>
                    {account.dietaryFlags.length === 0 ? (
                      <p className="text-sm text-gray-400">Nothing declared.</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {account.dietaryFlags.map((flag) => (
                          <span
                            key={flag}
                            className="px-3 py-1 rounded-full text-xs font-medium bg-rose-100 text-rose-700"
                          >
                            {ALLERGEN_LABELS[flag] || flag}
                          </span>
                        ))}
                      </div>
                    )}
                    {account.dietaryNotes && (
                      <p className="text-xs text-gray-600 mt-3 italic">{account.dietaryNotes}</p>
                    )}
                  </>
                )}

                {editingDiet && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                      {Object.keys(ALLERGEN_LABELS).map((allergen) => {
                        const on = draftFlags.includes(allergen);
                        return (
                          <button
                            key={allergen}
                            type="button"
                            onClick={() => toggleFlag(allergen)}
                            className={`px-3 py-1 rounded-full text-xs font-medium border transition ${
                              on
                                ? 'bg-rose-600 text-white border-rose-600'
                                : 'bg-white text-gray-600 border-gray-300 hover:border-rose-400'
                            }`}
                          >
                            {ALLERGEN_LABELS[allergen]}
                          </button>
                        );
                      })}
                    </div>
                    <textarea
                      value={draftNotes}
                      onChange={(e) => setDraftNotes(e.target.value)}
                      rows={3}
                      maxLength={300}
                      placeholder="Anything the kitchen should know"
                      className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-400"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={saveDietary}
                        disabled={saving}
                        className="flex-1 bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white text-sm py-2 rounded-lg transition"
                      >
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={() => {
                          setEditingDiet(false);
                          setDraftFlags(account.dietaryFlags || []);
                          setDraftNotes(account.dietaryNotes || '');
                        }}
                        className="px-4 text-sm text-gray-600 hover:text-gray-800"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Subscriptions */}
              <div className="bg-white rounded-2xl shadow p-6">
                <h2 className="font-semibold text-gray-800 mb-4">Meal plans you are on</h2>
                {activeSubscriptions.length === 0 ? (
                  <p className="text-sm text-gray-400">No active meal plan.</p>
                ) : (
                  <ul className="space-y-3">
                    {activeSubscriptions.map((subscription) => (
                      <li key={subscription._id} className="border border-gray-100 rounded-xl p-3">
                        <div className="font-medium text-sm text-gray-800">{subscription.planName}</div>
                        <div className="text-xs text-gray-500 mt-1">
                          Until {formatDate(subscription.endsOn)} ·{' '}
                          {money(subscription.pricePaid, account.currency)} paid
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* Ledger + menu */}
            <div className="lg:col-span-2 space-y-6">
              <div className="bg-white rounded-2xl shadow p-6">
                <h2 className="font-semibold text-gray-800 mb-4">Recent activity</h2>
                {account.ledger.length === 0 ? (
                  <p className="text-sm text-gray-400">Nothing recorded yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b">
                          <th className="pb-2">When</th>
                          <th className="pb-2">What</th>
                          <th className="pb-2 text-right">Amount</th>
                          <th className="pb-2 text-right">Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {account.ledger.map((entry) => {
                          const style = ENTRY_STYLES[entry.type] || ENTRY_STYLES.adjustment;
                          return (
                            <tr key={entry._id} className="border-b border-gray-50 last:border-0">
                              <td className="py-3 text-gray-500 whitespace-nowrap">
                                {formatDateTime(entry.occurredAt)}
                              </td>
                              <td className="py-3">
                                <span
                                  className={`inline-block px-2 py-0.5 rounded text-xs font-medium mr-2 ${style.tone}`}
                                >
                                  {style.label}
                                </span>
                                <span className="text-gray-700">{entry.description}</span>
                              </td>
                              <td className="py-3 text-right font-medium whitespace-nowrap">
                                {style.sign}
                                {money(entry.amount, account.currency)}
                              </td>
                              <td className="py-3 text-right text-gray-500 whitespace-nowrap">
                                {money(entry.balanceAfter, account.currency)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="bg-white rounded-2xl shadow p-6">
                <h2 className="font-semibold text-gray-800 mb-1">Available meal plans</h2>
                <p className="text-xs text-gray-500 mb-4">
                  Plans marked unsafe contain something you have declared. Ask the office to subscribe.
                </p>
                {plans.length === 0 ? (
                  <p className="text-sm text-gray-400">No plans on offer at the moment.</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {plans.map((plan) => {
                      const unsafe = unsafePlanIds.has(plan._id);
                      return (
                        <div
                          key={plan._id}
                          className={`border rounded-xl p-4 ${
                            unsafe ? 'border-rose-300 bg-rose-50' : 'border-gray-200'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="font-medium text-gray-800">{plan.name}</div>
                            <div className="text-sm font-semibold whitespace-nowrap">
                              {money(plan.price, plan.currency)}
                            </div>
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            {(plan.mealTypes || []).join(', ')} · {plan.cycle}
                          </div>
                          {unsafe && (
                            <div className="flex items-center gap-1.5 text-xs text-rose-700 font-medium mt-2">
                              <ShieldAlert size={13} /> Not safe for you
                            </div>
                          )}
                          {(plan.allergens || []).length > 0 && (
                            <div className="text-xs text-gray-500 mt-2">
                              Contains: {plan.allergens.map((a) => ALLERGEN_LABELS[a] || a).join(', ')}
                            </div>
                          )}
                          {plan.seatsLeft !== null && plan.seatsLeft !== undefined && (
                            <div className="flex items-center gap-1.5 text-xs text-gray-400 mt-2">
                              <TrendingUp size={13} /> {plan.seatsLeft} place(s) left
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Cafeteria;
