import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Gauge,
  Wallet,
  RefreshCw,
  AlertTriangle,
  Check,
  Plus,
  Users,
  TrendingDown,
} from 'lucide-react';
import api from '../../utils/axios';

const STATUS_STYLES = {
  submitted: 'bg-blue-100 text-blue-700',
  'under-review': 'bg-amber-100 text-amber-800',
  approved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-rose-100 text-rose-700',
  waitlisted: 'bg-violet-100 text-violet-700',
  withdrawn: 'bg-gray-100 text-gray-500',
};

const AID_TYPES = ['merit', 'need', 'sports', 'arts', 'sibling', 'staff-ward'];

const money = (value, currency = 'INR') =>
  `${currency === 'INR' ? '₹' : `${currency} `}${Number(value || 0).toLocaleString('en-IN')}`;

const today = () => new Date().toISOString().slice(0, 10);
const inThreeMonths = () =>
  new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const emptyProgram = () => ({
  name: '',
  description: '',
  academicYear: `${new Date().getFullYear()}-${String((new Date().getFullYear() + 1) % 100).padStart(2, '0')}`,
  aidType: 'need',
  opensOn: today(),
  closesOn: inThreeMonths(),
  totalBudget: '',
  maxAwardPerStudent: '',
  eligibility: { minPercentage: 0, minAttendance: 0, maxHouseholdIncome: 0 },
  scoringWeights: { need: 50, merit: 30, attendance: 20 },
});

/**
 * The aid committee's queue.
 *
 * Every decision button sits next to the fund's remaining budget, because the
 * one mistake this module exists to prevent is approving an award the fund
 * cannot cover.
 */
const AidReviewPanel = () => {
  const [tab, setTab] = useState('queue');

  const [programs, setPrograms] = useState([]);
  const [applications, setApplications] = useState([]);
  const [summary, setSummary] = useState(null);
  const [programFilter, setProgramFilter] = useState('');

  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [deciding, setDeciding] = useState(null);
  const [decisionForm, setDecisionForm] = useState({
    decision: 'approved',
    amountAwarded: '',
    reviewNote: '',
  });
  const [programForm, setProgramForm] = useState(emptyProgram());

  const load = useCallback(async (filterProgramId) => {
    setLoading(true);
    setError('');
    try {
      const [programsRes, applicationsRes, summaryRes] = await Promise.all([
        api.get('/financial-aid/programs'),
        api.get('/financial-aid/applications', {
          params: filterProgramId ? { programId: filterProgramId } : {},
        }),
        api.get('/financial-aid/summary'),
      ]);
      setPrograms(programsRes.data.data || []);
      setApplications(applicationsRes.data.data || []);
      setSummary(summaryRes.data.summary);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the aid data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(programFilter);
  }, [load, programFilter]);

  const programById = useMemo(() => {
    const map = {};
    programs.forEach((program) => {
      map[program._id] = program;
    });
    return map;
  }, [programs]);

  const openDecision = (application) => {
    setDeciding(application);
    setDecisionForm({
      decision: 'approved',
      amountAwarded: String(application.amountRequested),
      reviewNote: '',
    });
    setError('');
    setNotice('');
  };

  const submitDecision = async (event) => {
    event.preventDefault();
    if (!deciding) return;
    setBusyId(deciding._id);
    setError('');
    setNotice('');
    try {
      const res = await api.patch(`/financial-aid/applications/${deciding._id}/review`, {
        decision: decisionForm.decision,
        amountAwarded:
          decisionForm.decision === 'approved' ? Number(decisionForm.amountAwarded) : undefined,
        reviewNote: decisionForm.reviewNote,
      });
      setNotice(res.data.message);
      setDeciding(null);
      await load(programFilter);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not record that decision.');
    } finally {
      setBusyId(null);
    }
  };

  const createProgram = async (event) => {
    event.preventDefault();
    setBusyId('program');
    setError('');
    setNotice('');
    try {
      await api.post('/financial-aid/programs', {
        ...programForm,
        totalBudget: Number(programForm.totalBudget),
        maxAwardPerStudent: Number(programForm.maxAwardPerStudent),
        eligibility: {
          minPercentage: Number(programForm.eligibility.minPercentage) || 0,
          minAttendance: Number(programForm.eligibility.minAttendance) || 0,
          maxHouseholdIncome: Number(programForm.eligibility.maxHouseholdIncome) || 0,
        },
      });
      setProgramForm(emptyProgram());
      setNotice('Program created as a draft. Open it when you are ready to take applications.');
      await load(programFilter);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not create the program.');
    } finally {
      setBusyId(null);
    }
  };

  const openProgram = async (program) => {
    setBusyId(program._id);
    setError('');
    try {
      await api.put(`/financial-aid/programs/${program._id}`, { status: 'open' });
      setNotice(`"${program.name}" is now taking applications.`);
      await load(programFilter);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not open the program.');
    } finally {
      setBusyId(null);
    }
  };

  const closeProgram = async (program) => {
    setBusyId(program._id);
    setError('');
    try {
      const res = await api.patch(`/financial-aid/programs/${program._id}/close`);
      setNotice(res.data.message);
      await load(programFilter);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not close the program.');
    } finally {
      setBusyId(null);
    }
  };

  const pending = useMemo(
    () => applications.filter((a) => ['submitted', 'under-review'].includes(a.status)),
    [applications]
  );

  const tabs = [
    { id: 'queue', label: `Queue${pending.length ? ` (${pending.length})` : ''}` },
    { id: 'programs', label: 'Funds' },
    { id: 'summary', label: 'Summary' },
  ];

  return (
    <div className="bg-white rounded-2xl shadow-lg p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-800">Financial aid</h2>
          <p className="text-sm text-gray-500">Scored applications and the funds behind them</p>
        </div>
        <button
          onClick={() => load(programFilter)}
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
              tab === item.id ? 'bg-teal-700 text-white shadow' : 'text-gray-500 hover:text-gray-700'
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

      {/* ---- Queue ---- */}
      {tab === 'queue' && (
        <div className="space-y-4">
          <select
            value={programFilter}
            onChange={(e) => setProgramFilter(e.target.value)}
            className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
          >
            <option value="">All funds</option>
            {programs.map((program) => (
              <option key={program._id} value={program._id}>
                {program.name}
              </option>
            ))}
          </select>

          {applications.length === 0 && (
            <p className="text-sm text-gray-400 py-6">Nothing to review.</p>
          )}

          {applications.map((application) => {
            const program = programById[application.program];
            return (
              <div key={application._id} className="border border-gray-200 rounded-2xl p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-gray-800">
                      {application.studentName || 'Unnamed student'}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {application.className || '—'} · {application.programName} · requested{' '}
                      {money(application.amountRequested)}
                    </div>
                  </div>
                  <div className="text-right">
                    <span
                      className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium ${
                        STATUS_STYLES[application.status] || 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {application.status}
                    </span>
                  </div>
                </div>

                {/* Score components, not just the total. */}
                <div className="grid grid-cols-4 gap-3 mt-4 bg-gray-50 rounded-xl p-4 text-center">
                  {[
                    { label: 'Need', value: application.score?.need },
                    { label: 'Academic', value: application.score?.merit },
                    { label: 'Attendance', value: application.score?.attendance },
                    { label: 'Score', value: application.score?.total, strong: true },
                  ].map((part) => (
                    <div key={part.label}>
                      <div
                        className={`text-xl ${
                          part.strong ? 'font-bold text-teal-700' : 'font-semibold text-gray-700'
                        }`}
                      >
                        {part.value ?? 0}
                      </div>
                      <div className="text-xs text-gray-500">{part.label}</div>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 text-xs text-gray-600">
                  <div>
                    <span className="text-gray-400">Household income</span>
                    <div className="font-medium">{money(application.householdIncome)}</div>
                  </div>
                  <div>
                    <span className="text-gray-400">Dependants</span>
                    <div className="font-medium">{application.dependants}</div>
                  </div>
                  <div>
                    <span className="text-gray-400">Occupation</span>
                    <div className="font-medium">{application.guardianOccupation || '—'}</div>
                  </div>
                  <div>
                    <span className="text-gray-400">Documents</span>
                    <div className="font-medium">{application.documents?.length || 0}</div>
                  </div>
                </div>

                <p className="text-sm text-gray-600 mt-3 bg-gray-50 rounded-lg p-3">
                  {application.statementOfNeed}
                </p>

                {application.reviewNote && (
                  <p className="text-sm text-gray-500 mt-2 italic">
                    {application.reviewedByName}: {application.reviewNote}
                  </p>
                )}

                {['submitted', 'under-review'].includes(application.status) && (
                  <div className="flex items-center justify-between gap-3 mt-4 pt-4 border-t border-gray-100">
                    {/* The remaining budget is right next to the button. */}
                    <div className="text-xs text-gray-500 inline-flex items-center gap-1.5">
                      <Wallet size={13} />
                      {program
                        ? `${money(program.budgetRemaining, program.currency)} left in ${program.name}`
                        : 'Fund unavailable'}
                    </div>
                    <button
                      onClick={() => openDecision(application)}
                      disabled={busyId === application._id}
                      className="bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg"
                    >
                      Decide
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ---- Funds ---- */}
      {tab === 'programs' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <form
            onSubmit={createProgram}
            className="lg:col-span-1 border border-gray-200 rounded-2xl p-5 space-y-3"
          >
            <h3 className="font-semibold text-sm flex items-center gap-2 text-gray-800">
              <Plus size={16} /> New fund
            </h3>
            <input
              required
              value={programForm.name}
              onChange={(e) => setProgramForm({ ...programForm, name: e.target.value })}
              placeholder="Fund name"
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
            />
            <textarea
              rows={2}
              value={programForm.description}
              onChange={(e) => setProgramForm({ ...programForm, description: e.target.value })}
              placeholder="Description"
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                required
                value={programForm.academicYear}
                onChange={(e) => setProgramForm({ ...programForm, academicYear: e.target.value })}
                placeholder="Academic year"
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
              />
              <select
                value={programForm.aidType}
                onChange={(e) => setProgramForm({ ...programForm, aidType: e.target.value })}
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
              >
                {AID_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="1"
                required
                value={programForm.totalBudget}
                onChange={(e) => setProgramForm({ ...programForm, totalBudget: e.target.value })}
                placeholder="Total budget"
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
              />
              <input
                type="number"
                min="1"
                required
                value={programForm.maxAwardPerStudent}
                onChange={(e) =>
                  setProgramForm({ ...programForm, maxAwardPerStudent: e.target.value })
                }
                placeholder="Max per student"
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
              />
              <input
                type="date"
                required
                value={programForm.opensOn}
                onChange={(e) => setProgramForm({ ...programForm, opensOn: e.target.value })}
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
              />
              <input
                type="date"
                required
                value={programForm.closesOn}
                onChange={(e) => setProgramForm({ ...programForm, closesOn: e.target.value })}
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
              />
            </div>

            <div>
              <div className="text-xs text-gray-500 mb-1.5">
                Eligibility — 0 means the rule is not applied
              </div>
              <div className="grid grid-cols-3 gap-2">
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={programForm.eligibility.minPercentage}
                  onChange={(e) =>
                    setProgramForm({
                      ...programForm,
                      eligibility: { ...programForm.eligibility, minPercentage: e.target.value },
                    })
                  }
                  placeholder="Min %"
                  className="text-sm border border-gray-300 rounded-lg px-2 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
                />
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={programForm.eligibility.minAttendance}
                  onChange={(e) =>
                    setProgramForm({
                      ...programForm,
                      eligibility: { ...programForm.eligibility, minAttendance: e.target.value },
                    })
                  }
                  placeholder="Min att."
                  className="text-sm border border-gray-300 rounded-lg px-2 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
                />
                <input
                  type="number"
                  min="0"
                  value={programForm.eligibility.maxHouseholdIncome}
                  onChange={(e) =>
                    setProgramForm({
                      ...programForm,
                      eligibility: {
                        ...programForm.eligibility,
                        maxHouseholdIncome: e.target.value,
                      },
                    })
                  }
                  placeholder="Income cap"
                  className="text-sm border border-gray-300 rounded-lg px-2 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
                />
              </div>
            </div>

            <div>
              <div className="text-xs text-gray-500 mb-1.5">
                Scoring weights — these cannot change once anything is scored
              </div>
              <div className="grid grid-cols-3 gap-2">
                {['need', 'merit', 'attendance'].map((key) => (
                  <input
                    key={key}
                    type="number"
                    min="0"
                    max="100"
                    value={programForm.scoringWeights[key]}
                    onChange={(e) =>
                      setProgramForm({
                        ...programForm,
                        scoringWeights: {
                          ...programForm.scoringWeights,
                          [key]: Number(e.target.value),
                        },
                      })
                    }
                    placeholder={key}
                    className="text-sm border border-gray-300 rounded-lg px-2 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
                  />
                ))}
              </div>
            </div>

            <button
              type="submit"
              disabled={busyId === 'program'}
              className="w-full bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white text-sm py-2 rounded-lg transition"
            >
              {busyId === 'program' ? 'Saving…' : 'Create as draft'}
            </button>
          </form>

          <div className="lg:col-span-2 space-y-3">
            {programs.length === 0 && <p className="text-sm text-gray-400">No funds yet.</p>}
            {programs.map((program) => (
              <div key={program._id} className="border border-gray-200 rounded-2xl p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-gray-800">{program.name}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {program.aidType} · {program.academicYear} · up to{' '}
                      {money(program.maxAwardPerStudent, program.currency)} each
                    </div>
                  </div>
                  <span
                    className={`inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${
                      program.status === 'open'
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {program.status}
                  </span>
                </div>

                <div className="mt-3">
                  <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                    <span>Allocated</span>
                    <span>
                      {money(program.budgetAwarded, program.currency)} of{' '}
                      {money(program.totalBudget, program.currency)}
                    </span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-teal-600 rounded-full"
                      style={{ width: `${program.budgetUsedPercent || 0}%` }}
                    />
                  </div>
                </div>

                <div className="flex items-center gap-3 mt-3 pt-3 border-t border-gray-50">
                  {program.status === 'draft' && (
                    <button
                      onClick={() => openProgram(program)}
                      disabled={busyId === program._id}
                      className="text-xs text-emerald-600 hover:text-emerald-700 disabled:opacity-50"
                    >
                      Open for applications
                    </button>
                  )}
                  {program.status === 'open' && (
                    <button
                      onClick={() => closeProgram(program)}
                      disabled={busyId === program._id}
                      className="text-xs text-amber-600 hover:text-amber-700 disabled:opacity-50"
                    >
                      Close to new applications
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
            { label: 'Funds', value: summary.programs, icon: Wallet },
            { label: 'Budget', value: money(summary.totalBudget) },
            { label: 'Awarded', value: money(summary.totalAwarded) },
            { label: 'Remaining', value: money(summary.budgetRemaining) },
            { label: 'Applications', value: summary.applications, icon: Users },
            { label: 'Awaiting decision', value: summary.submitted + summary.underReview },
            { label: 'Approved', value: summary.approved },
            {
              label: 'Average score',
              value: summary.averageScore === null ? '—' : summary.averageScore,
              icon: Gauge,
            },
            {
              label: 'Unmet need',
              value: money(summary.unmetNeed),
              hint: 'Requested but not awarded',
              icon: TrendingDown,
            },
          ].map((card) => (
            <div key={card.label} className="border border-gray-200 rounded-2xl p-5">
              <div className="text-xs uppercase tracking-wide text-gray-400 flex items-center gap-1.5">
                {card.icon && <card.icon size={12} />} {card.label}
              </div>
              <div className="text-2xl font-bold text-gray-800 mt-1">{card.value}</div>
              {card.hint && <div className="text-xs text-gray-400 mt-1">{card.hint}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Decision dialog */}
      {deciding && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <form
            onSubmit={submitDecision}
            className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-lg space-y-4"
          >
            <div>
              <h3 className="font-semibold text-lg text-gray-800">
                {deciding.studentName} — {deciding.programName}
              </h3>
              <p className="text-xs text-gray-500 mt-1">
                Scored {deciding.score?.total ?? 0}/100 · requested {money(deciding.amountRequested)} ·{' '}
                {money(programById[deciding.program]?.budgetRemaining || 0)} left in the fund
              </p>
            </div>

            <select
              value={decisionForm.decision}
              onChange={(e) => setDecisionForm({ ...decisionForm, decision: e.target.value })}
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
            >
              <option value="approved">Approve</option>
              <option value="waitlisted">Waitlist</option>
              <option value="rejected">Reject</option>
              <option value="under-review">Mark under review</option>
            </select>

            {decisionForm.decision === 'approved' && (
              <label className="block text-sm">
                <span className="text-gray-600 text-xs">Amount to award</span>
                <input
                  type="number"
                  min="1"
                  required
                  value={decisionForm.amountAwarded}
                  onChange={(e) =>
                    setDecisionForm({ ...decisionForm, amountAwarded: e.target.value })
                  }
                  className="w-full mt-1 text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
                />
              </label>
            )}

            <textarea
              required={decisionForm.decision !== 'under-review'}
              rows={4}
              maxLength={1000}
              value={decisionForm.reviewNote}
              onChange={(e) => setDecisionForm({ ...decisionForm, reviewNote: e.target.value })}
              placeholder="The reason. The family will read this."
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
            />

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={busyId === deciding._id}
                className="flex-1 bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white text-sm py-2.5 rounded-lg transition"
              >
                {busyId === deciding._id ? 'Recording…' : 'Record decision'}
              </button>
              <button
                type="button"
                onClick={() => setDeciding(null)}
                className="px-5 text-sm text-gray-600 hover:text-gray-800"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

export default AidReviewPanel;
