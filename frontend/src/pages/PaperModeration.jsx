import { useState, useEffect, useContext, useCallback, useMemo } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * Question-paper moderation.
 *
 * Three things on this page are the point of it.
 *
 * The blueprint is drawn as bars against the target, so a paper that is 70%
 * recall looks wrong at a glance rather than after somebody adds up a column.
 *
 * Derived checks sit above everything else, blockers first, each naming the
 * question it came from. A moderator should spend their attention on the
 * judgements a machine cannot make.
 *
 * And an approved paper that has since been edited carries a red banner saying
 * which version was approved and that this is not it. Without that, an approval
 * is a claim about a process rather than a fact about a paper.
 */

const ASSESSMENT_LABELS = {
  'unit-test': 'Unit test',
  'mid-term': 'Mid-term',
  final: 'Final',
  'pre-board': 'Pre-board',
  'board-mock': 'Board mock',
  practical: 'Practical',
  retest: 'Retest',
};

const STATUS_LABELS = {
  draft: 'Draft',
  submitted: 'Submitted',
  'under-review': 'Under review',
  'changes-requested': 'Changes requested',
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  superseded: 'Superseded',
};

const STATUS_STYLES = {
  draft: 'bg-slate-100 text-slate-700',
  submitted: 'bg-blue-100 text-blue-700',
  'under-review': 'bg-blue-100 text-blue-700',
  'changes-requested': 'bg-amber-100 text-amber-800',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  withdrawn: 'bg-gray-200 text-gray-600',
  superseded: 'bg-red-100 text-red-700',
};

const CHECK_STYLES = {
  blocker: 'border-red-300 bg-red-50 text-red-800',
  warning: 'border-amber-300 bg-amber-50 text-amber-900',
  note: 'border-slate-300 bg-slate-50 text-slate-700',
};

const SEVERITY_STYLES = {
  blocker: 'bg-red-100 text-red-700',
  major: 'bg-amber-100 text-amber-800',
  minor: 'bg-slate-100 text-slate-700',
};

const COGNITIVE_LABELS = {
  recall: 'Recall',
  understanding: 'Understanding',
  application: 'Application',
  analysis: 'Analysis',
  evaluation: 'Evaluation',
  creation: 'Creation',
};

const emptyFinding = {
  questionIndex: '',
  category: 'accuracy',
  severity: 'major',
  comment: '',
};

const StatusChip = ({ status }) => (
  <span
    className={`px-2 py-0.5 rounded text-xs font-medium ${
      STATUS_STYLES[status] || 'bg-gray-100 text-gray-600'
    }`}
  >
    {STATUS_LABELS[status] || status}
  </span>
);

/**
 * The cognitive mix, drawn against the target.
 *
 * Every figure here came from the questions and their classification. Nothing
 * on this component was typed by the person whose paper it describes, which is
 * the only reason the bars mean anything.
 */
const BlueprintBars = ({ blueprint }) => {
  if (!blueprint) return null;

  return (
    <div className="rounded-lg border bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-semibold text-gray-800">Blueprint</h4>
        <p className="text-sm text-gray-600">
          {blueprint.questionCount} questions · {blueprint.totalMarks} marks
          {blueprint.declaredTotalMarks !== null &&
            blueprint.declaredTotalMarks !== undefined &&
            blueprint.declaredTotalMarks !== blueprint.totalMarks && (
              <span className="ml-2 font-medium text-red-600">
                billed as {blueprint.declaredTotalMarks}
              </span>
            )}
          {blueprint.marksPerMinute !== null && (
            <span className="ml-2 text-gray-500">
              · {blueprint.marksPerMinute} marks/min
            </span>
          )}
        </p>
      </div>

      <ul className="mt-3 space-y-2">
        {blueprint.byCognitiveLevel.map((row) => (
          <li key={row.key} className="text-sm">
            <div className="flex justify-between text-xs text-gray-600">
              <span>{COGNITIVE_LABELS[row.key] || row.key}</span>
              <span>
                {row.share}%
                {row.target > 0 && (
                  <span className="text-gray-400"> / target {row.target}%</span>
                )}
              </span>
            </div>
            <div className="mt-1 relative h-2 w-full rounded bg-gray-100">
              <div
                className={`h-full rounded ${
                  Math.abs(row.drift) > 15 && row.target > 0
                    ? 'bg-amber-500'
                    : 'bg-blue-500'
                }`}
                style={{ width: `${Math.min(row.share, 100)}%` }}
              />
              {row.target > 0 && (
                <span
                  className="absolute top-[-2px] h-3 w-px bg-gray-700"
                  style={{ left: `${Math.min(row.target, 100)}%` }}
                  title={`Target ${row.target}%`}
                />
              )}
            </div>
          </li>
        ))}
      </ul>

      {blueprint.unclassifiedMarks > 0 && (
        <p className="mt-3 text-xs text-amber-800">
          {blueprint.unclassifiedMarks} mark(s) unclassified — the mix above is
          incomplete until every question has a level.
        </p>
      )}

      {blueprint.byTopic.length > 0 && (
        <div className="mt-4">
          <h5 className="text-xs font-medium uppercase tracking-wide text-gray-500">
            By topic
          </h5>
          <ul className="mt-2 flex flex-wrap gap-2">
            {blueprint.byTopic.map((row) => (
              <li
                key={row.key}
                className={`rounded px-2 py-1 text-xs ${
                  row.share > 40
                    ? 'bg-amber-100 text-amber-900'
                    : 'bg-gray-100 text-gray-700'
                }`}
              >
                {row.key} · {row.marks} marks ({row.share}%)
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

const CheckList = ({ checks }) => {
  if (!checks || checks.length === 0) {
    return (
      <p className="rounded border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
        Nothing the server can check is wrong with this paper.
      </p>
    );
  }

  const order = { blocker: 0, warning: 1, note: 2 };
  const sorted = [...checks].sort(
    (a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3)
  );

  return (
    <ul className="space-y-2">
      {sorted.map((check, index) => (
        <li
          key={`${check.code}-${index}`}
          className={`rounded border px-3 py-2 text-sm ${
            CHECK_STYLES[check.severity] || 'border-gray-200 bg-gray-50'
          }`}
        >
          <span className="font-medium uppercase text-xs tracking-wide">
            {check.severity}
          </span>{' '}
          {check.message}
        </li>
      ))}
    </ul>
  );
};

/** The banner that makes an approval mean something. */
const IntegrityBanner = ({ integrity, status }) => {
  if (!integrity || integrity.state === 'not-approved') return null;

  if (integrity.state === 'intact') {
    return (
      <div className="mb-4 rounded border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
        Version {integrity.approvedVersion} was approved, and this is that paper.
      </div>
    );
  }

  return (
    <div className="mb-4 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
      <p className="font-semibold">This is not the paper that was approved.</p>
      <p className="mt-1">
        Version {integrity.approvedVersion} carried the sign-off. The questions, marks or
        answer keys have changed since. It cannot be published until it is moderated
        again{status === 'superseded' ? '' : ' — the review is now superseded'}.
      </p>
    </div>
  );
};

const PaperModeration = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';

  const [tab, setTab] = useState('mine');
  const [meta, setMeta] = useState(null);

  const [mine, setMine] = useState([]);
  const [assigned, setAssigned] = useState([]);
  const [queue, setQueue] = useState([]);

  const [open, setOpen] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [finding, setFinding] = useState({ ...emptyFinding });

  const readError = (err, fallback) => err?.response?.data?.message || fallback;

  const clearMessages = () => {
    setError('');
    setNotice('');
  };

  const loadMeta = useCallback(async () => {
    try {
      const { data } = await api.get('/paper-moderation/meta');
      setMeta(data.data);
    } catch {
      // The form falls back to its own labels.
    }
  }, []);

  const loadMine = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/paper-moderation/reviews/mine');
      setMine(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load your papers'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAssigned = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/paper-moderation/reviews/assigned');
      setAssigned(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the papers assigned to you'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/paper-moderation/reviews/queue');
      setQueue(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the moderation queue'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    if (tab === 'mine') loadMine();
    if (tab === 'assigned') loadAssigned();
    if (tab === 'queue') loadQueue();
  }, [tab, loadMine, loadAssigned, loadQueue]);

  const openReview = async (reviewId) => {
    clearMessages();
    try {
      const { data } = await api.get(`/paper-moderation/reviews/${reviewId}`);
      setOpen(data.data);
    } catch (err) {
      setError(readError(err, 'Could not open that review'));
    }
  };

  const refreshOpen = async () => {
    if (open?._id) await openReview(open._id);
  };

  const submit = async (reviewId) => {
    clearMessages();
    try {
      const { data } = await api.patch(`/paper-moderation/reviews/${reviewId}/submit`);
      setNotice(data.message);
      loadMine();
      refreshOpen();
    } catch (err) {
      setError(readError(err, 'Could not submit the paper'));
    }
  };

  const claim = async (reviewId) => {
    clearMessages();
    try {
      const { data } = await api.patch(`/paper-moderation/reviews/${reviewId}/claim`);
      setNotice(data.message);
      loadQueue();
      loadAssigned();
    } catch (err) {
      setError(readError(err, 'Could not claim that paper'));
    }
  };

  const raiseFinding = async (event) => {
    event.preventDefault();
    if (!open) return;
    clearMessages();
    try {
      await api.post(`/paper-moderation/reviews/${open._id}/findings`, {
        ...finding,
        questionIndex: finding.questionIndex === '' ? null : Number(finding.questionIndex),
      });
      setNotice('Finding recorded.');
      setFinding({ ...emptyFinding });
      refreshOpen();
    } catch (err) {
      setError(readError(err, 'Could not record the finding'));
    }
  };

  const resolveFinding = async (findingId) => {
    const resolutionNote = window.prompt('What was done about it?');
    if (!resolutionNote) return;
    clearMessages();
    try {
      await api.patch(
        `/paper-moderation/reviews/${open._id}/findings/${findingId}/resolve`,
        { resolutionNote }
      );
      setNotice('Marked as resolved.');
      refreshOpen();
    } catch (err) {
      setError(readError(err, 'Could not resolve the finding'));
    }
  };

  const requestChanges = async () => {
    const note = window.prompt('Anything to add for the author?') ?? '';
    clearMessages();
    try {
      const { data } = await api.patch(
        `/paper-moderation/reviews/${open._id}/request-changes`,
        { note }
      );
      setNotice(data.message);
      loadAssigned();
      refreshOpen();
    } catch (err) {
      setError(readError(err, 'Could not send the paper back'));
    }
  };

  const approve = async () => {
    clearMessages();
    try {
      const { data } = await api.patch(`/paper-moderation/reviews/${open._id}/approve`);
      setNotice(data.message);
      loadAssigned();
      refreshOpen();
    } catch (err) {
      setError(readError(err, 'Could not approve the paper'));
    }
  };

  const reject = async () => {
    const note = window.prompt('Why is this paper being rejected?');
    if (!note) return;
    clearMessages();
    try {
      await api.patch(`/paper-moderation/reviews/${open._id}/reject`, { note });
      setNotice('Paper rejected.');
      loadAssigned();
      refreshOpen();
    } catch (err) {
      setError(readError(err, 'Could not reject the paper'));
    }
  };

  const withdraw = async (reviewId) => {
    const reason = window.prompt('Why is this paper being withdrawn?');
    if (!reason) return;
    clearMessages();
    try {
      await api.patch(`/paper-moderation/reviews/${reviewId}/withdraw`, { reason });
      setNotice('Withdrawn from moderation.');
      loadMine();
      setOpen(null);
    } catch (err) {
      setError(readError(err, 'Could not withdraw the paper'));
    }
  };

  const categories = meta?.findingCategories || ['accuracy'];
  const severities = meta?.findingSeverities || ['major'];

  const openBlockers = useMemo(
    () => (open?.checks || []).filter((check) => check.severity === 'blocker'),
    [open]
  );
  const openUnresolved = useMemo(
    () => (open?.findings || []).filter((f) => !f.resolvedAt),
    [open]
  );

  const isModerator = open && String(open.moderator?._id || open.moderator) === String(user?._id);
  const isAuthor = open && String(open.author?._id || open.author) === String(user?._id);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Paper moderation</h1>
        <p className="mt-1 text-gray-600">
          A second pair of eyes on a paper before the students see it. Submitting freezes
          a version and fingerprints it, so an approval refers to one exact paper and says
          so when that paper changes.
        </p>
      </header>

      <nav className="flex gap-2 border-b mb-6">
        {[
          { key: 'mine', label: 'My papers' },
          { key: 'assigned', label: 'To moderate' },
          ...(isAdmin ? [{ key: 'queue', label: 'Queue' }] : []),
        ].map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => {
              setTab(entry.key);
              setOpen(null);
            }}
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

      {!open && tab === 'mine' && (
        <section>
          {mine.length === 0 ? (
            <p className="text-sm text-gray-500">
              No papers in moderation. Open a review from an exam to start one.
            </p>
          ) : (
            <ul className="space-y-3">
              {mine.map((review) => (
                <li key={review._id} className="rounded-lg border bg-white p-4 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-gray-900">{review.examTitle}</p>
                      <p className="text-sm text-gray-600">
                        {ASSESSMENT_LABELS[review.assessmentType] ||
                          review.assessmentType}{' '}
                        · version {review.paperVersion}
                        {review.blueprint &&
                          ` · ${review.blueprint.totalMarks} marks`}
                      </p>
                    </div>
                    <StatusChip status={review.status} />
                  </div>

                  {review.integrity?.state === 'changed' && (
                    <p className="mt-2 text-sm font-medium text-red-700">
                      Edited since approval — not cleared to publish.
                    </p>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => openReview(review._id)}
                      className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
                    >
                      Open
                    </button>
                    {['draft', 'changes-requested'].includes(review.status) && (
                      <button
                        type="button"
                        onClick={() => submit(review._id)}
                        className="rounded border px-3 py-1 text-xs text-gray-700 hover:bg-gray-50"
                      >
                        Submit version {review.paperVersion + (review.status === 'changes-requested' ? 1 : 0)}
                      </button>
                    )}
                    {!['withdrawn', 'rejected'].includes(review.status) && (
                      <button
                        type="button"
                        onClick={() => withdraw(review._id)}
                        className="rounded border px-3 py-1 text-xs text-gray-600 hover:bg-gray-50"
                      >
                        Withdraw
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!open && tab === 'assigned' && (
        <section>
          {assigned.length === 0 ? (
            <p className="text-sm text-gray-500">Nothing is waiting on you.</p>
          ) : (
            <ul className="space-y-3">
              {assigned.map((review) => (
                <li key={review._id} className="rounded-lg border bg-white p-4 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-gray-900">{review.examTitle}</p>
                      <p className="text-sm text-gray-600">
                        {review.author?.name || 'Author hidden'} ·{' '}
                        {ASSESSMENT_LABELS[review.assessmentType]} · version{' '}
                        {review.paperVersion}
                      </p>
                    </div>
                    <span className="text-sm text-red-700">
                      {(review.checks || []).filter((c) => c.severity === 'blocker').length}{' '}
                      blockers
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => openReview(review._id)}
                    className="mt-3 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
                  >
                    Moderate
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!open && tab === 'queue' && isAdmin && (
        <section>
          {queue.length === 0 ? (
            <p className="text-sm text-gray-500">Nothing is waiting for a moderator.</p>
          ) : (
            <ul className="space-y-3">
              {queue.map((row) => (
                <li key={row._id} className="rounded-lg border bg-white p-4 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-gray-900">{row.examTitle}</p>
                      <p className="text-sm text-gray-600">
                        {row.author?.name} · {ASSESSMENT_LABELS[row.assessmentType]} ·{' '}
                        {row.blueprint.totalMarks} marks
                        {row.dueBy && ` · due ${row.dueBy}`}
                      </p>
                    </div>
                    {row.blockerCount > 0 && (
                      <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                        {row.blockerCount} blockers
                      </span>
                    )}
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => claim(row._id)}
                      className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
                    >
                      Moderate this
                    </button>
                    <button
                      type="button"
                      onClick={() => openReview(row._id)}
                      className="rounded border px-3 py-1 text-xs text-gray-700 hover:bg-gray-50"
                    >
                      Look first
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {open && (
        <section>
          <button
            type="button"
            onClick={() => setOpen(null)}
            className="mb-4 text-sm text-blue-700 hover:underline"
          >
            ← back to the list
          </button>

          <IntegrityBanner integrity={open.integrity} status={open.status} />

          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">{open.examTitle}</h2>
              <p className="text-sm text-gray-600">
                {ASSESSMENT_LABELS[open.assessmentType] || open.assessmentType} · version{' '}
                {open.paperVersion}
                {open.moderator?.name && ` · moderated by ${open.moderator.name}`}
                {open.isBlind && !open.verdict?.decidedAt && ' · blind review'}
              </p>
            </div>
            <StatusChip status={open.status} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              <div>
                <h3 className="mb-2 font-semibold text-gray-800">
                  Checks{' '}
                  {openBlockers.length > 0 && (
                    <span className="text-sm font-normal text-red-700">
                      — {openBlockers.length} blocking
                    </span>
                  )}
                </h3>
                <CheckList checks={open.checks} />
              </div>

              <BlueprintBars blueprint={open.blueprint} />
            </div>

            <div className="space-y-4">
              <div>
                <h3 className="mb-2 font-semibold text-gray-800">
                  Findings{' '}
                  {openUnresolved.length > 0 && (
                    <span className="text-sm font-normal text-amber-800">
                      — {openUnresolved.length} unresolved
                    </span>
                  )}
                </h3>

                {(open.findings || []).length === 0 ? (
                  <p className="text-sm text-gray-500">Nothing raised yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {open.findings.map((entry) => (
                      <li
                        key={entry._id}
                        className={`rounded border bg-white p-3 text-sm ${
                          entry.resolvedAt ? 'opacity-70' : ''
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded px-2 py-0.5 text-xs font-medium ${
                              SEVERITY_STYLES[entry.severity] || 'bg-gray-100'
                            }`}
                          >
                            {entry.severity}
                          </span>
                          <span className="text-xs text-gray-500">{entry.category}</span>
                          {entry.questionIndex !== null && (
                            <span className="text-xs text-gray-500">
                              Q{entry.questionIndex + 1}
                            </span>
                          )}
                          <span className="text-xs text-gray-400">
                            v{entry.paperVersion}
                          </span>
                        </div>

                        {entry.questionExcerpt && (
                          <p className="mt-1 text-xs italic text-gray-500">
                            “{entry.questionExcerpt}”
                          </p>
                        )}
                        <p className="mt-1 text-gray-800">{entry.comment}</p>

                        {entry.resolvedAt ? (
                          <p className="mt-1 text-xs text-green-700">
                            Resolved: {entry.resolutionNote}
                          </p>
                        ) : (
                          isAuthor && (
                            <button
                              type="button"
                              onClick={() => resolveFinding(entry._id)}
                              className="mt-2 rounded border px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50"
                            >
                              Mark resolved
                            </button>
                          )
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {isModerator && (
                <form
                  onSubmit={raiseFinding}
                  className="rounded-lg border bg-white p-4 shadow-sm"
                >
                  <h4 className="mb-3 font-semibold text-gray-800">Raise a finding</h4>

                  <div className="grid gap-2 sm:grid-cols-3">
                    <select
                      className="rounded border px-2 py-1 text-sm"
                      value={finding.questionIndex}
                      onChange={(e) =>
                        setFinding({ ...finding, questionIndex: e.target.value })
                      }
                    >
                      <option value="">Whole paper</option>
                      {(open.questions || []).map((question, index) => (
                        <option key={index} value={index}>
                          Q{index + 1}
                        </option>
                      ))}
                    </select>
                    <select
                      className="rounded border px-2 py-1 text-sm"
                      value={finding.category}
                      onChange={(e) =>
                        setFinding({ ...finding, category: e.target.value })
                      }
                    >
                      {categories.map((category) => (
                        <option key={category} value={category}>
                          {category}
                        </option>
                      ))}
                    </select>
                    <select
                      className="rounded border px-2 py-1 text-sm"
                      value={finding.severity}
                      onChange={(e) =>
                        setFinding({ ...finding, severity: e.target.value })
                      }
                    >
                      {severities.map((severity) => (
                        <option key={severity} value={severity}>
                          {severity}
                        </option>
                      ))}
                    </select>
                  </div>

                  <textarea
                    required
                    rows={3}
                    className="mt-2 w-full rounded border px-3 py-2 text-sm"
                    placeholder="What is wrong with it, and what would fix it?"
                    value={finding.comment}
                    onChange={(e) => setFinding({ ...finding, comment: e.target.value })}
                  />

                  <button
                    type="submit"
                    className="mt-2 rounded bg-gray-800 px-3 py-1 text-sm text-white hover:bg-gray-900"
                  >
                    Record finding
                  </button>
                </form>
              )}

              {isModerator && (
                <div className="rounded-lg border bg-white p-4 shadow-sm">
                  <h4 className="mb-2 font-semibold text-gray-800">Verdict</h4>
                  {(openBlockers.length > 0 || openUnresolved.length > 0) && (
                    <p className="mb-3 text-sm text-amber-900">
                      Approval is refused while {openBlockers.length} blocking check(s) and{' '}
                      {openUnresolved.length} unresolved finding(s) stand.
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={approve}
                      disabled={openBlockers.length > 0 || openUnresolved.length > 0}
                      className="rounded bg-green-600 px-3 py-1 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-40"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={requestChanges}
                      className="rounded border px-3 py-1 text-sm text-gray-700 hover:bg-gray-50"
                    >
                      Request changes
                    </button>
                    <button
                      type="button"
                      onClick={reject}
                      className="rounded border border-red-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {open.questions && (
            <div className="mt-6">
              <h3 className="mb-2 font-semibold text-gray-800">The paper</h3>
              <ol className="space-y-3">
                {open.questions.map((question, index) => (
                  <li key={index} className="rounded border bg-white p-3 text-sm">
                    <div className="flex justify-between gap-2">
                      <p className="font-medium text-gray-900">
                        Q{index + 1}. {question.questionText}
                      </p>
                      <span className="shrink-0 text-xs text-gray-500">
                        {question.points} mark(s) · {question.type}
                      </span>
                    </div>
                    {question.type === 'MCQ' && (
                      <ul className="mt-1 list-disc pl-6 text-gray-600">
                        {(question.options || []).map((option, optionIndex) => (
                          <li key={optionIndex}>{option}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      )}
    </div>
  );
};

export default PaperModeration;
