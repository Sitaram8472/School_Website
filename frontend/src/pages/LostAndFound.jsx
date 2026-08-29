import { useState, useEffect, useContext, useCallback } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';

/**
 * Lost and found register.
 *
 * One page, two audiences. A student searches, reports and claims. Desk staff
 * get the extra controls inline — a separate dashboard tab would mean the
 * person holding the item has to go somewhere else to log it.
 *
 * Note what is *not* on this page for a student: the distinguishing marks. The
 * server withholds them, and the claim form says so, because a listing that
 * described the chipped hinge would tell every claimant how to pass the test.
 */

const CATEGORIES = [
  'electronics', 'stationery', 'clothing', 'books', 'id-card',
  'jewellery', 'sports', 'documents', 'other',
];

const STATUS_STYLES = {
  registered: 'bg-gray-100 text-gray-700',
  stored: 'bg-blue-100 text-blue-700',
  'claim-pending': 'bg-amber-100 text-amber-800',
  matched: 'bg-indigo-100 text-indigo-700',
  'handed-over': 'bg-green-100 text-green-700',
  disposed: 'bg-gray-200 text-gray-500',
  expired: 'bg-orange-100 text-orange-700',
  withdrawn: 'bg-gray-200 text-gray-500',
};

const CLAIM_STATUS_STYLES = {
  pending: 'bg-amber-100 text-amber-800',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  withdrawn: 'bg-gray-200 text-gray-500',
};

const emptyReport = {
  kind: 'lost',
  title: '',
  description: '',
  category: 'other',
  colour: '',
  brand: '',
  location: '',
  occurredOn: new Date().toISOString().split('T')[0],
};

const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '';

const LostAndFound = () => {
  const { user } = useContext(AuthContext);
  const role = user?.role || user?.user?.role;
  const isStaff = ['teacher', 'staff', 'admin'].includes(role);

  const [items, setItems] = useState([]);
  const [stats, setStats] = useState(null);
  const [tab, setTab] = useState('search');
  const [report, setReport] = useState(emptyReport);

  const [kindFilter, setKindFilter] = useState('found');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [search, setSearch] = useState('');

  const [claimTarget, setClaimTarget] = useState(null);
  const [claimForm, setClaimForm] = useState({
    proofDescription: '',
    answeredMarks: '',
    className: '',
    contact: '',
  });

  const [expanded, setExpanded] = useState(null);
  const [deskClaims, setDeskClaims] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const flash = (message) => {
    setNotice(message);
    setTimeout(() => setNotice(''), 5000);
  };

  const load = useCallback(async () => {
    try {
      const params = {};
      if (kindFilter) params.kind = kindFilter;
      if (categoryFilter) params.category = categoryFilter;
      if (search.trim()) params.search = search.trim();
      const res = await api.get('/lost-found', { params });
      setItems(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the register.');
    }
  }, [kindFilter, categoryFilter, search]);

  const loadStats = useCallback(async () => {
    if (!isStaff) return;
    try {
      const res = await api.get('/lost-found/stats');
      setStats(res.data.stats);
    } catch (err) {
      console.error(err);
    }
  }, [isStaff]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadStats(); }, [loadStats]);

  const submitReport = async (event) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.post('/lost-found', report);
      flash(res.data.message);
      setReport(emptyReport);
      await Promise.all([load(), loadStats()]);
      setTab('search');
    } catch (err) {
      setError(err.response?.data?.message || 'Could not register that.');
    } finally {
      setBusy(false);
    }
  };

  const submitClaim = async (event) => {
    event.preventDefault();
    if (!claimTarget) return;
    setError('');
    setBusy(true);
    try {
      await api.post(`/lost-found/${claimTarget._id}/claims`, claimForm);
      flash('Claim submitted. The office will compare it against what they hold.');
      setClaimTarget(null);
      setClaimForm({ proofDescription: '', answeredMarks: '', className: '', contact: '' });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not submit that claim.');
    } finally {
      setBusy(false);
    }
  };

  const withdrawClaim = async (item, claim) => {
    setError('');
    try {
      await api.patch(`/lost-found/${item._id}/claims/${claim._id}/withdraw`);
      flash('Claim withdrawn.');
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not withdraw that claim.');
    }
  };

  const openDesk = async (item) => {
    setExpanded(item._id);
    setDeskClaims(null);
    if (!isStaff) return;
    try {
      const res = await api.get(`/lost-found/${item._id}/claims`);
      setDeskClaims(res.data);
    } catch (err) {
      console.error(err);
    }
  };

  const deskAction = async (item, path, body, message) => {
    setBusy(true);
    setError('');
    try {
      await api.patch(`/lost-found/${item._id}/${path}`, body || {});
      flash(message);
      await Promise.all([load(), loadStats()]);
      await openDesk(item);
    } catch (err) {
      setError(err.response?.data?.message || 'That action was refused.');
    } finally {
      setBusy(false);
    }
  };

  const approve = (item, claim) =>
    deskAction(
      item,
      `claims/${claim._id}/approve`,
      { note: 'Description matched what we hold.' },
      'Claim approved; any other claims on this item were rejected.'
    );

  const reject = (item, claim) => {
    const reason = window.prompt('Why is this claim being rejected?');
    if (!reason) return;
    deskAction(item, `claims/${claim._id}/reject`, { reason }, 'Claim rejected.');
  };

  const handover = (item, claim) =>
    deskAction(
      item,
      'handover',
      { to: claim.claimant, signatureNote: 'Collected in person.' },
      'Handover recorded.'
    );

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="max-w-4xl mx-auto px-4 py-8">

        <div className="bg-gradient-to-r from-orange-500 to-amber-600 rounded-2xl p-6 mb-6 text-white">
          <h1 className="text-2xl font-bold">Lost &amp; Found</h1>
          <p className="text-orange-50 mt-1 text-sm">
            Search what has been handed in, report something missing, or claim
            an item by describing it.
          </p>
          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5">
              {[
                { label: 'In storage', value: stats.inStorage },
                { label: 'Awaiting a decision', value: stats.awaitingDecision },
                { label: 'Reunited', value: stats.handedOver },
                { label: 'Past retention', value: stats.pastRetention },
              ].map((entry) => (
                <div key={entry.label} className="bg-white/15 rounded-xl p-3 text-center">
                  <div className="text-xl font-bold">{entry.value}</div>
                  <div className="text-xs text-orange-50 mt-1">{entry.label}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex gap-2 mb-6 bg-white rounded-xl p-1 shadow">
          {[
            { id: 'search', label: 'Search the register' },
            { id: 'report', label: 'Report an item' },
          ].map((entry) => (
            <button
              key={entry.id}
              onClick={() => setTab(entry.id)}
              className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition ${
                tab === entry.id
                  ? 'bg-orange-500 text-white shadow'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {notice && (
          <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-xl px-4 py-3 mb-4">
            {notice}
          </div>
        )}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3 mb-4">
            {error}
          </div>
        )}

        {tab === 'report' && (
          <div className="bg-white rounded-2xl shadow p-6">
            <form onSubmit={submitReport} className="space-y-3">
              <div className="flex gap-2">
                {[
                  { value: 'lost', label: 'I have lost something' },
                  { value: 'found', label: 'I have found something' },
                ].map((entry) => (
                  <button
                    key={entry.value}
                    type="button"
                    onClick={() => setReport({ ...report, kind: entry.value })}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium transition border ${
                      report.kind === entry.value
                        ? 'bg-orange-50 border-orange-400 text-orange-700'
                        : 'border-gray-300 text-gray-500 hover:bg-gray-50'
                    }`}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>

              <input
                type="text"
                required
                placeholder="Short title (e.g. Black wireless earbuds) *"
                value={report.title}
                onChange={(e) => setReport({ ...report, title: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              />

              <textarea
                required
                rows={3}
                placeholder="Describe it *"
                value={report.description}
                onChange={(e) => setReport({ ...report, description: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              />

              {report.kind === 'found' && !isStaff && (
                <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
                  Please hand the item in at the office. Anything distinctive
                  about it — a chip, a sticker, a name inside — is recorded there
                  and kept off the public listing, so it can be used to check
                  whoever claims it really owns it.
                </p>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <select
                  value={report.category}
                  onChange={(e) => setReport({ ...report, category: e.target.value })}
                  className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                >
                  {CATEGORIES.map((category) => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="Colour"
                  value={report.colour}
                  onChange={(e) => setReport({ ...report, colour: e.target.value })}
                  className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
                <input
                  type="text"
                  placeholder="Brand"
                  value={report.brand}
                  onChange={(e) => setReport({ ...report, brand: e.target.value })}
                  className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  type="text"
                  required
                  placeholder={report.kind === 'lost' ? 'Where did you lose it? *' : 'Where did you find it? *'}
                  value={report.location}
                  onChange={(e) => setReport({ ...report, location: e.target.value })}
                  className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
                <input
                  type="date"
                  required
                  value={report.occurredOn}
                  onChange={(e) => setReport({ ...report, occurredOn: e.target.value })}
                  className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>

              <button
                type="submit"
                disabled={busy}
                className="bg-orange-500 hover:bg-orange-600 text-white px-5 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
              >
                {busy ? 'Registering...' : 'Register'}
              </button>
            </form>
          </div>
        )}

        {tab === 'search' && (
          <>
            <div className="bg-white rounded-2xl shadow p-4 mb-6">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <select
                  value={kindFilter}
                  onChange={(e) => setKindFilter(e.target.value)}
                  className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                >
                  <option value="found">Handed in</option>
                  <option value="lost">Reported missing</option>
                  <option value="">Everything</option>
                </select>
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                >
                  <option value="">All categories</option>
                  {CATEGORIES.map((category) => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="Search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>
            </div>

            {items.length === 0 && (
              <div className="bg-white rounded-2xl shadow p-8 text-center text-gray-500 text-sm">
                Nothing in the register matches those filters.
              </div>
            )}

            <div className="space-y-3">
              {items.map((item) => {
                const isOpen = expanded === item._id;
                const myClaim = (item.claims || [])[0];

                return (
                  <div key={item._id} className="bg-white rounded-2xl shadow overflow-hidden">
                    <button
                      onClick={() => (isOpen ? setExpanded(null) : openDesk(item))}
                      className="w-full text-left px-5 py-4 hover:bg-gray-50 transition"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-xs text-gray-400">{item.ticketId}</span>
                            <span
                              className={`text-xs px-2 py-0.5 rounded-full ${
                                STATUS_STYLES[item.status] || 'bg-gray-100 text-gray-600'
                              }`}
                            >
                              {item.status}
                            </span>
                            {item.isHighValue && (
                              <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">
                                high value
                              </span>
                            )}
                          </div>
                          <h3 className="font-semibold text-gray-800 mt-1">{item.title}</h3>
                          <p className="text-sm text-gray-500">
                            {item.category}
                            {item.colour ? ` · ${item.colour}` : ''}
                            {item.brand ? ` · ${item.brand}` : ''}
                          </p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {item.kind === 'found' ? 'Found at' : 'Lost at'} {item.location}
                            {' '}on {formatDate(item.occurredOn)}
                          </p>
                        </div>

                        {myClaim && (
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
                              CLAIM_STATUS_STYLES[myClaim.status] || 'bg-gray-100 text-gray-600'
                            }`}
                          >
                            your claim: {myClaim.status}
                          </span>
                        )}
                      </div>
                    </button>

                    {isOpen && (
                      <div className="border-t border-gray-200 px-5 py-4 bg-gray-50 space-y-4">
                        <p className="text-sm text-gray-700">{item.description}</p>

                        {item.retentionUntil && (
                          <p className="text-xs text-gray-400">
                            Held until {formatDate(item.retentionUntil)}
                          </p>
                        )}

                        {myClaim && (
                          <div className="bg-white rounded-lg p-3">
                            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">
                              Your claim
                            </p>
                            <p className="text-sm text-gray-700">{myClaim.proofDescription}</p>
                            {myClaim.reviewNote && (
                              <p className="text-sm text-gray-500 mt-2">
                                Office: {myClaim.reviewNote}
                              </p>
                            )}
                            {myClaim.status === 'pending' && (
                              <button
                                onClick={() => withdrawClaim(item, myClaim)}
                                className="mt-2 text-xs text-red-600 hover:text-red-700"
                              >
                                Withdraw this claim
                              </button>
                            )}
                          </div>
                        )}

                        {item.kind === 'found' &&
                          !myClaim &&
                          !item.hasApprovedClaim &&
                          !['handed-over', 'disposed', 'withdrawn'].includes(item.status) && (
                            <button
                              onClick={() => setClaimTarget(item)}
                              className="bg-orange-500 hover:bg-orange-600 text-white text-sm px-4 py-1.5 rounded-lg transition"
                            >
                              This is mine
                            </button>
                          )}

                        {isStaff && deskClaims && (
                          <div className="border-t border-gray-200 pt-4">
                            <p className="text-xs text-gray-400 uppercase tracking-wide mb-2">
                              Desk view
                            </p>

                            <div className="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 mb-3">
                              <p className="text-xs text-purple-700 font-semibold">
                                Recorded distinguishing marks
                              </p>
                              <p className="text-sm text-purple-900">
                                {deskClaims.distinguishingMarks || 'None recorded.'}
                              </p>
                              <p className="text-xs text-purple-600 mt-1">
                                Never shown to a claimant before their claim is approved.
                              </p>
                            </div>

                            {deskClaims.data.length === 0 && (
                              <p className="text-sm text-gray-400">No claims on this item.</p>
                            )}

                            <div className="space-y-2">
                              {deskClaims.data.map((claim) => (
                                <div key={claim._id} className="bg-white rounded-lg p-3">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="text-sm font-semibold text-gray-800">
                                      {claim.claimantName}
                                      {claim.className ? ` (${claim.className})` : ''}
                                    </span>
                                    <span
                                      className={`text-xs px-2 py-0.5 rounded-full ${
                                        CLAIM_STATUS_STYLES[claim.status]
                                      }`}
                                    >
                                      {claim.status}
                                    </span>
                                  </div>
                                  <p className="text-sm text-gray-700 mt-1">
                                    {claim.proofDescription}
                                  </p>
                                  {claim.answeredMarks && (
                                    <p className="text-sm text-gray-600 mt-1">
                                      <span className="text-gray-400">Marks given:</span>{' '}
                                      {claim.answeredMarks}
                                    </p>
                                  )}
                                  {claim.reviewNote && (
                                    <p className="text-xs text-gray-400 mt-1">
                                      {claim.reviewNote}
                                    </p>
                                  )}

                                  <div className="flex flex-wrap gap-2 mt-2">
                                    {claim.status === 'pending' && (
                                      <>
                                        <button
                                          onClick={() => approve(item, claim)}
                                          disabled={busy}
                                          className="text-xs bg-green-100 text-green-700 hover:bg-green-200 px-3 py-1 rounded-full transition"
                                        >
                                          Approve
                                        </button>
                                        <button
                                          onClick={() => reject(item, claim)}
                                          disabled={busy}
                                          className="text-xs bg-red-100 text-red-700 hover:bg-red-200 px-3 py-1 rounded-full transition"
                                        >
                                          Reject
                                        </button>
                                      </>
                                    )}
                                    {claim.status === 'approved' && item.status === 'matched' && (
                                      <button
                                        onClick={() => handover(item, claim)}
                                        disabled={busy}
                                        className="text-xs bg-indigo-600 text-white hover:bg-indigo-700 px-3 py-1 rounded-full transition"
                                      >
                                        Record handover
                                      </button>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {claimTarget && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
              <div className="p-6">
                <h3 className="text-lg font-bold text-gray-800">Claim this item</h3>
                <p className="text-sm text-gray-500 mt-1">
                  {claimTarget.ticketId} — {claimTarget.title}
                </p>

                <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-4">
                  <p className="text-xs text-amber-800">
                    The listing above is deliberately vague. Whoever handed this
                    in also described the details that are <em>not</em> shown
                    here — describe them yourself and the office will compare.
                  </p>
                </div>

                <form onSubmit={submitClaim} className="mt-4 space-y-3">
                  <textarea
                    required
                    rows={4}
                    placeholder="Describe the item in your own words — marks, damage, contents, anything specific *"
                    value={claimForm.proofDescription}
                    onChange={(e) =>
                      setClaimForm({ ...claimForm, proofDescription: e.target.value })
                    }
                    className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                  <p className="text-xs text-gray-400 -mt-2">
                    {claimForm.proofDescription.length}/800 — at least 20 characters.
                  </p>

                  {claimTarget.isHighValue && (
                    <textarea
                      required
                      rows={2}
                      placeholder="This item is marked high value — what marks, damage or contents would identify it? *"
                      value={claimForm.answeredMarks}
                      onChange={(e) =>
                        setClaimForm({ ...claimForm, answeredMarks: e.target.value })
                      }
                      className="w-full border border-purple-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <input
                      type="text"
                      placeholder="Your class"
                      value={claimForm.className}
                      onChange={(e) => setClaimForm({ ...claimForm, className: e.target.value })}
                      className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                    />
                    <input
                      type="text"
                      placeholder="Contact"
                      value={claimForm.contact}
                      onChange={(e) => setClaimForm({ ...claimForm, contact: e.target.value })}
                      className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                    />
                  </div>

                  {error && <p className="text-red-600 text-sm">{error}</p>}

                  <div className="flex gap-2 pt-2">
                    <button
                      type="submit"
                      disabled={busy}
                      className="flex-1 bg-orange-500 hover:bg-orange-600 text-white text-sm py-2 rounded-lg transition disabled:opacity-50"
                    >
                      {busy ? 'Submitting...' : 'Submit claim'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setClaimTarget(null); setError(''); }}
                      className="px-5 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-lg transition"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default LostAndFound;
