import React, { useState, useEffect, useContext, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  MessagesSquare,
  ShieldCheck,
  AlertTriangle,
  Check,
  CalendarClock,
  Lock,
} from 'lucide-react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';
import SurveyAuthorPanel from '../components/feedback/SurveyAuthorPanel';

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

/**
 * Feedback portal.
 *
 * Everyone signed in can answer the surveys addressed to them. Teachers and
 * admins additionally get the authoring panel below the list — a teacher is
 * also a respondent for staff surveys, so the two are not mutually exclusive
 * the way the other portals in this app are.
 */
const CourseFeedback = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAuthor = role === 'teacher' || role === 'admin';

  const [surveys, setSurveys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [answering, setAnswering] = useState(null);
  const [answers, setAnswers] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/feedback/surveys');
      setSurveys(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the surveys.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openSurvey = (survey) => {
    setAnswering(survey);
    setAnswers({});
    setError('');
    setNotice('');
  };

  const setAnswer = (questionId, value) => {
    setAnswers((current) => ({ ...current, [questionId]: value }));
  };

  const toggleMulti = (questionId, option) => {
    setAnswers((current) => {
      const picked = current[questionId] || [];
      return {
        ...current,
        [questionId]: picked.includes(option)
          ? picked.filter((item) => item !== option)
          : [...picked, option],
      };
    });
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!answering) return;
    setBusy(true);
    setError('');
    setNotice('');

    const payload = Object.entries(answers)
      .filter(([, value]) => value !== undefined && value !== '' && value !== null)
      .map(([question, value]) => ({ question, value }));

    try {
      const res = await api.post(`/feedback/surveys/${answering._id}/responses`, {
        answers: payload,
      });
      setNotice(res.data.message);
      setAnswering(null);
      setAnswers({});
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not record your response.');
    } finally {
      setBusy(false);
    }
  };

  const renderQuestion = (question) => {
    const value = answers[question._id];

    if (question.type === 'rating' || question.type === 'scale') {
      const max = question.type === 'rating' ? 5 : 10;
      return (
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: max }, (_, index) => index + 1).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setAnswer(question._id, n)}
              className={`w-10 h-10 rounded-lg text-sm font-medium border transition ${
                value === n
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-gray-600 border-gray-300 hover:border-indigo-400'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      );
    }

    if (question.type === 'yes-no') {
      return (
        <div className="flex gap-2">
          {['yes', 'no'].map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setAnswer(question._id, option)}
              className={`px-4 py-2 rounded-lg text-sm font-medium border transition ${
                value === option
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-gray-600 border-gray-300 hover:border-indigo-400'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      );
    }

    if (question.type === 'single-choice') {
      return (
        <div className="space-y-2">
          {question.options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setAnswer(question._id, option)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm border transition ${
                value === option
                  ? 'bg-indigo-50 text-indigo-800 border-indigo-400'
                  : 'bg-white text-gray-600 border-gray-300 hover:border-indigo-300'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      );
    }

    if (question.type === 'multi-choice') {
      const picked = value || [];
      return (
        <div className="space-y-2">
          {question.options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => toggleMulti(question._id, option)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm border transition ${
                picked.includes(option)
                  ? 'bg-indigo-50 text-indigo-800 border-indigo-400'
                  : 'bg-white text-gray-600 border-gray-300 hover:border-indigo-300'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      );
    }

    return (
      <textarea
        rows={4}
        maxLength={2000}
        value={value || ''}
        onChange={(e) => setAnswer(question._id, e.target.value)}
        className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400"
      />
    );
  };

  return (
    <div
      className="min-h-screen p-4 sm:p-6"
      style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
    >
      {/* Header */}
      <div className="bg-gradient-to-r from-indigo-700 to-blue-700 text-white rounded-3xl p-8 shadow-2xl mb-8">
        <Link to="/academics" className="inline-flex items-center gap-2 text-indigo-100 hover:text-white text-sm">
          <ArrowLeft size={16} /> Academics
        </Link>

        <div className="flex items-center gap-4 mt-4">
          <div className="bg-white text-indigo-700 p-4 rounded-full shadow-lg">
            <MessagesSquare size={28} />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Feedback</h1>
            <p className="text-indigo-100 mt-1">Tell us honestly — we cannot see who said what</p>
          </div>
        </div>

        {/* What is and is not recorded, stated plainly. The paper version of
            this failed because nobody believed the anonymity claim. */}
        <div className="bg-white/15 rounded-2xl p-5 mt-6 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <ShieldCheck size={16} /> How anonymity works here
          </div>
          <ul className="mt-2 space-y-1 text-indigo-50 text-xs leading-relaxed">
            <li>
              Your answers are stored with a one-way code, not your name or your account id.
            </li>
            <li>
              The code is different for every survey, so your answers cannot be joined up across
              surveys.
            </li>
            <li>
              It exists only so you cannot answer twice — nobody, including the teacher, can turn it
              back into you.
            </li>
            <li>
              Results stay sealed until enough people answer that no single response stands out.
            </li>
          </ul>
        </div>
      </div>

      <div className="max-w-4xl mx-auto space-y-5">
        {error && (
          <div className="flex items-start gap-3 bg-red-50 border border-red-200 text-red-700 rounded-xl p-4">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <span className="text-sm">{error}</span>
          </div>
        )}

        {notice && (
          <div className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl p-4">
            <Check size={18} className="mt-0.5 shrink-0" />
            <span className="text-sm">{notice}</span>
          </div>
        )}

        {loading && <div className="text-center py-12 text-gray-500">Loading…</div>}

        {!loading && surveys.length === 0 && (
          <div className="bg-white rounded-2xl shadow p-12 text-center text-gray-400 text-sm">
            No surveys are open for you at the moment.
          </div>
        )}

        {surveys.map((survey) => (
          <div key={survey._id} className="bg-white rounded-2xl shadow p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold text-gray-800">{survey.title}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {survey.courseName || survey.type}
                  {survey.teacherName ? ` · ${survey.teacherName}` : ''} ·{' '}
                  {survey.questions.length} question(s)
                </div>
              </div>
              {survey.anonymous && (
                <span className="inline-flex items-center gap-1 bg-indigo-50 text-indigo-700 text-xs font-medium px-2.5 py-1 rounded-full whitespace-nowrap">
                  <Lock size={11} /> anonymous
                </span>
              )}
            </div>

            {survey.description && (
              <p className="text-sm text-gray-600 mt-3">{survey.description}</p>
            )}

            <div className="flex items-center gap-1.5 text-xs text-gray-500 mt-3">
              <CalendarClock size={13} /> Closes {formatDate(survey.closesAt)}
            </div>

            <div className="mt-4">
              {survey.alreadySubmitted ? (
                <div className="text-center text-xs font-medium py-2 rounded-lg bg-emerald-50 text-emerald-700">
                  You have answered this
                </div>
              ) : (
                <button
                  onClick={() => openSurvey(survey)}
                  className="bg-indigo-700 hover:bg-indigo-800 text-white text-sm px-5 py-2 rounded-lg transition"
                >
                  Answer
                </button>
              )}
            </div>
          </div>
        ))}

        {isAuthor && <SurveyAuthorPanel />}
      </div>

      {/* Survey form */}
      {answering && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50 overflow-y-auto">
          <form
            onSubmit={submit}
            className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-2xl space-y-5 my-8"
          >
            <div>
              <h3 className="font-semibold text-lg text-gray-800">{answering.title}</h3>
              {answering.anonymous && (
                <p className="text-xs text-indigo-700 mt-1 inline-flex items-center gap-1">
                  <Lock size={11} /> Your name is not stored with these answers.
                </p>
              )}
            </div>

            {answering.questions.map((question, index) => (
              <div key={question._id}>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {index + 1}. {question.prompt}
                  {question.required && <span className="text-rose-600"> *</span>}
                </label>
                {renderQuestion(question)}
              </div>
            ))}

            <div className="flex gap-2 pt-2">
              <button
                type="submit"
                disabled={busy}
                className="flex-1 bg-indigo-700 hover:bg-indigo-800 disabled:opacity-50 text-white text-sm py-2.5 rounded-lg transition"
              >
                {busy ? 'Submitting…' : 'Submit'}
              </button>
              <button
                type="button"
                onClick={() => setAnswering(null)}
                className="px-5 text-sm text-gray-600 hover:text-gray-800"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

export default CourseFeedback;
