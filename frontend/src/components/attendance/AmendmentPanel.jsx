import { useState, useEffect, useCallback, useContext, useMemo } from 'react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * Corrections to a register that has already been taken.
 *
 * For a teacher: pick a register, pick a row, choose the correction and the
 * reason. How old the register is sits next to the date rather than appearing
 * at submit time, because a teacher who discovers the window has closed after
 * writing the note has already done the work twice.
 *
 * For an admin: the queue, with the effect on the student's percentage computed
 * and shown *before* approval. "Does this take her under 90%" is the question
 * the decision actually turns on, and answering it afterwards is answering it
 * too late.
 */

const STATUS_STYLES = {
  submitted: 'bg-amber-100 text-amber-800',
  approved: 'bg-blue-100 text-blue-700',
  applied: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  withdrawn: 'bg-gray-200 text-gray-600',
  superseded: 'bg-gray-100 text-gray-500',
};

const STATUS_LABELS = {
  submitted: 'Awaiting approval',
  approved: 'Approved, not yet applied',
  applied: 'Applied',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  superseded: 'Superseded',
};

const REASON_LABELS = {
  'late-arrival': 'Arrived late',
  medical: 'Medical',
  bereavement: 'Bereavement',
  'authorised-activity': 'School activity',
  'religious-observance': 'Religious observance',
  'clerical-error': 'Clerical error',
  'wrong-student': 'Wrong student marked',
};

const label = (value) => REASON_LABELS[value] || value || '—';

const formatDate = (value) =>
  value
    ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—';

const percentText = (value) => (value === null || value === undefined ? '—' : `${value}%`);

/**
 * The before-and-after, drawn as two numbers and an arrow.
 *
 * Both sides are shown even when they are identical, because "this changes
 * nothing" is a useful thing for the person approving to see.
 */
const EffectRow = ({ before, after }) => {
  if (!before) return null;

  const moved = before.percent !== after.percent;
  const up = (after.percent ?? 0) > (before.percent ?? 0);

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-gray-600">{percentText(before.percent)}</span>
      <span className="text-gray-400">→</span>
      <span
        className={
          !moved ? 'text-gray-600' : up ? 'text-emerald-700 font-medium' : 'text-red-600 font-medium'
        }
      >
        {percentText(after.percent)}
      </span>
      <span className="text-xs text-gray-400">
        over {before.sessions} session{before.sessions === 1 ? '' : 's'}
      </span>
    </div>
  );
};

const AmendmentPanel = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isStaff = role === 'teacher' || role === 'admin';
  const isAdmin = role === 'admin';

  const [meta, setMeta] = useState(null);
  const [mine, setMine] = useState([]);
  const [pending, setPending] = useState([]);
  const [certifications, setCertifications] = useState([]);
  const [summary, setSummary] = useState(null);

  const [registerId, setRegisterId] = useState('');
  const [studentName, setStudentName] = useState('');
  const [requestedStatus, setRequestedStatus] = useState('Present');
  const [reasonCode, setReasonCode] = useState('medical');
  const [reasonNote, setReasonNote] = useState('');
  const [evidenceReference, setEvidenceReference] = useState('');

  const [certClass, setCertClass] = useState('');
  const [certMonth, setCertMonth] = useState('');

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 5000);
  };

  const explain = (err, fallback) =>
    setError(err?.response?.data?.message || err?.message || fallback);

  // ---- loading -------------------------------------------------------------

  const loadMeta = useCallback(async () => {
    if (!isStaff) return;
    try {
      const res = await api.get('/teacher/attendance-amendments/meta');
      setMeta(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load amendment reference data.');
    }
  }, [isStaff]);

  const loadMine = useCallback(async () => {
    if (!isStaff) return;

    setLoading(true);
    try {
      const res = await api.get('/teacher/attendance-amendments/mine');
      setMine(res.data.data || []);
    } catch (err) {
      explain(err, 'Could not load your amendments.');
    } finally {
      setLoading(false);
    }
  }, [isStaff]);

  const loadOffice = useCallback(async () => {
    if (!isAdmin) return;

    try {
      const [pendingRes, certRes, summaryRes] = await Promise.all([
        api.get('/teacher/attendance-amendments/pending'),
        api.get('/teacher/attendance-amendments/certifications'),
        api.get('/teacher/attendance-amendments/summary'),
      ]);

      setPending(pendingRes.data.data || []);
      setCertifications(certRes.data.data || []);
      setSummary(summaryRes.data.data || null);
    } catch (err) {
      explain(err, 'Could not load the amendment queue.');
    }
  }, [isAdmin]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    loadMine();
  }, [loadMine]);

  useEffect(() => {
    loadOffice();
  }, [loadOffice]);

  const windowDays = meta?.amendmentWindowDays ?? 14;

  const openCount = useMemo(
    () => mine.filter((row) => ['submitted', 'approved'].includes(row.status)).length,
    [mine]
  );

  // ---- acting --------------------------------------------------------------

  const raise = async () => {
    if (!registerId || !studentName) {
      setError('A register id and a student name are both needed.');
      return;
    }

    setError('');
    setBusy('raise');

    try {
      const res = await api.post('/teacher/attendance-amendments', {
        attendanceId: registerId,
        studentName,
        requestedStatus,
        reasonCode,
        reasonNote,
        evidenceReference,
      });

      flash(res.data.message || 'Amendment raised.');
      setReasonNote('');
      setEvidenceReference('');
      loadMine();
      loadOffice();
    } catch (err) {
      explain(err, 'Could not raise the amendment.');
    } finally {
      setBusy('');
    }
  };

  const act = async (amendment, verb, body) => {
    setError('');
    setBusy(amendment._id);

    try {
      const res = await api.patch(
        `/teacher/attendance-amendments/${amendment._id}/${verb}`,
        body || {}
      );
      flash(res.data.message || 'Done.');
      loadMine();
      loadOffice();
    } catch (err) {
      explain(err, `Could not ${verb} the amendment.`);
    } finally {
      setBusy('');
    }
  };

  const reject = (amendment) => {
    const reason = window.prompt('Why is this correction being refused?');
    if (!reason) return;
    return act(amendment, 'reject', { reason });
  };

  const certify = async (force = false) => {
    if (!certClass || !certMonth) {
      setError('A class and a month are both needed to certify.');
      return;
    }

    const confirmed = window.confirm(
      `Certifying ${certClass} for ${certMonth} seals it. No amendment can be applied into that month afterwards${
        force ? ', and any still open will be closed as superseded' : ''
      }. Continue?`
    );
    if (!confirmed) return;

    setError('');
    setBusy('certify');

    try {
      const res = await api.post('/teacher/attendance-amendments/certifications', {
        className: certClass,
        monthKey: certMonth,
        force,
      });
      flash(res.data.message || 'Month certified.');
      loadOffice();
    } catch (err) {
      explain(err, 'Could not certify that month.');
    } finally {
      setBusy('');
    }
  };

  const reopen = async (certification) => {
    const reason = window.prompt('Why is this certified month being reopened?');
    if (!reason) return;

    setBusy(certification._id);
    try {
      const res = await api.patch(
        `/teacher/attendance-amendments/certifications/${certification._id}/reopen`,
        { reason }
      );
      flash(res.data.message || 'Month reopened.');
      loadOffice();
    } catch (err) {
      explain(err, 'Could not reopen that month.');
    } finally {
      setBusy('');
    }
  };

  if (!isStaff) return null;

  return (
    <div className="bg-white rounded-3xl p-6 sm:p-8 shadow-lg mt-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-2xl font-bold text-blue-700">Register corrections</h2>
          <p className="text-sm text-gray-500 mt-1">
            A register that has been taken cannot be edited. It can be corrected — with a reason, a
            second signature, and a record of what changed.
          </p>
        </div>

        {openCount > 0 && (
          <span className="text-xs px-2 py-1 rounded-full bg-amber-100 text-amber-800">
            {openCount} of yours still open
          </span>
        )}
      </div>

      {error && (
        <div className="mb-4 text-sm bg-red-50 border border-red-100 text-red-700 rounded px-3 py-2">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 text-sm bg-emerald-50 border border-emerald-100 text-emerald-700 rounded px-3 py-2">
          {success}
        </div>
      )}

      {/* ---- raising one ---- */}
      <div className="border border-gray-100 rounded-xl p-4 mb-6">
        <h3 className="font-semibold text-gray-800 text-sm mb-3">Ask for a correction</h3>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="block text-xs text-gray-500 mb-1">Register id</span>
            <input
              type="text"
              value={registerId}
              onChange={(event) => setRegisterId(event.target.value.trim())}
              placeholder="The attendance record this correction applies to"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />
          </label>

          <label className="text-sm">
            <span className="block text-xs text-gray-500 mb-1">Student, as written on the register</span>
            <input
              type="text"
              value={studentName}
              onChange={(event) => setStudentName(event.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />
          </label>

          <label className="text-sm">
            <span className="block text-xs text-gray-500 mb-1">Should read</span>
            <select
              value={requestedStatus}
              onChange={(event) => setRequestedStatus(event.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            >
              {(meta?.marks || ['Present', 'Absent']).map((mark) => (
                <option key={mark} value={mark}>
                  {mark}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="block text-xs text-gray-500 mb-1">Reason</span>
            <select
              value={reasonCode}
              onChange={(event) => setReasonCode(event.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            >
              {(meta?.reasonCodes || ['medical', 'clerical-error']).map((code) => (
                <option key={code} value={code}>
                  {label(code)}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="block text-xs text-gray-500 mb-1">Note (optional)</span>
            <input
              type="text"
              value={reasonNote}
              maxLength={500}
              onChange={(event) => setReasonNote(event.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />
          </label>

          <label className="text-sm">
            <span className="block text-xs text-gray-500 mb-1">Evidence reference (optional)</span>
            <input
              type="text"
              value={evidenceReference}
              maxLength={120}
              onChange={(event) => setEvidenceReference(event.target.value)}
              placeholder="Certificate number, email, form id"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />
          </label>
        </div>

        <button
          type="button"
          disabled={busy === 'raise'}
          onClick={raise}
          className="mt-4 bg-blue-600 text-white px-5 py-2.5 rounded-xl text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          Raise the correction
        </button>

        <p className="text-xs text-gray-500 mt-3">
          The current mark is read off the register, never taken from this form — so a correction
          raised from a stale view is refused rather than applied over whatever is actually there.
          Past {windowDays} days a correction needs an administrator rather than a colleague.
        </p>
      </div>

      {/* ---- the teacher's own ---- */}
      <div className="border border-gray-100 rounded-xl p-4 mb-6">
        <h3 className="font-semibold text-gray-800 text-sm mb-3">Corrections you have asked for</h3>

        {loading && !mine.length ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : mine.length ? (
          <div className="space-y-2">
            {mine.map((row) => (
              <div
                key={row._id}
                className="flex flex-wrap items-start justify-between gap-2 bg-gray-50 rounded-lg px-3 py-2"
              >
                <div>
                  <p className="text-sm text-gray-800">
                    {row.studentName} · {formatDate(row.date)} · {row.className}
                  </p>
                  <p className="text-xs text-gray-600 mt-0.5">
                    {row.originalStatus} → {row.requestedStatus} · {label(row.reasonCode)}
                    {row.lateRequest ? ` · ${row.daysLate} days late` : ''}
                    {row.studentAmbiguous ? ' · name matches more than one student' : ''}
                  </p>
                  {row.rejectionReason && (
                    <p className="text-xs text-red-600 mt-0.5">{row.rejectionReason}</p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      STATUS_STYLES[row.status] || 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {STATUS_LABELS[row.status] || row.status}
                  </span>

                  {row.status === 'submitted' && (
                    <button
                      type="button"
                      disabled={busy === row._id}
                      onClick={() => act(row, 'withdraw')}
                      className="text-xs px-2 py-1 border border-gray-200 rounded disabled:opacity-50"
                    >
                      Withdraw
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500">You have not asked for any corrections.</p>
        )}
      </div>

      {/* ---- the office ---- */}
      {isAdmin && (
        <div className="space-y-6">
          <div className="border border-gray-100 rounded-xl p-4">
            <h3 className="font-semibold text-gray-800 text-sm mb-3">Waiting for a decision</h3>

            {pending.length ? (
              <div className="space-y-3">
                {pending.map((row) => (
                  <div key={row._id} className="border border-gray-100 rounded-lg p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-gray-800">
                          {row.studentName} · {row.className} · {formatDate(row.date)}
                        </p>
                        <p className="text-xs text-gray-600 mt-0.5">
                          Register says <span className="font-medium">{row.originalStatus}</span>,
                          asked to read <span className="font-medium">{row.requestedStatus}</span> ·{' '}
                          {label(row.reasonCode)}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          Raised by {row.requestedByName}
                          {row.evidenceReference ? ` · evidence ${row.evidenceReference}` : ' · no evidence recorded'}
                          {row.lateRequest ? ` · ${row.daysLate} days after the lesson` : ''}
                        </p>
                        {row.reasonNote && (
                          <p className="text-xs text-gray-600 mt-0.5">{row.reasonNote}</p>
                        )}
                      </div>

                      <div className="text-right">
                        <p className="text-xs text-gray-500 mb-0.5">Attendance</p>
                        <EffectRow before={row.attendanceBefore} after={row.attendanceAfter} />
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2 mt-3">
                      <button
                        type="button"
                        disabled={busy === row._id}
                        onClick={() => act(row, 'approve')}
                        className="text-xs px-3 py-1.5 bg-emerald-600 text-white rounded disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={busy === row._id}
                        onClick={() => reject(row)}
                        className="text-xs px-3 py-1.5 border border-gray-200 rounded disabled:opacity-50"
                      >
                        Refuse
                      </button>
                      <button
                        type="button"
                        disabled={busy === row._id}
                        onClick={() => act(row, 'apply')}
                        className="text-xs px-3 py-1.5 border border-blue-200 text-blue-700 rounded disabled:opacity-50"
                      >
                        Apply to the register
                      </button>
                    </div>
                  </div>
                ))}

                <p className="text-xs text-gray-500">
                  Approving is a judgement; applying is a change to the record. They are separate
                  buttons because the second can fail even when the first succeeded — if the
                  register has moved in the meantime, the write is refused rather than overwriting
                  it.
                </p>
              </div>
            ) : (
              <p className="text-sm text-gray-500">Nothing waiting.</p>
            )}
          </div>

          {summary && summary.total > 0 && (
            <div className="border border-gray-100 rounded-xl p-4">
              <h3 className="font-semibold text-gray-800 text-sm mb-2">Corrections in context</h3>
              <div className="grid gap-3 sm:grid-cols-4 text-sm">
                <div>
                  <p className="text-xs text-gray-500">Raised</p>
                  <p className="text-gray-800">{summary.total}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Authorised absence</p>
                  <p className="text-gray-800">{summary.authorisedAbsences}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Clerical errors</p>
                  <p className={summary.clericalErrors > 0 ? 'text-amber-700' : 'text-gray-800'}>
                    {summary.clericalErrors}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Raised late</p>
                  <p className="text-gray-800">{summary.lateRequests}</p>
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Clerical errors are the number worth watching: a class producing a lot of them has a
                register-taking problem, not an attendance problem.
              </p>
            </div>
          )}

          <div className="border border-gray-100 rounded-xl p-4">
            <h3 className="font-semibold text-gray-800 text-sm mb-3">Certify a month</h3>

            <div className="grid gap-2 sm:grid-cols-3">
              <label className="text-sm">
                <span className="block text-xs text-gray-500 mb-1">Class</span>
                <input
                  type="text"
                  value={certClass}
                  onChange={(event) => setCertClass(event.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                />
              </label>

              <label className="text-sm">
                <span className="block text-xs text-gray-500 mb-1">Month</span>
                <input
                  type="month"
                  value={certMonth}
                  onChange={(event) => setCertMonth(event.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                />
              </label>

              <div className="flex items-end gap-2">
                <button
                  type="button"
                  disabled={busy === 'certify'}
                  onClick={() => certify(false)}
                  className="text-sm px-3 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50"
                >
                  Certify
                </button>
                <button
                  type="button"
                  disabled={busy === 'certify'}
                  onClick={() => certify(true)}
                  className="text-sm px-3 py-2 border border-gray-200 rounded-lg disabled:opacity-50"
                >
                  Certify anyway
                </button>
              </div>
            </div>

            {certifications.length > 0 && (
              <div className="mt-4 space-y-2">
                {certifications.map((row) => (
                  <div
                    key={row._id}
                    className="flex flex-wrap items-center justify-between gap-2 bg-gray-50 rounded-lg px-3 py-2"
                  >
                    <div>
                      <p className="text-sm text-gray-800">
                        {row.className} · {row.monthKey} · {row.percent}%
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {row.sessionCount} session(s), {row.presentCount} present of{' '}
                        {row.recordCount} · certified by {row.certifiedByName}
                        {row.reopenReason ? ` · reopened: ${row.reopenReason}` : ''}
                      </p>
                    </div>

                    {row.status === 'certified' ? (
                      <button
                        type="button"
                        disabled={busy === row._id}
                        onClick={() => reopen(row)}
                        className="text-xs px-2 py-1 border border-gray-200 rounded disabled:opacity-50"
                      >
                        Reopen
                      </button>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                        Reopened
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            <p className="text-xs text-gray-500 mt-3">
              Certifying stores the figures it certified, so the number that went out stays
              recoverable even after the month is reopened. Reopening is allowed and logged — a
              month that can never be reopened produces a second, unofficial register.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default AmendmentPanel;
