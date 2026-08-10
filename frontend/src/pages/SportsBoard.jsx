import { useState, useEffect, useContext, useCallback, useMemo } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * Inter-house sports: standings, fixtures and a day schedule.
 *
 * Standings is the default tab because that is what almost everybody opens the
 * page for. It is also the tab with no controls on it at all — the table is
 * derived server-side from results, so there is nothing here that could edit it
 * even if somebody wanted to.
 *
 * Staff get result entry inline on each fixture row rather than on a separate
 * admin screen. One page with different affordances stays in step with itself;
 * two pages do not.
 */

const HOUSE_STYLES = {
  Falcon: 'bg-blue-100 text-blue-800',
  Phoenix: 'bg-red-100 text-red-800',
  Titan: 'bg-amber-100 text-amber-800',
  Vanguard: 'bg-emerald-100 text-emerald-800',
};

const STATUS_STYLES = {
  scheduled: 'bg-slate-100 text-slate-700',
  'in-progress': 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  walkover: 'bg-purple-100 text-purple-700',
  abandoned: 'bg-orange-100 text-orange-700',
  cancelled: 'bg-gray-200 text-gray-600',
};

const STATUS_LABELS = {
  scheduled: 'Scheduled',
  'in-progress': 'Under way',
  completed: 'Result in',
  walkover: 'Walkover',
  abandoned: 'Abandoned',
  cancelled: 'Cancelled',
};

const emptyFixture = {
  sport: 'football',
  stage: 'league',
  season: '',
  ageGroup: 'open',
  date: '',
  startTime: '',
  endTime: '',
  venue: '',
  homeHouse: 'Falcon',
  awayHouse: 'Phoenix',
};

const todayKey = () => {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
};

/** The season a date falls in, as the `2026-27` string the model wants. */
const currentSeason = () => {
  const now = new Date();
  // A school year turns over in July, so January still belongs to the season
  // that started the previous summer.
  const startYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
};

const formatDate = (value) => {
  if (!value) return '';
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
};

const titleCase = (value) =>
  String(value || '')
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

const HouseChip = ({ house }) => (
  <span
    className={`px-2 py-0.5 rounded text-xs font-semibold ${
      HOUSE_STYLES[house] || 'bg-gray-100 text-gray-700'
    }`}
  >
    {house}
  </span>
);

const StatusChip = ({ status }) => (
  <span
    className={`px-2 py-0.5 rounded text-xs font-medium ${
      STATUS_STYLES[status] || 'bg-gray-100 text-gray-700'
    }`}
  >
    {STATUS_LABELS[status] || status}
  </span>
);

const SportsBoard = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const canManage = role === 'admin' || role === 'teacher';

  const [tab, setTab] = useState('standings');
  const [meta, setMeta] = useState(null);
  const [season, setSeason] = useState(currentSeason());
  const [sportFilter, setSportFilter] = useState('');

  const [standings, setStandings] = useState(null);
  const [fixtures, setFixtures] = useState([]);
  const [schedule, setSchedule] = useState(null);
  const [scheduleDate, setScheduleDate] = useState(todayKey());

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Clash detail from a rejected create/update. Kept separate from `error`
  // because it is a list, and flattening it into one sentence loses the ids.
  const [clashes, setClashes] = useState([]);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...emptyFixture, season: currentSeason() });
  const [saving, setSaving] = useState(false);

  // Which fixture's result panel is open, and the scores typed into it.
  const [resultFor, setResultFor] = useState(null);
  const [scores, setScores] = useState({ homeScore: '', awayScore: '', notes: '' });

  const readError = useCallback((err, fallback) => {
    const data = err?.response?.data;
    setClashes(Array.isArray(data?.clashes) ? data.clashes : []);
    return data?.message || fallback;
  }, []);

  const clearMessages = () => {
    setError('');
    setNotice('');
    setClashes([]);
  };

  const loadMeta = useCallback(async () => {
    try {
      const { data } = await api.get('/sports/meta');
      setMeta(data.data);
    } catch {
      // The form falls back to its own defaults; not worth an error banner.
    }
  }, []);

  const loadStandings = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (season) params.season = season;
      if (sportFilter) params.sport = sportFilter;
      const { data } = await api.get('/sports/standings', { params });
      setStandings(data.data);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the standings'));
    } finally {
      setLoading(false);
    }
  }, [season, sportFilter, readError]);

  const loadFixtures = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (season) params.season = season;
      if (sportFilter) params.sport = sportFilter;
      const { data } = await api.get('/sports/fixtures', { params });
      setFixtures(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load fixtures'));
    } finally {
      setLoading(false);
    }
  }, [season, sportFilter, readError]);

  const loadSchedule = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/sports/schedule', {
        params: { date: scheduleDate },
      });
      setSchedule(data.data);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the schedule'));
    } finally {
      setLoading(false);
    }
  }, [scheduleDate, readError]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    if (tab === 'standings') loadStandings();
    if (tab === 'fixtures') loadFixtures();
    if (tab === 'schedule') loadSchedule();
  }, [tab, loadStandings, loadFixtures, loadSchedule]);

  const sports = meta?.sports || [];
  const houses = meta?.houses || ['Falcon', 'Phoenix', 'Titan', 'Vanguard'];

  const submitFixture = async (event) => {
    event.preventDefault();
    setSaving(true);
    clearMessages();
    try {
      await api.post('/sports/fixtures', form);
      setNotice('Fixture scheduled.');
      setShowForm(false);
      setForm({ ...emptyFixture, season });
      if (tab === 'fixtures') loadFixtures();
      if (tab === 'schedule') loadSchedule();
    } catch (err) {
      setError(readError(err, 'Could not schedule the fixture'));
    } finally {
      setSaving(false);
    }
  };

  const submitResult = async (fixtureId) => {
    clearMessages();
    try {
      await api.patch(`/sports/fixtures/${fixtureId}/result`, {
        homeScore: Number(scores.homeScore),
        awayScore: Number(scores.awayScore),
        notes: scores.notes,
      });
      setNotice('Result recorded.');
      setResultFor(null);
      setScores({ homeScore: '', awayScore: '', notes: '' });
      loadFixtures();
    } catch (err) {
      setError(readError(err, 'Could not record the result'));
    }
  };

  const clearResult = async (fixtureId) => {
    clearMessages();
    try {
      await api.delete(`/sports/fixtures/${fixtureId}/result`);
      setNotice('Result cleared; the fixture is open again.');
      loadFixtures();
    } catch (err) {
      setError(readError(err, 'Could not clear the result'));
    }
  };

  const awardWalkover = async (fixtureId, awardedTo) => {
    clearMessages();
    try {
      await api.patch(`/sports/fixtures/${fixtureId}/walkover`, { awardedTo });
      setNotice(`Walkover awarded to ${awardedTo}.`);
      loadFixtures();
    } catch (err) {
      setError(readError(err, 'Could not award the walkover'));
    }
  };

  const openResultPanel = (fixture) => {
    setResultFor(fixture._id);
    setScores({
      homeScore: fixture.homeScore ?? '',
      awayScore: fixture.awayScore ?? '',
      notes: fixture.resultNotes ?? '',
    });
  };

  const awaitingResult = useMemo(
    () =>
      fixtures.filter(
        (f) => ['scheduled', 'in-progress'].includes(f.status) && f.date < todayKey()
      ).length,
    [fixtures]
  );

  const tabs = [
    { key: 'standings', label: 'Standings' },
    { key: 'fixtures', label: 'Fixtures' },
    { key: 'schedule', label: 'Schedule' },
  ];

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-gray-800">Inter-house sports</h1>
        <p className="text-gray-600 mt-1">
          The table is calculated from recorded results every time this page is
          opened. It is never edited by hand.
        </p>
      </header>

      <div className="flex flex-wrap gap-2 mb-6 border-b border-gray-200">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => {
              setTab(entry.key);
              clearMessages();
            }}
            className={`px-4 py-2 -mb-px border-b-2 font-medium transition ${
              tab === entry.key
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 items-end mb-5">
        <label className="text-sm">
          <span className="block text-gray-600 mb-1">Season</span>
          <input
            type="text"
            value={season}
            onChange={(e) => setSeason(e.target.value)}
            placeholder="2026-27"
            className="border border-gray-300 rounded px-3 py-1.5 w-32"
          />
        </label>
        <label className="text-sm">
          <span className="block text-gray-600 mb-1">Sport</span>
          <select
            value={sportFilter}
            onChange={(e) => setSportFilter(e.target.value)}
            className="border border-gray-300 rounded px-3 py-1.5"
          >
            <option value="">All sports</option>
            {sports.map((sport) => (
              <option key={sport} value={sport}>
                {titleCase(sport)}
              </option>
            ))}
          </select>
        </label>

        {canManage && (
          <button
            type="button"
            onClick={() => {
              setShowForm((open) => !open);
              clearMessages();
            }}
            className="ml-auto bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition"
          >
            {showForm ? 'Close' : 'Schedule a fixture'}
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-red-700">
          {error}
          {clashes.length > 0 && (
            <ul className="mt-2 list-disc list-inside text-sm">
              {clashes.map((clash, index) => (
                <li key={`${clash.kind}-${index}`}>{clash.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {notice && (
        <div className="mb-4 p-3 rounded bg-green-50 border border-green-200 text-green-700">
          {notice}
        </div>
      )}

      {showForm && canManage && (
        <form
          onSubmit={submitFixture}
          className="mb-6 p-4 border border-gray-200 rounded-lg bg-gray-50 grid gap-3 md:grid-cols-3"
        >
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Sport</span>
            <select
              value={form.sport}
              onChange={(e) => setForm({ ...form, sport: e.target.value })}
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            >
              {(sports.length ? sports : ['football']).map((sport) => (
                <option key={sport} value={sport}>
                  {titleCase(sport)}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Stage</span>
            <select
              value={form.stage}
              onChange={(e) => setForm({ ...form, stage: e.target.value })}
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            >
              {(meta?.stages || ['league']).map((stage) => (
                <option key={stage} value={stage}>
                  {titleCase(stage)}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Age group</span>
            <select
              value={form.ageGroup}
              onChange={(e) => setForm({ ...form, ageGroup: e.target.value })}
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            >
              {(meta?.ageGroups || ['open']).map((group) => (
                <option key={group} value={group}>
                  {group.toUpperCase()}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Home house</span>
            <select
              value={form.homeHouse}
              onChange={(e) => setForm({ ...form, homeHouse: e.target.value })}
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            >
              {houses.map((house) => (
                <option key={house} value={house}>
                  {house}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Away house</span>
            <select
              value={form.awayHouse}
              onChange={(e) => setForm({ ...form, awayHouse: e.target.value })}
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            >
              {houses.map((house) => (
                <option key={house} value={house}>
                  {house}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Venue</span>
            <input
              type="text"
              value={form.venue}
              onChange={(e) => setForm({ ...form, venue: e.target.value })}
              placeholder="Top field"
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Date</span>
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Start</span>
            <input
              type="time"
              value={form.startTime}
              onChange={(e) => setForm({ ...form, startTime: e.target.value })}
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">End</span>
            <input
              type="time"
              value={form.endTime}
              onChange={(e) => setForm({ ...form, endTime: e.target.value })}
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Season</span>
            <input
              type="text"
              value={form.season}
              onChange={(e) => setForm({ ...form, season: e.target.value })}
              placeholder="2026-27"
              className="border border-gray-300 rounded px-3 py-1.5 w-full"
            />
          </label>

          <div className="md:col-span-3 flex gap-3">
            <button
              type="submit"
              disabled={saving}
              className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-60 transition"
            >
              {saving ? 'Checking for clashes…' : 'Schedule fixture'}
            </button>
            <span className="text-sm text-gray-500 self-center">
              The server refuses a slot where a house, the venue or an official
              is already committed.
            </span>
          </div>
        </form>
      )}

      {loading && <p className="text-gray-500">Loading…</p>}

      {tab === 'standings' && standings && !loading && (
        <section>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-100 text-gray-600 text-sm">
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">House</th>
                  <th className="px-3 py-2 text-center">P</th>
                  <th className="px-3 py-2 text-center">W</th>
                  <th className="px-3 py-2 text-center">D</th>
                  <th className="px-3 py-2 text-center">L</th>
                  <th className="px-3 py-2 text-center">For</th>
                  <th className="px-3 py-2 text-center">Ag</th>
                  <th className="px-3 py-2 text-center">Diff</th>
                  <th className="px-3 py-2 text-center font-semibold">Pts</th>
                </tr>
              </thead>
              <tbody>
                {standings.table.map((row) => (
                  <tr key={row.house} className="border-b border-gray-100">
                    <td className="px-3 py-2 text-gray-500">{row.position}</td>
                    <td className="px-3 py-2">
                      <HouseChip house={row.house} />
                    </td>
                    <td className="px-3 py-2 text-center">{row.played}</td>
                    <td className="px-3 py-2 text-center">{row.won}</td>
                    <td className="px-3 py-2 text-center">{row.drawn}</td>
                    <td className="px-3 py-2 text-center">{row.lost}</td>
                    <td className="px-3 py-2 text-center">{row.scoreFor}</td>
                    <td className="px-3 py-2 text-center">{row.scoreAgainst}</td>
                    <td className="px-3 py-2 text-center">
                      {row.scoreDifference > 0 ? `+${row.scoreDifference}` : row.scoreDifference}
                    </td>
                    <td className="px-3 py-2 text-center font-semibold">{row.points}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm text-gray-500 mt-3">
            Built from {standings.countedFixtures} completed{' '}
            {standings.countedFixtures === 1 ? 'fixture' : 'fixtures'}. Win{' '}
            {standings.points.win}, draw {standings.points.draw}, loss{' '}
            {standings.points.loss}. Abandoned matches count for nothing.
          </p>
        </section>
      )}

      {tab === 'fixtures' && !loading && (
        <section className="space-y-3">
          {canManage && awaitingResult > 0 && (
            <div className="p-3 rounded bg-amber-50 border border-amber-200 text-amber-800 text-sm">
              {awaitingResult} {awaitingResult === 1 ? 'fixture has' : 'fixtures have'}{' '}
              been played without a result recorded.
            </div>
          )}

          {fixtures.length === 0 && (
            <p className="text-gray-500">No fixtures match these filters.</p>
          )}

          {fixtures.map((fixture) => (
            <article
              key={fixture._id}
              className="border border-gray-200 rounded-lg p-4 bg-white"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-gray-500 w-32">
                  {formatDate(fixture.date)}
                  <span className="block text-xs">
                    {fixture.startTime}–{fixture.endTime}
                  </span>
                </span>

                <div className="flex items-center gap-2">
                  <HouseChip house={fixture.homeHouse} />
                  <span className="font-semibold text-gray-700">
                    {fixture.status === 'completed'
                      ? `${fixture.homeScore} – ${fixture.awayScore}`
                      : 'v'}
                  </span>
                  <HouseChip house={fixture.awayHouse} />
                </div>

                <span className="text-sm text-gray-600">
                  {titleCase(fixture.sport)} · {titleCase(fixture.stage)} ·{' '}
                  {fixture.venue}
                </span>

                <span className="ml-auto flex items-center gap-2">
                  <StatusChip status={fixture.status} />
                  {fixture.walkoverTo && (
                    <span className="text-xs text-purple-700">
                      awarded to {fixture.walkoverTo}
                    </span>
                  )}
                </span>
              </div>

              {canManage && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {['scheduled', 'in-progress'].includes(fixture.status) && (
                    <>
                      <button
                        type="button"
                        onClick={() => openResultPanel(fixture)}
                        className="text-sm px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                      >
                        Record result
                      </button>
                      <button
                        type="button"
                        onClick={() => awardWalkover(fixture._id, fixture.homeHouse)}
                        className="text-sm px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
                      >
                        Walkover to {fixture.homeHouse}
                      </button>
                      <button
                        type="button"
                        onClick={() => awardWalkover(fixture._id, fixture.awayHouse)}
                        className="text-sm px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
                      >
                        Walkover to {fixture.awayHouse}
                      </button>
                    </>
                  )}
                  {['completed', 'walkover', 'abandoned'].includes(fixture.status) && (
                    <button
                      type="button"
                      onClick={() => clearResult(fixture._id)}
                      className="text-sm px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
                    >
                      Clear result
                    </button>
                  )}
                </div>
              )}

              {resultFor === fixture._id && (
                <div className="mt-3 p-3 rounded bg-gray-50 border border-gray-200 flex flex-wrap gap-3 items-end">
                  <label className="text-sm">
                    <span className="block text-gray-600 mb-1">
                      {fixture.homeHouse}
                    </span>
                    <input
                      type="number"
                      min="0"
                      value={scores.homeScore}
                      onChange={(e) =>
                        setScores({ ...scores, homeScore: e.target.value })
                      }
                      className="border border-gray-300 rounded px-3 py-1.5 w-20"
                    />
                  </label>
                  <label className="text-sm">
                    <span className="block text-gray-600 mb-1">
                      {fixture.awayHouse}
                    </span>
                    <input
                      type="number"
                      min="0"
                      value={scores.awayScore}
                      onChange={(e) =>
                        setScores({ ...scores, awayScore: e.target.value })
                      }
                      className="border border-gray-300 rounded px-3 py-1.5 w-20"
                    />
                  </label>
                  <label className="text-sm grow">
                    <span className="block text-gray-600 mb-1">Notes</span>
                    <input
                      type="text"
                      value={scores.notes}
                      onChange={(e) => setScores({ ...scores, notes: e.target.value })}
                      className="border border-gray-300 rounded px-3 py-1.5 w-full"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => submitResult(fixture._id)}
                    className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setResultFor(null)}
                    className="px-4 py-2 rounded border border-gray-300 hover:bg-gray-100"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </article>
          ))}
        </section>
      )}

      {tab === 'schedule' && !loading && (
        <section>
          <label className="text-sm block mb-4">
            <span className="block text-gray-600 mb-1">Day</span>
            <input
              type="date"
              value={scheduleDate}
              onChange={(e) => setScheduleDate(e.target.value)}
              className="border border-gray-300 rounded px-3 py-1.5"
            />
          </label>

          {schedule && schedule.venues.length === 0 && (
            <p className="text-gray-500">Nothing scheduled on this day.</p>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            {schedule?.venues.map((venueBlock) => (
              <div
                key={venueBlock.venue}
                className="border border-gray-200 rounded-lg p-4 bg-white"
              >
                <h3 className="font-semibold text-gray-800 mb-2">
                  {venueBlock.venue}
                </h3>
                <ul className="space-y-2">
                  {venueBlock.fixtures.map((fixture) => (
                    <li
                      key={fixture._id}
                      className="flex items-center gap-2 text-sm"
                    >
                      <span className="text-gray-500 w-24">
                        {fixture.startTime}–{fixture.endTime}
                      </span>
                      <HouseChip house={fixture.homeHouse} />
                      <span className="text-gray-400">v</span>
                      <HouseChip house={fixture.awayHouse} />
                      <span className="text-gray-500 ml-auto">
                        {titleCase(fixture.sport)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};

export default SportsBoard;
