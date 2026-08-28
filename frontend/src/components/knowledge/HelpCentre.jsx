import { useState, useEffect, useCallback, useContext } from 'react';
import {
  LifeBuoy,
  Search,
  ThumbsUp,
  ThumbsDown,
  ShieldAlert,
  CheckCircle2,
  PencilLine,
  Clock,
} from 'lucide-react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * The help centre.
 *
 * The same published articles the assistant answers from, rendered as a page
 * anybody can read. That is the point: the FAQ and the assistant's knowledge
 * base are currently two hard-coded copies of overlapping material that drift
 * apart, and a visitor asking the chatbot and a visitor reading the page can
 * be told different things about the same policy on the same afternoon.
 *
 * Staff who are signed in get the authoring controls in the same panel, so the
 * person fixing a wrong answer is looking at the answer as a family sees it.
 */

const CATEGORY_LABELS = {
  admissions: 'Admissions',
  fees: 'Fees',
  academics: 'Academics',
  'campus-life': 'Campus life',
  transport: 'Transport',
  results: 'Results',
  support: 'Support',
  general: 'General',
};

const STATUS_STYLES = {
  draft: 'bg-amber-100 text-amber-800',
  'in-review': 'bg-blue-100 text-blue-700',
  published: 'bg-green-100 text-green-700',
  archived: 'bg-gray-200 text-gray-600',
};

const EMPTY_DRAFT = {
  question: '',
  answer: '',
  category: 'general',
  audience: 'public',
  tags: '',
};

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—';

/**
 * Identifies a browser, not a person — which is the most an unauthenticated
 * help page can honestly claim, and enough to stop the same reader pressing
 * the button forty times. Kept in local storage so a refresh does not mint a
 * second one.
 */
const voterKey = () => {
  const stored = localStorage.getItem('helpCentreVoterKey');
  if (stored) return stored;

  const minted =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? `hc-${crypto.randomUUID()}`
      : `hc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  localStorage.setItem('helpCentreVoterKey', minted);
  return minted;
};

const HelpCentre = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isEditor = role === 'teacher' || role === 'staff' || role === 'admin';
  const isPublisher = role === 'admin';
  const myId = user?._id || user?.user?._id || user?.id || null;

  const [articles, setArticles] = useState([]);
  const [categories, setCategories] = useState({});
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const [openSlug, setOpenSlug] = useState('');
  const [voted, setVoted] = useState({});

  const [manageRows, setManageRows] = useState([]);
  const [showManage, setShowManage] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [showDraft, setShowDraft] = useState(false);

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

  const load = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const term = query.trim();

      const { data } = term
        ? await api.get('/knowledge-articles/search', { params: { q: term } })
        : await api.get('/knowledge-articles', {
            params: category ? { category } : {},
          });

      setArticles(data.data || []);
      if (!term) setCategories(data.categories || {});
    } catch (err) {
      setError(explain(err, 'Could not load the help centre.'));
    } finally {
      setLoading(false);
    }
  }, [query, category]);

  useEffect(() => {
    // Debounced so typing a question does not fire a request per keystroke.
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load]);

  const loadManage = useCallback(async () => {
    if (!isEditor) return;

    try {
      const { data } = await api.get('/knowledge-articles/manage');
      setManageRows(data.data || []);
    } catch (err) {
      setError(explain(err, 'Could not load the article list.'));
    }
  }, [isEditor]);

  useEffect(() => {
    if (showManage) loadManage();
  }, [showManage, loadManage]);

  const rate = async (slug, helpful) => {
    setBusyId(slug);

    try {
      await api.post(`/knowledge-articles/slug/${slug}/rate`, {
        voterKey: voterKey(),
        helpful,
      });

      setVoted((current) => ({ ...current, [slug]: helpful }));
      flash('Thank you — that helps us keep this accurate.');
      await load();
    } catch (err) {
      setError(explain(err, 'Could not record your feedback.'));
    } finally {
      setBusyId('');
    }
  };

  const saveDraft = async (event) => {
    event.preventDefault();
    setError('');

    if (!draft.question.trim() || !draft.answer.trim()) {
      setError('A question and an answer are both needed.');
      return;
    }

    setBusyId('draft');

    try {
      await api.post('/knowledge-articles', {
        ...draft,
        tags: draft.tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      });

      flash('Draft saved. Somebody other than you has to publish it.');
      setDraft(EMPTY_DRAFT);
      setShowDraft(false);
      await loadManage();
    } catch (err) {
      setError(explain(err, 'Could not save the draft.'));
    } finally {
      setBusyId('');
    }
  };

  const publish = async (row) => {
    setBusyId(row._id);
    setError('');

    try {
      await api.patch(`/knowledge-articles/${row._id}/publish`);
      flash('Published.');
      await Promise.all([loadManage(), load()]);
    } catch (err) {
      setError(explain(err, 'Could not publish the article.'));
    } finally {
      setBusyId('');
    }
  };

  const archive = async (row) => {
    const reason = window.prompt('Why is this answer coming down? This is recorded.');
    if (reason === null) return;

    if (!reason.trim()) {
      setError('Archiving needs a reason.');
      return;
    }

    setBusyId(row._id);
    setError('');

    try {
      await api.patch(`/knowledge-articles/${row._id}/archive`, { reason });
      flash('Archived and removed from the site.');
      await Promise.all([loadManage(), load()]);
    } catch (err) {
      setError(explain(err, 'Could not archive the article.'));
    } finally {
      setBusyId('');
    }
  };

  const submit = async (row) => {
    setBusyId(row._id);
    setError('');

    try {
      await api.patch(`/knowledge-articles/${row._id}/submit`);
      flash('Sent for review.');
      await loadManage();
    } catch (err) {
      setError(explain(err, 'Could not send it for review.'));
    } finally {
      setBusyId('');
    }
  };

  const categoryKeys = Object.keys(categories);

  return (
    <section className="max-w-5xl mx-auto px-4 py-16">
      <div className="text-center mb-8">
        <h2 className="text-3xl font-bold text-slate-800 flex items-center justify-center gap-2">
          <LifeBuoy className="text-blue-600" size={28} />
          Help centre
        </h2>
        <p className="text-slate-600 mt-2 max-w-2xl mx-auto">
          The answers our assistant gives, written down and dated. Ask a question or
          browse by topic.
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

      <div className="relative mb-6">
        <Search
          size={18}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="What would you like to know?"
          className="w-full border border-slate-300 rounded-xl pl-10 pr-4 py-3"
        />
      </div>

      {!query.trim() && categoryKeys.length > 0 && (
        <div className="flex flex-wrap justify-center gap-2 mb-8">
          <button
            type="button"
            onClick={() => setCategory('')}
            className={`px-4 py-2 rounded-full text-sm font-medium transition ${
              category === ''
                ? 'bg-blue-600 text-white'
                : 'bg-white text-slate-700 border border-slate-300 hover:bg-blue-50'
            }`}
          >
            Everything
          </button>

          {categoryKeys.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setCategory(key)}
              className={`px-4 py-2 rounded-full text-sm font-medium transition ${
                category === key
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-slate-700 border border-slate-300 hover:bg-blue-50'
              }`}
            >
              {CATEGORY_LABELS[key] || key} ({categories[key]})
            </button>
          ))}
        </div>
      )}

      {loading && <p className="text-center text-slate-500">Looking…</p>}

      {!loading && !articles.length && (
        <p className="text-center text-slate-500">
          {query.trim()
            ? 'Nothing matches that yet. Try fewer words, or ask our assistant.'
            : 'No published answers yet.'}
        </p>
      )}

      <div className="space-y-3">
        {articles.map((article) => {
          const open = openSlug === article.slug;

          return (
            <div
              key={article.slug}
              className="border border-slate-200 rounded-lg overflow-hidden bg-white"
            >
              <button
                type="button"
                onClick={() => setOpenSlug(open ? '' : article.slug)}
                aria-expanded={open}
                className="w-full text-left px-4 py-3 flex justify-between items-center gap-3 hover:bg-slate-50"
              >
                <span className="font-medium text-slate-800">{article.question}</span>
                <span
                  className={`text-xl text-slate-400 transition-transform duration-300 ${
                    open ? 'rotate-45' : ''
                  }`}
                >
                  +
                </span>
              </button>

              {open && (
                <div className="px-4 pb-4 text-slate-700">
                  <p className="whitespace-pre-line">{article.answer}</p>

                  <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-slate-500">
                    <span>
                      {CATEGORY_LABELS[article.category] || article.category} · reviewed{' '}
                      {formatDate(article.publishedAt)}
                      {article.version > 1 ? ` · v${article.version}` : ''}
                    </span>

                    <span className="flex items-center gap-2">
                      Was this useful?
                      <button
                        type="button"
                        disabled={busyId === article.slug}
                        onClick={() => rate(article.slug, true)}
                        className={`p-1.5 rounded-md border transition ${
                          voted[article.slug] === true
                            ? 'border-green-500 text-green-700 bg-green-50'
                            : 'border-slate-300 text-slate-500 hover:bg-slate-50'
                        }`}
                        aria-label="Yes, this was useful"
                      >
                        <ThumbsUp size={15} />
                      </button>

                      <button
                        type="button"
                        disabled={busyId === article.slug}
                        onClick={() => rate(article.slug, false)}
                        className={`p-1.5 rounded-md border transition ${
                          voted[article.slug] === false
                            ? 'border-red-400 text-red-700 bg-red-50'
                            : 'border-slate-300 text-slate-500 hover:bg-slate-50'
                        }`}
                        aria-label="No, this was not useful"
                      >
                        <ThumbsDown size={15} />
                      </button>
                    </span>

                    {article.helpfulRate !== null && (
                      <span>{article.helpfulRate}% found this useful</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {isEditor && (
        <div className="mt-10 border-t border-slate-200 pt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
              <PencilLine size={18} className="text-blue-600" />
              Maintain the answers
            </h3>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowManage((open) => !open)}
                className="px-3 py-2 rounded-md bg-slate-800 text-white hover:bg-slate-700 text-sm"
              >
                {showManage ? 'Hide' : 'Show'} all articles
              </button>

              <button
                type="button"
                onClick={() => setShowDraft((open) => !open)}
                className="px-3 py-2 rounded-md border border-blue-600 text-blue-700 hover:bg-blue-50 text-sm"
              >
                Write an answer
              </button>
            </div>
          </div>

          {showDraft && (
            <form
              onSubmit={saveDraft}
              className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 rounded-lg border border-slate-200 bg-slate-50 p-4"
            >
              <label className="text-sm text-slate-700 md:col-span-2">
                Question
                <input
                  type="text"
                  value={draft.question}
                  onChange={(e) => setDraft({ ...draft, question: e.target.value })}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
                />
              </label>

              <label className="text-sm text-slate-700 md:col-span-2">
                Answer
                <textarea
                  rows="4"
                  value={draft.answer}
                  onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
                />
              </label>

              <label className="text-sm text-slate-700">
                Topic
                <select
                  value={draft.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
                >
                  {Object.keys(CATEGORY_LABELS).map((key) => (
                    <option key={key} value={key}>
                      {CATEGORY_LABELS[key]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-sm text-slate-700">
                Who is it for?
                <select
                  value={draft.audience}
                  onChange={(e) => setDraft({ ...draft, audience: e.target.value })}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
                >
                  <option value="public">Anybody</option>
                  <option value="students">Students</option>
                  <option value="parents">Parents</option>
                  <option value="staff">Staff</option>
                </select>
              </label>

              <label className="text-sm text-slate-700 md:col-span-2">
                Tags, comma separated
                <input
                  type="text"
                  value={draft.tags}
                  onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                  placeholder="uniform, timings"
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2"
                />
              </label>

              <div className="md:col-span-2">
                <button
                  type="submit"
                  disabled={busyId === 'draft'}
                  className="px-4 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
                >
                  {busyId === 'draft' ? 'Saving…' : 'Save draft'}
                </button>
              </div>
            </form>
          )}

          {showManage && (
            <div className="mt-4 space-y-3">
              {manageRows.length ? (
                manageRows.map((row) => {
                  const mine = myId && String(row.authoredBy) === String(myId);

                  return (
                    <div
                      key={row._id}
                      className="border border-slate-200 rounded-lg p-4 bg-white"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="font-medium text-slate-800">{row.question}</p>
                          <p className="text-sm text-slate-500">
                            {CATEGORY_LABELS[row.category] || row.category} ·{' '}
                            {row.audience} · v{row.version}
                            {row.authoredByName ? ` · by ${row.authoredByName}` : ''}
                          </p>
                          {row.isStale && (
                            <p className="text-sm text-amber-700 mt-1 flex items-center gap-1">
                              <Clock size={14} />
                              Review was due {formatDate(row.reviewDueAt)}
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
                            disabled={busyId === row._id}
                            onClick={() => submit(row)}
                            className="px-3 py-1.5 text-sm rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                          >
                            Send for review
                          </button>
                        )}

                        {isPublisher &&
                          (row.status === 'draft' || row.status === 'in-review') && (
                            <button
                              type="button"
                              disabled={busyId === row._id || mine}
                              onClick={() => publish(row)}
                              title={
                                mine
                                  ? 'You wrote this, so somebody else has to publish it'
                                  : ''
                              }
                              className="px-3 py-1.5 text-sm rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                            >
                              Publish
                            </button>
                          )}

                        {isPublisher && row.status !== 'archived' && (
                          <button
                            type="button"
                            disabled={busyId === row._id}
                            onClick={() => archive(row)}
                            className="px-3 py-1.5 text-sm rounded-md border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-60"
                          >
                            Archive
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              ) : (
                <p className="text-sm text-slate-500">Nothing written yet.</p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
};

export default HelpCentre;
