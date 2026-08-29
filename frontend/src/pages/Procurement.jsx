import { useState, useEffect, useContext, useCallback } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * Procurement — budgets, requisitions, quotations and receipts.
 *
 * The bar at the top of each budget line is split three ways: spent, committed,
 * available. The middle segment is the one nobody in the school has ever been
 * able to see, and it is the reason two departments both spend the same
 * remaining rupee.
 *
 * The quotation table names the lowest itself and asks for a reason the moment
 * a different one is selected. The receipt form is pre-filled with what is
 * still outstanding per line, so a short delivery is recorded as a short
 * delivery in ten seconds rather than discovered by the auditor.
 */

const STATUS_STYLES = {
  draft: 'bg-slate-100 text-slate-700',
  submitted: 'bg-indigo-100 text-indigo-700',
  quoting: 'bg-indigo-100 text-indigo-700',
  approved: 'bg-green-100 text-green-700',
  ordered: 'bg-blue-100 text-blue-700',
  'partially-received': 'bg-amber-100 text-amber-800',
  received: 'bg-teal-100 text-teal-800',
  closed: 'bg-gray-200 text-gray-600',
  rejected: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-200 text-gray-600',
};

const ENCUMBRANCE_LABELS = {
  none: 'No budget held',
  held: 'Holding budget',
  released: 'Released',
  converted: 'Converted to spend',
};

const emptyLine = {
  code: '',
  financialYear: '',
  department: '',
  title: '',
  allocated: 0,
};

const emptyRequisition = {
  budgetLine: '',
  department: '',
  justification: '',
  neededBy: '',
};

const emptyItem = { description: '', quantity: 1, unit: 'each', estimatedUnitCost: 0 };

const emptyQuote = { vendorName: '', vendorContact: '', amount: 0, note: '' };

const currentFinancialYear = () => {
  const now = new Date();
  const startYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
};

const rupees = (value) =>
  typeof value === 'number' ? `₹${value.toLocaleString('en-IN')}` : '—';

const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
};

const StatusChip = ({ status }) => (
  <span
    className={`px-2 py-0.5 rounded text-xs font-medium ${
      STATUS_STYLES[status] || 'bg-gray-100 text-gray-600'
    }`}
  >
    {status}
  </span>
);

/** Spent, committed, available — the three numbers, in one bar. */
const BudgetBar = ({ line }) => {
  const allocated = line.allocated || 1;
  const spentPct = Math.min(100, Math.round((line.spent / allocated) * 100));
  const committedPct = Math.min(100 - spentPct, Math.round((line.committed / allocated) * 100));

  return (
    <div>
      <div className="flex h-3 w-full rounded overflow-hidden bg-gray-100">
        <div className="bg-blue-600" style={{ width: `${spentPct}%` }} />
        <div className="bg-amber-400" style={{ width: `${committedPct}%` }} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600 mt-2">
        <span>
          <span className="inline-block w-2 h-2 rounded-sm bg-blue-600 mr-1" />
          Spent {rupees(line.spent)}
        </span>
        <span>
          <span className="inline-block w-2 h-2 rounded-sm bg-amber-400 mr-1" />
          Committed {rupees(line.committed)}
        </span>
        <span className="font-medium text-gray-800">Available {rupees(line.available)}</span>
        <span className="text-gray-400">of {rupees(line.allocated)}</span>
      </div>
    </div>
  );
};

const Procurement = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';
  const isOffice = role === 'admin' || role === 'staff';

  const [tab, setTab] = useState('mine');
  const [meta, setMeta] = useState(null);

  const [budgetLines, setBudgetLines] = useState([]);
  const [mine, setMine] = useState([]);
  const [queue, setQueue] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [showLineForm, setShowLineForm] = useState(false);
  const [lineForm, setLineForm] = useState({
    ...emptyLine,
    financialYear: currentFinancialYear(),
  });

  const [showReqForm, setShowReqForm] = useState(false);
  const [reqForm, setReqForm] = useState({ ...emptyRequisition });
  const [items, setItems] = useState([{ ...emptyItem }]);

  const [quoteForm, setQuoteForm] = useState({ ...emptyQuote });
  const [receiptLines, setReceiptLines] = useState({});

  const readError = (err, fallback) => err?.response?.data?.message || fallback;

  const clearMessages = () => {
    setError('');
    setNotice('');
  };

  const loadMeta = useCallback(async () => {
    try {
      const { data } = await api.get('/procurement/meta');
      setMeta(data.data);
    } catch {
      // The form falls back to its own defaults.
    }
  }, []);

  const loadBudget = useCallback(async () => {
    try {
      const { data } = await api.get('/procurement/budget-lines');
      setBudgetLines(data.data || []);
    } catch (err) {
      setError(readError(err, 'Could not load budget lines'));
    }
  }, []);

  const loadMine = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/procurement/requisitions/mine');
      setMine(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load your requisitions'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadQueue = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    try {
      const { data } = await api.get('/procurement/requisitions');
      setQueue(data.data || []);
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the approval queue'));
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  const loadDetail = useCallback(async (id) => {
    if (!id) return;
    setLoading(true);
    try {
      const { data } = await api.get(`/procurement/requisitions/${id}`);
      setDetail(data.data);
      setReceiptLines(
        Object.fromEntries(
          (data.data.outstanding || []).map((line) => [line.itemIndex, line.outstanding])
        )
      );
      setError('');
    } catch (err) {
      setError(readError(err, 'Could not load the requisition'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMeta();
    loadBudget();
  }, [loadMeta, loadBudget]);

  useEffect(() => {
    if (tab === 'mine') loadMine();
    if (tab === 'queue') loadQueue();
  }, [tab, loadMine, loadQueue]);

  useEffect(() => {
    if (openId) loadDetail(openId);
  }, [openId, loadDetail]);

  const submitLine = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      await api.post('/procurement/budget-lines', {
        ...lineForm,
        allocated: Number(lineForm.allocated),
      });
      setNotice('Budget line created.');
      setShowLineForm(false);
      setLineForm({ ...emptyLine, financialYear: currentFinancialYear() });
      loadBudget();
    } catch (err) {
      setError(readError(err, 'Could not create the budget line'));
    }
  };

  const submitRequisition = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      const { data } = await api.post('/procurement/requisitions', {
        ...reqForm,
        items: items
          .filter((item) => item.description)
          .map((item) => ({
            ...item,
            quantity: Number(item.quantity),
            estimatedUnitCost: Number(item.estimatedUnitCost),
          })),
      });
      setNotice(data.message);
      setShowReqForm(false);
      setReqForm({ ...emptyRequisition });
      setItems([{ ...emptyItem }]);
      loadMine();
    } catch (err) {
      setError(readError(err, 'Could not raise the requisition'));
    }
  };

  const act = async (path, body, verb) => {
    clearMessages();
    try {
      const { data } = await api.patch(`/procurement/requisitions/${openId}/${path}`, body);
      setNotice(data.message);
      loadDetail(openId);
      loadBudget();
      loadMine();
      loadQueue();
    } catch (err) {
      setError(readError(err, `Could not ${verb}`));
    }
  };

  const submitQuote = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      const { data } = await api.post(`/procurement/requisitions/${openId}/quotes`, {
        ...quoteForm,
        amount: Number(quoteForm.amount),
      });
      setNotice(data.message);
      setQuoteForm({ ...emptyQuote });
      loadDetail(openId);
    } catch (err) {
      setError(readError(err, 'Could not record the quotation'));
    }
  };

  const selectQuote = async (quoteId, isLowest) => {
    let justification = '';
    if (!isLowest) {
      justification =
        window.prompt('This is not the lowest quotation. Why is it the right one?') || '';
      if (!justification) return;
    }
    clearMessages();
    try {
      const { data } = await api.patch(
        `/procurement/requisitions/${openId}/quotes/${quoteId}/select`,
        { justification }
      );
      setNotice(data.message);
      loadDetail(openId);
    } catch (err) {
      setError(readError(err, 'Could not select the quotation'));
    }
  };

  const submitReceipt = async () => {
    clearMessages();
    try {
      const { data } = await api.post(`/procurement/requisitions/${openId}/receipts`, {
        lines: Object.entries(receiptLines)
          .map(([itemIndex, quantity]) => ({
            itemIndex: Number(itemIndex),
            quantity: Number(quantity),
          }))
          .filter((line) => line.quantity > 0),
      });
      setNotice(data.message);
      loadDetail(openId);
    } catch (err) {
      setError(readError(err, 'Could not record the receipt'));
    }
  };

  const requisition = detail?.requisition;
  const units = meta?.units || ['each'];
  const threshold = meta?.threeQuoteThreshold ?? 25000;

  const listFor = tab === 'queue' ? queue : mine;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Procurement</h1>
        <p className="text-gray-600 mt-1">
          An approval takes the money out of the available balance straight away, and every way out
          of a requisition puts it back exactly once.
        </p>
      </header>

      <div className="flex gap-2 mb-6 border-b">
        <button
          type="button"
          onClick={() => setTab('mine')}
          className={`px-4 py-2 text-sm font-medium border-b-2 ${
            tab === 'mine'
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          My requisitions
        </button>
        <button
          type="button"
          onClick={() => setTab('budget')}
          className={`px-4 py-2 text-sm font-medium border-b-2 ${
            tab === 'budget'
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Budget
        </button>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setTab('queue')}
            className={`px-4 py-2 text-sm font-medium border-b-2 ${
              tab === 'queue'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            All requisitions
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded bg-red-50 text-red-700 border border-red-200">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 px-4 py-3 rounded bg-green-50 text-green-700 border border-green-200">
          {notice}
        </div>
      )}
      {loading && <p className="text-gray-500 mb-4">Loading…</p>}

      {tab === 'budget' && (
        <section>
          {isAdmin && (
            <div className="mb-4">
              <button
                type="button"
                onClick={() => setShowLineForm((open) => !open)}
                className="px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
              >
                {showLineForm ? 'Cancel' : 'New budget line'}
              </button>
            </div>
          )}

          {showLineForm && (
            <form onSubmit={submitLine} className="bg-white rounded-lg border p-5 mb-6">
              <div className="grid md:grid-cols-5 gap-4">
                <label className="text-sm">
                  <span className="text-gray-600">Code</span>
                  <input
                    required
                    value={lineForm.code}
                    onChange={(e) => setLineForm({ ...lineForm, code: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Financial year</span>
                  <input
                    required
                    value={lineForm.financialYear}
                    onChange={(e) => setLineForm({ ...lineForm, financialYear: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Department</span>
                  <input
                    required
                    value={lineForm.department}
                    onChange={(e) => setLineForm({ ...lineForm, department: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Title</span>
                  <input
                    required
                    value={lineForm.title}
                    onChange={(e) => setLineForm({ ...lineForm, title: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Allocation</span>
                  <input
                    type="number"
                    min="0"
                    value={lineForm.allocated}
                    onChange={(e) => setLineForm({ ...lineForm, allocated: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
              </div>
              <button
                type="submit"
                className="mt-4 px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
              >
                Create line
              </button>
            </form>
          )}

          <div className="space-y-4">
            {budgetLines.map((line) => (
              <article key={line._id} className="bg-white rounded-lg border p-5">
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div>
                    <h3 className="font-semibold text-gray-900">
                      {line.code} · {line.title}
                    </h3>
                    <p className="text-sm text-gray-600">
                      {line.department} · {line.financialYear}
                    </p>
                  </div>
                  <span className="text-sm text-gray-500">{line.utilisation}% used</span>
                </div>
                <BudgetBar line={line} />
              </article>
            ))}
            {budgetLines.length === 0 && <p className="text-gray-500">No budget lines yet.</p>}
          </div>
        </section>
      )}

      {tab !== 'budget' && !openId && (
        <section>
          {tab === 'mine' && (
            <div className="mb-4">
              <button
                type="button"
                onClick={() => setShowReqForm((open) => !open)}
                className="px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
              >
                {showReqForm ? 'Cancel' : 'Raise a requisition'}
              </button>
            </div>
          )}

          {showReqForm && (
            <form onSubmit={submitRequisition} className="bg-white rounded-lg border p-5 mb-6">
              <div className="grid md:grid-cols-3 gap-4">
                <label className="text-sm">
                  <span className="text-gray-600">Budget line</span>
                  <select
                    required
                    value={reqForm.budgetLine}
                    onChange={(e) => setReqForm({ ...reqForm, budgetLine: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  >
                    <option value="">Choose…</option>
                    {budgetLines.map((line) => (
                      <option key={line._id} value={line._id}>
                        {line.code} — {rupees(line.available)} available
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Department</span>
                  <input
                    value={reqForm.department}
                    onChange={(e) => setReqForm({ ...reqForm, department: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-gray-600">Needed by</span>
                  <input
                    type="date"
                    value={reqForm.neededBy}
                    onChange={(e) => setReqForm({ ...reqForm, neededBy: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
                <label className="text-sm md:col-span-3">
                  <span className="text-gray-600">What is this for</span>
                  <textarea
                    required
                    rows="2"
                    value={reqForm.justification}
                    onChange={(e) => setReqForm({ ...reqForm, justification: e.target.value })}
                    className="mt-1 w-full border rounded px-3 py-2"
                  />
                </label>
              </div>

              <div className="mt-4 border-t pt-4">
                <p className="text-sm font-medium text-gray-700 mb-2">Items</p>
                {items.map((item, index) => (
                  <div key={index} className="grid md:grid-cols-5 gap-2 mb-2">
                    <input
                      placeholder="Description"
                      value={item.description}
                      onChange={(e) => {
                        const next = [...items];
                        next[index] = { ...item, description: e.target.value };
                        setItems(next);
                      }}
                      className="border rounded px-3 py-2 text-sm md:col-span-2"
                    />
                    <input
                      type="number"
                      min="1"
                      value={item.quantity}
                      onChange={(e) => {
                        const next = [...items];
                        next[index] = { ...item, quantity: e.target.value };
                        setItems(next);
                      }}
                      className="border rounded px-3 py-2 text-sm"
                    />
                    <select
                      value={item.unit}
                      onChange={(e) => {
                        const next = [...items];
                        next[index] = { ...item, unit: e.target.value };
                        setItems(next);
                      }}
                      className="border rounded px-3 py-2 text-sm"
                    >
                      {units.map((unit) => (
                        <option key={unit} value={unit}>
                          {unit}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min="0"
                      placeholder="Unit cost"
                      value={item.estimatedUnitCost}
                      onChange={(e) => {
                        const next = [...items];
                        next[index] = { ...item, estimatedUnitCost: e.target.value };
                        setItems(next);
                      }}
                      className="border rounded px-3 py-2 text-sm"
                    />
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setItems([...items, { ...emptyItem }])}
                  className="text-sm text-blue-700"
                >
                  + another line
                </button>

                <p className="text-sm text-gray-600 mt-3">
                  Estimated{' '}
                  <span className="font-medium">
                    {rupees(
                      items.reduce(
                        (sum, item) =>
                          sum + (Number(item.quantity) || 0) * (Number(item.estimatedUnitCost) || 0),
                        0
                      )
                    )}
                  </span>
                  {items.reduce(
                    (sum, item) =>
                      sum + (Number(item.quantity) || 0) * (Number(item.estimatedUnitCost) || 0),
                    0
                  ) >= threshold && ' — three quotations will be needed before approval'}
                </p>
              </div>

              <button
                type="submit"
                className="mt-4 px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
              >
                Raise requisition
              </button>
            </form>
          )}

          <div className="space-y-3">
            {listFor.map((item) => (
              <button
                key={item._id}
                type="button"
                onClick={() => setOpenId(item._id)}
                className="w-full text-left bg-white rounded-lg border p-4 hover:border-blue-400"
              >
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="font-semibold text-gray-900">
                      {item.ref || 'Draft'} · {rupees(item.estimatedValue)}
                    </p>
                    <p className="text-sm text-gray-600 line-clamp-1">{item.justification}</p>
                    <p className="text-xs text-gray-500 mt-1">
                      {item.budgetLine?.code} · raised {formatDate(item.createdAt)}
                      {item.poNumber && ` · ${item.poNumber}`}
                    </p>
                  </div>
                  <StatusChip status={item.status} />
                </div>
              </button>
            ))}
            {listFor.length === 0 && !loading && (
              <p className="text-gray-500">Nothing here yet.</p>
            )}
          </div>
        </section>
      )}

      {openId && requisition && (
        <section>
          <button
            type="button"
            onClick={() => {
              setOpenId(null);
              setDetail(null);
            }}
            className="text-sm text-blue-700 mb-4"
          >
            ← Back
          </button>

          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <h2 className="text-2xl font-semibold text-gray-900">
                {requisition.ref || 'Draft requisition'}
              </h2>
              <p className="text-sm text-gray-600">
                {requisition.department} · {requisition.budgetLine?.code} ·{' '}
                {rupees(requisition.estimatedValue)} estimated
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <StatusChip status={requisition.status} />
              <span className="text-xs text-gray-500">
                {ENCUMBRANCE_LABELS[requisition.encumbrance?.state]}
                {requisition.encumbrance?.state === 'held' &&
                  ` — ${rupees(requisition.encumbrance.amount)}`}
              </span>
            </div>
          </div>

          <p className="text-gray-700 mb-4">{requisition.justification}</p>

          {detail.approvalBlocker && (
            <div className="mb-4 px-4 py-3 rounded bg-amber-50 text-amber-800 border border-amber-200">
              {detail.approvalBlocker}
            </div>
          )}

          <div className="bg-white rounded-lg border overflow-x-auto mb-6">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-4 py-2">Item</th>
                  <th className="text-right px-4 py-2">Ordered</th>
                  <th className="text-right px-4 py-2">Received</th>
                  <th className="text-right px-4 py-2">Outstanding</th>
                  <th className="text-right px-4 py-2">Unit cost</th>
                </tr>
              </thead>
              <tbody>
                {detail.outstanding.map((line) => (
                  <tr key={line.itemIndex} className="border-t">
                    <td className="px-4 py-2">{line.description}</td>
                    <td className="px-4 py-2 text-right">{line.ordered}</td>
                    <td className="px-4 py-2 text-right">{line.received}</td>
                    <td
                      className={`px-4 py-2 text-right ${
                        line.outstanding > 0 ? 'text-amber-700 font-medium' : 'text-gray-400'
                      }`}
                    >
                      {line.outstanding}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-500">
                      {rupees(requisition.items[line.itemIndex]?.estimatedUnitCost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bg-white rounded-lg border p-5 mb-6">
            <h3 className="font-semibold text-gray-900 mb-3">
              Quotations
              {requisition.needsThreeQuotes && (
                <span className="ml-2 text-xs font-normal text-gray-500">
                  {requisition.quotes.length} of {meta?.minQuotesAboveThreshold ?? 3} required
                </span>
              )}
            </h3>

            <table className="w-full text-sm mb-4">
              <tbody>
                {requisition.quotes.map((quote) => {
                  const isLowest = quote.amount === requisition.lowestQuote?.amount;
                  return (
                    <tr key={quote._id} className="border-b last:border-0">
                      <td className="py-2">
                        {quote.vendorName}
                        {isLowest && (
                          <span className="ml-2 text-xs text-green-700 font-medium">lowest</span>
                        )}
                        {quote.isSelected && (
                          <span className="ml-2 text-xs text-blue-700 font-medium">selected</span>
                        )}
                      </td>
                      <td className="py-2 text-right font-medium">{rupees(quote.amount)}</td>
                      <td className="py-2 text-right">
                        {isOffice && !quote.isSelected && (
                          <button
                            type="button"
                            onClick={() => selectQuote(quote._id, isLowest)}
                            className="text-xs text-blue-700 hover:underline"
                          >
                            select
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {requisition.quotes.length === 0 && (
                  <tr>
                    <td className="py-2 text-gray-500">No quotations recorded.</td>
                  </tr>
                )}
              </tbody>
            </table>

            {requisition.selectionJustification && (
              <p className="text-sm text-gray-600 mb-4">
                Why this one: {requisition.selectionJustification}
              </p>
            )}

            {isOffice && ['submitted', 'quoting'].includes(requisition.status) && (
              <form onSubmit={submitQuote} className="grid md:grid-cols-4 gap-2">
                <input
                  required
                  placeholder="Vendor"
                  value={quoteForm.vendorName}
                  onChange={(e) => setQuoteForm({ ...quoteForm, vendorName: e.target.value })}
                  className="border rounded px-3 py-2 text-sm"
                />
                <input
                  placeholder="Contact"
                  value={quoteForm.vendorContact}
                  onChange={(e) => setQuoteForm({ ...quoteForm, vendorContact: e.target.value })}
                  className="border rounded px-3 py-2 text-sm"
                />
                <input
                  required
                  type="number"
                  min="0"
                  placeholder="Amount"
                  value={quoteForm.amount}
                  onChange={(e) => setQuoteForm({ ...quoteForm, amount: e.target.value })}
                  className="border rounded px-3 py-2 text-sm"
                />
                <button
                  type="submit"
                  className="px-4 py-2 rounded border text-sm font-medium hover:bg-gray-50"
                >
                  Record quotation
                </button>
              </form>
            )}
          </div>

          {['ordered', 'partially-received'].includes(requisition.status) && isOffice && (
            <div className="bg-white rounded-lg border p-5 mb-6">
              <h3 className="font-semibold text-gray-900 mb-3">Record a delivery</h3>
              <div className="space-y-2">
                {detail.outstanding
                  .filter((line) => line.outstanding > 0)
                  .map((line) => (
                    <div key={line.itemIndex} className="flex items-center gap-3">
                      <span className="text-sm text-gray-700 flex-1">{line.description}</span>
                      <input
                        type="number"
                        min="0"
                        max={line.outstanding}
                        value={receiptLines[line.itemIndex] ?? 0}
                        onChange={(e) =>
                          setReceiptLines({
                            ...receiptLines,
                            [line.itemIndex]: e.target.value,
                          })
                        }
                        className="border rounded px-3 py-1 text-sm w-24"
                      />
                      <span className="text-xs text-gray-500 w-24">
                        of {line.outstanding} left
                      </span>
                    </div>
                  ))}
              </div>
              <button
                type="button"
                onClick={submitReceipt}
                className="mt-4 px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
              >
                Record receipt
              </button>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {requisition.status === 'draft' && (
              <button
                type="button"
                onClick={() => act('submit', {}, 'submit it')}
                className="px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
              >
                Submit
              </button>
            )}
            {isAdmin && ['submitted', 'quoting'].includes(requisition.status) && (
              <>
                <button
                  type="button"
                  onClick={() => act('approve', {}, 'approve it')}
                  className="px-4 py-2 rounded bg-green-600 text-white text-sm font-medium hover:bg-green-700"
                >
                  Approve &amp; commit budget
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const note = window.prompt('Why is this being rejected?');
                    if (note) act('reject', { note }, 'reject it');
                  }}
                  className="px-4 py-2 rounded border border-red-200 text-red-700 text-sm font-medium hover:bg-red-50"
                >
                  Reject
                </button>
              </>
            )}
            {isAdmin && requisition.status === 'approved' && (
              <button
                type="button"
                onClick={() => act('order', {}, 'place the order')}
                className="px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
              >
                Place order
              </button>
            )}
            {isAdmin && ['received', 'partially-received'].includes(requisition.status) && (
              <button
                type="button"
                onClick={() => {
                  const invoicedAmount = window.prompt(
                    'Invoice amount (blank uses the committed figure)'
                  );
                  act(
                    'close',
                    invoicedAmount ? { invoicedAmount: Number(invoicedAmount) } : {},
                    'close it'
                  );
                }}
                className="px-4 py-2 rounded bg-teal-600 text-white text-sm font-medium hover:bg-teal-700"
              >
                Close &amp; convert to spend
              </button>
            )}
            {!['closed', 'cancelled', 'rejected'].includes(requisition.status) && (
              <button
                type="button"
                onClick={() => {
                  const note = window.prompt('Why is this being cancelled?') || '';
                  if (note) act('cancel', { note }, 'cancel it');
                }}
                className="px-4 py-2 rounded border text-sm font-medium hover:bg-gray-50"
              >
                Cancel
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
};

export default Procurement;
