import { useState, useEffect, useCallback, useContext, useMemo } from 'react';
import {
  CalendarClock,
  AlertTriangle,
  CheckCircle2,
  Search,
  ShieldCheck,
  Ban,
  Wallet,
} from 'lucide-react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * Instalment plans against fee invoices.
 *
 * The panel is built around the preview. A bursar picks an invoice, types a
 * number of instalments, and sees the real dates and the real amounts before
 * the plan exists — including which instalment carries the rounding remainder,
 * because "why is the first one ₹34 more?" is otherwise a phone call.
 *
 * The two numbers that decide whether a plan can still be approved — the
 * balance it was drafted against and the balance now — are always shown
 * together. A plan that has gone stale should look like two numbers that
 * disagree, not like a rejection after the button.
 */

const STATUS_STYLES = {
  draft: 'bg-amber-100 text-amber-800',
  active: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  defaulted: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-200 text-gray-600',
};

const STATUS_LABELS = {
  draft: 'Awaiting approval',
  active: 'Active',
  completed: 'Settled in full',
  defaulted: 'Defaulted',
  cancelled: 'Cancelled',
};

const INSTALMENT_STYLES = {
  due: 'text-gray-600',
  'part-paid': 'text-amber-700',
  paid: 'text-green-700',
  waived: 'text-gray-400 line-through',
};

const FREQUENCY_LABELS = {
  weekly: 'Weekly',
  fortnightly: 'Fortnightly',
  monthly: 'Monthly',
  term: 'Per term',
};

const EMPTY_FORM = {
  instalmentCount: 3,
  downPayment: '',
  frequency: 'monthly',
  firstDueOn: '',
  graceDays: 5,
  reason: '',
};

const money = (value, currency = 'INR') =>
  `${currency === 'INR' ? '₹' : `${currency} `}${Number(value || 0).toLocaleString('en-IN')}`;

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

const shortDate = (value) =>
  value ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—';

/**
 * A key that survives a retry. Minted when the form opens, replaced only once a
 * plan has actually been created, so pressing the button twice sends the same
 * one and the server returns the plan rather than making a second.
 */
const mintRequestKey = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `ip-${crypto.randomUUID()}`;
  }
  return `ip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const defaultFirstDue = () => {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  return date.toISOString().slice(0, 10);
};

const InstalmentPlanPanel = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isStaff = role === 'admin' || role === 'staff';
  const isAdmin = role === 'admin';
  const myId = user?._id || user?.user?._id || user?.id || null;

  const [plans, setPlans] = useState([]);
  const [myPlans, setMyPlans] = useState([]);
  const [summary, setSummary] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [riskOnly, setRiskOnly] = useState(false);

  const [invoiceQuery, setInvoiceQuery] = useState('');
  const [invoiceResults, setInvoiceResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState(null);

  const [form, setForm] = useState({ ...EMPTY_FORM, firstDueOn: defaultFirstDue() });
  const [requestKey, setRequestKey] = useState(mintRequestKey);

  const [expandedId, setExpandedId] = useState('');
  const [payForm, setPayForm] = useState({ amount: '', reference: '', method: 'bank-transfer' });

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

  // ---- loading -------------------------------------------------------------

  const loadMine = useCallback(async () => {
    try {
      const res = await api.get('/fees/instalment-plans/mine');
      setMyPlans(res.data.data || []);
    } catch (err) {
      explain(err, 'Could not load your payment plans.');
    }
  }, []);

  const loadQueue = useCallback(async () => {
    if (!isStaff) return;

    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (riskOnly) params.set('atRisk', 'true');

      const [queueRes, summaryRes] = await Promise.all([
        api.get(`/fees/instalment-plans?${params.toString()}`),
        api.get('/fees/instalment-plans/summary'),
      ]);

      setPlans(queueRes.data.data || []);
      setSummary(summaryRes.data.data || null);
    } catch (err) {
      explain(err, 'Could not load the plan list.');
    } finally {
      setLoading(false);
    }
  }, [isStaff, statusFilter, riskOnly]);

  useEffect(() => {
    loadMine();
  }, [loadMine]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  // ---- drafting ------------------------------------------------------------

  const searchInvoices = async (event) => {
    event.preventDefault();
    setError('');

    try {
      const res = await api.get(
        `/fees/instalment-plans/schedulable?q=${encodeURIComponent(invoiceQuery)}`
      );
      setInvoiceResults(res.data.data || []);
    } catch (err) {
      explain(err, 'Could not search invoices.');
    }
  };

  /**
   * Ask the server what the schedule would be.
   *
   * Deliberately a server call rather than arithmetic in the browser: the
   * rounding rule lives in one place, and a preview computed differently from
   * the thing it previews is worse than no preview.
   */
  const loadPreview = useCallback(async (invoice, shape) => {
    if (!invoice) return;

    try {
      const params = new URLSearchParams({
        instalments: String(shape.instalmentCount || 3),
        downPayment: String(Number(shape.downPayment) || 0),
        frequency: shape.frequency || 'monthly',
      });
      if (shape.firstDueOn) params.set('firstDueOn', shape.firstDueOn);

      const res = await api.get(`/fees/invoices/${invoice._id}/plan-preview?${params.toString()}`);
      setPreview(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not build a preview.');
    }
  }, []);

  useEffect(() => {
    if (selected) loadPreview(selected, form);
  }, [selected, form, loadPreview]);

  const chooseInvoice = (invoice) => {
    setSelected(invoice);
    setInvoiceResults([]);
    setRequestKey(mintRequestKey());
  };

  const clearDraft = () => {
    setSelected(null);
    setPreview(null);
    setForm({ ...EMPTY_FORM, firstDueOn: defaultFirstDue() });
    setRequestKey(mintRequestKey());
  };

  const submitPlan = async (event) => {
    event.preventDefault();
    setError('');

    if (!selected) return;

    setBusyId('new');
    try {
      const res = await api.post('/fees/instalment-plans', {
        invoiceId: selected._id,
        instalmentCount: Number(form.instalmentCount),
        downPayment: Number(form.downPayment) || 0,
        frequency: form.frequency,
        firstDueOn: form.firstDueOn,
        graceDays: Number(form.graceDays),
        reason: form.reason,
        requestKey,
      });

      flash(res.data.message || 'Plan drafted.');
      clearDraft();
      loadQueue();
    } catch (err) {
      explain(err, 'Could not draft the plan.');
    } finally {
      setBusyId('');
    }
  };

  // ---- decisions -----------------------------------------------------------

  const act = async (planId, path, body, fallback) => {
    setError('');
    setBusyId(planId);

    try {
      const res = await api.patch(`/fees/instalment-plans/${planId}/${path}`, body || {});
      flash(res.data.message || 'Done.');
      loadQueue();
      loadMine();
    } catch (err) {
      explain(err, fallback);
    } finally {
      setBusyId('');
    }
  };

  const approve = (plan) => act(plan._id, 'approve', {}, 'Could not approve the plan.');

  const reject = (plan) => {
    const reason = window.prompt('Why is this plan being rejected?');
    if (!reason) return;
    return act(plan._id, 'reject', { reason }, 'Could not reject the plan.');
  };

  const cancel = (plan) => {
    const reason = window.prompt('Why is this plan being cancelled?');
    if (!reason) return;
    return act(plan._id, 'cancel', { reason }, 'Could not cancel the plan.');
  };

  const declareDefault = (plan) => {
    const reason = window.prompt('Note against the default (optional):') || '';
    return act(plan._id, 'default', { reason }, 'Could not default the plan.');
  };

  const waive = (plan, sequence) => {
    const reason = window.prompt(`Why is instalment ${sequence} being waived?`);
    if (!reason) return;

    setBusyId(plan._id);
    api
      .patch(`/fees/instalment-plans/${plan._id}/instalments/${sequence}/waive`, { reason })
      .then((res) => {
        flash(res.data.message || 'Instalment waived.');
        loadQueue();
      })
      .catch((err) => explain(err, 'Could not waive the instalment.'))
      .finally(() => setBusyId(''));
  };

  const recordPayment = async (plan) => {
    setError('');
    setBusyId(plan._id);

    try {
      const res = await api.post(`/fees/instalment-plans/${plan._id}/payments`, {
        amount: Number(payForm.amount),
        reference: payForm.reference,
        method: payForm.method,
      });

      flash(res.data.message || 'Payment recorded.');
      setPayForm({ amount: '', reference: '', method: 'bank-transfer' });
      loadQueue();
    } catch (err) {
      explain(err, 'Could not record the payment.');
    } finally {
      setBusyId('');
    }
  };

  // ---- pieces --------------------------------------------------------------

  const statusChip = (status) => (
    <span
      className={`text-xs px-2 py-0.5 rounded-full font-medium ${
        STATUS_STYLES[status] || 'bg-gray-100 text-gray-600'
      }`}
    >
      {STATUS_LABELS[status] || status}
    </span>
  );

  const scheduleRows = useMemo(() => preview?.schedule || [], [preview]);

  const scheduleTable = (rows, currency, options = {}) => (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
            <th className="py-2 pr-2 font-medium">#</th>
            <th className="py-2 pr-2 font-medium">Due</th>
            <th className="py-2 pr-2 font-medium text-right">Amount</th>
            {options.showPaid && <th className="py-2 pr-2 font-medium text-right">Paid</th>}
            {options.showPaid && <th className="py-2 pr-2 font-medium">State</th>}
            {options.onWaive && <th className="py-2 font-medium" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.sequence} className="border-b border-gray-50 last:border-0">
              <td className="py-2 pr-2 text-gray-400">{row.sequence}</td>
              <td className="py-2 pr-2 text-gray-700">{formatDate(row.dueOn)}</td>
              <td
                className={`py-2 pr-2 text-right font-medium ${
                  INSTALMENT_STYLES[row.status] || 'text-gray-700'
                }`}
              >
                {money(row.amount, currency)}
              </td>
              {options.showPaid && (
                <td className="py-2 pr-2 text-right text-gray-600">
                  {row.paidAmount ? money(row.paidAmount, currency) : '—'}
                </td>
              )}
              {options.showPaid && (
                <td className="py-2 pr-2 text-xs text-gray-500 capitalize">
                  {row.status.replace('-', ' ')}
                </td>
              )}
              {options.onWaive && (
                <td className="py-2 text-right">
                  {row.status !== 'paid' && row.status !== 'waived' && (
                    <button
                      type="button"
                      onClick={() => options.onWaive(row.sequence)}
                      className="text-xs text-gray-500 hover:text-red-600"
                    >
                      Waive
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  // ---- the family's own view ----------------------------------------------

  const familyView = (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-6">
      <div className="flex items-center gap-2 mb-4">
        <CalendarClock size={20} className="text-emerald-600" />
        <h2 className="text-lg font-bold text-gray-800">Your payment plan</h2>
      </div>

      {myPlans.length === 0 ? (
        <p className="text-sm text-gray-500">
          You do not have a payment plan. If paying in one go is difficult, the fees office can
          arrange one.
        </p>
      ) : (
        <div className="space-y-5">
          {myPlans.map((plan) => (
            <div key={plan._id} className="border border-gray-100 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <div className="font-semibold text-gray-800">
                    {plan.planNumber}
                    <span className="text-gray-400 font-normal">
                      {' '}
                      · {FREQUENCY_LABELS[plan.frequency] || plan.frequency}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    Invoice {plan.invoiceNumber} · {plan.instalmentCount} instalments
                  </div>
                </div>
                {statusChip(plan.status)}
              </div>

              {/* The next payment is the only thing most families open this for,
                  so it is the largest thing on the card. */}
              {plan.position?.nextDue && plan.status === 'active' && (
                <div className="bg-emerald-50 rounded-xl p-4 mb-3">
                  <div className="text-xs text-emerald-700">Next payment</div>
                  <div className="text-2xl font-bold text-emerald-800">
                    {money(
                      plan.position.nextDue.amount - plan.position.nextDue.paidAmount,
                      plan.currency
                    )}
                  </div>
                  <div className="text-xs text-emerald-700 mt-1">
                    due {formatDate(plan.position.nextDue.dueOn)}
                    {plan.position.nextDue.daysAway >= 0
                      ? ` · in ${plan.position.nextDue.daysAway} day(s)`
                      : ` · ${Math.abs(plan.position.nextDue.daysAway)} day(s) ago`}
                  </div>
                </div>
              )}

              {plan.position?.arrears > 0 && (
                <div className="bg-red-50 border border-red-100 text-red-700 rounded-xl p-3 mb-3 text-sm">
                  {money(plan.position.arrears, plan.currency)} of this plan is overdue. Please
                  contact the fees office.
                </div>
              )}

              {scheduleTable(plan.instalments, plan.currency, { showPaid: true })}

              <div className="flex justify-between text-sm mt-3 pt-3 border-t border-gray-100">
                <span className="text-gray-500">Still to pay</span>
                <span className="font-bold text-gray-800">
                  {money(plan.position?.outstanding, plan.currency)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  if (!isStaff) return familyView;

  // ---- the bursar's view ---------------------------------------------------

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-6">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <div className="flex items-center gap-2">
          <CalendarClock size={20} className="text-emerald-600" />
          <h2 className="text-lg font-bold text-gray-800">Instalment plans</h2>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-600 flex items-center gap-1">
            <input
              type="checkbox"
              checked={riskOnly}
              onChange={(event) => setRiskOnly(event.target.checked)}
            />
            At risk only
          </label>

          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All statuses</option>
            {Object.keys(STATUS_LABELS).map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-100 text-red-700 rounded-xl p-3 mb-4 text-sm flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-100 text-green-700 rounded-xl p-3 mb-4 text-sm flex items-center gap-2">
          <CheckCircle2 size={16} />
          {success}
        </div>
      )}

      {/* Scheduled debt and late debt are two different problems, so they are
          two different tiles rather than one "outstanding" figure. */}
      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          {[
            { label: 'Scheduled, not late', value: money(summary.scheduledOutstanding) },
            { label: 'Scheduled and overdue', value: money(summary.arrears) },
            { label: 'Plans at risk', value: summary.atRisk },
            { label: 'Awaiting approval', value: summary.awaitingApproval },
          ].map((tile) => (
            <div key={tile.label} className="bg-emerald-50 rounded-xl p-3">
              <div className="text-lg font-bold text-emerald-800">{tile.value}</div>
              <div className="text-xs text-emerald-700 mt-0.5">{tile.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* ---- draft a plan ---- */}
      <div className="border border-gray-100 rounded-xl p-4 mb-6">
        <h3 className="font-semibold text-gray-800 mb-3">Draft a plan</h3>

        <form onSubmit={searchInvoices} className="flex gap-2 mb-4">
          <input
            value={invoiceQuery}
            onChange={(event) => setInvoiceQuery(event.target.value)}
            placeholder="Search by student name"
            className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="px-4 py-2 bg-gray-800 text-white rounded-lg text-sm font-medium inline-flex items-center gap-1"
          >
            <Search size={15} /> Find
          </button>
        </form>

        {invoiceResults.length > 0 && !selected && (
          <div className="space-y-2 mb-4">
            {invoiceResults.map((invoice) => (
              <button
                key={invoice._id}
                type="button"
                disabled={Boolean(invoice.livePlanNumber)}
                onClick={() => chooseInvoice(invoice)}
                className="w-full text-left border border-gray-100 hover:border-emerald-300 disabled:opacity-50 disabled:hover:border-gray-100 rounded-lg px-3 py-2 text-sm transition"
              >
                <span className="font-medium text-gray-800">{invoice.invoiceNumber}</span>
                <span className="text-gray-500">
                  {' '}
                  · {invoice.studentName} · {money(invoice.balance, invoice.currency)} outstanding
                </span>
                {invoice.livePlanNumber && (
                  <span className="text-xs text-amber-700"> · already on {invoice.livePlanNumber}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {selected && (
          <form onSubmit={submitPlan}>
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm text-gray-700">
                <span className="font-semibold">{selected.invoiceNumber}</span> ·{' '}
                {selected.studentName}
              </div>
              <button
                type="button"
                onClick={clearDraft}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                Choose another
              </button>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <label className="text-sm">
                <span className="block text-xs text-gray-500 mb-1">Instalments</span>
                <input
                  type="number"
                  min="2"
                  max="24"
                  value={form.instalmentCount}
                  onChange={(event) =>
                    setForm({ ...form, instalmentCount: event.target.value })
                  }
                  className="w-full border border-gray-200 rounded-lg px-3 py-2"
                />
              </label>

              <label className="text-sm">
                <span className="block text-xs text-gray-500 mb-1">Down payment</span>
                <input
                  type="number"
                  min="0"
                  value={form.downPayment}
                  onChange={(event) => setForm({ ...form, downPayment: event.target.value })}
                  placeholder="0"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2"
                />
              </label>

              <label className="text-sm">
                <span className="block text-xs text-gray-500 mb-1">Frequency</span>
                <select
                  value={form.frequency}
                  onChange={(event) => setForm({ ...form, frequency: event.target.value })}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2"
                >
                  {Object.keys(FREQUENCY_LABELS).map((key) => (
                    <option key={key} value={key}>
                      {FREQUENCY_LABELS[key]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-sm">
                <span className="block text-xs text-gray-500 mb-1">First payment</span>
                <input
                  type="date"
                  value={form.firstDueOn}
                  onChange={(event) => setForm({ ...form, firstDueOn: event.target.value })}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2"
                />
              </label>
            </div>

            {preview && (
              <div className="bg-gray-50 rounded-xl p-4 mb-4">
                <div className="grid grid-cols-3 gap-3 mb-3">
                  <div>
                    <div className="text-xs text-gray-500">Invoice balance</div>
                    <div className="font-bold text-gray-800">
                      {money(preview.balance, preview.currency)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">Down payment</div>
                    <div className="font-bold text-gray-800">
                      {money(preview.downPayment, preview.currency)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">Scheduled</div>
                    <div className="font-bold text-gray-800">
                      {money(preview.balance - (preview.downPayment || 0), preview.currency)}
                    </div>
                  </div>
                </div>

                {preview.error ? (
                  <p className="text-sm text-red-600">{preview.error}</p>
                ) : (
                  <>
                    {scheduleTable(scheduleRows, preview.currency)}
                    {scheduleRows.length > 1 &&
                      scheduleRows[0].amount !== scheduleRows[1].amount && (
                        <p className="text-xs text-gray-500 mt-2">
                          Instalment 1 carries the rounding remainder, so the last payment is a
                          round figure.
                        </p>
                      )}
                  </>
                )}
              </div>
            )}

            <label className="text-sm block mb-3">
              <span className="block text-xs text-gray-500 mb-1">
                Why does this family need a schedule?
              </span>
              <textarea
                value={form.reason}
                onChange={(event) => setForm({ ...form, reason: event.target.value })}
                rows={2}
                required
                minLength={10}
                className="w-full border border-gray-200 rounded-lg px-3 py-2"
              />
            </label>

            <button
              type="submit"
              disabled={busyId === 'new' || Boolean(preview?.error)}
              className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
            >
              {busyId === 'new' ? 'Drafting…' : 'Draft plan for approval'}
            </button>
          </form>
        )}
      </div>

      {/* ---- the list ---- */}
      {loading ? (
        <p className="text-sm text-gray-500">Loading plans…</p>
      ) : plans.length === 0 ? (
        <p className="text-sm text-gray-500">No plans match that filter.</p>
      ) : (
        <div className="space-y-3">
          {plans.map((plan) => {
            const open = expandedId === plan._id;
            const mine = String(plan.draftedBy) === String(myId);

            return (
              <div key={plan._id} className="border border-gray-100 rounded-xl p-4">
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setExpandedId(open ? '' : plan._id)}
                    className="text-left flex-1"
                  >
                    <div className="font-semibold text-gray-800">
                      {plan.planNumber}
                      <span className="text-gray-400 font-normal"> · {plan.studentName}</span>
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {money(plan.principal, plan.currency)} over {plan.instalmentCount}{' '}
                      {FREQUENCY_LABELS[plan.frequency]?.toLowerCase()} payments · drafted by{' '}
                      {plan.draftedByName || 'staff'} on {shortDate(plan.draftedAt)}
                    </div>

                    {plan.position?.atRisk && (
                      <div className="text-xs text-red-600 mt-1 flex items-center gap-1">
                        <AlertTriangle size={12} />
                        {plan.position.missedCount} instalment(s) missed ·{' '}
                        {money(plan.position.arrears, plan.currency)} overdue
                      </div>
                    )}
                  </button>

                  <div className="flex flex-col items-end gap-2">
                    {statusChip(plan.status)}
                    <span className="text-xs text-gray-500">
                      {money(plan.position?.outstanding, plan.currency)} left
                    </span>
                  </div>
                </div>

                {open && (
                  <div className="mt-4 pt-4 border-t border-gray-100">
                    <p className="text-sm text-gray-600 mb-3">{plan.reason}</p>

                    {scheduleTable(plan.instalments, plan.currency, {
                      showPaid: true,
                      onWaive:
                        isAdmin && plan.status === 'active'
                          ? (sequence) => waive(plan, sequence)
                          : undefined,
                    })}

                    {plan.status === 'active' && (
                      <div className="mt-4 bg-gray-50 rounded-xl p-3">
                        <div className="text-xs text-gray-500 mb-2 flex items-center gap-1">
                          <Wallet size={13} /> Record a payment
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <input
                            type="number"
                            min="1"
                            value={payForm.amount}
                            onChange={(event) =>
                              setPayForm({ ...payForm, amount: event.target.value })
                            }
                            placeholder="Amount"
                            className="w-32 border border-gray-200 rounded-lg px-3 py-2 text-sm"
                          />
                          <input
                            value={payForm.reference}
                            onChange={(event) =>
                              setPayForm({ ...payForm, reference: event.target.value })
                            }
                            placeholder="Reference / UTR"
                            className="flex-1 min-w-[10rem] border border-gray-200 rounded-lg px-3 py-2 text-sm"
                          />
                          <button
                            type="button"
                            disabled={busyId === plan._id}
                            onClick={() => recordPayment(plan)}
                            className="px-3 py-2 bg-gray-800 text-white rounded-lg text-sm disabled:opacity-50"
                          >
                            Record
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2 mt-4">
                      {plan.status === 'draft' && isAdmin && !mine && (
                        <>
                          <button
                            type="button"
                            disabled={busyId === plan._id}
                            onClick={() => approve(plan)}
                            className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm inline-flex items-center gap-1 disabled:opacity-50"
                          >
                            <ShieldCheck size={14} /> Approve
                          </button>
                          <button
                            type="button"
                            disabled={busyId === plan._id}
                            onClick={() => reject(plan)}
                            className="px-3 py-1.5 border border-gray-200 text-gray-700 rounded-lg text-sm disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </>
                      )}

                      {plan.status === 'draft' && mine && (
                        <span className="text-xs text-gray-500 self-center">
                          You drafted this plan, so somebody else has to approve it.
                        </span>
                      )}

                      {plan.status === 'active' && isAdmin && plan.position?.atRisk && (
                        <button
                          type="button"
                          disabled={busyId === plan._id}
                          onClick={() => declareDefault(plan)}
                          className="px-3 py-1.5 border border-red-200 text-red-700 rounded-lg text-sm disabled:opacity-50"
                        >
                          Mark defaulted
                        </button>
                      )}

                      {(plan.status === 'draft' || plan.status === 'active') && (
                        <button
                          type="button"
                          disabled={busyId === plan._id}
                          onClick={() => cancel(plan)}
                          className="px-3 py-1.5 border border-gray-200 text-gray-600 rounded-lg text-sm inline-flex items-center gap-1 disabled:opacity-50"
                        >
                          <Ban size={14} /> Cancel
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default InstalmentPlanPanel;
