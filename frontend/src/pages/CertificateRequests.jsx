import { useState, useEffect, useContext, useCallback } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';

/**
 * Student-facing certificate requests.
 *
 * Three things a student needs and does not currently have: a way to ask, a
 * way to see where the request has got to, and — once it is issued — the
 * serial and verification code that let whoever they hand it to check it.
 */

const TYPES = [
  { value: 'bonafide', label: 'Bonafide certificate', hint: 'Proof you study here — banks, passports, visas' },
  { value: 'character', label: 'Character certificate', hint: 'Usually asked for by colleges' },
  { value: 'transfer', label: 'Transfer certificate', hint: 'On leaving the school' },
  { value: 'migration', label: 'Migration certificate', hint: 'Moving to another board' },
  { value: 'study', label: 'Study certificate', hint: 'Years of study completed' },
  { value: 'conduct', label: 'Conduct certificate', hint: 'Disciplinary record' },
  { value: 'fee-receipt', label: 'Fee receipt', hint: 'Duplicate receipt' },
  { value: 'mark-sheet', label: 'Mark sheet', hint: 'Duplicate mark sheet' },
];

const STATUS_STYLES = {
  submitted: 'bg-gray-100 text-gray-700',
  'under-review': 'bg-blue-100 text-blue-700',
  'info-required': 'bg-amber-100 text-amber-800',
  approved: 'bg-indigo-100 text-indigo-700',
  issued: 'bg-green-100 text-green-700',
  collected: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-200 text-gray-500',
  revoked: 'bg-red-200 text-red-800',
};

const STATUS_LABELS = {
  submitted: 'Submitted',
  'under-review': 'Under review',
  'info-required': 'Information needed',
  approved: 'Approved',
  issued: 'Ready',
  collected: 'Collected',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  revoked: 'Revoked',
};

const emptyForm = {
  type: 'bonafide',
  studentName: '',
  className: '',
  rollNumber: '',
  purpose: '',
  copies: 1,
  deliveryMode: 'collect',
  postalAddress: '',
};

const formatDateTime = (value) =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '';

const CertificateRequests = () => {
  const { user } = useContext(AuthContext);

  const [requests, setRequests] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [expanded, setExpanded] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const flash = (message) => {
    setNotice(message);
    setTimeout(() => setNotice(''), 5000);
  };

  const load = useCallback(async () => {
    try {
      const res = await api.get('/certificates/mine');
      setRequests(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load your requests.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setForm((current) => ({ ...current, studentName: current.studentName || user?.name || '' }));
    load();
  }, [load, user]);

  const submit = async (event) => {
    event.preventDefault();
    setError('');

    if (form.purpose.trim().length < 10) {
      setError('Please say what the certificate is for — at least a short sentence.');
      return;
    }
    if (form.deliveryMode === 'post' && !form.postalAddress.trim()) {
      setError('A postal address is needed if the certificate is to be posted.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.post('/certificates', { ...form, copies: Number(form.copies) });
      flash(res.data.message);
      setForm({ ...emptyForm, studentName: user?.name || '' });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not submit that request.');
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async (request) => {
    setError('');
    try {
      await api.patch(`/certificates/${request._id}/cancel`);
      flash('Request cancelled.');
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not cancel that request.');
    }
  };

  const reply = async (request) => {
    if (!replyText.trim()) return;
    setError('');
    try {
      await api.post(`/certificates/${request._id}/remarks`, { body: replyText });
      setReplyText('');
      flash('Reply sent. Your request is back in the queue.');
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not send that reply.');
    }
  };

  const copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      flash(`${label} copied.`);
    } catch {
      // Clipboard access is denied in plenty of ordinary situations; the value
      // is on screen and selectable either way, so this is not worth an error.
      flash('Select and copy the value shown.');
    }
  };

  const selectedType = TYPES.find((entry) => entry.value === form.type);

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="max-w-4xl mx-auto px-4 py-8">

        <div className="bg-gradient-to-r from-slate-700 to-slate-900 rounded-2xl p-6 mb-6 text-white">
          <h1 className="text-2xl font-bold">Certificates &amp; Documents</h1>
          <p className="text-slate-300 mt-1 text-sm">
            Request an official document and track it. Once issued, it carries a
            serial number and a verification code that whoever you give it to
            can check.
          </p>
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

        <div className="bg-white rounded-2xl shadow p-6 mb-6">
          <h2 className="text-lg font-bold text-gray-800 mb-4">New request</h2>

          <form onSubmit={submit} className="space-y-3">
            <div>
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
              >
                {TYPES.map((entry) => (
                  <option key={entry.value} value={entry.value}>{entry.label}</option>
                ))}
              </select>
              {selectedType && (
                <p className="text-xs text-gray-400 mt-1">{selectedType.hint}</p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <input
                type="text"
                required
                placeholder="Student name *"
                value={form.studentName}
                onChange={(e) => setForm({ ...form, studentName: e.target.value })}
                className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
              />
              <input
                type="text"
                placeholder="Class"
                value={form.className}
                onChange={(e) => setForm({ ...form, className: e.target.value })}
                className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
              />
              <input
                type="text"
                placeholder="Roll number"
                value={form.rollNumber}
                onChange={(e) => setForm({ ...form, rollNumber: e.target.value })}
                className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
              />
            </div>

            <div>
              <textarea
                required
                rows={3}
                placeholder="What is it for? e.g. bank account opening, passport application *"
                value={form.purpose}
                onChange={(e) => setForm({ ...form, purpose: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
              />
              <p className="text-xs text-gray-400 mt-1">
                {form.purpose.length}/300 — the office needs this to write the
                certificate correctly.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="text-xs text-gray-500">
                Copies
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={form.copies}
                  onChange={(e) => setForm({ ...form, copies: e.target.value })}
                  className="mt-1 w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
                />
              </label>
              <label className="text-xs text-gray-500">
                Delivery
                <select
                  value={form.deliveryMode}
                  onChange={(e) => setForm({ ...form, deliveryMode: e.target.value })}
                  className="mt-1 w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
                >
                  <option value="collect">Collect from the office</option>
                  <option value="email">Email</option>
                  <option value="post">Post</option>
                </select>
              </label>
            </div>

            {form.deliveryMode === 'post' && (
              <textarea
                required
                rows={2}
                placeholder="Postal address *"
                value={form.postalAddress}
                onChange={(e) => setForm({ ...form, postalAddress: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
              />
            )}

            <button
              type="submit"
              disabled={submitting}
              className="bg-slate-800 hover:bg-slate-900 text-white px-5 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
            >
              {submitting ? 'Submitting...' : 'Submit request'}
            </button>
          </form>
        </div>

        <div className="bg-white rounded-2xl shadow p-6">
          <h2 className="text-lg font-bold text-gray-800 mb-4">
            Your requests ({requests.length})
          </h2>

          {loading && <p className="text-gray-400 text-sm text-center py-6">Loading...</p>}
          {!loading && requests.length === 0 && (
            <p className="text-gray-400 text-sm text-center py-6">
              You have not requested any documents yet.
            </p>
          )}

          <div className="space-y-3">
            {requests.map((request) => {
              const isOpen = expanded === request._id;
              return (
                <div key={request._id} className="border border-gray-200 rounded-xl overflow-hidden">
                  <button
                    onClick={() => { setExpanded(isOpen ? null : request._id); setReplyText(''); }}
                    className="w-full text-left px-4 py-3 hover:bg-gray-50 transition"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs text-gray-400">
                            {request.requestNumber}
                          </span>
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full ${
                              STATUS_STYLES[request.status] || 'bg-gray-100 text-gray-600'
                            }`}
                          >
                            {STATUS_LABELS[request.status] || request.status}
                          </span>
                        </div>
                        <p className="font-semibold text-gray-800 text-sm mt-0.5">
                          {request.typeLabel}
                          {request.copies > 1 ? ` · ${request.copies} copies` : ''}
                        </p>
                        <p className="text-xs text-gray-400">
                          Requested {formatDate(request.createdAt)}
                        </p>
                      </div>
                    </div>
                  </button>

                  {isOpen && (
                    <div className="border-t border-gray-200 px-4 py-4 bg-gray-50 space-y-4">
                      <div>
                        <p className="text-xs text-gray-400 uppercase tracking-wide">Purpose</p>
                        <p className="text-sm text-gray-700">{request.purpose}</p>
                      </div>

                      {request.status === 'info-required' && (
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                          <p className="text-sm text-amber-800 font-medium mb-2">
                            The office needs something from you. Reply below and
                            your request goes straight back into the queue.
                          </p>
                          <textarea
                            rows={2}
                            placeholder="Your reply"
                            value={replyText}
                            onChange={(e) => setReplyText(e.target.value)}
                            className="w-full border border-amber-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
                          />
                          <button
                            onClick={() => reply(request)}
                            disabled={!replyText.trim()}
                            className="mt-2 bg-amber-600 hover:bg-amber-700 text-white text-sm px-4 py-1.5 rounded-lg transition disabled:opacity-40"
                          >
                            Send reply
                          </button>
                        </div>
                      )}

                      {request.serialNumber && (
                        <div className="bg-white border border-green-200 rounded-lg p-4">
                          <p className="text-xs text-green-700 font-semibold uppercase tracking-wide mb-2">
                            Issued document
                          </p>
                          <div className="space-y-2 text-sm">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-gray-500">Serial number</span>
                              <button
                                onClick={() => copy(request.serialNumber, 'Serial number')}
                                className="font-mono text-gray-800 hover:text-slate-600"
                              >
                                {request.serialNumber}
                              </button>
                            </div>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-gray-500">Verification code</span>
                              <button
                                onClick={() => copy(request.verificationCode, 'Verification code')}
                                className="font-mono text-xs text-gray-800 hover:text-slate-600 break-all text-right"
                              >
                                {request.verificationCode}
                              </button>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-gray-500">Issued on</span>
                              <span className="text-gray-800">{formatDate(request.issuedAt)}</span>
                            </div>
                            {request.validUntil && (
                              <div className="flex items-center justify-between">
                                <span className="text-gray-500">Valid until</span>
                                <span
                                  className={request.isExpired ? 'text-red-600' : 'text-gray-800'}
                                >
                                  {formatDate(request.validUntil)}
                                  {request.isExpired ? ' (expired)' : ''}
                                </span>
                              </div>
                            )}
                          </div>
                          <p className="text-xs text-gray-400 mt-3">
                            Anyone can confirm this document at{' '}
                            <span className="font-mono">/api/certificates/verify/{'{code}'}</span>{' '}
                            without needing an account.
                          </p>
                        </div>
                      )}

                      {request.status === 'revoked' && (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                          <p className="text-sm text-red-800">
                            This certificate has been revoked
                            {request.revokedAt ? ` on ${formatDate(request.revokedAt)}` : ''}.
                            It will no longer verify as valid.
                          </p>
                        </div>
                      )}

                      {request.rejectionReason && (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                          <p className="text-sm text-red-800">
                            <strong>Rejected:</strong> {request.rejectionReason}
                          </p>
                        </div>
                      )}

                      {request.remarks?.length > 0 && (
                        <div>
                          <p className="text-xs text-gray-400 uppercase tracking-wide mb-2">
                            Messages
                          </p>
                          <div className="space-y-2">
                            {request.remarks.map((remark) => (
                              <div key={remark._id} className="bg-white rounded-lg px-3 py-2">
                                <p className="text-sm text-gray-700">{remark.body}</p>
                                <p className="text-xs text-gray-400 mt-1">
                                  {remark.authorName} &middot; {formatDateTime(remark.at)}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {['submitted', 'info-required'].includes(request.status) && (
                        <button
                          onClick={() => cancel(request)}
                          className="text-sm text-red-600 hover:text-red-700 border border-red-200 hover:bg-red-50 px-4 py-1.5 rounded-lg transition"
                        >
                          Cancel this request
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

export default CertificateRequests;
