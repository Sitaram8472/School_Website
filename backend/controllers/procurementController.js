const mongoose = require('mongoose');
const {
  ProcurementCounter,
  BudgetLine,
  PurchaseRequisition,
  REQUISITION_STATUSES,
  UNITS,
  THREE_QUOTE_THRESHOLD,
  MIN_QUOTES_ABOVE_THRESHOLD,
  MIN_JUSTIFICATION_LENGTH,
  money,
} = require('../models/PurchaseRequisition');

/**
 * Procurement.
 *
 * Two functions carry the module. `holdBudget` is the guarded update that takes
 * money out of an allocation, and `settleEncumbrance` is the only way it comes
 * back. Everything else — quotes, orders, receipts — is bookkeeping around
 * those two.
 *
 * The guard is expressed inside the query with `$expr`, so two approvals racing
 * for the last of an allocation cannot both succeed: the loser is refused with
 * the balance as it actually is rather than as it was when the handler started.
 */

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

function serverError(res, error, message) {
  console.error(`${message}:`, error);
  return res.status(500).json({ success: false, message, error: error.message });
}

function validationMessage(error) {
  if (!error) return null;
  if (error.name === 'ValidationError') {
    return Object.values(error.errors)
      .map((e) => e.message)
      .join(' ');
  }
  if (error.name === 'ValidatorError' || error.name === 'CastError') return error.message;
  return null;
}

function isAdmin(user) {
  return user && user.role === 'admin';
}

function sanitiseItems(list) {
  if (!Array.isArray(list)) return undefined;
  return list
    .filter((item) => item && item.description)
    .map((item) => ({
      description: item.description,
      quantity: Math.max(1, Number(item.quantity) || 1),
      unit: UNITS.includes(item.unit) ? item.unit : 'each',
      estimatedUnitCost: Math.max(0, Number(item.estimatedUnitCost) || 0),
    }));
}

async function loadRequisition(id, user, { ownerOnly = false } = {}) {
  if (!isValidId(id)) return { status: 400, message: 'Invalid requisition id' };

  const requisition = await PurchaseRequisition.findById(id);
  if (!requisition) return { status: 404, message: 'Requisition not found' };

  const owns = requisition.isOwnedBy(user);
  if (ownerOnly && !owns) {
    return { status: 403, message: 'That requisition was raised by somebody else' };
  }
  if (!owns && !isAdmin(user) && user.role !== 'staff') {
    return { status: 403, message: 'That requisition was raised by somebody else' };
  }

  return { requisition };
}

/**
 * Take money out of an allocation, or refuse with the real balance.
 *
 * The `$expr` guard is the whole point: it is evaluated by the database against
 * the document as it is at that instant, so this is safe under two people
 * approving at once in a way that reading the line and then writing it is not.
 */
async function holdBudget(budgetLineId, amount) {
  const held = await BudgetLine.findOneAndUpdate(
    {
      _id: budgetLineId,
      isActive: true,
      $expr: {
        $gte: [{ $subtract: ['$allocated', { $add: ['$committed', '$spent'] }] }, amount],
      },
    },
    { $inc: { committed: amount } },
    { new: true }
  );

  if (held) return { line: held };

  const line = await BudgetLine.findById(budgetLineId);
  if (!line) return { error: 'That budget line no longer exists' };
  if (!line.isActive) return { error: `Budget line ${line.code} is closed` };

  return {
    error: `${line.code} has ${line.available} available and this needs ${amount}`,
    line,
  };
}

/**
 * Put money back, exactly once.
 *
 * The state check is on the requisition rather than the budget line, and it is
 * a guarded update, so a rejection retried three times releases the hold once.
 * `spend` converts instead of releasing: committed down, spent up, by the same
 * amount that was held.
 */
async function settleEncumbrance(requisition, { spend = 0 } = {}) {
  const claimed = await PurchaseRequisition.findOneAndUpdate(
    { _id: requisition._id, 'encumbrance.state': 'held' },
    {
      $set: {
        'encumbrance.state': spend > 0 ? 'converted' : 'released',
        'encumbrance.settledAt': new Date(),
      },
    },
    { new: true }
  );

  if (!claimed) return { settled: false };

  const amount = claimed.encumbrance.amount;
  const spendAmount = Math.min(money(spend), amount);

  await BudgetLine.updateOne(
    { _id: claimed.budgetLine },
    { $inc: { committed: -amount, spent: spendAmount } }
  );

  return { settled: true, released: amount - spendAmount, spent: spendAmount };
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/** GET /api/procurement/meta */
exports.getMeta = async (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      statuses: REQUISITION_STATUSES,
      units: UNITS,
      threeQuoteThreshold: THREE_QUOTE_THRESHOLD,
      minQuotesAboveThreshold: MIN_QUOTES_ABOVE_THRESHOLD,
      minJustificationLength: MIN_JUSTIFICATION_LENGTH,
    },
  });
};

// ---------------------------------------------------------------------------
// Budget lines
// ---------------------------------------------------------------------------

/** POST /api/procurement/budget-lines */
exports.createBudgetLine = async (req, res) => {
  try {
    const line = new BudgetLine({
      code: req.body.code,
      financialYear: req.body.financialYear,
      department: req.body.department,
      title: req.body.title,
      allocated: Math.max(0, Number(req.body.allocated) || 0),
      createdBy: req.user._id,
    });

    line.recordHistory('created', req.user._id);
    await line.save();

    return res.status(201).json({ success: true, message: 'Budget line created', data: line });
  } catch (error) {
    if (error.code === 11000) {
      return fail(res, 409, 'That code already exists for this financial year');
    }
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to create the budget line');
  }
};

/** GET /api/procurement/budget-lines */
exports.listBudgetLines = async (req, res) => {
  try {
    const filter = {};
    if (req.query.financialYear) filter.financialYear = req.query.financialYear;
    if (req.query.department) filter.department = req.query.department;

    const lines = await BudgetLine.find(filter).sort({ financialYear: -1, code: 1 }).limit(300);
    return res.status(200).json({ success: true, count: lines.length, data: lines });
  } catch (error) {
    return serverError(res, error, 'Failed to load budget lines');
  }
};

/**
 * PATCH /api/procurement/budget-lines/:id
 *
 * An allocation may be revised, but never below what has already been committed
 * and spent — that would produce a negative available balance, which is the
 * figure the whole module exists to keep honest.
 */
exports.updateBudgetLine = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid budget line id');

    const line = await BudgetLine.findById(req.params.id);
    if (!line) return fail(res, 404, 'Budget line not found');

    if (req.body.allocated !== undefined) {
      const allocated = Math.max(0, Number(req.body.allocated) || 0);
      const inUse = line.committed + line.spent;
      if (allocated < inUse) {
        return fail(
          res,
          409,
          `${line.code} already has ${line.committed} committed and ${line.spent} spent; it cannot be cut to ${allocated}`
        );
      }
      line.allocated = allocated;
    }

    if (req.body.title !== undefined) line.title = req.body.title;
    if (req.body.department !== undefined) line.department = req.body.department;
    if (req.body.isActive !== undefined) line.isActive = Boolean(req.body.isActive);

    line.recordHistory('edited', req.user._id, req.body.note);
    await line.save();

    return res.status(200).json({ success: true, message: 'Budget line updated', data: line });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update the budget line');
  }
};

// ---------------------------------------------------------------------------
// Requisitions
// ---------------------------------------------------------------------------

/** POST /api/procurement/requisitions */
exports.createRequisition = async (req, res) => {
  try {
    if (!isValidId(req.body.budgetLine)) return fail(res, 400, 'Invalid budget line id');

    const line = await BudgetLine.findById(req.body.budgetLine);
    if (!line) return fail(res, 404, 'Budget line not found');
    if (!line.isActive) return fail(res, 409, `Budget line ${line.code} is closed`);

    const requisition = new PurchaseRequisition({
      raisedBy: req.user._id,
      department: req.body.department || line.department,
      budgetLine: line._id,
      justification: req.body.justification,
      neededBy: req.body.neededBy,
      items: sanitiseItems(req.body.items) || [],
      status: 'draft',
    });

    requisition.recordHistory('created', req.user._id);
    await requisition.save();

    return res.status(201).json({
      success: true,
      message: requisition.needsThreeQuotes
        ? `Raised for ${requisition.estimatedValue}; three quotations will be needed`
        : `Raised for ${requisition.estimatedValue}`,
      data: requisition,
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to raise the requisition');
  }
};

/** GET /api/procurement/requisitions/mine */
exports.getMyRequisitions = async (req, res) => {
  try {
    const requisitions = await PurchaseRequisition.find({ raisedBy: req.user._id })
      .sort({ createdAt: -1 })
      .populate('budgetLine', 'code title allocated committed spent');

    return res.status(200).json({
      success: true,
      count: requisitions.length,
      data: requisitions,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load your requisitions');
  }
};

/** GET /api/procurement/requisitions */
exports.listRequisitions = async (req, res) => {
  try {
    const filter = {};
    if (req.query.status && REQUISITION_STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (req.query.department) filter.department = req.query.department;

    const requisitions = await PurchaseRequisition.find(filter)
      .sort({ createdAt: -1 })
      .limit(300)
      .populate('budgetLine', 'code title')
      .populate('raisedBy', 'name email');

    return res.status(200).json({
      success: true,
      count: requisitions.length,
      data: requisitions,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load requisitions');
  }
};

/** GET /api/procurement/requisitions/:id */
exports.getRequisition = async (req, res) => {
  try {
    const { requisition, status, message } = await loadRequisition(req.params.id, req.user);
    if (!requisition) return fail(res, status, message);

    await requisition.populate('budgetLine', 'code title allocated committed spent');
    await requisition.populate('raisedBy', 'name email');

    return res.status(200).json({
      success: true,
      data: {
        requisition,
        outstanding: requisition.outstandingByItem(),
        approvalBlocker: requisition.approvalBlocker(),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load the requisition');
  }
};

/** PATCH /api/procurement/requisitions/:id */
exports.updateRequisition = async (req, res) => {
  try {
    const { requisition, status, message } = await loadRequisition(req.params.id, req.user, {
      ownerOnly: true,
    });
    if (!requisition) return fail(res, status, message);

    if (!requisition.isEditable()) {
      return fail(res, 409, `A ${requisition.status} requisition cannot be edited`);
    }

    const items = sanitiseItems(req.body.items);
    if (items) requisition.items = items;
    if (req.body.justification !== undefined) requisition.justification = req.body.justification;
    if (req.body.neededBy !== undefined) requisition.neededBy = req.body.neededBy;

    requisition.recordHistory('edited', req.user._id);
    await requisition.save();

    return res.status(200).json({ success: true, message: 'Requisition updated', data: requisition });
  } catch (error) {
    const msg = validationMessage(error);
    if (msg) return fail(res, 400, msg);
    return serverError(res, error, 'Failed to update the requisition');
  }
};

/** PATCH /api/procurement/requisitions/:id/submit */
exports.submitRequisition = async (req, res) => {
  try {
    const { requisition, status, message } = await loadRequisition(req.params.id, req.user, {
      ownerOnly: true,
    });
    if (!requisition) return fail(res, status, message);

    if (requisition.status !== 'draft') {
      return fail(res, 409, `That requisition is already ${requisition.status}`);
    }

    const financialYear = (await BudgetLine.findById(requisition.budgetLine))?.financialYear;
    const serial = await ProcurementCounter.next(`PR:${financialYear}`);
    requisition.ref = `PR/${financialYear}/${String(serial).padStart(3, '0')}`;
    requisition.status = 'quoting';
    requisition.recordHistory('submitted', req.user._id);
    await requisition.save();

    return res.status(200).json({
      success: true,
      message: `Submitted as ${requisition.ref}`,
      data: requisition,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to submit the requisition');
  }
};

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/** POST /api/procurement/requisitions/:id/quotes */
exports.addQuote = async (req, res) => {
  try {
    const { requisition, status, message } = await loadRequisition(req.params.id, req.user);
    if (!requisition) return fail(res, status, message);

    if (!['submitted', 'quoting'].includes(requisition.status)) {
      return fail(res, 409, `Quotations cannot be added to a ${requisition.status} requisition`);
    }

    requisition.quotes.push({
      vendorName: req.body.vendorName,
      vendorContact: req.body.vendorContact,
      amount: Math.max(0, Number(req.body.amount) || 0),
      receivedOn: req.body.receivedOn,
      validUntil: req.body.validUntil,
      note: req.body.note,
    });

    requisition.status = 'quoting';
    requisition.recordHistory('quotation recorded', req.user._id, req.body.vendorName);
    await requisition.save();

    return res.status(201).json({
      success: true,
      message: `${requisition.quotes.length} quotations on file`,
      data: requisition,
    });
  } catch (error) {
    const msg = validationMessage(error);
    if (msg) return fail(res, 400, msg);
    return serverError(res, error, 'Failed to record the quotation');
  }
};

/**
 * PATCH /api/procurement/requisitions/:id/quotes/:qid/select
 *
 * Selecting anything other than the lowest is allowed and has to say why. The
 * refusal names both amounts and the difference, because that is the sentence
 * somebody will be reading a year from now.
 */
exports.selectQuote = async (req, res) => {
  try {
    const { requisition, status, message } = await loadRequisition(req.params.id, req.user);
    if (!requisition) return fail(res, status, message);

    if (!['submitted', 'quoting'].includes(requisition.status)) {
      return fail(res, 409, `A ${requisition.status} requisition is past quotation`);
    }

    const quote = requisition.quotes.id(req.params.qid);
    if (!quote) return fail(res, 404, 'Quotation not found');

    const lowest = requisition.lowestQuote;
    const justification = (req.body.justification || '').trim();

    if (quote.amount > lowest.amount && justification.length < MIN_JUSTIFICATION_LENGTH) {
      return fail(
        res,
        400,
        `${quote.vendorName} at ${quote.amount} is ${quote.amount - lowest.amount} above ${lowest.vendorName} at ${lowest.amount}; say why in at least ${MIN_JUSTIFICATION_LENGTH} characters`
      );
    }

    requisition.quotes.forEach((entry) => {
      entry.isSelected = String(entry._id) === String(quote._id);
    });
    requisition.selectionJustification = justification;
    requisition.recordHistory('quotation selected', req.user._id, quote.vendorName);
    await requisition.save();

    return res.status(200).json({
      success: true,
      message: `${quote.vendorName} selected at ${quote.amount}`,
      data: requisition,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to select the quotation');
  }
};

// ---------------------------------------------------------------------------
// Approval and the money
// ---------------------------------------------------------------------------

/** PATCH /api/procurement/requisitions/:id/approve */
exports.approveRequisition = async (req, res) => {
  try {
    const { requisition, status, message } = await loadRequisition(req.params.id, req.user);
    if (!requisition) return fail(res, status, message);

    if (requisition.status === 'approved') {
      return res.status(200).json({ success: true, message: 'Already approved', data: requisition });
    }
    if (!['submitted', 'quoting'].includes(requisition.status)) {
      return fail(res, 409, `A ${requisition.status} requisition cannot be approved`);
    }

    // Holding the admin role is necessary and not sufficient.
    if (requisition.isOwnedBy(req.user)) {
      return fail(res, 403, 'A requisition cannot be approved by the person who raised it');
    }

    const blocker = requisition.approvalBlocker();
    if (blocker) return fail(res, 409, blocker);

    const amount = money(requisition.selectedQuote.amount);
    const { line, error } = await holdBudget(requisition.budgetLine, amount);
    if (error) return fail(res, 409, error);

    requisition.status = 'approved';
    requisition.approvedBy = req.user._id;
    requisition.approvedAt = new Date();
    requisition.decisionNote = req.body.note;
    requisition.encumbrance = { amount, state: 'held', heldAt: new Date() };
    requisition.recordHistory('approved', req.user._id, `committed ${amount}`);
    await requisition.save();

    return res.status(200).json({
      success: true,
      message: `Approved; ${amount} committed against ${line.code}, ${line.available} left`,
      data: { requisition, budgetLine: line },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to approve the requisition');
  }
};

/** PATCH /api/procurement/requisitions/:id/reject */
exports.rejectRequisition = async (req, res) => {
  try {
    const { requisition, status, message } = await loadRequisition(req.params.id, req.user);
    if (!requisition) return fail(res, status, message);

    if (['rejected', 'cancelled'].includes(requisition.status)) {
      return res.status(200).json({ success: true, message: 'Already closed', data: requisition });
    }

    const note = (req.body.note || '').trim();
    if (note.length < 8) return fail(res, 400, 'A rejection needs a reason on the record');

    const settlement = await settleEncumbrance(requisition);
    const fresh = await PurchaseRequisition.findById(requisition._id);
    fresh.status = 'rejected';
    fresh.decisionNote = note;
    fresh.recordHistory('rejected', req.user._id, note);
    await fresh.save();

    return res.status(200).json({
      success: true,
      message: settlement.settled
        ? `Rejected; ${settlement.released} released back to the budget`
        : 'Rejected',
      data: fresh,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to reject the requisition');
  }
};

/** PATCH /api/procurement/requisitions/:id/order */
exports.orderRequisition = async (req, res) => {
  try {
    const { requisition, status, message } = await loadRequisition(req.params.id, req.user);
    if (!requisition) return fail(res, status, message);

    if (requisition.poNumber) {
      return res.status(200).json({
        success: true,
        message: `Already ordered as ${requisition.poNumber}`,
        data: requisition,
      });
    }
    if (requisition.status !== 'approved') {
      return fail(res, 409, 'Only an approved requisition can be ordered');
    }

    const line = await BudgetLine.findById(requisition.budgetLine);
    const serial = await ProcurementCounter.next(`PO:${line.financialYear}`);
    requisition.poNumber = `PO/${line.financialYear}/${String(serial).padStart(3, '0')}`;
    requisition.status = 'ordered';
    requisition.orderedAt = new Date();
    requisition.recordHistory('ordered', req.user._id, requisition.poNumber);
    await requisition.save();

    return res.status(200).json({
      success: true,
      message: `Ordered as ${requisition.poNumber}`,
      data: requisition,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to place the order');
  }
};

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/** POST /api/procurement/requisitions/:id/receipts */
exports.recordReceipt = async (req, res) => {
  try {
    const { requisition, status, message } = await loadRequisition(req.params.id, req.user);
    if (!requisition) return fail(res, status, message);

    if (!['ordered', 'partially-received'].includes(requisition.status)) {
      return fail(res, 409, `Goods cannot be received against a ${requisition.status} requisition`);
    }

    const lines = (Array.isArray(req.body.lines) ? req.body.lines : [])
      .map((line) => ({
        itemIndex: Number(line.itemIndex),
        quantity: Math.max(0, Number(line.quantity) || 0),
      }))
      .filter((line) => line.quantity > 0 && Number.isInteger(line.itemIndex));

    if (!lines.length) return fail(res, 400, 'Record at least one line as received');

    const overReceipt = requisition.overReceiptError(lines);
    if (overReceipt) return fail(res, 409, overReceipt);

    requisition.receipts.push({
      receivedOn: req.body.receivedOn,
      receivedBy: req.user._id,
      lines,
      note: req.body.note,
    });

    const complete = requisition.isFullyReceived();
    requisition.status = complete ? 'received' : 'partially-received';
    requisition.recordHistory(
      complete ? 'fully received' : 'partially received',
      req.user._id,
      req.body.note
    );
    await requisition.save();

    return res.status(201).json({
      success: true,
      message: complete
        ? 'Everything ordered has been received'
        : 'Receipt recorded; some lines are still outstanding',
      data: { requisition, outstanding: requisition.outstandingByItem() },
    });
  } catch (error) {
    const msg = validationMessage(error);
    if (msg) return fail(res, 400, msg);
    return serverError(res, error, 'Failed to record the receipt');
  }
};

/**
 * PATCH /api/procurement/requisitions/:id/close
 *
 * Closing converts the hold into spending. An invoice lower than the quotation
 * spends the invoice and releases the difference, which is the case the
 * spreadsheet never handles: the school keeps holding money it did not spend.
 */
exports.closeRequisition = async (req, res) => {
  try {
    const { requisition, status, message } = await loadRequisition(req.params.id, req.user);
    if (!requisition) return fail(res, status, message);

    if (requisition.status === 'closed') {
      return res.status(200).json({ success: true, message: 'Already closed', data: requisition });
    }
    if (!['received', 'partially-received'].includes(requisition.status)) {
      return fail(res, 409, 'Only a received requisition can be closed');
    }

    const invoiced =
      req.body.invoicedAmount === undefined
        ? requisition.encumbrance.amount
        : money(Number(req.body.invoicedAmount) || 0);

    if (invoiced > requisition.encumbrance.amount) {
      return fail(
        res,
        409,
        `The invoice of ${invoiced} is above the ${requisition.encumbrance.amount} committed; raise a fresh requisition for the difference`
      );
    }

    const settlement = await settleEncumbrance(requisition, { spend: invoiced });
    const fresh = await PurchaseRequisition.findById(requisition._id);
    fresh.status = 'closed';
    fresh.closedAt = new Date();
    fresh.invoicedAmount = invoiced;
    fresh.recordHistory('closed', req.user._id, `spent ${invoiced}`);
    await fresh.save();

    return res.status(200).json({
      success: true,
      message: settlement.settled
        ? `Closed; ${settlement.spent} spent and ${settlement.released} released`
        : 'Closed',
      data: fresh,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to close the requisition');
  }
};

/** PATCH /api/procurement/requisitions/:id/cancel */
exports.cancelRequisition = async (req, res) => {
  try {
    const { requisition, status, message } = await loadRequisition(req.params.id, req.user);
    if (!requisition) return fail(res, status, message);

    if (!requisition.isOwnedBy(req.user) && !isAdmin(req.user)) {
      return fail(res, 403, 'That requisition was raised by somebody else');
    }
    if (['closed', 'cancelled'].includes(requisition.status)) {
      return res.status(200).json({ success: true, message: 'Already closed', data: requisition });
    }
    if (requisition.receipts.length) {
      return fail(res, 409, 'Goods have been received against this order; close it instead');
    }

    const settlement = await settleEncumbrance(requisition);
    const fresh = await PurchaseRequisition.findById(requisition._id);
    fresh.status = 'cancelled';
    fresh.decisionNote = req.body.note;
    fresh.recordHistory('cancelled', req.user._id, req.body.note);
    await fresh.save();

    return res.status(200).json({
      success: true,
      message: settlement.settled
        ? `Cancelled; ${settlement.released} released back to the budget`
        : 'Cancelled',
      data: fresh,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to cancel the requisition');
  }
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** GET /api/procurement/stats */
exports.getStats = async (req, res) => {
  try {
    const [byStatus, lines] = await Promise.all([
      PurchaseRequisition.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      BudgetLine.find({ isActive: true }).sort({ code: 1 }),
    ]);

    const awaitingApproval = await PurchaseRequisition.countDocuments({
      status: { $in: ['submitted', 'quoting'] },
    });

    return res.status(200).json({
      success: true,
      data: {
        byStatus: byStatus.reduce((acc, row) => ({ ...acc, [row._id]: row.count }), {}),
        awaitingApproval,
        budget: lines.map((line) => ({
          code: line.code,
          title: line.title,
          allocated: line.allocated,
          committed: line.committed,
          spent: line.spent,
          available: line.available,
          utilisation: line.utilisation,
        })),
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to load procurement statistics');
  }
};
