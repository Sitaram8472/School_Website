import { useState, useEffect, useCallback } from 'react';
import api from '../../utils/axios';

const EMPTY_COMPONENT = { label: '', amount: '', mandatory: true };

const EMPTY_STRUCTURE = {
  name: '',
  academicYear: '',
  className: '',
  dueDate: '',
  lateFeePerDay: 0,
  maxLateFee: 0,
  notes: '',
};

const PAYMENT_METHODS = ['cash', 'cheque', 'bank-transfer', 'upi', 'card', 'online'];

const STATUS_STYLES = {
  pending: 'bg-yellow-100 text-yellow-800',
  partial: 'bg-blue-100 text-blue-700',
  paid: 'bg-green-100 text-green-700',
  overdue: 'bg-red-100 text-red-700',
  waived: 'bg-purple-100 text-purple-700',
};

const money = (value, currency = 'INR') =>
  `${currency === 'INR' ? '₹' : `${currency} `}${Number(value || 0).toLocaleString('en-IN')}`;

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

/**
 * Finance-office view: define what each class is billed, generate the invoices
 * and record payments against them.
 */
const FeeAdminPanel = () => {
  const [tab, setTab] = useState('structures');

  const [structures, setStructures] = useState([]);
  const [structureForm, setStructureForm] = useState(EMPTY_STRUCTURE);
  const [components, setComponents] = useState([{ ...EMPTY_COMPONENT }]);

  const [invoices, setInvoices] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [searchTerm, setSearchTerm] = useState('');

  const [summary, setSummary] = useState(null);
  const [paymentDrafts, setPaymentDrafts] = useState({});
  const [openInvoiceId, setOpenInvoiceId] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 3000);
  };

  const fetchStructures = useCallback(async () => {
    try {
      const res = await api.get('/fees/structures');
      setStructures(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load fee structures.');
    }
  }, []);

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      if (searchTerm.trim()) params.search = searchTerm.trim();

      const res = await api.get('/fees/invoices', { params });
      setInvoices(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load invoices.');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, searchTerm]);

  const fetchSummary = useCallback(async () => {
    try {
      const res = await api.get('/fees/summary');
      setSummary(res.data.data || null);
    } catch {
      // The summary is decoration — a failure here must not blank the panel.
      setSummary(null);
    }
  }, []);

  useEffect(() => {
    fetchStructures();
    fetchSummary();
  }, [fetchStructures, fetchSummary]);

  useEffect(() => {
    if (tab !== 'invoices') return undefined;
    const timer = setTimeout(fetchInvoices, 300);
    return () => clearTimeout(timer);
  }, [tab, fetchInvoices]);

  const componentTotal = components.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);

  const updateComponent = (index, patch) =>
    setComponents((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));

  const handleCreateStructure = async (event) => {
    event.preventDefault();
    setError('');

    const cleaned = components
      .filter((c) => c.label.trim() && c.amount !== '')
      .map((c) => ({ label: c.label.trim(), amount: Number(c.amount), mandatory: c.mandatory }));

    if (!structureForm.name || !structureForm.academicYear || !structureForm.className || !structureForm.dueDate) {
      setError('Name, academic year, class and due date are required.');
      return;
    }
    if (cleaned.length === 0) {
      setError('Add at least one fee component with a label and an amount.');
      return;
    }

    try {
      await api.post('/fees/structures', { ...structureForm, components: cleaned });
      flash('Fee structure created.');
      setStructureForm(EMPTY_STRUCTURE);
      setComponents([{ ...EMPTY_COMPONENT }]);
      fetchStructures();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to create fee structure.');
    }
  };

  const handleGenerate = async (structure) => {
    if (!window.confirm(`Generate invoices for every active student in ${structure.className}?`)) return;
    try {
      const res = await api.post('/fees/invoices/generate', { feeStructureId: structure._id });
      flash(res.data.message);
      fetchSummary();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to generate invoices.');
    }
  };

  const handleDeleteStructure = async (structure) => {
    if (!window.confirm(`Remove "${structure.name}"?`)) return;
    try {
      const res = await api.delete(`/fees/structures/${structure._id}`);
      flash(res.data.message);
      fetchStructures();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to remove fee structure.');
    }
  };

  const handleRecordPayment = async (invoice) => {
    const draft = paymentDrafts[invoice._id] || {};
    if (!draft.amount) {
      setError('Enter the amount received.');
      return;
    }

    try {
      const res = await api.post(`/fees/invoices/${invoice._id}/payments`, {
        amount: Number(draft.amount),
        method: draft.method || 'cash',
        reference: draft.reference || '',
        note: draft.note || '',
      });
      setInvoices((prev) => prev.map((i) => (i._id === invoice._id ? res.data.data : i)));
      setPaymentDrafts((prev) => ({ ...prev, [invoice._id]: {} }));
      flash(res.data.message);
      fetchSummary();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to record payment.');
    }
  };

  return (
    <div className="bg-white rounded-3xl shadow-xl p-6 md:p-8">
      <h2 className="text-2xl font-bold text-gray-800 mb-6">💰 Fee Administration</h2>

      {/* Collection summary */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          {[
            { label: 'Invoices', value: summary.invoiceCount },
            { label: 'Billed', value: money(summary.totalBilled) },
            { label: 'Collected', value: money(summary.totalCollected) },
            { label: 'Outstanding', value: money(summary.totalOutstanding) },
          ].map((tile) => (
            <div key={tile.label} className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-2xl p-4">
              <div className="text-xl font-bold text-gray-800">{tile.value}</div>
              <div className="text-xs text-gray-500 mt-1">{tile.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 mb-6 bg-gray-100 rounded-xl p-1">
        {[
          { id: 'structures', label: 'Fee structures' },
          { id: 'invoices', label: 'Invoices & payments' },
        ].map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition ${
              tab === item.id ? 'bg-blue-600 text-white shadow' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}
      {success && <p className="text-green-600 text-sm mb-4">{success}</p>}

      {tab === 'structures' && (
        <>
          <form onSubmit={handleCreateStructure} className="space-y-4 mb-8">
            <div className="grid md:grid-cols-2 gap-3">
              <input
                type="text"
                placeholder="Structure name, e.g. Term 1 Fees *"
                value={structureForm.name}
                onChange={(e) => setStructureForm({ ...structureForm, name: e.target.value })}
                className="border border-gray-300 rounded-lg px-4 py-2 text-sm"
              />
              <input
                type="text"
                placeholder="Academic year, e.g. 2025-26 *"
                value={structureForm.academicYear}
                onChange={(e) => setStructureForm({ ...structureForm, academicYear: e.target.value })}
                className="border border-gray-300 rounded-lg px-4 py-2 text-sm"
              />
            </div>

            <div className="grid md:grid-cols-4 gap-3">
              <input
                type="text"
                placeholder="Class, e.g. Class 10 *"
                value={structureForm.className}
                onChange={(e) => setStructureForm({ ...structureForm, className: e.target.value })}
                className="border border-gray-300 rounded-lg px-4 py-2 text-sm"
              />
              <label className="text-xs text-gray-500">
                Due date *
                <input
                  type="date"
                  value={structureForm.dueDate}
                  onChange={(e) => setStructureForm({ ...structureForm, dueDate: e.target.value })}
                  className="mt-1 w-full border border-gray-300 rounded-lg px-4 py-2 text-sm"
                />
              </label>
              <label className="text-xs text-gray-500">
                Late fee / day
                <input
                  type="number"
                  min="0"
                  value={structureForm.lateFeePerDay}
                  onChange={(e) => setStructureForm({ ...structureForm, lateFeePerDay: e.target.value })}
                  className="mt-1 w-full border border-gray-300 rounded-lg px-4 py-2 text-sm"
                />
              </label>
              <label className="text-xs text-gray-500">
                Late fee cap
                <input
                  type="number"
                  min="0"
                  value={structureForm.maxLateFee}
                  onChange={(e) => setStructureForm({ ...structureForm, maxLateFee: e.target.value })}
                  className="mt-1 w-full border border-gray-300 rounded-lg px-4 py-2 text-sm"
                />
              </label>
            </div>

            {/* Components */}
            <div className="border border-gray-200 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-semibold text-gray-700">Fee components</p>
                <p className="text-sm font-bold text-blue-700">Total {money(componentTotal)}</p>
              </div>

              <div className="space-y-2">
                {components.map((component, index) => (
                  <div key={index} className="flex flex-wrap gap-2 items-center">
                    <input
                      type="text"
                      placeholder="Label, e.g. Tuition"
                      value={component.label}
                      onChange={(e) => updateComponent(index, { label: e.target.value })}
                      className="flex-1 min-w-[140px] border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                    <input
                      type="number"
                      min="0"
                      placeholder="Amount"
                      value={component.amount}
                      onChange={(e) => updateComponent(index, { amount: e.target.value })}
                      className="w-32 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                    <label className="flex items-center gap-1.5 text-xs text-gray-500">
                      <input
                        type="checkbox"
                        checked={component.mandatory}
                        onChange={(e) => updateComponent(index, { mandatory: e.target.checked })}
                      />
                      Mandatory
                    </label>
                    {components.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setComponents((prev) => prev.filter((_, i) => i !== index))}
                        className="text-red-400 hover:text-red-600 text-xs"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setComponents((prev) => [...prev, { ...EMPTY_COMPONENT }])}
                className="mt-3 text-blue-600 hover:text-blue-800 text-xs font-medium"
              >
                + Add component
              </button>
            </div>

            <button
              type="submit"
              className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-lg text-sm font-medium transition"
            >
              Create fee structure
            </button>
          </form>

          {structures.length === 0 ? (
            <p className="text-gray-400 text-sm text-center py-6">No fee structures defined yet.</p>
          ) : (
            <div className="space-y-3">
              {structures.map((structure) => (
                <div key={structure._id} className="bg-gray-50 rounded-2xl p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-gray-800">
                        {structure.name}
                        {!structure.isActive && (
                          <span className="ml-2 text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full">
                            inactive
                          </span>
                        )}
                      </p>
                      <div className="flex flex-wrap gap-3 mt-2 text-xs text-gray-500">
                        <span>🏫 {structure.className}</span>
                        <span>📆 {structure.academicYear}</span>
                        <span>📅 Due {formatDate(structure.dueDate)}</span>
                        <span className="font-semibold text-gray-700">
                          {money(structure.totalAmount, structure.currency)}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {structure.components.map((component) => (
                          <span
                            key={component.label}
                            className="text-[11px] bg-white border border-gray-200 px-2 py-0.5 rounded-full text-gray-600"
                          >
                            {component.label} · {money(component.amount, structure.currency)}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="flex gap-3 shrink-0">
                      <button
                        onClick={() => handleGenerate(structure)}
                        className="text-blue-600 hover:text-blue-800 text-xs font-medium"
                      >
                        Generate invoices
                      </button>
                      <button
                        onClick={() => handleDeleteStructure(structure)}
                        className="text-red-400 hover:text-red-600 text-xs"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'invoices' && (
        <>
          <div className="flex flex-wrap gap-3 mb-4">
            <input
              type="text"
              placeholder="Search by student name..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="flex-1 min-w-[180px] border border-gray-300 rounded-lg px-4 py-2 text-sm"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="border border-gray-300 rounded-lg px-4 py-2 text-sm"
            >
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="partial">Partially paid</option>
              <option value="paid">Paid</option>
              <option value="overdue">Overdue</option>
              <option value="waived">Waived</option>
            </select>
          </div>

          {loading ? (
            <p className="text-gray-400 text-sm text-center py-6">Loading invoices...</p>
          ) : invoices.length === 0 ? (
            <p className="text-gray-400 text-sm text-center py-6">
              No invoices match these filters. Generate some from a fee structure.
            </p>
          ) : (
            <div className="space-y-3">
              {invoices.map((invoice) => {
                const draft = paymentDrafts[invoice._id] || {};
                const isOpen = openInvoiceId === invoice._id;

                return (
                  <div key={invoice._id} className="bg-gray-50 rounded-2xl p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-gray-800 text-sm">
                          {invoice.student?.name || invoice.studentName}
                          <span
                            className={`ml-2 text-[11px] px-2 py-0.5 rounded-full ${
                              STATUS_STYLES[invoice.status] || STATUS_STYLES.pending
                            }`}
                          >
                            {invoice.status}
                          </span>
                        </p>
                        <div className="flex flex-wrap gap-3 mt-2 text-xs text-gray-500">
                          <span>🧾 {invoice.invoiceNumber}</span>
                          <span>🏫 {invoice.className}</span>
                          <span>📅 Due {formatDate(invoice.dueDate)}</span>
                        </div>
                      </div>

                      <div className="text-right">
                        <p className="text-sm font-bold text-gray-800">
                          {money(invoice.balance, invoice.currency)}
                        </p>
                        <p className="text-[11px] text-gray-500">
                          paid {money(invoice.amountPaid, invoice.currency)} of{' '}
                          {money(invoice.totalAmount, invoice.currency)}
                        </p>
                        <button
                          onClick={() => setOpenInvoiceId(isOpen ? null : invoice._id)}
                          className="text-blue-600 hover:text-blue-800 text-xs mt-1"
                        >
                          {isOpen ? 'Close' : 'Record payment'}
                        </button>
                      </div>
                    </div>

                    {isOpen && invoice.status !== 'paid' && invoice.status !== 'waived' && (
                      <div className="mt-4 border-t border-gray-200 pt-4 flex flex-wrap gap-2 items-center">
                        <input
                          type="number"
                          min="1"
                          placeholder="Amount"
                          value={draft.amount || ''}
                          onChange={(e) =>
                            setPaymentDrafts((prev) => ({
                              ...prev,
                              [invoice._id]: { ...prev[invoice._id], amount: e.target.value },
                            }))
                          }
                          className="w-32 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                        />
                        <select
                          value={draft.method || 'cash'}
                          onChange={(e) =>
                            setPaymentDrafts((prev) => ({
                              ...prev,
                              [invoice._id]: { ...prev[invoice._id], method: e.target.value },
                            }))
                          }
                          className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
                        >
                          {PAYMENT_METHODS.map((method) => (
                            <option key={method} value={method}>
                              {method}
                            </option>
                          ))}
                        </select>
                        <input
                          type="text"
                          placeholder="Reference / receipt no."
                          value={draft.reference || ''}
                          onChange={(e) =>
                            setPaymentDrafts((prev) => ({
                              ...prev,
                              [invoice._id]: { ...prev[invoice._id], reference: e.target.value },
                            }))
                          }
                          className="flex-1 min-w-[160px] border border-gray-300 rounded-lg px-3 py-2 text-sm"
                        />
                        <button
                          onClick={() => handleRecordPayment(invoice)}
                          className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg text-sm"
                        >
                          Save payment
                        </button>
                      </div>
                    )}

                    {isOpen && invoice.payments?.length > 0 && (
                      <div className="mt-3 space-y-1">
                        {invoice.payments.map((payment, index) => (
                          <p key={index} className="text-xs text-gray-500">
                            {formatDate(payment.paidAt)} · {money(payment.amount, invoice.currency)} ·{' '}
                            {payment.method}
                            {payment.reference && ` · ${payment.reference}`}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default FeeAdminPanel;
