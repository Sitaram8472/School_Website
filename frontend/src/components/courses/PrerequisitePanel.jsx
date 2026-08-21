import { useState, useEffect, useCallback, useContext } from 'react';
import { GitBranch, AlertTriangle, CheckCircle2, Lock, Unlock, CornerDownRight } from 'lucide-react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * Course prerequisites.
 *
 * Two audiences, one panel. A student sees what they still need and the
 * evidence for each verdict, because "not eligible" without a reason is the
 * thing that generates an email to the office. A curriculum lead sees the
 * chain — both what a course depends on and what depends on it — before
 * changing anything.
 *
 * The circular-prerequisite error renders the path the server returns, in
 * order. "Cycle detected" on its own is an error somebody files a ticket
 * about; "Physics III → Physics II → Physics I → Physics III" is one they fix.
 */

const KIND_LABELS = {
  completion: 'Must have taken it',
  'minimum-score': 'Must have scored',
  concurrent: 'May be taken alongside',
};

const KIND_STYLES = {
  completion: 'bg-blue-100 text-blue-700',
  'minimum-score': 'bg-purple-100 text-purple-700',
  concurrent: 'bg-teal-100 text-teal-700',
};

const EMPTY_RULE = {
  course: '',
  requires: '',
  kind: 'completion',
  minimumPercent: 50,
  isMandatory: true,
  rationale: '',
};

const describeRule = (rule) =>
  rule.kind === 'minimum-score'
    ? `${KIND_LABELS[rule.kind]} at least ${rule.minimumPercent}%`
    : KIND_LABELS[rule.kind] || rule.kind;

const PrerequisitePanel = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);

  const isTeachingStaff = role === 'teacher' || role === 'admin';
  const isAdmin = role === 'admin';

  const [tab, setTab] = useState('mine');

  const [eligibility, setEligibility] = useState([]);
  const [courses, setCourses] = useState([]);
  const [rules, setRules] = useState([]);
  const [waivers, setWaivers] = useState([]);

  const [chainFor, setChainFor] = useState('');
  const [chain, setChain] = useState(null);

  const [ruleForm, setRuleForm] = useState(EMPTY_RULE);
  const [cyclePath, setCyclePath] = useState([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 3500);
  };

  const explain = (err, fallback) =>
    setError(err?.response?.data?.message || err?.message || fallback);

  // ---- loading -------------------------------------------------------------

  const loadMine = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/courses/prerequisites/mine');
      setEligibility(res.data.data || []);
    } catch (err) {
      explain(err, 'Could not work out what you still need.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadGraph = useCallback(async () => {
    if (!isTeachingStaff) return;

    try {
      const [coursesRes, rulesRes] = await Promise.all([
        api.get('/courses'),
        api.get('/courses/prerequisites'),
      ]);
      setCourses(coursesRes.data.data || []);
      setRules(rulesRes.data.data || []);
    } catch (err) {
      explain(err, 'Could not load the prerequisite graph.');
    }
  }, [isTeachingStaff]);

  const loadWaivers = useCallback(async () => {
    if (!isTeachingStaff) return;

    try {
      const res = await api.get('/courses/prerequisites/waivers');
      setWaivers(res.data.data || []);
    } catch (err) {
      explain(err, 'Could not load waivers.');
    }
  }, [isTeachingStaff]);

  useEffect(() => {
    if (!user) return;
    loadMine();
    loadGraph();
    loadWaivers();
  }, [user, loadMine, loadGraph, loadWaivers]);

  // ---- the chain -----------------------------------------------------------

  const showChain = async (courseId) => {
    setChainFor(courseId);
    setChain(null);
    setError('');

    if (!courseId) return;

    try {
      const res = await api.get(`/courses/prerequisites/${courseId}/chain`);
      setChain(res.data.data);
    } catch (err) {
      explain(err, 'Could not build the chain.');
    }
  };

  // ---- writing rules -------------------------------------------------------

  const submitRule = async (event) => {
    event.preventDefault();
    setError('');
    setCyclePath([]);

    if (!ruleForm.course || !ruleForm.requires) {
      setError('Pick both courses.');
      return;
    }
    if (ruleForm.course === ruleForm.requires) {
      setError('A course cannot be a prerequisite of itself.');
      return;
    }

    setLoading(true);
    try {
      const res = await api.post('/courses/prerequisites', ruleForm);
      flash(res.data.message || 'Prerequisite added.');
      setRuleForm(EMPTY_RULE);
      await loadGraph();
      if (chainFor) await showChain(chainFor);
    } catch (err) {
      // The server hands back the offending path when it refuses a cycle.
      // Rendering it is the whole difference between a fixable error and a
      // mystery.
      const path = err?.response?.data?.data?.path;
      if (Array.isArray(path)) setCyclePath(path);
      explain(err, 'Could not add the prerequisite.');
    } finally {
      setLoading(false);
    }
  };

  const retireRule = async (rule) => {
    setError('');
    try {
      await api.patch(`/courses/prerequisites/${rule._id}/retire`, {});
      flash('Prerequisite retired.');
      await loadGraph();
    } catch (err) {
      explain(err, 'Could not retire the prerequisite.');
    }
  };

  const revokeWaiver = async (waiver) => {
    const reason = window.prompt('Why is this waiver being revoked?');
    if (!reason || !reason.trim()) return;

    try {
      await api.patch(`/courses/prerequisites/waivers/${waiver._id}/revoke`, {
        reason: reason.trim(),
      });
      flash('Waiver revoked.');
      await loadWaivers();
    } catch (err) {
      explain(err, 'Could not revoke the waiver.');
    }
  };

  // Academics is a public page; there is nothing here for a visitor who is not
  // signed in, and a login prompt in the middle of a prospectus page is worse
  // than nothing at all.
  if (!user) return null;

  // ---- rendering -----------------------------------------------------------

  const tabs = isTeachingStaff
    ? [
        { key: 'mine', label: 'What I still need' },
        { key: 'graph', label: 'Prerequisite graph' },
        { key: 'waivers', label: 'Waivers' },
      ]
    : [{ key: 'mine', label: 'What I still need' }];

  const evidenceLine = (entry) =>
    entry.evidence ? (
      <span className="text-gray-500">{entry.evidence.detail}</span>
    ) : (
      <span className="text-gray-400 italic">no result on record</span>
    );

  return (
    <div className="max-w-4xl mx-auto bg-white rounded-2xl shadow-sm border border-gray-100 p-6 my-12">
      <div className="flex items-center gap-2 mb-1">
        <GitBranch size={20} className="text-blue-600" />
        <h2 className="text-lg font-bold text-gray-800">Course prerequisites</h2>
      </div>
      <p className="text-sm text-gray-500 mb-5">
        What has to come first, and what each verdict is based on.
      </p>

      {tabs.length > 1 && (
        <div className="flex gap-2 mb-5 border-b border-gray-100">
          {tabs.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setTab(entry.key)}
              className={`px-3 py-2 text-sm font-medium -mb-px border-b-2 transition ${
                tab === entry.key
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-100 text-red-700 rounded-xl p-3 mb-4 text-sm">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
          {cyclePath.length > 0 && (
            <div className="mt-2 pl-6 font-mono text-xs text-red-800">
              {cyclePath.join('  →  ')}
            </div>
          )}
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-100 text-green-700 rounded-xl p-3 mb-4 text-sm flex items-center gap-2">
          <CheckCircle2 size={16} />
          {success}
        </div>
      )}

      {/* ---- what the caller still needs ---- */}
      {tab === 'mine' && (
        <>
          {loading && eligibility.length === 0 && (
            <p className="text-sm text-gray-500">Working it out…</p>
          )}

          {!loading && eligibility.length === 0 && (
            <p className="text-sm text-gray-500">
              No course has prerequisites yet, so nothing is gated.
            </p>
          )}

          <div className="space-y-3">
            {eligibility.map((row) => (
              <div
                key={row.course._id}
                className={`border rounded-xl p-4 ${
                  row.eligible ? 'border-gray-100' : 'border-amber-200 bg-amber-50/40'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="font-semibold text-gray-800">{row.course.name}</div>
                  {row.eligible ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-700">
                      <Unlock size={12} /> Eligible
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
                      <Lock size={12} /> {row.unmet.length} still needed
                    </span>
                  )}
                </div>

                {row.unmet.length > 0 && (
                  <ul className="mt-3 space-y-1.5">
                    {row.unmet.map((entry) => (
                      <li key={entry.rule} className="text-sm flex flex-wrap gap-x-2">
                        <span className="text-gray-800 font-medium">{entry.requiresName}</span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                            KIND_STYLES[entry.kind] || 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {describeRule(entry)}
                        </span>
                        {evidenceLine(entry)}
                      </li>
                    ))}
                  </ul>
                )}

                {row.warnings.length > 0 && (
                  <p className="mt-2 text-xs text-gray-500">
                    Recommended first: {row.warnings.map((entry) => entry.requiresName).join(', ')}
                  </p>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* ---- the graph ---- */}
      {tab === 'graph' && isTeachingStaff && (
        <>
          <div className="mb-5">
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Show the chain for
            </label>
            <select
              value={chainFor}
              onChange={(event) => showChain(event.target.value)}
              className="w-full md:w-80 border border-gray-200 rounded-lg px-3 py-2 text-sm"
            >
              <option value="">Pick a course…</option>
              {courses.map((course) => (
                <option key={course._id} value={course._id}>
                  {course.name}
                </option>
              ))}
            </select>
          </div>

          {chain && (
            <div className="grid md:grid-cols-2 gap-4 mb-6">
              <div className="border border-gray-100 rounded-xl p-4">
                <h3 className="text-sm font-semibold text-gray-800 mb-2">
                  {chain.course.name} depends on
                </h3>
                {chain.requires.length === 0 ? (
                  <p className="text-xs text-gray-500">Nothing — it can be taken first.</p>
                ) : (
                  chain.requires.map((entry) => (
                    <div
                      key={`${entry.course}-${entry.depth}`}
                      className="text-sm text-gray-700 flex items-center gap-1"
                      style={{ paddingLeft: `${(entry.depth - 1) * 16}px` }}
                    >
                      {entry.depth > 1 && <CornerDownRight size={13} className="text-gray-400" />}
                      {entry.name}
                    </div>
                  ))
                )}
              </div>

              <div className="border border-gray-100 rounded-xl p-4">
                <h3 className="text-sm font-semibold text-gray-800 mb-2">
                  Changing it affects
                </h3>
                {chain.requiredBy.length === 0 ? (
                  <p className="text-xs text-gray-500">Nothing depends on it.</p>
                ) : (
                  chain.requiredBy.map((entry) => (
                    <div
                      key={`${entry.course}-${entry.depth}`}
                      className="text-sm text-gray-700 flex items-center gap-1"
                      style={{ paddingLeft: `${(entry.depth - 1) * 16}px` }}
                    >
                      {entry.depth > 1 && <CornerDownRight size={13} className="text-gray-400" />}
                      {entry.name}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {isAdmin && (
            <form onSubmit={submitRule} className="border border-gray-100 rounded-xl p-4 mb-6">
              <h3 className="text-sm font-semibold text-gray-800 mb-3">Add a prerequisite</h3>

              <div className="grid md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Course</label>
                  <select
                    value={ruleForm.course}
                    onChange={(event) => setRuleForm({ ...ruleForm, course: event.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">Pick…</option>
                    {courses.map((course) => (
                      <option key={course._id} value={course._id}>
                        {course.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Requires</label>
                  <select
                    value={ruleForm.requires}
                    onChange={(event) => setRuleForm({ ...ruleForm, requires: event.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">Pick…</option>
                    {courses.map((course) => (
                      <option key={course._id} value={course._id}>
                        {course.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Kind</label>
                  <select
                    value={ruleForm.kind}
                    onChange={(event) => setRuleForm({ ...ruleForm, kind: event.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  >
                    {Object.keys(KIND_LABELS).map((kind) => (
                      <option key={kind} value={kind}>
                        {KIND_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                </div>

                {ruleForm.kind === 'minimum-score' && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Minimum percent
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={ruleForm.minimumPercent}
                      onChange={(event) =>
                        setRuleForm({ ...ruleForm, minimumPercent: Number(event.target.value) })
                      }
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                )}

                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Why</label>
                  <input
                    value={ruleForm.rationale}
                    onChange={(event) => setRuleForm({ ...ruleForm, rationale: event.target.value })}
                    placeholder="The reason this order matters"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  />
                </div>

                <label className="md:col-span-2 flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={ruleForm.isMandatory}
                    onChange={(event) =>
                      setRuleForm({ ...ruleForm, isMandatory: event.target.checked })
                    }
                  />
                  Blocks enrolment (uncheck to make it advisory)
                </label>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="mt-3 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white rounded-lg text-sm font-medium"
              >
                Add prerequisite
              </button>
            </form>
          )}

          <h3 className="text-sm font-semibold text-gray-800 mb-3">Live rules</h3>

          {rules.length === 0 ? (
            <p className="text-sm text-gray-500">No prerequisites have been set.</p>
          ) : (
            <div className="space-y-2">
              {rules.map((rule) => (
                <div
                  key={rule._id}
                  className="border border-gray-100 rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-2"
                >
                  <div className="text-sm">
                    <span className="font-medium text-gray-800">{rule.course?.name}</span>
                    <span className="text-gray-400"> requires </span>
                    <span className="font-medium text-gray-800">{rule.requires?.name}</span>
                    <span
                      className={`ml-2 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                        KIND_STYLES[rule.kind] || 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {describeRule(rule)}
                    </span>
                    {!rule.isMandatory && (
                      <span className="ml-2 text-[11px] text-gray-500">advisory</span>
                    )}
                    {rule.rationale && (
                      <div className="text-xs text-gray-500 mt-1">{rule.rationale}</div>
                    )}
                  </div>

                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => retireRule(rule)}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 hover:bg-gray-200 text-gray-700"
                    >
                      Retire
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ---- waivers ---- */}
      {tab === 'waivers' && isTeachingStaff && (
        <>
          {waivers.length === 0 ? (
            <p className="text-sm text-gray-500">No live waivers.</p>
          ) : (
            <div className="space-y-2">
              {waivers.map((waiver) => (
                <div key={waiver._id} className="border border-gray-100 rounded-lg px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm">
                      <span className="font-medium text-gray-800">{waiver.student?.name}</span>
                      <span className="text-gray-400"> into </span>
                      <span className="font-medium text-gray-800">{waiver.course?.name}</span>
                      {waiver.expired && (
                        <span className="ml-2 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-100 text-red-700">
                          expired
                        </span>
                      )}
                    </div>

                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => revokeWaiver(waiver)}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-50 hover:bg-red-100 text-red-700"
                      >
                        Revoke
                      </button>
                    )}
                  </div>

                  <div className="text-xs text-gray-500 mt-1">
                    Granted by {waiver.grantedBy?.name || 'admin'} · covers{' '}
                    {waiver.unmetAtWaiver.map((gap) => gap.requiresName).join(', ') || '—'}
                  </div>
                  <div className="text-xs text-gray-600 mt-1 italic">{waiver.justification}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default PrerequisitePanel;
