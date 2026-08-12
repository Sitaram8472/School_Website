import { useState, useEffect, useContext, useCallback, useMemo } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * Student council elections.
 *
 * The ballot paper is one card per position with an explicit **Abstain**
 * option, because leaving a position blank and meaning to leave it blank
 * should not look like an unfinished form.
 *
 * Confirmation states plainly that the vote cannot be changed and cannot be
 * traced. Both halves matter and for opposite reasons: the first is a warning,
 * the second is the promise the whole module is built to keep, and a promise
 * nobody is told about does not change whether a nervous fourteen-year-old
 * votes honestly.
 *
 * Nomination shows the eligibility rules *before* the manifesto box. Finding
 * out you were never eligible after writing four hundred words is the reason
 * people stop bothering.
 */

const STATUS_LABELS = {
  draft: 'Draft',
  'nominations-open': 'Nominations open',
  'nominations-closed': 'Nominations closed',
  'voting-open': 'Voting open',
  'voting-closed': 'Voting closed',
  'results-published': 'Results published',
  cancelled: 'Cancelled',
};

const STATUS_STYLES = {
  draft: 'bg-gray-100 text-gray-600',
  'nominations-open': 'bg-blue-100 text-blue-700',
  'nominations-closed': 'bg-slate-100 text-slate-700',
  'voting-open': 'bg-green-100 text-green-700',
  'voting-closed': 'bg-amber-100 text-amber-800',
  'results-published': 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-gray-200 text-gray-500',
};

const CANDIDATE_STATUS_LABELS = {
  pending: 'Awaiting approval',
  approved: 'On the ballot',
  rejected: 'Not approved',
  withdrawn: 'Withdrawn',
};

const ABSTAIN = 'abstain';

const dateTime = (value) =>
  value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';

const StatusChip = ({ status }) => (
  <span
    className={`px-2 py-0.5 rounded text-xs font-medium ${
      STATUS_STYLES[status] || 'bg-gray-100 text-gray-700'
    }`}
  >
    {STATUS_LABELS[status] || status}
  </span>
);

/** A result bar. Width is share of votes cast on that position. */
const ResultBar = ({ votes, total, elected }) => {
  const pct = total ? Math.round((votes / total) * 100) : 0;
  return (
    <div className="mt-1 h-2 w-full rounded bg-gray-100 overflow-hidden">
      <div
        className={`h-full ${elected ? 'bg-emerald-500' : 'bg-blue-400'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
};

const StudentElections = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isStudent = role === 'student';
  const isStaff = role === 'teacher' || role === 'staff' || role === 'admin';
  const isAdmin = role === 'admin';

  const [elections, setElections] = useState([]);
  const [selected, setSelected] = useState(null);
  const [myStatus, setMyStatus] = useState(null);
  const [nominations, setNominations] = useState([]);
  const [seconders, setSeconders] = useState([]);
  const [results, setResults] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [tab, setTab] = useState('vote');

  // positionKey -> candidateId | ABSTAIN
  const [choices, setChoices] = useState({});
  const [confirming, setConfirming] = useState(false);

  const [nominationForm, setNominationForm] = useState({
    positionKey: '',
    manifesto: '',
    seconderId: '',
  });

  const readError = (err, fallback) => err?.response?.data?.message || fallback;

  const clearMessages = () => {
    setError('');
    setNotice('');
  };

  const loadElections = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/elections');
      setElections(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load elections'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadElection = useCallback(
    async (electionId) => {
      setLoading(true);
      try {
        const { data } = await api.get(`/elections/${electionId}`);
        setSelected(data.data);
        setChoices({});
        setConfirming(false);

        const status = await api.get(`/elections/${electionId}/my-status`);
        setMyStatus(status.data.data);

        if (data.data.resultsPublished) {
          const res = await api.get(`/elections/${electionId}/results`);
          setResults(res.data.data.results);
        } else {
          setResults(null);
        }

        if (isStaff) {
          const noms = await api.get(`/elections/${electionId}/nominations`);
          setNominations(noms.data.data || []);
        }
        setError('');
      } catch (err) {
        setError(readError(err, 'Could not load that election'));
      } finally {
        setLoading(false);
      }
    },
    [isStaff]
  );

  const loadSeconders = useCallback(async () => {
    try {
      const { data } = await api.get('/elections/seconders');
      setSeconders(data.data || []);
    } catch {
      setSeconders([]);
    }
  }, []);

  useEffect(() => {
    loadElections();
    if (isStudent) loadSeconders();
  }, [loadElections, loadSeconders, isStudent]);

  const eligiblePositions = useMemo(() => {
    if (!selected) return [];
    const allowed = myStatus?.eligiblePositions;
    if (!allowed) return selected.positions;
    return selected.positions.filter((position) => allowed.includes(position.key));
  }, [selected, myStatus]);

  const chosenCount = useMemo(() => Object.keys(choices).length, [choices]);

  // -- actions ---------------------------------------------------------------

  const submitVote = async () => {
    if (!selected) return;
    clearMessages();

    const payload = Object.entries(choices).map(([positionKey, candidateId]) => ({
      positionKey,
      candidateId: candidateId === ABSTAIN ? undefined : candidateId,
    }));

    if (!payload.length) {
      setError('Choose a candidate or abstain on at least one position');
      return;
    }

    try {
      const { data } = await api.post(`/elections/${selected._id}/vote`, { choices: payload });
      setNotice(data.message);
      setConfirming(false);
      setChoices({});
      await loadElection(selected._id);
    } catch (err) {
      // The already-voted refusal comes from the unique index, not a check, so
      // it is correct even when two tabs submit at once.
      setError(readError(err, 'Could not record your vote'));
      setConfirming(false);
    }
  };

  const submitNomination = async (event) => {
    event.preventDefault();
    if (!selected) return;
    clearMessages();
    try {
      const { data } = await api.post(`/elections/${selected._id}/nominate`, nominationForm);
      setNotice(data.message);
      setNominationForm({ positionKey: '', manifesto: '', seconderId: '' });
      await loadElection(selected._id);
    } catch (err) {
      setError(readError(err, 'Could not record your nomination'));
    }
  };

  const reviewNomination = async (candidateId, decision) => {
    if (!selected) return;
    let reason;
    if (decision === 'rejected') {
      reason = window.prompt('Why is this nomination not approved? The student will read this.');
      if (!reason) return;
    }
    clearMessages();
    try {
      await api.patch(`/elections/${selected._id}/nominations/${candidateId}`, {
        decision,
        reason,
      });
      setNotice(`Nomination ${decision}`);
      await loadElection(selected._id);
    } catch (err) {
      setError(readError(err, 'Could not review the nomination'));
    }
  };

  const moveStatus = async (status) => {
    if (!selected) return;
    clearMessages();
    try {
      const { data } = await api.patch(`/elections/${selected._id}/status`, { status });
      setNotice(data.message);
      await loadElection(selected._id);
      await loadElections();
    } catch (err) {
      setError(readError(err, 'Could not change the status'));
    }
  };

  const publish = async () => {
    if (!selected) return;
    clearMessages();
    try {
      const { data } = await api.patch(`/elections/${selected._id}/publish`, {});
      setNotice(data.message);
      await loadElection(selected._id);
      await loadElections();
    } catch (err) {
      setError(readError(err, 'Could not publish the results'));
    }
  };

  // -- render ----------------------------------------------------------------

  const tabs = [
    { key: 'vote', label: 'Ballot' },
    ...(isStudent ? [{ key: 'stand', label: 'Stand for election' }] : []),
    { key: 'results', label: 'Results' },
    ...(isStaff ? [{ key: 'admin', label: 'Running the election' }] : []),
  ];

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <header>
        <h1 className="text-2xl font-semibold text-gray-800">Student council elections</h1>
        <p className="mt-1 text-sm text-gray-600 max-w-2xl">
          Your ballot is stored with no link to your name — the record that you voted and the
          record of what you chose are kept apart, and there is no field anywhere joining them.
          Voting once is enforced by the database rather than by anybody recognising your face.
        </p>
      </header>

      {(error || notice) && (
        <div
          className={`mt-4 rounded-md px-4 py-3 text-sm ${
            error
              ? 'bg-red-50 text-red-700 border border-red-200'
              : 'bg-green-50 text-green-700 border border-green-200'
          }`}
        >
          {error || notice}
        </div>
      )}

      {!selected && (
        <section className="mt-6 space-y-3">
          {loading && <p className="text-sm text-gray-500">Loading…</p>}
          {elections.length === 0 && !loading ? (
            <p className="text-sm text-gray-500">There are no elections at the moment.</p>
          ) : (
            elections.map((election) => (
              <article
                key={election._id}
                className="rounded-lg border border-gray-200 bg-white p-4 flex flex-wrap items-start justify-between gap-3"
              >
                <div>
                  <h2 className="font-semibold text-gray-800">{election.title}</h2>
                  <p className="text-xs text-gray-500">
                    {election.academicYear} · {election.positions.length} position
                    {election.positions.length === 1 ? '' : 's'}
                  </p>
                  <p className="mt-1 text-xs text-gray-500">
                    Voting {dateTime(election.votingOpensAt)} — {dateTime(election.votingClosesAt)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <StatusChip status={election.status} />
                  <button
                    type="button"
                    onClick={() => {
                      loadElection(election._id);
                      setTab(election.resultsPublished ? 'results' : 'vote');
                    }}
                    className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition"
                  >
                    Open
                  </button>
                </div>
              </article>
            ))
          )}
        </section>
      )}

      {selected && (
        <div className="mt-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-gray-800">{selected.title}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <StatusChip status={selected.status} />
                <span className="text-xs text-gray-500">
                  Voting {dateTime(selected.votingOpensAt)} — {dateTime(selected.votingClosesAt)}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setSelected(null);
                setResults(null);
                setMyStatus(null);
                clearMessages();
              }}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Back to all elections
            </button>
          </div>

          <nav className="mt-6 flex flex-wrap gap-2 border-b border-gray-200">
            {tabs.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => {
                  setTab(entry.key);
                  clearMessages();
                }}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
                  tab === entry.key
                    ? 'border-blue-600 text-blue-700'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {entry.label}
              </button>
            ))}
          </nav>

          {tab === 'vote' && (
            <section className="mt-6">
              {myStatus?.hasVoted ? (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-4 text-sm text-emerald-800">
                  <p className="font-medium">You have voted in this election.</p>
                  <p className="mt-1 text-emerald-700">
                    Your ballot carries no link to your name, so it cannot be shown to you again —
                    and it cannot be shown to anybody else either.
                  </p>
                </div>
              ) : myStatus?.blockedReason ? (
                <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-4 text-sm text-gray-700">
                  {myStatus.blockedReason}
                </div>
              ) : (
                <>
                  <div className="space-y-4">
                    {eligiblePositions.map((position) => (
                      <article
                        key={position.key}
                        className="rounded-lg border border-gray-200 bg-white p-4"
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <h3 className="font-semibold text-gray-800">{position.title}</h3>
                          <span className="text-xs text-gray-500">
                            {position.seats} seat{position.seats === 1 ? '' : 's'}
                          </span>
                        </div>
                        {position.description && (
                          <p className="mt-1 text-xs text-gray-500">{position.description}</p>
                        )}

                        <div className="mt-3 space-y-2">
                          {position.candidates.map((candidate) => {
                            const chosen = choices[position.key] === candidate._id;
                            return (
                              <button
                                key={candidate._id}
                                type="button"
                                onClick={() =>
                                  setChoices({ ...choices, [position.key]: candidate._id })
                                }
                                className={`w-full text-left rounded border px-3 py-3 transition ${
                                  chosen
                                    ? 'border-blue-500 bg-blue-50'
                                    : 'border-gray-200 hover:bg-gray-50'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="font-medium text-gray-800">
                                    {candidate.studentName}
                                  </span>
                                  {candidate.yearGroup && (
                                    <span className="text-xs text-gray-500">
                                      {candidate.yearGroup}
                                    </span>
                                  )}
                                </div>
                                <p className="mt-1 text-sm text-gray-600">{candidate.manifesto}</p>
                              </button>
                            );
                          })}

                          {position.candidates.length === 0 && (
                            <p className="text-sm text-gray-500">
                              No approved candidates for this position.
                            </p>
                          )}

                          {/* An abstention is a choice, and looks like one. */}
                          <button
                            type="button"
                            onClick={() => setChoices({ ...choices, [position.key]: ABSTAIN })}
                            className={`w-full text-left rounded border px-3 py-2 text-sm transition ${
                              choices[position.key] === ABSTAIN
                                ? 'border-gray-500 bg-gray-100 text-gray-800'
                                : 'border-dashed border-gray-300 text-gray-500 hover:bg-gray-50'
                            }`}
                          >
                            Abstain on {position.title}
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>

                  {eligiblePositions.length > 0 && (
                    <div className="mt-6 rounded-lg border border-gray-200 bg-white p-4">
                      {confirming ? (
                        <div>
                          <p className="text-sm font-medium text-gray-800">
                            Submitting {chosenCount} choice{chosenCount === 1 ? '' : 's'}.
                          </p>
                          <p className="mt-1 text-sm text-gray-600">
                            Once submitted your vote <strong>cannot be changed</strong>, and it
                            cannot be traced back to you — including by the staff running the
                            election.
                          </p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={submitVote}
                              className="px-4 py-2 rounded-md bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 transition"
                            >
                              Cast my vote
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirming(false)}
                              className="px-4 py-2 rounded-md border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 transition"
                            >
                              Go back
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <p className="text-sm text-gray-600">
                            {chosenCount} of {eligiblePositions.length} positions chosen
                          </p>
                          <button
                            type="button"
                            disabled={!chosenCount}
                            onClick={() => setConfirming(true)}
                            className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
                          >
                            Review and submit
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {tab === 'stand' && isStudent && (
            <section className="mt-6">
              {(myStatus?.standing || []).length > 0 && (
                <div className="mb-4 space-y-2">
                  {myStatus.standing.map((entry) => (
                    <div
                      key={entry.positionKey}
                      className="rounded border border-gray-200 bg-white px-4 py-3 text-sm"
                    >
                      <span className="font-medium text-gray-800">{entry.positionKey}</span>{' '}
                      <span className="text-gray-500">
                        — {CANDIDATE_STATUS_LABELS[entry.status] || entry.status}
                      </span>
                      {entry.rejectionReason && (
                        <p className="mt-1 text-xs text-red-700">{entry.rejectionReason}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {!selected.nominationsOpen ? (
                <p className="text-sm text-gray-500">
                  Nominations are not open. They run from {dateTime(selected.nominationOpensAt)} to{' '}
                  {dateTime(selected.nominationClosesAt)}.
                </p>
              ) : (
                <form
                  onSubmit={submitNomination}
                  className="rounded-lg border border-gray-200 bg-white p-5 space-y-4"
                >
                  <label className="block text-sm">
                    <span className="block text-gray-600 mb-1">Position</span>
                    <select
                      required
                      value={nominationForm.positionKey}
                      onChange={(e) =>
                        setNominationForm({ ...nominationForm, positionKey: e.target.value })
                      }
                      className="w-full rounded border border-gray-300 px-3 py-2"
                    >
                      <option value="">Choose a position…</option>
                      {eligiblePositions.map((position) => (
                        <option key={position.key} value={position.key}>
                          {position.title} ({position.seats} seat
                          {position.seats === 1 ? '' : 's'})
                        </option>
                      ))}
                    </select>
                    {/* Eligibility before the manifesto box, not after it. */}
                    {selected.positions.length !== eligiblePositions.length && (
                      <span className="mt-1 block text-xs text-amber-700">
                        Some positions in this election are restricted to other year groups and are
                        not listed.
                      </span>
                    )}
                  </label>

                  <label className="block text-sm">
                    <span className="block text-gray-600 mb-1">
                      Seconder — another student who supports your nomination
                    </span>
                    <select
                      required
                      value={nominationForm.seconderId}
                      onChange={(e) =>
                        setNominationForm({ ...nominationForm, seconderId: e.target.value })
                      }
                      className="w-full rounded border border-gray-300 px-3 py-2"
                    >
                      <option value="">Choose a seconder…</option>
                      {seconders.map((person) => (
                        <option key={person._id} value={person._id}>
                          {person.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block text-sm">
                    <span className="block text-gray-600 mb-1">
                      Manifesto — what you would do, in your own words
                    </span>
                    <textarea
                      required
                      rows={6}
                      minLength={40}
                      value={nominationForm.manifesto}
                      onChange={(e) =>
                        setNominationForm({ ...nominationForm, manifesto: e.target.value })
                      }
                      className="w-full rounded border border-gray-300 px-3 py-2"
                    />
                    <span className="mt-1 block text-xs text-gray-500">
                      {nominationForm.manifesto.length} characters — at least 40
                    </span>
                  </label>

                  <button
                    type="submit"
                    className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition"
                  >
                    Stand for election
                  </button>
                </form>
              )}
            </section>
          )}

          {tab === 'results' && (
            <section className="mt-6">
              {!results ? (
                <p className="text-sm text-gray-500">
                  Results are published once the poll has closed and been counted.
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="rounded-lg border border-gray-200 bg-white p-4">
                      <div className="text-xs uppercase tracking-wide text-gray-500">Turnout</div>
                      <div className="mt-1 text-2xl font-semibold text-gray-800">
                        {results.turnout === null ? '—' : `${results.turnout}%`}
                      </div>
                    </div>
                    <div className="rounded-lg border border-gray-200 bg-white p-4">
                      <div className="text-xs uppercase tracking-wide text-gray-500">Voters</div>
                      <div className="mt-1 text-2xl font-semibold text-gray-800">
                        {results.votersRecorded}
                      </div>
                    </div>
                    <div className="rounded-lg border border-gray-200 bg-white p-4">
                      <div className="text-xs uppercase tracking-wide text-gray-500">Eligible</div>
                      <div className="mt-1 text-2xl font-semibold text-gray-800">
                        {results.eligibleVoterCount ?? '—'}
                      </div>
                    </div>
                    <div className="rounded-lg border border-gray-200 bg-white p-4">
                      <div className="text-xs uppercase tracking-wide text-gray-500">Counted</div>
                      <div className="mt-1 text-sm font-medium text-gray-700">
                        {dateTime(results.computedAt)}
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 space-y-4">
                    {results.tallies.map((tally) => (
                      <article
                        key={tally.positionKey}
                        className="rounded-lg border border-gray-200 bg-white p-4"
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <h3 className="font-semibold text-gray-800">{tally.positionTitle}</h3>
                          <span className="text-xs text-gray-500">
                            {tally.votesCast} vote{tally.votesCast === 1 ? '' : 's'} ·{' '}
                            {tally.abstentions} abstention{tally.abstentions === 1 ? '' : 's'} ·{' '}
                            {tally.seats} seat{tally.seats === 1 ? '' : 's'}
                          </span>
                        </div>
                        <ul className="mt-3 space-y-3">
                          {tally.counts.map((count) => (
                            <li key={String(count.candidateId)}>
                              <div className="flex items-center justify-between gap-2 text-sm">
                                <span
                                  className={
                                    count.elected ? 'font-semibold text-emerald-800' : 'text-gray-700'
                                  }
                                >
                                  {count.studentName}
                                  {count.elected && ' · elected'}
                                </span>
                                <span className="text-gray-600">{count.votes}</span>
                              </div>
                              <ResultBar
                                votes={count.votes}
                                total={tally.votesCast}
                                elected={count.elected}
                              />
                            </li>
                          ))}
                          {tally.counts.length === 0 && (
                            <li className="text-sm text-gray-500">No votes recorded.</li>
                          )}
                        </ul>
                      </article>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}

          {tab === 'admin' && isStaff && (
            <section className="mt-6 space-y-6">
              {isAdmin && (
                <div className="rounded-lg border border-gray-200 bg-white p-4">
                  <h3 className="text-sm font-semibold text-gray-700">Windows</h3>
                  <p className="mt-1 text-xs text-gray-500">
                    Nominations {dateTime(selected.nominationOpensAt)} —{' '}
                    {dateTime(selected.nominationClosesAt)}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {['nominations-open', 'nominations-closed', 'voting-open', 'voting-closed'].map(
                      (status) => (
                        <button
                          key={status}
                          type="button"
                          onClick={() => moveStatus(status)}
                          className="px-3 py-1.5 rounded border border-gray-300 text-gray-700 text-xs font-medium hover:bg-gray-50 transition"
                        >
                          {STATUS_LABELS[status]}
                        </button>
                      )
                    )}
                    {selected.status === 'voting-closed' && (
                      <button
                        type="button"
                        onClick={publish}
                        className="px-3 py-1.5 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 transition"
                      >
                        Count and publish
                      </button>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-gray-500">
                    Results are counted from the ballots at publication and frozen. Publishing
                    cannot be undone and voting cannot be reopened afterwards.
                  </p>
                </div>
              )}

              <div>
                <h3 className="text-sm font-semibold text-gray-700">Nominations</h3>
                <div className="mt-2 space-y-2">
                  {nominations.map((nomination) => (
                    <article
                      key={nomination._id}
                      className="rounded-lg border border-gray-200 bg-white p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-gray-800">
                              {nomination.studentName}
                            </span>
                            <span className="text-xs text-gray-500">
                              {nomination.positionTitle || nomination.positionKey}
                            </span>
                            <span className="text-xs text-gray-500">
                              {CANDIDATE_STATUS_LABELS[nomination.status] || nomination.status}
                            </span>
                          </div>
                          <p className="mt-1 text-sm text-gray-600">{nomination.manifesto}</p>
                          <p className="mt-1 text-xs text-gray-500">
                            Seconded by {nomination.seconderName || 'unknown'}
                          </p>
                          {nomination.rejectionReason && (
                            <p className="mt-1 text-xs text-red-700">
                              {nomination.rejectionReason}
                            </p>
                          )}
                        </div>
                        {nomination.status === 'pending' && (
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => reviewNomination(nomination._id, 'approved')}
                              className="px-3 py-1.5 rounded border border-green-300 text-green-700 text-xs font-medium hover:bg-green-50 transition"
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              onClick={() => reviewNomination(nomination._id, 'rejected')}
                              className="px-3 py-1.5 rounded border border-red-300 text-red-700 text-xs font-medium hover:bg-red-50 transition"
                            >
                              Reject
                            </button>
                          </div>
                        )}
                      </div>
                    </article>
                  ))}
                  {nominations.length === 0 && (
                    <p className="text-sm text-gray-500">No nominations yet.</p>
                  )}
                </div>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
};

export default StudentElections;
