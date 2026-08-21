import { useState, useEffect, useCallback, useContext, useMemo } from 'react';
import { RotateCcw, ShieldCheck, AlertTriangle, Search, Ban, CheckCircle2 } from 'lucide-react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * Refunds against fee invoices.
 *
 * The panel is built around one number — how much of this invoice can still be
 * given back — and it shows that number *before* an amount is typed rather than
 * after the server rejects one. Alongside it sits the list of refunds already
 * holding part of it, because a bursar who sees a smaller ceiling than they
 * expected will otherwise assume the figure is wrong.
 */

const REASON_LABELS = {
  overpayment: 'Overpayment',
  'duplicate-payment': 'Duplicate payment',
  'service-not-availed': 'Service not availed',
  withdrawal: 'Withdrawal',
  'billing-error': 'Billing error',
  'scholarship-adjustment': 'Scholarship adjustment',
  other: 'Other',
};

const METHOD_LABELS = {
  'bank-transfer': 'Bank transfer',
  cheque: 'Cheque',
  upi: 'UPI',
  cash: 'Cash',
  'credit-to-next-term': 'Credit to next term',
};

const STATUS_STYLES = {
  requested: 'bg-amber-100 text-amber-800',
  approved: 'bg-blue-100 text-blue-700',
  settled: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-200 text-gray-600',
};

const STATUS_LABELS = {
  requested: 'Awaiting approval',
  approved: 'Approved, not yet paid',
  settled: 'Settled',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const EMPTY_FORM = {
  amount: '',
  reason: 'overpayment',
  narrative: '',
  method: 'bank-transfer',
};

const money = (value, currency = 'INR') =>
  `${currency === 'INR' ? '₹' : `${currency} `}${Number(value || 0).toLocaleString('en-IN')}`;

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

/**
 * A key that survives a retry.
 *
 * The whole point of the idempotency key is that pressing the button twice
 * sends the *same* one, so it is minted when the form is opened and only
 * replaced once a refund has actually been created.
 */
const mintRequestKey = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `rf-${crypto.randomUUID()}`;
  }
  return `rf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const RefundPanel = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isStaff = role === 'admin' || role === 'staff';
  const isAdmin = role === 'admin';
  const myId = user?._id || user?.user?._id || user?.id || null;

  const [refunds, setRefunds] = useState([]);
  const [myRefunds, setMyRefunds] = useState([]);
  const [summary, setSummary] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');

  const [invoiceQuery, setInvoiceQuery] = useState('');
  const [invoiceResults, setInvoiceResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [ceiling, setCeiling] = useState(null);

  const [form, setForm] = useState(EMPTY_FORM);
  const [requestKey, setRequestKey] = useState(mintRequestKey);

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
      const res = await api.get('/fees/refunds/mine');
      setMyRefunds(res.data.data || []);
    } catch (err) {
      explain(err, 'Could not load your refunds.');
    }
  }, []);

  const loadQueue = useCallback(async () => {
    if (!isStaff) return;

    setLoading(true);
    try {
      const query = statusFilter ? `?status=${statusFilter}` : '';
      const [queueRes, summaryRes] = await Promise.all([
        api.get(`/fees/refunds${query}`),
        api.get('/fees/refunds/summary'),
      ]);
      setRefunds(queueRes.data.data || []);
      setSummary(summaryRes.data.data || null);
    } catch (err) {
      explain(err, 'Could not load the refund queue.');
    } finally {
      setLoading(false);
    }
  }, [isStaff, statusFilter]);

  useEffect(() => {
    loadMine();
  }, [loadMine]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  // ---- picking an invoice --------------------------------------------------

  const searchInvoices = async (event) => {
    event.preventDefault();
    setError('');

    if (!invoiceQuery.trim()) {
      setInvoiceResults([]);
      return;
    }

    try {
      const res = await api.get(`/fees/invoices?search=${encodeURIComponent(invoiceQuery.trim())}`);
      // Only invoices with money on them can be refunded, so filtering here
      // saves the bursar from picking one and being told no.
      setInvoiceResults((res.data.data || []).filter((invoice) => invoice.amountPaid > 0));
    } catch (err) {
      explain(err, 'Could not search invoices.');
    }
  };

  const chooseInvoice = async (invoice) => {
    setSelected(invoice);
    setCeiling(null);
    setForm(EMPTY_FORM);
    setRequestKey(mintRequestKey());
    setError('');

    try {
      const res = await api.get(`/fees/invoices/${invoice._id}/refundable`);
      setCeiling(res.data.data);
    } catch (err) {
      explain(err, 'Could not work out how much is refundable.');
    }
  };

  const refreshCeiling = useCallback(async () => {
    if (!selected) return;
    try {
      const res = await api.get(`/fees/invoices/${selected._id}/refundable`);
      setCeiling(res.data.data);
    } catch (err) {
      explain(err, 'Could not refresh the refundable amount.');
    }
  }, [selected]);

  const refundable = ceiling ? ceiling.refundable : 0;

  const amountIsOverCeiling = useMemo(() => {
    const value = Number(form.amount);
    return Boolean(form.amount) && !Number.isNaN(value) && value > refundable;
  }, [form.amount, refundable]);

  // ---- raising -------------------------------------------------------------

  const submitRefund = async (event) => {
    event.preventDefault();
    setError('');

    if (!selected) {
      setError('Pick an invoice first.');
      return;
    }

    const value = Number(form.amount);
    if (!value || Number.isNaN(value) || value <= 0) {
      setError('Enter a refund amount greater than zero.');
      return;
    }
    if (value > refundable) {
      setError(`Only ${money(refundable, selected.currency)} can still be refunded on this invoice.`);
      return;
    }
    if (form.reason === 'other' && !form.narrative.trim()) {
      setError('Describe the reason when choosing "other".');
      return;
    }

    setLoading(true);
    try {
      const res = await api.post('/fees/refunds', {
        invoiceId: selected._id,
        amount: value,
        reason: form.reason,
        narrative: form.narrative.trim(),
        method: form.method,
        requestKey,
      });

      flash(
        res.data.alreadyRequested
          ? 'That refund had already been raised — nothing was duplicated.'
          : 'Refund raised and sent for approval.'
      );

      setForm(EMPTY_FORM);
      setRequestKey(mintRequestKey());
      await Promise.all([loadQueue(), refreshCeiling(), loadMine()]);
    } catch (err) {
      explain(err, 'Could not raise the refund.');
    } finally {
      setLoading(false);
    }
  };

  // ---- deciding ------------------------------------------------------------

  const act = async (refund, action, payload = {}) => {
    setBusyId(refund._id);
    setError('');

    try {
      const res = await api.patch(`/fees/refunds/${refund._id}/${action}`, payload);
      flash(res.data.message || 'Done.');
      await Promise.all([loadQueue(), refreshCeiling(), loadMine()]);
    } catch (err) {
      explain(err, `Could not ${action} the refund.`);
    } finally {
      setBusyId('');
    }
  };

  const approve = (refund) => act(refund, 'approve', { note: '' });

  const reject = (refund) => {
    const reason = window.prompt('Why is this refund being rejected?');
    if (!reason || !reason.trim()) return;
    act(refund, 'reject', { reason: reason.trim() });
  };

  const settle = (refund) => {
    const reference = window.prompt('Settlement reference (bank UTR, cheque number, or blank):') || '';
    act(refund, 'settle', { settlementReference: reference.trim() });
  };

  const cancel = (refund) => act(refund, 'cancel');

  // A refund cannot be decided by the person who raised it. Showing the control
  // disabled with the reason teaches the rule; hiding it produces a support
  // ticket the first time someone hits the 403.
  const raisedByMe = (refund) => {
    const requester = refund.requestedBy?._id || refund.requestedBy;
    return myId && requester && String(requester) === String(myId);
  };

  // ---- rendering -----------------------------------------------------------

  const statusChip = (status) => (
    <span
      className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
        STATUS_STYLES[status] || 'bg-gray-100 text-gray-600'
      }`}
    >
      {STATUS_LABELS[status] || status}
    </span>
  );

  const studentView = (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-6">
      <div className="flex items-center gap-2 mb-4">
        <RotateCcw size={18} className="text-emerald-600" />
        <h2 className="text-lg font-bold text-gray-800">Refunds</h2>
      </div>

      {myRefunds.length === 0 ? (
        <p className="text-sm text-gray-500">
          No refunds have been raised on your account. If you have been billed for something you did
          not take, ask the fee office to raise one.
        </p>
      ) : (
        <div className="space-y-3">
          {myRefunds.map((refund) => (
            <div
              key={refund._id}
              className="border border-gray-100 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3"
            >
              <div>
                <div className="font-semibold text-gray-800">
                  {money(refund.amount, refund.currency)}
                  <span className="text-gray-400 font-normal"> · {REASON_LABELS[refund.reason]}</span>
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {refund.invoiceNumber} · raised {formatDate(refund.requestedAt)}
                  {refund.creditNoteNumber && ` · credit note ${refund.creditNoteNumber}`}
                </div>
                {refund.status === 'rejected' && refund.rejectionReason && (
                  <div className="text-xs text-red-600 mt-1">{refund.rejectionReason}</div>
                )}
              </div>
              {statusChip(refund.status)}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  if (!isStaff) return studentView;

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-6">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <div className="flex items-center gap-2">
          <RotateCcw size={20} className="text-emerald-600" />
          <h2 className="text-lg font-bold text-gray-800">Refunds &amp; credit notes</h2>
        </div>

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

      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          {[
            { label: 'Refunded to date', value: money(summary.totalRefunded) },
            { label: 'Approved, not yet paid', value: money(summary.committedNotYetPaid) },
            { label: 'Awaiting approval', value: summary.awaitingApproval },
            { label: 'Credit notes issued', value: summary.refundCount },
          ].map((tile) => (
            <div key={tile.label} className="bg-emerald-50 rounded-xl p-3">
              <div className="text-lg font-bold text-emerald-800">{tile.value}</div>
              <div className="text-xs text-emerald-700 mt-0.5">{tile.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* ---- raise a refund ---- */}
      <div className="border border-gray-100 rounded-xl p-4 mb-6">
        <h3 className="font-semibold text-gray-800 mb-3">Raise a refund</h3>

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
                onClick={() => chooseInvoice(invoice)}
                className="w-full text-left border border-gray-100 hover:border-emerald-300 rounded-lg px-3 py-2 text-sm transition"
              >
                <span className="font-medium text-gray-800">{invoice.invoiceNumber}</span>
                <span className="text-gray-500">
                  {' '}
                  · {invoice.studentName} · paid {money(invoice.amountPaid, invoice.currency)}
                </span>
              </button>
            ))}
          </div>
        )}

        {selected && (
          <>
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm text-gray-700">
                <span className="font-semibold">{selected.invoiceNumber}</span> · {selected.studentName}
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelected(null);
                  setCeiling(null);
                }}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                Choose another
              </button>
            </div>

            {/* The three figures that decide whether this refund is possible,
                shown before the amount is typed rather than after. */}
            {ceiling && (
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-xs text-gray-500">Paid in</div>
                  <div className="font-bold text-gray-800">{money(ceiling.amountPaid)}</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-xs text-gray-500">Already refunded or held</div>
                  <div className="font-bold text-gray-800">{money(ceiling.alreadyRefunded)}</div>
                </div>
                <div className="bg-emerald-50 rounded-lg p-3">
                  <div className="text-xs text-emerald-700">Refundable now</div>
                  <div className="font-bold text-emerald-800">{money(ceiling.refundable)}</div>
                </div>
              </div>
            )}

            {ceiling && ceiling.holds.length > 0 && (
              <div className="text-xs text-gray-500 mb-4">
                Held by{' '}
                {ceiling.holds
                  .map((hold) => `${money(hold.amount)} (${STATUS_LABELS[hold.status] || hold.status})`)
                  .join(', ')}
              </div>
            )}

            <form onSubmit={submitRefund} className="grid md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Amount</label>
                <input
                  type="number"
                  min="1"
                  max={refundable || undefined}
                  value={form.amount}
                  onChange={(event) => setForm({ ...form, amount: event.target.value })}
                  className={`w-full border rounded-lg px-3 py-2 text-sm ${
                    amountIsOverCeiling ? 'border-red-400 bg-red-50' : 'border-gray-200'
                  }`}
                />
                {amountIsOverCeiling && (
                  <p className="text-xs text-red-600 mt-1">
                    That is more than the {money(refundable)} still refundable.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Reason</label>
                <select
                  value={form.reason}
                  onChange={(event) => setForm({ ...form, reason: event.target.value })}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                >
                  {Object.keys(REASON_LABELS).map((reason) => (
                    <option key={reason} value={reason}>
                      {REASON_LABELS[reason]}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Method</label>
                <select
                  value={form.method}
                  onChange={(event) => setForm({ ...form, method: event.target.value })}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                >
                  {Object.keys(METHOD_LABELS).map((method) => (
                    <option key={method} value={method}>
                      {METHOD_LABELS[method]}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Note {form.reason === 'other' && <span className="text-red-500">*</span>}
                </label>
                <input
                  value={form.narrative}
                  onChange={(event) => setForm({ ...form, narrative: event.target.value })}
                  placeholder="What happened"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                />
              </div>

              <div className="md:col-span-2">
                <button
                  type="submit"
                  disabled={loading || refundable <= 0}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white rounded-lg text-sm font-medium"
                >
                  {refundable <= 0 ? 'Nothing left to refund' : 'Raise refund'}
                </button>
                <span className="text-xs text-gray-400 ml-3">
                  Raising this twice will not refund twice.
                </span>
              </div>
            </form>
          </>
        )}
      </div>

      {/* ---- the queue ---- */}
      <h3 className="font-semibold text-gray-800 mb-3">Refund queue</h3>

      {refunds.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing in the queue.</p>
      ) : (
        <div className="space-y-3">
          {refunds.map((refund) => {
            const mine = raisedByMe(refund);
            const busy = busyId === refund._id;

            return (
              <div key={refund._id} className="border border-gray-100 rounded-xl p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-gray-800">
                      {money(refund.amount, refund.currency)}
                      <span className="text-gray-400 font-normal">
                        {' '}
                        · {REASON_LABELS[refund.reason] || refund.reason} ·{' '}
                        {METHOD_LABELS[refund.method] || refund.method}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {refund.invoiceNumber} · {refund.studentName} · raised{' '}
                      {formatDate(refund.requestedAt)} by {refund.requestedBy?.name || 'staff'}
                    </div>
                    {refund.narrative && (
                      <div className="text-xs text-gray-600 mt-1 italic">{refund.narrative}</div>
                    )}
                    {refund.creditNoteNumber && (
                      <div className="text-xs text-green-700 mt-1 inline-flex items-center gap-1">
                        <ShieldCheck size={13} /> Credit note {refund.creditNoteNumber}
                      </div>
                    )}
                    {refund.rejectionReason && (
                      <div className="text-xs text-red-600 mt-1">{refund.rejectionReason}</div>
                    )}
                  </div>

                  <div className="flex flex-col items-end gap-2">
                    {statusChip(refund.status)}

                    <div className="flex gap-2">
                      {refund.status === 'requested' && isAdmin && (
                        <>
                          <button
                            type="button"
                            disabled={busy || mine}
                            title={mine ? 'You raised this refund, so you cannot approve it' : ''}
                            onClick={() => approve(refund)}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-500 text-white"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            disabled={busy || mine}
                            title={mine ? 'You raised this refund, so you cannot reject it' : ''}
                            onClick={() => reject(refund)}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-50 hover:bg-red-100 disabled:bg-gray-100 disabled:text-gray-400 text-red-700"
                          >
                            Reject
                          </button>
                        </>
                      )}

                      {refund.status === 'requested' && mine && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => cancel(refund)}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 hover:bg-gray-200 text-gray-700 inline-flex items-center gap-1"
                        >
                          <Ban size={13} /> Withdraw
                        </button>
                      )}

                      {refund.status === 'approved' && isAdmin && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => settle(refund)}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-200 text-white"
                        >
                          Settle &amp; issue credit note
                        </button>
                      )}
                    </div>

                    {refund.status === 'requested' && mine && isAdmin && (
                      <span className="text-[11px] text-gray-400">
                        You raised this — someone else has to approve it
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default RefundPanel;
