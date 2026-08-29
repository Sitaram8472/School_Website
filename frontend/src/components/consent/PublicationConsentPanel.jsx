import { useState, useEffect, useCallback, useContext, useMemo } from 'react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * Whether a child's image or name may appear in a school publication.
 *
 * For a family: one row per channel with an unambiguous state — granted until a
 * date, withheld, or *never asked*. The last one is the row that matters and
 * the one a list built from existing records would omit entirely, so the panel
 * enumerates the channels rather than the documents.
 *
 * Withdrawing shows the takedown count it will create *before* it is confirmed.
 * A parent pressing that button is entitled to know it starts a clock rather
 * than ending a conversation.
 *
 * For staff the takedown queue is the screen. Everything else is context for it.
 */

const CHANNEL_LABELS = {
  website: 'School website',
  'social-media': 'Social media',
  press: 'Press and newspapers',
  prospectus: 'Prospectus',
  newsletter: 'Newsletter',
  yearbook: 'Yearbook',
  'internal-display': 'Displays inside school',
};

const SCOPE_LABELS = {
  work: "The child's work",
  image: 'Photographs only',
  name: 'Name only',
  'image-and-name': 'Photographs and name',
};

const STATE_STYLES = {
  granted: 'bg-green-100 text-green-700',
  withheld: 'bg-red-100 text-red-700',
  withdrawn: 'bg-amber-100 text-amber-800',
  'never-asked': 'bg-gray-200 text-gray-600',
  'not-in-force': 'bg-gray-100 text-gray-500',
};

const STATE_LABELS = {
  granted: 'Granted',
  withheld: 'Withheld',
  withdrawn: 'Withdrawn',
  'never-asked': 'Never asked',
  'not-in-force': 'Not in force',
};

const channelLabel = (value) => CHANNEL_LABELS[value] || value;

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—';

const PublicationConsentPanel = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isSignedIn = Boolean(role);
  const isStaff = ['teacher', 'staff', 'admin'].includes(role);
  const isOffice = ['staff', 'admin'].includes(role);

  const [meta, setMeta] = useState(null);
  const [mine, setMine] = useState(null);
  const [takedowns, setTakedowns] = useState(null);
  const [coverage, setCoverage] = useState(null);
  const [coverageClass, setCoverageClass] = useState('');

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 6000);
  };

  const explain = (err, fallback) =>
    setError(err?.response?.data?.message || err?.message || fallback);

  // ---- loading -------------------------------------------------------------

  const loadMeta = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const res = await api.get('/notices/publication-consent/meta');
      setMeta(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load consent reference data.');
    }
  }, [isSignedIn]);

  const loadMine = useCallback(async () => {
    if (!isSignedIn) return;

    setLoading(true);
    try {
      const res = await api.get('/notices/publication-consent/mine');
      setMine(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load your consents.');
    } finally {
      setLoading(false);
    }
  }, [isSignedIn]);

  const loadQueue = useCallback(async () => {
    if (!isOffice) return;

    try {
      const res = await api.get('/notices/publication-consent/takedowns');
      setTakedowns(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load the takedown queue.');
    }
  }, [isOffice]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    loadMine();
  }, [loadMine]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  const takedownDays = meta?.takedownDays ?? 7;

  const liveCount = mine?.liveUsageCount ?? 0;

  const grantedRows = useMemo(
    () => (mine?.rows || []).filter((row) => row.state === 'granted'),
    [mine]
  );

  // ---- acting --------------------------------------------------------------

  const withdraw = async (row) => {
    const confirmed = window.confirm(
      liveCount
        ? `Withdrawing consent for ${channelLabel(row.channel)} stops any future use straight away, and puts the ${liveCount} item(s) already published into a takedown queue due within ${takedownDays} days. Continue?`
        : `Withdrawing consent for ${channelLabel(row.channel)} stops any future use straight away. Continue?`
    );
    if (!confirmed) return;

    const reason = window.prompt('Anything you would like recorded with the withdrawal? (optional)');

    setError('');
    setBusy(row.channel);

    try {
      const res = await api.patch(
        `/notices/publication-consent/${row.consent._id}/withdraw`,
        { reason: reason || '' }
      );
      flash(res.data.message || 'Consent withdrawn.');
      loadMine();
      loadQueue();
    } catch (err) {
      explain(err, 'Could not withdraw that consent.');
    } finally {
      setBusy('');
    }
  };

  const remove = async (usage) => {
    const note = window.prompt('Where was it taken down from? (optional)');

    setError('');
    setBusy(usage._id);

    try {
      const res = await api.patch(
        `/notices/publication-consent/usages/${usage._id}/remove`,
        { note: note || '' }
      );
      flash(res.data.message || 'Taken down.');
      loadQueue();
      loadMine();
    } catch (err) {
      explain(err, 'Could not record the takedown.');
    } finally {
      setBusy('');
    }
  };

  const loadCoverage = async () => {
    if (!coverageClass) {
      setError('Name a class to check coverage for.');
      return;
    }

    setError('');
    setBusy('coverage');

    try {
      const res = await api.get(
        `/notices/publication-consent/coverage?className=${encodeURIComponent(coverageClass)}`
      );
      setCoverage(res.data.data || null);
    } catch (err) {
      setCoverage(null);
      explain(err, 'Could not build the coverage report.');
    } finally {
      setBusy('');
    }
  };

  if (!isSignedIn) return null;

  return (
    <div className="max-w-5xl mx-auto px-4 pb-16 text-left">
      <div className="bg-white rounded-xl shadow p-4 sm:p-6">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Photograph and name permissions</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Permission is given per place it might appear, lasts one academic year, and can be
            taken back at any time. Where nothing has been recorded, nothing may be published.
          </p>
        </div>

        {error && (
          <div className="mb-4 text-sm bg-red-50 border border-red-100 text-red-700 rounded px-3 py-2">
            {error}
          </div>
        )}
        {success && (
          <div className="mb-4 text-sm bg-emerald-50 border border-emerald-100 text-emerald-700 rounded px-3 py-2">
            {success}
          </div>
        )}

        {/* ---- the family's own ---- */}
        <div className="border border-gray-100 rounded-lg p-4 mb-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
            <h3 className="font-semibold text-gray-800 text-sm">Where you have agreed</h3>
            {liveCount > 0 && (
              <span className="text-xs text-gray-500">
                {liveCount} published item(s) currently rely on these
              </span>
            )}
          </div>

          {loading && !mine ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : (
            <div className="space-y-2">
              {(mine?.rows || []).map((row) => (
                <div
                  key={row.channel}
                  className="flex flex-wrap items-center justify-between gap-2 bg-gray-50 rounded px-3 py-2"
                >
                  <div>
                    <p className="text-sm text-gray-800">{channelLabel(row.channel)}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {row.state === 'never-asked'
                        ? 'Nobody has asked, so nothing may be published here'
                        : row.state === 'granted'
                          ? `${SCOPE_LABELS[row.consent.scope] || row.consent.scope} · until ${formatDate(row.consent.expiresAt)} · agreed by ${row.consent.guardianName}`
                          : row.reason || '—'}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        STATE_STYLES[row.state] || 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {STATE_LABELS[row.state] || row.state}
                    </span>

                    {row.state === 'granted' && (
                      <button
                        type="button"
                        disabled={busy === row.channel}
                        onClick={() => withdraw(row)}
                        className="text-xs px-2 py-1 border border-gray-200 rounded disabled:opacity-50"
                      >
                        Withdraw
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {mine?.pendingTakedownCount > 0 && (
            <p className="text-xs text-amber-700 mt-3">
              {mine.pendingTakedownCount} item(s) are queued for removal following a withdrawal.
              They are due down within {takedownDays} days of the request.
            </p>
          )}

          {grantedRows.length === 0 && mine && (
            <p className="text-xs text-gray-500 mt-3">
              Nothing is currently permitted. That is the default, not an oversight — a permission
              has to be given before anything can be published.
            </p>
          )}
        </div>

        {/* ---- the office ---- */}
        {isOffice && (
          <div className="space-y-6">
            <div className="border border-gray-100 rounded-lg p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
                <h3 className="font-semibold text-gray-800 text-sm">Takedown queue</h3>
                {takedowns && (
                  <span
                    className={`text-xs ${
                      takedowns.overdue > 0 ? 'text-red-600 font-medium' : 'text-gray-500'
                    }`}
                  >
                    {takedowns.rows.length} outstanding
                    {takedowns.overdue > 0 ? `, ${takedowns.overdue} overdue` : ''}
                  </span>
                )}
              </div>

              {takedowns?.rows?.length ? (
                <div className="space-y-2">
                  {takedowns.rows.map((usage) => (
                    <div
                      key={usage._id}
                      className={`flex flex-wrap items-start justify-between gap-2 rounded px-3 py-2 ${
                        usage.overdueDays > 0 ? 'bg-red-50' : 'bg-gray-50'
                      }`}
                    >
                      <div>
                        <p className="text-sm text-gray-800">
                          {usage.assetLabel || usage.assetReference}
                        </p>
                        <p className="text-xs text-gray-600 mt-0.5">
                          {channelLabel(usage.channel)} · {usage.students.length} child(ren) ·{' '}
                          published {formatDate(usage.publishedAt)}
                        </p>
                        <p
                          className={`text-xs mt-0.5 ${
                            usage.overdueDays > 0 ? 'text-red-700 font-medium' : 'text-gray-500'
                          }`}
                        >
                          {usage.overdueDays > 0
                            ? `${usage.overdueDays} day(s) overdue`
                            : `Due ${formatDate(usage.takedownDueAt)}`}
                          {usage.takedownReason ? ` · ${usage.takedownReason}` : ''}
                        </p>
                      </div>

                      <button
                        type="button"
                        disabled={busy === usage._id}
                        onClick={() => remove(usage)}
                        className="text-xs px-3 py-1.5 bg-emerald-600 text-white rounded disabled:opacity-50"
                      >
                        Mark taken down
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-500">
                  Nothing outstanding. A withdrawal that leaves photographs up is a withdrawal in
                  name only, so this queue is the thing that has to stay empty.
                </p>
              )}
            </div>

            <div className="border border-gray-100 rounded-lg p-4">
              <h3 className="font-semibold text-gray-800 text-sm mb-3">Coverage by class</h3>

              <div className="flex flex-wrap gap-2 items-end">
                <label className="text-sm">
                  <span className="block text-xs text-gray-500 mb-1">Class</span>
                  <input
                    type="text"
                    value={coverageClass}
                    onChange={(event) => setCoverageClass(event.target.value)}
                    className="border border-gray-200 rounded px-2 py-1 text-sm"
                  />
                </label>
                <button
                  type="button"
                  disabled={busy === 'coverage'}
                  onClick={loadCoverage}
                  className="text-sm px-3 py-1.5 bg-indigo-600 text-white rounded disabled:opacity-50"
                >
                  Check
                </button>
              </div>

              {coverage && (
                <div className="mt-4 space-y-2">
                  {coverage.channels.map((row) => (
                    <div key={row.channel} className="bg-gray-50 rounded px-3 py-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="text-sm text-gray-800">{channelLabel(row.channel)}</p>
                        <p className="text-xs text-gray-600">
                          {row.granted} of {coverage.studentCount} with a live permission
                        </p>
                      </div>
                      {row.missing.length > 0 && (
                        <p className="text-xs text-amber-700 mt-1">
                          No permission: {row.missing.slice(0, 8).map((s) => s.name).join(', ')}
                          {row.missing.length > 8 ? ` and ${row.missing.length - 8} more` : ''}
                        </p>
                      )}
                    </div>
                  ))}

                  <p className="text-xs text-gray-500">
                    Worst-covered channel first, because that is the one somebody is about to
                    publish on without checking.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {isStaff && !isOffice && (
          <p className="text-xs text-gray-500">
            Before a photograph goes anywhere, check the child against the channel it is going on.
            A permission for the yearbook is not a permission for social media.
          </p>
        )}
      </div>
    </div>
  );
};

export default PublicationConsentPanel;
