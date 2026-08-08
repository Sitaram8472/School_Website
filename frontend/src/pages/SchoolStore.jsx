import { useState, useEffect, useContext, useCallback, useMemo } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';

/**
 * The school store.
 *
 * Availability is shown per size, not per item, because "we have blazers" is
 * not an answer to "do you have a 32". The number next to each size is what the
 * server says is available right now — stock minus what is already reserved —
 * and it is re-read after every order rather than adjusted locally. The seat
 * you think is free and the seat the database thinks is free are allowed to
 * disagree, and the database wins.
 *
 * The basket is deliberately client-side until the order is placed. Reserving
 * stock the moment somebody clicks a size would hold a uniform for anybody
 * browsing.
 */

const CATEGORY_LABELS = {
  textbook: 'Textbooks',
  workbook: 'Workbooks',
  uniform: 'Uniform',
  sportswear: 'PE kit',
  stationery: 'Stationery',
  other: 'Other',
};

const ORDER_STATUS_STYLES = {
  reserved: 'bg-blue-100 text-blue-700',
  ready: 'bg-green-100 text-green-700',
  collected: 'bg-gray-200 text-gray-600',
  cancelled: 'bg-gray-200 text-gray-600',
  expired: 'bg-red-100 text-red-700',
};

const PAYMENT_LABELS = {
  pending: 'Payment due',
  paid: 'Paid',
  waived: 'Waived',
  refunded: 'Refunded',
};

const ADJUSTMENT_REASONS = [
  { value: 'receive', label: 'Received from supplier' },
  { value: 'damage', label: 'Damaged' },
  { value: 'loss', label: 'Lost' },
  { value: 'correction', label: 'Stock-take correction' },
  { value: 'return', label: 'Returned by a family' },
];

const emptyOrderDetails = {
  studentName: '',
  className: '',
  contactNumber: '',
};

const SchoolStore = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isAdmin = role === 'admin';

  const [tab, setTab] = useState('catalogue');
  const [items, setItems] = useState([]);
  const [myOrders, setMyOrders] = useState([]);
  const [counterOrders, setCounterOrders] = useState([]);
  const [lowStock, setLowStock] = useState([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [categoryFilter, setCategoryFilter] = useState('');
  const [search, setSearch] = useState('');
  const [inStockOnly, setInStockOnly] = useState(false);

  // basket: { key, item, itemName, variantSku, variantLabel, unitPrice, quantity }
  const [basket, setBasket] = useState([]);
  const [orderDetails, setOrderDetails] = useState(emptyOrderDetails);
  const [submitting, setSubmitting] = useState(false);

  const [adjusting, setAdjusting] = useState(null);
  const [adjustment, setAdjustment] = useState({ delta: '', reason: 'receive', note: '' });

  const flash = useCallback((message) => {
    setNotice(message);
    setTimeout(() => setNotice(''), 4000);
  }, []);

  const loadItems = useCallback(async () => {
    try {
      const params = {};
      if (categoryFilter) params.category = categoryFilter;
      if (search) params.search = search;
      if (inStockOnly) params.inStockOnly = 'true';
      const res = await api.get('/store/items', { params });
      setItems(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the catalogue.');
    }
  }, [categoryFilter, search, inStockOnly]);

  const loadMyOrders = useCallback(async () => {
    try {
      const res = await api.get('/store/my-orders');
      setMyOrders(res.data.data || []);
    } catch (err) {
      console.error(err);
    }
  }, []);

  const loadCounter = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const [orders, low] = await Promise.all([
        api.get('/store/orders', { params: { status: 'reserved' } }),
        api.get('/store/low-stock'),
      ]);
      setCounterOrders(orders.data.data || []);
      setLowStock(low.data.data || []);
    } catch (err) {
      console.error(err);
    }
  }, [isAdmin]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await Promise.all([loadItems(), loadMyOrders(), loadCounter()]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadItems, loadMyOrders, loadCounter]);

  const basketTotal = useMemo(
    () => basket.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0),
    [basket]
  );

  // --- Basket --------------------------------------------------------------

  const addToBasket = (item, variant) => {
    const key = `${item._id}:${variant.variantSku}`;
    setBasket((current) => {
      const existing = current.find((line) => line.key === key);
      if (existing) {
        return current.map((line) =>
          line.key === key ? { ...line, quantity: line.quantity + 1 } : line
        );
      }
      return [
        ...current,
        {
          key,
          item: item._id,
          itemName: item.name,
          variantSku: variant.variantSku,
          variantLabel: variant.label,
          unitPrice: item.unitPrice,
          quantity: 1,
        },
      ];
    });
    flash(`${item.name} (${variant.label}) added.`);
  };

  const setQuantity = (key, quantity) => {
    const value = Math.max(1, Math.min(50, Number(quantity) || 1));
    setBasket((current) =>
      current.map((line) => (line.key === key ? { ...line, quantity: value } : line))
    );
  };

  const removeLine = (key) => {
    setBasket((current) => current.filter((line) => line.key !== key));
  };

  const placeOrder = async (event) => {
    event.preventDefault();
    if (basket.length === 0) {
      setError('Add something to the basket first.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const res = await api.post('/store/orders', {
        ...orderDetails,
        lines: basket.map((line) => ({
          item: line.item,
          variantSku: line.variantSku,
          quantity: line.quantity,
        })),
      });
      flash(res.data.message);
      setBasket([]);
      setOrderDetails(emptyOrderDetails);
      await Promise.all([loadItems(), loadMyOrders(), loadCounter()]);
      setTab('orders');
    } catch (err) {
      // A 409 means somebody took the last one between the page rendering and
      // this request. Reload so the sizes on screen stop offering it.
      setError(err.response?.data?.message || 'Could not place that order.');
      if (err.response?.status === 409) await loadItems();
    } finally {
      setSubmitting(false);
    }
  };

  const cancelOrder = async (order) => {
    const reason = window.prompt('Why is the order being cancelled? (optional)') ?? '';
    setError('');
    try {
      await api.patch(`/store/orders/${order._id}/cancel`, {
        cancelReason: reason || null,
      });
      flash('Order cancelled and the stock released.');
      await Promise.all([loadItems(), loadMyOrders(), loadCounter()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not cancel that order.');
    }
  };

  // --- Counter -------------------------------------------------------------

  const markReady = async (order) => {
    setError('');
    try {
      await api.patch(`/store/orders/${order._id}/ready`);
      flash(`${order.reference} is ready for collection.`);
      await loadCounter();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not update that order.');
    }
  };

  const collect = async (order) => {
    const collectedByName = window.prompt('Who is collecting it?', order.ordererName || '');
    if (!collectedByName) return;
    setError('');
    try {
      await api.patch(`/store/orders/${order._id}/collect`, { collectedByName });
      flash(`${order.reference} handed over.`);
      await Promise.all([loadCounter(), loadItems()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not complete that collection.');
    }
  };

  const runExpirySweep = async () => {
    setError('');
    try {
      const res = await api.post('/store/orders/expire');
      flash(res.data.message);
      await Promise.all([loadCounter(), loadItems()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not run the sweep.');
    }
  };

  const submitAdjustment = async (event) => {
    event.preventDefault();
    if (!adjusting) return;
    setError('');
    try {
      await api.patch(
        `/store/items/${adjusting.itemId}/variants/${adjusting.variantSku}/stock`,
        {
          delta: Number(adjustment.delta),
          reason: adjustment.reason,
          note: adjustment.note || null,
        }
      );
      flash('Stock adjusted.');
      setAdjusting(null);
      setAdjustment({ delta: '', reason: 'receive', note: '' });
      await Promise.all([loadItems(), loadCounter()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not adjust that stock.');
    }
  };

  // --- Render --------------------------------------------------------------

  const tabs = [
    { id: 'catalogue', label: 'Catalogue' },
    { id: 'basket', label: `Basket (${basket.length})` },
    { id: 'orders', label: 'My orders' },
    ...(isAdmin ? [{ id: 'counter', label: 'Counter' }] : []),
  ];

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-gray-500">
        Loading the store...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="bg-gradient-to-r from-amber-600 to-orange-700 rounded-2xl p-6 mb-6 text-white">
          <h1 className="text-2xl font-bold">School store</h1>
          <p className="text-amber-100 mt-1 text-sm">
            Books, uniform and kit — with a number next to each size that means something.
          </p>
        </div>

        {notice && (
          <div className="mb-4 rounded-lg bg-green-100 text-green-800 px-4 py-3 text-sm">
            {notice}
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-lg bg-red-100 text-red-800 px-4 py-3 text-sm">
            {error}
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-6 bg-white rounded-xl p-1 shadow">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setTab(entry.id)}
              className={`flex-1 min-w-[110px] py-2 px-4 rounded-lg text-sm font-medium transition ${
                tab === entry.id
                  ? 'bg-amber-600 text-white shadow'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {/* ---------------------------------------------------------------- */}
        {tab === 'catalogue' && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl shadow p-4 flex flex-wrap items-center gap-4">
              <input
                type="search"
                placeholder="Search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[160px]"
              />
              <select
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value)}
                className="border rounded-lg px-3 py-2 text-sm"
              >
                <option value="">All categories</option>
                {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={inStockOnly}
                  onChange={(event) => setInStockOnly(event.target.checked)}
                />
                In stock only
              </label>
            </div>

            {items.length === 0 ? (
              <div className="bg-white rounded-xl shadow p-6 text-sm text-gray-500">
                Nothing matches that.
              </div>
            ) : (
              items.map((item) => (
                <div key={item._id} className="bg-white rounded-xl shadow p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <h2 className="font-semibold">{item.name}</h2>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                          {CATEGORY_LABELS[item.category]}
                        </span>
                        {item.mandatory && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                            Required
                          </span>
                        )}
                        {item.status === 'discontinued' && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-600">
                            Discontinued
                          </span>
                        )}
                      </div>
                      {item.description && (
                        <p className="text-sm text-gray-500 mt-1">{item.description}</p>
                      )}
                      {item.classesApplicable?.length > 0 && (
                        <p className="text-xs text-gray-500 mt-1">
                          For {item.classesApplicable.join(', ')}
                        </p>
                      )}
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-bold">₹{item.unitPrice}</div>
                      <div className="text-xs text-gray-500">{item.sku}</div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 mt-4">
                    {(item.variants || []).map((variant) => {
                      const available =
                        variant.available ??
                        Math.max(0, (variant.stock || 0) - (variant.reserved || 0));
                      return (
                        <div
                          key={variant.variantSku}
                          className="border rounded-lg px-3 py-2 flex items-center gap-3"
                        >
                          <div>
                            <div className="text-sm font-medium">{variant.label}</div>
                            <div
                              className={`text-xs ${
                                available === 0 ? 'text-red-600' : 'text-gray-500'
                              }`}
                            >
                              {available === 0 ? 'Out of stock' : `${available} available`}
                              {isAdmin && variant.reserved > 0 && (
                                <span className="text-gray-400">
                                  {' '}
                                  ({variant.reserved} reserved)
                                </span>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={() => addToBasket(item, variant)}
                            disabled={available === 0 || item.status !== 'active'}
                            className="text-xs bg-amber-600 text-white px-3 py-1.5 rounded-lg hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            Add
                          </button>
                          {isAdmin && (
                            <button
                              onClick={() =>
                                setAdjusting({
                                  itemId: item._id,
                                  itemName: item.name,
                                  variantSku: variant.variantSku,
                                  label: variant.label,
                                })
                              }
                              className="text-xs text-gray-500 hover:underline"
                            >
                              Adjust
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {tab === 'basket' && (
          <form onSubmit={placeOrder} className="space-y-4">
            {basket.length === 0 ? (
              <div className="bg-white rounded-xl shadow p-6 text-sm text-gray-500">
                Your basket is empty. Nothing is reserved until you place the order.
              </div>
            ) : (
              <>
                <div className="bg-white rounded-xl shadow divide-y">
                  {basket.map((line) => (
                    <div
                      key={line.key}
                      className="p-4 flex flex-wrap items-center justify-between gap-3"
                    >
                      <div>
                        <div className="font-medium">{line.itemName}</div>
                        <div className="text-sm text-gray-500">
                          {line.variantLabel} · ₹{line.unitPrice} each
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <input
                          type="number"
                          min="1"
                          max="50"
                          value={line.quantity}
                          onChange={(event) => setQuantity(line.key, event.target.value)}
                          className="border rounded-lg px-3 py-2 w-20 text-sm"
                        />
                        <div className="w-20 text-right font-medium">
                          ₹{line.unitPrice * line.quantity}
                        </div>
                        <button
                          type="button"
                          onClick={() => removeLine(line.key)}
                          className="text-xs text-red-600 hover:underline"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                  <div className="p-4 flex justify-between font-semibold">
                    <span>Total</span>
                    <span>₹{basketTotal}</span>
                  </div>
                </div>

                <div className="bg-white rounded-xl shadow p-5 grid sm:grid-cols-3 gap-4">
                  {[
                    { field: 'studentName', label: 'Student name', required: true },
                    { field: 'className', label: 'Class', required: false },
                    { field: 'contactNumber', label: 'Contact number', required: false },
                  ].map((input) => (
                    <label key={input.field} className="text-sm">
                      <span className="block text-gray-500 mb-1">{input.label}</span>
                      <input
                        type="text"
                        required={input.required}
                        value={orderDetails[input.field]}
                        onChange={(event) =>
                          setOrderDetails({
                            ...orderDetails,
                            [input.field]: event.target.value,
                          })
                        }
                        className="w-full border rounded-lg px-3 py-2"
                      />
                    </label>
                  ))}
                  <div className="sm:col-span-3">
                    <button
                      type="submit"
                      disabled={submitting}
                      className="bg-amber-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-amber-500 disabled:opacity-50"
                    >
                      {submitting ? 'Reserving...' : 'Reserve and collect later'}
                    </button>
                    <p className="text-xs text-gray-500 mt-2">
                      Stock is held for you from the moment this is submitted, for three days.
                    </p>
                  </div>
                </div>
              </>
            )}
          </form>
        )}

        {/* ---------------------------------------------------------------- */}
        {tab === 'orders' && (
          <div className="space-y-3">
            {myOrders.length === 0 ? (
              <div className="bg-white rounded-xl shadow p-6 text-sm text-gray-500">
                You have not ordered anything.
              </div>
            ) : (
              myOrders.map((order) => (
                <div key={order._id} className="bg-white rounded-xl shadow p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold">{order.reference}</span>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            ORDER_STATUS_STYLES[order.status]
                          }`}
                        >
                          {order.status}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                          {PAYMENT_LABELS[order.paymentStatus]}
                        </span>
                      </div>
                      <div className="text-sm text-gray-600 mt-1">
                        For {order.studentName}
                        {order.className ? ` (${order.className})` : ''}
                      </div>
                      <ul className="mt-2 text-sm text-gray-600 space-y-0.5">
                        {order.lines.map((line) => (
                          <li key={line._id}>
                            {line.quantity} × {line.itemName} ({line.variantLabel}) — ₹
                            {line.lineTotal}
                          </li>
                        ))}
                      </ul>
                      {order.status === 'reserved' && order.reservedUntil && (
                        <p className="text-xs text-gray-500 mt-2">
                          Held until{' '}
                          {new Date(order.reservedUntil).toLocaleDateString(undefined, {
                            day: 'numeric',
                            month: 'short',
                          })}
                        </p>
                      )}
                      {order.cancelReason && (
                        <p className="text-xs text-gray-500 mt-1">{order.cancelReason}</p>
                      )}
                    </div>
                    <div className="text-right">
                      <div className="font-semibold">₹{order.total}</div>
                      {(order.status === 'reserved' || order.status === 'ready') && (
                        <button
                          onClick={() => cancelOrder(order)}
                          className="mt-2 text-sm border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {tab === 'counter' && isAdmin && (
          <div className="space-y-6">
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold">To pick ({counterOrders.length})</h2>
                <button
                  onClick={runExpirySweep}
                  className="text-sm border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50"
                >
                  Release expired holds
                </button>
              </div>
              {counterOrders.length === 0 ? (
                <div className="bg-white rounded-xl shadow p-6 text-sm text-gray-500">
                  Nothing waiting.
                </div>
              ) : (
                <div className="space-y-3">
                  {counterOrders.map((order) => (
                    <div key={order._id} className="bg-white rounded-xl shadow p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="font-semibold">{order.reference}</div>
                          <div className="text-sm text-gray-600">
                            {order.studentName}
                            {order.className ? ` (${order.className})` : ''} ·{' '}
                            {order.ordererName}
                          </div>
                          <ul className="mt-2 text-sm text-gray-600 space-y-0.5">
                            {order.lines.map((line) => (
                              <li key={line._id}>
                                {line.quantity} × {line.itemName} ({line.variantLabel})
                              </li>
                            ))}
                          </ul>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => markReady(order)}
                            className="text-sm border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50"
                          >
                            Picked
                          </button>
                          <button
                            onClick={() => collect(order)}
                            className="text-sm bg-amber-600 text-white px-3 py-1.5 rounded-lg hover:bg-amber-500"
                          >
                            Hand over
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h2 className="text-lg font-semibold mb-3">
                Low stock ({lowStock.length})
              </h2>
              {lowStock.length === 0 ? (
                <div className="bg-white rounded-xl shadow p-6 text-sm text-gray-500">
                  Nothing at or below its reorder level.
                </div>
              ) : (
                <div className="bg-white rounded-xl shadow overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-left text-gray-600">
                      <tr>
                        <th className="px-4 py-3">Item</th>
                        <th className="px-4 py-3">Size</th>
                        <th className="px-4 py-3">Available</th>
                        <th className="px-4 py-3">Reorder at</th>
                        <th className="px-4 py-3">Supplier</th>
                        <th className="px-4 py-3" />
                      </tr>
                    </thead>
                    <tbody>
                      {lowStock.map((row) => (
                        <tr key={`${row.itemId}-${row.variantSku}`} className="border-t">
                          <td className="px-4 py-3">{row.itemName}</td>
                          <td className="px-4 py-3">{row.label}</td>
                          <td
                            className={`px-4 py-3 font-medium ${
                              row.available === 0 ? 'text-red-600' : ''
                            }`}
                          >
                            {row.available}
                          </td>
                          <td className="px-4 py-3 text-gray-500">{row.reorderLevel}</td>
                          <td className="px-4 py-3 text-gray-500">{row.supplier || '—'}</td>
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={() =>
                                setAdjusting({
                                  itemId: row.itemId,
                                  itemName: row.itemName,
                                  variantSku: row.variantSku,
                                  label: row.label,
                                })
                              }
                              className="text-xs text-amber-700 hover:underline"
                            >
                              Receive stock
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}

        {/* Stock adjustment ------------------------------------------------ */}
        {adjusting && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
            <form
              onSubmit={submitAdjustment}
              className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4"
            >
              <div>
                <h3 className="text-lg font-semibold">Adjust stock</h3>
                <p className="text-sm text-gray-500">
                  {adjusting.itemName} · {adjusting.label} ({adjusting.variantSku})
                </p>
              </div>

              <label className="text-sm block">
                <span className="block text-gray-500 mb-1">
                  Change (negative to take units out)
                </span>
                <input
                  type="number"
                  required
                  value={adjustment.delta}
                  onChange={(event) =>
                    setAdjustment({ ...adjustment, delta: event.target.value })
                  }
                  className="w-full border rounded-lg px-3 py-2"
                />
              </label>

              <label className="text-sm block">
                <span className="block text-gray-500 mb-1">Reason</span>
                <select
                  value={adjustment.reason}
                  onChange={(event) =>
                    setAdjustment({ ...adjustment, reason: event.target.value })
                  }
                  className="w-full border rounded-lg px-3 py-2"
                >
                  {ADJUSTMENT_REASONS.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-sm block">
                <span className="block text-gray-500 mb-1">Note (optional)</span>
                <input
                  type="text"
                  value={adjustment.note}
                  onChange={(event) =>
                    setAdjustment({ ...adjustment, note: event.target.value })
                  }
                  className="w-full border rounded-lg px-3 py-2"
                />
              </label>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setAdjusting(null)}
                  className="text-sm border border-gray-300 px-4 py-2 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="text-sm bg-amber-600 text-white px-4 py-2 rounded-lg hover:bg-amber-500"
                >
                  Record it
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};

export default SchoolStore;
