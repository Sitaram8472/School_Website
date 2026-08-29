import { useState, useEffect, useCallback, useContext } from 'react';
import {
  FileCheck2,
  AlertTriangle,
  CheckCircle2,
  PauseCircle,
  Clock,
  History,
} from 'lucide-react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * Report card publication, on the page that already lists students by class.
 *
 * A report card is generated on demand today, so a student can pull one
 * halfway through marking and get a grade computed from three of the eight
 * assessments that will count. This panel is the decision that was missing
 * around it.
 *
 * The interface is built around the two numbers that decide whether a run is
 * ready: how many reports would go out, and how many are being held. They sit
 * next to each other, because "release" with thirty of thirty-one going out is
 * a different act from "release" with eleven held, and a single button label
 * cannot tell them apart.
 *
 * Once a run is released the release button is gone, not disabled. The way to
 * change a released report is a revision, and offering anything else would
 * suggest the original could be quietly edited.
 */

const STATUS_LABELS = {
  preparing: 'Being prepared',
  scheduled: 'Scheduled',
  released: 'Released',
  withdrawn: 'Withdrawn',
  superseded: 'Superseded',
};

const STATUS_STYLES = {
  preparing: 'bg-gray-200 text-gray-700',
  scheduled: 'bg-blue-100 text-blue-700',
  released: 'bg-green-100 text-green-700',
  withdrawn: 'bg-red-100 text-red-700',
  superseded: 'bg-gray-200 text-gray-500',
};

const HOLD_LABELS = {
  'marks-incomplete': 'Marks incomplete',
  'under-appeal': 'Under appeal',
  'integrity-case': 'Integrity case',
  fees: 'Fees',
  safeguarding: 'Safeguarding',
  other: 'Other',
};

const shortDateTime = (value) =>
  value
    ? new Date(value).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

const EMPTY_FORM = {
  academicYear: '',
  term: '',
  className: '',
};

const StatusChip = ({ status }) => (
  <span
    className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
      STATUS_STYLES[status] || 'bg-gray-200 text-gray-700'
    }`}
  >
    {STATUS_LABELS[status] || status}
  </span>
);

const ReleasePanel = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';
  const isStaff = role === 'admin' || role === 'teacher';

  const [meta, setMeta] = useState(null);
  const [releases, setReleases] = useState([]);
  const [expanded, setExpanded] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [roll, setRoll] = useState(null);

  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 4000);
  };

  const explain = (err, fallback) =>
    setError(err?.response?.data?.message || err?.message || fallback);

  const loadMeta = useCallback(async () => {
    try {
      const res = await api.get('/reports/releases/meta');
      setMeta(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load the release options.');
    }
  }, []);

  const loadReleases = useCallback(async () => {
    try {
      const res = await api.get('/reports/releases');
      setReleases(res.data.data || []);
    } catch (err) {
      explain(err, 'Could not load the report runs.');
    }
  }, []);

  useEffect(() => {
    if (!isStaff) return;
    setLoading(true);
    Promise.all([loadMeta(), loadReleases()]).finally(() => setLoading(false));
  }, [isStaff, loadMeta, loadReleases]);

  const previewRoll = async (className) => {
    if (!className) {
      setRoll(null);
      return;
    }
    try {
      const res = await api.get('/reports/releases/roll', { params: { className } });
      setRoll(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not work out that class roll.');
    }
  };

  const prepare = async (event) => {
    event.preventDefault();
    setBusyId('new');
    setError('');
    try {
      await api.post('/reports/releases', form);
      flash('Report run prepared. Nothing is visible to students until it is released.');
      setForm(EMPTY_FORM);
      setRoll(null);
      setShowForm(false);
      await loadReleases();
    } catch (err) {
      explain(err, 'Could not prepare that report run.');
    } finally {
      setBusyId('');
    }
  };

  const hold = async (release, entry) => {
    const category = window.prompt(
      `Why is ${entry.studentName}'s report being held?\n\n${(meta?.holdCategories || [])
        .map((value) => `${value} — ${HOLD_LABELS[value] || value}`)
        .join('\n')}`,
      'marks-incomplete'
    );
    if (!category) return;

    const reason = window.prompt('In a sentence, for the record:');
    if (!reason) return;

    setBusyId(entry._id);
    setError('');
    try {
      await api.patch(`/reports/releases/${release._id}/entries/${entry.student}/hold`, {
        category,
        reason,
      });
      flash(`${entry.studentName}'s report is held.`);
      await loadReleases();
    } catch (err) {
      explain(err, 'Could not hold that report.');
    } finally {
      setBusyId('');
    }
  };

  const lift = async (release, entry) => {
    setBusyId(entry._id);
    setError('');
    try {
      await api.patch(`/reports/releases/${release._id}/entries/${entry.student}/lift`, {});
      flash(
        release.status === 'released'
          ? `${entry.studentName}'s report is now visible — nobody else was re-released.`
          : 'Hold lifted.'
      );
      await loadReleases();
    } catch (err) {
      explain(err, 'Could not lift that hold.');
    } finally {
      setBusyId('');
    }
  };

  const releaseRun = async (release) => {
    const when = window.prompt(
      `Releasing ${release.className}, ${release.term}.\n\n` +
        `${release.holds.releasable} of ${release.holds.total} reports will become visible; ` +
        `${release.holds.held} are held.\n\n` +
        'This cannot be undone — a correction afterwards means issuing a revision.\n\n' +
        'Leave blank to release now, or give a date and time to publish later ' +
        '(YYYY-MM-DDTHH:MM):',
      ''
    );
    if (when === null) return;

    setBusyId(release._id);
    setError('');
    try {
      await api.patch(`/reports/releases/${release._id}/release`, {
        releaseAt: when || undefined,
      });
      flash(when ? `Scheduled for ${when}.` : 'Released.');
      await loadReleases();
    } catch (err) {
      explain(err, 'Could not release that run.');
    } finally {
      setBusyId('');
    }
  };

  const withdraw = async (release) => {
    const reason = window.prompt(
      'Withdrawing hides these reports again. It does not erase the fact that they were ' +
        'released.\n\nWhy?'
    );
    if (!reason) return;

    setBusyId(release._id);
    setError('');
    try {
      await api.patch(`/reports/releases/${release._id}/withdraw`, { reason });
      flash('Withdrawn.');
      await loadReleases();
    } catch (err) {
      explain(err, 'Could not withdraw that run.');
    } finally {
      setBusyId('');
    }
  };

  const revise = async (release) => {
    const reason = window.prompt(
      'A revision is a new report run that supersedes this one. The version families ' +
        'already have stays on the record.\n\nWhat is being corrected?'
    );
    if (!reason) return;

    setBusyId(release._id);
    setError('');
    try {
      await api.post(`/reports/releases/${release._id}/revise`, { reason });
      flash('Revision prepared. It still has to be released.');
      await loadReleases();
    } catch (err) {
      explain(err, 'Could not revise that run.');
    } finally {
      setBusyId('');
    }
  };

  if (!isStaff) return null;

  return (
    <section className="max-w-6xl mx-auto mt-8 bg-white rounded-2xl shadow-lg p-6">
      <header className="flex items-start justify-between gap-4 flex-wrap mb-5">
        <div>
          <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
            <FileCheck2 size={20} className="text-blue-700" />
            Report card releases
          </h2>
          <p className="text-sm text-gray-600 mt-1 max-w-2xl">
            Report cards are built on demand from whatever marks exist at that moment. A release is
            the decision that they may be handed over — dated, attributable, and reversible only by
            issuing a revision.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowForm((open) => !open)}
          className="px-3 py-2 rounded-md border border-gray-300 text-sm font-medium hover:bg-gray-50 transition"
        >
          {showForm ? 'Close' : 'Prepare a run'}
        </button>
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

      {/* --- prepare ------------------------------------------------------ */}
      {showForm && (
        <form
          onSubmit={prepare}
          className="mb-6 rounded-xl border border-gray-200 bg-gray-50 p-4 grid gap-3 md:grid-cols-3"
        >
          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Academic year</span>
            <input
              required
              value={form.academicYear}
              onChange={(e) => setForm({ ...form, academicYear: e.target.value })}
              placeholder="2026-27"
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Term</span>
            <input
              required
              value={form.term}
              onChange={(e) => setForm({ ...form, term: e.target.value })}
              placeholder="Term 1"
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Class</span>
            <input
              required
              value={form.className}
              onChange={(e) => setForm({ ...form, className: e.target.value })}
              onBlur={(e) => previewRoll(e.target.value)}
              placeholder="10A"
              className="w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>

          {roll && (
            <div className="md:col-span-3 text-xs text-gray-700 bg-white border border-gray-200 rounded-md px-3 py-2">
              <p>
                {roll.students.length} student{roll.students.length === 1 ? '' : 's'} found for{' '}
                {roll.className}.
              </p>
              {roll.unresolved.length > 0 && (
                <p className="text-amber-800 mt-1">
                  {roll.unresolved.length} name
                  {roll.unresolved.length === 1 ? '' : 's'} on the attendance sheets did not match a
                  student account: {roll.unresolved.join(', ')}. {roll.note}
                </p>
              )}
            </div>
          )}

          <div className="md:col-span-3">
            <button
              type="submit"
              disabled={busyId === 'new'}
              className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition disabled:opacity-60"
            >
              Prepare
            </button>
            <p className="text-xs text-gray-500 mt-2">
              Preparing takes a fingerprint of the marks each report is built from. Nothing becomes
              visible to a student until the run is released.
            </p>
          </div>
        </form>
      )}

      {/* --- the runs ----------------------------------------------------- */}
      {releases.length === 0 ? (
        <p className="text-sm text-gray-500">
          No report runs yet. Until one exists, a report card is available to any student the
          moment a mark is entered.
        </p>
      ) : (
        <ul className="space-y-4">
          {releases.map((release) => (
            <li key={release._id} className="border border-gray-200 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <p className="font-medium text-gray-900">
                    {release.className} · {release.term} · {release.academicYear}
                    {release.revision > 1 && (
                      <span className="ml-2 text-xs font-normal text-gray-600">
                        revision {release.revision}
                      </span>
                    )}
                  </p>

                  <p className="text-xs text-gray-600 mt-1">
                    Prepared {shortDateTime(release.preparedAt)}
                    {release.releasedAt && <> · released {shortDateTime(release.releasedAt)}</>}
                  </p>

                  {release.pending && (
                    <p className="text-xs text-blue-700 mt-1 flex items-center gap-1">
                      <Clock size={12} />
                      Not visible yet — publishes {shortDateTime(release.releaseAt)}
                    </p>
                  )}

                  {release.withdrawalReason && (
                    <p className="text-xs text-red-700 mt-1">
                      Withdrawn: {release.withdrawalReason}
                    </p>
                  )}

                  {release.revisionReason && (
                    <p className="text-xs text-gray-600 mt-1 flex items-start gap-1">
                      <History size={12} className="mt-0.5 shrink-0" />
                      {release.revisionReason}
                    </p>
                  )}
                </div>

                <div className="text-right shrink-0">
                  <StatusChip status={release.status} />
                  <p className="text-sm font-medium text-gray-900 mt-1">
                    {release.holds.releasable} of {release.holds.total} going out
                  </p>
                  {release.holds.held > 0 && (
                    <p className="text-xs text-amber-800">
                      {release.holds.held} held —{' '}
                      {Object.entries(release.holds.byCategory)
                        .map(([category, count]) => `${HOLD_LABELS[category] || category} ${count}`)
                        .join(', ')}
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === release._id ? '' : release._id)}
                  className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50"
                >
                  {expanded === release._id ? 'Hide students' : 'Show students'}
                </button>

                {isAdmin && ['preparing', 'scheduled'].includes(release.status) && (
                  <button
                    type="button"
                    onClick={() => releaseRun(release)}
                    disabled={busyId === release._id}
                    className="text-xs px-2 py-1 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                  >
                    Release
                  </button>
                )}

                {isAdmin && release.status === 'released' && (
                  <>
                    <button
                      type="button"
                      onClick={() => revise(release)}
                      disabled={busyId === release._id}
                      className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      Issue a revision
                    </button>
                    <button
                      type="button"
                      onClick={() => withdraw(release)}
                      disabled={busyId === release._id}
                      className="text-xs px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50"
                    >
                      Withdraw
                    </button>
                  </>
                )}
              </div>

              {expanded === release._id && (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-gray-500">
                      <tr>
                        <th className="py-2 pr-4 font-medium">Student</th>
                        <th className="py-2 pr-4 font-medium">Report</th>
                        <th className="py-2 pr-4 font-medium">Fingerprint</th>
                        <th className="py-2 pr-4 font-medium">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {release.entries.map((entry) => (
                        <tr key={entry._id} className="border-t border-gray-100">
                          <td className="py-2 pr-4">{entry.studentName}</td>
                          <td className="py-2 pr-4">
                            {entry.held ? (
                              <span className="text-amber-800 flex items-center gap-1">
                                <PauseCircle size={13} />
                                Held — {HOLD_LABELS[entry.holdCategory] || entry.holdCategory}
                                <span className="text-xs text-gray-500 ml-1">
                                  {entry.holdReason}
                                </span>
                              </span>
                            ) : release.showing ? (
                              <span className="text-green-700">Visible</span>
                            ) : (
                              <span className="text-gray-500">Not yet issued</span>
                            )}
                          </td>
                          <td className="py-2 pr-4 font-mono text-[11px] text-gray-500">
                            {entry.snapshotHash ? entry.snapshotHash.slice(0, 12) : '—'}
                          </td>
                          <td className="py-2 pr-4">
                            {entry.held ? (
                              <button
                                type="button"
                                onClick={() => lift(release, entry)}
                                disabled={busyId === entry._id}
                                className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                              >
                                Lift hold
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => hold(release, entry)}
                                disabled={busyId === entry._id}
                                className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                              >
                                Hold
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <p className="text-xs text-gray-500 mt-2">
                    The fingerprint is a digest of the marks each report was built from, taken when
                    the run was prepared. It answers “is the document you are holding the one we
                    issued?” without storing a second copy of every report.
                  </p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

export default ReleasePanel;
