const crypto = require('crypto');
const mongoose = require('mongoose');
const StoreItem = require('../models/StoreItem');
const StoreOrder = require('../models/StoreOrder');

/**
 * The school store.
 *
 * `placeOrder` is the handler that matters, and specifically the compensating
 * release inside it. Without a transaction to lean on, a multi-line order takes
 * its reservations one line at a time and hands back everything it has taken if
 * any line fails. That is only correct because releasing a reservation is an
 * unconditional `$inc` in the safe direction — it has no guard that can refuse
 * it, so the undo cannot itself fail halfway.
 */

// How long a reservation is held before the sweep can take it back.
const DEFAULT_HOLD_HOURS = 72;

const HOLDING = StoreOrder.HOLDING_STATUSES;

function makeReference() {
  const year = new Date().getFullYear();
  return `SO-${year}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

function serverError(res, error, message) {
  console.error(`${message}:`, error);
  return res.status(500).json({
    success: false,
    message,
    error: error.message,
  });
}

function validationMessage(error) {
  if (!error) return null;
  if (error.name === 'ValidationError') {
    return Object.values(error.errors)
      .map((e) => e.message)
      .join(' ');
  }
  if (error.name === 'ValidatorError' || error.name === 'CastError') {
    return error.message;
  }
  if (error.code === 11000) {
    return 'That code is already in use.';
  }
  return null;
}

function isAdmin(user) {
  return user && user.role === 'admin';
}

/**
 * Gives a variant's reserved units back, unconditionally.
 *
 * This is the undo half of the order path and it must never be able to refuse.
 * It is filtered only on the item and the variant existing — no `$expr`, no
 * status check — because a compensating action that can fail leaves the
 * inventory in the state the compensation existed to prevent.
 */
async function releaseReservation(itemId, variantSku, quantity) {
  await StoreItem.updateOne(
    { _id: itemId, 'variants.variantSku': variantSku },
    { $inc: { 'variants.$[v].reserved': -quantity } },
    { arrayFilters: [{ 'v.variantSku': variantSku }] }
  );
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/**
 * POST /api/store/items
 */
exports.createItem = async (req, res) => {
  try {
    const {
      name,
      sku,
      category,
      description,
      unitPrice,
      classesApplicable,
      mandatory,
      supplier,
      notes,
      variants,
    } = req.body;

    // Opening stock arrives through this field, and it is the one place a
    // variant may be born with units on it. Every later change goes through the
    // reason-coded adjustment endpoint.
    const cleanVariants = (Array.isArray(variants) ? variants : []).map((variant) => ({
      variantSku: variant.variantSku,
      label: variant.label,
      size: variant.size,
      stock: Number(variant.stock) || 0,
      reserved: 0,
      reorderLevel: variant.reorderLevel,
      active: variant.active !== false,
    }));

    const item = await StoreItem.create({
      name,
      sku,
      category,
      description,
      unitPrice,
      classesApplicable: Array.isArray(classesApplicable) ? classesApplicable : [],
      mandatory: mandatory === true,
      supplier,
      notes,
      variants: cleanVariants,
      movements: cleanVariants
        .filter((variant) => variant.stock > 0)
        .map((variant) => ({
          variantSku: variant.variantSku,
          reason: 'receive',
          delta: variant.stock,
          resultingStock: variant.stock,
          note: 'Opening stock',
          actor: req.user._id,
          actorName: req.user.name,
        })),
    });

    return res.status(201).json({
      success: true,
      message: `${item.name} added to the catalogue.`,
      data: item.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to add the item');
  }
};

/**
 * GET /api/store/items
 */
exports.listItems = async (req, res) => {
  try {
    const { category, className, inStockOnly, search } = req.query;

    const filter = {};
    if (!isAdmin(req.user)) filter.status = 'active';
    if (category) filter.category = category;
    if (className) {
      filter.$or = [{ classesApplicable: className }, { classesApplicable: { $size: 0 } }];
    }
    if (search) filter.name = { $regex: String(search).slice(0, 60), $options: 'i' };

    let items = await StoreItem.find(filter).sort({ category: 1, name: 1 }).limit(300);

    if (inStockOnly === 'true') {
      items = items.filter((item) => item.totalAvailable > 0);
    }

    return res.status(200).json({
      success: true,
      count: items.length,
      data: items.map((item) => item.redactFor(req.user)),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the catalogue');
  }
};

/**
 * GET /api/store/items/:id
 */
exports.getItem = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid item id.');

    const item = await StoreItem.findById(req.params.id);
    if (!item) return fail(res, 404, 'Item not found.');

    return res.status(200).json({ success: true, data: item.redactFor(req.user) });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the item');
  }
};

/**
 * PATCH /api/store/items/:id
 *
 * Deliberately cannot touch `stock` or `reserved`. Stock moves through the
 * adjustment endpoint, which demands a reason and writes a movement; an
 * inventory that can be edited freely from a general update handler is one
 * where nobody can say why a number changed.
 */
exports.updateItem = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid item id.');

    const item = await StoreItem.findById(req.params.id);
    if (!item) return fail(res, 404, 'Item not found.');

    const editable = [
      'name',
      'category',
      'description',
      'unitPrice',
      'classesApplicable',
      'mandatory',
      'supplier',
      'notes',
      'status',
    ];
    for (const field of editable) {
      if (req.body[field] !== undefined) item[field] = req.body[field];
    }

    if (item.status === 'discontinued') {
      const held = item.variants.reduce((sum, variant) => sum + variant.reserved, 0);
      if (held > 0) {
        return fail(
          res,
          409,
          `${held} unit${held === 1 ? ' is' : 's are'} reserved against this item. Hand them over or cancel those orders first.`
        );
      }
    }

    await item.save();

    return res.status(200).json({
      success: true,
      message: 'Item updated.',
      data: item.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update the item');
  }
};

/**
 * POST /api/store/items/:id/variants
 */
exports.addVariant = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid item id.');

    const item = await StoreItem.findById(req.params.id);
    if (!item) return fail(res, 404, 'Item not found.');

    const { variantSku, label, size, stock, reorderLevel } = req.body;
    if (item.findVariant(variantSku)) {
      return fail(res, 409, 'That variant code already exists on this item.');
    }

    const opening = Number(stock) || 0;
    item.variants.push({
      variantSku,
      label,
      size,
      stock: opening,
      reserved: 0,
      reorderLevel,
    });

    if (opening > 0) {
      item.movements.push({
        variantSku: String(variantSku).toUpperCase(),
        reason: 'receive',
        delta: opening,
        resultingStock: opening,
        note: 'Opening stock',
        actor: req.user._id,
        actorName: req.user.name,
      });
    }

    await item.save();

    return res.status(201).json({
      success: true,
      message: `${label} added to ${item.name}.`,
      data: item.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to add the variant');
  }
};

/**
 * PATCH /api/store/items/:id/variants/:variantSku/stock
 *
 * The only way `stock` changes other than collection. A reason is mandatory and
 * a movement is written, so every number on the shelf can be traced back to
 * somebody who typed it and said why.
 *
 * A decrease is guarded so it cannot take stock below what is already reserved;
 * writing off units that are spoken for would leave orders that cannot be
 * fulfilled and a counter that lies.
 */
exports.adjustStock = async (req, res) => {
  try {
    const { id, variantSku } = req.params;
    const { delta, reason, note } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid item id.');

    const change = Number(delta);
    if (!Number.isInteger(change) || change === 0) {
      return fail(res, 400, 'delta must be a non-zero whole number.');
    }
    if (!StoreItem.ADJUSTMENT_REASONS.includes(reason)) {
      return fail(
        res,
        400,
        `reason must be one of: ${StoreItem.ADJUSTMENT_REASONS.join(', ')}.`
      );
    }

    const item = await StoreItem.findById(id);
    if (!item) return fail(res, 404, 'Item not found.');

    const code = String(variantSku).toUpperCase();
    const variant = item.findVariant(code);
    if (!variant) return fail(res, 404, 'That variant is not on this item.');

    if (change < 0 && variant.stock + change < variant.reserved) {
      return fail(
        res,
        409,
        `${variant.reserved} unit${variant.reserved === 1 ? ' is' : 's are'} already reserved. Stock cannot go below that.`
      );
    }

    const updated = await StoreItem.findOneAndUpdate(
      {
        _id: item._id,
        variants: {
          $elemMatch: {
            variantSku: code,
            // Re-checked on the write so a concurrent order cannot slip a
            // reservation in between the check above and this update.
            $expr: { $gte: [{ $add: ['$stock', change] }, '$reserved'] },
          },
        },
      },
      {
        $inc: { 'variants.$[v].stock': change },
        $push: {
          movements: {
            variantSku: code,
            reason,
            delta: change,
            resultingStock: variant.stock + change,
            note: note || null,
            actor: req.user._id,
            actorName: req.user.name,
            at: new Date(),
          },
        },
      },
      { new: true, arrayFilters: [{ 'v.variantSku': code }] }
    );

    if (!updated) {
      return fail(
        res,
        409,
        'Stock changed while you were adjusting it. Reload and try again.'
      );
    }

    return res.status(200).json({
      success: true,
      message: `${code} adjusted by ${change > 0 ? '+' : ''}${change}.`,
      data: updated.redactFor(req.user),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to adjust the stock');
  }
};

/**
 * GET /api/store/low-stock
 * The ordering problem the school actually has.
 */
exports.getLowStock = async (req, res) => {
  try {
    const items = await StoreItem.find({ status: 'active' }).limit(500);

    const rows = [];
    for (const item of items) {
      for (const variant of item.variants) {
        if (!variant.active) continue;
        const available = Math.max(0, variant.stock - variant.reserved);
        if (available > variant.reorderLevel) continue;
        rows.push({
          itemId: item._id,
          itemName: item.name,
          sku: item.sku,
          category: item.category,
          variantSku: variant.variantSku,
          label: variant.label,
          stock: variant.stock,
          reserved: variant.reserved,
          available,
          reorderLevel: variant.reorderLevel,
          supplier: item.supplier,
        });
      }
    }

    rows.sort((a, b) => a.available - b.available || a.itemName.localeCompare(b.itemName));

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    return serverError(res, error, 'Failed to build the low-stock report');
  }
};

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * POST /api/store/orders
 *
 * Each line is reserved with a conditional update that matches the variant and
 * requires the available count to still cover the quantity:
 *
 *   variants: { $elemMatch: { variantSku, active: true,
 *                             $expr: { $gte: [ { $subtract: ['$stock','$reserved'] },
 *                                              quantity ] } } }
 *
 * with the update incrementing that variant's `reserved`. Two parents taking
 * the last blazer means one matches nothing and is told so, before any money is
 * discussed.
 *
 * Lines are taken one at a time because they touch different documents. If any
 * line fails — or the order document itself fails to save — every reservation
 * already taken is released before returning. Half-applied inventory is worse
 * than a rejected order, and the release cannot itself be refused, so the undo
 * always completes.
 */
exports.placeOrder = async (req, res) => {
  const taken = [];

  try {
    const { studentName, className, contactNumber, lines } = req.body;

    if (!Array.isArray(lines) || lines.length === 0) {
      return fail(res, 400, 'Add at least one item to the order.');
    }
    if (lines.length > 20) {
      return fail(res, 400, 'An order cannot have more than 20 lines.');
    }

    const orderLines = [];

    for (const line of lines) {
      const quantity = Number(line.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
        await Promise.all(
          taken.map((held) => releaseReservation(held.item, held.variantSku, held.quantity))
        );
        return fail(res, 400, 'Each line needs a whole quantity between 1 and 50.');
      }
      if (!isValidId(line.item)) {
        await Promise.all(
          taken.map((held) => releaseReservation(held.item, held.variantSku, held.quantity))
        );
        return fail(res, 400, 'One of those items does not exist.');
      }

      const code = String(line.variantSku || '').toUpperCase();

      const reserved = await StoreItem.findOneAndUpdate(
        {
          _id: line.item,
          status: 'active',
          variants: {
            $elemMatch: {
              variantSku: code,
              active: true,
              $expr: { $gte: [{ $subtract: ['$stock', '$reserved'] }, quantity] },
            },
          },
        },
        { $inc: { 'variants.$[v].reserved': quantity } },
        { new: true, arrayFilters: [{ 'v.variantSku': code }] }
      );

      if (!reserved) {
        // Give back everything taken so far, then explain what went wrong using
        // a fresh read rather than a guess.
        await Promise.all(
          taken.map((held) => releaseReservation(held.item, held.variantSku, held.quantity))
        );

        const item = await StoreItem.findById(line.item);
        return fail(
          res,
          409,
          item
            ? item.orderabilityError(code, quantity) || 'That item is no longer available.'
            : 'One of those items no longer exists.'
        );
      }

      taken.push({ item: reserved._id, variantSku: code, quantity });

      const variant = reserved.findVariant(code);
      orderLines.push({
        item: reserved._id,
        itemName: reserved.name,
        itemSku: reserved.sku,
        variantSku: code,
        variantLabel: variant.label,
        unitPrice: reserved.unitPrice,
        quantity,
        lineTotal: reserved.unitPrice * quantity,
      });
    }

    const order = await StoreOrder.create({
      reference: makeReference(),
      orderedBy: req.user._id,
      ordererName: req.user.name,
      studentName,
      className,
      contactNumber,
      lines: orderLines,
      reservedUntil: new Date(Date.now() + DEFAULT_HOLD_HOURS * 60 * 60 * 1000),
      // status, total and every timestamp are server-owned.
    });

    return res.status(201).json({
      success: true,
      message: `Order ${order.reference} reserved. Collect it by ${order.reservedUntil.toLocaleDateString()}.`,
      reference: order.reference,
      data: order.redactFor(req.user),
    });
  } catch (error) {
    // The order document failed to save after the stock was reserved. Hand it
    // all back — this is the case the compensating release exists for.
    await Promise.all(
      taken.map((held) => releaseReservation(held.item, held.variantSku, held.quantity))
    );

    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to place the order');
  }
};

/**
 * GET /api/store/orders
 */
exports.listOrders = async (req, res) => {
  try {
    const { status, from, to } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(`${to}T23:59:59`);
    }

    const orders = await StoreOrder.find(filter).sort({ createdAt: -1 }).limit(300);

    return res.status(200).json({
      success: true,
      count: orders.length,
      data: orders.map((order) => order.redactFor(req.user)),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch orders');
  }
};

/**
 * GET /api/store/my-orders
 */
exports.getMyOrders = async (req, res) => {
  try {
    const orders = await StoreOrder.find({ orderedBy: req.user._id })
      .sort({ createdAt: -1 })
      .limit(100);

    return res.status(200).json({
      success: true,
      count: orders.length,
      data: orders.map((order) => order.redactFor(req.user)),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch your orders');
  }
};

/**
 * GET /api/store/orders/:id
 */
exports.getOrder = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid order id.');

    const order = await StoreOrder.findById(req.params.id);
    if (!order) return fail(res, 404, 'Order not found.');

    const isOwner = String(order.orderedBy) === String(req.user._id);
    if (!isOwner && !['teacher', 'admin'].includes(req.user.role)) {
      return fail(res, 403, 'That order is not yours.');
    }

    return res.status(200).json({ success: true, data: order.redactFor(req.user) });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the order');
  }
};

/**
 * PATCH /api/store/orders/:id/ready
 * Picked and waiting at the counter. Still reserved, not yet moved.
 */
exports.markReady = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid order id.');

    const order = await StoreOrder.findOneAndUpdate(
      { _id: req.params.id, status: 'reserved' },
      { $set: { status: 'ready', readyAt: new Date(), counterNote: req.body.counterNote || null } },
      { new: true }
    );

    if (!order) return fail(res, 409, 'That order is not waiting to be picked.');

    return res.status(200).json({
      success: true,
      message: `${order.reference} is ready for collection.`,
      data: order.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to mark the order ready');
  }
};

/**
 * PATCH /api/store/orders/:id/collect
 *
 * The moment the goods leave the room. For each line the units come out of
 * `reserved` *and* out of `stock` in one update — that pairing is what keeps
 * the shelf count equal to the shelf.
 *
 * The status change is applied first, filtered on the order still holding
 * stock, so a double tap on the counter tablet cannot decrement the stock
 * twice. If a line's stock update somehow fails the order is put back to
 * `ready` and the whole collection is refused, rather than being left half
 * handed over.
 */
exports.collectOrder = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid order id.');

    const claimed = await StoreOrder.findOneAndUpdate(
      { _id: req.params.id, status: { $in: HOLDING } },
      {
        $set: {
          status: 'collected',
          collectedAt: new Date(),
          collectedBy: req.user._id,
          collectedByName: req.body.collectedByName || req.user.name,
        },
      },
      { new: true }
    );

    if (!claimed) {
      return fail(res, 409, 'That order is not holding any stock to hand over.');
    }

    const failures = [];
    for (const line of claimed.lines) {
      const moved = await StoreItem.findOneAndUpdate(
        {
          _id: line.item,
          variants: {
            $elemMatch: {
              variantSku: line.variantSku,
              stock: { $gte: line.quantity },
              reserved: { $gte: line.quantity },
            },
          },
        },
        {
          $inc: {
            'variants.$[v].stock': -line.quantity,
            'variants.$[v].reserved': -line.quantity,
          },
          $push: {
            movements: {
              variantSku: line.variantSku,
              reason: 'correction',
              delta: -line.quantity,
              resultingStock: 0,
              note: `Collected on ${claimed.reference}`,
              actor: req.user._id,
              actorName: req.user.name,
              at: new Date(),
            },
          },
        },
        { new: true, arrayFilters: [{ 'v.variantSku': line.variantSku }] }
      );

      if (!moved) {
        failures.push(`${line.itemName} (${line.variantLabel})`);
        continue;
      }

      // `resultingStock` is written blind above because the pushed movement
      // cannot read the post-update value; correct it now that the result is in
      // hand, so the audit trail is not misleading.
      const variant = moved.findVariant(line.variantSku);
      await StoreItem.updateOne(
        { _id: moved._id, 'movements._id': moved.movements[moved.movements.length - 1]._id },
        { $set: { 'movements.$.resultingStock': variant ? variant.stock : 0 } }
      );
    }

    if (failures.length > 0) {
      // Put the order back so the counter can deal with it, rather than
      // recording a hand-over the shelf disagrees with.
      await StoreOrder.updateOne(
        { _id: claimed._id },
        {
          $set: { status: 'ready', collectedAt: null, collectedBy: null, collectedByName: null },
        }
      );
      return fail(
        res,
        409,
        `The stock records do not match for ${failures.join(', ')}. Check the shelf before handing this order over.`
      );
    }

    return res.status(200).json({
      success: true,
      message: `${claimed.reference} handed over.`,
      data: claimed.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to complete the collection');
  }
};

/**
 * PATCH /api/store/orders/:id/cancel
 * Releases every reservation the order was holding.
 */
exports.cancelOrder = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid order id.');

    const order = await StoreOrder.findById(req.params.id);
    if (!order) return fail(res, 404, 'Order not found.');

    const isOwner = String(order.orderedBy) === String(req.user._id);
    if (!isOwner && !isAdmin(req.user)) {
      return fail(res, 403, 'That order is not yours to cancel.');
    }

    // Claim the cancellation first, so two taps cannot both go on to release
    // the same reservations and drive `reserved` negative.
    const cancelled = await StoreOrder.findOneAndUpdate(
      { _id: order._id, status: { $in: HOLDING } },
      { $set: { status: 'cancelled', cancelReason: req.body.cancelReason || null } },
      { new: true }
    );

    if (!cancelled) return fail(res, 409, 'That order is not holding any stock.');

    await Promise.all(
      cancelled.lines.map((line) =>
        releaseReservation(line.item, line.variantSku, line.quantity)
      )
    );

    return res.status(200).json({
      success: true,
      message: `${cancelled.reference} cancelled and the stock released.`,
      data: cancelled.redactFor(req.user),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to cancel the order');
  }
};

/**
 * POST /api/store/orders/expire
 *
 * The sweep. Each order is claimed with its own conditional update before its
 * reservations are released, so running the sweep twice — or running it while
 * somebody collects — cannot release the same units twice.
 */
exports.expireStaleOrders = async (req, res) => {
  try {
    const now = new Date();

    const stale = await StoreOrder.find({
      status: { $in: HOLDING },
      reservedUntil: { $lt: now },
    }).limit(500);

    const expired = [];
    for (const order of stale) {
      const claimed = await StoreOrder.findOneAndUpdate(
        { _id: order._id, status: { $in: HOLDING }, reservedUntil: { $lt: now } },
        { $set: { status: 'expired', cancelReason: 'Not collected before the hold expired.' } },
        { new: true }
      );
      if (!claimed) continue;

      await Promise.all(
        claimed.lines.map((line) =>
          releaseReservation(line.item, line.variantSku, line.quantity)
        )
      );
      expired.push(claimed.reference);
    }

    return res.status(200).json({
      success: true,
      message: `${expired.length} order${expired.length === 1 ? '' : 's'} expired and returned to stock.`,
      expired,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to expire stale orders');
  }
};

/**
 * GET /api/store/stats
 */
exports.getStats = async (req, res) => {
  try {
    const [items, orders] = await Promise.all([
      StoreItem.find({ status: 'active' }).select('name variants unitPrice category'),
      StoreOrder.find().select('status total lines createdAt').limit(2000),
    ]);

    let onShelf = 0;
    let reserved = 0;
    let lowVariants = 0;
    for (const item of items) {
      for (const variant of item.variants) {
        if (!variant.active) continue;
        onShelf += variant.stock;
        reserved += variant.reserved;
        if (variant.stock - variant.reserved <= variant.reorderLevel) lowVariants += 1;
      }
    }

    const byStatus = {};
    let collectedValue = 0;
    for (const order of orders) {
      byStatus[order.status] = (byStatus[order.status] || 0) + 1;
      if (order.status === 'collected') collectedValue += order.total;
    }

    return res.status(200).json({
      success: true,
      stats: {
        items: items.length,
        onShelf,
        reserved,
        available: onShelf - reserved,
        lowVariants,
        orders: orders.length,
        byStatus,
        collectedValue,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to build the store statistics');
  }
};
