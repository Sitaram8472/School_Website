import { useState, useEffect, useContext, useCallback } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * Staff payroll.
 *
 * A member of staff sees their own payslips and the lines that produced the
 * net — the same lines the office used, not a re-typed summary, because "why is
 * my salary short this month" is the question payroll answers most often and
 * the honest answer is always one of these rows.
 *
 * An admin gets the run editor. Everything the server derives is rendered as a
 * read-only figure with its inputs beside it, so the person entering knows
 * which numbers are theirs and which are not. The lock dialogue says what lock
 * means before it happens: serials issued, nothing editable afterwards, and no
 * way back other than cancelling the whole run.
 */

const EARNING_LABELS = {
  basic: 'Basic',
  hra: 'House rent allowance',
  da: 'Dearness allowance',
  transport: 'Transport',
  special: 'Special allowance',
  arrears: 'Arrears',
  bonus: 'Bonus',
};

const DEDUCTION_LABELS = {
  'provident-fund': 'Provident fund',
  'professional-tax': 'Professional tax',
  'income-tax': 'Income tax',
  insurance: 'Insurance',
  'loan-recovery': 'Loan recovery',
  other: 'Other',
};

const RUN_STATUS_STYLES = {
  draft: 'bg-slate-100 text-slate-700',
  computed: 'bg-indigo-100 text-indigo-700',
  locked: 'bg-green-100 text-green-700',
  paid: 'bg-blue-100 text-blue-700',
  cancelled: 'bg-gray-200 text-gray-600',
};

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const emptyRun = {
  period: '',
  payDate: '',
  workingDays: 26,
  notes: '',
};

const emptyPayslip = {
  staff: '',
  designation: '',
  unpaidLeaveDays: 0,
  basic: 0,
  hra: 0,
  da: 0,
  transport: 0,
  special: 0,
  incomeTax: 0,
  insurance: 0,
  loanRecovery: 0,
};

const currentPeriod = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

const periodLabel = (period) => {
  if (!period) return '—';
  const [year, month] = period.split('-').map(Number);
  if (!MONTHS[month - 1]) return period;
  return `${MONTHS[month - 1]} ${year}`;
};

const rupees = (value) =>
  typeof value === 'number' ? `₹${value.toLocaleString('en-IN')}` : '—';

const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
};

const StatusChip = ({ status }) => (
  <span
    className={`px-2 py-0.5 rounded text-xs font-medium ${
      RUN_STATUS_STYLES[status] || 'bg-gray-100 text-gray-600'
    }`}
  >
    {status}
  </span>
);

/** The lines behind a net figure, on both sides, with the derivation named. */
const PayslipDetail = ({ payslip }) => (
  <div className="grid md:grid-cols-2 gap-6 mt-4">
    <div>
      <h4 className="text-sm font-semibold text-gray-700 mb-2">Earnings</h4>
      <table className="w-full text-sm">
        <tbody>
          {payslip.earnings?.map((line) => (
            <tr key={line.code} className="border-b last:border-0">
              <td className="py-1 text-gray-600">{EARNING_LABELS[line.code] || line.code}</td>
              <td className="py-1 text-right font-medium">{rupees(line.amount)}</td>
            </tr>
          ))}
          <tr className="border-t">
            <td className="py-1 font-semibold">Gross</td>
            <td className="py-1 text-right font-semibold">{rupees(payslip.grossEarnings)}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div>
      <h4 className="text-sm font-semibold text-gray-700 mb-2">Deductions</h4>
      <table className="w-full text-sm">
        <tbody>
          {payslip.deductions?.map((line) => (
            <tr key={line.code} className="border-b last:border-0">
              <td className="py-1 text-gray-600">{DEDUCTION_LABELS[line.code] || line.code}</td>
              <td className="py-1 text-right font-medium">{rupees(line.amount)}</td>
            </tr>
          ))}
          <tr className="border-t">
            <td className="py-1 font-semibold">Total</td>
            <td className="py-1 text-right font-semibold">{rupees(payslip.totalDeductions)}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div className="md:col-span-2 bg-gray-50 rounded p-3 text-sm">
      <p className="text-gray-700">
        Loss of pay: <span className="font-medium">{rupees(payslip.lossOfPay)}</span> ={' '}
        {rupees(payslip.grossEarnings)} ÷ {payslip.workingDaysSnapshot} working days ×{' '}
        {payslip.unpaidLeaveDays} unpaid day{payslip.unpaidLeaveDays === 1 ? '' : 's'}
      </p>
      <p className="text-lg font-semibold text-gray-900 mt-2">
        Net pay {rupees(payslip.netPay)}
        {payslip.serial && (
          <span className="ml-2 text-xs font-normal text-gray-500">{payslip.serial}</span>
        )}
      </p>
    </div>
  </div>
);

const StaffPayroll = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';

  const [tab, setTab] = useState('mine');
  const [meta, setMeta] = useState(null);

  const [payslips, setPayslips] = useState([]);
  const [openPayslip, setOpenPayslip] = useState(null);

  const [runs, setRuns] = useState([]);
  const [openRunId, setOpenRunId] = useState(null);
  const [runDetail, setRunDetail] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [showRunForm, setShowRunForm] = useState(false);
  const [runForm, setRunForm] = useState({ ...emptyRun, period: currentPeriod() });

  const [showSlipForm, setShowSlipForm] = useState(false);
  const [slipForm, setSlipForm] = useState({ ...emptyPayslip });

  const readError = (err, fallback) => err?.response?.data?.message || fallback;

  const clearMessages = () => {
    setError('');
    setNotice('');
  };

  const loadMeta = useCallback(async () => {
    try {
      const { data } = await api.get('/payroll/meta');
      setMeta(data.data);
    } catch {
      // The page still works; it just cannot show the slab table.
    }
  }, []);

  const loadMine = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/payroll/payslips/mine');
      setPayslips(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load your payslips'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRuns = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    try {
      const { data } = await api.get('/payroll/runs');
      setRuns(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load payroll runs'));
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  const loadRun = useCallback(async (runId) => {
    if (!runId) return;
    setLoading(true);
    try {
      const { data } = await api.get(`/payroll/runs/${runId}`);
      setRunDetail(data.data);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the run'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    if (tab === 'mine') loadMine();
    if (tab === 'runs') loadRuns();
  }, [tab, loadMine, loadRuns]);

  useEffect(() => {
    if (openRunId) loadRun(openRunId);
  }, [openRunId, loadRun]);

  const submitRun = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      const { data } = await api.post('/payroll/runs', {
        ...runForm,
        workingDays: Number(runForm.workingDays),
      });
      setNotice(data.message);
      setShowRunForm(false);
      setRunForm({ ...emptyRun, period: currentPeriod() });
      loadRuns();
    } catch (err) {
      setError(readError(err, 'Could not open the run'));
    }
  };

  const submitPayslip = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      await api.post(`/payroll/runs/${openRunId}/payslips`, {
        staff: slipForm.staff,
        designation: slipForm.designation,
        unpaidLeaveDays: Number(slipForm.unpaidLeaveDays),
        earnings: [
          { code: 'basic', amount: Number(slipForm.basic) },
          { code: 'hra', amount: Number(slipForm.hra) },
          { code: 'da', amount: Number(slipForm.da) },
          { code: 'transport', amount: Number(slipForm.transport) },
          { code: 'special', amount: Number(slipForm.special) },
        ].filter((line) => line.amount > 0),
        deductions: [
          { code: 'income-tax', amount: Number(slipForm.incomeTax) },
          { code: 'insurance', amount: Number(slipForm.insurance) },
          { code: 'loan-recovery', amount: Number(slipForm.loanRecovery) },
        ].filter((line) => line.amount > 0),
      });
      setNotice('Payslip added. Provident fund and professional tax were computed.');
      setShowSlipForm(false);
      setSlipForm({ ...emptyPayslip });
      loadRun(openRunId);
    } catch (err) {
      setError(readError(err, 'Could not add the payslip'));
    }
  };

  const recompute = async () => {
    clearMessages();
    try {
      const { data } = await api.post(`/payroll/runs/${openRunId}/recompute`);
      setNotice(data.message);
      loadRun(openRunId);
    } catch (err) {
      setError(readError(err, 'Could not recompute the run'));
    }
  };

  const lockRun = async () => {
    const totals = runDetail?.run?.totals;
    const confirmed = window.confirm(
      [
        'Locking issues a serial for every payslip and freezes every figure.',
        'There is no unlock: a correction means cancelling this run and issuing another.',
        totals ? `\nHeadcount ${totals.headcount} · net ${rupees(totals.net)}` : '',
      ].join('\n')
    );
    if (!confirmed) return;

    clearMessages();
    try {
      const { data } = await api.patch(`/payroll/runs/${openRunId}/lock`);
      setNotice(data.message);
      loadRun(openRunId);
      loadRuns();
    } catch (err) {
      setError(readError(err, 'Could not lock the run'));
    }
  };

  const markPaid = async () => {
    clearMessages();
    try {
      const { data } = await api.patch(`/payroll/runs/${openRunId}/mark-paid`);
      setNotice(data.message);
      loadRun(openRunId);
    } catch (err) {
      setError(readError(err, 'Could not mark the run paid'));
    }
  };

  const cancelRun = async () => {
    const reason = window.prompt('Why is this run being cancelled?');
    if (!reason) return;
    clearMessages();
    try {
      const { data } = await api.patch(`/payroll/runs/${openRunId}/cancel`, { reason });
      setNotice(data.message);
      loadRun(openRunId);
      loadRuns();
    } catch (err) {
      setError(readError(err, 'Could not cancel the run'));
    }
  };

  const removePayslip = async (payslipId) => {
    clearMessages();
    try {
      await api.delete(`/payroll/runs/${openRunId}/payslips/${payslipId}`);
      setNotice('Payslip removed.');
      loadRun(openRunId);
    } catch (err) {
      setError(readError(err, 'Could not remove the payslip'));
    }
  };

  const run = runDetail?.run;
  const runIsEditable = run && ['draft', 'computed'].includes(run.status);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Payroll</h1>
        <p className="text-gray-600 mt-1">
          Gross, loss of pay, provident fund, professional tax and net are computed here and never
          typed. Locking a run issues the serials and is one-way.
        </p>
      </header>

      <div className="flex gap-2 mb-6 border-b">
        <button
          type="button"
          onClick={() => setTab('mine')}
          className={`px-4 py-2 text-sm font-medium border-b-2 ${
            tab === 'mine'
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          My payslips
        </button>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setTab('runs')}
            className={`px-4 py-2 text-sm font-medium border-b-2 ${
              tab === 'runs'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Runs
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded bg-red-50 text-red-700 border border-red-200">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 px-4 py-3 rounded bg-green-50 text-green-700 border border-green-200">
          {notice}
        </div>
      )}
      {loading && <p className="text-gray-500 mb-4">Loading…</p>}

      {tab === 'mine' && (
        <section className="space-y-3">
          {payslips.length === 0 && !loading && (
            <p className="text-gray-500">
              No payslips yet. A payslip appears here once the month&apos;s run is locked.
            </p>
          )}

          {payslips.map((payslip) => (
            <article key={payslip._id} className="bg-white rounded-lg border">
              <button
                type="button"
                onClick={() =>
                  setOpenPayslip(openPayslip === payslip._id ? null : payslip._id)
                }
                className="w-full flex items-center justify-between px-5 py-4 text-left"
              >
                <div>
                  <p className="font-semibold text-gray-900">
                    {payslip.periodLabel || periodLabel(payslip.run?.period)}
                  </p>
                  <p className="text-sm text-gray-500">
                    {payslip.serial || 'Serial pending'} · paid {formatDate(payslip.run?.payDate)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-semibold text-gray-900">{rupees(payslip.netPay)}</p>
                  <p className="text-xs text-gray-500">net</p>
                </div>
              </button>

              {openPayslip === payslip._id && (
                <div className="px-5 pb-5 border-t">
                  <PayslipDetail payslip={payslip} />
                </div>
              )}
            </article>
          ))}
        </section>
      )}

      {tab === 'runs' && isAdmin && !openRunId && (
        <section>
          <div className="mb-4">
            <button
              type="button"
              onClick={() => setShowRunForm((open) => !open)}
              className="px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
            >
              {showRunForm ? 'Cancel' : 'Open a run'}
            </button>
          </div>

          {showRunForm && (
            <form onSubmit={submitRun} className="bg-white rounded-lg border p-5 mb-6">
              <div className="grid md:grid-cols-4 gap-4">
                <label className="text-sm">
                  <span className="text-gray-600">Period</span>
                  <input
                    required
                    value={runForm.period}
                    onChange={(e) => setRunForm({ ...runForm, period: e.target.value })}
                    placeholder="2026-08"
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Pay date</span>
                  <input
                    required
                    type="date"
                    value={runForm.payDate}
                    onChange={(e) => setRunForm({ ...runForm, payDate: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Working days</span>
                  <input
                    type="number"
                    min="15"
                    max="31"
                    value={runForm.workingDays}
                    onChange={(e) => setRunForm({ ...runForm, workingDays: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Note</span>
                  <input
                    value={runForm.notes}
                    onChange={(e) => setRunForm({ ...runForm, notes: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Working days is the divisor for loss of pay, so it is copied onto every payslip when
                it is computed.
              </p>
              <button
                type="submit"
                className="mt-4 px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
              >
                Open run
              </button>
            </form>
          )}

          <div className="space-y-3">
            {runs.map((item) => (
              <button
                key={item._id}
                type="button"
                onClick={() => setOpenRunId(item._id)}
                className="w-full text-left bg-white rounded-lg border p-4 hover:border-blue-400"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-gray-900">{periodLabel(item.period)}</p>
                    <p className="text-sm text-gray-600">
                      {item.totals?.headcount || 0} staff · net {rupees(item.totals?.net || 0)} ·
                      pay date {formatDate(item.payDate)}
                    </p>
                  </div>
                  <StatusChip status={item.status} />
                </div>
              </button>
            ))}
            {runs.length === 0 && !loading && <p className="text-gray-500">No payroll runs yet.</p>}
          </div>
        </section>
      )}

      {tab === 'runs' && isAdmin && openRunId && run && (
        <section>
          <button
            type="button"
            onClick={() => {
              setOpenRunId(null);
              setRunDetail(null);
            }}
            className="text-sm text-blue-700 mb-4"
          >
            ← All runs
          </button>

          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <h2 className="text-2xl font-semibold text-gray-900">{periodLabel(run.period)}</h2>
              <p className="text-sm text-gray-600">
                {run.workingDays} working days · pay date {formatDate(run.payDate)}
                {run.lockedAt && ` · locked ${formatDate(run.lockedAt)}`}
              </p>
            </div>
            <StatusChip status={run.status} />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
            {[
              { label: 'Headcount', value: run.totals?.headcount ?? 0, money: false },
              { label: 'Gross', value: run.totals?.gross ?? 0, money: true },
              { label: 'Loss of pay', value: run.totals?.lossOfPay ?? 0, money: true },
              { label: 'Deductions', value: run.totals?.deductions ?? 0, money: true },
              { label: 'Net', value: run.totals?.net ?? 0, money: true },
            ].map((cell) => (
              <div key={cell.label} className="bg-white rounded-lg border p-3 text-center">
                <div className="text-xl font-semibold text-gray-900">
                  {cell.money ? rupees(cell.value) : cell.value}
                </div>
                <div className="text-xs text-gray-500 uppercase tracking-wide">{cell.label}</div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2 mb-6">
            {runIsEditable && (
              <>
                <button
                  type="button"
                  onClick={() => setShowSlipForm((open) => !open)}
                  className="px-4 py-2 rounded border text-sm font-medium hover:bg-gray-50"
                >
                  {showSlipForm ? 'Cancel' : 'Add payslip'}
                </button>
                <button
                  type="button"
                  onClick={recompute}
                  className="px-4 py-2 rounded border text-sm font-medium hover:bg-gray-50"
                >
                  Recompute
                </button>
                <button
                  type="button"
                  onClick={lockRun}
                  className="px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
                >
                  Lock run
                </button>
              </>
            )}
            {run.status === 'locked' && (
              <button
                type="button"
                onClick={markPaid}
                className="px-4 py-2 rounded bg-green-600 text-white text-sm font-medium hover:bg-green-700"
              >
                Mark paid
              </button>
            )}
            {run.status !== 'cancelled' && (
              <button
                type="button"
                onClick={cancelRun}
                className="px-4 py-2 rounded border border-red-200 text-red-700 text-sm font-medium hover:bg-red-50"
              >
                Cancel run
              </button>
            )}
          </div>

          {showSlipForm && (
            <form onSubmit={submitPayslip} className="bg-white rounded-lg border p-5 mb-6">
              <div className="grid md:grid-cols-3 gap-4">
                <label className="text-sm md:col-span-2">
                  <span className="text-gray-600">Staff id</span>
                  <input
                    required
                    value={slipForm.staff}
                    onChange={(e) => setSlipForm({ ...slipForm, staff: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2 font-mono text-xs"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Designation</span>
                  <input
                    value={slipForm.designation}
                    onChange={(e) => setSlipForm({ ...slipForm, designation: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                {['basic', 'hra', 'da', 'transport', 'special'].map((code) => (
                  <label key={code} className="text-sm">
                    <span className="text-gray-600">{EARNING_LABELS[code]}</span>
                    <input
                      type="number"
                      min="0"
                      value={slipForm[code]}
                      onChange={(e) => setSlipForm({ ...slipForm, [code]: e.target.value })}
                      className="mt-1 w-full border rounded px-3 py-2"
                    />
                  </label>
                ))}
                <label className="text-sm">
                  <span className="text-gray-600">Unpaid leave (days)</span>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={slipForm.unpaidLeaveDays}
                    onChange={(e) =>
                      setSlipForm({ ...slipForm, unpaidLeaveDays: e.target.value })
                    }
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Income tax</span>
                  <input
                    type="number"
                    min="0"
                    value={slipForm.incomeTax}
                    onChange={(e) => setSlipForm({ ...slipForm, incomeTax: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Insurance</span>
                  <input
                    type="number"
                    min="0"
                    value={slipForm.insurance}
                    onChange={(e) => setSlipForm({ ...slipForm, insurance: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Loan recovery</span>
                  <input
                    type="number"
                    min="0"
                    value={slipForm.loanRecovery}
                    onChange={(e) => setSlipForm({ ...slipForm, loanRecovery: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
              </div>

              <p className="text-xs text-gray-500 mt-3">
                Provident fund ({meta ? `${Math.round(meta.providentFundRate * 100)}%` : '12%'} of
                basic) and professional tax are added by the server. Loss of pay is gross ÷{' '}
                {run.workingDays} × unpaid days.
              </p>

              <button
                type="submit"
                className="mt-4 px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
              >
                Add payslip
              </button>
            </form>
          )}

          <div className="bg-white rounded-lg border overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-4 py-2">Serial</th>
                  <th className="text-left px-4 py-2">Staff</th>
                  <th className="text-right px-4 py-2">Gross</th>
                  <th className="text-right px-4 py-2">Unpaid</th>
                  <th className="text-right px-4 py-2">Loss of pay</th>
                  <th className="text-right px-4 py-2">Deductions</th>
                  <th className="text-right px-4 py-2">Net</th>
                  {runIsEditable && <th className="px-4 py-2" />}
                </tr>
              </thead>
              <tbody>
                {runDetail.payslips.map((payslip) => (
                  <tr key={payslip._id} className="border-t">
                    <td className="px-4 py-2 font-mono text-xs">{payslip.serial || '—'}</td>
                    <td className="px-4 py-2">
                      {payslip.staff?.name || '—'}
                      <span className="block text-xs text-gray-500">
                        {payslip.designationSnapshot}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right">{rupees(payslip.grossEarnings)}</td>
                    <td className="px-4 py-2 text-right text-gray-500">
                      {payslip.unpaidLeaveDays}
                    </td>
                    <td className="px-4 py-2 text-right text-orange-700">
                      {rupees(payslip.lossOfPay)}
                    </td>
                    <td className="px-4 py-2 text-right">{rupees(payslip.totalDeductions)}</td>
                    <td className="px-4 py-2 text-right font-semibold">{rupees(payslip.netPay)}</td>
                    {runIsEditable && (
                      <td className="px-4 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => removePayslip(payslip._id)}
                          className="text-xs text-red-600 hover:underline"
                        >
                          remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {runDetail.payslips.length === 0 && (
              <p className="px-4 py-6 text-gray-500">No payslips in this run yet.</p>
            )}
          </div>
        </section>
      )}
    </div>
  );
};

export default StaffPayroll;
