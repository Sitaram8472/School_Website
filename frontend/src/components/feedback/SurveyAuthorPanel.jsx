import React, { useState, useEffect, useCallback } from 'react';
import {
  Plus,
  Trash2,
  Lock,
  Unlock,
  BarChart3,
  RefreshCw,
  AlertTriangle,
  Check,
  X,
} from 'lucide-react';
import api from '../../utils/axios';

const QUESTION_TYPES = ['rating', 'scale', 'single-choice', 'multi-choice', 'text', 'yes-no'];
const AUDIENCES = ['students', 'parents', 'teachers', 'all'];
const SURVEY_TYPES = ['course', 'teaching', 'facility', 'general'];

const today = () => new Date().toISOString().slice(0, 10);
const inTwoWeeks = () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const emptyQuestion = () => ({
  prompt: '',
  type: 'rating',
  options: [],
  required: false,
});

const emptySurvey = () => ({
  title: '',
  description: '',
  type: 'course',
  courseName: '',
  audience: 'students',
  opensAt: today(),
  closesAt: inTwoWeeks(),
  anonymous: true,
  minResponsesToRelease: 5,
  questions: [emptyQuestion()],
});

/**
 * Survey authoring and results.
 *
 * The results view is where the suppression rule becomes visible: below the
 * release threshold this shows a count and a plain explanation, never the
 * responses — including to the person who wrote the survey.
 */
const SurveyAuthorPanel = () => {
  const [tab, setTab] = useState('mine');

  const [surveys, setSurveys] = useState([]);
  const [stats, setStats] = useState(null);
  const [results, setResults] = useState(null);
  const [viewing, setViewing] = useState(null);

  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState(emptySurvey());

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [surveysRes, statsRes] = await Promise.all([
        api.get('/feedback/surveys/mine'),
        api.get('/feedback/stats'),
      ]);
      setSurveys(surveysRes.data.data || []);
      setStats(statsRes.data.stats);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load your surveys.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = async (event) => {
    event.preventDefault();
    setBusyId('create');
    setError('');
    setNotice('');
    try {
      const res = await api.post('/feedback/surveys', {
        ...form,
        minResponsesToRelease: Number(form.minResponsesToRelease),
        questions: form.questions.map((question, index) => ({
          ...question,
          order: index,
          options: ['single-choice', 'multi-choice'].includes(question.type)
            ? question.options.filter(Boolean)
            : [],
        })),
      });
      setNotice(res.data.message);
      setForm(emptySurvey());
      setTab('mine');
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not create the survey.');
    } finally {
      setBusyId(null);
    }
  };

  const act = async (survey, path, successFallback) => {
    setBusyId(survey._id);
    setError('');
    setNotice('');
    try {
      const res = await api.patch(`/feedback/surveys/${survey._id}/${path}`);
      setNotice(res.data.message || successFallback);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'That did not work.');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (survey) => {
    setBusyId(survey._id);
    setError('');
    try {
      await api.delete(`/feedback/surveys/${survey._id}`);
      setNotice('Survey deleted.');
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not delete the survey.');
    } finally {
      setBusyId(null);
    }
  };

  const openResults = async (survey) => {
    setBusyId(survey._id);
    setError('');
    setNotice('');
    try {
      const res = await api.get(`/feedback/surveys/${survey._id}/results`);
      setResults(res.data);
      setViewing(survey);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the results.');
    } finally {
      setBusyId(null);
    }
  };

  const updateQuestion = (index, patch) => {
    setForm((current) => ({
      ...current,
      questions: current.questions.map((question, i) =>
        i === index ? { ...question, ...patch } : question
      ),
    }));
  };

  const addQuestion = () => {
    setForm((current) => ({ ...current, questions: [...current.questions, emptyQuestion()] }));
  };

  const removeQuestion = (index) => {
    setForm((current) => ({
      ...current,
      questions: current.questions.filter((_, i) => i !== index),
    }));
  };

  const tabs = [
    { id: 'mine', label: 'My surveys' },
    { id: 'new', label: 'New survey' },
    { id: 'stats', label: 'Stats' },
  ];

  return (
    <div className="bg-white rounded-2xl shadow-lg p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-800">Survey authoring</h2>
          <p className="text-sm text-gray-500">Collect feedback and read it in aggregate</p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="flex gap-2 mb-6 bg-gray-100 rounded-xl p-1">
        {tabs.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition ${
              tab === item.id ? 'bg-indigo-700 text-white shadow' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-start gap-3 bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 mb-5">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      {notice && (
        <div className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl p-4 mb-5">
          <Check size={18} className="mt-0.5 shrink-0" />
          <span className="text-sm">{notice}</span>
        </div>
      )}

      {/* ---- My surveys ---- */}
      {tab === 'mine' && (
        <div className="space-y-3">
          {surveys.length === 0 && <p className="text-sm text-gray-400 py-6">No surveys yet.</p>}

          {surveys.map((survey) => (
            <div key={survey._id} className="border border-gray-200 rounded-2xl p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium text-gray-800">{survey.title}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {survey.courseName || survey.type} · {survey.audience} ·{' '}
                    {survey.questions.length} question(s)
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      survey.status === 'open'
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {survey.status}
                  </span>
                  {survey.anonymous && (
                    <span className="inline-flex items-center gap-1 text-xs text-indigo-700">
                      <Lock size={10} /> anonymous
                    </span>
                  )}
                </div>
              </div>

              {/* The seal state is shown on the card, so nobody has to click
                  into a survey to find out the results are not available yet. */}
              <div className="flex items-center gap-2 mt-3 text-xs">
                {survey.responseCount >= survey.minResponsesToRelease ? (
                  <span className="inline-flex items-center gap-1 text-emerald-700">
                    <Unlock size={12} /> {survey.responseCount} responses — results available
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-amber-700">
                    <Lock size={12} /> {survey.responseCount} of {survey.minResponsesToRelease}{' '}
                    responses — sealed
                  </span>
                )}
              </div>

              <div className="flex items-center gap-4 mt-3 pt-3 border-t border-gray-50">
                {survey.status === 'draft' && (
                  <button
                    onClick={() => act(survey, 'publish', 'Published.')}
                    disabled={busyId === survey._id}
                    className="text-xs text-emerald-600 hover:text-emerald-700 disabled:opacity-50"
                  >
                    Publish
                  </button>
                )}
                {survey.status === 'open' && (
                  <button
                    onClick={() => act(survey, 'close', 'Closed.')}
                    disabled={busyId === survey._id}
                    className="text-xs text-amber-600 hover:text-amber-700 disabled:opacity-50"
                  >
                    Close
                  </button>
                )}
                {survey.status !== 'draft' && (
                  <button
                    onClick={() => openResults(survey)}
                    disabled={busyId === survey._id}
                    className="inline-flex items-center gap-1.5 text-xs text-indigo-700 hover:text-indigo-800 disabled:opacity-50"
                  >
                    <BarChart3 size={12} /> Results
                  </button>
                )}
                {survey.responseCount === 0 && (
                  <button
                    onClick={() => remove(survey)}
                    disabled={busyId === survey._id}
                    className="inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-700 disabled:opacity-50 ml-auto"
                  >
                    <Trash2 size={12} /> Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---- New survey ---- */}
      {tab === 'new' && (
        <form onSubmit={create} className="max-w-2xl space-y-4">
          <input
            required
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="Survey title"
            className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <textarea
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="What is this for?"
            className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <select
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            >
              {SURVEY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <select
              value={form.audience}
              onChange={(e) => setForm({ ...form, audience: e.target.value })}
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            >
              {AUDIENCES.map((audience) => (
                <option key={audience} value={audience}>
                  {audience}
                </option>
              ))}
            </select>
            <input
              type="date"
              required
              value={form.opensAt}
              onChange={(e) => setForm({ ...form, opensAt: e.target.value })}
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
            <input
              type="date"
              required
              value={form.closesAt}
              onChange={(e) => setForm({ ...form, closesAt: e.target.value })}
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </div>

          <input
            value={form.courseName}
            onChange={(e) => setForm({ ...form, courseName: e.target.value })}
            placeholder="Course or subject (optional)"
            className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />

          <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4 space-y-3">
            <label className="flex items-center gap-2 text-sm text-indigo-900">
              <input
                type="checkbox"
                checked={form.anonymous}
                onChange={(e) => setForm({ ...form, anonymous: e.target.checked })}
              />
              Anonymous — responses are stored with a one-way code, not a name
            </label>
            <label className="block text-sm text-indigo-900">
              <span className="text-xs">
                Seal results until this many people have answered
              </span>
              <input
                type="number"
                min="2"
                max="100"
                value={form.minResponsesToRelease}
                onChange={(e) => setForm({ ...form, minResponsesToRelease: e.target.value })}
                className="w-24 mt-1 block text-sm border border-indigo-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
              <span className="text-xs text-indigo-700 mt-1 block">
                This applies to you too. With two or three responses an individual answer is
                identifiable, and knowing the class is enough to do it.
              </span>
            </label>
          </div>

          <div className="space-y-3">
            {form.questions.map((question, index) => (
              <div key={index} className="border border-gray-200 rounded-xl p-4 space-y-2">
                <div className="flex items-start gap-2">
                  <input
                    required
                    value={question.prompt}
                    onChange={(e) => updateQuestion(index, { prompt: e.target.value })}
                    placeholder={`Question ${index + 1}`}
                    className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  />
                  {form.questions.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeQuestion(index)}
                      className="text-gray-400 hover:text-red-600 p-2"
                      aria-label="Remove question"
                    >
                      <X size={15} />
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <select
                    value={question.type}
                    onChange={(e) => updateQuestion(index, { type: e.target.value })}
                    className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  >
                    {QUESTION_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-2 text-xs text-gray-600">
                    <input
                      type="checkbox"
                      checked={question.required}
                      onChange={(e) => updateQuestion(index, { required: e.target.checked })}
                    />
                    Required
                  </label>
                </div>

                {['single-choice', 'multi-choice'].includes(question.type) && (
                  <input
                    value={question.options.join(', ')}
                    onChange={(e) =>
                      updateQuestion(index, {
                        options: e.target.value.split(',').map((option) => option.trim()),
                      })
                    }
                    placeholder="Options, comma separated — at least two"
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  />
                )}
              </div>
            ))}

            <button
              type="button"
              onClick={addQuestion}
              className="inline-flex items-center gap-1.5 text-sm text-indigo-700 hover:text-indigo-800"
            >
              <Plus size={15} /> Add question
            </button>
          </div>

          <button
            type="submit"
            disabled={busyId === 'create'}
            className="bg-indigo-700 hover:bg-indigo-800 disabled:opacity-50 text-white text-sm px-6 py-2.5 rounded-lg transition"
          >
            {busyId === 'create' ? 'Saving…' : 'Save as draft'}
          </button>
        </form>
      )}

      {/* ---- Stats ---- */}
      {tab === 'stats' && stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: 'Surveys', value: stats.totalSurveys },
            { label: 'Open', value: stats.open },
            { label: 'Responses', value: stats.totalResponses },
            { label: 'Average per survey', value: stats.averageResponses },
            { label: 'Anonymous', value: stats.anonymous },
            { label: 'Results available', value: stats.released },
            { label: 'Still sealed', value: stats.sealed },
            { label: 'Drafts', value: stats.draft },
          ].map((card) => (
            <div key={card.label} className="border border-gray-200 rounded-2xl p-5">
              <div className="text-xs uppercase tracking-wide text-gray-400">{card.label}</div>
              <div className="text-2xl font-bold text-gray-800 mt-1">{card.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Results dialog */}
      {viewing && results && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-3xl space-y-5 my-8">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold text-lg text-gray-800">{viewing.title}</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  {results.released
                    ? `${results.results.responseCount} responses`
                    : 'Results sealed'}
                </p>
              </div>
              <button
                onClick={() => {
                  setViewing(null);
                  setResults(null);
                }}
                className="text-gray-400 hover:text-gray-600"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            {!results.released && (
              <div className="bg-amber-50 border border-amber-300 rounded-xl p-5">
                <div className="flex items-center gap-2 font-medium text-amber-900">
                  <Lock size={16} /> Sealed — {results.responseCount} of{' '}
                  {results.minResponsesToRelease} responses
                </div>
                <p className="text-sm text-amber-800 mt-2">{results.message}</p>
              </div>
            )}

            {results.released &&
              results.results.questions.map((question) => (
                <div key={question.questionId} className="border border-gray-200 rounded-xl p-5">
                  <div className="font-medium text-sm text-gray-800">{question.prompt}</div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {question.answered} answered · {question.skipped} skipped
                  </div>

                  {question.mean !== undefined && question.mean !== null && (
                    <div className="flex items-center gap-6 mt-3">
                      <div>
                        <div className="text-2xl font-bold text-indigo-700">{question.mean}</div>
                        <div className="text-xs text-gray-500">mean of {question.max}</div>
                      </div>
                      <div>
                        <div className="text-2xl font-bold text-gray-700">{question.median}</div>
                        <div className="text-xs text-gray-500">median</div>
                      </div>
                    </div>
                  )}

                  {question.distribution && (
                    <div className="space-y-1.5 mt-3">
                      {Object.entries(question.distribution).map(([label, count]) => (
                        <div key={label} className="flex items-center gap-3">
                          <span className="text-xs text-gray-600 w-28 shrink-0 truncate">
                            {label}
                          </span>
                          <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-indigo-600 rounded-full"
                              style={{
                                width: `${
                                  question.answered > 0
                                    ? Math.round((count / question.answered) * 100)
                                    : 0
                                }%`,
                              }}
                            />
                          </div>
                          <span className="text-xs text-gray-500 w-8 text-right">{count}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {question.responses && (
                    <div className="space-y-2 mt-3">
                      <p className="text-xs text-gray-400">
                        Shown in random order — the order they arrived in would say something about
                        who wrote them.
                      </p>
                      {question.responses.map((text, index) => (
                        <p key={index} className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3">
                          {text}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default SurveyAuthorPanel;
