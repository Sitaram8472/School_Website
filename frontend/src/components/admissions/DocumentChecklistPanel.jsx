import { useState, useEffect, useCallback, useContext } from 'react';
import { FileCheck2, AlertTriangle, CheckCircle2, Clock3, XCircle, FilePlus2 } from 'lucide-react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * Admission document checklist.
 *
 * The checklist is the screen. One row per requirement, in requirement order,
 * with six states rather than two — and `expired` and `stale` styled as
 * problems rather than absences, because a clerk scanning for red will
 * otherwise tick straight past a document that is present and useless.
 *
 * The verify control on a document the current user receipted is shown
 * disabled with the reason on it. The two-person rule should be visible before
 * it is enforced.
 */

const STATE_STYLES = {
  missing: 'bg-slate-100 text-slate-600',
  submitted: 'bg-amber-100 text-amber-800',
  verified: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  expired: 'bg-red-100 text-red-700',
  stale: 'bg-orange-100 text-orange-800',
};

const STATE_LABELS = {
  missing: 'Not received',
  submitted: 'Awaiting check',
  verified: 'Verified',
  rejected: 'Rejected',
  expired: 'Expired',
  stale: 'Too old',
};

// `expired` and `stale` mean the document is there and does not count. They are
// the two a present/absent checklist reads as satisfied.
const PROBLEM_STATES = ['rejected', 'expired', 'stale'];

const FORMAT_LABELS = {
  original: 'Original',
  'attested-copy': 'Attested copy',
  photocopy: 'Photocopy',
  digital: 'Digital',
};

const EMPTY_RECEIPT = {
  requirementCode: '',
  format: 'original',
  reference: '',
  issuedOn: '',
  expiresOn: '',
  issuingAuthority: '',
};

const EMPTY_REQUIREMENT = {
  code: 'birth-certificate',
  label: '',
  description: '',
  appliesToGrades: '',
  isMandatory: true,
  maxAgeMonths: 0,
  requiresExpiryDate: false,
};

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

const DocumentChecklistPanel = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);

  const isAdmissions = role === 'admin' || role === 'staff';
  const isRegistrar = role === 'admin';
  const myId = user?._id || user?.user?._id || user?.id || null;

  const [tab, setTab] = useState('outstanding');

  const [outstanding, setOutstanding] = useState([]);
  const [requirements, setRequirements] = useState([]);
  const [meta, setMeta] = useState(null);

  const [selected, setSelected] = useState(null);
  const [checklist, setChecklist] = useState(null);
  const [clearance, setClearance] = useState(null);

  const [receipt, setReceipt] = useState(EMPTY_RECEIPT);
  const [requirementForm, setRequirementForm] = useState(EMPTY_REQUIREMENT);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 4000);
  };

  const explain = (err, fallback) =>
    setError(err?.response?.data?.message || err?.message || fallback);

  // ---- loading -------------------------------------------------------------

  const loadOutstanding = useCallback(async () => {
    if (!isAdmissions) return;

    setLoading(true);
    try {
      const [outstandingRes, requirementsRes, metaRes] = await Promise.all([
        api.get('/applications/documents/outstanding'),
        api.get('/applications/documents/requirements'),
        api.get('/applications/documents/meta'),
      ]);
      setOutstanding(outstandingRes.data.data || []);
      setRequirements(requirementsRes.data.data || []);
      setMeta(metaRes.data.data || null);
    } catch (err) {
      explain(err, 'Could not load the admissions documents.');
    } finally {
      setLoading(false);
    }
  }, [isAdmissions]);

  useEffect(() => {
    loadOutstanding();
  }, [loadOutstanding]);

  const openApplication = async (applicationId) => {
    setSelected(applicationId);
    setChecklist(null);
    setClearance(null);
    setReceipt(EMPTY_RECEIPT);
    setError('');

    try {
      const [checklistRes, clearanceRes] = await Promise.all([
        api.get(`/applications/documents/${applicationId}/checklist`),
        api.get(`/applications/documents/${applicationId}/clearance`),
      ]);
      setChecklist(checklistRes.data.data);
      setClearance(clearanceRes.data.data);
    } catch (err) {
      explain(err, 'Could not build the checklist.');
    }
  };

  const refreshChecklist = async () => {
    if (selected) await openApplication(selected);
    await loadOutstanding();
  };

  // ---- documents -----------------------------------------------------------

  const submitReceipt = async (event) => {
    event.preventDefault();
    setError('');

    if (!receipt.requirementCode) {
      setError('Pick which requirement this document is for.');
      return;
    }

    setLoading(true);
    try {
      const res = await api.post(`/applications/documents/${selected}`, {
        requirementCode: receipt.requirementCode,
        format: receipt.format,
        reference: receipt.reference.trim(),
        issuedOn: receipt.issuedOn || undefined,
        expiresOn: receipt.expiresOn || undefined,
        issuingAuthority: receipt.issuingAuthority.trim(),
      });
      flash(res.data.message || 'Document recorded.');
      setReceipt(EMPTY_RECEIPT);
      await refreshChecklist();
    } catch (err) {
      explain(err, 'Could not record the document.');
    } finally {
      setLoading(false);
    }
  };

  const verify = async (documentId) => {
    setError('');
    try {
      await api.patch(`/applications/documents/item/${documentId}/verify`, { note: '' });
      flash('Document verified.');
      await refreshChecklist();
    } catch (err) {
      explain(err, 'Could not verify the document.');
    }
  };

  const reject = async (documentId) => {
    const reason = window.prompt('What is wrong with it? The applicant is told this.');
    if (!reason || !reason.trim()) return;

    setError('');
    try {
      await api.patch(`/applications/documents/item/${documentId}/reject`, { reason: reason.trim() });
      flash('Document rejected.');
      await refreshChecklist();
    } catch (err) {
      explain(err, 'Could not reject the document.');
    }
  };

  // ---- requirements --------------------------------------------------------

  const submitRequirement = async (event) => {
    event.preventDefault();
    setError('');

    if (!requirementForm.label.trim()) {
      setError('Give the requirement a label.');
      return;
    }

    setLoading(true);
    try {
      const res = await api.post('/applications/documents/requirements', {
        code: requirementForm.code,
        label: requirementForm.label.trim(),
        description: requirementForm.description.trim(),
        appliesToGrades: requirementForm.appliesToGrades
          .split(',')
          .map((grade) => grade.trim())
          .filter(Boolean),
        isMandatory: requirementForm.isMandatory,
        maxAgeMonths: Number(requirementForm.maxAgeMonths) || 0,
        requiresExpiryDate: requirementForm.requiresExpiryDate,
      });
      flash(res.data.message || 'Requirement added.');
      setRequirementForm(EMPTY_REQUIREMENT);
      await loadOutstanding();
    } catch (err) {
      explain(err, 'Could not add the requirement.');
    } finally {
      setLoading(false);
    }
  };

  const retireRequirement = async (requirement) => {
    setError('');
    try {
      await api.patch(`/applications/documents/requirements/${requirement._id}/retire`, {});
      flash('Requirement retired.');
      await loadOutstanding();
    } catch (err) {
      explain(err, 'Could not retire the requirement.');
    }
  };

  const receivedByMe = (document) => {
    if (!document) return false;
    const receiver = document.receivedBy?._id || document.receivedBy;
    return myId && receiver && String(receiver) === String(myId);
  };

  // The admissions page is public. There is nothing here for a prospective
  // parent, and a permissions message on a prospectus page is worse than
  // rendering nothing.
  if (!isAdmissions) return null;

  // ---- rendering -----------------------------------------------------------

  const stateChip = (state) => (
    <span
      className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
        STATE_STYLES[state] || 'bg-slate-100 text-slate-600'
      }`}
    >
      {STATE_LABELS[state] || state}
    </span>
  );

  return (
    <div className="max-w-5xl mx-auto bg-white rounded-2xl border border-slate-200 shadow-sm p-6 my-12">
      <div className="flex items-center gap-2 mb-1">
        <FileCheck2 size={20} className="text-indigo-600" />
        <h2 className="text-lg font-bold text-slate-800">Admission documents</h2>
      </div>
      <p className="text-sm text-slate-500 mb-5">
        What each grade has to produce, what has arrived, and what somebody else has checked.
      </p>

      <div className="flex gap-2 mb-5 border-b border-slate-100">
        {[
          { key: 'outstanding', label: 'Outstanding' },
          { key: 'requirements', label: 'Requirements' },
        ].map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => setTab(entry.key)}
            className={`px-3 py-2 text-sm font-medium -mb-px border-b-2 transition ${
              tab === entry.key
                ? 'border-indigo-600 text-indigo-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-3 mb-4 text-sm flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 rounded-xl p-3 mb-4 text-sm flex items-center gap-2">
          <CheckCircle2 size={16} />
          {success}
        </div>
      )}

      {/* ---- applications still missing something ---- */}
      {tab === 'outstanding' && (
        <>
          {loading && outstanding.length === 0 && (
            <p className="text-sm text-slate-500">Loading…</p>
          )}

          {!loading && outstanding.length === 0 && (
            <p className="text-sm text-slate-500">
              Nothing outstanding. Either every pending application is documented, or no
              requirements have been set up yet.
            </p>
          )}

          <div className="space-y-2 mb-6">
            {outstanding.map((row) => (
              <button
                key={row.application._id}
                type="button"
                onClick={() => openApplication(row.application._id)}
                className={`w-full text-left border rounded-xl px-4 py-3 transition ${
                  selected === row.application._id
                    ? 'border-indigo-300 bg-indigo-50/40'
                    : 'border-slate-100 hover:border-indigo-200'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm">
                    <span className="font-semibold text-slate-800">{row.application.studentName}</span>
                    <span className="text-slate-400"> · {row.application.grade}</span>
                  </div>
                  <span className="text-xs font-semibold text-slate-600">
                    {row.mandatoryVerified} of {row.mandatoryCount} verified
                  </span>
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  {row.outstanding
                    .map((item) => `${item.label} (${STATE_LABELS[item.state] || item.state})`)
                    .join(' · ')}
                </div>
              </button>
            ))}
          </div>

          {/* ---- one application's checklist ---- */}
          {checklist && (
            <div className="border border-slate-200 rounded-2xl p-5">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div>
                  <h3 className="font-bold text-slate-800">
                    {checklist.application.studentName}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {checklist.application.grade} · application {checklist.application.status}
                  </p>
                </div>

                <div
                  className={`px-3 py-2 rounded-xl text-sm font-semibold ${
                    clearance?.cleared
                      ? 'bg-green-50 text-green-700'
                      : 'bg-amber-50 text-amber-800'
                  }`}
                >
                  {checklist.mandatoryVerified} of {checklist.mandatoryCount} mandatory documents
                  verified
                </div>
              </div>

              <div className="space-y-2 mb-5">
                {checklist.rows.map((row) => {
                  const mine = receivedByMe(row.document);
                  const problem = PROBLEM_STATES.includes(row.state);

                  return (
                    <div
                      key={row.code}
                      className={`border rounded-xl px-4 py-3 ${
                        problem ? 'border-red-200 bg-red-50/30' : 'border-slate-100'
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-slate-800">
                            {row.label}
                            {!row.isMandatory && (
                              <span className="ml-2 text-[11px] text-slate-500">optional</span>
                            )}
                          </div>

                          {row.document ? (
                            <div className="text-xs text-slate-500 mt-1">
                              {FORMAT_LABELS[row.document.format] || row.document.format}
                              {row.document.issuedOn &&
                                ` · issued ${formatDate(row.document.issuedOn)}`}
                              {row.document.expiresOn &&
                                ` · expires ${formatDate(row.document.expiresOn)}`}
                              {row.maxAgeMonths > 0 && ` · must be under ${row.maxAgeMonths} months old`}
                            </div>
                          ) : (
                            <div className="text-xs text-slate-500 mt-1">
                              {row.description || 'Not received yet.'}
                            </div>
                          )}

                          {row.document?.rejectionReason && (
                            <div className="text-xs text-red-600 mt-1">
                              {row.document.rejectionReason}
                            </div>
                          )}

                          {row.state === 'stale' && (
                            <div className="text-xs text-orange-700 mt-1 inline-flex items-center gap-1">
                              <Clock3 size={12} /> It is here, and it is too old to count.
                            </div>
                          )}
                          {row.state === 'expired' && (
                            <div className="text-xs text-red-700 mt-1 inline-flex items-center gap-1">
                              <XCircle size={12} /> It is here, and it has expired.
                            </div>
                          )}
                        </div>

                        <div className="flex flex-col items-end gap-2">
                          {stateChip(row.state)}

                          {row.document && row.state === 'submitted' && (
                            <div className="flex gap-2">
                              <button
                                type="button"
                                disabled={mine}
                                title={mine ? 'You received this document, so you cannot verify it' : ''}
                                onClick={() => verify(row.document._id)}
                                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-green-600 hover:bg-green-700 disabled:bg-slate-200 disabled:text-slate-500 text-white"
                              >
                                Verify
                              </button>
                              <button
                                type="button"
                                disabled={mine}
                                title={mine ? 'You received this document, so you cannot reject it' : ''}
                                onClick={() => reject(row.document._id)}
                                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-50 hover:bg-red-100 disabled:bg-slate-100 disabled:text-slate-400 text-red-700"
                              >
                                Reject
                              </button>
                            </div>
                          )}

                          {mine && row.state === 'submitted' && (
                            <span className="text-[11px] text-slate-400">
                              You took this in — someone else checks it
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* ---- record what just arrived ---- */}
              <form onSubmit={submitReceipt} className="border-t border-slate-100 pt-4">
                <h4 className="text-sm font-semibold text-slate-800 mb-3 flex items-center gap-1">
                  <FilePlus2 size={15} /> Record a document
                </h4>

                <div className="grid md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">For</label>
                    <select
                      value={receipt.requirementCode}
                      onChange={(event) =>
                        setReceipt({ ...receipt, requirementCode: event.target.value })
                      }
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                    >
                      <option value="">Pick a requirement…</option>
                      {checklist.rows.map((row) => (
                        <option key={row.code} value={row.code}>
                          {row.label}
                          {row.state !== 'missing' ? ' (replaces the current one)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Format</label>
                    <select
                      value={receipt.format}
                      onChange={(event) => setReceipt({ ...receipt, format: event.target.value })}
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                    >
                      {(meta?.formats || Object.keys(FORMAT_LABELS)).map((format) => (
                        <option key={format} value={format}>
                          {FORMAT_LABELS[format] || format}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      Issued on
                    </label>
                    <input
                      type="date"
                      value={receipt.issuedOn}
                      onChange={(event) => setReceipt({ ...receipt, issuedOn: event.target.value })}
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      Expires on
                    </label>
                    <input
                      type="date"
                      value={receipt.expiresOn}
                      onChange={(event) => setReceipt({ ...receipt, expiresOn: event.target.value })}
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      Issuing authority
                    </label>
                    <input
                      value={receipt.issuingAuthority}
                      onChange={(event) =>
                        setReceipt({ ...receipt, issuingAuthority: event.target.value })
                      }
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      Reference
                    </label>
                    <input
                      value={receipt.reference}
                      onChange={(event) => setReceipt({ ...receipt, reference: event.target.value })}
                      placeholder="Certificate number or file reference"
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="mt-3 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white rounded-lg text-sm font-medium"
                >
                  Record receipt
                </button>
              </form>
            </div>
          )}
        </>
      )}

      {/* ---- the requirement matrix ---- */}
      {tab === 'requirements' && (
        <>
          {isRegistrar && (
            <form onSubmit={submitRequirement} className="border border-slate-100 rounded-xl p-4 mb-6">
              <h3 className="text-sm font-semibold text-slate-800 mb-3">Add a requirement</h3>

              <div className="grid md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Document</label>
                  <select
                    value={requirementForm.code}
                    onChange={(event) =>
                      setRequirementForm({ ...requirementForm, code: event.target.value })
                    }
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                  >
                    {(meta?.codes || []).map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Label</label>
                  <input
                    value={requirementForm.label}
                    onChange={(event) =>
                      setRequirementForm({ ...requirementForm, label: event.target.value })
                    }
                    placeholder="Birth certificate"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Grades (blank means all)
                  </label>
                  <input
                    value={requirementForm.appliesToGrades}
                    onChange={(event) =>
                      setRequirementForm({ ...requirementForm, appliesToGrades: event.target.value })
                    }
                    placeholder="Grade 9, Grade 10"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Maximum age in months (0 = never goes off)
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={requirementForm.maxAgeMonths}
                    onChange={(event) =>
                      setRequirementForm({ ...requirementForm, maxAgeMonths: event.target.value })
                    }
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    What the applicant is told
                  </label>
                  <input
                    value={requirementForm.description}
                    onChange={(event) =>
                      setRequirementForm({ ...requirementForm, description: event.target.value })
                    }
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                  />
                </div>

                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={requirementForm.isMandatory}
                    onChange={(event) =>
                      setRequirementForm({ ...requirementForm, isMandatory: event.target.checked })
                    }
                  />
                  Mandatory
                </label>

                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={requirementForm.requiresExpiryDate}
                    onChange={(event) =>
                      setRequirementForm({
                        ...requirementForm,
                        requiresExpiryDate: event.target.checked,
                      })
                    }
                  />
                  Has an expiry date
                </label>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="mt-3 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white rounded-lg text-sm font-medium"
              >
                Add requirement
              </button>
            </form>
          )}

          {requirements.length === 0 ? (
            <p className="text-sm text-slate-500">
              No requirements yet, so every checklist is empty and nothing is being checked.
            </p>
          ) : (
            <div className="space-y-2">
              {requirements.map((requirement) => (
                <div
                  key={requirement._id}
                  className="border border-slate-100 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3"
                >
                  <div className="text-sm">
                    <span className="font-medium text-slate-800">{requirement.label}</span>
                    <span className="text-slate-400"> · {requirement.code}</span>
                    {!requirement.isMandatory && (
                      <span className="ml-2 text-[11px] text-slate-500">optional</span>
                    )}
                    <div className="text-xs text-slate-500 mt-1">
                      {requirement.appliesToGrades.length
                        ? requirement.appliesToGrades.join(', ')
                        : 'Every grade'}
                      {requirement.maxAgeMonths > 0 &&
                        ` · must be under ${requirement.maxAgeMonths} months old`}
                      {requirement.requiresExpiryDate && ' · expiry date required'}
                    </div>
                  </div>

                  {isRegistrar && (
                    <button
                      type="button"
                      onClick={() => retireRequirement(requirement)}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700"
                    >
                      Retire
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default DocumentChecklistPanel;
