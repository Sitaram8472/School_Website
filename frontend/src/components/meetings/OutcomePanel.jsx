import { useState, useEffect, useCallback, useContext } from 'react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * Meeting write-ups.
 *
 * Two audiences, two shapes. A teacher gets a backlog — attended meetings with
 * nothing written up, oldest first — because that is what they came here for. A
 * family gets a letter: prose first, then what everybody agreed to do, with the
 * school's undertakings and their own visually apart.
 *
 * Publication is a separate, confirmed step and the consequence is written on
 * the button rather than in a paragraph above it. After publishing, the
 * write-up cannot be edited, only added to, and a button that does something
 * irreversible should say so where the finger is.
 */

const PURPOSE_LABELS = {
  ptm: 'Parent-teacher meeting',
  'academic-concern': 'Academic concern',
  counselling: 'Counselling',
  admission: 'Admission',
  general: 'General',
};

const STATUS_STYLES = {
  draft: 'bg-gray-200 text-gray-700',
  published: 'bg-blue-100 text-blue-700',
  closed: 'bg-green-100 text-green-700',
};

const STATUS_LABELS = {
  draft: 'Draft — not shared',
  published: 'Shared with the family',
  closed: 'Closed',
};

const OWNER_LABELS = {
  school: 'The school',
  family: 'The family',
  student: 'The student',
};

const EMPTY_DRAFT = {
  discussionSummary: '',
  strengths: [''],
  concerns: [''],
  privateNote: '',
  actions: [],
};

const EMPTY_ACTION = {
  description: '',
  ownerRole: 'school',
  ownerName: '',
  dueOn: '',
};

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : '—';

const shortDate = (value) =>
  value ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—';

const OutcomePanel = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isStaff = role === 'teacher' || role === 'admin';

  const [pending, setPending] = useState([]);
  const [outcomes, setOutcomes] = useState([]);
  const [myOutcomes, setMyOutcomes] = useState([]);
  const [openActions, setOpenActions] = useState(null);

  const [writingFor, setWritingFor] = useState(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [newAction, setNewAction] = useState(EMPTY_ACTION);

  const [expandedId, setExpandedId] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 3500);
  };

  const explain = (err, fallback) =>
    setError(err?.response?.data?.message || err?.message || fallback);

  // ---- loading -------------------------------------------------------------

  const loadFamily = useCallback(async () => {
    try {
      const res = await api.get('/meetings/outcomes/mine');
      setMyOutcomes(res.data.data || []);
    } catch (err) {
      explain(err, 'Could not load your meeting write-ups.');
    }
  }, []);

  const loadStaff = useCallback(async () => {
    if (!isStaff) return;

    setLoading(true);
    try {
      const [pendingRes, outcomesRes, actionsRes] = await Promise.all([
        api.get('/meetings/outcomes/pending'),
        api.get('/meetings/outcomes'),
        api.get('/meetings/outcomes/actions/open'),
      ]);

      setPending(pendingRes.data.data || []);
      setOutcomes(outcomesRes.data.data || []);
      setOpenActions(actionsRes.data || null);
    } catch (err) {
      explain(err, 'Could not load meeting write-ups.');
    } finally {
      setLoading(false);
    }
  }, [isStaff]);

  useEffect(() => {
    loadFamily();
  }, [loadFamily]);

  useEffect(() => {
    loadStaff();
  }, [loadStaff]);

  // ---- drafting ------------------------------------------------------------

  const startWriteUp = (row) => {
    setWritingFor(row);
    setDraft({ ...EMPTY_DRAFT, strengths: [''], concerns: [''], actions: [] });
    setError('');
  };

  const setBullet = (field, index, value) => {
    setDraft((current) => ({
      ...current,
      [field]: current[field].map((text, i) => (i === index ? value : text)),
    }));
  };

  const addBullet = (field) =>
    setDraft((current) => ({ ...current, [field]: [...current[field], ''] }));

  const stageAction = () => {
    if (!newAction.description || !newAction.dueOn || !newAction.ownerName) {
      setError('An action needs a description, an owner and a date.');
      return;
    }

    setDraft((current) => ({ ...current, actions: [...current.actions, newAction] }));
    setNewAction(EMPTY_ACTION);
    setError('');
  };

  const submitDraft = async (event) => {
    event.preventDefault();
    setError('');
    setBusy(true);

    try {
      const res = await api.post(
        `/meetings/slots/${writingFor.slot}/bookings/${writingFor.bookingId}/outcome-record`,
        {
          discussionSummary: draft.discussionSummary,
          strengths: draft.strengths.filter(Boolean),
          concerns: draft.concerns.filter(Boolean),
          privateNote: draft.privateNote,
          actions: draft.actions,
        }
      );

      flash(res.data.message || 'Draft saved.');
      setWritingFor(null);
      loadStaff();
    } catch (err) {
      explain(err, 'Could not save the write-up.');
    } finally {
      setBusy(false);
    }
  };

  // ---- acting --------------------------------------------------------------

  const publish = async (outcome) => {
    const confirmed = window.confirm(
      'Publishing shares this with the family and locks it. After this you can add to it, but not change it. Continue?'
    );
    if (!confirmed) return;

    setBusy(true);
    try {
      const res = await api.patch(`/meetings/outcomes/${outcome._id}/publish`);
      flash(res.data.message || 'Published.');
      loadStaff();
    } catch (err) {
      explain(err, 'Could not publish the write-up.');
    } finally {
      setBusy(false);
    }
  };

  const completeAction = async (outcome, action, asFamily) => {
    setBusy(true);
    try {
      const res = await api.patch(
        `/meetings/outcomes/${outcome._id}/actions/${action.index}`,
        { status: 'completed' }
      );
      flash(res.data.message || 'Action completed.');
      if (asFamily) loadFamily();
      else loadStaff();
    } catch (err) {
      explain(err, 'Could not update the action.');
    } finally {
      setBusy(false);
    }
  };

  const carryForward = async (outcome, action) => {
    const reason = window.prompt('Why is this being carried forward?');
    if (!reason) return;

    setBusy(true);
    try {
      const res = await api.patch(`/meetings/outcomes/${outcome._id}/actions/${action.index}`, {
        status: 'carried-forward',
        reason,
      });
      flash(res.data.message || 'Action carried forward.');
      loadStaff();
    } catch (err) {
      explain(err, 'Could not carry the action forward.');
    } finally {
      setBusy(false);
    }
  };

  const addAddendum = async (outcome, asFamily) => {
    const text = window.prompt('What would you like to add?');
    if (!text) return;

    setBusy(true);
    try {
      const res = await api.post(`/meetings/outcomes/${outcome._id}/addenda`, { text });
      flash(res.data.message || 'Addendum added.');
      if (asFamily) loadFamily();
      else loadStaff();
    } catch (err) {
      explain(err, 'Could not add the addendum.');
    } finally {
      setBusy(false);
    }
  };

  const acknowledge = async (outcome) => {
    setBusy(true);
    try {
      const res = await api.patch(`/meetings/outcomes/${outcome._id}/acknowledge`);
      flash(res.data.message || 'Acknowledged.');
      loadFamily();
    } catch (err) {
      explain(err, 'Could not acknowledge the write-up.');
    } finally {
      setBusy(false);
    }
  };

  const closeOutcome = async (outcome) => {
    const note = window.prompt('Closing note (optional):') || '';

    setBusy(true);
    try {
      const res = await api.patch(`/meetings/outcomes/${outcome._id}/close`, { note });
      flash(res.data.message || 'Closed.');
      loadStaff();
    } catch (err) {
      explain(err, 'Could not close the outcome.');
    } finally {
      setBusy(false);
    }
  };

  // ---- pieces --------------------------------------------------------------

  const statusChip = (status) => (
    <span
      className={`text-xs px-2 py-0.5 rounded-full font-medium ${
        STATUS_STYLES[status] || 'bg-gray-100 text-gray-600'
      }`}
    >
      {STATUS_LABELS[status] || status}
    </span>
  );

  const banner = (
    <>
      {error && (
        <div className="bg-red-50 border border-red-100 text-red-700 rounded-xl p-3 mb-4 text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-100 text-green-700 rounded-xl p-3 mb-4 text-sm">
          {success}
        </div>
      )}
    </>
  );

  const actionList = (outcome, asFamily) => {
    const school = outcome.actions.filter((action) => action.ownerRole === 'school');
    const others = outcome.actions.filter((action) => action.ownerRole !== 'school');

    const group = (title, rows) =>
      rows.length > 0 && (
        <div className="mb-3">
          <div className="text-xs font-semibold text-gray-500 mb-1">{title}</div>
          <div className="space-y-1.5">
            {rows.map((action) => (
              <div
                key={action.index}
                className="flex items-start gap-2 text-sm border border-gray-100 rounded-lg px-3 py-2"
              >
                <span
                  className={`mt-0.5 w-4 h-4 rounded border shrink-0 ${
                    action.status === 'completed'
                      ? 'bg-green-500 border-green-500'
                      : 'border-gray-300'
                  }`}
                />
                <div className="flex-1">
                  <div className={action.status === 'completed' ? 'text-gray-400 line-through' : ''}>
                    {action.description}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {action.ownerName} · by {formatDate(action.dueOn)}
                    {action.status === 'carried-forward' && ' · carried forward'}
                    {action.status === 'cancelled' && ' · cancelled'}
                  </div>
                  {action.overdue && (
                    <div className="text-xs text-red-600 mt-0.5">
                      {action.daysLate} day(s) past the agreed date
                    </div>
                  )}
                </div>

                {action.status === 'open' && (
                  <div className="flex gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => completeAction(outcome, action, asFamily)}
                      className="text-xs text-emerald-700 hover:underline disabled:opacity-50"
                    >
                      Done
                    </button>
                    {!asFamily && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => carryForward(outcome, action)}
                        className="text-xs text-gray-500 hover:underline disabled:opacity-50"
                      >
                        Carry over
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      );

    return (
      <>
        {group('The school will', school)}
        {group('The family and student will', others)}
      </>
    );
  };

  // ---- the family's letter -------------------------------------------------

  if (!isStaff) {
    return (
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-6">
        <h2 className="text-lg font-bold text-gray-800 mb-4">What was agreed</h2>
        {banner}

        {myOutcomes.length === 0 ? (
          <p className="text-sm text-gray-500">
            Nothing yet. After a meeting, the teacher's write-up appears here.
          </p>
        ) : (
          <div className="space-y-5">
            {myOutcomes.map((outcome) => (
              <article key={outcome._id} className="border border-gray-100 rounded-xl p-5">
                <header className="mb-3">
                  <div className="font-semibold text-gray-800">
                    {outcome.studentName}
                    <span className="text-gray-400 font-normal">
                      {' '}
                      · {PURPOSE_LABELS[outcome.purpose] || outcome.purpose}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500">
                    {formatDate(outcome.meetingDate)} with {outcome.teacherName}
                  </div>
                </header>

                <p className="text-sm text-gray-700 whitespace-pre-line mb-4">
                  {outcome.discussionSummary}
                </p>

                {outcome.strengths.length > 0 && (
                  <div className="bg-emerald-50 rounded-lg p-3 mb-3">
                    <div className="text-xs font-semibold text-emerald-800 mb-1">
                      What is going well
                    </div>
                    <ul className="text-sm text-emerald-900 list-disc ml-5 space-y-0.5">
                      {outcome.strengths.map((row) => (
                        <li key={row.text}>{row.text}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {outcome.concerns.length > 0 && (
                  <div className="bg-amber-50 rounded-lg p-3 mb-3">
                    <div className="text-xs font-semibold text-amber-900 mb-1">
                      What we are working on
                    </div>
                    <ul className="text-sm text-amber-900 list-disc ml-5 space-y-0.5">
                      {outcome.concerns.map((row) => (
                        <li key={row.text}>{row.text}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {actionList(outcome, true)}

                {outcome.addenda.length > 0 && (
                  <div className="border-t border-gray-100 pt-3 mt-3">
                    <div className="text-xs font-semibold text-gray-500 mb-1">Added since</div>
                    {outcome.addenda.map((addendum) => (
                      <div key={addendum.addedAt} className="text-sm text-gray-600 mb-1">
                        {addendum.text}
                        <span className="text-xs text-gray-400">
                          {' '}
                          — {addendum.addedByName}, {shortDate(addendum.addedAt)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap gap-2 mt-4">
                  {!outcome.acknowledgedAt ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => acknowledge(outcome)}
                      className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm disabled:opacity-50"
                    >
                      I have read this
                    </button>
                  ) : (
                    <span className="text-xs text-gray-500 self-center">
                      Read on {shortDate(outcome.acknowledgedAt)}
                    </span>
                  )}

                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => addAddendum(outcome, true)}
                    className="px-3 py-1.5 border border-gray-200 text-gray-700 rounded-lg text-sm disabled:opacity-50"
                  >
                    Add a comment
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ---- the teacher's view --------------------------------------------------

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-6">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <h2 className="text-lg font-bold text-gray-800">Meeting write-ups</h2>
        {openActions?.summary && (
          <div className="text-xs text-gray-500">
            {openActions.summary.schoolOverdue} overdue school action(s) ·{' '}
            {openActions.summary.school} open
          </div>
        )}
      </div>

      {banner}
      {loading && <p className="text-sm text-gray-500">Loading…</p>}

      {/* ---- the backlog ---- */}
      {pending.length > 0 && !writingFor && (
        <div className="border border-amber-100 bg-amber-50 rounded-xl p-4 mb-6">
          <div className="text-sm font-semibold text-amber-900 mb-2">
            {pending.length} attended meeting(s) not written up
          </div>
          <div className="space-y-2">
            {pending.slice(0, 8).map((row) => (
              <div
                key={`${row.slot}-${row.bookingReference}`}
                className="flex items-center justify-between gap-3 bg-white rounded-lg px-3 py-2 text-sm"
              >
                <div>
                  <span className="font-medium text-gray-800">{row.studentName}</span>
                  <span className="text-gray-500">
                    {' '}
                    · {row.guardianName} · {formatDate(row.date)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => startWriteUp(row)}
                  className="text-xs px-3 py-1.5 bg-gray-800 text-white rounded-lg"
                >
                  Write up
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---- the draft form ---- */}
      {writingFor && (
        <form onSubmit={submitDraft} className="border border-gray-100 rounded-xl p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm text-gray-700">
              <span className="font-semibold">{writingFor.studentName}</span> ·{' '}
              {writingFor.guardianName} · {formatDate(writingFor.date)}
            </div>
            <button
              type="button"
              onClick={() => setWritingFor(null)}
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>

          {writingFor.agenda && (
            <p className="text-xs text-gray-500 mb-3">
              They asked to discuss: {writingFor.agenda}
            </p>
          )}

          <label className="block text-sm mb-3">
            <span className="block text-xs text-gray-500 mb-1">
              What was discussed — the family will read this
            </span>
            <textarea
              value={draft.discussionSummary}
              onChange={(event) => setDraft({ ...draft, discussionSummary: event.target.value })}
              rows={4}
              required
              minLength={30}
              className="w-full border border-gray-200 rounded-lg px-3 py-2"
            />
          </label>

          {/* Strengths before concerns, deliberately. */}
          {[
            ['strengths', 'What is going well'],
            ['concerns', 'What we are working on'],
          ].map(([field, label]) => (
            <div key={field} className="mb-3">
              <span className="block text-xs text-gray-500 mb-1">{label}</span>
              {draft[field].map((text, index) => (
                <input
                  key={`${field}-${index}`}
                  value={text}
                  onChange={(event) => setBullet(field, index, event.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm mb-1"
                />
              ))}
              <button
                type="button"
                onClick={() => addBullet(field)}
                className="text-xs text-blue-600"
              >
                + another
              </button>
            </div>
          ))}

          <label className="block text-sm mb-4">
            <span className="block text-xs text-gray-500 mb-1">
              Private note — staff only, never shown to the family
            </span>
            <textarea
              value={draft.privateNote}
              onChange={(event) => setDraft({ ...draft, privateNote: event.target.value })}
              rows={2}
              className="w-full border border-gray-200 rounded-lg px-3 py-2"
            />
          </label>

          <div className="bg-gray-50 rounded-xl p-3 mb-4">
            <div className="text-xs font-semibold text-gray-600 mb-2">Agreed actions</div>

            {draft.actions.map((action, index) => (
              <div key={`${action.description}-${index}`} className="text-sm text-gray-700 mb-1">
                {index + 1}. {action.description}{' '}
                <span className="text-xs text-gray-500">
                  — {OWNER_LABELS[action.ownerRole]} ({action.ownerName}), by{' '}
                  {formatDate(action.dueOn)}
                </span>
              </div>
            ))}

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 mt-2">
              <input
                value={newAction.description}
                onChange={(event) =>
                  setNewAction({ ...newAction, description: event.target.value })
                }
                placeholder="What will be done"
                className="sm:col-span-2 border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
              />
              <select
                value={newAction.ownerRole}
                onChange={(event) => setNewAction({ ...newAction, ownerRole: event.target.value })}
                className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm"
              >
                {Object.keys(OWNER_LABELS).map((key) => (
                  <option key={key} value={key}>
                    {OWNER_LABELS[key]}
                  </option>
                ))}
              </select>
              <input
                type="date"
                value={newAction.dueOn}
                onChange={(event) => setNewAction({ ...newAction, dueOn: event.target.value })}
                className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm"
              />
              <input
                value={newAction.ownerName}
                onChange={(event) => setNewAction({ ...newAction, ownerName: event.target.value })}
                placeholder="Who exactly"
                className="sm:col-span-2 border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
              />
              <button
                type="button"
                onClick={stageAction}
                className="sm:col-span-2 px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
              >
                Add action
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={busy}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save draft'}
          </button>
        </form>
      )}

      {/* ---- written up ---- */}
      {outcomes.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing written up yet.</p>
      ) : (
        <div className="space-y-3">
          {outcomes.map((outcome) => {
            const open = expandedId === outcome._id;

            return (
              <div key={outcome._id} className="border border-gray-100 rounded-xl p-4">
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setExpandedId(open ? '' : outcome._id)}
                    className="text-left flex-1"
                  >
                    <div className="font-semibold text-gray-800">
                      {outcome.studentName}
                      <span className="text-gray-400 font-normal">
                        {' '}
                        · {formatDate(outcome.meetingDate)}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {outcome.tally.total} action(s) · {outcome.tally.open} open
                      {outcome.tally.overdue > 0 && (
                        <span className="text-red-600"> · {outcome.tally.overdue} overdue</span>
                      )}
                      {outcome.acknowledgedAt && ' · read by the family'}
                    </div>
                  </button>
                  {statusChip(outcome.status)}
                </div>

                {open && (
                  <div className="mt-4 pt-4 border-t border-gray-100">
                    <p className="text-sm text-gray-700 whitespace-pre-line mb-3">
                      {outcome.discussionSummary}
                    </p>

                    {outcome.privateNote && (
                      <div className="bg-gray-100 rounded-lg p-3 mb-3">
                        <div className="text-xs font-semibold text-gray-500 mb-1">
                          Private — never shown to the family
                        </div>
                        <p className="text-sm text-gray-700">{outcome.privateNote}</p>
                      </div>
                    )}

                    {actionList(outcome, false)}

                    <div className="flex flex-wrap gap-2 mt-3">
                      {outcome.status === 'draft' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => publish(outcome)}
                          className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50"
                        >
                          Publish — this locks it
                        </button>
                      )}

                      {outcome.status !== 'draft' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => addAddendum(outcome, false)}
                          className="px-3 py-1.5 border border-gray-200 text-gray-700 rounded-lg text-sm disabled:opacity-50"
                        >
                          Add an addendum
                        </button>
                      )}

                      {outcome.status === 'published' && (
                        <button
                          type="button"
                          disabled={busy || outcome.tally.open > 0}
                          onClick={() => closeOutcome(outcome)}
                          title={
                            outcome.tally.open > 0
                              ? 'Settle every action before closing'
                              : undefined
                          }
                          className="px-3 py-1.5 border border-gray-200 text-gray-600 rounded-lg text-sm disabled:opacity-50"
                        >
                          Close
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default OutcomePanel;
