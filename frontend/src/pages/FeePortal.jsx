import React, { useState, useEffect, useContext, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Receipt, Wallet, AlertCircle, Printer, CheckCircle2 } from 'lucide-react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';
import FeeAdminPanel from '../components/fees/FeeAdminPanel';

const STATUS_STYLES = {
  pending: 'bg-yellow-100 text-yellow-800',
  partial: 'bg-blue-100 text-blue-700',
  paid: 'bg-green-100 text-green-700',
  overdue: 'bg-red-100 text-red-700',
  waived: 'bg-purple-100 text-purple-700',
};

const STATUS_LABELS = {
  pending: 'Payment pending',
  partial: 'Partially paid',
  paid: 'Fully paid',
  overdue: 'Overdue',
  waived: 'Waived',
};

const money = (value, currency = 'INR') =>
  `${currency === 'INR' ? '₹' : `${currency} `}${Number(value || 0).toLocaleString('en-IN')}`;

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

/**
 * Fee portal. Students see their own invoices and receipts; admins and office
 * staff get the administration panel instead.
 */
const FeePortal = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isStaff = role === 'admin' || role === 'staff';
  const displayName = user?.name || user?.user?.name || 'Student';

  const [invoices, setInvoices] = useState([]);
  const [summary, setSummary] = useState({ totalBilled: 0, totalPaid: 0, totalOutstanding: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openReceiptId, setOpenReceiptId] = useState(null);

  const fetchMyInvoices = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/fees/invoices/me');
      setInvoices(res.data.data || []);
      setSummary(res.data.summary || { totalBilled: 0, totalPaid: 0, totalOutstanding: 0 });
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load your fee records right now.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isStaff) fetchMyInvoices();
    else setLoading(false);
  }, [isStaff, fetchMyInvoices]);

  const overdueCount = useMemo(
    () => invoices.filter((invoice) => invoice.status === 'overdue').length,
    [invoices]
  );

  const paymentProgress = useMemo(() => {
    if (!summary.totalBilled) return 0;
    return Math.min(100, Math.round((summary.totalPaid / summary.totalBilled) * 100));
  }, [summary]);

  return (
    <div
      className="min-h-screen p-4 sm:p-6"
      style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
    >
      {/* Header */}
      <div className="bg-gradient-to-r from-emerald-700 to-teal-700 text-white rounded-3xl p-8 shadow-2xl mb-8">
        <Link to="/student" className="inline-flex items-center gap-2 text-emerald-100 hover:text-white text-sm">
          <ArrowLeft size={16} /> Back to dashboard
        </Link>

        <div className="flex items-center gap-4 mt-4">
          <div className="bg-white text-emerald-700 p-4 rounded-full shadow-lg">
            <Wallet size={30} />
          </div>
          <div>
            <h1 className="text-2xl sm:text-4xl font-bold">Fees &amp; Payments</h1>
            <p className="text-emerald-100 mt-1">
              {isStaff
                ? 'Manage fee structures, invoices and collections.'
                : `Your billing history, ${displayName}.`}
            </p>
          </div>
        </div>

        {!isStaff && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
              {[
                { label: 'Total billed', value: money(summary.totalBilled) },
                { label: 'Paid', value: money(summary.totalPaid) },
                { label: 'Outstanding', value: money(summary.totalOutstanding) },
                { label: 'Overdue invoices', value: overdueCount },
              ].map((tile) => (
                <div key={tile.label} className="bg-white/15 rounded-2xl p-4">
                  <div className="text-xl font-bold">{tile.value}</div>
                  <div className="text-xs text-emerald-100 mt-1">{tile.label}</div>
                </div>
              ))}
            </div>

            <div className="mt-6">
              <div className="flex justify-between text-xs text-emerald-100 mb-1">
                <span>Payment progress</span>
                <span>{paymentProgress}%</span>
              </div>
              <div className="h-2 bg-white/20 rounded-full overflow-hidden">
                <div
                  className="h-full bg-white rounded-full transition-all duration-500"
                  style={{ width: `${paymentProgress}%` }}
                />
              </div>
            </div>
          </>
        )}
      </div>

      {isStaff ? (
        <FeeAdminPanel />
      ) : (
        <>
          {error && (
            <div className="bg-red-50 border border-red-100 text-red-700 rounded-2xl p-4 mb-6 flex items-center gap-2">
              <AlertCircle size={18} />
              {error}
            </div>
          )}

          {loading ? (
            <div className="bg-white rounded-3xl shadow-xl p-12 text-center text-gray-500">
              Loading your fee records...
            </div>
          ) : invoices.length === 0 ? (
            <div className="bg-white rounded-3xl shadow-xl p-12 text-center text-gray-500">
              <Receipt size={40} className="mx-auto text-gray-300" />
              <p className="text-lg font-semibold mt-4">No invoices yet</p>
              <p className="text-sm mt-2">
                When the school office issues a fee invoice for you it will appear here.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {invoices.map((invoice) => {
                const isReceiptOpen = openReceiptId === invoice._id;

                return (
                  <div key={invoice._id} className="bg-white rounded-3xl shadow-xl p-6 md:p-8">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-3 flex-wrap">
                          <h2 className="text-xl font-bold text-gray-800">{invoice.invoiceNumber}</h2>
                          <span
                            className={`text-xs px-3 py-1 rounded-full ${
                              STATUS_STYLES[invoice.status] || STATUS_STYLES.pending
                            }`}
                          >
                            {STATUS_LABELS[invoice.status] || invoice.status}
                          </span>
                        </div>

                        <div className="flex flex-wrap gap-4 mt-3 text-sm text-gray-500">
                          <span>📆 {invoice.academicYear}</span>
                          <span>🏫 {invoice.className}</span>
                          <span>📅 Due {formatDate(invoice.dueDate)}</span>
                        </div>
                      </div>

                      <div className="text-right">
                        <p className="text-xs text-gray-400">Amount payable now</p>
                        <p className="text-3xl font-bold text-gray-800">
                          {money(invoice.payableNow, invoice.currency)}
                        </p>
                        {invoice.accruedLateFee > 0 && (
                          <p className="text-xs text-red-600 mt-1">
                            includes {money(invoice.accruedLateFee, invoice.currency)} late fee
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Line items */}
                    <div className="mt-6 border border-gray-100 rounded-2xl overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-gray-500">
                          <tr>
                            <th className="text-left px-4 py-2 font-medium">Component</th>
                            <th className="text-right px-4 py-2 font-medium">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {invoice.lineItems.map((item) => (
                            <tr key={item.label} className="border-t border-gray-100">
                              <td className="px-4 py-2 text-gray-700">{item.label}</td>
                              <td className="px-4 py-2 text-right text-gray-700">
                                {money(item.amount, invoice.currency)}
                              </td>
                            </tr>
                          ))}
                          <tr className="border-t border-gray-200 bg-gray-50 font-semibold">
                            <td className="px-4 py-2 text-gray-800">Total</td>
                            <td className="px-4 py-2 text-right text-gray-800">
                              {money(invoice.totalAmount, invoice.currency)}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                    {invoice.status === 'waived' && invoice.waivedReason && (
                      <p className="mt-4 text-sm text-purple-700 bg-purple-50 border border-purple-100 rounded-2xl p-4">
                        This invoice was waived — {invoice.waivedReason}
                      </p>
                    )}

                    {invoice.status === 'paid' && (
                      <p className="mt-4 flex items-center gap-2 text-sm text-green-700">
                        <CheckCircle2 size={16} /> Fully paid. Thank you!
                      </p>
                    )}

                    {/* Payment history / receipt */}
                    <div className="mt-5 flex flex-wrap gap-3">
                      <button
                        onClick={() => setOpenReceiptId(isReceiptOpen ? null : invoice._id)}
                        className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition"
                      >
                        <Receipt size={16} />
                        {isReceiptOpen ? 'Hide receipt' : 'View receipt'}
                      </button>

                      {isReceiptOpen && (
                        <button
                          onClick={() => window.print()}
                          className="inline-flex items-center gap-2 border border-gray-300 text-gray-600 hover:bg-gray-50 px-5 py-2.5 rounded-xl text-sm font-semibold transition"
                        >
                          <Printer size={16} /> Print
                        </button>
                      )}
                    </div>

                    {isReceiptOpen && (
                      <div className="mt-4 bg-gray-50 rounded-2xl p-5">
                        <p className="text-sm font-semibold text-gray-700 mb-3">Payment history</p>

                        {invoice.payments.length === 0 ? (
                          <p className="text-sm text-gray-500">No payments recorded yet.</p>
                        ) : (
                          <div className="space-y-2">
                            {invoice.payments.map((payment, index) => (
                              <div
                                key={index}
                                className="flex flex-wrap items-center justify-between gap-2 bg-white rounded-xl p-3 border border-gray-100"
                              >
                                <div>
                                  <p className="text-sm font-medium text-gray-800">
                                    {money(payment.amount, invoice.currency)}
                                  </p>
                                  <p className="text-xs text-gray-500 capitalize">
                                    {payment.method}
                                    {payment.reference && ` · ${payment.reference}`}
                                  </p>
                                </div>
                                <span className="text-xs text-gray-400">{formatDate(payment.paidAt)}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        <div className="flex justify-between mt-4 pt-3 border-t border-gray-200 text-sm">
                          <span className="text-gray-500">Balance remaining</span>
                          <span className="font-bold text-gray-800">
                            {money(invoice.payableNow, invoice.currency)}
                          </span>
                        </div>
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

export default FeePortal;
