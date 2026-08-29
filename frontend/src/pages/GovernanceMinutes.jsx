import { useState, useEffect, useContext, useCallback, useMemo } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * Committee governance — meetings, motions, minutes and actions.
 *
 * The quorum bar at the top of a meeting in session is the thing worth having.
 * It goes red the moment a member leaves and takes the count below the line,
 * because that is the moment the next motion becomes void — and in a room, that
 * moment currently passes unnoticed until somebody wants a decision overturned.
 *
 * The motion recorder computes the outcome as the numbers are typed and refuses
 * to save one that does not reconcile, naming both figures. "Carried 7–2" in a
 * meeting of eight is unresolvable a month later and trivially preventable now.
 *
 * Recusal is a control on the motion rather than a note under it, and the
 * denominator visibly changes when it is used.
 */

const TYPE_LABELS = {
  management: 'Management',
  pta: 'PTA',
  'academic-council': 'Academic council',
  disciplinary: 'Disciplinary',
  finance: 'Finance',
  tender: 'Tender',
  safety: 'Safety',
  admissions: 'Admissions',
  'ad-hoc': 'Ad hoc',
};

const STATUS_LABELS = {
  scheduled: 'Scheduled',
  'in-session': 'In session',
  minuted: 'Minuted',
  circulated: 'Circulated',
  approved: 'Approved',
  cancelled: 'Cancelled',
};

const STATUS_STYLES = {
  scheduled: 'bg-slate-100 text-slate-700',
  'in-session': 'bg-blue-100 text-blue-700',
  minuted: 'bg-indigo-100 text-indigo-700',
  circulated: 'bg-amber-100 text-amber-800',
  approved: 'bg-green-100 text-green-700',
  cancelled: 'bg-gray-200 text-gray-600',
};

const OUTCOME_STYLES = {
  carried: 'bg-green-100 text-green-700',
  lost: 'bg-red-100 text-red-700',
  tied: 'bg-amber-100 text-amber-800',
  'void-no-quorum': 'bg-red-200 text-red-900',
  withdrawn: 'bg-gray-200 text-gray-600',
};

const OUTCOME_LABELS = {
  carried: 'Carried',
  lost: 'Lost',
  tied: 'Tied',
  'void-no-quorum': 'Void — no quorum',
  withdrawn: 'Withdrawn',
};

const ATTENDANCE_LABELS = {
  present: 'Present',
  absent: 'Absent',
  apology: 'Apologies',
  late: 'Arrived late',
  'left-early': 'Left early',
};

const ACTION_STYLES = {
  open: 'bg-slate-100 text-slate-700',
  'in-progress': 'bg-blue-100 text-blue-700',
  done: 'bg-green-100 text-green-700',
  'carried-forward': 'bg-amber-100 text-amber-800',
  dropped: 'bg-gray-200 text-gray-600',
};

const emptyMotion = {
  text: '',
  movedBy: '',
  secondedBy: '',
  votesFor: 0,
  votesAgainst: 0,
  abstentions: 0,
};

const emptyAction = {
  description: '',
  owner: '',
  ownerName: '',
  dueBy: '',
};

/**
 * The quorum bar. Red the instant the room drops below the line.
 */
const QuorumBar = ({ quorum }) => {
  if (!quorum) return null;

  const share = quorum.required
    ? Math.min((quorum.votingPresent / quorum.required) * 100, 100)
    : 100;

  return (
    <div
      className={`rounded-lg border-2 px-4 py-3 ${
        quorum.hasQuorum
          ? 'border-green-300 bg-green-50'
          : 'border-red-400 bg-red-50'
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p
          className={`text-sm font-semibold ${
            quorum.hasQuorum ? 'text-green-800' : 'text-red-800'
          }`}
        >
          {quorum.votingPresent} of {quorum.votingMembers} voting members present ·
          quorum is {quorum.required}
        </p>
        <span
          className={`rounded px-2 py-0.5 text-xs font-bold uppercase ${
            quorum.hasQuorum ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
          }`}
        >
          {quorum.hasQuorum ? 'Quorate' : `Short by ${quorum.shortBy}`}
        </span>
      </div>

      <div className="mt-2 h-2 w-full rounded bg-white">
        <div
          className={`h-full rounded ${quorum.hasQuorum ? 'bg-green-500' : 'bg-red-500'}`}
          style={{ width: `${share}%` }}
        />
      </div>

      {!quorum.hasQuorum && (
        <p className="mt-2 text-sm text-red-800">
          Any motion taken now is void. It will still be recorded, with its figures, and
          marked as void.
        </p>
      )}
    </div>
  );
};

const GovernanceMinutes = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';

  const [tab, setTab] = useState('meetings');

  const [committees, setCommittees] = useState([]);
  const [meetings, setMeetings] = useState([]);
  const [actions, setActions] = useState([]);
  const [overdue, setOverdue] = useState([]);

  const [open, setOpen] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [motion, setMotion] = useState({ ...emptyMotion });
  const [action, setAction] = useState({ ...emptyAction });
  const [minutesText, setMinutesText] = useState('');

  const readError = (err, fallback) => err?.response?.data?.message || fallback;

  const clearMessages = () => {
    setError('');
    setNotice('');
  };

  const loadCommittees = useCallback(async () => {
    try {
      const { data } = await api.get('/governance/committees');
      setCommittees(data.data || []);
    } catch {
      // The meetings list still works without it.
    }
  }, []);

  const loadMeetings = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/governance/meetings/mine');
      setMeetings(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load your meetings'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadActions = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/governance/actions/mine');
      setActions(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load your actions'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOverdue = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/governance/actions/overdue');
      setOverdue(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load overdue actions'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCommittees();
  }, [loadCommittees]);

  useEffect(() => {
    if (tab === 'meetings') loadMeetings();
    if (tab === 'actions') loadActions();
    if (tab === 'overdue') loadOverdue();
  }, [tab, loadMeetings, loadActions, loadOverdue]);

  const openMeeting = async (meetingId) => {
    clearMessages();
    try {
      const { data } = await api.get(`/governance/meetings/${meetingId}`);
      setOpen(data.data);
      setMinutesText(data.data.minutesText || '');
    } catch (err) {
      setError(readError(err, 'Could not open that meeting'));
    }
  };

  const refreshOpen = async () => {
    if (open?._id) await openMeeting(open._id);
  };

  const markAttendance = async (memberId, state) => {
    if (!open) return;
    clearMessages();
    try {
      const { data } = await api.patch(`/governance/meetings/${open._id}/attendance`, {
        attendance: [{ member: memberId, state }],
      });
      setOpen({ ...open, ...data.data });
    } catch (err) {
      setError(readError(err, 'Could not record attendance'));
    }
  };

  const recordMotion = async (event) => {
    event.preventDefault();
    if (!open) return;
    clearMessages();
    try {
      const { data } = await api.post(`/governance/meetings/${open._id}/motions`, {
        ...motion,
        votesFor: Number(motion.votesFor),
        votesAgainst: Number(motion.votesAgainst),
        abstentions: Number(motion.abstentions),
      });
      setNotice(data.message);
      setMotion({ ...emptyMotion });
      refreshOpen();
    } catch (err) {
      setError(readError(err, 'Could not record the motion'));
    }
  };

  const recuse = async (motionId) => {
    const reason = window.prompt('What is the interest being declared?');
    if (!reason) return;
    clearMessages();
    try {
      const { data } = await api.patch(
        `/governance/meetings/${open._id}/motions/${motionId}/recuse`,
        { reason }
      );
      setNotice(data.message);
      refreshOpen();
    } catch (err) {
      setError(readError(err, 'Could not record that recusal'));
    }
  };

  const addAction = async (event) => {
    event.preventDefault();
    if (!open) return;
    clearMessages();
    try {
      await api.post(`/governance/meetings/${open._id}/actions`, action);
      setNotice('Action recorded.');
      setAction({ ...emptyAction });
      refreshOpen();
    } catch (err) {
      setError(readError(err, 'Could not record the action'));
    }
  };

  const closeAction = async (actionId) => {
    const closingNote = window.prompt('What was done?') ?? '';
    clearMessages();
    try {
      await api.patch(`/governance/meetings/${open._id}/actions/${actionId}`, {
        status: 'done',
        closingNote,
      });
      setNotice('Action closed.');
      refreshOpen();
    } catch (err) {
      setError(readError(err, 'Could not close that action'));
    }
  };

  const saveMinutes = async () => {
    if (!open) return;
    clearMessages();
    try {
      const { data } = await api.patch(`/governance/meetings/${open._id}/minute`, {
        minutesText,
      });
      setNotice(data.message);
      refreshOpen();
    } catch (err) {
      setError(readError(err, 'Could not save the minutes'));
    }
  };

  const circulate = async () => {
    clearMessages();
    try {
      const { data } = await api.patch(`/governance/meetings/${open._id}/circulate`);
      setNotice(data.message);
      refreshOpen();
    } catch (err) {
      setError(readError(err, 'Could not circulate the minutes'));
    }
  };

  const approve = async () => {
    const approvalMeeting = window.prompt(
      'Id of the meeting at which these minutes were approved'
    );
    if (!approvalMeeting) return;
    clearMessages();
    try {
      const { data } = await api.patch(`/governance/meetings/${open._id}/approve`, {
        approvalMeeting,
      });
      setNotice(data.message);
      refreshOpen();
    } catch (err) {
      setError(readError(err, 'Could not approve the minutes'));
    }
  };

  const voidMotions = useMemo(
    () => (open?.motions || []).filter((m) => m.outcome === 'void-no-quorum'),
    [open]
  );

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Governance</h1>
        <p className="mt-1 text-gray-600">
          Committees, motions and the actions that come out of them. Quorum is worked out
          at the moment of each vote, and a vote that does not add up is refused when it is
          typed rather than found in an audit.
        </p>
      </header>

      <nav className="flex flex-wrap gap-2 border-b mb-6">
        {[
          { key: 'meetings', label: 'Meetings' },
          { key: 'actions', label: 'My actions' },
          ...(isAdmin ? [{ key: 'overdue', label: 'Overdue' }] : []),
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

      {!open && tab === 'meetings' && (
        <section>
          {committees.length > 0 && (
            <ul className="mb-6 flex flex-wrap gap-2">
              {committees.map((committee) => (
                <li
                  key={committee._id}
                  className="rounded border bg-white px-3 py-2 text-sm"
                >
                  <span className="font-medium text-gray-900">{committee.name}</span>{' '}
                  <span className="text-gray-500">
                    ({TYPE_LABELS[committee.type] || committee.type} ·{' '}
                    {committee.memberCount} members · quorum{' '}
                    {committee.quorum?.required})
                  </span>
                  {committee.myRole && (
                    <span className="ml-2 rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
                      {committee.myRole}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {meetings.length === 0 ? (
            <p className="text-sm text-gray-500">
              You are not on a committee with any meetings recorded.
            </p>
          ) : (
            <ul className="space-y-3">
              {meetings.map((meeting) => (
                <li key={meeting._id} className="rounded-lg border bg-white p-4 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-gray-900">
                        {meeting.serial} · {meeting.committeeName}
                      </p>
                      <p className="text-sm text-gray-600">
                        {meeting.scheduledFor}
                        {meeting.venue && ` · ${meeting.venue}`} ·{' '}
                        {meeting.motions?.length || 0} motion(s) ·{' '}
                        {meeting.openActionCount} open action(s)
                      </p>
                    </div>
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${
                        STATUS_STYLES[meeting.status] || 'bg-gray-100'
                      }`}
                    >
                      {STATUS_LABELS[meeting.status] || meeting.status}
                    </span>
                  </div>

                  {meeting.integrity?.state === 'edited-since-approval' && (
                    <p className="mt-2 text-sm font-medium text-red-700">
                      These approved minutes have been edited since.
                    </p>
                  )}

                  <button
                    type="button"
                    onClick={() => openMeeting(meeting._id)}
                    className="mt-3 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
                  >
                    Open
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!open && tab === 'actions' && (
        <section>
          <h2 className="mb-3 text-lg font-semibold text-gray-800">
            Actions owed by you ({actions.length})
          </h2>
          {actions.length === 0 ? (
            <p className="text-sm text-gray-500">Nothing outstanding.</p>
          ) : (
            <ul className="space-y-2">
              {actions.map((entry) => (
                <li
                  key={entry._id}
                  className={`rounded border bg-white px-4 py-3 text-sm ${
                    entry.isOverdue ? 'border-red-300' : ''
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-gray-900">{entry.description}</span>
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${
                        ACTION_STYLES[entry.status] || 'bg-gray-100'
                      }`}
                    >
                      {entry.status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    {entry.serial} · {entry.committeeName}
                    {entry.dueBy && ` · due ${entry.dueBy}`}
                    {entry.carryCount > 0 &&
                      ` · carried forward ${entry.carryCount} time(s)`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!open && tab === 'overdue' && isAdmin && (
        <section>
          <h2 className="mb-1 text-lg font-semibold text-gray-800">
            Overdue actions ({overdue.length})
          </h2>
          <p className="mb-3 text-sm text-gray-600">
            The carried-forward count is the report. An action carried four times is the
            recurring item that appears in every set of minutes because nobody could see it
            was still open.
          </p>
          {overdue.length === 0 ? (
            <p className="text-sm text-gray-500">Nothing is overdue.</p>
          ) : (
            <ul className="space-y-2">
              {overdue.map((entry) => (
                <li
                  key={entry._id}
                  className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-red-900">{entry.description}</span>
                    <span className="text-xs font-semibold text-red-700">
                      {entry.daysOverdue} days overdue
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-red-700">
                    {entry.ownerName || 'Unassigned'} · {entry.serial} ·{' '}
                    {entry.committeeName}
                    {entry.carryCount > 0 && ` · carried ${entry.carryCount}×`}
                  </p>
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

          {open.integrity?.state === 'edited-since-approval' && (
            <div className="mb-4 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
              <p className="font-semibold">
                These minutes have changed since they were approved.
              </p>
              <p className="mt-1">
                The committee approved a different text, set of motions or set of actions.
                The record no longer matches what was signed off.
              </p>
            </div>
          )}

          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">{open.serial}</h2>
              <p className="text-sm text-gray-600">
                {open.committeeName} · {open.scheduledFor}
                {open.venue && ` · ${open.venue}`}
              </p>
            </div>
            <span
              className={`rounded px-2 py-0.5 text-xs font-medium ${
                STATUS_STYLES[open.status] || 'bg-gray-100'
              }`}
            >
              {STATUS_LABELS[open.status] || open.status}
            </span>
          </div>

          <div className="mb-5">
            <QuorumBar quorum={open.quorum} />
          </div>

          {voidMotions.length > 0 && (
            <div className="mb-4 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
              {voidMotions.length} motion(s) in this meeting were taken without quorum and
              are void.
            </div>
          )}

          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-5">
              <div>
                <h3 className="mb-2 font-semibold text-gray-800">Attendance</h3>
                <ul className="space-y-1">
                  {(open.attendance || []).map((entry) => (
                    <li
                      key={String(entry.member)}
                      className="flex flex-wrap items-center justify-between gap-2 rounded border bg-white px-3 py-2 text-sm"
                    >
                      <span className="text-gray-800">
                        {entry.name || 'Member'}
                        {!entry.isVoting && (
                          <span className="ml-2 text-xs text-gray-400">non-voting</span>
                        )}
                      </span>
                      {open.canMinute ? (
                        <select
                          className="rounded border px-2 py-1 text-xs"
                          value={entry.state}
                          onChange={(e) => markAttendance(entry.member, e.target.value)}
                        >
                          {Object.entries(ATTENDANCE_LABELS).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-xs text-gray-500">
                          {ATTENDANCE_LABELS[entry.state] || entry.state}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <h3 className="mb-2 font-semibold text-gray-800">
                  Motions ({open.motions?.length || 0})
                </h3>
                {(open.motions || []).length === 0 ? (
                  <p className="text-sm text-gray-500">Nothing has been put yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {open.motions.map((entry) => (
                      <li key={entry._id} className="rounded border bg-white p-3 text-sm">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <p className="flex-1 text-gray-900">{entry.text}</p>
                          <span
                            className={`rounded px-2 py-0.5 text-xs font-medium ${
                              OUTCOME_STYLES[entry.outcome] || 'bg-gray-100'
                            }`}
                          >
                            {OUTCOME_LABELS[entry.outcome] || entry.outcome}
                          </span>
                        </div>

                        <p className="mt-1 text-xs text-gray-600">
                          {entry.votesFor} for · {entry.votesAgainst} against ·{' '}
                          {entry.abstentions} abstaining · {entry.eligibleAtVote} entitled
                          to vote against a quorum of {entry.quorumAtVote}
                        </p>

                        {entry.recusals?.length > 0 && (
                          <ul className="mt-1 space-y-0.5 text-xs text-amber-800">
                            {entry.recusals.map((recusal, index) => (
                              <li key={index}>Recused: {recusal.reason}</li>
                            ))}
                          </ul>
                        )}

                        {open.status !== 'approved' && (
                          <button
                            type="button"
                            onClick={() => recuse(entry._id)}
                            className="mt-2 rounded border px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50"
                          >
                            Declare an interest
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {open.canMinute && open.status !== 'approved' && (
                <form
                  onSubmit={recordMotion}
                  className="rounded-lg border bg-white p-4 shadow-sm"
                >
                  <h4 className="mb-3 font-semibold text-gray-800">Record a motion</h4>

                  <textarea
                    required
                    rows={2}
                    className="w-full rounded border px-3 py-2 text-sm"
                    placeholder="That the committee approves…"
                    value={motion.text}
                    onChange={(e) => setMotion({ ...motion, text: e.target.value })}
                  />

                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <input
                      required
                      className="rounded border px-2 py-1 text-sm"
                      placeholder="Moved by (user id)"
                      value={motion.movedBy}
                      onChange={(e) => setMotion({ ...motion, movedBy: e.target.value })}
                    />
                    <input
                      className="rounded border px-2 py-1 text-sm"
                      placeholder="Seconded by (user id)"
                      value={motion.secondedBy}
                      onChange={(e) =>
                        setMotion({ ...motion, secondedBy: e.target.value })
                      }
                    />
                  </div>

                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <label className="text-xs text-gray-600">
                      For
                      <input
                        type="number"
                        min={0}
                        className="mt-1 w-full rounded border px-2 py-1 text-sm"
                        value={motion.votesFor}
                        onChange={(e) =>
                          setMotion({ ...motion, votesFor: e.target.value })
                        }
                      />
                    </label>
                    <label className="text-xs text-gray-600">
                      Against
                      <input
                        type="number"
                        min={0}
                        className="mt-1 w-full rounded border px-2 py-1 text-sm"
                        value={motion.votesAgainst}
                        onChange={(e) =>
                          setMotion({ ...motion, votesAgainst: e.target.value })
                        }
                      />
                    </label>
                    <label className="text-xs text-gray-600">
                      Abstaining
                      <input
                        type="number"
                        min={0}
                        className="mt-1 w-full rounded border px-2 py-1 text-sm"
                        value={motion.abstentions}
                        onChange={(e) =>
                          setMotion({ ...motion, abstentions: e.target.value })
                        }
                      />
                    </label>
                  </div>

                  {/* The arithmetic, said out loud before it is submitted. */}
                  <p className="mt-2 text-xs text-gray-600">
                    {Number(motion.votesFor) +
                      Number(motion.votesAgainst) +
                      Number(motion.abstentions)}{' '}
                    votes against {open.quorum?.votingPresent ?? 0} voting members present.
                    {Number(motion.votesFor) +
                      Number(motion.votesAgainst) +
                      Number(motion.abstentions) >
                      (open.quorum?.votingPresent ?? 0) && (
                      <span className="ml-1 font-medium text-red-700">
                        That does not reconcile and will be refused.
                      </span>
                    )}
                  </p>

                  <button
                    type="submit"
                    className="mt-3 rounded bg-gray-800 px-3 py-1 text-sm text-white hover:bg-gray-900"
                  >
                    Record
                  </button>
                </form>
              )}
            </div>

            <div className="space-y-5">
              <div>
                <h3 className="mb-2 font-semibold text-gray-800">
                  Actions ({open.actions?.length || 0})
                </h3>
                {(open.actions || []).length === 0 ? (
                  <p className="text-sm text-gray-500">Nothing recorded.</p>
                ) : (
                  <ul className="space-y-2">
                    {open.actions.map((entry) => (
                      <li key={entry._id} className="rounded border bg-white p-3 text-sm">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <p className="flex-1 text-gray-900">{entry.description}</p>
                          <span
                            className={`rounded px-2 py-0.5 text-xs ${
                              ACTION_STYLES[entry.status] || 'bg-gray-100'
                            }`}
                          >
                            {entry.status}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-gray-500">
                          {entry.ref} · {entry.ownerName || 'unassigned'}
                          {entry.dueBy && ` · due ${entry.dueBy}`}
                          {entry.carryCount > 0 && (
                            <span className="ml-1 font-medium text-amber-700">
                              carried {entry.carryCount}×
                            </span>
                          )}
                        </p>
                        {entry.status !== 'done' && (
                          <button
                            type="button"
                            onClick={() => closeAction(entry._id)}
                            className="mt-2 rounded border px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50"
                          >
                            Mark done
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {open.canMinute && open.status !== 'approved' && (
                <form
                  onSubmit={addAction}
                  className="rounded-lg border bg-white p-4 shadow-sm"
                >
                  <h4 className="mb-3 font-semibold text-gray-800">Add an action</h4>
                  <textarea
                    required
                    rows={2}
                    className="w-full rounded border px-3 py-2 text-sm"
                    placeholder="What has to happen, and by when?"
                    value={action.description}
                    onChange={(e) =>
                      setAction({ ...action, description: e.target.value })
                    }
                  />
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    <input
                      required
                      className="rounded border px-2 py-1 text-sm"
                      placeholder="Owner (user id)"
                      value={action.owner}
                      onChange={(e) => setAction({ ...action, owner: e.target.value })}
                    />
                    <input
                      className="rounded border px-2 py-1 text-sm"
                      placeholder="Their name"
                      value={action.ownerName}
                      onChange={(e) =>
                        setAction({ ...action, ownerName: e.target.value })
                      }
                    />
                    <input
                      type="date"
                      className="rounded border px-2 py-1 text-sm"
                      value={action.dueBy}
                      onChange={(e) => setAction({ ...action, dueBy: e.target.value })}
                    />
                  </div>
                  <button
                    type="submit"
                    className="mt-3 rounded bg-gray-800 px-3 py-1 text-sm text-white hover:bg-gray-900"
                  >
                    Add
                  </button>
                </form>
              )}

              {open.canMinute && (
                <div className="rounded-lg border bg-white p-4 shadow-sm">
                  <h4 className="mb-2 font-semibold text-gray-800">Minutes</h4>
                  <textarea
                    rows={8}
                    disabled={open.status === 'approved'}
                    className="w-full rounded border px-3 py-2 text-sm disabled:bg-gray-50"
                    value={minutesText}
                    onChange={(e) => setMinutesText(e.target.value)}
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={saveMinutes}
                      disabled={open.status === 'approved'}
                      className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={circulate}
                      disabled={open.status !== 'minuted'}
                      className="rounded border px-3 py-1 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                    >
                      Circulate
                    </button>
                    <button
                      type="button"
                      onClick={approve}
                      disabled={!['minuted', 'circulated'].includes(open.status)}
                      className="rounded bg-green-600 px-3 py-1 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-40"
                    >
                      Approve at a later meeting
                    </button>
                  </div>
                  {open.status === 'approved' && (
                    <p className="mt-2 text-xs text-gray-500">
                      Approved and fingerprinted. Any edit from here shows on the record.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
};

export default GovernanceMinutes;
