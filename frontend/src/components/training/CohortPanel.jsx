import { useState, useEffect, useCallback, useContext, useMemo } from 'react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * Scheduled training sessions with seats.
 *
 * Seats are shown as a count of what is left rather than as a bar: "3 seats
 * left" is actionable and "87% full" is not. A full cohort still shows an
 * enrol button, labelled with the place the person would take, so nobody has
 * to guess whether joining the queue is worth doing.
 *
 * Where an action has a consequence, the consequence is on the button. Once
 * the withdrawal cutoff has passed the button does not disappear — it says
 * that withdrawing now counts as a no-show, which is the thing the person
 * actually needs to know.
 */

const STATUS_STYLES = {
  draft: 'bg-gray-200 text-gray-700',
  open: 'bg-green-100 text-green-700',
  full: 'bg-amber-100 text-amber-800',
  closed: 'bg-gray-200 text-gray-600',
  running: 'bg-blue-100 text-blue-700',
  completed: 'bg-gray-100 text-gray-500',
  cancelled: 'bg-red-100 text-red-700',
};

const STATE_STYLES = {
  enrolled: 'bg-green-100 text-green-700',
  waitlisted: 'bg-amber-100 text-amber-800',
  attended: 'bg-emerald-100 text-emerald-800',
  'no-show': 'bg-red-100 text-red-700',
  withdrawn: 'bg-gray-200 text-gray-600',
};

const MODE_LABELS = {
  'in-person': 'In person',
  online: 'Online',
  hybrid: 'Hybrid',
};

const COMPETENCY_LABELS = {
  safeguarding: 'Safeguarding',
  'first-aid': 'First aid',
  pedagogy: 'Pedagogy',
  assessment: 'Assessment',
  inclusion: 'Inclusion',
  technology: 'Technology',
  leadership: 'Leadership',
  'subject-knowledge': 'Subject knowledge',
  wellbeing: 'Wellbeing',
  compliance: 'Compliance',
};

const EMPTY_COHORT = {
  title: '',
  provider: '',
  type: 'in-house',
  competency: 'safeguarding',
  academicYear: '2026-27',
  startDate: '',
  endDate: '',
  startTime: '09:00',
  endTime: '16:00',
  venue: '',
  mode: 'in-person',
  creditHours: 3,
  seatCapacity: 24,
  isMandatory: false,
  status: 'open',
};

const formatDate = (value) => {
  if (!value) return '—';
  const [year, month, day] = String(value).split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
};

const CohortPanel = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';

  const [meta, setMeta] = useState(null);
  const [cohorts, setCohorts] = useState([]);
  const [mine, setMine] = useState([]);
  const [tab, setTab] = useState('browse');

  const [registerFor, setRegisterFor] = useState(null);
  const [register, setRegister] = useState(null);
  const [gap, setGap] = useState(null);

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_COHORT);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 4000);
  };

  const explain = (err, fallback) =>
    setError(err?.response?.data?.message || err?.message || fallback);

  // ---- loading -------------------------------------------------------------

  const loadMeta = useCallback(async () => {
    try {
      const res = await api.get('/staff-training/cohorts/meta');
      setMeta(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load cohort reference data.');
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cohortsRes, mineRes] = await Promise.all([
        api.get('/staff-training/cohorts'),
        api.get('/staff-training/cohorts/mine'),
      ]);

      setCohorts(cohortsRes.data.data || []);
      setMine(mineRes.data.data || []);
    } catch (err) {
      explain(err, 'Could not load training sessions.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRegister = useCallback(async (cohortId) => {
    if (!cohortId) {
      setRegister(null);
      setGap(null);
      return;
    }

    try {
      const res = await api.get(`/staff-training/cohorts/${cohortId}/register`);
      setRegister(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load the register.');
    }

    try {
      const gapRes = await api.get(`/staff-training/cohorts/${cohortId}/gap`);
      setGap(gapRes.data.data || null);
    } catch {
      // Not a mandatory cohort, or not an admin. Neither is an error worth
      // showing — the gap report simply does not apply.
      setGap(null);
    }
  }, []);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadRegister(registerFor?._id);
  }, [registerFor, loadRegister]);

  // ---- acting --------------------------------------------------------------

  const refresh = () => {
    load();
    if (registerFor) loadRegister(registerFor._id);
  };

  const enrol = async (cohort) => {
    setError('');
    setBusy(cohort._id);

    try {
      const res = await api.post(`/staff-training/cohorts/${cohort._id}/enrol`);
      flash(res.data.message || 'Done.');
      refresh();
    } catch (err) {
      explain(err, 'Could not enrol you.');
    } finally {
      setBusy('');
    }
  };

  const withdraw = async (cohort) => {
    if (cohort.lateWithdrawalNow) {
      const confirmed = window.confirm(
        'The withdrawal cutoff has passed. Withdrawing now is recorded as a no-show against you. Continue?'
      );
      if (!confirmed) return;
    }

    setError('');
    setBusy(cohort._id);

    try {
      const res = await api.patch(`/staff-training/cohorts/${cohort._id}/withdraw`, {
        reason: '',
      });
      flash(res.data.message || 'Withdrawn.');
      refresh();
    } catch (err) {
      explain(err, 'Could not withdraw.');
    } finally {
      setBusy('');
    }
  };

  const promote = async (cohort) => {
    setBusy(cohort._id);
    try {
      const res = await api.patch(`/staff-training/cohorts/${cohort._id}/promote`);
      flash(res.data.message || 'Promoted.');
      refresh();
    } catch (err) {
      explain(err, 'Could not promote from the waiting list.');
    } finally {
      setBusy('');
    }
  };

  const mark = async (cohort, staffId, present) => {
    setBusy(staffId);
    try {
      const res = await api.patch(
        `/staff-training/cohorts/${cohort._id}/attendance/${staffId}`,
        { present }
      );
      flash(res.data.message || 'Marked.');
      refresh();
    } catch (err) {
      explain(err, 'Could not mark attendance.');
    } finally {
      setBusy('');
    }
  };

  const cancelCohort = async (cohort) => {
    const reason = window.prompt('Why is this session being cancelled?');
    if (!reason) return;

    setBusy(cohort._id);
    try {
      const res = await api.patch(`/staff-training/cohorts/${cohort._id}/cancel`, { reason });
      flash(res.data.message || 'Cancelled.');
      refresh();
    } catch (err) {
      explain(err, 'Could not cancel the session.');
    } finally {
      setBusy('');
    }
  };

  const createCohort = async (event) => {
    event.preventDefault();
    setError('');
    setBusy('new');

    try {
      const res = await api.post('/staff-training/cohorts', form);
      flash(res.data.message || 'Cohort created.');
      setCreating(false);
      setForm(EMPTY_COHORT);
      load();
    } catch (err) {
      explain(err, 'Could not create the cohort.');
    } finally {
      setBusy('');
    }
  };

  // ---- pieces --------------------------------------------------------------

  const rows = useMemo(() => (tab === 'mine' ? mine : cohorts), [tab, mine, cohorts]);

  const statusChip = (status) => (
    <span
      className={`text-xs px-2 py-0.5 rounded-full font-medium ${
        STATUS_STYLES[status] || 'bg-gray-100 text-gray-600'
      }`}
    >
      {status}
    </span>
  );

  /**
   * Seats as a count, and a label that already says what pressing the button
   * will get you.
   */
  const seatLine = (cohort) => {
    if (cohort.seatsLeft > 0) {
      return `${cohort.seatsLeft} seat${cohort.seatsLeft === 1 ? '' : 's'} left of ${
        cohort.seatCapacity
      }`;
    }

    return `Full · ${cohort.tally.waitlisted} waiting`;
  };

  const enrolLabel = (cohort) => {
    if (cohort.myEnrolment?.state === 'enrolled') return 'You have a seat';
    if (cohort.myEnrolment?.state === 'waitlisted') {
      return `Waiting — you are ${cohort.myEnrolment.queuePlace}${
        cohort.myEnrolment.queuePlace === 1 ? 'st' : 'th'
      } in the queue`;
    }
    if (cohort.seatsLeft > 0) return 'Take a seat';
    return `Join the waitlist — you would be ${cohort.nextWaitlistPlace}${
      cohort.nextWaitlistPlace === 1 ? 'st' : 'th'
    }`;
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-6">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <h2 className="text-lg font-bold text-gray-800">Scheduled sessions</h2>

        <div className="flex items-center gap-2">
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            {[
              { id: 'browse', label: 'All' },
              { id: 'mine', label: 'Mine' },
            ].map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setTab(option.id)}
                className={`px-3 py-1 text-sm rounded-md ${
                  tab === option.id ? 'bg-white shadow-sm font-medium' : 'text-gray-600'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          {isAdmin && (
            <button
              type="button"
              onClick={() => setCreating((current) => !current)}
              className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-sm"
            >
              {creating ? 'Close' : 'Schedule one'}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-100 text-red-700 rounded-xl p-3 mb-4 text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-100 text-green-700 rounded-xl p-3 mb-4 text-sm">
          {success}
        </div>
      )}

      {/* ---- schedule one ---- */}
      {creating && meta && (
        <form onSubmit={createCohort} className="border border-gray-100 rounded-xl p-4 mb-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <input
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              placeholder="Title"
              required
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />
            <input
              value={form.provider}
              onChange={(event) => setForm({ ...form, provider: event.target.value })}
              placeholder="Provider"
              required
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />

            <select
              value={form.competency}
              onChange={(event) => setForm({ ...form, competency: event.target.value })}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
            >
              {meta.competencies.map((key) => (
                <option key={key} value={key}>
                  {COMPETENCY_LABELS[key] || key}
                </option>
              ))}
            </select>

            <select
              value={form.type}
              onChange={(event) => setForm({ ...form, type: event.target.value })}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
            >
              {meta.types.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>

            <label className="text-sm">
              <span className="block text-xs text-gray-500 mb-1">Starts</span>
              <input
                type="date"
                value={form.startDate}
                onChange={(event) =>
                  setForm({
                    ...form,
                    startDate: event.target.value,
                    endDate: form.endDate || event.target.value,
                  })
                }
                required
                className="w-full border border-gray-200 rounded-lg px-3 py-2"
              />
            </label>

            <label className="text-sm">
              <span className="block text-xs text-gray-500 mb-1">Ends</span>
              <input
                type="date"
                value={form.endDate}
                onChange={(event) => setForm({ ...form, endDate: event.target.value })}
                required
                className="w-full border border-gray-200 rounded-lg px-3 py-2"
              />
            </label>

            <label className="text-sm">
              <span className="block text-xs text-gray-500 mb-1">Seats in the room</span>
              <input
                type="number"
                min="1"
                value={form.seatCapacity}
                onChange={(event) =>
                  setForm({ ...form, seatCapacity: Number(event.target.value) })
                }
                required
                className="w-full border border-gray-200 rounded-lg px-3 py-2"
              />
            </label>

            <label className="text-sm">
              <span className="block text-xs text-gray-500 mb-1">Credit hours, for everyone</span>
              <input
                type="number"
                step="0.5"
                min="0.5"
                value={form.creditHours}
                onChange={(event) =>
                  setForm({ ...form, creditHours: Number(event.target.value) })
                }
                required
                className="w-full border border-gray-200 rounded-lg px-3 py-2"
              />
            </label>

            <input
              value={form.venue}
              onChange={(event) => setForm({ ...form, venue: event.target.value })}
              placeholder="Venue"
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />

            <label className="text-sm flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.isMandatory}
                onChange={(event) => setForm({ ...form, isMandatory: event.target.checked })}
              />
              Mandatory
            </label>
          </div>

          <button
            type="submit"
            disabled={busy === 'new'}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {busy === 'new' ? 'Saving…' : 'Create'}
          </button>
        </form>
      )}

      {/* ---- the list ---- */}
      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">
          {tab === 'mine' ? 'You are not on any sessions.' : 'Nothing scheduled.'}
        </p>
      ) : (
        <div className="space-y-3">
          {rows.map((cohort) => (
            <div key={cohort._id} className="border border-gray-100 rounded-xl p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex-1 min-w-[14rem]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-gray-800">{cohort.title}</span>
                    {cohort.isMandatory && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">
                        mandatory
                      </span>
                    )}
                    {statusChip(cohort.status)}
                  </div>

                  <div className="text-xs text-gray-500 mt-1">
                    {formatDate(cohort.startDate)} · {cohort.startTime}–{cohort.endTime} ·{' '}
                    {MODE_LABELS[cohort.mode]} · {cohort.venue || 'venue tbc'}
                  </div>

                  <div className="text-xs text-gray-500 mt-0.5">
                    {COMPETENCY_LABELS[cohort.competency] || cohort.competency} ·{' '}
                    {cohort.creditHours} credit hour(s) · {cohort.provider}
                  </div>

                  <div
                    className={`text-sm mt-1 font-medium ${
                      cohort.seatsLeft > 0 ? 'text-emerald-700' : 'text-amber-700'
                    }`}
                  >
                    {seatLine(cohort)}
                  </div>

                  {cohort.status === 'cancelled' && cohort.cancelReason && (
                    <div className="text-xs text-red-600 mt-1">{cohort.cancelReason}</div>
                  )}
                </div>

                <div className="flex flex-col items-end gap-2">
                  {cohort.myEnrolment ? (
                    <>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          STATE_STYLES[cohort.myEnrolment.state] || 'bg-gray-100'
                        }`}
                      >
                        {enrolLabel(cohort)}
                      </span>

                      {['enrolled', 'waitlisted'].includes(cohort.myEnrolment.state) &&
                        !['running', 'completed', 'cancelled'].includes(cohort.status) && (
                          <button
                            type="button"
                            disabled={busy === cohort._id}
                            onClick={() => withdraw(cohort)}
                            className="text-xs text-gray-500 hover:text-red-600 disabled:opacity-50"
                          >
                            {cohort.lateWithdrawalNow
                              ? 'Withdraw — counts as a no-show'
                              : 'Withdraw'}
                          </button>
                        )}
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={busy === cohort._id || Boolean(cohort.enrolmentError)}
                      title={cohort.enrolmentError || undefined}
                      onClick={() => enrol(cohort)}
                      className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-sm disabled:opacity-40"
                    >
                      {cohort.enrolmentError || enrolLabel(cohort)}
                    </button>
                  )}

                  {isAdmin && (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setRegisterFor((current) =>
                            current && current._id === cohort._id ? null : cohort
                          )
                        }
                        className="text-xs text-gray-500 hover:text-gray-800"
                      >
                        {registerFor?._id === cohort._id ? 'Hide register' : 'Register'}
                      </button>

                      {cohort.tally.waitlisted > 0 && cohort.seatsLeft > 0 && (
                        <button
                          type="button"
                          disabled={busy === cohort._id}
                          onClick={() => promote(cohort)}
                          className="text-xs text-emerald-700 hover:underline disabled:opacity-50"
                        >
                          Promote next
                        </button>
                      )}

                      {!['running', 'completed', 'cancelled'].includes(cohort.status) && (
                        <button
                          type="button"
                          disabled={busy === cohort._id}
                          onClick={() => cancelCohort(cohort)}
                          className="text-xs text-red-600 hover:underline disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* ---- the register ---- */}
              {registerFor?._id === cohort._id && register && (
                <div className="mt-4 pt-4 border-t border-gray-100">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                    {[
                      { label: 'Enrolled', value: register.cohort.tally.enrolled },
                      { label: 'Waiting', value: register.cohort.tally.waitlisted },
                      { label: 'Attended', value: register.cohort.tally.attended },
                      { label: 'No-shows', value: register.cohort.tally.noShow },
                    ].map((tile) => (
                      <div key={tile.label} className="bg-gray-50 rounded-lg p-2 text-center">
                        <div className="font-bold text-gray-800">{tile.value}</div>
                        <div className="text-xs text-gray-500">{tile.label}</div>
                      </div>
                    ))}
                  </div>

                  <div className="space-y-1 mb-3">
                    {register.register.map((row) => (
                      <div
                        key={String(row.staff)}
                        className="flex items-center justify-between gap-3 text-sm border border-gray-100 rounded-lg px-3 py-1.5"
                      >
                        <div>
                          <span className="text-gray-800">{row.staffName || 'Unnamed'}</span>
                          {row.position ? (
                            <span className="text-xs text-gray-500"> · queue #{row.position}</span>
                          ) : null}
                          {row.lateWithdrawal && (
                            <span className="text-xs text-red-600"> · late withdrawal</span>
                          )}
                          {row.creditAwarded > 0 && (
                            <span className="text-xs text-emerald-700">
                              {' '}
                              · {row.creditAwarded} hour(s) credited
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full ${
                              STATE_STYLES[row.state] || 'bg-gray-100'
                            }`}
                          >
                            {row.state}
                          </span>

                          {row.state === 'enrolled' && cohort.status === 'running' && (
                            <>
                              <button
                                type="button"
                                disabled={busy === String(row.staff)}
                                onClick={() => mark(cohort, row.staff, true)}
                                className="text-xs px-2 py-0.5 bg-emerald-600 text-white rounded disabled:opacity-50"
                              >
                                Present
                              </button>
                              <button
                                type="button"
                                disabled={busy === String(row.staff)}
                                onClick={() => mark(cohort, row.staff, false)}
                                className="text-xs px-2 py-0.5 border border-gray-200 rounded disabled:opacity-50"
                              >
                                Absent
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* ---- the mandatory gap ---- */}
                  {gap && (
                    <div className="bg-amber-50 border border-amber-100 rounded-xl p-3">
                      <div className="text-sm font-semibold text-amber-900 mb-1">
                        {gap.missingCount} of {gap.requiredCount} required staff are not on this
                        session
                      </div>
                      {gap.seatsShort > 0 && (
                        <div className="text-xs text-red-700 mb-1">
                          There are {gap.seatsShort} fewer seats than people still to be trained.
                        </div>
                      )}
                      <div className="text-xs text-amber-900">
                        {gap.missing.map((person) => person.name).join(', ') || 'Everybody is on.'}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default CohortPanel;
