import { useState, useEffect, useContext, useCallback } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * Staff recruitment.
 *
 * The scoring form is built from the posting's own criteria, with each
 * component's weight shown and the weighted total running as it is filled in,
 * so a panellist can see what a 7 out of 10 on a 35% criterion is actually
 * worth before they commit to it.
 *
 * The panel indicator says "2 of 3 scored" and the scores are genuinely absent
 * until the third arrives — not blurred, not collapsed. Mean and spread appear
 * together, because 74 over forty points of spread is a different
 * recommendation from 74 over four.
 *
 * The vacancy counter sits next to the button that makes an offer, since that
 * is the moment somebody needs to know two posts have three offers against
 * them.
 */

const STAGE_LABELS = {
  received: 'Received',
  screened: 'Screened',
  shortlisted: 'Shortlisted',
  interviewed: 'Interviewed',
  'offer-made': 'Offer made',
  'offer-accepted': 'Accepted',
  'offer-declined': 'Declined',
  'offer-lapsed': 'Lapsed',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

const STAGE_STYLES = {
  received: 'bg-slate-100 text-slate-700',
  screened: 'bg-slate-100 text-slate-700',
  shortlisted: 'bg-indigo-100 text-indigo-700',
  interviewed: 'bg-blue-100 text-blue-700',
  'offer-made': 'bg-amber-100 text-amber-800',
  'offer-accepted': 'bg-green-100 text-green-700',
  'offer-declined': 'bg-orange-100 text-orange-700',
  'offer-lapsed': 'bg-red-100 text-red-700',
  rejected: 'bg-gray-200 text-gray-600',
  withdrawn: 'bg-gray-200 text-gray-600',
};

const POSTING_STATUS_STYLES = {
  draft: 'bg-slate-100 text-slate-700',
  open: 'bg-green-100 text-green-700',
  closed: 'bg-amber-100 text-amber-800',
  shortlisting: 'bg-indigo-100 text-indigo-700',
  interviewing: 'bg-blue-100 text-blue-700',
  offered: 'bg-amber-100 text-amber-800',
  filled: 'bg-teal-100 text-teal-800',
  cancelled: 'bg-gray-200 text-gray-600',
};

const emptyPosting = {
  title: '',
  department: '',
  subject: '',
  employmentType: 'permanent',
  vacancies: 1,
  minQualification: '',
  minExperienceYears: 0,
  salaryBand: '',
  closesOn: '',
  offerValidityDays: 10,
};

const emptyCandidate = {
  candidateName: '',
  email: '',
  phone: '',
  qualification: '',
  yearsExperience: 0,
  coverNote: '',
};

const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
};

const StageChip = ({ stage }) => (
  <span
    className={`px-2 py-0.5 rounded text-xs font-medium ${
      STAGE_STYLES[stage] || 'bg-gray-100 text-gray-600'
    }`}
  >
    {STAGE_LABELS[stage] || stage}
  </span>
);

/** "2 of 3 scored" — and nothing else until the third card arrives. */
const PanelSeal = ({ aggregate }) => {
  if (!aggregate) return null;

  if (!aggregate.isComplete) {
    return (
      <div className="rounded border border-dashed border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        Panel sealed — {aggregate.panelCount} of {aggregate.expectedPanel} panellists have scored.
        Scores appear once everybody has entered theirs.
      </div>
    );
  }

  return (
    <div className="flex items-center gap-6 rounded border bg-white px-3 py-2">
      <div>
        <div className="text-xl font-semibold text-gray-900">{aggregate.mean}</div>
        <div className="text-xs text-gray-500 uppercase tracking-wide">Mean</div>
      </div>
      <div>
        <div
          className={`text-xl font-semibold ${
            aggregate.spread >= 20 ? 'text-amber-700' : 'text-gray-900'
          }`}
        >
          {aggregate.spread}
        </div>
        <div className="text-xs text-gray-500 uppercase tracking-wide">Spread</div>
      </div>
      <p className="text-xs text-gray-500 max-w-xs">
        {aggregate.spread >= 20
          ? 'The panel disagrees; read the individual cards before deciding.'
          : `${aggregate.panelCount} panellists, in agreement.`}
      </p>
    </div>
  );
};

/** The same weighting the server applies, so the form and the record agree. */
const weightedTotalOf = (criteria, draft) =>
  criteria.reduce((sum, criterion) => {
    const raw = Number(draft[criterion.key] ?? 0);
    const ratio = criterion.maxScore ? Math.min(1, raw / criterion.maxScore) : 0;
    return sum + ratio * criterion.weight;
  }, 0);

/**
 * One panellist's card.
 *
 * Declared at module scope rather than inside the page: a component defined in
 * a render is a new component type every keystroke, and the number input loses
 * focus after every digit.
 */
const ScoreForm = ({ criteria, draft, onDraftChange, comment, onCommentChange, total, onSubmit }) => (
  <div className="border-t pt-4 mt-4">
    <p className="text-sm font-medium text-gray-700 mb-3">Your interview card</p>
    <div className="space-y-3">
      {criteria.map((criterion) => (
        <div key={criterion.key} className="flex items-center gap-3">
          <span className="text-sm text-gray-700 flex-1">
            {criterion.label}
            <span className="text-xs text-gray-400 ml-2">
              {criterion.weight}% · out of {criterion.maxScore}
            </span>
          </span>
          <input
            type="number"
            min="0"
            max={criterion.maxScore}
            value={draft[criterion.key] ?? ''}
            onChange={(e) => onDraftChange(criterion.key, e.target.value)}
            className="border rounded px-3 py-1 text-sm w-24"
          />
        </div>
      ))}
    </div>

    <textarea
      rows="2"
      placeholder="Comment for the panel"
      value={comment}
      onChange={(e) => onCommentChange(e.target.value)}
      className="mt-3 w-full border rounded px-3 py-2 text-sm"
    />

    <div className="flex items-center justify-between mt-3">
      <p className="text-sm text-gray-600">
        Weighted total <span className="font-semibold">{Math.round(total * 100) / 100}</span> out of
        100
      </p>
      <button
        type="button"
        onClick={onSubmit}
        className="px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
      >
        Submit card
      </button>
    </div>
  </div>
);

const Recruitment = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';

  const [tab, setTab] = useState('postings');
  const [meta, setMeta] = useState(null);

  const [postings, setPostings] = useState([]);
  const [openPostingId, setOpenPostingId] = useState(null);
  const [postingDetail, setPostingDetail] = useState(null);
  const [applications, setApplications] = useState([]);
  const [openApplication, setOpenApplication] = useState(null);
  const [panelWork, setPanelWork] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [showPostingForm, setShowPostingForm] = useState(false);
  const [postingForm, setPostingForm] = useState({ ...emptyPosting });

  const [showCandidateForm, setShowCandidateForm] = useState(false);
  const [candidateForm, setCandidateForm] = useState({ ...emptyCandidate });

  const [scoreDraft, setScoreDraft] = useState({});
  const [scoreComment, setScoreComment] = useState('');

  const readError = (err, fallback) => err?.response?.data?.message || fallback;

  const clearMessages = () => {
    setError('');
    setNotice('');
  };

  const loadMeta = useCallback(async () => {
    try {
      const { data } = await api.get('/recruitment/meta');
      setMeta(data.data);
    } catch {
      // The page still renders; the form falls back to its own defaults.
    }
  }, []);

  const loadPostings = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/recruitment/postings');
      setPostings(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load postings'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPosting = useCallback(async (postingId) => {
    if (!postingId) return;
    setLoading(true);
    try {
      const [postingRes, applicationsRes] = await Promise.all([
        api.get(`/recruitment/postings/${postingId}`),
        api.get(`/recruitment/postings/${postingId}/applications`),
      ]);
      setPostingDetail(postingRes.data.data);
      setApplications(applicationsRes.data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the posting'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPanelWork = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/recruitment/panel/mine');
      setPanelWork(data.data);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load your panel work'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    if (tab === 'postings') loadPostings();
    if (tab === 'panel') loadPanelWork();
  }, [tab, loadPostings, loadPanelWork]);

  useEffect(() => {
    if (openPostingId) loadPosting(openPostingId);
  }, [openPostingId, loadPosting]);

  const submitPosting = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      await api.post('/recruitment/postings', {
        ...postingForm,
        vacancies: Number(postingForm.vacancies),
        minExperienceYears: Number(postingForm.minExperienceYears),
        offerValidityDays: Number(postingForm.offerValidityDays),
      });
      setNotice('Posting drafted. Add the panel, then publish.');
      setShowPostingForm(false);
      setPostingForm({ ...emptyPosting });
      loadPostings();
    } catch (err) {
      setError(readError(err, 'Could not create the posting'));
    }
  };

  const submitCandidate = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      const { data } = await api.post(
        `/recruitment/postings/${openPostingId}/applications`,
        { ...candidateForm, yearsExperience: Number(candidateForm.yearsExperience) }
      );
      setNotice(data.message);
      setShowCandidateForm(false);
      setCandidateForm({ ...emptyCandidate });
      loadPosting(openPostingId);
    } catch (err) {
      setError(readError(err, 'Could not record the application'));
    }
  };

  const postingAction = async (path, verb) => {
    clearMessages();
    try {
      const { data } = await api.patch(`/recruitment/postings/${openPostingId}/${path}`);
      setNotice(data.message);
      loadPosting(openPostingId);
      loadPostings();
    } catch (err) {
      setError(readError(err, `Could not ${verb}`));
    }
  };

  const reconcile = async () => {
    clearMessages();
    try {
      const { data } = await api.post(`/recruitment/postings/${openPostingId}/reconcile`);
      setNotice(data.message);
      loadPosting(openPostingId);
    } catch (err) {
      setError(readError(err, 'Could not lapse the expired offers'));
    }
  };

  const addPanellist = async () => {
    const userId = window.prompt('User id of the panellist');
    if (!userId) return;
    clearMessages();
    try {
      const { data } = await api.post(`/recruitment/postings/${openPostingId}/panel`, {
        user: userId,
      });
      setNotice(data.message);
      loadPosting(openPostingId);
    } catch (err) {
      setError(readError(err, 'Could not add the panellist'));
    }
  };

  const applicationAction = async (applicationId, path, body, verb) => {
    clearMessages();
    try {
      const { data } = await api.patch(`/recruitment/applications/${applicationId}/${path}`, body);
      setNotice(data.message);
      loadPosting(openPostingId);
      if (tab === 'panel') loadPanelWork();
    } catch (err) {
      setError(readError(err, `Could not ${verb}`));
    }
  };

  const submitScore = async (applicationId, criteria) => {
    clearMessages();
    try {
      const { data } = await api.post(`/recruitment/applications/${applicationId}/scores`, {
        scores: criteria.map((criterion) => ({
          key: criterion.key,
          score: Number(scoreDraft[criterion.key] ?? 0),
        })),
        comment: scoreComment,
      });
      setNotice(data.message);
      setScoreDraft({});
      setScoreComment('');
      setOpenApplication(null);
      if (openPostingId) loadPosting(openPostingId);
      if (tab === 'panel') loadPanelWork();
    } catch (err) {
      setError(readError(err, 'Could not record the score'));
    }
  };

  const posting = postingDetail?.posting;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Recruitment</h1>
        <p className="text-gray-600 mt-1">
          Structured scoring that nobody reads until the panel is complete, offers that cannot
          exceed the establishment, and an acceptance that is firm and singular.
        </p>
      </header>

      <div className="flex gap-2 mb-6 border-b">
        <button
          type="button"
          onClick={() => setTab('postings')}
          className={`px-4 py-2 text-sm font-medium border-b-2 ${
            tab === 'postings'
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Postings
        </button>
        <button
          type="button"
          onClick={() => setTab('panel')}
          className={`px-4 py-2 text-sm font-medium border-b-2 ${
            tab === 'panel'
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          My panel work
        </button>
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

      {tab === 'panel' && panelWork && (
        <section className="space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-3">Waiting for your score</h2>
            {panelWork.awaitingMyScore.length === 0 && (
              <p className="text-gray-500">Nothing is waiting on you.</p>
            )}
            <div className="space-y-3">
              {panelWork.awaitingMyScore.map((application) => {
                const forPosting = panelWork.postings.find(
                  (item) => String(item._id) === String(application.posting)
                );
                return (
                  <article key={application._id} className="bg-white rounded-lg border p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="font-semibold text-gray-900">{application.candidateName}</h3>
                        <p className="text-sm text-gray-600">
                          {forPosting?.title} · {application.qualification || 'no qualification given'}{' '}
                          · {application.yearsExperience} years
                        </p>
                      </div>
                      <StageChip stage={application.stage} />
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        setOpenApplication(
                          openApplication === application._id ? null : application._id
                        )
                      }
                      className="mt-3 text-sm text-blue-700"
                    >
                      {openApplication === application._id ? 'Close card' : 'Score this candidate'}
                    </button>

                    {openApplication === application._id && forPosting && (
                      <ScoreForm
                        criteria={forPosting.criteria}
                        draft={scoreDraft}
                        onDraftChange={(key, value) =>
                          setScoreDraft({ ...scoreDraft, [key]: value })
                        }
                        comment={scoreComment}
                        onCommentChange={setScoreComment}
                        total={weightedTotalOf(forPosting.criteria, scoreDraft)}
                        onSubmit={() => submitScore(application._id, forPosting.criteria)}
                      />
                    )}
                  </article>
                );
              })}
            </div>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-3">Already scored by you</h2>
            {panelWork.scored.length === 0 && <p className="text-gray-500">Nothing yet.</p>}
            <div className="space-y-3">
              {panelWork.scored.map((application) => (
                <article key={application._id} className="bg-white rounded-lg border p-5">
                  <div className="flex items-start justify-between gap-4 mb-3">
                    <h3 className="font-semibold text-gray-900">{application.candidateName}</h3>
                    <StageChip stage={application.stage} />
                  </div>
                  <PanelSeal aggregate={application.aggregate} />
                </article>
              ))}
            </div>
          </div>
        </section>
      )}

      {tab === 'postings' && !openPostingId && (
        <section>
          {isAdmin && (
            <div className="mb-4">
              <button
                type="button"
                onClick={() => setShowPostingForm((open) => !open)}
                className="px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
              >
                {showPostingForm ? 'Cancel' : 'New posting'}
              </button>
            </div>
          )}

          {showPostingForm && (
            <form onSubmit={submitPosting} className="bg-white rounded-lg border p-5 mb-6">
              <div className="grid md:grid-cols-3 gap-4">
                <label className="text-sm">
                  <span className="text-gray-600">Title</span>
                  <input
                    required
                    value={postingForm.title}
                    onChange={(e) => setPostingForm({ ...postingForm, title: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Department</span>
                  <input
                    required
                    value={postingForm.department}
                    onChange={(e) => setPostingForm({ ...postingForm, department: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Subject</span>
                  <input
                    value={postingForm.subject}
                    onChange={(e) => setPostingForm({ ...postingForm, subject: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Vacancies</span>
                  <input
                    type="number"
                    min="1"
                    value={postingForm.vacancies}
                    onChange={(e) => setPostingForm({ ...postingForm, vacancies: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Closes on</span>
                  <input
                    required
                    type="date"
                    value={postingForm.closesOn}
                    onChange={(e) => setPostingForm({ ...postingForm, closesOn: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Offer validity (days)</span>
                  <input
                    type="number"
                    min="1"
                    value={postingForm.offerValidityDays}
                    onChange={(e) =>
                      setPostingForm({ ...postingForm, offerValidityDays: e.target.value })
                    }
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Minimum qualification</span>
                  <input
                    value={postingForm.minQualification}
                    onChange={(e) =>
                      setPostingForm({ ...postingForm, minQualification: e.target.value })
                    }
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Minimum experience (years)</span>
                  <input
                    type="number"
                    min="0"
                    value={postingForm.minExperienceYears}
                    onChange={(e) =>
                      setPostingForm({ ...postingForm, minExperienceYears: e.target.value })
                    }
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Salary band</span>
                  <input
                    value={postingForm.salaryBand}
                    onChange={(e) => setPostingForm({ ...postingForm, salaryBand: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
              </div>
              <p className="text-xs text-gray-500 mt-3">
                Scoring criteria:{' '}
                {(meta?.defaultCriteria || [])
                  .map((criterion) => `${criterion.label} ${criterion.weight}%`)
                  .join(', ')}
                . The weights must total 100, and the panel has to be assigned before publication
                because the seal is defined by its size.
              </p>
              <button
                type="submit"
                className="mt-4 px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
              >
                Draft posting
              </button>
            </form>
          )}

          <div className="space-y-3">
            {postings.map((item) => (
              <button
                key={item._id}
                type="button"
                onClick={() => setOpenPostingId(item._id)}
                className="w-full text-left bg-white rounded-lg border p-4 hover:border-blue-400"
              >
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="font-semibold text-gray-900">
                      {item.ref ? `${item.ref} · ` : ''}
                      {item.title}
                    </p>
                    <p className="text-sm text-gray-600">
                      {item.department} · {item.vacancies} post
                      {item.vacancies === 1 ? '' : 's'} · {item.applicationCount} applications ·
                      closes {formatDate(item.closesOn)}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${
                        POSTING_STATUS_STYLES[item.status] || 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {item.status}
                    </span>
                    <span className="text-xs text-gray-500">
                      {item.seatsFree} of {item.vacancies} free
                    </span>
                  </div>
                </div>
              </button>
            ))}
            {postings.length === 0 && !loading && <p className="text-gray-500">No postings yet.</p>}
          </div>
        </section>
      )}

      {tab === 'postings' && openPostingId && posting && (
        <section>
          <button
            type="button"
            onClick={() => {
              setOpenPostingId(null);
              setPostingDetail(null);
            }}
            className="text-sm text-blue-700 mb-4"
          >
            ← All postings
          </button>

          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <h2 className="text-2xl font-semibold text-gray-900">{posting.title}</h2>
              <p className="text-sm text-gray-600">
                {posting.ref || 'Draft'} · {posting.department} · closes{' '}
                {formatDate(posting.closesOn)} · panel of {posting.panel?.length || 0}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span
                className={`px-2 py-0.5 rounded text-xs font-medium ${
                  POSTING_STATUS_STYLES[posting.status] || 'bg-gray-100 text-gray-600'
                }`}
              >
                {posting.status}
              </span>
              <span className="text-sm font-medium text-gray-700">
                {posting.seatsFree} of {posting.vacancies} posts free
              </span>
              <span className="text-xs text-gray-500">{posting.liveOffers} live offers</span>
            </div>
          </div>

          {isAdmin && (
            <div className="flex flex-wrap gap-2 mb-6">
              {posting.status === 'draft' && (
                <>
                  <button
                    type="button"
                    onClick={addPanellist}
                    className="px-4 py-2 rounded border text-sm font-medium hover:bg-gray-50"
                  >
                    Add panellist
                  </button>
                  <button
                    type="button"
                    onClick={() => postingAction('publish', 'publish it')}
                    className="px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
                  >
                    Publish
                  </button>
                </>
              )}
              {posting.status === 'open' && (
                <button
                  type="button"
                  onClick={() => postingAction('close', 'close it')}
                  className="px-4 py-2 rounded border text-sm font-medium hover:bg-gray-50"
                >
                  Close to applications
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowCandidateForm((open) => !open)}
                className="px-4 py-2 rounded border text-sm font-medium hover:bg-gray-50"
              >
                {showCandidateForm ? 'Cancel' : 'Record an application'}
              </button>
              <button
                type="button"
                onClick={reconcile}
                className="px-4 py-2 rounded border text-sm font-medium hover:bg-gray-50"
              >
                Lapse expired offers
              </button>
            </div>
          )}

          {showCandidateForm && (
            <form onSubmit={submitCandidate} className="bg-white rounded-lg border p-5 mb-6">
              <div className="grid md:grid-cols-3 gap-4">
                <label className="text-sm">
                  <span className="text-gray-600">Name</span>
                  <input
                    required
                    value={candidateForm.candidateName}
                    onChange={(e) =>
                      setCandidateForm({ ...candidateForm, candidateName: e.target.value })
                    }
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Email</span>
                  <input
                    required
                    type="email"
                    value={candidateForm.email}
                    onChange={(e) => setCandidateForm({ ...candidateForm, email: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Phone</span>
                  <input
                    value={candidateForm.phone}
                    onChange={(e) => setCandidateForm({ ...candidateForm, phone: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm md:col-span-2">
                  <span className="text-gray-600">Qualification</span>
                  <input
                    value={candidateForm.qualification}
                    onChange={(e) =>
                      setCandidateForm({ ...candidateForm, qualification: e.target.value })
                    }
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Years of experience</span>
                  <input
                    type="number"
                    min="0"
                    value={candidateForm.yearsExperience}
                    onChange={(e) =>
                      setCandidateForm({ ...candidateForm, yearsExperience: e.target.value })
                    }
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
              </div>
              <button
                type="submit"
                className="mt-4 px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
              >
                Record application
              </button>
            </form>
          )}

          <div className="space-y-3">
            {applications.map((application) => (
              <article key={application._id} className="bg-white rounded-lg border p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="font-semibold text-gray-900">{application.candidateName}</h3>
                    <p className="text-sm text-gray-600">
                      {application.reference} · {application.qualification || '—'} ·{' '}
                      {application.yearsExperience} years
                    </p>
                    {application.stage === 'offer-made' && (
                      <p className="text-sm text-amber-700 mt-1">
                        Offer expires {formatDate(application.offer?.expiresAt)}
                      </p>
                    )}
                  </div>
                  <StageChip stage={application.stage} />
                </div>

                <div className="mt-3">
                  <PanelSeal aggregate={application.aggregate} />
                </div>

                {isAdmin && (
                  <div className="flex flex-wrap gap-2 mt-4">
                    {application.stage === 'received' && (
                      <button
                        type="button"
                        onClick={() =>
                          applicationAction(
                            application._id,
                            'screen',
                            { meetsQualification: true },
                            'screen it'
                          )
                        }
                        className="px-3 py-1.5 rounded border text-xs font-medium hover:bg-gray-50"
                      >
                        Screen
                      </button>
                    )}
                    {application.stage === 'screened' && (
                      <button
                        type="button"
                        onClick={() =>
                          applicationAction(application._id, 'shortlist', {}, 'shortlist it')
                        }
                        className="px-3 py-1.5 rounded border text-xs font-medium hover:bg-gray-50"
                      >
                        Shortlist
                      </button>
                    )}
                    {application.stage === 'shortlisted' && (
                      <button
                        type="button"
                        onClick={() =>
                          applicationAction(application._id, 'interviewed', {}, 'mark interviewed')
                        }
                        className="px-3 py-1.5 rounded border text-xs font-medium hover:bg-gray-50"
                      >
                        Mark interviewed
                      </button>
                    )}
                    {application.stage === 'interviewed' && (
                      <button
                        type="button"
                        onClick={() => applicationAction(application._id, 'offer', {}, 'make the offer')}
                        className="px-3 py-1.5 rounded bg-green-600 text-white text-xs font-medium hover:bg-green-700"
                      >
                        Make offer ({posting.seatsFree} free)
                      </button>
                    )}
                    {application.stage === 'offer-made' && (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            applicationAction(
                              application._id,
                              'offer/respond',
                              { decision: 'accept' },
                              'record the acceptance'
                            )
                          }
                          className="px-3 py-1.5 rounded bg-green-600 text-white text-xs font-medium hover:bg-green-700"
                        >
                          Candidate accepted
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            applicationAction(
                              application._id,
                              'offer/respond',
                              { decision: 'decline' },
                              'record the decline'
                            )
                          }
                          className="px-3 py-1.5 rounded border text-xs font-medium hover:bg-gray-50"
                        >
                          Candidate declined
                        </button>
                      </>
                    )}
                    {!['offer-accepted', 'rejected', 'withdrawn'].includes(application.stage) && (
                      <button
                        type="button"
                        onClick={() => {
                          const note = window.prompt('Note for the record') || '';
                          applicationAction(application._id, 'reject', { note }, 'close it');
                        }}
                        className="px-3 py-1.5 rounded border border-red-200 text-red-700 text-xs font-medium hover:bg-red-50"
                      >
                        Reject
                      </button>
                    )}
                  </div>
                )}
              </article>
            ))}
            {applications.length === 0 && !loading && (
              <p className="text-gray-500">No applications recorded for this post yet.</p>
            )}
          </div>
        </section>
      )}
    </div>
  );
};

export default Recruitment;
