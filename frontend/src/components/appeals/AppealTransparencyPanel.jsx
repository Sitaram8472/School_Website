import { useState, useEffect, useCallback, useContext } from 'react';
import {
  BarChart3,
  EyeOff,
  Fingerprint,
  ShieldAlert,
  CheckCircle2,
  Calculator,
} from 'lucide-react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * Published appeal outcomes.
 *
 * The figures a family wants before they ever have an appeal to make: how many
 * were submitted, how many changed a mark, and how long it took. They are read
 * off a published report rather than computed live, so the percentage quoted
 * here in March is the same percentage in June.
 *
 * The suppression note is not decoration. A reader who sees a course with no
 * numbers against it is entitled to know that the row was withheld because the
 * cohort was too small to report on without identifying somebody, rather than
 * being handed a shorter list with no explanation.
 */

const REASON_LABELS = {
  'calculation-error': 'Calculation error',
  'unmarked-answer': 'Unmarked answer',
  'marking-scheme-mismatch': 'Marking scheme mismatch',
  'answer-misread': 'Answer misread',
  'technical-issue': 'Technical issue',
  other: 'Other',
};

const STATUS_STYLES = {
  draft: 'bg-amber-100 text-amber-800',
  approved: 'bg-blue-100 text-blue-700',
  published: 'bg-green-100 text-green-700',
  withdrawn: 'bg-gray-200 text-gray-600',
};

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—';

const cell = (value) => (value === null || value === undefined ? '—' : value);

const AppealTransparencyPanel = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';
  const myId = user?._id || user?.user?._id || user?.id || null;

  const [reports, setReports] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [meta, setMeta] = useState(null);

  const [manageRows, setManageRows] = useState([]);
  const [showManage, setShowManage] = useState(false);
  const [spec, setSpec] = useState({
    periodLabel: '',
    academicYear: '',
    from: '',
    to: '',
    suppressionThreshold: 5,
  });
  const [preview, setPreview] = useState(null);

  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 3500);
  };

  const explain = (err, fallback) =>
    err?.response?.data?.message || err?.message || fallback;

  const loadPublished = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const [listRes, metaRes] = await Promise.all([
        api.get('/appeals/statistics/published'),
        api.get('/appeals/statistics/meta'),
      ]);

      const rows = listRes.data.data || [];
      setReports(rows);
      setMeta(metaRes.data.data);
      setSelectedId((current) => current || (rows[0] ? rows[0]._id : ''));
    } catch (err) {
      setError(explain(err, 'Could not load the published figures.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPublished();
  }, [loadPublished]);

  const loadManage = useCallback(async () => {
    if (!isAdmin) return;

    try {
      const { data } = await api.get('/appeals/statistics');
      setManageRows(data.data || []);
    } catch (err) {
      setError(explain(err, 'Could not load the report list.'));
    }
  }, [isAdmin]);

  useEffect(() => {
    if (showManage) loadManage();
  }, [showManage, loadManage]);

  const selected = reports.find((report) => report._id === selectedId) || reports[0] || null;

  const runPreview = async () => {
    setError('');

    if (!spec.from || !spec.to) {
      setError('Give the period this report covers.');
      return;
    }

    setBusyId('preview');

    try {
      const { data } = await api.post('/appeals/statistics/preview', {
        from: spec.from,
        to: spec.to,
        suppressionThreshold: Number(spec.suppressionThreshold) || 5,
      });

      setPreview(data.data);
    } catch (err) {
      setError(explain(err, 'Could not compute the preview.'));
    } finally {
      setBusyId('');
    }
  };

  const createReport = async (supersede = false) => {
    setError('');

    if (!spec.periodLabel.trim()) {
      setError('A period label is needed — "Term 1 2026-27", for instance.');
      return;
    }

    setBusyId('create');

    try {
      await api.post('/appeals/statistics', {
        ...spec,
        suppressionThreshold: Number(spec.suppressionThreshold) || 5,
        supersede,
      });

      flash('Report computed. Somebody else has to approve it.');
      setPreview(null);
      await loadManage();
    } catch (err) {
      const message = explain(err, 'Could not compute the report.');

      // A live report for the same period is a deliberate replacement rather
      // than an error, so the confirmation is offered rather than the request
      // simply failing.
      if (!supersede && /supersede: true/.test(message)) {
        if (window.confirm(`${message}\n\nReplace it?`)) {
          setBusyId('');
          return createReport(true);
        }
      } else {
        setError(message);
      }
    } finally {
      setBusyId('');
    }
  };

  const act = async (row, path, body, message) => {
    setBusyId(row._id);
    setError('');

    try {
      await api.patch(`/appeals/statistics/${row._id}/${path}`, body || {});
      flash(message);
      await Promise.all([loadManage(), loadPublished()]);
    } catch (err) {
      setError(explain(err, 'Could not update the report.'));
    } finally {
      setBusyId('');
    }
  };

  const withdraw = (row) => {
    const reason = window.prompt('Why is this report being withdrawn? This is recorded.');
    if (reason === null) return;

    if (!reason.trim()) {
      setError('A withdrawal needs a reason.');
      return;
    }

    act(row, 'withdraw', { reason }, 'Report withdrawn.');
  };

  const renderTable = (rows, threshold) => (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-200">
            <th className="py-2 pr-4">Subject</th>
            <th className="py-2 pr-4">Submitted</th>
            <th className="py-2 pr-4">Decided</th>
            <th className="py-2 pr-4">Mark changed</th>
            <th className="py-2 pr-4">Rejected</th>
            <th className="py-2 pr-4">Median days</th>
          </tr>
        </thead>

        <tbody>
          {rows.map((row) => (
            <tr
              key={row.courseName}
              className={`border-b border-slate-100 ${
                row.suppressed ? 'text-slate-400 italic' : 'text-slate-700'
              }`}
            >
              <td className="py-2 pr-4">{row.courseName}</td>

              {row.suppressed ? (
                <td className="py-2 pr-4" colSpan="5">
                  <EyeOff size={13} className="inline mr-1" />
                  fewer than {threshold} appeals — withheld
                </td>
              ) : (
                <>
                  <td className="py-2 pr-4">{cell(row.submitted)}</td>
                  <td className="py-2 pr-4">{cell(row.decided)}</td>
                  <td className="py-2 pr-4">
                    {cell(
                      row.upheld === null ? null : row.upheld + row.partiallyUpheld
                    )}
                  </td>
                  <td className="py-2 pr-4">{cell(row.rejected)}</td>
                  <td className="py-2 pr-4">{cell(row.medianDaysToDecision)}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <section className="max-w-5xl mx-auto px-4 py-16">
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-slate-800 flex items-center gap-2">
          <BarChart3 className="text-blue-600" size={28} />
          Exam appeals: what actually happens
        </h2>
        <p className="text-slate-600 mt-2 max-w-3xl">
          When a student asks for a paper to be looked at again, how often does the mark
          change, and how long does it take? These figures are published for each
          reporting period and do not change afterwards.
        </p>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md bg-red-50 border border-red-200 p-3 text-red-700">
          <ShieldAlert size={18} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="mb-4 flex items-start gap-2 rounded-md bg-green-50 border border-green-200 p-3 text-green-700">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      {loading && <p className="text-slate-500">Loading…</p>}

      {!loading && !reports.length && (
        <p className="text-slate-500">
          No reporting period has been published yet.
        </p>
      )}

      {selected && (
        <>
          {reports.length > 1 && (
            <div className="mb-5 flex flex-wrap gap-2">
              {reports.map((report) => (
                <button
                  key={report._id}
                  type="button"
                  onClick={() => setSelectedId(report._id)}
                  className={`px-4 py-2 rounded-full text-sm font-medium transition ${
                    report._id === selected._id
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-slate-700 border border-slate-300 hover:bg-blue-50'
                  }`}
                >
                  {report.period.label}
                </button>
              ))}
            </div>
          )}

          <div className="rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
              <div>
                <h3 className="text-xl font-semibold text-slate-800">{selected.title}</h3>
                <p className="text-sm text-slate-500">
                  {formatDate(selected.period.from)} to {formatDate(selected.period.to)} ·
                  published {formatDate(selected.publishedAt)}
                </p>
              </div>

              {selected.checksum && (
                <span
                  className="text-xs text-slate-400 font-mono flex items-center gap-1"
                  title="A digest over the figures as approved"
                >
                  <Fingerprint size={13} />
                  {selected.checksum.slice(0, 12)}
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-2xl font-bold text-slate-800">
                  {selected.totals.submitted}
                </p>
                <p className="text-sm text-slate-500">appeals submitted</p>
              </div>

              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-2xl font-bold text-slate-800">
                  {selected.totals.upheldRate}%
                </p>
                <p className="text-sm text-slate-500">changed the mark</p>
              </div>

              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-2xl font-bold text-slate-800">
                  {cell(selected.totals.medianDaysToDecision)}
                </p>
                <p className="text-sm text-slate-500">median days to a decision</p>
              </div>

              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-2xl font-bold text-slate-800">
                  {selected.totals.marksMoved}
                </p>
                <p className="text-sm text-slate-500">marks moved in total</p>
              </div>
            </div>

            {selected.narrative && (
              <p className="text-slate-700 mb-6">{selected.narrative}</p>
            )}

            {renderTable(selected.rows, selected.suppressionThreshold)}

            {selected.byReason?.some((row) => row.count) && (
              <div className="mt-6">
                <h4 className="font-semibold text-slate-700 mb-2">Why students appealed</h4>
                <div className="flex flex-wrap gap-2">
                  {selected.byReason
                    .filter((row) => row.count)
                    .map((row) => (
                      <span
                        key={row.reason}
                        className="px-3 py-1 rounded-full bg-slate-100 text-slate-700 text-xs"
                      >
                        {REASON_LABELS[row.reason] || row.reason}: {row.count}
                      </span>
                    ))}
                </div>
              </div>
            )}

            <p className="mt-6 text-xs text-slate-500 flex items-start gap-2">
              <EyeOff size={14} className="mt-0.5 shrink-0" />
              Any subject with fewer than {selected.totals.coursesSuppressed >= 0
                ? selected.suppressionThreshold
                : 5}{' '}
              appeals in this period is listed without its figures, so that no individual
              student can be identified from them.{' '}
              {selected.totals.coursesSuppressed > 0 &&
                `${selected.totals.coursesSuppressed} of ${
                  selected.totals.coursesSuppressed + selected.totals.coursesReported
                } subjects are withheld on that basis.`}
            </p>
          </div>
        </>
      )}

      {isAdmin && (
        <div className="mt-10 border-t border-slate-200 pt-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
              <Calculator size={18} className="text-blue-600" />
              Prepare a report
            </h3>

            <button
              type="button"
              onClick={() => setShowManage((open) => !open)}
              className="px-3 py-2 rounded-md bg-slate-800 text-white hover:bg-slate-700 text-sm"
            >
              {showManage ? 'Hide' : 'Show'} all reports
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end rounded-lg border border-slate-200 bg-slate-50 p-4">
            <label className="text-sm text-slate-700">
              Period label
              <input
                type="text"
                value={spec.periodLabel}
                onChange={(e) => setSpec({ ...spec, periodLabel: e.target.value })}
                placeholder="Term 1"
                className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
              />
            </label>

            <label className="text-sm text-slate-700">
              Academic year
              <input
                type="text"
                value={spec.academicYear}
                onChange={(e) => setSpec({ ...spec, academicYear: e.target.value })}
                placeholder="2026-27"
                className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
              />
            </label>

            <label className="text-sm text-slate-700">
              From
              <input
                type="date"
                value={spec.from}
                onChange={(e) => setSpec({ ...spec, from: e.target.value })}
                className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
              />
            </label>

            <label className="text-sm text-slate-700">
              To
              <input
                type="date"
                value={spec.to}
                onChange={(e) => setSpec({ ...spec, to: e.target.value })}
                className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
              />
            </label>

            <label className="text-sm text-slate-700">
              Suppress below
              <input
                type="number"
                min={meta?.minThreshold ?? 3}
                max="50"
                value={spec.suppressionThreshold}
                onChange={(e) =>
                  setSpec({ ...spec, suppressionThreshold: e.target.value })
                }
                className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
              />
            </label>

            <div className="md:col-span-5 flex flex-wrap gap-3">
              <button
                type="button"
                disabled={busyId === 'preview'}
                onClick={runPreview}
                className="px-4 py-2 rounded-md border border-blue-600 text-blue-700 hover:bg-blue-50 disabled:opacity-60"
              >
                {busyId === 'preview' ? 'Computing…' : 'Preview'}
              </button>

              <button
                type="button"
                disabled={busyId === 'create'}
                onClick={() => createReport(false)}
                className="px-4 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {busyId === 'create' ? 'Saving…' : 'Compute and save'}
              </button>
            </div>
          </div>

          {preview && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
              <p className="text-sm text-slate-600 mb-3">
                {preview.totals.submitted} appeals · {preview.totals.coursesReported}{' '}
                subjects reported · {preview.totals.coursesSuppressed} withheld at a
                threshold of {preview.suppressionThreshold}.
              </p>

              {renderTable(preview.rows, preview.suppressionThreshold)}
            </div>
          )}

          {showManage && (
            <div className="mt-5 space-y-3">
              {manageRows.length ? (
                manageRows.map((row) => {
                  const mine = myId && String(row.computedBy) === String(myId);

                  return (
                    <div
                      key={row._id}
                      className="border border-slate-200 rounded-lg p-4 bg-white"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="font-medium text-slate-800">{row.title}</p>
                          <p className="text-sm text-slate-500">
                            {row.totals.submitted} appeals · computed by{' '}
                            {row.computedByName || 'unknown'} on {formatDate(row.computedAt)}
                            {row.approvedByName ? ` · approved by ${row.approvedByName}` : ''}
                          </p>
                          {row.status === 'published' && !row.checksumValid && (
                            <p className="text-sm text-red-700 mt-1">
                              The stored figures no longer match the approved digest.
                            </p>
                          )}
                          {row.withdrawalReason && (
                            <p className="text-sm text-slate-500 mt-1">
                              Withdrawn: {row.withdrawalReason}
                            </p>
                          )}
                        </div>

                        <span
                          className={`px-2 py-1 rounded text-xs font-medium ${
                            STATUS_STYLES[row.status] || 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {row.status}
                        </span>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        {row.status === 'draft' && (
                          <button
                            type="button"
                            disabled={busyId === row._id || mine}
                            onClick={() => act(row, 'approve', {}, 'Report approved.')}
                            title={
                              mine
                                ? 'You computed this, so somebody else has to approve it'
                                : ''
                            }
                            className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                          >
                            Approve
                          </button>
                        )}

                        {row.status === 'approved' && (
                          <button
                            type="button"
                            disabled={busyId === row._id}
                            onClick={() => act(row, 'publish', {}, 'Report published.')}
                            className="px-3 py-1.5 text-sm rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-60"
                          >
                            Publish
                          </button>
                        )}

                        {row.status === 'published' && (
                          <button
                            type="button"
                            disabled={busyId === row._id}
                            onClick={() => withdraw(row)}
                            className="px-3 py-1.5 text-sm rounded-md border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-60"
                          >
                            Withdraw
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              ) : (
                <p className="text-sm text-slate-500">No reports have been computed yet.</p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
};

export default AppealTransparencyPanel;
