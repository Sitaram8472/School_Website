import React, { useState, useEffect, useContext, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  HandCoins,
  AlertTriangle,
  Check,
  FileText,
  Calendar,
  Gauge,
} from 'lucide-react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';
import AidReviewPanel from '../components/aid/AidReviewPanel';

const STATUS_STYLES = {
  draft: 'bg-gray-100 text-gray-600',
  submitted: 'bg-blue-100 text-blue-700',
  'under-review': 'bg-amber-100 text-amber-800',
  approved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-rose-100 text-rose-700',
  waitlisted: 'bg-violet-100 text-violet-700',
  withdrawn: 'bg-gray-100 text-gray-500',
};

const STATUS_LABELS = {
  draft: 'Draft — not yet submitted',
  submitted: 'Submitted',
  'under-review': 'Being reviewed',
  approved: 'Approved',
  rejected: 'Not awarded',
  waitlisted: 'Waitlisted',
  withdrawn: 'Withdrawn',
};

const money = (value, currency = 'INR') =>
  `${currency === 'INR' ? '₹' : `${currency} `}${Number(value || 0).toLocaleString('en-IN')}`;

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

const emptyForm = () => ({
  programId: '',
  householdIncome: '',
  dependants: 0,
  guardianOccupation: '',
  academicPercentage: '',
  attendancePercentage: '',
  amountRequested: '',
  statementOfNeed: '',
});

/**
 * Financial aid portal. Families see open funds, apply, and read the score
 * breakdown behind whatever decision they were given. The committee gets the
 * review queue instead.
 */
const FinancialAid = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isStaff = role === 'admin' || role === 'staff';

  const [programs, setPrograms] = useState([]);
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState(emptyForm());
  const [applyingTo, setApplyingTo] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [programsRes, applicationsRes] = await Promise.all([
        api.get('/financial-aid/programs'),
        api.get('/financial-aid/applications/me'),
      ]);
      setPrograms(programsRes.data.data || []);
      setApplications(applicationsRes.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the financial aid programs.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const appliedProgramIds = useMemo(
    () => new Set(applications.map((application) => application.program)),
    [applications]
  );

  const startApplication = (program) => {
    setApplyingTo(program);
    setForm({ ...emptyForm(), programId: program._id });
    setError('');
    setNotice('');
  };

  const submitDraft = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await api.post('/financial-aid/applications', {
        ...form,
        householdIncome: Number(form.householdIncome),
        dependants: Number(form.dependants) || 0,
        academicPercentage: Number(form.academicPercentage),
        attendancePercentage: Number(form.attendancePercentage) || 0,
        amountRequested: Number(form.amountRequested),
      });
      setNotice(res.data.message);
      setApplyingTo(null);
      setForm(emptyForm());
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save that application.');
    } finally {
      setBusy(false);
    }
  };

  const submitApplication = async (application) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await api.patch(`/financial-aid/applications/${application._id}/submit`);
      setNotice(res.data.message);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not submit that application.');
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (application) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.patch(`/financial-aid/applications/${application._id}/withdraw`);
      setNotice('Application withdrawn.');
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not withdraw that application.');
    } finally {
      setBusy(false);
    }
  };

  if (isStaff) {
    return (
      <div
        className="min-h-screen p-4 sm:p-6"
        style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
      >
        <div className="max-w-6xl mx-auto">
          <Link
            to="/teacher/dashboard"
            className="inline-flex items-center gap-2 text-sm text-teal-700 hover:text-teal-800 mb-4"
          >
            <ArrowLeft size={16} /> Back to dashboard
          </Link>
          <AidReviewPanel />
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
      <div className="bg-gradient-to-r from-teal-700 to-cyan-700 text-white rounded-3xl p-8 shadow-2xl mb-8">
        <Link
          to="/admissions/scholarship"
          className="inline-flex items-center gap-2 text-teal-100 hover:text-white text-sm"
        >
          <ArrowLeft size={16} /> Scholarships
        </Link>

        <div className="flex items-center gap-4 mt-4">
          <div className="bg-white text-teal-700 p-4 rounded-full shadow-lg">
            <HandCoins size={28} />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Financial aid</h1>
            <p className="text-teal-100 mt-1">
              Apply for a scholarship or bursary, and see exactly how it was scored
            </p>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto space-y-6">
        {error && (
          <div className="flex items-start gap-3 bg-red-50 border border-red-200 text-red-700 rounded-xl p-4">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <span className="text-sm">{error}</span>
          </div>
        )}

        {notice && (
          <div className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl p-4">
            <Check size={18} className="mt-0.5 shrink-0" />
            <span className="text-sm">{notice}</span>
          </div>
        )}

        {loading && <div className="text-center py-12 text-gray-500">Loading…</div>}

        {/* My applications */}
        {!loading && applications.length > 0 && (
          <div className="bg-white rounded-2xl shadow p-6">
            <h2 className="font-semibold text-gray-800 mb-4">My applications</h2>
            <div className="space-y-4">
              {applications.map((application) => (
                <div key={application._id} className="border border-gray-200 rounded-xl p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium text-gray-800">{application.programName}</div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        Requested {money(application.amountRequested)} ·{' '}
                        {application.submittedAt
                          ? `submitted ${formatDate(application.submittedAt)}`
                          : 'not submitted'}
                      </div>
                    </div>
                    <span
                      className={`px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap ${
                        STATUS_STYLES[application.status]
                      }`}
                    >
                      {STATUS_LABELS[application.status] || application.status}
                    </span>
                  </div>

                  {/* The score breakdown, not just the total — this is what
                      makes a refusal something a family can argue with. */}
                  {application.score?.total > 0 && (
                    <div className="mt-4 bg-gray-50 rounded-xl p-4">
                      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-gray-500 mb-3">
                        <Gauge size={13} /> How this was scored
                      </div>
                      <div className="grid grid-cols-4 gap-3 text-center">
                        {[
                          { label: 'Need', value: application.score.need },
                          { label: 'Academic', value: application.score.merit },
                          { label: 'Attendance', value: application.score.attendance },
                          { label: 'Total', value: application.score.total, strong: true },
                        ].map((part) => (
                          <div key={part.label}>
                            <div
                              className={`text-xl ${
                                part.strong ? 'font-bold text-teal-700' : 'font-semibold text-gray-700'
                              }`}
                            >
                              {part.value}
                            </div>
                            <div className="text-xs text-gray-500">{part.label}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {application.status === 'approved' && (
                    <div className="mt-3 text-sm font-medium text-emerald-700">
                      Awarded {money(application.amountAwarded)}
                    </div>
                  )}

                  {application.reviewNote && (
                    <p className="text-sm text-gray-600 mt-3 bg-gray-50 rounded-lg p-3">
                      {application.reviewNote}
                    </p>
                  )}

                  <div className="flex items-center gap-4 mt-3">
                    {application.status === 'draft' && (
                      <button
                        onClick={() => submitApplication(application)}
                        disabled={busy}
                        className="bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white text-xs px-4 py-2 rounded-lg"
                      >
                        Submit
                      </button>
                    )}
                    {['draft', 'submitted', 'under-review'].includes(application.status) && (
                      <button
                        onClick={() => withdraw(application)}
                        disabled={busy}
                        className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
                      >
                        Withdraw
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Programs */}
        {!loading && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {programs.length === 0 && (
              <p className="text-sm text-gray-400 col-span-full py-8 text-center">
                No aid programs are open at the moment.
              </p>
            )}

            {programs.map((program) => {
              const applied = appliedProgramIds.has(program._id);
              return (
                <div key={program._id} className="bg-white rounded-2xl shadow p-6 flex flex-col">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold text-gray-800">{program.name}</div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {program.aidType} · {program.academicYear}
                      </div>
                    </div>
                    <span className="text-xs font-medium bg-teal-50 text-teal-700 px-2.5 py-1 rounded-full whitespace-nowrap">
                      up to {money(program.maxAwardPerStudent, program.currency)}
                    </span>
                  </div>

                  {program.description && (
                    <p className="text-sm text-gray-600 mt-3">{program.description}</p>
                  )}

                  <div className="flex items-center gap-1.5 text-xs text-gray-500 mt-3">
                    <Calendar size={13} /> Closes {formatDate(program.closesOn)}
                  </div>

                  {/* The remaining budget is shown to families deliberately. A
                      fund that is nearly gone is information they should have
                      before they spend an evening on the form. */}
                  <div className="mt-4">
                    <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                      <span>Fund allocated</span>
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

                  <div className="mt-auto pt-4">
                    {applied ? (
                      <div className="text-center text-xs font-medium py-2 rounded-lg bg-gray-100 text-gray-600">
                        You have applied
                      </div>
                    ) : (
                      <button
                        onClick={() => startApplication(program)}
                        disabled={Boolean(program.unavailableReason)}
                        className="w-full bg-teal-700 hover:bg-teal-800 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm py-2 rounded-lg transition"
                      >
                        {program.unavailableReason || 'Apply'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Application form */}
      {applyingTo && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50 overflow-y-auto">
          <form
            onSubmit={submitDraft}
            className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-2xl space-y-4 my-8"
          >
            <div>
              <h3 className="font-semibold text-lg text-gray-800 flex items-center gap-2">
                <FileText size={18} /> {applyingTo.name}
              </h3>
              <p className="text-xs text-gray-500 mt-1">
                This is saved as a draft first. Nothing is scored or seen by the committee until you
                submit it.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="text-sm">
                <span className="text-gray-600 text-xs">Annual household income</span>
                <input
                  type="number"
                  min="0"
                  required
                  value={form.householdIncome}
                  onChange={(e) => setForm({ ...form, householdIncome: e.target.value })}
                  className="w-full mt-1 text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
                />
              </label>
              <label className="text-sm">
                <span className="text-gray-600 text-xs">Dependants in the household</span>
                <input
                  type="number"
                  min="0"
                  max="20"
                  value={form.dependants}
                  onChange={(e) => setForm({ ...form, dependants: e.target.value })}
                  className="w-full mt-1 text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
                />
              </label>
              <label className="text-sm">
                <span className="text-gray-600 text-xs">Guardian&apos;s occupation</span>
                <input
                  value={form.guardianOccupation}
                  onChange={(e) => setForm({ ...form, guardianOccupation: e.target.value })}
                  className="w-full mt-1 text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
                />
              </label>
              <label className="text-sm">
                <span className="text-gray-600 text-xs">Amount requested</span>
                <input
                  type="number"
                  min="1"
                  max={applyingTo.maxAwardPerStudent}
                  required
                  value={form.amountRequested}
                  onChange={(e) => setForm({ ...form, amountRequested: e.target.value })}
                  className="w-full mt-1 text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
                />
              </label>
              <label className="text-sm">
                <span className="text-gray-600 text-xs">Last year&apos;s percentage</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  required
                  value={form.academicPercentage}
                  onChange={(e) => setForm({ ...form, academicPercentage: e.target.value })}
                  className="w-full mt-1 text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
                />
              </label>
              <label className="text-sm">
                <span className="text-gray-600 text-xs">Attendance percentage</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={form.attendancePercentage}
                  onChange={(e) => setForm({ ...form, attendancePercentage: e.target.value })}
                  className="w-full mt-1 text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
                />
              </label>
            </div>

            <label className="block text-sm">
              <span className="text-gray-600 text-xs">Statement of need</span>
              <textarea
                required
                minLength={50}
                maxLength={2000}
                rows={6}
                value={form.statementOfNeed}
                onChange={(e) => setForm({ ...form, statementOfNeed: e.target.value })}
                placeholder="Tell the committee about your circumstances. At least 50 characters."
                className="w-full mt-1 text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400"
              />
            </label>

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={busy}
                className="flex-1 bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white text-sm py-2.5 rounded-lg transition"
              >
                {busy ? 'Saving…' : 'Save draft'}
              </button>
              <button
                type="button"
                onClick={() => setApplyingTo(null)}
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

export default FinancialAid;
