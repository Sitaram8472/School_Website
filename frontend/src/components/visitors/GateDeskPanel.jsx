import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  DoorOpen,
  DoorClosed,
  Users,
  AlertTriangle,
  Check,
  RefreshCw,
  Search,
  Siren,
  Clock,
  BarChart3,
} from 'lucide-react';
import api from '../../utils/axios';

const PURPOSES = [
  'parent-meeting',
  'admission-enquiry',
  'delivery',
  'maintenance',
  'official',
  'event',
  'student-pickup',
  'medical',
  'other',
];

const ID_PROOF_TYPES = ['aadhaar', 'driving-licence', 'passport', 'voter-id', 'employee-id', 'other'];

const STATUS_STYLES = {
  expected: 'bg-blue-100 text-blue-700',
  'checked-in': 'bg-emerald-100 text-emerald-700',
  'checked-out': 'bg-gray-100 text-gray-600',
  cancelled: 'bg-gray-100 text-gray-500',
  'auto-closed': 'bg-amber-100 text-amber-800',
};

const APPROVAL_STYLES = {
  pending: 'bg-amber-100 text-amber-800',
  approved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-rose-100 text-rose-700',
  'not-required': 'bg-gray-100 text-gray-600',
};

const formatTime = (value) =>
  value
    ? new Date(value).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

const emptyVisitor = () => ({
  passType: 'visitor',
  visitorName: '',
  visitorPhone: '',
  organisation: '',
  idProofType: 'aadhaar',
  idNumber: '',
  vehicleNumber: '',
  accompanyingCount: 0,
  hostId: '',
  purpose: 'parent-meeting',
  purposeNote: '',
  expectedDurationMinutes: 60,
});

const emptyGatePass = () => ({
  passType: 'gate-pass',
  studentId: '',
  guardianName: '',
  guardianRelation: '',
  purpose: 'student-pickup',
  purposeNote: '',
  expectedDurationMinutes: 60,
});

/**
 * The gate desk: register, approve, check in and out, and the live on-campus
 * roll.
 *
 * The roll is the first tab on purpose. It is the thing somebody needs at the
 * moment a fire alarm goes off, and it should not be two clicks away.
 */
const GateDeskPanel = () => {
  const [tab, setTab] = useState('campus');

  const [onCampus, setOnCampus] = useState({ data: [], count: 0, headcount: 0, overstayed: 0 });
  const [passes, setPasses] = useState([]);
  const [stats, setStats] = useState(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [visitorForm, setVisitorForm] = useState(emptyVisitor());
  const [gatePassForm, setGatePassForm] = useState(emptyGatePass());
  const [registerMode, setRegisterMode] = useState('visitor');

  const loadCampus = useCallback(async () => {
    const res = await api.get('/visitors/passes/on-campus');
    setOnCampus({
      data: res.data.data || [],
      count: res.data.count || 0,
      headcount: res.data.headcount || 0,
      overstayed: res.data.overstayed || 0,
    });
  }, []);

  const loadPasses = useCallback(async (term, status) => {
    const params = {};
    if (term) params.search = term;
    if (status) params.status = status;
    const res = await api.get('/visitors/passes', { params });
    setPasses(res.data.data || []);
  }, []);

  const loadStats = useCallback(async () => {
    const res = await api.get('/visitors/stats');
    setStats(res.data.stats);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await Promise.all([loadCampus(), loadPasses(search.trim(), statusFilter), loadStats()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the gate data.');
    } finally {
      setLoading(false);
    }
  }, [loadCampus, loadPasses, loadStats, search, statusFilter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const act = async (pass, path, body, successFallback) => {
    setBusyId(pass._id);
    setError('');
    setNotice('');
    try {
      const res = await api.patch(`/visitors/passes/${pass._id}/${path}`, body || {});
      setNotice(res.data.message || successFallback);
      await Promise.all([loadCampus(), loadPasses(search.trim(), statusFilter)]);
    } catch (err) {
      setError(err.response?.data?.message || 'That did not work.');
    } finally {
      setBusyId(null);
    }
  };

  const register = async (event) => {
    event.preventDefault();
    setBusyId('register');
    setError('');
    setNotice('');
    const form = registerMode === 'visitor' ? visitorForm : gatePassForm;
    try {
      const res = await api.post('/visitors/passes', {
        ...form,
        accompanyingCount: Number(form.accompanyingCount) || 0,
        expectedDurationMinutes: Number(form.expectedDurationMinutes) || 60,
      });
      setNotice(res.data.message);
      if (registerMode === 'visitor') setVisitorForm(emptyVisitor());
      else setGatePassForm(emptyGatePass());
      await loadPasses(search.trim(), statusFilter);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not register that pass.');
    } finally {
      setBusyId(null);
    }
  };

  const reconcile = async () => {
    setBusyId('reconcile');
    setError('');
    setNotice('');
    try {
      const res = await api.post('/visitors/passes/reconcile', { graceMinutes: 120 });
      setNotice(res.data.message);
      await Promise.all([loadCampus(), loadPasses(search.trim(), statusFilter), loadStats()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Reconciliation failed.');
    } finally {
      setBusyId(null);
    }
  };

  const runSearch = (event) => {
    event.preventDefault();
    refresh();
  };

  const overstayers = useMemo(
    () => onCampus.data.filter((pass) => pass.isOverstayed),
    [onCampus]
  );

  const tabs = [
    { id: 'campus', label: `On campus (${onCampus.count})` },
    { id: 'register', label: 'Register' },
    { id: 'passes', label: 'All passes' },
    { id: 'stats', label: 'Stats' },
  ];

  const activeForm = registerMode === 'visitor' ? visitorForm : gatePassForm;
  const setActiveForm = registerMode === 'visitor' ? setVisitorForm : setGatePassForm;

  return (
    <div className="bg-white rounded-2xl shadow-lg p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-800">Gate desk</h2>
          <p className="text-sm text-gray-500">Visitors, gate passes and who is on site</p>
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
            className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition ${
              tab === item.id ? 'bg-slate-800 text-white shadow' : 'text-gray-500 hover:text-gray-700'
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

      {/* ---- On campus ---- */}
      {tab === 'campus' && (
        <div className="space-y-5">
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-slate-800 text-white rounded-2xl p-5">
              <div className="text-xs uppercase tracking-wide text-slate-300 flex items-center gap-1.5">
                <Users size={12} /> Headcount
              </div>
              <div className="text-3xl font-bold mt-1">{onCampus.headcount}</div>
              <div className="text-xs text-slate-300 mt-1">
                across {onCampus.count} open pass(es)
              </div>
            </div>
            <div className="border border-gray-200 rounded-2xl p-5">
              <div className="text-xs uppercase tracking-wide text-gray-400">Visitors</div>
              <div className="text-3xl font-bold text-gray-800 mt-1">
                {onCampus.data.filter((pass) => pass.passType === 'visitor').length}
              </div>
            </div>
            <div
              className={`rounded-2xl p-5 ${
                onCampus.overstayed > 0
                  ? 'bg-amber-50 border border-amber-300'
                  : 'border border-gray-200'
              }`}
            >
              <div className="text-xs uppercase tracking-wide text-gray-400 flex items-center gap-1.5">
                <Clock size={12} /> Overstaying
              </div>
              <div className="text-3xl font-bold text-gray-800 mt-1">{onCampus.overstayed}</div>
            </div>
          </div>

          {overstayers.length > 0 && (
            <div className="bg-amber-50 border border-amber-300 rounded-2xl p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-medium text-amber-900">
                  <Siren size={16} /> {overstayers.length} pass(es) past their expected departure
                </div>
                <button
                  onClick={reconcile}
                  disabled={busyId === 'reconcile'}
                  className="text-xs bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg"
                >
                  Auto-close stale passes
                </button>
              </div>
              <p className="text-xs text-amber-800 mt-2">
                Auto-closing records that we assumed they left, not that anybody watched them go.
              </p>
            </div>
          )}

          <div className="space-y-2">
            {onCampus.data.length === 0 && (
              <p className="text-sm text-gray-400 py-6 text-center">Nobody is signed in.</p>
            )}
            {onCampus.data.map((pass) => (
              <div
                key={pass._id}
                className={`border rounded-xl p-4 ${
                  pass.isOverstayed ? 'border-amber-300 bg-amber-50' : 'border-gray-200'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-gray-800">
                      {pass.visitorName || pass.studentName}
                      {pass.accompanyingCount > 0 && (
                        <span className="text-xs text-gray-500 font-normal">
                          {' '}
                          +{pass.accompanyingCount}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {pass.badgeNumber} · in at {formatTime(pass.checkInAt)} ·{' '}
                      {pass.durationMinutes} min
                      {pass.hostName ? ` · hosted by ${pass.hostName}` : ''}
                      {pass.guardianName ? ` · collected by ${pass.guardianName}` : ''}
                    </div>
                    {pass.isOverstayed && (
                      <div className="text-xs text-amber-800 font-medium mt-1">
                        {pass.minutesOverstayed} min over
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => act(pass, 'check-out', {}, 'Checked out.')}
                    disabled={busyId === pass._id}
                    className="inline-flex items-center gap-1.5 bg-slate-800 hover:bg-slate-900 disabled:opacity-50 text-white text-xs px-3 py-2 rounded-lg whitespace-nowrap"
                  >
                    <DoorClosed size={13} /> Check out
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---- Register ---- */}
      {tab === 'register' && (
        <form onSubmit={register} className="max-w-2xl space-y-4">
          <div className="flex gap-2 bg-gray-100 rounded-xl p-1">
            {[
              { id: 'visitor', label: 'Visitor coming in' },
              { id: 'gate-pass', label: 'Student going out' },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setRegisterMode(item.id)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${
                  registerMode === item.id
                    ? 'bg-white text-gray-800 shadow'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          {registerMode === 'visitor' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                required
                value={visitorForm.visitorName}
                onChange={(e) => setVisitorForm({ ...visitorForm, visitorName: e.target.value })}
                placeholder="Visitor name"
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
              <input
                value={visitorForm.visitorPhone}
                onChange={(e) => setVisitorForm({ ...visitorForm, visitorPhone: e.target.value })}
                placeholder="Phone"
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
              <input
                value={visitorForm.organisation}
                onChange={(e) => setVisitorForm({ ...visitorForm, organisation: e.target.value })}
                placeholder="Organisation"
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
              <input
                required
                value={visitorForm.hostId}
                onChange={(e) => setVisitorForm({ ...visitorForm, hostId: e.target.value })}
                placeholder="Host user id"
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
              <select
                value={visitorForm.idProofType}
                onChange={(e) => setVisitorForm({ ...visitorForm, idProofType: e.target.value })}
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
              >
                {ID_PROOF_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <input
                value={visitorForm.idNumber}
                onChange={(e) => setVisitorForm({ ...visitorForm, idNumber: e.target.value })}
                placeholder="ID number — only the last 4 are kept"
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
              <input
                value={visitorForm.vehicleNumber}
                onChange={(e) => setVisitorForm({ ...visitorForm, vehicleNumber: e.target.value })}
                placeholder="Vehicle number"
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
              <input
                type="number"
                min="0"
                value={visitorForm.accompanyingCount}
                onChange={(e) =>
                  setVisitorForm({ ...visitorForm, accompanyingCount: e.target.value })
                }
                placeholder="Accompanying people"
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                required
                value={gatePassForm.studentId}
                onChange={(e) => setGatePassForm({ ...gatePassForm, studentId: e.target.value })}
                placeholder="Student user id"
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
              <input
                required
                value={gatePassForm.guardianName}
                onChange={(e) => setGatePassForm({ ...gatePassForm, guardianName: e.target.value })}
                placeholder="Who is collecting them"
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
              <input
                value={gatePassForm.guardianRelation}
                onChange={(e) =>
                  setGatePassForm({ ...gatePassForm, guardianRelation: e.target.value })
                }
                placeholder="Relationship to the student"
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <select
              value={activeForm.purpose}
              onChange={(e) => setActiveForm({ ...activeForm, purpose: e.target.value })}
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              {PURPOSES.map((purpose) => (
                <option key={purpose} value={purpose}>
                  {purpose}
                </option>
              ))}
            </select>
            <input
              type="number"
              min="5"
              max="720"
              value={activeForm.expectedDurationMinutes}
              onChange={(e) =>
                setActiveForm({ ...activeForm, expectedDurationMinutes: e.target.value })
              }
              placeholder="Expected minutes on site"
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
          </div>

          <textarea
            rows={2}
            maxLength={300}
            value={activeForm.purposeNote}
            onChange={(e) => setActiveForm({ ...activeForm, purposeNote: e.target.value })}
            placeholder="Anything else"
            className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
          />

          <button
            type="submit"
            disabled={busyId === 'register'}
            className="bg-slate-800 hover:bg-slate-900 disabled:opacity-50 text-white text-sm px-6 py-2.5 rounded-lg transition"
          >
            {busyId === 'register' ? 'Registering…' : 'Register pass'}
          </button>
        </form>
      )}

      {/* ---- All passes ---- */}
      {tab === 'passes' && (
        <div className="space-y-4">
          <form onSubmit={runSearch} className="flex flex-wrap gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, badge or organisation"
              className="flex-1 min-w-[200px] text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              <option value="">Any status</option>
              {['expected', 'checked-in', 'checked-out', 'cancelled', 'auto-closed'].map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="bg-slate-800 hover:bg-slate-900 text-white px-3 rounded-lg"
              aria-label="Search"
            >
              <Search size={16} />
            </button>
          </form>

          {passes.length === 0 && <p className="text-sm text-gray-400 py-6">No passes found.</p>}

          {passes.map((pass) => (
            <div key={pass._id} className="border border-gray-200 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium text-gray-800">
                    {pass.visitorName || pass.studentName}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {pass.badgeNumber} · {pass.passType} · {pass.purpose}
                    {pass.idNumberMasked ? ` · ID ${pass.idNumberMasked}` : ''}
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    registered {formatTime(pass.createdAt)}
                    {pass.checkInAt ? ` · in ${formatTime(pass.checkInAt)}` : ''}
                    {pass.checkOutAt ? ` · out ${formatTime(pass.checkOutAt)}` : ''}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      STATUS_STYLES[pass.status] || 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {pass.status}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      APPROVAL_STYLES[pass.approvalStatus] || 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {pass.approvalStatus}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-3 mt-3 pt-3 border-t border-gray-50">
                {pass.approvalStatus === 'pending' && pass.passType === 'gate-pass' && (
                  <button
                    onClick={() => act(pass, 'approve', { decision: 'approved' }, 'Approved.')}
                    disabled={busyId === pass._id}
                    className="text-xs text-emerald-600 hover:text-emerald-700 disabled:opacity-50"
                  >
                    Authorise release
                  </button>
                )}
                {pass.status === 'expected' && pass.approvalStatus === 'approved' && (
                  <button
                    onClick={() => act(pass, 'check-in', {}, 'Checked in.')}
                    disabled={busyId === pass._id}
                    className="inline-flex items-center gap-1.5 text-xs text-slate-700 hover:text-slate-900 disabled:opacity-50"
                  >
                    <DoorOpen size={13} /> Check in
                  </button>
                )}
                {pass.status === 'checked-in' && (
                  <button
                    onClick={() => act(pass, 'check-out', {}, 'Checked out.')}
                    disabled={busyId === pass._id}
                    className="inline-flex items-center gap-1.5 text-xs text-slate-700 hover:text-slate-900 disabled:opacity-50"
                  >
                    <DoorClosed size={13} /> Check out
                  </button>
                )}
                {pass.status === 'expected' && (
                  <button
                    onClick={() => act(pass, 'cancel', { reason: 'Not attending' }, 'Cancelled.')}
                    disabled={busyId === pass._id}
                    className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50 ml-auto"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---- Stats ---- */}
      {tab === 'stats' && stats && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'On campus now', value: stats.onCampusNow },
              { label: 'Headcount', value: stats.headcountNow },
              { label: 'Overstaying', value: stats.overstayedNow },
              { label: 'Awaiting approval', value: stats.awaitingApproval },
              { label: 'Visits (30d)', value: stats.last30Days },
              { label: 'Gate passes (30d)', value: stats.gatePasses },
              {
                label: 'Average visit',
                value: stats.averageVisitMinutes === null ? '—' : `${stats.averageVisitMinutes} min`,
              },
              {
                label: 'Unobserved exits',
                value:
                  stats.unobservedExitRate === null ? '—' : `${stats.unobservedExitRate}%`,
                hint: 'Closed by assumption, not by anyone watching',
              },
            ].map((card) => (
              <div key={card.label} className="border border-gray-200 rounded-2xl p-5">
                <div className="text-xs uppercase tracking-wide text-gray-400">{card.label}</div>
                <div className="text-2xl font-bold text-gray-800 mt-1">{card.value}</div>
                {card.hint && <div className="text-xs text-gray-400 mt-1">{card.hint}</div>}
              </div>
            ))}
          </div>

          {stats.byPurpose?.length > 0 && (
            <div className="border border-gray-200 rounded-2xl p-5">
              <h3 className="font-semibold text-sm text-gray-800 mb-3 flex items-center gap-2">
                <BarChart3 size={15} /> Why people came, last 30 days
              </h3>
              <div className="space-y-2">
                {stats.byPurpose.map((row) => (
                  <div key={row.purpose} className="flex items-center gap-3">
                    <span className="text-xs text-gray-600 w-40 shrink-0">{row.purpose}</span>
                    <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-slate-700 rounded-full"
                        style={{
                          width: `${Math.round((row.count / stats.last30Days) * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="text-xs text-gray-500 w-8 text-right">{row.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default GateDeskPanel;
