import { useState, useEffect, useCallback, useContext, useMemo } from 'react';
import api from '../../utils/axios';
import { AuthContext } from '../../context/AuthContext';
import { getUserRole } from '../../utils/permissions';

/**
 * Fee concessions — standing entitlements, and what they take off a bill.
 *
 * For a family the panel shows the published total next to the net rather than
 * instead of it. A bill that hides its list price is the reason families do not
 * trust the discount printed on it; showing both, with the concession named
 * between them, is the whole difference between a reduction and a mystery.
 *
 * For the bursar the stacking ceiling is drawn as a bar that fills, because the
 * moment worth catching is the one where a fourth concession is worth nothing —
 * and a table of percentages never shows that.
 */

const STATUS_STYLES = {
  draft: 'bg-gray-200 text-gray-700',
  submitted: 'bg-amber-100 text-amber-800',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  revoked: 'bg-red-50 text-red-600',
  expired: 'bg-gray-100 text-gray-500',
};

const STATUS_LABELS = {
  draft: 'Draft',
  submitted: 'Awaiting approval',
  approved: 'Live',
  rejected: 'Rejected',
  revoked: 'Revoked',
  expired: 'Expired',
};

const APPLIES_LABELS = {
  'mandatory-only': 'Mandatory components only',
  'tuition-only': 'Tuition only',
  'all-components': 'The whole bill',
};

const money = (value, currency = 'INR') =>
  `${currency === 'INR' ? '₹' : ''}${Number(value || 0).toLocaleString('en-IN')}`;

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—';

const rateLabel = (row) =>
  row.basis === 'percentage' ? `${row.rate}%` : money(row.rate);

/**
 * The stacking ceiling, drawn.
 *
 * `raw` is what the schemes are worth before the clamp; `applied` is what came
 * off. When the two differ, the difference is the thing to look at, so it is
 * written out rather than implied by a shorter bar.
 */
const CeilingBar = ({ pricing, currency }) => {
  if (!pricing) return null;

  const ceiling = Math.max(1, pricing.stackingCeiling);
  const filled = Math.min(100, Math.round((pricing.concessionAmount / ceiling) * 100));
  const over = pricing.rawTotal > pricing.stackingCeiling;

  return (
    <div>
      <div className="flex items-baseline justify-between text-xs mb-1">
        <span className="text-gray-600">
          {money(pricing.concessionAmount, currency)} of a{' '}
          {money(pricing.stackingCeiling, currency)} ceiling ({pricing.stackingCeilingPercent}% of
          the bill)
        </span>
        <span className={over ? 'text-amber-700 font-medium' : 'text-gray-400'}>
          {over ? 'At the ceiling' : `${100 - filled}% headroom`}
        </span>
      </div>
      <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${over ? 'bg-amber-500' : 'bg-emerald-500'}`}
          style={{ width: `${filled}%` }}
        />
      </div>
      {over && (
        <p className="text-xs text-amber-700 mt-1">
          The schemes held are worth {money(pricing.rawTotal, currency)}; the ceiling holds it at{' '}
          {money(pricing.concessionAmount, currency)}. A further concession would be worth nothing.
        </p>
      )}
      {pricing.cappedByOutstanding && (
        <p className="text-xs text-amber-700 mt-1">
          Held at what is still owed. A concession cannot reduce a bill below what has already been
          paid — that is a refund, which is a separate decision.
        </p>
      )}
    </div>
  );
};

const ConcessionPanel = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isSignedIn = Boolean(role);
  const isBursar = role === 'staff' || role === 'admin';
  const isAdmin = role === 'admin';

  const [meta, setMeta] = useState(null);
  const [mine, setMine] = useState(null);

  const [schemes, setSchemes] = useState([]);
  const [concessions, setConcessions] = useState([]);
  const [register, setRegister] = useState(null);
  const [academicYear, setAcademicYear] = useState('');

  const [previewInvoice, setPreviewInvoice] = useState('');
  const [previewScheme, setPreviewScheme] = useState('');
  const [preview, setPreview] = useState(null);

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
    if (!isSignedIn) return;
    try {
      const res = await api.get('/fees/concessions/meta');
      setMeta(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load concession reference data.');
    }
  }, [isSignedIn]);

  const loadMine = useCallback(async () => {
    if (!isSignedIn) return;

    setLoading(true);
    try {
      const res = await api.get('/fees/concessions/mine');
      setMine(res.data.data || null);
    } catch (err) {
      explain(err, 'Could not load your concessions.');
    } finally {
      setLoading(false);
    }
  }, [isSignedIn]);

  const loadOffice = useCallback(async () => {
    if (!isBursar) return;

    try {
      const query = academicYear ? `?academicYear=${academicYear}` : '';
      const [schemesRes, listRes, registerRes] = await Promise.all([
        api.get(`/fees/concessions/schemes${query}`),
        api.get(`/fees/concessions${query}`),
        api.get(`/fees/concessions/register${query}`),
      ]);

      setSchemes(schemesRes.data.data || []);
      setConcessions(listRes.data.data || []);
      setRegister(registerRes.data.data || null);
    } catch (err) {
      explain(err, 'Could not load the concession register.');
    }
  }, [isBursar, academicYear]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    loadMine();
  }, [loadMine]);

  useEffect(() => {
    loadOffice();
  }, [loadOffice]);

  const years = useMemo(
    () => [...new Set(schemes.map((scheme) => scheme.academicYear))].sort(),
    [schemes]
  );

  // ---- acting --------------------------------------------------------------

  const runPreview = async () => {
    if (!previewInvoice || !previewScheme) {
      setError('Pick an invoice and a scheme to price.');
      return;
    }

    setError('');
    setBusy('preview');

    try {
      const res = await api.get(
        `/fees/concessions/preview?invoiceId=${previewInvoice}&schemeId=${previewScheme}`
      );
      setPreview(res.data.data || null);
    } catch (err) {
      setPreview(null);
      explain(err, 'Could not price that concession.');
    } finally {
      setBusy('');
    }
  };

  const decide = async (concession, verb, body) => {
    setError('');
    setBusy(concession._id);

    try {
      const res = await api.patch(`/fees/concessions/${concession._id}/${verb}`, body || {});
      flash(res.data.message || 'Done.');
      loadOffice();
      loadMine();
    } catch (err) {
      explain(err, `Could not ${verb} the concession.`);
    } finally {
      setBusy('');
    }
  };

  const reject = (concession) => {
    const reason = window.prompt('Why is this concession being rejected?');
    if (!reason) return;
    return decide(concession, 'reject', { reason });
  };

  const revoke = (concession) => {
    const reason = window.prompt(
      'Why is this concession being revoked? Unpaid invoices will go back up immediately.'
    );
    if (!reason) return;
    return decide(concession, 'revoke', { reason });
  };

  const setSchemeStatus = async (scheme, isActive) => {
    setError('');
    setBusy(scheme._id);

    try {
      const res = await api.patch(`/fees/concessions/schemes/${scheme._id}/status`, { isActive });
      flash(res.data.message || 'Scheme updated.');
      loadOffice();
    } catch (err) {
      explain(err, 'Could not change the scheme.');
    } finally {
      setBusy('');
    }
  };

  if (!isSignedIn) return null;

  return (
    <div className="bg-white rounded-xl shadow p-4 sm:p-6 my-8 text-left">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Fee concessions</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Standing entitlements — sibling, staff ward, quota, agreed bursary — and what they take
            off a bill.
          </p>
        </div>

        {isBursar && years.length > 0 && (
          <label className="text-sm">
            <span className="block text-xs text-gray-500 mb-1">Academic year</span>
            <select
              value={academicYear}
              onChange={(event) => setAcademicYear(event.target.value)}
              className="border border-gray-200 rounded px-2 py-1 text-sm"
            >
              <option value="">All years</option>
              {years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </label>
        )}
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
        <h3 className="font-semibold text-gray-800 text-sm mb-3">What you hold</h3>

        {loading && !mine ? (
          <p className="text-sm text-gray-500">Working it out…</p>
        ) : mine?.concessions?.length ? (
          <div className="space-y-2 mb-4">
            {mine.concessions.map((row) => (
              <div
                key={row._id}
                className="flex flex-wrap items-center justify-between gap-2 bg-gray-50 rounded px-3 py-2"
              >
                <div>
                  <p className="text-sm text-gray-800">
                    {row.schemeName} · {rateLabel(row)}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {APPLIES_LABELS[row.appliesTo] || row.appliesTo} · {row.academicYear}
                    {row.effectiveTo ? ` · ended ${formatDate(row.effectiveTo)}` : ''}
                  </p>
                </div>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    STATUS_STYLES[row.status] || 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {STATUS_LABELS[row.status] || row.status}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500 mb-4">
            You hold no concessions. If you think you should, the school office records them.
          </p>
        )}

        {mine?.invoices?.length > 0 && (
          <div className="space-y-3">
            {mine.invoices.map((invoice) => (
              <div key={invoice._id} className="border border-gray-100 rounded-lg p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
                  <p className="text-sm font-medium text-gray-800">{invoice.invoiceNumber}</p>
                  <p className="text-xs text-gray-500">Due {formatDate(invoice.dueDate)}</p>
                </div>

                <div className="grid gap-2 sm:grid-cols-3 text-sm">
                  <div>
                    <p className="text-xs text-gray-500">Published total</p>
                    <p className="text-gray-800">{money(invoice.totalAmount, invoice.currency)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Concession</p>
                    <p className="text-emerald-700">
                      {invoice.concessionAmount > 0 ? '−' : ''}
                      {money(invoice.concessionAmount, invoice.currency)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">You pay</p>
                    <p className="font-semibold text-gray-900">
                      {money(invoice.netPayable, invoice.currency)}
                    </p>
                  </div>
                </div>

                {invoice.rows?.length > 0 && (
                  <ul className="mt-2 space-y-0.5">
                    {invoice.rows
                      .filter((row) => row.amount > 0 || row.suppressed)
                      .map((row) => (
                        <li key={row.concession} className="text-xs text-gray-600">
                          {row.schemeName} ({rateLabel(row)}) ·{' '}
                          {row.suppressed
                            ? row.suppressed
                            : `−${money(row.amount, invoice.currency)}`}
                        </li>
                      ))}
                  </ul>
                )}

                <p className="text-xs text-gray-400 mt-2">
                  The published total is what the school charges for this class. The concession is
                  worked out from it every time this page is opened, so it is never out of date.
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- the office ---- */}
      {isBursar && (
        <div className="space-y-6">
          {register && (
            <div className="border border-gray-100 rounded-lg p-4">
              <h3 className="font-semibold text-gray-800 text-sm mb-1">
                The register{academicYear ? `, ${academicYear}` : ''}
              </h3>
              <p className="text-xs text-gray-500 mb-3">
                {register.concessionCount || 0} concession(s) held by {register.studentCount || 0}{' '}
                student(s), worth {money(register.totalValue)} across{' '}
                {register.invoiceCount || 0} invoice(s).
              </p>

              {register.bySchemeRows?.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[24rem]">
                    <thead>
                      <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                        <th className="py-2 pr-2 font-medium">Scheme</th>
                        <th className="py-2 pr-2 font-medium text-right">Held</th>
                        <th className="py-2 font-medium text-right">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {register.bySchemeRows.map((row) => (
                        <tr key={row.schemeCode} className="border-b border-gray-50 last:border-0">
                          <td className="py-2 pr-2 text-gray-800">{row.schemeName}</td>
                          <td className="py-2 pr-2 text-right text-gray-600">{row.count}</td>
                          <td className="py-2 text-right font-medium">{money(row.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <p className="text-xs text-gray-500 mt-2">
                Priced per invoice, not per scheme, because a concession is worth what it actually
                took off a bill — the ceiling and the outstanding balance both have a say, and the
                headline rate does not know about either.
              </p>
            </div>
          )}

          {/* ---- what would this cost ---- */}
          <div className="border border-gray-100 rounded-lg p-4">
            <h3 className="font-semibold text-gray-800 text-sm mb-1">Price a concession</h3>
            <p className="text-xs text-gray-500 mb-3">
              What an invoice would come to under a scheme, before anything is granted.
            </p>

            <div className="grid gap-2 sm:grid-cols-3">
              <label className="text-sm">
                <span className="block text-xs text-gray-500 mb-1">Invoice id</span>
                <input
                  type="text"
                  value={previewInvoice}
                  onChange={(event) => setPreviewInvoice(event.target.value.trim())}
                  placeholder="Paste an invoice id"
                  className="w-full border border-gray-200 rounded px-2 py-1 text-sm"
                />
              </label>

              <label className="text-sm">
                <span className="block text-xs text-gray-500 mb-1">Scheme</span>
                <select
                  value={previewScheme}
                  onChange={(event) => setPreviewScheme(event.target.value)}
                  className="w-full border border-gray-200 rounded px-2 py-1 text-sm"
                >
                  <option value="">Choose…</option>
                  {schemes.map((scheme) => (
                    <option key={scheme._id} value={scheme._id}>
                      {scheme.name} ({rateLabel(scheme)})
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex items-end">
                <button
                  type="button"
                  disabled={busy === 'preview'}
                  onClick={runPreview}
                  className="text-sm px-3 py-1.5 bg-indigo-600 text-white rounded disabled:opacity-50"
                >
                  Price it
                </button>
              </div>
            </div>

            {preview && (
              <div className="mt-4 space-y-3">
                <div className="grid gap-2 sm:grid-cols-3 text-sm">
                  <div>
                    <p className="text-xs text-gray-500">Concession now</p>
                    <p className="text-gray-800">{money(preview.before.concessionAmount)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">With {preview.scheme.name}</p>
                    <p className="text-gray-800">{money(preview.after.concessionAmount)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">This scheme is worth</p>
                    <p className="font-semibold text-gray-900">{money(preview.marginalValue)}</p>
                  </div>
                </div>

                <CeilingBar pricing={preview.after} />

                {preview.marginalValue === 0 && (
                  <p className="text-xs text-amber-700">
                    Worth nothing on this invoice. Granting it would record an entitlement that
                    reduces no bill, which is worth knowing before somebody is told they have one.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* ---- schemes ---- */}
          {schemes.length > 0 && (
            <div className="border border-gray-100 rounded-lg p-4">
              <h3 className="font-semibold text-gray-800 text-sm mb-3">Schemes</h3>

              <div className="space-y-2">
                {schemes.map((scheme) => (
                  <div
                    key={scheme._id}
                    className="flex flex-wrap items-center justify-between gap-2 bg-gray-50 rounded px-3 py-2"
                  >
                    <div>
                      <p className="text-sm text-gray-800">
                        {scheme.name} · {rateLabel(scheme)}
                        {!scheme.stackable && (
                          <span className="ml-2 text-xs text-amber-700">does not stack</span>
                        )}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {APPLIES_LABELS[scheme.appliesTo] || scheme.appliesTo} ·{' '}
                        {scheme.requiresEvidence ? 'evidence required' : 'no evidence required'} ·{' '}
                        {scheme.academicYear}
                      </p>
                    </div>

                    {isAdmin && (
                      <button
                        type="button"
                        disabled={busy === scheme._id}
                        onClick={() => setSchemeStatus(scheme, !scheme.isActive)}
                        className="text-xs px-2 py-1 border border-gray-200 rounded disabled:opacity-50"
                      >
                        {scheme.isActive ? 'Close to new grants' : 'Reopen'}
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <p className="text-xs text-gray-500 mt-2">
                Closing a scheme stops new grants. It does not revoke the concessions already held
                under it — that would restate bills without anybody deciding to.
              </p>
            </div>
          )}

          {/* ---- live concessions ---- */}
          {concessions.length > 0 && (
            <div className="border border-gray-100 rounded-lg p-4">
              <h3 className="font-semibold text-gray-800 text-sm mb-3">Concessions</h3>

              <div className="space-y-2">
                {concessions.map((row) => (
                  <div
                    key={row._id}
                    className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-50 last:border-0 pb-2"
                  >
                    <div>
                      <p className="text-sm text-gray-800">
                        {row.studentName} · {row.schemeName} ({rateLabel(row)})
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {row.className || '—'} · {row.academicYear} · requested by{' '}
                        {row.requestedByName || '—'}
                        {row.approvedByName ? ` · approved by ${row.approvedByName}` : ''}
                        {row.evidenceReference ? ` · evidence ${row.evidenceReference}` : ''}
                      </p>
                      {row.rejectionReason && (
                        <p className="text-xs text-red-600 mt-0.5">{row.rejectionReason}</p>
                      )}
                      {row.revocationReason && (
                        <p className="text-xs text-red-600 mt-0.5">{row.revocationReason}</p>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          STATUS_STYLES[row.status] || 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {STATUS_LABELS[row.status] || row.status}
                      </span>

                      {row.status === 'draft' && (
                        <button
                          type="button"
                          disabled={busy === row._id}
                          onClick={() => decide(row, 'submit')}
                          className="text-xs px-2 py-1 border border-gray-200 rounded disabled:opacity-50"
                        >
                          Submit
                        </button>
                      )}

                      {isAdmin && row.status === 'submitted' && (
                        <>
                          <button
                            type="button"
                            disabled={busy === row._id}
                            onClick={() => decide(row, 'approve')}
                            className="text-xs px-2 py-1 bg-emerald-600 text-white rounded disabled:opacity-50"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            disabled={busy === row._id}
                            onClick={() => reject(row)}
                            className="text-xs px-2 py-1 border border-gray-200 rounded disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </>
                      )}

                      {isAdmin && row.status === 'approved' && (
                        <button
                          type="button"
                          disabled={busy === row._id}
                          onClick={() => revoke(row)}
                          className="text-xs px-2 py-1 border border-gray-200 rounded disabled:opacity-50"
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <p className="text-xs text-gray-500 mt-3">
                Approval is by somebody other than whoever asked, and on a scheme that needs
                evidence, by somebody other than whoever checked it. The buttons refuse it and so
                does the model.
              </p>
            </div>
          )}

          {meta && (
            <p className="text-xs text-gray-400">
              Concessions stack to at most {meta.maxTotalConcessionPercent}% of a bill, and never
              below what has already been paid. Nothing here writes to an invoice.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default ConcessionPanel;
