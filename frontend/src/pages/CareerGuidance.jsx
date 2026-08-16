import { useState, useEffect, useContext, useCallback, useMemo } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * Career guidance — college applications, deadlines and references.
 *
 * The reference panel on a student's card shows three words and nothing else:
 * requested, accepted, submitted. There is no preview, no download, no hover.
 * That is not a UI omission — it is the feature. A reference the subject can
 * read is not a reference, and a page that offers a peek at one has given the
 * whole thing away.
 *
 * The student board is grouped by deadline state rather than by institution,
 * overdue first, because the order is the advice. Each card names the item that
 * is outstanding rather than only showing a percentage — "60% ready" sends a
 * student looking; "waiting on Mrs Rao" sends them to Mrs Rao.
 */

const STATUS_LABELS = {
  researching: 'Researching',
  'in-progress': 'In progress',
  submitted: 'Submitted',
  interview: 'Interview',
  offer: 'Offer',
  'conditional-offer': 'Conditional offer',
  rejected: 'Rejected',
  waitlisted: 'Waitlisted',
  withdrawn: 'Withdrawn',
  accepted: 'Accepted',
  'declined-offer': 'Offer declined',
};

const STATUS_STYLES = {
  researching: 'bg-slate-100 text-slate-700',
  'in-progress': 'bg-blue-100 text-blue-700',
  submitted: 'bg-indigo-100 text-indigo-700',
  interview: 'bg-purple-100 text-purple-700',
  offer: 'bg-green-100 text-green-700',
  'conditional-offer': 'bg-teal-100 text-teal-700',
  rejected: 'bg-gray-200 text-gray-600',
  waitlisted: 'bg-amber-100 text-amber-800',
  withdrawn: 'bg-gray-200 text-gray-600',
  accepted: 'bg-green-600 text-white',
  'declined-offer': 'bg-gray-200 text-gray-600',
};

const DEADLINE_STYLES = {
  overdue: 'border-red-400 bg-red-50',
  'due-today': 'border-red-300 bg-red-50',
  'due-soon': 'border-amber-300 bg-amber-50',
  upcoming: 'border-gray-200 bg-white',
  met: 'border-green-200 bg-green-50',
  closed: 'border-gray-200 bg-gray-50',
  unknown: 'border-gray-200 bg-white',
};

const DEADLINE_GROUPS = [
  { key: 'overdue', label: 'Past the deadline' },
  { key: 'due-today', label: 'Closing today' },
  { key: 'due-soon', label: 'Closing this week' },
  { key: 'upcoming', label: 'Still open' },
  { key: 'met', label: 'Gone in' },
  { key: 'closed', label: 'Finished with' },
];

const REFERENCE_LABELS = {
  requested: 'Asked',
  accepted: 'Agreed to write',
  declined: 'Declined',
  submitted: 'Submitted',
  withdrawn: 'Withdrawn',
  expired: 'No answer — chase or ask somebody else',
};

const REFERENCE_STYLES = {
  requested: 'bg-slate-100 text-slate-700',
  accepted: 'bg-blue-100 text-blue-700',
  declined: 'bg-red-100 text-red-700',
  submitted: 'bg-green-100 text-green-700',
  withdrawn: 'bg-gray-200 text-gray-600',
  expired: 'bg-amber-100 text-amber-800',
};

const PRIORITY_LABELS = {
  dream: 'Dream',
  target: 'Target',
  safety: 'Safety',
};

const todayKey = () => {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
};

const emptyApplication = {
  institution: '',
  country: '',
  programme: '',
  level: 'undergraduate',
  applicationType: 'regular',
  priority: 'target',
  deadline: '',
  portalRef: '',
};

const emptyLetter = {
  letterBody: '',
  strengthRating: 4,
  recommendationLevel: 'recommend',
  submissionRef: '',
};

/** "in 9 days" / "3 days ago" — the phrasing somebody acts on. */
const deadlinePhrase = (state) => {
  if (!state || state.daysRemaining === null) {
    if (state?.state === 'met') return 'Submitted';
    if (state?.state === 'closed') return 'Closed';
    return '';
  }
  if (state.daysRemaining < 0) {
    return `${Math.abs(state.daysRemaining)} days past the deadline`;
  }
  if (state.daysRemaining === 0) return 'Closes today';
  if (state.daysRemaining === 1) return 'Closes tomorrow';
  return `Closes in ${state.daysRemaining} days`;
};

/** A ring rather than a bar — it sits next to the title without a row of its own. */
const ReadinessRing = ({ readiness }) => {
  const percent = readiness?.percent ?? 0;
  const tone =
    percent === 100 ? '#16a34a' : percent >= 60 ? '#2563eb' : '#d97706';

  return (
    <div
      className="relative h-12 w-12 shrink-0 rounded-full"
      style={{
        background: `conic-gradient(${tone} ${percent * 3.6}deg, #e5e7eb 0deg)`,
      }}
      title={`${readiness?.completedItems ?? 0} of ${readiness?.totalItems ?? 0} done`}
    >
      <div className="absolute inset-1 flex items-center justify-center rounded-full bg-white text-xs font-semibold text-gray-700">
        {percent}%
      </div>
    </div>
  );
};

const CareerGuidance = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isCounsellor = ['teacher', 'admin'].includes(role);
  const isStudent = role === 'student';

  const [tab, setTab] = useState(isStudent ? 'mine' : 'referee');
  const [meta, setMeta] = useState(null);

  const [applications, setApplications] = useState([]);
  const [refereeQueue, setRefereeQueue] = useState([]);
  const [atRisk, setAtRisk] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...emptyApplication, deadline: todayKey() });

  const [writingFor, setWritingFor] = useState(null);
  const [letter, setLetter] = useState({ ...emptyLetter });

  const readError = (err, fallback) => err?.response?.data?.message || fallback;

  const clearMessages = () => {
    setError('');
    setNotice('');
  };

  const loadMeta = useCallback(async () => {
    try {
      const { data } = await api.get('/careers/meta');
      setMeta(data.data);
    } catch {
      // The form falls back to its own labels.
    }
  }, []);

  const loadMine = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/careers/applications/mine');
      setApplications(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load your applications'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadReferee = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/careers/references/mine');
      setRefereeQueue(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load your reference requests'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAtRisk = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/careers/applications/at-risk');
      setAtRisk(data.data);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the at-risk list'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    if (tab === 'mine') loadMine();
    if (tab === 'referee') loadReferee();
    if (tab === 'cohort') loadAtRisk();
  }, [tab, loadMine, loadReferee, loadAtRisk]);

  const submitApplicationForm = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      await api.post('/careers/applications', form);
      setNotice('Application added.');
      setShowForm(false);
      setForm({ ...emptyApplication, deadline: todayKey() });
      loadMine();
    } catch (err) {
      setError(readError(err, 'Could not add that application'));
    }
  };

  const markRequirement = async (applicationId, index, status) => {
    clearMessages();
    try {
      const { data } = await api.patch(
        `/careers/applications/${applicationId}/requirements/${index}`,
        { status }
      );
      setNotice(data.message);
      loadMine();
    } catch (err) {
      setError(readError(err, 'Could not update that requirement'));
    }
  };

  const submitApplication = async (applicationId) => {
    clearMessages();
    try {
      const { data } = await api.patch(`/careers/applications/${applicationId}/submit`);
      setNotice(data.message);
      loadMine();
    } catch (err) {
      setError(readError(err, 'Could not mark it submitted'));
    }
  };

  const acceptOffer = async (applicationId) => {
    clearMessages();
    try {
      const { data } = await api.patch(`/careers/applications/${applicationId}/accept`);
      setNotice(data.message);
      loadMine();
    } catch (err) {
      setError(readError(err, 'Could not accept that offer'));
    }
  };

  const requestReference = async (applicationId) => {
    const referee = window.prompt("Referee's user id");
    if (!referee) return;
    const refereeName = window.prompt('Their name, as you would write it') ?? '';
    clearMessages();
    try {
      const { data } = await api.post(
        `/careers/applications/${applicationId}/references`,
        { referee, refereeName, relationship: 'subject-teacher' }
      );
      setNotice(data.message);
      loadMine();
    } catch (err) {
      setError(readError(err, 'Could not request that reference'));
    }
  };

  const acceptReference = async (row) => {
    clearMessages();
    try {
      const { data } = await api.patch(
        `/careers/references/${row.applicationId}/${row.referenceId}/accept`
      );
      setNotice(data.message);
      loadReferee();
    } catch (err) {
      setError(readError(err, 'Could not accept that request'));
    }
  };

  const declineReference = async (row) => {
    const reason = window.prompt(
      'Why? The student sees this, so make it something they can act on.'
    );
    if (!reason) return;
    clearMessages();
    try {
      const { data } = await api.patch(
        `/careers/references/${row.applicationId}/${row.referenceId}/decline`,
        { reason }
      );
      setNotice(data.message);
      loadReferee();
    } catch (err) {
      setError(readError(err, 'Could not decline that request'));
    }
  };

  const submitLetter = async (event) => {
    event.preventDefault();
    if (!writingFor) return;
    clearMessages();
    try {
      const { data } = await api.patch(
        `/careers/references/${writingFor.applicationId}/${writingFor.referenceId}/submit`,
        letter
      );
      setNotice(data.message);
      setWritingFor(null);
      setLetter({ ...emptyLetter });
      loadReferee();
    } catch (err) {
      setError(readError(err, 'Could not submit that reference'));
    }
  };

  const grouped = useMemo(() => {
    const buckets = {};
    for (const application of applications) {
      const key = application.deadlineState?.state || 'unknown';
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(application);
    }
    return buckets;
  }, [applications]);

  const firmAcceptance = useMemo(
    () => applications.find((a) => a.offer?.isFirmAcceptance),
    [applications]
  );

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Careers &amp; applications</h1>
        <p className="mt-1 text-gray-600">
          Where you have applied, what each one is still waiting on, and who is writing
          your references. Deadlines are worked out on every page load, so a date that has
          passed says so.
        </p>
      </header>

      <nav className="flex flex-wrap gap-2 border-b mb-6">
        {[
          { key: 'mine', label: 'My applications' },
          { key: 'referee', label: 'References I was asked for' },
          ...(isCounsellor ? [{ key: 'cohort', label: 'At risk' }] : []),
        ].map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => setTab(entry.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === entry.key
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {notice}
        </div>
      )}
      {loading && <p className="mb-4 text-sm text-gray-500">Loading…</p>}

      {tab === 'mine' && (
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-800">
              {applications.length} application(s)
            </h2>
            <button
              type="button"
              onClick={() => setShowForm((open) => !open)}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              {showForm ? 'Close' : 'Add one'}
            </button>
          </div>

          {firmAcceptance && (
            <div className="mb-4 rounded border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-900">
              <p className="font-semibold">
                You have firmly accepted {firmAcceptance.institution}.
              </p>
              <p className="mt-1">
                Accepting somewhere else will release this one. You can only hold one firm
                acceptance at a time — some boards treat two as fraud.
              </p>
            </div>
          )}

          {showForm && (
            <form
              onSubmit={submitApplicationForm}
              className="mb-6 rounded-lg border bg-white p-5 shadow-sm"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="text-gray-600">Institution</span>
                  <input
                    required
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={form.institution}
                    onChange={(e) => setForm({ ...form, institution: e.target.value })}
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Programme</span>
                  <input
                    required
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={form.programme}
                    onChange={(e) => setForm({ ...form, programme: e.target.value })}
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Deadline</span>
                  <input
                    type="date"
                    required
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={form.deadline}
                    onChange={(e) => setForm({ ...form, deadline: e.target.value })}
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">How ambitious is it?</span>
                  <select
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={form.priority}
                    onChange={(e) => setForm({ ...form, priority: e.target.value })}
                  >
                    {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Country</span>
                  <input
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={form.country}
                    onChange={(e) => setForm({ ...form, country: e.target.value })}
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Round</span>
                  <select
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={form.applicationType}
                    onChange={(e) =>
                      setForm({ ...form, applicationType: e.target.value })
                    }
                  >
                    {(meta?.applicationTypes || ['regular']).map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="mt-4 flex gap-2">
                <button
                  type="submit"
                  className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="rounded border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {applications.length === 0 ? (
            <p className="text-sm text-gray-500">
              Nothing here yet. Add the first one and the deadlines start looking after
              themselves.
            </p>
          ) : (
            DEADLINE_GROUPS.filter((group) => grouped[group.key]?.length).map((group) => (
              <div key={group.key} className="mb-6">
                <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
                  {group.label} ({grouped[group.key].length})
                </h3>

                <ul className="space-y-3">
                  {grouped[group.key].map((application) => (
                    <li
                      key={application._id}
                      className={`rounded-lg border p-4 shadow-sm ${
                        DEADLINE_STYLES[application.deadlineState?.state] || 'bg-white'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <ReadinessRing readiness={application.readiness} />

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="font-semibold text-gray-900">
                              {application.institution}
                            </p>
                            <span
                              className={`rounded px-2 py-0.5 text-xs font-medium ${
                                STATUS_STYLES[application.status] || 'bg-gray-100'
                              }`}
                            >
                              {STATUS_LABELS[application.status] || application.status}
                            </span>
                          </div>

                          <p className="text-sm text-gray-600">
                            {application.programme} ·{' '}
                            {PRIORITY_LABELS[application.priority] || application.priority}
                            {application.country && ` · ${application.country}`}
                          </p>

                          <p
                            className={`mt-1 text-sm ${
                              ['overdue', 'due-today'].includes(
                                application.deadlineState?.state
                              )
                                ? 'font-semibold text-red-700'
                                : 'text-gray-600'
                            }`}
                          >
                            {application.deadline} —{' '}
                            {deadlinePhrase(application.deadlineState)}
                          </p>

                          {/* Named, not counted. "60% ready" sends a student
                              looking; this sends them to the right person. */}
                          {application.readiness?.outstanding?.length > 0 && (
                            <ul className="mt-2 space-y-1 text-sm text-gray-700">
                              {application.readiness.outstanding
                                .slice(0, 4)
                                .map((item, index) => (
                                  <li key={index} className="flex items-center gap-2">
                                    <span
                                      className={
                                        item.status === 'declined'
                                          ? 'text-red-600'
                                          : 'text-amber-600'
                                      }
                                    >
                                      •
                                    </span>
                                    {item.label}
                                  </li>
                                ))}
                            </ul>
                          )}

                          {application.references?.length > 0 && (
                            <div className="mt-3">
                              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                                References
                              </p>
                              <ul className="mt-1 flex flex-wrap gap-2">
                                {application.references.map((reference) => (
                                  <li
                                    key={reference._id}
                                    className={`rounded px-2 py-1 text-xs ${
                                      REFERENCE_STYLES[reference.status] || 'bg-gray-100'
                                    }`}
                                    title={
                                      reference.declineReason ||
                                      'The letter itself is confidential'
                                    }
                                  >
                                    {reference.refereeName || 'A teacher'} —{' '}
                                    {REFERENCE_LABELS[reference.status] ||
                                      reference.status}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {application.requirements?.length > 0 && (
                            <ul className="mt-3 flex flex-wrap gap-2">
                              {application.requirements.map((requirement, index) => (
                                <li key={requirement._id || index}>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      markRequirement(
                                        application._id,
                                        index,
                                        requirement.status === 'done'
                                          ? 'outstanding'
                                          : 'done'
                                      )
                                    }
                                    className={`rounded border px-2 py-1 text-xs ${
                                      requirement.status === 'done'
                                        ? 'border-green-300 bg-green-50 text-green-700 line-through'
                                        : 'text-gray-700'
                                    }`}
                                  >
                                    {requirement.label}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}

                          <div className="mt-3 flex flex-wrap gap-2">
                            {!application.readiness?.isComplete &&
                              !['submitted', 'accepted'].includes(application.status) && (
                                <button
                                  type="button"
                                  onClick={() => requestReference(application._id)}
                                  className="rounded border px-3 py-1 text-xs text-gray-700 hover:bg-white"
                                >
                                  Ask for a reference
                                </button>
                              )}
                            {application.readiness?.isComplete &&
                              !['submitted', 'accepted', 'withdrawn'].includes(
                                application.status
                              ) && (
                                <button
                                  type="button"
                                  onClick={() => submitApplication(application._id)}
                                  className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
                                >
                                  Mark submitted
                                </button>
                              )}
                            {['offer', 'conditional-offer'].includes(
                              application.status
                            ) && (
                              <button
                                type="button"
                                onClick={() => acceptOffer(application._id)}
                                className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700"
                              >
                                Accept firmly
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
      )}

      {tab === 'referee' && (
        <section>
          <h2 className="mb-1 text-lg font-semibold text-gray-800">
            References you were asked for
          </h2>
          <p className="mb-4 text-sm text-gray-600">
            The student sees that you agreed and that you submitted. They never see what
            you wrote.
          </p>

          {refereeQueue.length === 0 ? (
            <p className="text-sm text-gray-500">Nobody has asked you for one.</p>
          ) : (
            <ul className="space-y-3">
              {refereeQueue.map((row) => (
                <li
                  key={row.referenceId}
                  className="rounded-lg border bg-white p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-gray-900">
                        {row.student?.name || row.studentName || 'A student'}
                      </p>
                      <p className="text-sm text-gray-600">
                        {row.institution} · {row.programme}
                      </p>
                      <p className="text-xs text-gray-500">
                        {row.relationship} · due {row.dueBy || row.deadline}
                      </p>
                    </div>
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${
                        REFERENCE_STYLES[row.status] || 'bg-gray-100'
                      }`}
                    >
                      {REFERENCE_LABELS[row.status] || row.status}
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {row.status === 'requested' && (
                      <>
                        <button
                          type="button"
                          onClick={() => acceptReference(row)}
                          className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
                        >
                          Agree to write it
                        </button>
                        <button
                          type="button"
                          onClick={() => declineReference(row)}
                          className="rounded border border-red-300 px-3 py-1 text-xs text-red-700 hover:bg-red-50"
                        >
                          Decline
                        </button>
                      </>
                    )}
                    {row.status === 'accepted' && (
                      <button
                        type="button"
                        onClick={() => {
                          setWritingFor(row);
                          setLetter({ ...emptyLetter });
                        }}
                        className="rounded bg-gray-800 px-3 py-1 text-xs font-medium text-white hover:bg-gray-900"
                      >
                        Write it
                      </button>
                    )}
                    {row.status === 'submitted' && (
                      <p className="text-xs text-green-700">
                        Submitted {new Date(row.submittedAt).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {writingFor && (
            <form
              onSubmit={submitLetter}
              className="mt-5 rounded-lg border bg-white p-5 shadow-sm"
            >
              <h3 className="mb-1 font-semibold text-gray-800">
                Reference for {writingFor.student?.name || writingFor.studentName}
              </h3>
              <p className="mb-3 text-sm text-gray-600">
                {writingFor.institution} · {writingFor.programme}. This is confidential —
                the student cannot read it from any page.
              </p>

              <textarea
                required
                rows={10}
                className="w-full rounded border px-3 py-2 text-sm"
                value={letter.letterBody}
                onChange={(e) => setLetter({ ...letter, letterBody: e.target.value })}
              />

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="text-gray-600">How strongly? (1–5)</span>
                  <input
                    type="number"
                    min={1}
                    max={5}
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={letter.strengthRating}
                    onChange={(e) =>
                      setLetter({ ...letter, strengthRating: Number(e.target.value) })
                    }
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Recommendation</span>
                  <select
                    className="mt-1 w-full rounded border px-3 py-2"
                    value={letter.recommendationLevel}
                    onChange={(e) =>
                      setLetter({ ...letter, recommendationLevel: e.target.value })
                    }
                  >
                    {(meta?.recommendationLevels || ['recommend']).map((level) => (
                      <option key={level} value={level}>
                        {level.replace(/-/g, ' ')}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="mt-4 flex gap-2">
                <button
                  type="submit"
                  className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Submit reference
                </button>
                <button
                  type="button"
                  onClick={() => setWritingFor(null)}
                  className="rounded border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  Not yet
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      {tab === 'cohort' && isCounsellor && atRisk && (
        <section>
          <h2 className="mb-1 text-lg font-semibold text-gray-800">
            At risk ({atRisk.applications.length})
          </h2>
          <p className="mb-4 text-sm text-gray-600">
            Closing on or before {atRisk.horizon} with something still outstanding.{' '}
            {atRisk.overdueCount > 0 && (
              <span className="font-medium text-red-700">
                {atRisk.overdueCount} are already past the deadline.
              </span>
            )}{' '}
            {atRisk.studentsWithApplications} student(s) have applied anywhere at all.
          </p>

          {atRisk.applications.length === 0 ? (
            <p className="text-sm text-gray-500">
              Nothing is at risk in the next fortnight.
            </p>
          ) : (
            <ul className="space-y-3">
              {atRisk.applications.map((application) => (
                <li
                  key={application._id}
                  className={`rounded-lg border p-4 shadow-sm ${
                    DEADLINE_STYLES[application.deadlineState?.state] || 'bg-white'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-gray-900">
                        {application.student?.name || application.studentName}
                      </p>
                      <p className="text-sm text-gray-600">
                        {application.institution} · {application.programme}
                      </p>
                    </div>
                    <span className="text-sm font-medium text-red-700">
                      {deadlinePhrase(application.deadlineState)}
                    </span>
                  </div>

                  <ul className="mt-2 space-y-1 text-sm text-gray-700">
                    {application.readiness.outstanding.map((item, index) => (
                      <li key={index}>• {item.label}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
};

export default CareerGuidance;
