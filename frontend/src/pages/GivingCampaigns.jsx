import { useState, useEffect, useContext, useCallback, useMemo } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * Donations and fundraising.
 *
 * Every progress bar is two bars: received solid, pledged behind it in a
 * lighter tone, with both figures written out underneath. Showing one number
 * is how a school ends up planning against money that has not arrived, and the
 * gap between the two is the thing worth seeing.
 *
 * The pledge form previews the generated instalment schedule before the donor
 * commits. Agreeing to "₹50,000 over ten months" and seeing ten dates with ten
 * amounts are different decisions, and only the second one is informed.
 *
 * The admin ledger leads with the chase list, then the payment form — where the
 * reference field is the one that matters, so it is labelled as such rather
 * than sitting at the bottom looking optional.
 */

const CATEGORY_LABELS = {
  infrastructure: 'Infrastructure',
  scholarship: 'Scholarships',
  library: 'Library',
  sports: 'Sports',
  technology: 'Technology',
  transport: 'Transport',
  'emergency-relief': 'Emergency relief',
  general: 'General',
};

const SCHEDULE_LABELS = {
  'one-off': 'One-off',
  monthly: 'Monthly for a year',
  quarterly: 'Quarterly for a year',
  annual: 'Once a year',
};

const STATUS_LABELS = {
  pledged: 'Pledged',
  'partially-fulfilled': 'Part paid',
  fulfilled: 'Fulfilled',
  lapsed: 'Lapsed',
  cancelled: 'Cancelled',
};

const STATUS_STYLES = {
  pledged: 'bg-blue-100 text-blue-700',
  'partially-fulfilled': 'bg-amber-100 text-amber-800',
  fulfilled: 'bg-green-100 text-green-700',
  lapsed: 'bg-gray-200 text-gray-600',
  cancelled: 'bg-gray-200 text-gray-500',
};

const INSTALMENT_LABELS = {
  due: 'Due',
  'part-paid': 'Part paid',
  paid: 'Paid',
  waived: 'Waived',
};

const money = (value, currency = 'INR') =>
  value === null || value === undefined
    ? '—'
    : `${currency === 'INR' ? '₹' : `${currency} `}${Number(value).toLocaleString('en-IN', {
        maximumFractionDigits: 0,
      })}`;

const shortDate = (value) => (value ? new Date(value).toLocaleDateString() : '—');

/**
 * The two-bar progress meter. Pledged is the lighter track behind received.
 */
const ProgressBars = ({ progress, goal, currency }) => (
  <div>
    <div className="relative h-3 w-full rounded bg-gray-100 overflow-hidden">
      <div
        className="absolute inset-y-0 left-0 bg-blue-200"
        style={{ width: `${Math.min(progress.pledgedPercent, 100)}%` }}
      />
      <div
        className="absolute inset-y-0 left-0 bg-blue-600"
        style={{ width: `${Math.min(progress.receivedPercent, 100)}%` }}
      />
    </div>
    <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
      <span className="font-semibold text-blue-700">
        {money(progress.amountReceived, currency)} received
      </span>
      <span className="text-blue-400">{money(progress.amountPledged, currency)} pledged</span>
      <span className="text-gray-500">of {money(goal, currency)}</span>
    </div>
  </div>
);

const StatusChip = ({ status }) => (
  <span
    className={`px-2 py-0.5 rounded text-xs font-medium ${
      STATUS_STYLES[status] || 'bg-gray-100 text-gray-700'
    }`}
  >
    {STATUS_LABELS[status] || status}
  </span>
);

const GivingCampaigns = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';

  const [tab, setTab] = useState('campaigns');
  const [meta, setMeta] = useState(null);

  const [campaigns, setCampaigns] = useState([]);
  const [selected, setSelected] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);
  const [myPledges, setMyPledges] = useState([]);
  const [myTotals, setMyTotals] = useState({ totalGiven: 0, totalOutstanding: 0 });
  const [overdue, setOverdue] = useState([]);
  const [stats, setStats] = useState(null);
  const [pledgeDetail, setPledgeDetail] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [pledgeForm, setPledgeForm] = useState({
    amount: '',
    schedule: 'one-off',
    startsOn: '',
    donorType: 'parent',
    isAnonymous: false,
    note: '',
  });

  const [paymentForm, setPaymentForm] = useState({
    reference: '',
    amount: '',
    method: 'bank-transfer',
    receivedOn: '',
    note: '',
  });

  const readError = (err, fallback) => err?.response?.data?.message || fallback;

  const clearMessages = () => {
    setError('');
    setNotice('');
  };

  const loadMeta = useCallback(async () => {
    try {
      const { data } = await api.get('/giving/meta');
      setMeta(data.data);
    } catch {
      // The forms fall back to their own labels.
    }
  }, []);

  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/giving/campaigns');
      setCampaigns(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load appeals'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMine = useCallback(async () => {
    try {
      const { data } = await api.get('/giving/pledges/mine');
      setMyPledges(data.data || []);
      setMyTotals({
        totalGiven: data.totalGiven || 0,
        totalOutstanding: data.totalOutstanding || 0,
      });
    } catch (err) {
      setError(readError(err, 'Could not load your giving'));
    }
  }, []);

  const loadOverdue = useCallback(async () => {
    try {
      const { data } = await api.get('/giving/pledges/overdue');
      setOverdue(data.data || []);
    } catch {
      setOverdue([]);
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const { data } = await api.get('/giving/stats');
      setStats(data.data);
    } catch {
      setStats(null);
    }
  }, []);

  const loadLeaderboard = useCallback(async (campaignId) => {
    try {
      const { data } = await api.get(`/giving/campaigns/${campaignId}/leaderboard`);
      setLeaderboard(data.data || []);
    } catch {
      setLeaderboard([]);
    }
  }, []);

  const loadPledge = useCallback(async (pledgeId) => {
    try {
      const { data } = await api.get(`/giving/pledges/${pledgeId}`);
      setPledgeDetail(data.data);
    } catch (err) {
      setError(readError(err, 'Could not load that pledge'));
    }
  }, []);

  useEffect(() => {
    loadMeta();
    loadCampaigns();
    loadMine();
    if (isAdmin) {
      loadOverdue();
      loadStats();
    }
  }, [loadMeta, loadCampaigns, loadMine, loadOverdue, loadStats, isAdmin]);

  /**
   * The schedule the server will generate, previewed locally.
   *
   * Mirrors `Pledge.buildSchedule`: the last instalment absorbs the remainder,
   * so the preview and the saved schedule agree to the rupee.
   */
  const schedulePreview = useMemo(() => {
    const amount = Number(pledgeForm.amount);
    if (!Number.isFinite(amount) || amount <= 0) return [];

    const counts = meta?.scheduleCounts || {
      'one-off': 1,
      monthly: 12,
      quarterly: 4,
      annual: 1,
    };
    const count = counts[pledgeForm.schedule] || 1;
    const step = { 'one-off': 0, monthly: 1, quarterly: 3, annual: 12 }[pledgeForm.schedule] || 0;

    const start = pledgeForm.startsOn ? new Date(pledgeForm.startsOn) : new Date();
    if (Number.isNaN(start.getTime())) return [];

    const per = Math.floor((amount * 100) / count) / 100;
    const rows = [];
    for (let i = 0; i < count; i += 1) {
      const due = new Date(start.getTime());
      if (step) {
        const target = start.getUTCMonth() + step * i;
        due.setUTCMonth(target);
        if (due.getUTCMonth() !== ((target % 12) + 12) % 12) due.setUTCDate(0);
      }
      rows.push({
        dueOn: due,
        amount: i === count - 1 ? Math.round((amount - per * (count - 1)) * 100) / 100 : per,
      });
    }
    return rows;
  }, [pledgeForm.amount, pledgeForm.schedule, pledgeForm.startsOn, meta]);

  // -- actions ---------------------------------------------------------------

  const submitPledge = async (event) => {
    event.preventDefault();
    if (!selected) return;
    clearMessages();
    try {
      const payload = {
        campaignId: selected._id,
        amount: Number(pledgeForm.amount),
        schedule: pledgeForm.schedule,
        startsOn: pledgeForm.startsOn || undefined,
        donorType: pledgeForm.donorType,
        isAnonymous: pledgeForm.isAnonymous,
        note: pledgeForm.note,
        asSelf: true,
      };
      const { data } = await api.post('/giving/pledges', payload);
      setNotice(data.message);
      setPledgeForm({
        amount: '',
        schedule: 'one-off',
        startsOn: '',
        donorType: 'parent',
        isAnonymous: false,
        note: '',
      });
      await Promise.all([loadCampaigns(), loadMine()]);
      setTab('mine');
    } catch (err) {
      setError(readError(err, 'Could not record the pledge'));
    }
  };

  const submitPayment = async (event) => {
    event.preventDefault();
    if (!pledgeDetail) return;
    clearMessages();
    try {
      const { data } = await api.post(`/giving/pledges/${pledgeDetail._id}/payments`, paymentForm);
      // The idempotent repeat comes back as a success saying nothing changed,
      // which is exactly what a retried request should be told.
      setNotice(data.message);
      setPledgeDetail(data.data);
      setPaymentForm({
        reference: '',
        amount: '',
        method: 'bank-transfer',
        receivedOn: '',
        note: '',
      });
      await Promise.all([loadCampaigns(), loadOverdue(), loadStats()]);
    } catch (err) {
      setError(readError(err, 'Could not record the payment'));
    }
  };

  const waive = async (index) => {
    if (!pledgeDetail) return;
    const reason = window.prompt('Why is this instalment being waived? It stays on the record.');
    if (!reason) return;
    clearMessages();
    try {
      const { data } = await api.patch(
        `/giving/pledges/${pledgeDetail._id}/instalments/${index}/waive`,
        { reason }
      );
      setNotice(data.message);
      setPledgeDetail(data.data);
      await Promise.all([loadCampaigns(), loadOverdue()]);
    } catch (err) {
      setError(readError(err, 'Could not waive the instalment'));
    }
  };

  const cancelPledge = async (pledgeId) => {
    const reason = window.prompt('Why is this pledge being cancelled?');
    if (!reason) return;
    clearMessages();
    try {
      const { data } = await api.patch(`/giving/pledges/${pledgeId}/cancel`, { reason });
      setNotice(data.message);
      await Promise.all([loadMine(), loadCampaigns()]);
      if (pledgeDetail && pledgeDetail._id === pledgeId) await loadPledge(pledgeId);
    } catch (err) {
      setError(readError(err, 'Could not cancel the pledge'));
    }
  };

  // -- render ----------------------------------------------------------------

  const schedules = meta?.schedules || Object.keys(SCHEDULE_LABELS);
  const donorTypes = meta?.donorTypes || ['parent', 'alumnus', 'staff', 'corporate', 'trust'];
  const methods = meta?.methods || ['bank-transfer', 'upi', 'cheque', 'cash', 'card'];

  const tabs = [
    { key: 'campaigns', label: 'Appeals' },
    { key: 'mine', label: 'My giving' },
    ...(isAdmin
      ? [{ key: 'ledger', label: `Ledger${overdue.length ? ` (${overdue.length})` : ''}` }]
      : []),
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <header>
        <h1 className="text-2xl font-semibold text-gray-800">Giving</h1>
        <p className="mt-1 text-sm text-gray-600 max-w-2xl">
          A promise and a payment are two different facts, and every figure here shows both. What
          has been received is the solid bar; what has been pledged is the lighter one behind it.
        </p>
      </header>

      {isAdmin && stats && (
        <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="text-xs uppercase tracking-wide text-gray-500">Received</div>
            <div className="mt-1 text-2xl font-semibold text-blue-700">
              {money(stats.totalReceived)}
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="text-xs uppercase tracking-wide text-gray-500">Pledged</div>
            <div className="mt-1 text-2xl font-semibold text-gray-800">
              {money(stats.totalPledged)}
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="text-xs uppercase tracking-wide text-gray-500">Outstanding</div>
            <div className="mt-1 text-2xl font-semibold text-gray-800">
              {money(stats.totalOutstanding)}
            </div>
          </div>
          <div
            className={`rounded-lg border p-4 ${
              stats.overduePledges ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-white'
            }`}
          >
            <div className="text-xs uppercase tracking-wide text-gray-500">Overdue pledges</div>
            <div className="mt-1 text-2xl font-semibold text-gray-800">{stats.overduePledges}</div>
          </div>
        </div>
      )}

      {(error || notice) && (
        <div
          className={`mt-4 rounded-md px-4 py-3 text-sm ${
            error
              ? 'bg-red-50 text-red-700 border border-red-200'
              : 'bg-green-50 text-green-700 border border-green-200'
          }`}
        >
          {error || notice}
        </div>
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

      {tab === 'campaigns' && (
        <section className="mt-6 grid gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            {campaigns.length === 0 && !loading ? (
              <p className="text-sm text-gray-500">There are no open appeals at the moment.</p>
            ) : (
              campaigns.map((campaign) => (
                <article
                  key={campaign._id}
                  className={`rounded-lg border bg-white p-5 transition ${
                    selected && selected._id === campaign._id
                      ? 'border-blue-400 ring-1 ring-blue-100'
                      : 'border-gray-200'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="font-semibold text-gray-800">{campaign.title}</h2>
                      <p className="text-xs text-gray-500">
                        {CATEGORY_LABELS[campaign.category] || campaign.category} ·{' '}
                        {campaign.pledgeCount ?? campaign.progress.pledgeCount} pledge
                        {(campaign.progress.pledgeCount ?? 0) === 1 ? '' : 's'}
                      </p>
                    </div>
                    {campaign.visibility === 'internal' && (
                      <span className="px-2 py-0.5 rounded text-xs bg-slate-100 text-slate-600">
                        Internal
                      </span>
                    )}
                  </div>

                  <p className="mt-2 text-sm text-gray-600">{campaign.purpose}</p>

                  <div className="mt-4">
                    <ProgressBars
                      progress={campaign.progress}
                      goal={campaign.goalAmount}
                      currency={campaign.currency}
                    />
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    {campaign.blockedReason ? (
                      <span className="text-xs text-gray-500">{campaign.blockedReason}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(campaign);
                          loadLeaderboard(campaign._id);
                          clearMessages();
                        }}
                        className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition"
                      >
                        Pledge
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(campaign);
                        loadLeaderboard(campaign._id);
                      }}
                      className="text-sm text-blue-600 hover:underline"
                    >
                      Supporters
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>

          {selected && (
            <div className="space-y-4">
              <form
                onSubmit={submitPledge}
                className="rounded-lg border border-gray-200 bg-white p-5 space-y-4"
              >
                <h3 className="text-sm font-semibold text-gray-700">Pledge to {selected.title}</h3>

                <div className="grid grid-cols-2 gap-3">
                  <label className="text-sm">
                    <span className="block text-gray-600 mb-1">Amount</span>
                    <input
                      required
                      type="number"
                      min="1"
                      value={pledgeForm.amount}
                      onChange={(e) => setPledgeForm({ ...pledgeForm, amount: e.target.value })}
                      className="w-full rounded border border-gray-300 px-3 py-2"
                    />
                  </label>
                  <label className="text-sm">
                    <span className="block text-gray-600 mb-1">Paid</span>
                    <select
                      value={pledgeForm.schedule}
                      onChange={(e) => setPledgeForm({ ...pledgeForm, schedule: e.target.value })}
                      className="w-full rounded border border-gray-300 px-3 py-2"
                    >
                      {schedules.map((key) => (
                        <option key={key} value={key}>
                          {SCHEDULE_LABELS[key] || key}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm">
                    <span className="block text-gray-600 mb-1">Starting</span>
                    <input
                      type="date"
                      value={pledgeForm.startsOn}
                      onChange={(e) => setPledgeForm({ ...pledgeForm, startsOn: e.target.value })}
                      className="w-full rounded border border-gray-300 px-3 py-2"
                    />
                  </label>
                  <label className="text-sm">
                    <span className="block text-gray-600 mb-1">I am a</span>
                    <select
                      value={pledgeForm.donorType}
                      onChange={(e) => setPledgeForm({ ...pledgeForm, donorType: e.target.value })}
                      className="w-full rounded border border-gray-300 px-3 py-2"
                    >
                      {donorTypes.map((key) => (
                        <option key={key} value={key}>
                          {key.replace(/-/g, ' ')}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={pledgeForm.isAnonymous}
                    onChange={(e) =>
                      setPledgeForm({ ...pledgeForm, isAnonymous: e.target.checked })
                    }
                    className="mt-1"
                  />
                  <span className="text-gray-600">
                    Give anonymously
                    <span className="block text-xs text-gray-500">
                      Your name is hidden from the supporters list and the appeal page. The school
                      still holds it, so your receipt can be issued in your name.
                    </span>
                  </span>
                </label>

                {/* The schedule, before committing rather than after. */}
                {schedulePreview.length > 0 && (
                  <div className="rounded border border-gray-200 bg-gray-50 p-3">
                    <p className="text-xs font-medium text-gray-700">
                      {schedulePreview.length} instalment
                      {schedulePreview.length === 1 ? '' : 's'}
                    </p>
                    <ul className="mt-2 max-h-40 overflow-y-auto space-y-1 text-xs text-gray-600">
                      {schedulePreview.map((row, index) => (
                        <li key={index} className="flex justify-between">
                          <span>{shortDate(row.dueOn)}</span>
                          <span>{money(row.amount, selected.currency)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <button
                  type="submit"
                  className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition"
                >
                  Pledge {pledgeForm.amount ? money(pledgeForm.amount, selected.currency) : ''}
                </button>
              </form>

              <div className="rounded-lg border border-gray-200 bg-white p-5">
                <h3 className="text-sm font-semibold text-gray-700">Supporters</h3>
                <ul className="mt-2 space-y-1 text-sm">
                  {leaderboard.map((row, index) => (
                    <li key={index} className="flex justify-between">
                      <span className={row.isAnonymous ? 'text-gray-500 italic' : 'text-gray-800'}>
                        {row.donorName}
                      </span>
                      <span className="text-gray-600">
                        {money(row.amountReceived, selected.currency)}
                      </span>
                    </li>
                  ))}
                  {leaderboard.length === 0 && (
                    <li className="text-sm text-gray-500">No gifts received yet.</li>
                  )}
                </ul>
              </div>
            </div>
          )}
        </section>
      )}

      {tab === 'mine' && (
        <section className="mt-6">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="text-xs uppercase tracking-wide text-gray-500">Given</div>
              <div className="mt-1 text-2xl font-semibold text-blue-700">
                {money(myTotals.totalGiven)}
              </div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="text-xs uppercase tracking-wide text-gray-500">Still to pay</div>
              <div className="mt-1 text-2xl font-semibold text-gray-800">
                {money(myTotals.totalOutstanding)}
              </div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="text-xs uppercase tracking-wide text-gray-500">Pledges</div>
              <div className="mt-1 text-2xl font-semibold text-gray-800">{myPledges.length}</div>
            </div>
          </div>

          <div className="mt-6 space-y-4">
            {myPledges.length === 0 ? (
              <p className="text-sm text-gray-500">You have not pledged to anything yet.</p>
            ) : (
              myPledges.map((pledge) => (
                <article key={pledge._id} className="rounded-lg border border-gray-200 bg-white p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold text-gray-800">{pledge.campaignTitle}</h3>
                      <p className="text-xs text-gray-500">
                        {money(pledge.amount)} · {SCHEDULE_LABELS[pledge.schedule] || pledge.schedule}
                        {pledge.isAnonymous ? ' · anonymous' : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusChip status={pledge.status} />
                      {pledge.status !== 'cancelled' && pledge.status !== 'lapsed' && (
                        <button
                          type="button"
                          onClick={() => cancelPledge(pledge._id)}
                          className="text-xs text-red-600 hover:underline"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                    <span className="text-blue-700 font-medium">
                      {money(pledge.amountReceived)} paid
                    </span>
                    <span className="text-gray-600">
                      {money(pledge.amountOutstanding)} outstanding
                    </span>
                    {pledge.nextDueOn && (
                      <span className="text-gray-500">
                        next {money(pledge.nextDueAmount)} on {shortDate(pledge.nextDueOn)}
                      </span>
                    )}
                    {pledge.overdueCount > 0 && (
                      <span className="text-red-600 font-medium">
                        {pledge.overdueCount} overdue ({money(pledge.overdueAmount)})
                      </span>
                    )}
                  </div>

                  {(pledge.payments || []).length > 0 && (
                    <div className="mt-4">
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Receipts
                      </h4>
                      <ul className="mt-1 space-y-1 text-xs">
                        {pledge.payments.map((payment) => (
                          <li key={payment._id} className="flex flex-wrap justify-between gap-2">
                            <span className="font-mono text-gray-700">{payment.receiptSerial}</span>
                            <span className="text-gray-600">
                              {money(payment.amount)} · {shortDate(payment.receivedOn)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </article>
              ))
            )}
          </div>
        </section>
      )}

      {tab === 'ledger' && isAdmin && (
        <section className="mt-6 grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="text-sm font-semibold text-gray-700">
              Overdue instalments{overdue.length ? ` (${overdue.length})` : ''}
            </h3>
            <div className="mt-2 space-y-2">
              {overdue.length === 0 ? (
                <p className="text-sm text-gray-500">Nothing is overdue.</p>
              ) : (
                overdue.map((row) => (
                  <article
                    key={row._id}
                    className="rounded-lg border border-gray-200 bg-white p-4 flex flex-wrap items-start justify-between gap-3"
                  >
                    <div>
                      <div className="font-medium text-gray-800">{row.donorName}</div>
                      <div className="text-xs text-gray-500">
                        {row.campaignTitle} · {money(row.amount)} pledged
                      </div>
                      <div className="mt-1 text-xs text-red-600 font-medium">
                        {money(row.overdueAmount)} overdue since {shortDate(row.oldestDueOn)} (
                        {row.daysOverdue} days)
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        loadPledge(row._id);
                        setPaymentForm((form) => ({
                          ...form,
                          amount: String(row.overdueAmount),
                        }));
                      }}
                      className="text-sm text-blue-600 hover:underline"
                    >
                      Record a payment
                    </button>
                  </article>
                ))
              )}
            </div>
          </div>

          {pledgeDetail && (
            <div className="space-y-4">
              <div className="rounded-lg border border-gray-200 bg-white p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-gray-800">{pledgeDetail.donorName}</h3>
                    <p className="text-xs text-gray-500">
                      {money(pledgeDetail.amount)} pledged ·{' '}
                      {money(pledgeDetail.amountReceived)} received ·{' '}
                      {money(pledgeDetail.amountOutstanding)} outstanding
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPledgeDetail(null)}
                    className="text-sm text-gray-500 hover:text-gray-700"
                  >
                    Close
                  </button>
                </div>

                <ul className="mt-4 space-y-1 text-sm">
                  {(pledgeDetail.instalments || []).map((instalment) => (
                    <li
                      key={instalment._id}
                      className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 py-1"
                    >
                      <span className={instalment.overdue ? 'text-red-600' : 'text-gray-700'}>
                        {shortDate(instalment.dueOn)}
                      </span>
                      <span className="text-gray-600">
                        {money(instalment.paidAmount)} / {money(instalment.amount)}
                      </span>
                      <span className="text-xs text-gray-500">
                        {INSTALMENT_LABELS[instalment.status] || instalment.status}
                      </span>
                      {instalment.status !== 'paid' && instalment.status !== 'waived' && (
                        <button
                          type="button"
                          onClick={() => waive(instalment.index)}
                          className="text-xs text-amber-700 hover:underline"
                        >
                          Waive
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              <form
                onSubmit={submitPayment}
                className="rounded-lg border border-gray-200 bg-white p-5 space-y-4"
              >
                <h3 className="text-sm font-semibold text-gray-700">Record a payment</h3>

                {/* The field the idempotency hangs on, so it leads. */}
                <label className="block text-sm">
                  <span className="block text-gray-600 mb-1">
                    Reference
                    <span className="block text-xs text-gray-500">
                      The UTR, cheque number or transaction id. Recording the same reference twice
                      does nothing, so a retry is always safe.
                    </span>
                  </span>
                  <input
                    required
                    value={paymentForm.reference}
                    onChange={(e) => setPaymentForm({ ...paymentForm, reference: e.target.value })}
                    className="w-full rounded border border-gray-300 px-3 py-2 font-mono"
                  />
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <label className="text-sm">
                    <span className="block text-gray-600 mb-1">Amount</span>
                    <input
                      required
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={paymentForm.amount}
                      onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })}
                      className="w-full rounded border border-gray-300 px-3 py-2"
                    />
                  </label>
                  <label className="text-sm">
                    <span className="block text-gray-600 mb-1">Method</span>
                    <select
                      value={paymentForm.method}
                      onChange={(e) => setPaymentForm({ ...paymentForm, method: e.target.value })}
                      className="w-full rounded border border-gray-300 px-3 py-2"
                    >
                      {methods.map((key) => (
                        <option key={key} value={key}>
                          {key.replace(/-/g, ' ')}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm col-span-2">
                    <span className="block text-gray-600 mb-1">Received on</span>
                    <input
                      type="date"
                      value={paymentForm.receivedOn}
                      onChange={(e) =>
                        setPaymentForm({ ...paymentForm, receivedOn: e.target.value })
                      }
                      className="w-full rounded border border-gray-300 px-3 py-2"
                    />
                  </label>
                </div>

                <button
                  type="submit"
                  className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition"
                >
                  Record and issue a receipt
                </button>
              </form>
            </div>
          )}
        </section>
      )}
    </div>
  );
};

export default GivingCampaigns;
