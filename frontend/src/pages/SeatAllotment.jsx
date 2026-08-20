import { useState, useEffect, useContext, useCallback } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * Admission merit lists and seat allotment.
 *
 * Two audiences share the page. A family sees one card — their offer, the hours
 * left on it, and two buttons — because during those seventy-two hours that is
 * the whole of their business with the school.
 *
 * Staff see the seat ledger first. Offered, accepted, declined, expired and
 * seats still free are counted from the candidate list on every load rather
 * than stored anywhere, so the figure on screen cannot drift away from the list
 * underneath it the way the spreadsheet's total always does.
 *
 * The merit table shows the tie-break columns next to the composite, so two
 * children on 82.5 visibly differ on the entrance paper or on age rather than
 * appearing to have been ordered by hand.
 */

const CATEGORY_LABELS = {
  general: 'Open merit',
  sibling: 'Sibling',
  'staff-ward': 'Staff ward',
  ews: 'EWS',
  sports: 'Sports',
  management: 'Management',
};

const STATE_LABELS = {
  registered: 'Registered',
  offered: 'Offered',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
  waitlisted: 'Waitlisted',
  'not-selected': 'Not selected',
  withdrawn: 'Withdrawn',
};

const STATE_STYLES = {
  registered: 'bg-slate-100 text-slate-700',
  offered: 'bg-blue-100 text-blue-700',
  accepted: 'bg-green-100 text-green-700',
  declined: 'bg-orange-100 text-orange-700',
  expired: 'bg-red-100 text-red-700',
  waitlisted: 'bg-amber-100 text-amber-800',
  'not-selected': 'bg-gray-200 text-gray-600',
  withdrawn: 'bg-gray-200 text-gray-600',
};

const ROUND_STATUS_STYLES = {
  draft: 'bg-slate-100 text-slate-700',
  ranked: 'bg-indigo-100 text-indigo-700',
  published: 'bg-green-100 text-green-700',
  closed: 'bg-gray-200 text-gray-600',
};

const emptyRound = {
  academicYear: '',
  gradeLevel: '',
  roundNumber: 1,
  totalSeats: 60,
  offerValidityHours: 72,
  quotaSpillover: true,
};

const emptyCandidate = {
  application: '',
  guardian: '',
  category: 'general',
  entrance: 0,
  interaction: 0,
  priorAcademic: 0,
};

const currentYear = () => {
  const now = new Date();
  const startYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
};

const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString();
};

/** "31 hours left" is the number a family is deciding against. */
const countdownPhrase = (hours) => {
  if (hours === null || hours === undefined) return 'No deadline';
  if (hours <= 0) return 'Expired';
  if (hours < 1) return 'Under an hour left';
  if (hours < 48) return `${Math.floor(hours)} hours left`;
  return `${Math.floor(hours / 24)} days left`;
};

const StateChip = ({ state }) => (
  <span
    className={`px-2 py-0.5 rounded text-xs font-medium ${
      STATE_STYLES[state] || 'bg-gray-100 text-gray-600'
    }`}
  >
    {STATE_LABELS[state] || state}
  </span>
);

const CountdownChip = ({ hours }) => (
  <span
    className={`px-2 py-0.5 rounded text-xs font-medium ${
      hours === null || hours === undefined
        ? 'bg-gray-100 text-gray-600'
        : hours <= 0
          ? 'bg-red-100 text-red-700'
          : hours <= 24
            ? 'bg-amber-100 text-amber-800'
            : 'bg-blue-100 text-blue-700'
    }`}
  >
    {countdownPhrase(hours)}
  </span>
);

/** The seat ledger. Every figure here is counted, never stored. */
const SeatLedger = ({ ledger }) => {
  if (!ledger) return null;
  const cells = [
    { label: 'Seats', value: ledger.seats, tone: 'text-gray-900' },
    { label: 'Held', value: ledger.held, tone: 'text-blue-700' },
    { label: 'Free', value: ledger.free, tone: 'text-green-700' },
    { label: 'Accepted', value: ledger.byState?.accepted ?? 0, tone: 'text-green-700' },
    { label: 'Waitlisted', value: ledger.byState?.waitlisted ?? 0, tone: 'text-amber-700' },
    { label: 'Expired', value: ledger.byState?.expired ?? 0, tone: 'text-red-700' },
  ];

  return (
    <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-6">
      {cells.map((cell) => (
        <div key={cell.label} className="bg-white rounded-lg border p-3 text-center">
          <div className={`text-2xl font-semibold ${cell.tone}`}>{cell.value}</div>
          <div className="text-xs text-gray-500 uppercase tracking-wide">{cell.label}</div>
        </div>
      ))}
    </div>
  );
};

const SeatAllotment = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';
  const isStaff = role === 'admin' || role === 'staff';

  const [tab, setTab] = useState('mine');
  const [meta, setMeta] = useState(null);

  const [offers, setOffers] = useState([]);
  const [rounds, setRounds] = useState([]);
  const [openRoundId, setOpenRoundId] = useState(null);
  const [allotment, setAllotment] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [showRoundForm, setShowRoundForm] = useState(false);
  const [roundForm, setRoundForm] = useState({ ...emptyRound, academicYear: currentYear() });
  const [quotaDraft, setQuotaDraft] = useState({ category: 'sibling', seats: 5 });
  const [quotas, setQuotas] = useState([]);

  const [showCandidateForm, setShowCandidateForm] = useState(false);
  const [candidateForm, setCandidateForm] = useState({ ...emptyCandidate });

  const readError = (err, fallback) => err?.response?.data?.message || fallback;

  const clearMessages = () => {
    setError('');
    setNotice('');
  };

  const loadMeta = useCallback(async () => {
    try {
      const { data } = await api.get('/allotment/meta');
      setMeta(data.data);
    } catch {
      // The form falls back to its own defaults.
    }
  }, []);

  const loadMine = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/allotment/offers/mine');
      setOffers(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load your offers'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRounds = useCallback(async () => {
    if (!isStaff) return;
    setLoading(true);
    try {
      const { data } = await api.get('/allotment/rounds');
      setRounds(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the rounds'));
    } finally {
      setLoading(false);
    }
  }, [isStaff]);

  const loadAllotment = useCallback(async (roundId) => {
    if (!roundId) return;
    setLoading(true);
    try {
      const { data } = await api.get(`/allotment/rounds/${roundId}/allotment`);
      setAllotment(data.data);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the allotment'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    if (tab === 'mine') loadMine();
    if (tab === 'rounds') loadRounds();
  }, [tab, loadMine, loadRounds]);

  useEffect(() => {
    if (openRoundId) loadAllotment(openRoundId);
  }, [openRoundId, loadAllotment]);

  const respond = async (offerId, action) => {
    clearMessages();
    try {
      const { data } = await api.patch(`/allotment/offers/${offerId}/${action}`);
      setNotice(data.message);
      loadMine();
      if (openRoundId) loadAllotment(openRoundId);
    } catch (err) {
      setError(readError(err, `Could not ${action} the offer`));
    }
  };

  const addQuota = () => {
    if (quotas.some((q) => q.category === quotaDraft.category)) {
      setError('That category already has a quota in this round');
      return;
    }
    setQuotas([...quotas, { ...quotaDraft, seats: Number(quotaDraft.seats) }]);
  };

  const submitRound = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      await api.post('/allotment/rounds', {
        ...roundForm,
        totalSeats: Number(roundForm.totalSeats),
        roundNumber: Number(roundForm.roundNumber),
        offerValidityHours: Number(roundForm.offerValidityHours),
        quotas,
      });
      setNotice('Round created as a draft. Add candidates, then rank.');
      setShowRoundForm(false);
      setQuotas([]);
      setRoundForm({ ...emptyRound, academicYear: currentYear() });
      loadRounds();
    } catch (err) {
      setError(readError(err, 'Could not create the round'));
    }
  };

  const submitCandidate = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      await api.post(`/allotment/rounds/${openRoundId}/candidates`, {
        ...candidateForm,
        guardian: candidateForm.guardian || undefined,
        entrance: Number(candidateForm.entrance),
        interaction: Number(candidateForm.interaction),
        priorAcademic: Number(candidateForm.priorAcademic),
      });
      setNotice('Candidate registered.');
      setShowCandidateForm(false);
      setCandidateForm({ ...emptyCandidate });
      loadAllotment(openRoundId);
    } catch (err) {
      setError(readError(err, 'Could not register the candidate'));
    }
  };

  const runRoundAction = async (action, verb) => {
    clearMessages();
    try {
      const { data } = await api.post(`/allotment/rounds/${openRoundId}/${action}`);
      setNotice(data.message);
      loadAllotment(openRoundId);
      loadRounds();
    } catch (err) {
      setError(readError(err, `Could not ${verb} the round`));
    }
  };

  const withdrawSeat = async (offerId) => {
    const note = window.prompt('Why is this seat being withdrawn?');
    if (!note) return;
    clearMessages();
    try {
      const { data } = await api.patch(`/allotment/offers/${offerId}/withdraw`, { note });
      setNotice(data.message);
      loadAllotment(openRoundId);
    } catch (err) {
      setError(readError(err, 'Could not withdraw the seat'));
    }
  };

  const categories = meta?.categories || Object.keys(CATEGORY_LABELS);
  const reservedCategories = meta?.reservedCategories || categories.filter((c) => c !== 'general');
  const round = allotment?.round;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Seat allotment</h1>
        <p className="text-gray-600 mt-1">
          Merit lists, reserved seats and offers that expire on their own. A declined seat goes to
          the next candidate in the same operation that released it.
        </p>
      </header>

      <div className="flex gap-2 mb-6 border-b">
        <button
          type="button"
          onClick={() => setTab('mine')}
          className={`px-4 py-2 text-sm font-medium border-b-2 ${
            tab === 'mine'
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          My offers
        </button>
        {isStaff && (
          <button
            type="button"
            onClick={() => setTab('rounds')}
            className={`px-4 py-2 text-sm font-medium border-b-2 ${
              tab === 'rounds'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Rounds
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded bg-red-50 text-red-700 border border-red-200">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 px-4 py-3 rounded bg-green-50 text-green-700 border border-green-200">
          {notice}
        </div>
      )}
      {loading && <p className="text-gray-500 mb-4">Loading…</p>}

      {tab === 'mine' && (
        <section>
          {offers.length === 0 && !loading && (
            <p className="text-gray-500">
              You have no admission offers. Offers appear here the moment a round is published.
            </p>
          )}

          <div className="space-y-4">
            {offers.map((offer) => (
              <article key={offer._id} className="bg-white rounded-lg border p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900">{offer.candidateName}</h2>
                    <p className="text-sm text-gray-600">
                      {offer.round?.gradeLevel} · {offer.round?.academicYear} · round{' '}
                      {offer.round?.roundNumber}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <StateChip state={offer.state} />
                    {offer.state === 'offered' && <CountdownChip hours={offer.hoursRemaining} />}
                  </div>
                </div>

                <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 text-sm">
                  <div>
                    <dt className="text-gray-500">Merit rank</dt>
                    <dd className="font-medium">{offer.rank ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">Composite</dt>
                    <dd className="font-medium">{offer.compositeScore}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">Seat</dt>
                    <dd className="font-medium">
                      {offer.seatKind ? CATEGORY_LABELS[offer.seatKind] : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">
                      {offer.state === 'waitlisted' ? 'Waitlist position' : 'Confirm by'}
                    </dt>
                    <dd className="font-medium">
                      {offer.state === 'waitlisted'
                        ? (offer.waitlistPosition ?? '—')
                        : formatDate(offer.expiresAt)}
                    </dd>
                  </div>
                </dl>

                {offer.state === 'offered' && (
                  <div className="flex gap-2 mt-4">
                    <button
                      type="button"
                      onClick={() => respond(offer._id, 'accept')}
                      className="px-4 py-2 rounded bg-green-600 text-white text-sm font-medium hover:bg-green-700"
                    >
                      Accept the seat
                    </button>
                    <button
                      type="button"
                      onClick={() => respond(offer._id, 'decline')}
                      className="px-4 py-2 rounded border text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                      Decline
                    </button>
                  </div>
                )}

                {offer.state === 'expired' && (
                  <p className="mt-4 text-sm text-red-700">
                    This offer lapsed on {formatDate(offer.expiresAt)} and the seat has gone to the
                    next candidate.
                  </p>
                )}
              </article>
            ))}
          </div>
        </section>
      )}

      {tab === 'rounds' && isStaff && !openRoundId && (
        <section>
          {isAdmin && (
            <div className="mb-4">
              <button
                type="button"
                onClick={() => setShowRoundForm((open) => !open)}
                className="px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
              >
                {showRoundForm ? 'Cancel' : 'New round'}
              </button>
            </div>
          )}

          {showRoundForm && (
            <form onSubmit={submitRound} className="bg-white rounded-lg border p-5 mb-6">
              <div className="grid md:grid-cols-3 gap-4">
                <label className="text-sm">
                  <span className="text-gray-600">Academic year</span>
                  <input
                    required
                    value={roundForm.academicYear}
                    onChange={(e) => setRoundForm({ ...roundForm, academicYear: e.target.value })}
                    placeholder="2026-27"
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Grade</span>
                  <input
                    required
                    value={roundForm.gradeLevel}
                    onChange={(e) => setRoundForm({ ...roundForm, gradeLevel: e.target.value })}
                    placeholder="Class VI"
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Round number</span>
                  <input
                    type="number"
                    min="1"
                    value={roundForm.roundNumber}
                    onChange={(e) => setRoundForm({ ...roundForm, roundNumber: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Total seats</span>
                  <input
                    type="number"
                    min="1"
                    value={roundForm.totalSeats}
                    onChange={(e) => setRoundForm({ ...roundForm, totalSeats: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Offer validity (hours)</span>
                  <input
                    type="number"
                    min="12"
                    value={roundForm.offerValidityHours}
                    onChange={(e) =>
                      setRoundForm({ ...roundForm, offerValidityHours: e.target.value })
                    }
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm flex items-end gap-2 pb-2">
                  <input
                    type="checkbox"
                    checked={roundForm.quotaSpillover}
                    onChange={(e) =>
                      setRoundForm({ ...roundForm, quotaSpillover: e.target.checked })
                    }
                  />
                  <span className="text-gray-600">Unfilled quota seats return to open merit</span>
                </label>
              </div>

              <div className="mt-4 border-t pt-4">
                <p className="text-sm font-medium text-gray-700 mb-2">
                  Reserved seats — what is left over is the open list
                </p>
                <div className="flex flex-wrap gap-2 items-end">
                  <select
                    value={quotaDraft.category}
                    onChange={(e) => setQuotaDraft({ ...quotaDraft, category: e.target.value })}
                    className="border rounded px-3 py-2 text-sm"
                  >
                    {reservedCategories.map((category) => (
                      <option key={category} value={category}>
                        {CATEGORY_LABELS[category] || category}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min="1"
                    value={quotaDraft.seats}
                    onChange={(e) => setQuotaDraft({ ...quotaDraft, seats: e.target.value })}
                    className="border rounded px-3 py-2 text-sm w-24"
                  />
                  <button
                    type="button"
                    onClick={addQuota}
                    className="px-3 py-2 rounded border text-sm hover:bg-gray-50"
                  >
                    Add quota
                  </button>
                </div>

                {quotas.length > 0 && (
                  <ul className="mt-3 text-sm text-gray-700 space-y-1">
                    {quotas.map((quota) => (
                      <li key={quota.category} className="flex items-center gap-2">
                        <span>
                          {CATEGORY_LABELS[quota.category]} — {quota.seats} seats
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setQuotas(quotas.filter((q) => q.category !== quota.category))
                          }
                          className="text-red-600 text-xs"
                        >
                          remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <button
                type="submit"
                className="mt-4 px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
              >
                Create round
              </button>
            </form>
          )}

          <div className="space-y-3">
            {rounds.map((item) => (
              <button
                key={item._id}
                type="button"
                onClick={() => setOpenRoundId(item._id)}
                className="w-full text-left bg-white rounded-lg border p-4 hover:border-blue-400"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-gray-900">
                      {item.gradeLevel} · round {item.roundNumber}
                    </p>
                    <p className="text-sm text-gray-600">
                      {item.academicYear} · {item.totalSeats} seats · offers valid{' '}
                      {item.offerValidityHours}h
                    </p>
                  </div>
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      ROUND_STATUS_STYLES[item.status] || 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {item.status}
                  </span>
                </div>
              </button>
            ))}
            {rounds.length === 0 && !loading && (
              <p className="text-gray-500">No admission rounds yet.</p>
            )}
          </div>
        </section>
      )}

      {tab === 'rounds' && isStaff && openRoundId && round && (
        <section>
          <button
            type="button"
            onClick={() => {
              setOpenRoundId(null);
              setAllotment(null);
            }}
            className="text-sm text-blue-700 mb-4"
          >
            ← All rounds
          </button>

          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <h2 className="text-2xl font-semibold text-gray-900">
                {round.gradeLevel} · round {round.roundNumber}
              </h2>
              <p className="text-sm text-gray-600">
                {round.academicYear} · {round.seatBreakdown?.general ?? 0} open seats ·{' '}
                {round.seatBreakdown?.reserved ?? 0} reserved
              </p>
            </div>
            <span
              className={`px-2 py-0.5 rounded text-xs font-medium ${
                ROUND_STATUS_STYLES[round.status] || 'bg-gray-100 text-gray-600'
              }`}
            >
              {round.status}
            </span>
          </div>

          {allotment.rankingChangedSincePublication && (
            <div className="mb-4 px-4 py-3 rounded bg-amber-50 text-amber-800 border border-amber-200">
              Scores have changed since this list was published. The offers already sent were made
              against the earlier ranking.
            </div>
          )}

          <SeatLedger ledger={allotment.ledger} />

          {isAdmin && (
            <div className="flex flex-wrap gap-2 mb-6">
              <button
                type="button"
                onClick={() => runRoundAction('rank', 'rank')}
                className="px-4 py-2 rounded border text-sm font-medium hover:bg-gray-50"
              >
                Rank
              </button>
              <button
                type="button"
                onClick={() => runRoundAction('publish', 'publish')}
                className="px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
              >
                Publish offers
              </button>
              <button
                type="button"
                onClick={() => runRoundAction('reconcile', 'reconcile')}
                className="px-4 py-2 rounded border text-sm font-medium hover:bg-gray-50"
              >
                Expire &amp; promote
              </button>
              <button
                type="button"
                onClick={() => setShowCandidateForm((open) => !open)}
                className="px-4 py-2 rounded border text-sm font-medium hover:bg-gray-50"
              >
                {showCandidateForm ? 'Cancel' : 'Add candidate'}
              </button>
            </div>
          )}

          {showCandidateForm && (
            <form onSubmit={submitCandidate} className="bg-white rounded-lg border p-5 mb-6">
              <div className="grid md:grid-cols-3 gap-4">
                <label className="text-sm md:col-span-2">
                  <span className="text-gray-600">Application id</span>
                  <input
                    required
                    value={candidateForm.application}
                    onChange={(e) =>
                      setCandidateForm({ ...candidateForm, application: e.target.value })
                    }
                    className="mt-1 w-full border rounded px-3 py-2 font-mono text-xs"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Category</span>
                  <select
                    value={candidateForm.category}
                    onChange={(e) =>
                      setCandidateForm({ ...candidateForm, category: e.target.value })
                    }
                    className="mt-1 w-full border rounded px-3 py-2"
                  >
                    {categories.map((category) => (
                      <option key={category} value={category}>
                        {CATEGORY_LABELS[category] || category}
                      </option>
                    ))}
                  </select>
                </label>
                {['entrance', 'interaction', 'priorAcademic'].map((component) => (
                  <label key={component} className="text-sm">
                    <span className="text-gray-600">{component} (out of 100)</span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={candidateForm[component]}
                      onChange={(e) =>
                        setCandidateForm({ ...candidateForm, [component]: e.target.value })
                      }
                      className="mt-1 w-full border rounded px-3 py-2"
                    />
                  </label>
                ))}
              </div>
              <button
                type="submit"
                className="mt-4 px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
              >
                Register candidate
              </button>
            </form>
          )}

          <div className="bg-white rounded-lg border overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-4 py-2">Rank</th>
                  <th className="text-left px-4 py-2">Candidate</th>
                  <th className="text-left px-4 py-2">Category</th>
                  <th className="text-right px-4 py-2">Composite</th>
                  <th className="text-right px-4 py-2">Entrance</th>
                  <th className="text-right px-4 py-2">Born</th>
                  <th className="text-left px-4 py-2">Seat</th>
                  <th className="text-left px-4 py-2">State</th>
                  {isAdmin && <th className="px-4 py-2" />}
                </tr>
              </thead>
              <tbody>
                {allotment.candidates.map((candidate) => (
                  <tr key={candidate._id} className="border-t">
                    <td className="px-4 py-2 font-medium">{candidate.rank ?? '—'}</td>
                    <td className="px-4 py-2">{candidate.candidateName}</td>
                    <td className="px-4 py-2">
                      {CATEGORY_LABELS[candidate.category] || candidate.category}
                    </td>
                    <td className="px-4 py-2 text-right font-medium">{candidate.compositeScore}</td>
                    <td className="px-4 py-2 text-right text-gray-500">
                      {candidate.componentScores?.entrance ?? 0}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-500">
                      {formatDate(candidate.dateOfBirth)}
                    </td>
                    <td className="px-4 py-2">
                      {candidate.seatKind ? CATEGORY_LABELS[candidate.seatKind] : '—'}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <StateChip state={candidate.state} />
                        {candidate.state === 'waitlisted' && candidate.waitlistPosition && (
                          <span className="text-xs text-gray-500">
                            #{candidate.waitlistPosition}
                          </span>
                        )}
                      </div>
                    </td>
                    {isAdmin && (
                      <td className="px-4 py-2 text-right">
                        {['offered', 'accepted'].includes(candidate.state) && (
                          <button
                            type="button"
                            onClick={() => withdrawSeat(candidate._id)}
                            className="text-xs text-red-600 hover:underline"
                          >
                            withdraw
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {allotment.candidates.length === 0 && (
              <p className="px-4 py-6 text-gray-500">
                No candidates in this round yet. Register them, then rank.
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
};

export default SeatAllotment;
