import { useState, useEffect, useCallback, useContext, useMemo } from 'react';
import {
  Building2,
  HandCoins,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  Ban,
  Clock,
} from 'lucide-react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * Employer matching gifts.
 *
 * The panel is built around one number — how much more this employer will give
 * on top of a gift the school has already received — and it shows that number,
 * with the limit that bound it named, *before* an amount is typed. A form that
 * says "the most you can claim here is ₹18,000, because this donor has ₹18,000
 * of their annual cap left" is a form that guides. One that accepts ₹25,000 and
 * then rejects it is a form that wastes the development office's afternoon.
 *
 * Matched money is shown next to donated money and never added into it. Three
 * separate figures — in the bank, asked for, refused — because they are three
 * different degrees of certainty and the reason this module exists is that the
 * school currently reports them as one.
 */

const CLAIM_STATUS_LABELS = {
  draft: 'Draft',
  submitted: 'With the employer',
  verified: 'Verified, awaiting payment',
  received: 'Received',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};

const CLAIM_STATUS_STYLES = {
  draft: 'bg-gray-200 text-gray-700',
  submitted: 'bg-amber-100 text-amber-800',
  verified: 'bg-blue-100 text-blue-700',
  received: 'bg-green-100 text-green-700',
  declined: 'bg-red-100 text-red-700',
  withdrawn: 'bg-gray-200 text-gray-600',
};

const DECLINE_LABELS = {
  'outside-claim-window': 'Outside the claim window',
  'donor-not-eligible': 'Donor not eligible',
  'programme-budget-exhausted': 'Employer budget exhausted',
  'evidence-insufficient': 'Evidence insufficient',
  'employer-policy-changed': 'Employer policy changed',
  other: 'Other',
};

// Which of the three limits bound the ceiling. Naming it is the difference
// between a number that looks broken and a number that explains itself.
const BOUND_BY_LABELS = {
  ratio: 'the employer’s match ratio',
  'donor-cap': 'this donor’s remaining annual cap',
  'programme-budget': 'the employer’s remaining budget',
};

const money = (value, currency = 'INR') =>
  value === null || value === undefined
    ? '—'
    : `${currency === 'INR' ? '₹' : `${currency} `}${Number(value).toLocaleString('en-IN')}`;

const shortDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—';

const daysUntil = (value) => {
  if (!value) return null;
  return Math.ceil((new Date(value) - new Date()) / 86400000);
};

const StatusChip = ({ status }) => (
  <span
    className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
      CLAIM_STATUS_STYLES[status] || 'bg-gray-200 text-gray-700'
    }`}
  >
    {CLAIM_STATUS_LABELS[status] || status}
  </span>
);

const EMPTY_PROGRAMME_FORM = {
  employerName: '',
  contactName: '',
  contactEmail: '',
  matchRatio: '1',
  perDonorAnnualCap: '',
  programmeBudget: '',
  claimWindowDays: '90',
  startsOn: '',
  endsOn: '',
  requiresPayrollId: false,
  requiresReceiptCopy: true,
};

const MatchingGiftPanel = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';

  const [meta, setMeta] = useState(null);
  const [programmes, setProgrammes] = useState([]);

  // Claim-raising flow: a pledge, then one payment on it, then the ceiling.
  const [myPledges, setMyPledges] = useState([]);
  const [selectedPledge, setSelectedPledge] = useState(null);
  const [pledgeDetail, setPledgeDetail] = useState(null);
  const [selectedReference, setSelectedReference] = useState('');
  const [programmeId, setProgrammeId] = useState('');
  const [ceiling, setCeiling] = useState(null);
  const [claimedAmount, setClaimedAmount] = useState('');
  const [payrollId, setPayrollId] = useState('');

  const [myClaims, setMyClaims] = useState([]);
  const [queue, setQueue] = useState([]);
  const [statusFilter, setStatusFilter] = useState('submitted');

  const [showProgrammeForm, setShowProgrammeForm] = useState(false);
  const [programmeForm, setProgrammeForm] = useState(EMPTY_PROGRAMME_FORM);

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

  const loadMeta = useCallback(async () => {
    try {
      const res = await api.get('/giving/matching/meta');
      setMeta(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load the matching options.');
    }
  }, []);

  const loadProgrammes = useCallback(async () => {
    try {
      const res = await api.get('/giving/matching/programmes');
      setProgrammes(res.data.data || []);
    } catch (err) {
      explain(err, 'Could not load the matching programmes.');
    }
  }, []);

  const loadMyPledges = useCallback(async () => {
    try {
      const res = await api.get('/giving/pledges/mine');
      // Only a pledge that has actually received money can be matched, so the
      // rest are filtered out here rather than offered and then refused.
      setMyPledges((res.data.data || []).filter((pledge) => pledge.amountReceived > 0));
    } catch (err) {
      explain(err, 'Could not load your pledges.');
    }
  }, []);

  const loadMyClaims = useCallback(async () => {
    try {
      const res = await api.get('/giving/matching/claims/mine');
      setMyClaims(res.data.data || []);
    } catch (err) {
      explain(err, 'Could not load your matching claims.');
    }
  }, []);

  const loadQueue = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const query = statusFilter ? `?status=${statusFilter}` : '';
      const res = await api.get(`/giving/matching/claims${query}`);
      setQueue(res.data.data || []);
    } catch (err) {
      explain(err, 'Could not load the claim queue.');
    }
  }, [isAdmin, statusFilter]);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadMeta(), loadProgrammes(), loadMyPledges(), loadMyClaims()]).finally(() =>
      setLoading(false)
    );
  }, [loadMeta, loadProgrammes, loadMyPledges, loadMyClaims]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  // ---- the claim-raising flow ---------------------------------------------

  const openPledge = async (pledge) => {
    setSelectedPledge(pledge);
    setPledgeDetail(null);
    setSelectedReference('');
    setCeiling(null);
    setError('');

    try {
      const res = await api.get(`/giving/pledges/${pledge._id}`);
      setPledgeDetail(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load that pledge.');
    }
  };

  /**
   * Ask the server what this gift can still be matched for.
   *
   * Deliberately a request rather than arithmetic in the browser: two of the
   * three limits depend on claims this donor cannot see.
   */
  const refreshCeiling = useCallback(async () => {
    if (!selectedPledge || !selectedReference || !programmeId) {
      setCeiling(null);
      return;
    }

    try {
      const res = await api.get('/giving/matching/claimable', {
        params: {
          pledgeId: selectedPledge._id,
          reference: selectedReference,
          programmeId,
        },
      });
      const data = res.data.data;
      setCeiling(data);
      setClaimedAmount(data?.claimable ? String(data.claimable) : '');
      setError('');
    } catch (err) {
      setCeiling(null);
      explain(err, 'Could not work out the claimable amount.');
    }
  }, [selectedPledge, selectedReference, programmeId]);

  useEffect(() => {
    refreshCeiling();
  }, [refreshCeiling]);

  const selectedProgramme = useMemo(
    () => programmes.find((programme) => programme._id === programmeId) || null,
    [programmes, programmeId]
  );

  const submitClaim = async (event) => {
    event.preventDefault();
    setError('');

    if (!ceiling || ceiling.claimable <= 0) {
      setError('There is nothing claimable against this gift.');
      return;
    }

    setBusyId('new-claim');
    try {
      await api.post('/giving/matching/claims', {
        programmeId,
        pledgeId: selectedPledge._id,
        reference: selectedReference,
        claimedAmount: Number(claimedAmount),
        payrollId,
        submit: true,
      });

      flash('Matching claim submitted.');
      setSelectedReference('');
      setCeiling(null);
      setClaimedAmount('');
      setPayrollId('');
      await Promise.all([loadMyClaims(), loadQueue()]);
    } catch (err) {
      explain(err, 'Could not submit the matching claim.');
    } finally {
      setBusyId('');
    }
  };

  const withdrawClaim = async (claim) => {
    setBusyId(claim._id);
    setError('');
    try {
      await api.patch(`/giving/matching/claims/${claim._id}/withdraw`, {
        note: 'Withdrawn by the donor',
      });
      flash('Claim withdrawn.');
      await Promise.all([loadMyClaims(), loadQueue()]);
    } catch (err) {
      explain(err, 'Could not withdraw that claim.');
    } finally {
      setBusyId('');
    }
  };

  // ---- admin actions -------------------------------------------------------

  const verifyClaim = async (claim) => {
    setBusyId(claim._id);
    setError('');
    try {
      await api.patch(`/giving/matching/claims/${claim._id}/verify`, {});
      flash('Claim verified.');
      await Promise.all([loadQueue(), loadMyClaims()]);
    } catch (err) {
      explain(err, 'Could not verify that claim.');
    } finally {
      setBusyId('');
    }
  };

  const declineClaim = async (claim) => {
    const reason = window.prompt(
      `Why is ${claim.employerName} declining this claim?\n\n${Object.entries(DECLINE_LABELS)
        .map(([value, label]) => `${value} — ${label}`)
        .join('\n')}`,
      'evidence-insufficient'
    );
    if (!reason) return;

    setBusyId(claim._id);
    setError('');
    try {
      await api.patch(`/giving/matching/claims/${claim._id}/decline`, { reason });
      flash('Claim declined.');
      await Promise.all([loadQueue(), loadMyClaims()]);
    } catch (err) {
      explain(err, 'Could not decline that claim.');
    } finally {
      setBusyId('');
    }
  };

  const recordReceipt = async (claim) => {
    const reference = window.prompt(
      `${claim.employerName} has paid ${money(claim.claimedAmount, claim.currency)}. ` +
        'What is their payment reference?'
    );
    if (!reference) return;

    setBusyId(claim._id);
    setError('');
    try {
      const res = await api.patch(`/giving/matching/claims/${claim._id}/receipt`, {
        receiptReference: reference,
      });
      flash(res.data.idempotent ? 'That receipt was already recorded.' : 'Receipt recorded.');
      await Promise.all([loadQueue(), loadProgrammes()]);
    } catch (err) {
      explain(err, 'Could not record that receipt.');
    } finally {
      setBusyId('');
    }
  };

  const createProgramme = async (event) => {
    event.preventDefault();
    setBusyId('new-programme');
    setError('');
    try {
      await api.post('/giving/matching/programmes', {
        ...programmeForm,
        matchRatio: Number(programmeForm.matchRatio),
        perDonorAnnualCap: Number(programmeForm.perDonorAnnualCap),
        programmeBudget: programmeForm.programmeBudget
          ? Number(programmeForm.programmeBudget)
          : null,
        claimWindowDays: Number(programmeForm.claimWindowDays),
        startsOn: programmeForm.startsOn || new Date().toISOString(),
      });

      flash('Matching programme added.');
      setProgrammeForm(EMPTY_PROGRAMME_FORM);
      setShowProgrammeForm(false);
      await loadProgrammes();
    } catch (err) {
      explain(err, 'Could not add that matching programme.');
    } finally {
      setBusyId('');
    }
  };

  // ---- render --------------------------------------------------------------

  const claimablePayments = useMemo(() => {
    if (!pledgeDetail) return [];
    return pledgeDetail.payments || [];
  }, [pledgeDetail]);

  const windowDays = ceiling ? daysUntil(ceiling.claimWindowClosesOn) : null;

  return (
    <section className="mt-10 bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
      <header className="flex items-start justify-between gap-4 flex-wrap mb-6">
        <div>
          <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
            <Building2 size={20} className="text-blue-600" />
            Employer matching
          </h2>
          <p className="text-sm text-gray-600 mt-1 max-w-2xl">
            Many employers will match a gift their employee has already made. A claim is raised
            against one payment the school has actually received, and the money it brings in is
            reported separately from the gift itself.
          </p>
        </div>

        {isAdmin && (
          <button
            type="button"
            onClick={() => setShowProgrammeForm((open) => !open)}
            className="px-3 py-2 rounded-md border border-gray-300 text-sm font-medium hover:bg-gray-50 transition"
          >
            {showProgrammeForm ? 'Close' : 'Add an employer programme'}
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

      {/* --- Admin: add a programme ------------------------------------- */}
      {isAdmin && showProgrammeForm && (
        <form
          onSubmit={createProgramme}
          className="mb-8 rounded-xl border border-gray-200 bg-gray-50 p-4 grid gap-3 md:grid-cols-2"
        >
          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Employer</span>
            <input
              required
              value={programmeForm.employerName}
              onChange={(e) =>
                setProgrammeForm({ ...programmeForm, employerName: e.target.value })
              }
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-700 mb-1">
              Match ratio <span className="text-gray-500">(1 = one-for-one)</span>
            </span>
            <input
              required
              type="number"
              step="0.01"
              min="0.01"
              value={programmeForm.matchRatio}
              onChange={(e) => setProgrammeForm({ ...programmeForm, matchRatio: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Cap per donor, per year</span>
            <input
              required
              type="number"
              min="1"
              value={programmeForm.perDonorAnnualCap}
              onChange={(e) =>
                setProgrammeForm({ ...programmeForm, perDonorAnnualCap: e.target.value })
              }
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-700 mb-1">
              Total budget <span className="text-gray-500">(blank if uncapped)</span>
            </span>
            <input
              type="number"
              min="1"
              value={programmeForm.programmeBudget}
              onChange={(e) =>
                setProgrammeForm({ ...programmeForm, programmeBudget: e.target.value })
              }
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-700 mb-1">
              Claim window, in days after the gift
            </span>
            <input
              required
              type="number"
              min="1"
              value={programmeForm.claimWindowDays}
              onChange={(e) =>
                setProgrammeForm({ ...programmeForm, claimWindowDays: e.target.value })
              }
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Contact email</span>
            <input
              type="email"
              value={programmeForm.contactEmail}
              onChange={(e) =>
                setProgrammeForm({ ...programmeForm, contactEmail: e.target.value })
              }
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="text-sm flex items-center gap-2 md:col-span-2">
            <input
              type="checkbox"
              checked={programmeForm.requiresPayrollId}
              onChange={(e) =>
                setProgrammeForm({ ...programmeForm, requiresPayrollId: e.target.checked })
              }
            />
            <span className="text-gray-700">This employer requires the donor’s payroll id</span>
          </label>

          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={busyId === 'new-programme'}
              className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition disabled:opacity-60"
            >
              Add programme
            </button>
            <p className="text-xs text-gray-500 mt-2">
              The match ratio cannot be changed later. Claims are calculated against it, and
              altering it would leave the school asking an employer for a figure its own records no
              longer reproduce.
            </p>
          </div>
        </form>
      )}

      {/* --- Admin: programme budgets ------------------------------------ */}
      {isAdmin && programmes.length > 0 && (
        <div className="mb-8">
          <h3 className="text-sm font-semibold text-gray-800 mb-2">Employer programmes</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-gray-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">Employer</th>
                  <th className="py-2 pr-4 font-medium">Ratio</th>
                  <th className="py-2 pr-4 font-medium">Donor cap</th>
                  <th className="py-2 pr-4 font-medium">Budget left</th>
                  <th className="py-2 pr-4 font-medium">Window</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {programmes.map((programme) => (
                  <tr key={programme._id} className="border-t border-gray-100">
                    <td className="py-2 pr-4 font-medium text-gray-900">
                      {programme.employerName}
                    </td>
                    <td className="py-2 pr-4">{programme.matchRatio}×</td>
                    <td className="py-2 pr-4">{money(programme.perDonorAnnualCap)}</td>
                    <td className="py-2 pr-4">
                      {programme.programmeRemaining === null ? (
                        <span className="text-gray-500">Uncapped</span>
                      ) : (
                        <span
                          className={
                            programme.programmeRemaining === 0 ? 'text-red-700 font-medium' : ''
                          }
                        >
                          {money(programme.programmeRemaining)}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4">{programme.claimWindowDays} days</td>
                    <td className="py-2 pr-4">{programme.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* --- Raising a claim --------------------------------------------- */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
            <HandCoins size={16} className="text-blue-600" />
            Claim a match on a gift
          </h3>

          {myPledges.length === 0 ? (
            <p className="text-sm text-gray-500">
              A match is claimed against money that has already reached the school. Once a payment
              is recorded against one of your pledges, it will appear here.
            </p>
          ) : (
            <>
              <label className="text-sm block mb-3">
                <span className="block text-gray-700 mb-1">Which gift?</span>
                <select
                  value={selectedPledge?._id || ''}
                  onChange={(e) => {
                    const pledge = myPledges.find((p) => p._id === e.target.value);
                    if (pledge) openPledge(pledge);
                  }}
                  className="w-full rounded border border-gray-300 px-3 py-2"
                >
                  <option value="">Select a pledge…</option>
                  {myPledges.map((pledge) => (
                    <option key={pledge._id} value={pledge._id}>
                      {money(pledge.amountReceived)} received — pledged {shortDate(pledge.createdAt)}
                    </option>
                  ))}
                </select>
              </label>

              {pledgeDetail && (
                <label className="text-sm block mb-3">
                  <span className="block text-gray-700 mb-1">Which payment?</span>
                  <select
                    value={selectedReference}
                    onChange={(e) => setSelectedReference(e.target.value)}
                    className="w-full rounded border border-gray-300 px-3 py-2"
                  >
                    <option value="">Select a payment…</option>
                    {claimablePayments.map((payment) => (
                      <option key={payment._id} value={payment.reference}>
                        {money(payment.amount)} on {shortDate(payment.receivedOn)} —{' '}
                        {payment.reference}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label className="text-sm block mb-3">
                <span className="block text-gray-700 mb-1">Which employer?</span>
                <select
                  value={programmeId}
                  onChange={(e) => setProgrammeId(e.target.value)}
                  className="w-full rounded border border-gray-300 px-3 py-2"
                >
                  <option value="">Select an employer…</option>
                  {programmes.map((programme) => (
                    <option key={programme._id} value={programme._id}>
                      {programme.employerName} ({programme.matchRatio}× match)
                    </option>
                  ))}
                </select>
              </label>

              {/* The ceiling, shown before an amount is typed. */}
              {ceiling && (
                <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 mb-3 text-sm">
                  <p className="text-blue-900 font-medium">
                    {money(ceiling.claimable)} can be claimed against this gift
                  </p>
                  <p className="text-blue-800 mt-1 text-xs">
                    Bound by {BOUND_BY_LABELS[ceiling.boundBy] || ceiling.boundBy}.{' '}
                    {money(ceiling.giftAmount)} × {ceiling.matchRatio} ={' '}
                    {money(ceiling.byRatio)}; this donor has {money(ceiling.donorRemaining)} of
                    their annual cap left
                    {ceiling.programmeRemaining !== null && (
                      <>, and the employer has {money(ceiling.programmeRemaining)} of budget left</>
                    )}
                    .
                  </p>

                  {ceiling.claimWindowClosesOn && (
                    <p
                      className={`mt-2 text-xs flex items-center gap-1 ${
                        ceiling.claimWindowOpen ? 'text-blue-800' : 'text-red-700 font-medium'
                      }`}
                    >
                      <Clock size={12} />
                      {ceiling.claimWindowOpen
                        ? `The claim window closes on ${shortDate(
                            ceiling.claimWindowClosesOn
                          )} — ${windowDays} day${windowDays === 1 ? '' : 's'} left.`
                        : `The claim window closed on ${shortDate(ceiling.claimWindowClosesOn)}.`}
                    </p>
                  )}

                  {ceiling.alreadyClaimed && (
                    <p className="mt-2 text-xs text-amber-800 font-medium">
                      This gift already has a claim against it (
                      {CLAIM_STATUS_LABELS[ceiling.alreadyClaimed.status]}). A gift can only be
                      matched once.
                    </p>
                  )}

                  {ceiling.programmeBlockedReason && (
                    <p className="mt-2 text-xs text-red-700 font-medium">
                      {ceiling.programmeBlockedReason}
                    </p>
                  )}
                </div>
              )}

              <form onSubmit={submitClaim}>
                <label className="text-sm block mb-3">
                  <span className="block text-gray-700 mb-1">Amount to claim</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    max={ceiling ? ceiling.claimable : undefined}
                    value={claimedAmount}
                    onChange={(e) => setClaimedAmount(e.target.value)}
                    disabled={!ceiling || ceiling.claimable <= 0}
                    className="w-full rounded border border-gray-300 px-3 py-2 disabled:bg-gray-100"
                  />
                </label>

                {selectedProgramme?.requiresPayrollId && (
                  <label className="text-sm block mb-3">
                    <span className="block text-gray-700 mb-1">
                      Payroll id{' '}
                      <span className="text-gray-500">
                        (required by {selectedProgramme.employerName})
                      </span>
                    </span>
                    <input
                      value={payrollId}
                      onChange={(e) => setPayrollId(e.target.value)}
                      className="w-full rounded border border-gray-300 px-3 py-2"
                    />
                  </label>
                )}

                <button
                  type="submit"
                  disabled={
                    busyId === 'new-claim' ||
                    !ceiling ||
                    ceiling.claimable <= 0 ||
                    !ceiling.claimWindowOpen ||
                    Boolean(ceiling.alreadyClaimed) ||
                    Boolean(ceiling.programmeBlockedReason)
                  }
                  className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition disabled:opacity-50"
                >
                  Submit the claim
                </button>
              </form>
            </>
          )}
        </div>

        {/* --- My claims ------------------------------------------------- */}
        <div className="rounded-xl border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-800 mb-3">Your matching claims</h3>

          {myClaims.length === 0 ? (
            <p className="text-sm text-gray-500">You have not claimed any matches yet.</p>
          ) : (
            <ul className="space-y-3">
              {myClaims.map((claim) => (
                <li key={claim._id} className="border-b border-gray-100 pb-3 last:border-0">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {claim.employerName} — {money(claim.claimedAmount, claim.currency)}
                      </p>
                      <p className="text-xs text-gray-600 mt-0.5">
                        on a gift of {money(claim.giftAmount, claim.currency)} received{' '}
                        {shortDate(claim.giftReceivedOn)}
                      </p>
                      {claim.declineReason && (
                        <p className="text-xs text-red-700 mt-1">
                          Declined: {DECLINE_LABELS[claim.declineReason] || claim.declineReason}
                        </p>
                      )}
                    </div>
                    <StatusChip status={claim.status} />
                  </div>

                  {['draft', 'submitted'].includes(claim.status) && (
                    <button
                      type="button"
                      onClick={() => withdrawClaim(claim)}
                      disabled={busyId === claim._id}
                      className="mt-2 text-xs text-gray-600 underline hover:text-gray-900 disabled:opacity-50"
                    >
                      Withdraw
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* --- Admin: the claim queue -------------------------------------- */}
      {isAdmin && (
        <div className="mt-8">
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
              <ShieldCheck size={16} className="text-blue-600" />
              Claim queue
            </h3>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded border border-gray-300 px-2 py-1 text-sm"
            >
              <option value="">All statuses</option>
              {(meta?.claimStatuses || []).map((status) => (
                <option key={status} value={status}>
                  {CLAIM_STATUS_LABELS[status] || status}
                </option>
              ))}
            </select>
          </div>

          {queue.length === 0 ? (
            <p className="text-sm text-gray-500">Nothing in this queue.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-gray-500">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Donor</th>
                    <th className="py-2 pr-4 font-medium">Employer</th>
                    <th className="py-2 pr-4 font-medium">Gift</th>
                    <th className="py-2 pr-4 font-medium">Claimed</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.map((claim) => (
                    <tr key={claim._id} className="border-t border-gray-100 align-top">
                      <td className="py-2 pr-4">{claim.donorName}</td>
                      <td className="py-2 pr-4">{claim.employerName}</td>
                      <td className="py-2 pr-4">
                        {money(claim.giftAmount, claim.currency)}
                        <span className="block text-xs text-gray-500">
                          {shortDate(claim.giftReceivedOn)}
                        </span>
                      </td>
                      <td className="py-2 pr-4 font-medium">
                        {money(claim.claimedAmount, claim.currency)}
                      </td>
                      <td className="py-2 pr-4">
                        <StatusChip status={claim.status} />
                      </td>
                      <td className="py-2 pr-4">
                        <div className="flex flex-wrap gap-2">
                          {claim.status === 'submitted' && (
                            <button
                              type="button"
                              onClick={() => verifyClaim(claim)}
                              disabled={busyId === claim._id}
                              className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                            >
                              Verify
                            </button>
                          )}

                          {claim.status === 'verified' && (
                            <button
                              type="button"
                              onClick={() => recordReceipt(claim)}
                              disabled={busyId === claim._id}
                              className="text-xs px-2 py-1 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                            >
                              Record receipt
                            </button>
                          )}

                          {['submitted', 'verified'].includes(claim.status) && (
                            <button
                              type="button"
                              onClick={() => declineClaim(claim)}
                              disabled={busyId === claim._id}
                              className="text-xs px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50 flex items-center gap-1"
                            >
                              <Ban size={12} />
                              Decline
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-xs text-gray-500 mt-3">
            A claim cannot be verified by the donor whose gift it matches, or by whoever submitted
            it. The claimable ceiling is worked out again when a receipt is recorded, in case other
            claims have spent the employer’s budget in the meantime.
          </p>
        </div>
      )}
    </section>
  );
};

export default MatchingGiftPanel;
