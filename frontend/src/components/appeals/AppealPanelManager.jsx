import { useState, useEffect, useCallback, useContext } from 'react';
import {
  Users,
  Gavel,
  Scale,
  UserPlus,
  ShieldAlert,
  CheckCircle2,
  RefreshCw,
  Crown,
} from 'lucide-react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * The re-evaluation panel for a course.
 *
 * The number this panel exists to show is the one nobody could see before:
 * how many open appeals each reviewer is already carrying. Without it, the
 * same one or two conscientious people get picked off the queue every time.
 *
 * It lives on the exam builder because the builder is already scoped to a
 * course and already restricted to teaching staff, which makes it the one
 * place in the app where a course-scoped roster belongs.
 */

const STATUS_STYLES = {
  draft: 'bg-amber-100 text-amber-800',
  active: 'bg-green-100 text-green-700',
  retired: 'bg-gray-200 text-gray-600',
};

const STATUS_LABELS = {
  draft: 'Draft — not assignable yet',
  active: 'Active',
  retired: 'Retired',
};

const SEAT_LABELS = {
  chair: 'Chair',
  member: 'Member',
};

/**
 * A load figure a person can act on. Nought is worth saying out loud, because
 * "free" is the reason to pick somebody.
 */
const describeLoad = (count) => {
  if (!count) return 'free';
  return `${count} open`;
};

const AppealPanelManager = ({ courseId }) => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isStaff = role === 'teacher' || role === 'admin';
  const isAdmin = role === 'admin';

  const [panel, setPanel] = useState(null);
  const [courseName, setCourseName] = useState('');
  const [meta, setMeta] = useState(null);
  const [eligible, setEligible] = useState([]);

  const [showAdd, setShowAdd] = useState(false);
  const [candidate, setCandidate] = useState('');
  const [candidateSeat, setCandidateSeat] = useState('member');
  const [staffSearch, setStaffSearch] = useState('');

  const [panelName, setPanelName] = useState('');
  const [minReviewers, setMinReviewers] = useState(2);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 3500);
  };

  const explain = (err, fallback) =>
    err?.response?.data?.message || err?.message || fallback;

  const loadPanel = useCallback(async () => {
    if (!courseId || !isStaff) return;

    setLoading(true);
    setError('');

    try {
      const [panelRes, metaRes] = await Promise.all([
        api.get(`/appeals/panels/course/${courseId}`),
        api.get('/appeals/panels/meta'),
      ]);

      setPanel(panelRes.data.data);
      setCourseName(panelRes.data.courseName || '');
      setMeta(metaRes.data.data);

      if (!panelRes.data.data && panelRes.data.courseName) {
        setPanelName(`${panelRes.data.courseName} appeal panel`);
      }
    } catch (err) {
      setError(explain(err, 'Could not load the appeal panel.'));
    } finally {
      setLoading(false);
    }
  }, [courseId, isStaff]);

  useEffect(() => {
    loadPanel();
  }, [loadPanel]);

  const loadEligible = useCallback(async () => {
    if (!isAdmin) return;

    try {
      const { data } = await api.get('/appeals/panels/eligible', {
        params: staffSearch.trim() ? { q: staffSearch.trim() } : {},
      });

      setEligible(data.data || []);
    } catch (err) {
      setError(explain(err, 'Could not load eligible staff.'));
    }
  }, [isAdmin, staffSearch]);

  useEffect(() => {
    if (showAdd) loadEligible();
  }, [showAdd, loadEligible]);

  const createPanel = async () => {
    setBusy('create');
    setError('');

    try {
      await api.post('/appeals/panels', {
        course: courseId,
        name: panelName.trim() || `${courseName} appeal panel`,
        minReviewers: Number(minReviewers) || 2,
      });

      flash('Panel drafted. Add its members, then activate it.');
      await loadPanel();
    } catch (err) {
      setError(explain(err, 'Could not create the panel.'));
    } finally {
      setBusy('');
    }
  };

  const addMember = async () => {
    if (!candidate) {
      setError('Choose somebody to add.');
      return;
    }

    setBusy('add');
    setError('');

    try {
      await api.post(`/appeals/panels/${panel._id}/members`, {
        userId: candidate,
        seat: candidateSeat,
      });

      flash('Added to the panel.');
      setCandidate('');
      setCandidateSeat('member');
      setShowAdd(false);
      await loadPanel();
    } catch (err) {
      setError(explain(err, 'Could not add that person.'));
    } finally {
      setBusy('');
    }
  };

  const removeMember = async (member) => {
    const reason = window.prompt(
      `Why is ${member.name || 'this member'} coming off the panel? This is recorded.`
    );
    if (reason === null) return;

    if (!reason.trim()) {
      setError('A removal needs a reason.');
      return;
    }

    setBusy(String(member.user));
    setError('');

    try {
      await api.delete(`/appeals/panels/${panel._id}/members/${member.user}`, {
        data: { reason },
      });

      flash('Removed from the panel.');
      await loadPanel();
    } catch (err) {
      setError(explain(err, 'Could not remove that person.'));
    } finally {
      setBusy('');
    }
  };

  const changeSeat = async (member) => {
    const seat = member.seat === 'chair' ? 'member' : 'chair';

    setBusy(String(member.user));
    setError('');

    try {
      await api.patch(`/appeals/panels/${panel._id}/members/${member.user}/seat`, { seat });
      flash(`${member.name || 'Member'} is now the ${SEAT_LABELS[seat].toLowerCase()}.`);
      await loadPanel();
    } catch (err) {
      setError(explain(err, 'Could not change the seat.'));
    } finally {
      setBusy('');
    }
  };

  const activate = async () => {
    setBusy('activate');
    setError('');

    try {
      await api.patch(`/appeals/panels/${panel._id}/activate`);
      flash('Panel activated. Appeals for this course can be assigned from it.');
      await loadPanel();
    } catch (err) {
      setError(explain(err, 'Could not activate the panel.'));
    } finally {
      setBusy('');
    }
  };

  const retire = async () => {
    const reason = window.prompt('Why is this panel being retired? This is recorded.');
    if (reason === null) return;

    if (!reason.trim()) {
      setError('A retirement needs a reason.');
      return;
    }

    setBusy('retire');
    setError('');

    try {
      await api.patch(`/appeals/panels/${panel._id}/retire`, { reason });
      flash('Panel retired.');
      await loadPanel();
    } catch (err) {
      setError(explain(err, 'Could not retire the panel.'));
    } finally {
      setBusy('');
    }
  };

  // Nothing here is meaningful without a course to scope it to, and the routes
  // behind it are staff-only.
  if (!courseId || !isStaff) return null;

  const activeMembers = (panel?.members || []).filter((member) => member.active);
  const formerMembers = (panel?.members || []).filter((member) => !member.active);

  const alreadyOn = new Set(activeMembers.map((member) => String(member.user)));
  const addable = eligible.filter((person) => !alreadyOn.has(String(person._id)));

  return (
    <section className="mt-10 rounded-xl border border-slate-200 bg-white p-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <Scale className="text-blue-600" size={22} />
            Re-evaluation panel
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Who may re-mark {courseName || 'this course'}, and what each of them is
            already carrying.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {panel && (
            <span
              className={`px-2 py-1 rounded text-xs font-medium ${
                STATUS_STYLES[panel.status] || 'bg-gray-100 text-gray-600'
              }`}
            >
              {STATUS_LABELS[panel.status] || panel.status}
            </span>
          )}

          <button
            type="button"
            onClick={loadPanel}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 text-sm"
          >
            <RefreshCw size={15} />
            Refresh
          </button>
        </div>
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

      {loading && <p className="text-sm text-slate-500">Loading the panel…</p>}

      {!loading && !panel && (
        <div className="rounded-lg border border-dashed border-slate-300 p-5">
          <p className="text-slate-600 mb-3">
            This course has no re-evaluation panel. Until it does, appeals against its
            exams can be assigned to anybody who is not the student and not the original
            marker.
          </p>

          {isAdmin ? (
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm text-slate-700">
                Panel name
                <input
                  type="text"
                  value={panelName}
                  onChange={(e) => setPanelName(e.target.value)}
                  className="mt-1 block w-64 border border-slate-300 rounded-md px-3 py-2"
                />
              </label>

              <label className="text-sm text-slate-700">
                Minimum reviewers
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={minReviewers}
                  onChange={(e) => setMinReviewers(e.target.value)}
                  className="mt-1 block w-32 border border-slate-300 rounded-md px-3 py-2"
                />
              </label>

              <button
                type="button"
                disabled={busy === 'create'}
                onClick={createPanel}
                className="px-4 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {busy === 'create' ? 'Creating…' : 'Create a panel'}
              </button>
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              An administrator can set one up for this course.
            </p>
          )}
        </div>
      )}

      {!loading && panel && (
        <>
          <div className="flex flex-wrap items-center gap-4 text-sm text-slate-600 mb-4">
            <span className="inline-flex items-center gap-1">
              <Users size={15} />
              {panel.memberCount} reviewer{panel.memberCount === 1 ? '' : 's'}
            </span>
            <span className="inline-flex items-center gap-1">
              <Gavel size={15} />
              {panel.chairCount} chair{panel.chairCount === 1 ? '' : 's'}
            </span>
            <span>Floor: {panel.minReviewers}</span>
          </div>

          <div className="space-y-2">
            {activeMembers.length ? (
              activeMembers.map((member) => (
                <div
                  key={String(member.user)}
                  className="flex flex-wrap items-center justify-between gap-3 border border-slate-200 rounded-lg px-4 py-3"
                >
                  <div>
                    <p className="font-medium text-slate-800 flex items-center gap-2">
                      {member.seat === 'chair' && (
                        <Crown size={15} className="text-amber-500" />
                      )}
                      {member.name || 'Unnamed'}
                      <span className="text-xs text-slate-500">
                        {SEAT_LABELS[member.seat] || member.seat}
                      </span>
                    </p>
                    <p className="text-sm text-slate-500">{member.email}</p>
                  </div>

                  <div className="flex items-center gap-3">
                    <span
                      className={`text-sm ${
                        member.openAppeals ? 'text-slate-700' : 'text-green-700'
                      }`}
                    >
                      {describeLoad(member.openAppeals)}
                    </span>

                    {isAdmin && (
                      <>
                        <button
                          type="button"
                          disabled={busy === String(member.user)}
                          onClick={() => changeSeat(member)}
                          className="px-3 py-1.5 text-sm rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                        >
                          {member.seat === 'chair' ? 'Stand down' : 'Make chair'}
                        </button>

                        <button
                          type="button"
                          disabled={busy === String(member.user)}
                          onClick={() => removeMember(member)}
                          className="px-3 py-1.5 text-sm rounded-md border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-60"
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-slate-500">Nobody is on this panel yet.</p>
            )}
          </div>

          {isAdmin && panel.status !== 'retired' && (
            <div className="mt-4">
              {showAdd ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="text-sm text-slate-700">
                      Search staff
                      <input
                        type="search"
                        value={staffSearch}
                        onChange={(e) => setStaffSearch(e.target.value)}
                        placeholder="Name or email"
                        className="mt-1 block w-56 border border-slate-300 rounded-md px-3 py-2"
                      />
                    </label>

                    <label className="text-sm text-slate-700">
                      Add
                      <select
                        value={candidate}
                        onChange={(e) => setCandidate(e.target.value)}
                        className="mt-1 block w-72 border border-slate-300 rounded-md px-3 py-2"
                      >
                        <option value="">Choose somebody…</option>
                        {addable.map((person) => (
                          <option key={person._id} value={person._id}>
                            {person.name} ({person.role}) — {describeLoad(person.openAppeals)}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="text-sm text-slate-700">
                      Seat
                      <select
                        value={candidateSeat}
                        onChange={(e) => setCandidateSeat(e.target.value)}
                        className="mt-1 block w-36 border border-slate-300 rounded-md px-3 py-2"
                      >
                        {(meta?.seats || ['chair', 'member']).map((seat) => (
                          <option key={seat} value={seat}>
                            {SEAT_LABELS[seat] || seat}
                          </option>
                        ))}
                      </select>
                    </label>

                    <button
                      type="button"
                      disabled={busy === 'add'}
                      onClick={addMember}
                      className="px-4 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
                    >
                      {busy === 'add' ? 'Adding…' : 'Add'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setShowAdd(false)}
                      className="px-4 py-2 rounded-md border border-slate-300 text-slate-600 hover:bg-white"
                    >
                      Done
                    </button>
                  </div>

                  <p className="mt-2 text-xs text-slate-500">
                    Only teaching and administrative accounts appear here — a student
                    account is refused by the server as well as hidden by this list.
                  </p>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowAdd(true)}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-blue-600 text-blue-700 hover:bg-blue-50 text-sm"
                >
                  <UserPlus size={16} />
                  Add a reviewer
                </button>
              )}
            </div>
          )}

          {isAdmin && (
            <div className="mt-5 flex flex-wrap gap-2 border-t border-slate-200 pt-4">
              {panel.status === 'draft' && (
                <button
                  type="button"
                  disabled={busy === 'activate' || !panel.canActivate}
                  onClick={activate}
                  title={
                    panel.canActivate
                      ? ''
                      : `Needs ${panel.minReviewers} reviewers and a chair`
                  }
                  className="px-4 py-2 rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                >
                  {busy === 'activate' ? 'Activating…' : 'Activate panel'}
                </button>
              )}

              {panel.status === 'active' && (
                <button
                  type="button"
                  disabled={busy === 'retire'}
                  onClick={retire}
                  className="px-4 py-2 rounded-md border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-60"
                >
                  Retire panel
                </button>
              )}
            </div>
          )}

          {formerMembers.length > 0 && (
            <details className="mt-5">
              <summary className="text-sm text-slate-600 cursor-pointer">
                Former members ({formerMembers.length})
              </summary>

              <div className="mt-2 space-y-1">
                {formerMembers.map((member) => (
                  <p key={String(member.user)} className="text-sm text-slate-500">
                    {member.name || 'Unnamed'} — removed
                    {member.removalReason ? `: ${member.removalReason}` : ''}
                  </p>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
};

export default AppealPanelManager;
