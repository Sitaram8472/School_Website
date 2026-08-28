import { useState, useEffect, useCallback, useContext, useMemo } from 'react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * Cover claims and monthly payment batches.
 *
 * For a teacher the panel leads with the allowance, not with the claim form.
 * How much of the month's free cover is left is the number that decides whether
 * a claim is worth anything, and showing it afterwards turns an understood rule
 * into a complaint — "I claimed for four periods and got paid for one."
 *
 * For an admin it is one month at a time, because that is the unit the money
 * actually moves in. The lock button carries its consequence next to it: after
 * locking, nothing in that month changes.
 */

const STATUS_STYLES = {
  submitted: 'bg-amber-100 text-amber-800',
  approved: 'bg-blue-100 text-blue-700',
  paid: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-200 text-gray-600',
};

const STATUS_LABELS = {
  submitted: 'Awaiting approval',
  approved: 'Approved, not yet paid',
  paid: 'Paid',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const BATCH_STYLES = {
  open: 'bg-gray-200 text-gray-700',
  locked: 'bg-amber-100 text-amber-800',
  paid: 'bg-green-100 text-green-700',
};

const BAND_LABELS = {
  standard: 'Standard',
  specialist: 'Specialist',
  examination: 'Examination',
  residential: 'Residential',
};

const money = (value) => `₹${Number(value || 0).toLocaleString('en-IN')}`;

const hoursAndMinutes = (minutes) => {
  const total = Math.max(0, Number(minutes) || 0);
  const hours = Math.floor(total / 60);
  const rest = total % 60;

  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
};

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

const monthLabel = (monthKey) => {
  if (!monthKey) return '—';
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
  });
};

const previousMonthKey = () => {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() - 1);
  return date.toISOString().slice(0, 7);
};

const CoverClaimPanel = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isStaff = role === 'teacher' || role === 'admin';
  const isAdmin = role === 'admin';

  const [meta, setMeta] = useState(null);
  const [claimable, setClaimable] = useState([]);
  const [myClaims, setMyClaims] = useState([]);
  const [summary, setSummary] = useState(null);

  const [adminMonth, setAdminMonth] = useState(previousMonthKey);
  const [claims, setClaims] = useState([]);
  const [batches, setBatches] = useState([]);
  const [load, setLoad] = useState(null);

  const [band, setBand] = useState('standard');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 4000);
  };

  const explain = (err, fallback) =>
    setError(err?.response?.data?.message || err?.message || fallback);

  // ---- loading -------------------------------------------------------------

  const loadMeta = useCallback(async () => {
    if (!isStaff) return;
    try {
      const res = await api.get('/substitutions/claims/meta');
      setMeta(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load claim reference data.');
    }
  }, [isStaff]);

  const loadMine = useCallback(async () => {
    if (!isStaff) return;

    setLoading(true);
    try {
      const [claimableRes, minesRes, summaryRes] = await Promise.all([
        api.get('/substitutions/claims/claimable'),
        api.get('/substitutions/claims/mine'),
        api.get('/substitutions/claims/summary/mine'),
      ]);

      setClaimable(claimableRes.data.data || []);
      setMyClaims(minesRes.data.data || []);
      setSummary(summaryRes.data.data || null);
    } catch (err) {
      explain(err, 'Could not load your cover claims.');
    } finally {
      setLoading(false);
    }
  }, [isStaff]);

  const loadAdmin = useCallback(async () => {
    if (!isAdmin) return;

    try {
      const [claimsRes, batchesRes, loadRes] = await Promise.all([
        api.get(`/substitutions/claims?month=${adminMonth}`),
        api.get('/substitutions/claims/batches'),
        api.get(`/substitutions/claims/load?month=${adminMonth}`),
      ]);

      setClaims(claimsRes.data.data || []);
      setBatches(batchesRes.data.data || []);
      setLoad(loadRes.data.data || null);
    } catch (err) {
      explain(err, 'Could not load the month.');
    }
  }, [isAdmin, adminMonth]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    loadMine();
  }, [loadMine]);

  useEffect(() => {
    loadAdmin();
  }, [loadAdmin]);

  const batch = useMemo(
    () => batches.find((row) => row.monthKey === adminMonth) || null,
    [batches, adminMonth]
  );

  // ---- acting --------------------------------------------------------------

  const raiseClaim = async (row) => {
    setError('');
    setBusy(`${row.absence}:${row.periodId}`);

    try {
      const res = await api.post('/substitutions/claims', {
        absenceId: row.absence,
        periodId: row.periodId,
        band,
      });

      flash(res.data.message || 'Claim raised.');
      loadMine();
      loadAdmin();
    } catch (err) {
      explain(err, 'Could not raise the claim.');
    } finally {
      setBusy('');
    }
  };

  const decide = async (claim, verb, body) => {
    setError('');
    setBusy(claim._id);

    try {
      const res = await api.patch(`/substitutions/claims/${claim._id}/${verb}`, body || {});
      flash(res.data.message || 'Done.');
      loadMine();
      loadAdmin();
    } catch (err) {
      explain(err, `Could not ${verb} the claim.`);
    } finally {
      setBusy('');
    }
  };

  const reject = (claim) => {
    const reason = window.prompt('Why is this claim being rejected?');
    if (!reason) return;
    return decide(claim, 'reject', { reason });
  };

  const lockMonth = async (force = false) => {
    const confirmed = window.confirm(
      `Locking ${monthLabel(adminMonth)} freezes every claim in it. No new claim can be raised for that month and none of its claims can be approved, rejected or cancelled. Continue?`
    );
    if (!confirmed) return;

    setBusy('batch');
    try {
      const res = await api.post(`/substitutions/claims/batches/${adminMonth}/lock`, { force });
      flash(res.data.message || 'Month locked.');
      loadAdmin();
    } catch (err) {
      explain(err, 'Could not lock the month.');
    } finally {
      setBusy('');
    }
  };

  const unlockMonth = async () => {
    setBusy('batch');
    try {
      const res = await api.patch(`/substitutions/claims/batches/${adminMonth}/unlock`);
      flash(res.data.message || 'Month reopened.');
      loadAdmin();
    } catch (err) {
      explain(err, 'Could not reopen the month.');
    } finally {
      setBusy('');
    }
  };

  const payMonth = async () => {
    const reference = window.prompt('Payment reference:');
    if (!reference) return;

    setBusy('batch');
    try {
      const res = await api.patch(`/substitutions/claims/batches/${adminMonth}/pay`, { reference });
      flash(res.data.message || 'Month paid.');
      loadAdmin();
    } catch (err) {
      explain(err, 'Could not mark the month paid.');
    } finally {
      setBusy('');
    }
  };

  if (!isStaff) return null;

  const statusChip = (status) => (
    <span
      className={`text-xs px-2 py-0.5 rounded-full font-medium ${
        STATUS_STYLES[status] || 'bg-gray-100 text-gray-600'
      }`}
    >
      {STATUS_LABELS[status] || status}
    </span>
  );

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-6">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <h2 className="text-lg font-bold text-gray-800">Cover claims</h2>
        {summary && (
          <span className="text-xs text-gray-500">{monthLabel(summary.monthKey)}</span>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-100 text-red-700 rounded-xl p-3 mb-4 text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-100 text-green-700 rounded-xl p-3 mb-4 text-sm">
          {success}
        </div>
      )}

      {/* ---- the allowance, before the button ---- */}
      {summary && (
        <div className="bg-gray-50 rounded-xl p-4 mb-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: 'Free cover left this month', value: hoursAndMinutes(summary.allowanceLeft) },
              { label: 'Covered', value: hoursAndMinutes(summary.totalMinutes) },
              { label: 'Payable', value: hoursAndMinutes(summary.payableMinutes) },
              { label: 'Due to you', value: money(summary.grossAmount) },
            ].map((tile) => (
              <div key={tile.label}>
                <div className="text-lg font-bold text-gray-800">{tile.value}</div>
                <div className="text-xs text-gray-500 mt-0.5">{tile.label}</div>
              </div>
            ))}
          </div>

          <p className="text-xs text-gray-500 mt-3">
            The first {hoursAndMinutes(summary.allowanceMinutes)} of cover each month is expected
            and is not paid. Only what is over that becomes payable, and the allowance is used up
            in the order claims are made.
          </p>

          {summary.batchStatus !== 'open' && (
            <p className="text-xs text-amber-700 mt-2">
              {monthLabel(summary.monthKey)} was locked on {formatDate(summary.lockedAt)}. Its
              figures can no longer change.
            </p>
          )}
        </div>
      )}

      {/* ---- what can be claimed ---- */}
      <div className="mb-6">
        <div className="flex items-center justify-between gap-3 mb-2">
          <h3 className="font-semibold text-gray-800 text-sm">
            Cover you have taught and not claimed for
          </h3>

          {meta && (
            <select
              value={band}
              onChange={(event) => setBand(event.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1 text-xs"
            >
              {meta.bands.map((key) => (
                <option key={key} value={key}>
                  {BAND_LABELS[key] || key} · {money(meta.rateBands[key])}/hr
                </option>
              ))}
            </select>
          )}
        </div>

        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : claimable.length === 0 ? (
          <p className="text-sm text-gray-500">
            Nothing outstanding. Cover is claimable for {meta?.claimWindowDays || 45} days after
            the lesson.
          </p>
        ) : (
          <div className="space-y-2">
            {claimable.map((row) => (
              <div
                key={`${row.absence}-${row.periodId}`}
                className="flex flex-wrap items-center justify-between gap-3 border border-gray-100 rounded-lg px-3 py-2 text-sm"
              >
                <div>
                  <span className="font-medium text-gray-800">
                    {row.className} · {row.subject}
                  </span>
                  <div className="text-xs text-gray-500">
                    {formatDate(row.date)} · {row.periodLabel} · {hoursAndMinutes(row.minutes)} ·
                    covering {row.absentStaffName}
                  </div>
                  {row.monthLocked && (
                    <div className="text-xs text-amber-700 mt-0.5">
                      That month is locked — speak to the office.
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  disabled={
                    row.monthLocked || busy === `${row.absence}:${row.periodId}`
                  }
                  onClick={() => raiseClaim(row)}
                  className="text-xs px-3 py-1.5 bg-gray-800 text-white rounded-lg disabled:opacity-40"
                >
                  Claim
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- my claims ---- */}
      <div className="mb-6">
        <h3 className="font-semibold text-gray-800 text-sm mb-2">Your claims</h3>

        {myClaims.length === 0 ? (
          <p className="text-sm text-gray-500">You have not claimed for any cover yet.</p>
        ) : (
          <div className="space-y-2">
            {myClaims.map((claim) => (
              <div
                key={claim._id}
                className="flex flex-wrap items-start justify-between gap-3 border border-gray-100 rounded-lg px-3 py-2 text-sm"
              >
                <div>
                  <span className="font-medium text-gray-800">
                    {claim.className} · {formatDate(claim.date)}
                  </span>
                  <div className="text-xs text-gray-500">
                    {hoursAndMinutes(claim.minutes)} covered ·{' '}
                    {claim.allowanceMinutesApplied > 0 && (
                      <>
                        {hoursAndMinutes(claim.allowanceMinutesApplied)} from the allowance ·{' '}
                      </>
                    )}
                    {hoursAndMinutes(claim.payableMinutes)} payable · {money(claim.grossAmount)}
                  </div>
                  {claim.rejectionReason && (
                    <div className="text-xs text-red-600 mt-0.5">{claim.rejectionReason}</div>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {statusChip(claim.status)}
                  {claim.status === 'submitted' && (
                    <button
                      type="button"
                      disabled={busy === claim._id}
                      onClick={() => decide(claim, 'cancel')}
                      className="text-xs text-gray-500 hover:text-red-600 disabled:opacity-50"
                    >
                      Withdraw
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- the month, for an admin ---- */}
      {isAdmin && (
        <div className="border-t border-gray-100 pt-5">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
            <h3 className="font-semibold text-gray-800 text-sm">Payment batch</h3>

            <div className="flex items-center gap-2">
              <input
                type="month"
                value={adminMonth}
                onChange={(event) => setAdminMonth(event.target.value)}
                className="border border-gray-200 rounded-lg px-2 py-1 text-sm"
              />
              {batch && (
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    BATCH_STYLES[batch.status]
                  }`}
                >
                  {batch.status}
                </span>
              )}
            </div>
          </div>

          {load && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              {[
                { label: 'Staff who covered', value: load.totals.staff },
                { label: 'Cover taught', value: hoursAndMinutes(load.totals.minutesCovered) },
                { label: 'Never claimed for', value: hoursAndMinutes(load.totals.minutesUnclaimed) },
                { label: 'Month total', value: money(load.totals.grossAmount) },
              ].map((tile) => (
                <div key={tile.label} className="bg-gray-50 rounded-xl p-3">
                  <div className="text-lg font-bold text-gray-800">{tile.value}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{tile.label}</div>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-2 mb-4">
            {(!batch || batch.status === 'open') && (
              <button
                type="button"
                disabled={busy === 'batch'}
                onClick={() => lockMonth(false)}
                className="px-3 py-1.5 bg-amber-600 text-white rounded-lg text-sm disabled:opacity-50"
              >
                Lock {monthLabel(adminMonth)} — nothing in it changes afterwards
              </button>
            )}

            {batch && batch.status === 'locked' && (
              <>
                <button
                  type="button"
                  disabled={busy === 'batch'}
                  onClick={payMonth}
                  className="px-3 py-1.5 bg-green-600 text-white rounded-lg text-sm disabled:opacity-50"
                >
                  Mark paid
                </button>
                <button
                  type="button"
                  disabled={busy === 'batch'}
                  onClick={unlockMonth}
                  className="px-3 py-1.5 border border-gray-200 text-gray-700 rounded-lg text-sm disabled:opacity-50"
                >
                  Reopen
                </button>
              </>
            )}

            {batch && batch.status === 'paid' && (
              <span className="text-xs text-gray-500 self-center">
                Paid {formatDate(batch.paidAt)} against {batch.paymentReference}. This month cannot
                be reopened.
              </span>
            )}
          </div>

          {/* ---- claims in the month ---- */}
          {claims.length === 0 ? (
            <p className="text-sm text-gray-500 mb-4">No claims for {monthLabel(adminMonth)}.</p>
          ) : (
            <div className="space-y-2 mb-5">
              {claims.map((claim) => (
                <div
                  key={claim._id}
                  className="flex flex-wrap items-start justify-between gap-3 border border-gray-100 rounded-lg px-3 py-2 text-sm"
                >
                  <div>
                    <span className="font-medium text-gray-800">{claim.claimantName}</span>
                    <span className="text-gray-500">
                      {' '}
                      · {claim.className} · {formatDate(claim.date)}
                    </span>
                    <div className="text-xs text-gray-500">
                      {hoursAndMinutes(claim.minutes)} · {hoursAndMinutes(claim.payableMinutes)}{' '}
                      payable at {money(claim.ratePerHour)}/hr · {money(claim.grossAmount)}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {statusChip(claim.status)}
                    {claim.status === 'submitted' && (
                      <>
                        <button
                          type="button"
                          disabled={busy === claim._id}
                          onClick={() => decide(claim, 'approve')}
                          className="text-xs px-2 py-1 bg-emerald-600 text-white rounded disabled:opacity-50"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          disabled={busy === claim._id}
                          onClick={() => reject(claim)}
                          className="text-xs px-2 py-1 border border-gray-200 rounded disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ---- who is carrying the load ---- */}
          {load && load.rows.length > 0 && (
            <div>
              <h3 className="font-semibold text-gray-800 text-sm mb-2">
                Who covered, {monthLabel(adminMonth)}
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[32rem]">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                      <th className="py-2 pr-2 font-medium">Teacher</th>
                      <th className="py-2 pr-2 font-medium text-right">Covered</th>
                      <th className="py-2 pr-2 font-medium text-right">Claimed</th>
                      <th className="py-2 pr-2 font-medium text-right">Never claimed</th>
                      <th className="py-2 font-medium text-right">Due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {load.rows.map((row) => (
                      <tr key={row.staff} className="border-b border-gray-50 last:border-0">
                        <td className="py-2 pr-2 text-gray-800">{row.name}</td>
                        <td className="py-2 pr-2 text-right">
                          {hoursAndMinutes(row.minutesCovered)}
                        </td>
                        <td className="py-2 pr-2 text-right text-gray-600">
                          {hoursAndMinutes(row.minutesClaimed)}
                        </td>
                        <td
                          className={`py-2 pr-2 text-right ${
                            row.minutesUnclaimed > 0 ? 'text-amber-700' : 'text-gray-400'
                          }`}
                        >
                          {hoursAndMinutes(row.minutesUnclaimed)}
                        </td>
                        <td className="py-2 text-right font-medium">{money(row.grossAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Cover nobody claimed for is shown on purpose — the teacher who never asks is the
                one this table exists to find.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default CoverClaimPanel;
