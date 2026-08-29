import { useState, useEffect, useCallback, useContext, useMemo } from 'react';
import {
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  Users,
  HeartPulse,
  Plus,
  Trash2,
} from 'lucide-react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * Risk assessments for field trips.
 *
 * The panel leads with the readiness list, because that is the question being
 * asked — can this trip open? — and the answer should be one screen rather than
 * a form to scroll. Each blocker is a plain sentence carrying the two numbers
 * that produced it, so "shortfall: 1" never appears without the arithmetic that
 * got there.
 *
 * Hazards render as two coloured cells per row, inherent and residual. A
 * control that changed nothing then looks like two cells of the same colour,
 * which is a thing somebody notices; a number in a table is not.
 */

const CATEGORY_LABELS = {
  'low-risk-local': 'Low-risk local',
  standard: 'Standard',
  residential: 'Residential',
  'water-based': 'Water-based',
  adventurous: 'Adventurous',
  overseas: 'Overseas',
};

const AGE_BAND_LABELS = {
  'early-years': 'Early years',
  primary: 'Primary',
  'lower-secondary': 'Lower secondary',
  'upper-secondary': 'Upper secondary',
  mixed: 'Mixed ages',
};

const STATUS_STYLES = {
  draft: 'bg-gray-200 text-gray-700',
  submitted: 'bg-amber-100 text-amber-800',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  withdrawn: 'bg-gray-200 text-gray-600',
  superseded: 'bg-gray-100 text-gray-500',
};

const STATUS_LABELS = {
  draft: 'Draft',
  submitted: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Sent back',
  withdrawn: 'Withdrawn',
  superseded: 'Superseded',
};

const EMPTY_HAZARD = {
  code: '',
  description: '',
  whoIsAtRisk: 'Students and escorting staff',
  likelihood: 3,
  severity: 3,
  controls: [{ measure: '', inPlace: false }],
  residualLikelihood: 2,
  residualSeverity: 2,
};

const EMPTY_PLAN = {
  rendezvous: '',
  nearestHospital: '',
  headcountPoints: [],
  communications: '',
  recallProcedure: '',
};

/**
 * A 1–25 rating as a colour. The bands are the ones a school actually uses:
 * green is tolerable, amber wants watching, red does not go out.
 */
const ratingStyle = (rating) => {
  if (!rating) return 'bg-gray-100 text-gray-500';
  if (rating <= 6) return 'bg-green-100 text-green-800';
  if (rating <= 12) return 'bg-amber-100 text-amber-800';
  return 'bg-red-100 text-red-800';
};

const RiskAssessmentPanel = ({ tripId, tripTitle }) => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isStaff = role === 'teacher' || role === 'admin';
  const isAdmin = role === 'admin';
  const myId = user?._id || user?.user?._id || user?.id || null;

  const [meta, setMeta] = useState(null);
  const [assessment, setAssessment] = useState(null);
  const [readiness, setReadiness] = useState(null);
  const [versions, setVersions] = useState([]);

  const [drafting, setDrafting] = useState(false);
  const [form, setForm] = useState({
    activityCategory: 'standard',
    ageBand: 'primary',
    hazards: [],
    firstAiders: [],
    emergencyPlan: { ...EMPTY_PLAN },
  });

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 3500);
  };

  const explain = (err, fallback) => {
    const blockers = err?.response?.data?.blockers;
    if (Array.isArray(blockers) && blockers.length > 0) {
      setError(blockers.join(' '));
      return;
    }
    setError(err?.response?.data?.message || err?.message || fallback);
  };

  // ---- loading -------------------------------------------------------------

  const loadMeta = useCallback(async () => {
    if (!isStaff) return;
    try {
      const res = await api.get('/trips/risk/meta');
      setMeta(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load risk reference data.');
    }
  }, [isStaff]);

  const load = useCallback(async () => {
    if (!isStaff || !tripId) return;

    setLoading(true);
    try {
      const [assessmentRes, readinessRes, historyRes] = await Promise.all([
        api.get(`/trips/${tripId}/risk`),
        api.get(`/trips/${tripId}/risk/readiness`),
        api.get(`/trips/${tripId}/risk/history`),
      ]);

      setAssessment(assessmentRes.data.data || null);
      setReadiness(readinessRes.data.data || null);
      setVersions(historyRes.data.data || []);
    } catch (err) {
      explain(err, 'Could not load the risk assessment.');
    } finally {
      setLoading(false);
    }
  }, [isStaff, tripId]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    load();
  }, [load]);

  // ---- the hazard form -----------------------------------------------------

  /**
   * Seed the draft with the hazards that apply to this category, so the usual
   * trip needs no typing and the unusual one can still add its own.
   */
  const seedHazards = (category) => {
    if (!meta) return [];

    return meta.hazardLibrary
      .filter((hazard) => hazard.appliesTo === 'all' || hazard.appliesTo === category)
      .map((hazard) => ({
        ...EMPTY_HAZARD,
        code: hazard.code,
        description: hazard.label,
        controls: [{ measure: '', inPlace: false }],
      }));
  };

  const startDraft = () => {
    setDrafting(true);
    setForm((current) => ({
      ...current,
      hazards: seedHazards(current.activityCategory),
    }));
  };

  const setCategory = (category) => {
    setForm((current) => ({
      ...current,
      activityCategory: category,
      hazards: seedHazards(category),
    }));
  };

  const updateHazard = (index, patch) => {
    setForm((current) => ({
      ...current,
      hazards: current.hazards.map((hazard, i) => (i === index ? { ...hazard, ...patch } : hazard)),
    }));
  };

  const updateControl = (hazardIndex, value) => {
    setForm((current) => ({
      ...current,
      hazards: current.hazards.map((hazard, i) =>
        i === hazardIndex ? { ...hazard, controls: [{ measure: value, inPlace: false }] } : hazard
      ),
    }));
  };

  const removeHazard = (index) => {
    setForm((current) => ({
      ...current,
      hazards: current.hazards.filter((unused, i) => i !== index),
    }));
  };

  const addHazard = () => {
    setForm((current) => ({
      ...current,
      hazards: [...current.hazards, { ...EMPTY_HAZARD, code: `custom-${current.hazards.length + 1}` }],
    }));
  };

  const addHeadcountPoint = () => {
    const label = window.prompt('Where will the group be counted?');
    if (!label) return;

    setForm((current) => ({
      ...current,
      emergencyPlan: {
        ...current.emergencyPlan,
        headcountPoints: [...current.emergencyPlan.headcountPoints, { label }],
      },
    }));
  };

  const addFirstAider = () => {
    const name = window.prompt('Which escort is the first aider?');
    if (!name) return;

    setForm((current) => ({
      ...current,
      firstAiders: [...current.firstAiders, { name, qualification: '' }],
    }));
  };

  const submitDraft = async (event) => {
    event.preventDefault();
    setError('');
    setBusy(true);

    try {
      const res = await api.post(`/trips/${tripId}/risk`, form);
      flash(res.data.message || 'Assessment drafted.');
      setDrafting(false);
      load();
    } catch (err) {
      explain(err, 'Could not draft the assessment.');
    } finally {
      setBusy(false);
    }
  };

  // ---- decisions -----------------------------------------------------------

  const act = async (path, body, fallback) => {
    setError('');
    setBusy(true);

    try {
      const res = await api.patch(`/trips/risk/${assessment._id}/${path}`, body || {});
      flash(res.data.message || 'Done.');
      load();
    } catch (err) {
      explain(err, fallback);
    } finally {
      setBusy(false);
    }
  };

  const submitForApproval = () => act('submit', {}, 'Could not submit the assessment.');

  const approve = () => {
    const note = window.prompt('Note against the approval (optional):') || '';
    return act('approve', { note }, 'Could not approve the assessment.');
  };

  const reject = () => {
    const reason = window.prompt('What needs changing?');
    if (!reason) return;
    return act('reject', { reason }, 'Could not send the assessment back.');
  };

  const withdraw = () => act('withdraw', {}, 'Could not withdraw the assessment.');

  // ---- pieces --------------------------------------------------------------

  const tolerance = useMemo(
    () => assessment?.residualTolerance ?? meta?.residualTolerance?.[form.activityCategory] ?? 8,
    [assessment, meta, form.activityCategory]
  );

  const iAmAssessor = assessment && String(assessment.assessedBy) === String(myId);

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
        <div className="flex items-center gap-2">
          <ShieldAlert size={20} className="text-indigo-600" />
          <h2 className="text-lg font-bold text-gray-800">
            Risk assessment
            {tripTitle && <span className="text-gray-400 font-normal"> · {tripTitle}</span>}
          </h2>
        </div>

        {assessment && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">version {assessment.version}</span>
            {statusChip(assessment.status)}
          </div>
        )}
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

      {loading && <p className="text-sm text-gray-500">Loading…</p>}

      {/* ---- readiness: the question being asked ---- */}
      {readiness && (
        <div
          className={`rounded-xl p-4 mb-6 border ${
            readiness.ready ? 'bg-green-50 border-green-100' : 'bg-amber-50 border-amber-100'
          }`}
        >
          <div className="flex items-center gap-2 mb-2">
            {readiness.ready ? (
              <ShieldCheck size={18} className="text-green-700" />
            ) : (
              <AlertTriangle size={18} className="text-amber-700" />
            )}
            <span
              className={`font-semibold ${
                readiness.ready ? 'text-green-800' : 'text-amber-900'
              }`}
            >
              {readiness.ready
                ? 'This trip is cleared to open.'
                : `This trip cannot open yet — ${readiness.blockers.length} thing(s) outstanding.`}
            </span>
          </div>

          {!readiness.ready && (
            <ul className="text-sm text-amber-900 space-y-1 ml-6 list-disc">
              {readiness.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          )}

          {/* The rule, the input and the gap in one line, because a bare
              "shortfall: 1" invites an argument about where the 1 came from. */}
          <div className="text-xs text-gray-600 mt-3 flex items-center gap-1">
            <Users size={13} />
            {readiness.supervision.named} escort(s) named,{' '}
            {readiness.supervision.required} required for {readiness.trip.confirmedCount}{' '}
            {AGE_BAND_LABELS[assessment?.ageBand]?.toLowerCase() || 'registered'} children at 1 adult
            per {readiness.supervision.childrenPerAdult}.
          </div>

          {readiness.refusedMedicalConsent.length > 0 && (
            <div className="mt-3 bg-white rounded-lg p-3 border border-amber-200">
              <div className="text-xs font-semibold text-gray-700 flex items-center gap-1 mb-1">
                <HeartPulse size={13} className="text-red-600" />
                {readiness.refusedMedicalConsent.length} guardian(s) refused permission for first aid
              </div>
              <div className="text-xs text-gray-600">
                {readiness.refusedMedicalConsent
                  .map((child) => `${child.studentName} (${child.className})`)
                  .join(', ')}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---- the assessment itself ---- */}
      {assessment && !drafting && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            {[
              { label: 'Activity', value: CATEGORY_LABELS[assessment.activityCategory] },
              { label: 'Age band', value: AGE_BAND_LABELS[assessment.ageBand] },
              { label: 'Assessed for', value: `${assessment.assessedHeadcount} children` },
              { label: 'Residual tolerance', value: tolerance },
            ].map((tile) => (
              <div key={tile.label} className="bg-gray-50 rounded-xl p-3">
                <div className="text-xs text-gray-500">{tile.label}</div>
                <div className="font-bold text-gray-800">{tile.value}</div>
              </div>
            ))}
          </div>

          <div className="overflow-x-auto mb-5">
            <table className="w-full text-sm min-w-[40rem]">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                  <th className="py-2 pr-2 font-medium">Hazard</th>
                  <th className="py-2 pr-2 font-medium">Control</th>
                  <th className="py-2 px-1 font-medium text-center">Before</th>
                  <th className="py-2 px-1 font-medium text-center">After</th>
                </tr>
              </thead>
              <tbody>
                {assessment.hazards.map((hazard) => (
                  <tr key={hazard.code} className="border-b border-gray-50 last:border-0 align-top">
                    <td className="py-2 pr-2">
                      <div className="font-medium text-gray-800">{hazard.description}</div>
                      <div className="text-xs text-gray-500">{hazard.whoIsAtRisk}</div>
                    </td>
                    <td className="py-2 pr-2 text-gray-600 text-xs">
                      {hazard.controls.map((control) => control.measure).join('; ') || '—'}
                    </td>
                    <td className="py-2 px-1 text-center">
                      <span
                        className={`inline-block w-9 rounded font-semibold py-1 ${ratingStyle(
                          hazard.inherentRating
                        )}`}
                      >
                        {hazard.inherentRating}
                      </span>
                    </td>
                    <td className="py-2 px-1 text-center">
                      <span
                        className={`inline-block w-9 rounded font-semibold py-1 ${ratingStyle(
                          hazard.residualRating
                        )}`}
                      >
                        {hazard.residualRating}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bg-gray-50 rounded-xl p-4 mb-5 text-sm">
            <h3 className="font-semibold text-gray-800 mb-2">Emergency plan</h3>
            <div className="grid gap-2 text-gray-700">
              <div>
                <span className="text-gray-500">Rendezvous:</span>{' '}
                {assessment.emergencyPlan.rendezvous || '—'}
              </div>
              <div>
                <span className="text-gray-500">Nearest hospital:</span>{' '}
                {assessment.emergencyPlan.nearestHospital || '—'}
              </div>
              <div>
                <span className="text-gray-500">Headcount points:</span>{' '}
                {(assessment.emergencyPlan.headcountPoints || [])
                  .map((point) => point.label)
                  .join(', ') || '—'}
              </div>
              <div>
                <span className="text-gray-500">Communications:</span>{' '}
                {assessment.emergencyPlan.communications || '—'}
              </div>
              <div>
                <span className="text-gray-500">First aiders:</span>{' '}
                {assessment.firstAiders.map((aider) => aider.name).join(', ') || '—'}
              </div>
            </div>
          </div>

          {assessment.status === 'draft' && assessment.submissionBlockers.length > 0 && (
            <div className="bg-amber-50 border border-amber-100 rounded-xl p-3 mb-4 text-sm text-amber-900">
              <div className="font-semibold mb-1">Not ready to submit:</div>
              <ul className="list-disc ml-5 space-y-0.5">
                {assessment.submissionBlockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {assessment.status === 'draft' && (
              <button
                type="button"
                disabled={busy || assessment.submissionBlockers.length > 0}
                onClick={submitForApproval}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
              >
                Submit for approval
              </button>
            )}

            {assessment.status === 'submitted' && !iAmAssessor && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={approve}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium inline-flex items-center gap-1 disabled:opacity-50"
                >
                  <ShieldCheck size={15} /> Approve
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={reject}
                  className="px-4 py-2 border border-gray-200 text-gray-700 rounded-lg text-sm disabled:opacity-50"
                >
                  Send back
                </button>
              </>
            )}

            {assessment.status === 'submitted' && iAmAssessor && (
              <span className="text-xs text-gray-500 self-center">
                You wrote this assessment, so somebody who is not escorting the trip has to approve
                it.
              </span>
            )}

            {(assessment.status === 'draft' || assessment.status === 'submitted') && (
              <button
                type="button"
                disabled={busy}
                onClick={withdraw}
                className="px-4 py-2 border border-gray-200 text-gray-600 rounded-lg text-sm disabled:opacity-50"
              >
                Withdraw
              </button>
            )}

            {assessment.status === 'approved' && (
              <button
                type="button"
                onClick={startDraft}
                className="px-4 py-2 border border-indigo-200 text-indigo-700 rounded-lg text-sm"
              >
                Start version {assessment.version + 1}
              </button>
            )}
          </div>

          {versions.length > 1 && (
            <div className="mt-5 pt-4 border-t border-gray-100">
              <h3 className="text-xs font-semibold text-gray-500 mb-2">Earlier versions</h3>
              <div className="space-y-1">
                {versions.slice(1).map((version) => (
                  <div key={version._id} className="text-xs text-gray-500">
                    v{version.version} · {STATUS_LABELS[version.status] || version.status} ·{' '}
                    {version.assessedByName} · assessed for {version.assessedHeadcount} children
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ---- write one ---- */}
      {!assessment && !drafting && !loading && (
        <div className="text-center py-6">
          <p className="text-sm text-gray-500 mb-3">
            This trip has no risk assessment. It cannot open until one is approved.
          </p>
          <button
            type="button"
            onClick={startDraft}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium"
          >
            Write one
          </button>
        </div>
      )}

      {drafting && meta && (
        <form onSubmit={submitDraft} className="border border-gray-100 rounded-xl p-4">
          <div className="grid grid-cols-2 gap-3 mb-4">
            <label className="text-sm">
              <span className="block text-xs text-gray-500 mb-1">Activity</span>
              <select
                value={form.activityCategory}
                onChange={(event) => setCategory(event.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2"
              >
                {meta.activityCategories.map((category) => (
                  <option key={category} value={category}>
                    {CATEGORY_LABELS[category] || category}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-sm">
              <span className="block text-xs text-gray-500 mb-1">Age band</span>
              <select
                value={form.ageBand}
                onChange={(event) => setForm({ ...form, ageBand: event.target.value })}
                className="w-full border border-gray-200 rounded-lg px-3 py-2"
              >
                {meta.ageBands.map((band) => (
                  <option key={band} value={band}>
                    {AGE_BAND_LABELS[band] || band}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="text-xs text-gray-500 mb-3">
            The escort requirement follows from these two answers — it is not something to type in.
            Residual ratings above {meta.residualTolerance[form.activityCategory]} will refuse
            submission for a {CATEGORY_LABELS[form.activityCategory]?.toLowerCase()} trip.
          </p>

          <div className="space-y-3 mb-4">
            {form.hazards.map((hazard, index) => (
              <div key={hazard.code || index} className="border border-gray-100 rounded-lg p-3">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <input
                    value={hazard.description}
                    onChange={(event) => updateHazard(index, { description: event.target.value })}
                    placeholder="What is the hazard?"
                    className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => removeHazard(index)}
                    className="text-gray-400 hover:text-red-600 mt-1"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>

                <input
                  value={hazard.controls[0]?.measure || ''}
                  onChange={(event) => updateControl(index, event.target.value)}
                  placeholder="What will be done about it?"
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm mb-2"
                />

                <div className="grid grid-cols-4 gap-2 text-xs">
                  {[
                    ['likelihood', 'Likelihood'],
                    ['severity', 'Severity'],
                    ['residualLikelihood', 'After: likelihood'],
                    ['residualSeverity', 'After: severity'],
                  ].map(([field, label]) => (
                    <label key={field}>
                      <span className="block text-gray-500 mb-0.5">{label}</span>
                      <select
                        value={hazard[field]}
                        onChange={(event) =>
                          updateHazard(index, { [field]: Number(event.target.value) })
                        }
                        className="w-full border border-gray-200 rounded px-2 py-1"
                      >
                        {[1, 2, 3, 4, 5].map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>

                <div className="flex items-center gap-2 mt-2 text-xs">
                  <span className={`px-2 py-0.5 rounded ${ratingStyle(hazard.likelihood * hazard.severity)}`}>
                    before {hazard.likelihood * hazard.severity}
                  </span>
                  <span>→</span>
                  <span
                    className={`px-2 py-0.5 rounded ${ratingStyle(
                      hazard.residualLikelihood * hazard.residualSeverity
                    )}`}
                  >
                    after {hazard.residualLikelihood * hazard.residualSeverity}
                  </span>
                  {hazard.residualLikelihood * hazard.residualSeverity >=
                    hazard.likelihood * hazard.severity && (
                    <span className="text-red-600">
                      the control has to move this down
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={addHazard}
            className="text-sm text-indigo-600 inline-flex items-center gap-1 mb-4"
          >
            <Plus size={14} /> Add a hazard
          </button>

          <div className="grid gap-3 mb-4">
            <input
              value={form.emergencyPlan.rendezvous}
              onChange={(event) =>
                setForm({
                  ...form,
                  emergencyPlan: { ...form.emergencyPlan, rendezvous: event.target.value },
                })
              }
              placeholder="Rendezvous point"
              required
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />
            <input
              value={form.emergencyPlan.nearestHospital}
              onChange={(event) =>
                setForm({
                  ...form,
                  emergencyPlan: { ...form.emergencyPlan, nearestHospital: event.target.value },
                })
              }
              placeholder="Nearest hospital"
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />
            <input
              value={form.emergencyPlan.communications}
              onChange={(event) =>
                setForm({
                  ...form,
                  emergencyPlan: { ...form.emergencyPlan, communications: event.target.value },
                })
              }
              placeholder="How will escorts contact the school?"
              required
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />

            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-xs text-gray-500">Headcount points:</span>
              {form.emergencyPlan.headcountPoints.map((point) => (
                <span key={point.label} className="bg-gray-100 rounded px-2 py-0.5 text-xs">
                  {point.label}
                </span>
              ))}
              <button
                type="button"
                onClick={addHeadcountPoint}
                className="text-xs text-indigo-600"
              >
                + add
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-xs text-gray-500">First aiders:</span>
              {form.firstAiders.map((aider) => (
                <span key={aider.name} className="bg-gray-100 rounded px-2 py-0.5 text-xs">
                  {aider.name}
                </span>
              ))}
              <button type="button" onClick={addFirstAider} className="text-xs text-indigo-600">
                + add
              </button>
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save draft'}
            </button>
            <button
              type="button"
              onClick={() => setDrafting(false)}
              className="px-4 py-2 border border-gray-200 text-gray-600 rounded-lg text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {isAdmin && !tripId && (
        <p className="text-xs text-gray-400 mt-4">
          Open a trip to see or write its assessment.
        </p>
      )}
    </div>
  );
};

export default RiskAssessmentPanel;
