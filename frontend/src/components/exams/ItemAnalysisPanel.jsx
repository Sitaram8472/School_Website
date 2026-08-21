import { useState, useEffect, useCallback } from 'react';
import { BarChart3, AlertTriangle, KeyRound, RefreshCw, StickyNote, History } from 'lucide-react';
import api from '../../utils/axios';

/**
 * Item analysis for one exam.
 *
 * Leads with the flagged items, not with the table — because a table is where
 * this normally goes wrong: forty rows of decimals that get scrolled past. A
 * suspected miskey is rendered as a sentence a person acts on, with the numbers
 * underneath for anyone who wants them.
 *
 * Facility is a bar with the useful band shaded, so "too easy" and "too hard"
 * are positions rather than adjectives.
 */

const FLAG_LABELS = {
  'too-easy': 'Almost everyone got it',
  'too-hard': 'Almost nobody got it',
  'non-discriminating': 'Separates nobody',
  'negative-discrimination': 'Works backwards',
  'suspected-miskey': 'Suspected wrong answer key',
  'dead-distractor': 'An option nobody picked',
  'ambiguous-distractor': 'A wrong option that attracts strong students',
};

const FLAG_STYLES = {
  'too-easy': 'bg-slate-100 text-slate-700',
  'too-hard': 'bg-orange-100 text-orange-800',
  'non-discriminating': 'bg-slate-100 text-slate-700',
  'negative-discrimination': 'bg-red-100 text-red-700',
  'suspected-miskey': 'bg-red-600 text-white',
  'dead-distractor': 'bg-amber-100 text-amber-800',
  'ambiguous-distractor': 'bg-purple-100 text-purple-700',
};

// The band a working question sits in. Mirrors the server's thresholds so the
// shading and the flags cannot disagree.
const USEFUL_LOW = 0.2;
const USEFUL_HIGH = 0.9;

const percent = (value) => `${Math.round((Number(value) || 0) * 100)}%`;

const formatDateTime = (value) =>
  value ? new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

const signed = (value) => {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  return `${number > 0 ? '+' : ''}${number.toFixed(2)}`;
};

const ItemAnalysisPanel = ({ examId }) => {
  const [analysis, setAnalysis] = useState(null);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [noteDrafts, setNoteDrafts] = useState({});

  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 4000);
  };

  const explain = (err, fallback) =>
    setError(err?.response?.data?.message || err?.message || fallback);

  const load = useCallback(async () => {
    if (!examId) return;

    setLoading(true);
    try {
      const [latestRes, historyRes] = await Promise.all([
        api.get(`/exams/${examId}/item-analysis`),
        api.get(`/exams/${examId}/item-analysis/history`),
      ]);
      setAnalysis(latestRes.data.data);
      setHistory(historyRes.data.data || []);
    } catch (err) {
      // A teacher looking at somebody else's exam gets a 403 here. That is not
      // an error worth shouting about on a page that otherwise works.
      if (err?.response?.status !== 403) {
        explain(err, 'Could not load the item analysis.');
      }
    } finally {
      setLoading(false);
    }
  }, [examId]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async () => {
    setRunning(true);
    setError('');

    try {
      const res = await api.post(`/exams/${examId}/item-analysis`, {});
      flash(res.data.message || 'Analysis complete.');
      await load();
    } catch (err) {
      explain(err, 'Could not run the analysis.');
    } finally {
      setRunning(false);
    }
  };

  const addNote = async (questionId) => {
    const text = (noteDrafts[questionId] || '').trim();
    if (!text) return;

    try {
      await api.post(`/exams/item-analysis/${analysis._id}/notes`, { questionId, text });
      flash('Note saved against the question.');
      setNoteDrafts({ ...noteDrafts, [questionId]: '' });
      await load();
    } catch (err) {
      explain(err, 'Could not save the note.');
    }
  };

  const notesFor = (questionId) =>
    (analysis?.notes || []).filter((note) => String(note.questionId) === String(questionId));

  const flagged = (analysis?.items || []).filter((item) => item.flags.includes('suspected-miskey'));

  // ---- rendering -----------------------------------------------------------

  const facilityBar = (value) => (
    <div className="relative h-2 w-full bg-slate-100 rounded-full overflow-hidden">
      {/* The band a question is worth keeping in. */}
      <div
        className="absolute inset-y-0 bg-green-100"
        style={{ left: `${USEFUL_LOW * 100}%`, width: `${(USEFUL_HIGH - USEFUL_LOW) * 100}%` }}
      />
      <div
        className="absolute inset-y-0 w-1 bg-slate-800 rounded"
        style={{ left: `calc(${Math.min(1, Math.max(0, value)) * 100}% - 2px)` }}
      />
    </div>
  );

  return (
    <div className="bg-white rounded-2xl shadow-xl border border-gray-100 mt-8 overflow-hidden">
      <div className="bg-gradient-to-r from-slate-800 to-slate-700 p-6 text-white">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold flex items-center gap-2">
              <BarChart3 size={20} /> How the paper performed
            </h2>
            <p className="text-slate-300 text-sm mt-1">
              The score column says how the students did. This says how the questions did.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {history.length > 1 && (
              <button
                type="button"
                onClick={() => setShowHistory(!showHistory)}
                className="px-3 py-2 rounded-lg text-sm font-medium bg-white/10 hover:bg-white/20 inline-flex items-center gap-1"
              >
                <History size={15} /> {history.length} runs
              </button>
            )}
            <button
              type="button"
              onClick={run}
              disabled={running}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-white text-slate-800 hover:bg-slate-100 disabled:opacity-60 inline-flex items-center gap-2"
            >
              <RefreshCw size={15} className={running ? 'animate-spin' : ''} />
              {analysis ? 'Run again' : 'Run analysis'}
            </button>
          </div>
        </div>
      </div>

      <div className="p-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-3 mb-4 text-sm flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {success && (
          <div className="bg-green-50 border border-green-200 text-green-700 rounded-xl p-3 mb-4 text-sm">
            {success}
          </div>
        )}

        {showHistory && history.length > 0 && (
          <div className="border border-slate-100 rounded-xl p-4 mb-5">
            <h3 className="text-sm font-semibold text-slate-800 mb-2">Previous runs</h3>
            <div className="space-y-1">
              {history.map((entry) => (
                <div key={entry._id} className="text-xs text-slate-600 flex flex-wrap gap-2">
                  <span>{formatDateTime(entry.analysedAt)}</span>
                  <span className="text-slate-400">·</span>
                  <span>{entry.cohortSize} submissions</span>
                  {entry.meanPercent !== undefined && (
                    <>
                      <span className="text-slate-400">·</span>
                      <span>mean {entry.meanPercent}%</span>
                    </>
                  )}
                  {!entry.isCurrent && (
                    <span className="px-2 rounded-full bg-amber-100 text-amber-800 font-semibold">
                      older version of the paper
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {loading && !analysis && <p className="text-sm text-slate-500">Loading…</p>}

        {!loading && !analysis && (
          <p className="text-sm text-slate-500">
            No analysis has been run for this exam yet. Running one reads the submissions already
            stored and writes a snapshot; it changes nothing about anyone&rsquo;s marks.
          </p>
        )}

        {analysis && !analysis.isCurrent && (
          <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-3 mb-5 text-sm">
            <strong>These figures describe an older version of the paper.</strong>{' '}
            {analysis.staleReason || 'The exam has been edited since this analysis was run.'} Run it
            again to see the current one.
          </div>
        )}

        {analysis?.suppressed && (
          <div className="bg-slate-50 border border-slate-200 text-slate-700 rounded-xl p-4 text-sm">
            {analysis.suppressionReason}
          </div>
        )}

        {analysis && !analysis.suppressed && (
          <>
            {/* ---- what to act on ---- */}
            {flagged.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6">
                <h3 className="text-sm font-bold text-red-800 flex items-center gap-2 mb-2">
                  <KeyRound size={16} /> Check the answer key
                </h3>
                {flagged.map((item) => (
                  <p key={String(item.questionId)} className="text-sm text-red-900 mb-2">
                    The strongest students got{' '}
                    <span className="font-semibold">
                      &ldquo;{item.questionText || 'this question'}&rdquo;
                    </span>{' '}
                    wrong more often than the weakest did. That usually means the stored answer is
                    the wrong one.
                    <span className="block text-xs text-red-700 mt-0.5 font-mono">
                      {percent(item.facility)} correct · discrimination {signed(item.discrimination)}
                    </span>
                  </p>
                ))}
              </div>
            )}

            {/* ---- the paper as a whole ---- */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
              {[
                { label: 'Submissions', value: analysis.cohortSize },
                { label: 'Mean', value: `${analysis.meanPercent}%` },
                { label: 'Median', value: `${analysis.medianPercent}%` },
                { label: 'Spread (SD)', value: analysis.standardDeviation },
                {
                  label: 'Reliability (KR-20)',
                  value:
                    analysis.reliabilityKr20 === null || analysis.reliabilityKr20 === undefined
                      ? 'n/a'
                      : analysis.reliabilityKr20.toFixed(2),
                },
              ].map((tile) => (
                <div key={tile.label} className="bg-slate-50 rounded-xl p-3">
                  <div className="text-lg font-bold text-slate-800">{tile.value}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{tile.label}</div>
                </div>
              ))}
            </div>

            <p className="text-xs text-slate-500 mb-5">
              Groups of {analysis.upperGroupSize} at each end, run {formatDateTime(analysis.analysedAt)}
              {analysis.analysedBy?.name ? ` by ${analysis.analysedBy.name}` : ''}.
            </p>

            {/* ---- question by question ---- */}
            <div className="space-y-3">
              {analysis.items.map((item, index) => {
                const notes = notesFor(item.questionId);

                return (
                  <div
                    key={String(item.questionId)}
                    className={`border rounded-xl p-4 ${
                      item.flags.includes('suspected-miskey')
                        ? 'border-red-300 bg-red-50/40'
                        : 'border-slate-100'
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-800">
                          Q{index + 1}. {item.questionText || '(no wording stored)'}
                        </div>
                        <div className="text-xs text-slate-500 mt-1">
                          {item.type} · {item.points} point{item.points === 1 ? '' : 's'} ·{' '}
                          {item.correct} of {item.attempted} attempts correct
                          {item.attempted < analysis.cohortSize && (
                            <span> · {analysis.cohortSize - item.attempted} left it blank</span>
                          )}
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <div className="text-xs text-slate-500">discrimination</div>
                        <div
                          className={`font-mono font-bold ${
                            item.discrimination < 0 ? 'text-red-600' : 'text-slate-800'
                          }`}
                        >
                          {signed(item.discrimination)}
                        </div>
                        {item.pointBiserial !== null && (
                          <div className="text-[11px] text-slate-400 font-mono">
                            r<sub>pb</sub> {signed(item.pointBiserial)}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 flex items-center gap-3">
                      <span className="text-xs text-slate-500 w-20 shrink-0">
                        {percent(item.facility)} correct
                      </span>
                      {facilityBar(item.facility)}
                    </div>

                    {item.flags.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {item.flags.map((flag) => (
                          <span
                            key={flag}
                            className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                              FLAG_STYLES[flag] || 'bg-slate-100 text-slate-700'
                            }`}
                          >
                            {FLAG_LABELS[flag] || flag}
                          </span>
                        ))}
                      </div>
                    )}

                    {item.distractors.length > 0 && (
                      <div className="mt-3">
                        <div className="text-xs font-semibold text-slate-600 mb-1">
                          Options — who picked what
                        </div>
                        <div className="space-y-1">
                          {item.distractors.map((option) => (
                            <div
                              key={option.option}
                              className="flex items-center gap-2 text-xs text-slate-600"
                            >
                              <span
                                className={`w-40 truncate ${
                                  option.isKey ? 'font-bold text-slate-800' : ''
                                }`}
                              >
                                {option.option}
                                {option.isKey && ' ✓'}
                              </span>
                              <span className="font-mono">{option.chosenBy}</span>
                              <span className="text-slate-400">
                                (top {option.chosenByUpperGroup} · bottom {option.chosenByLowerGroup})
                              </span>
                              {!option.isKey && option.chosenBy === 0 && (
                                <span className="text-amber-700">nobody</span>
                              )}
                              {!option.isKey &&
                                option.chosenByUpperGroup > option.chosenByLowerGroup && (
                                  <span className="text-purple-700">
                                    pulls the strong students
                                  </span>
                                )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {notes.length > 0 && (
                      <div className="mt-3 space-y-1">
                        {notes.map((note, noteIndex) => (
                          <div key={noteIndex} className="text-xs text-slate-600 flex gap-1">
                            <StickyNote size={12} className="mt-0.5 shrink-0 text-slate-400" />
                            <span>
                              {note.text}
                              <span className="text-slate-400">
                                {' '}
                                — {note.addedByName || 'staff'}
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="mt-3 flex gap-2">
                      <input
                        value={noteDrafts[item.questionId] || ''}
                        onChange={(event) =>
                          setNoteDrafts({ ...noteDrafts, [item.questionId]: event.target.value })
                        }
                        placeholder="What you decided to do about this question"
                        className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => addNote(item.questionId)}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700"
                      >
                        Note it
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default ItemAnalysisPanel;
