const mongoose = require('mongoose');
const Asset = require('../models/Asset');
const User = require('../models/User');

/**
 * Physical asset register.
 *
 * Three handlers carry the feature.
 *
 * `issueAsset` refuses when an open custody row already exists. That refusal is
 * the module: without it this is a notebook with better fonts, and a notebook
 * is how one projector ends up out to two people.
 *
 * `transferAsset` never does close-then-open as two requests. It calls
 * `transferTo`, which mutates both rows on one document, and saves once — so a
 * failure halfway leaves the asset with its old holder rather than with
 * nobody.
 *
 * `getStats` reports book value from `netBookValue()` rather than from a stored
 * column, which is why the figure is right in March as well as in August.
 */

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

function ok(res, data, extra = {}) {
  return res.status(200).json({ success: true, data, ...extra });
}

function serverError(res, error, message) {
  console.error(`${message}:`, error);
  return res.status(500).json({
    success: false,
    message,
    error: error.message,
  });
}

/**
 * Mongoose validation errors carry every failed path. Surfacing only the first
 * is how you get somebody fixing a form one field per submission.
 */
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
    return 'An asset with that tag already exists';
  }
  return null;
}

function isAdmin(user) {
  return user && user.role === 'admin';
}

function isStaff(user) {
  return user && (user.role === 'teacher' || user.role === 'staff' || user.role === 'admin');
}

function parseDate(value, fieldLabel) {
  if (value === undefined || value === null || value === '') return { value: undefined };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { error: `${fieldLabel} is not a valid date` };
  }
  return { value: date };
}

// The fields an admin may set directly. Everything else on the document is
// either derived or written only through a lifecycle handler, so an unfiltered
// spread of req.body would be the whole security model gone.
const EDITABLE_FIELDS = [
  'name',
  'category',
  'description',
  'serialNumber',
  'manufacturer',
  'model',
  'purchaseCost',
  'usefulLifeYears',
  'salvageValue',
  'fundingSource',
  'homeLocation',
  'condition',
];

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/**
 * GET /api/assets/meta
 */
exports.getMeta = async (req, res) => {
  try {
    return ok(res, {
      categories: Asset.CATEGORIES,
      conditions: Asset.CONDITIONS,
      statuses: Asset.STATUSES,
      faultSeverities: Asset.FAULT_SEVERITIES,
      faultStatuses: Asset.FAULT_STATUSES,
      disposalMethods: Asset.DISPOSAL_METHODS,
      defaultLifeYears: Asset.DEFAULT_LIFE_YEARS,
    });
  } catch (error) {
    return serverError(res, error, 'Could not load asset reference data');
  }
};

// ---------------------------------------------------------------------------
// Creating and editing
// ---------------------------------------------------------------------------

/**
 * POST /api/assets
 */
exports.createAsset = async (req, res) => {
  try {
    const {
      assetTag,
      name,
      category,
      description,
      serialNumber,
      manufacturer,
      model,
      purchaseDate,
      purchaseCost,
      usefulLifeYears,
      salvageValue,
      fundingSource,
      warrantyExpiresOn,
      condition,
      homeLocation,
    } = req.body;

    const purchased = parseDate(purchaseDate, 'Purchase date');
    if (purchased.error) return fail(res, 400, purchased.error);
    if (!purchased.value) return fail(res, 400, 'A purchase date is required');

    const warranty = parseDate(warrantyExpiresOn, 'Warranty expiry');
    if (warranty.error) return fail(res, 400, warranty.error);

    if (warranty.value && warranty.value.getTime() < purchased.value.getTime()) {
      return fail(res, 400, 'A warranty cannot expire before the asset was bought');
    }

    const asset = new Asset({
      assetTag,
      name,
      category,
      description,
      serialNumber,
      manufacturer,
      model,
      purchaseDate: purchased.value,
      purchaseCost,
      usefulLifeYears,
      salvageValue,
      fundingSource,
      warrantyExpiresOn: warranty.value,
      condition,
      homeLocation,
      status: 'in-store',
    });

    asset.recordHistory({
      action: 'registered',
      to: 'in-store',
      by: req.user._id,
      note: `Registered at ${asset.homeLocation || 'no stated location'}`,
    });

    await asset.save();

    return res.status(201).json({
      success: true,
      message: 'Asset registered',
      data: asset.toDetail(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not register the asset');
  }
};

/**
 * PATCH /api/assets/:id
 *
 * Identity fields — the tag, the purchase date — are not editable here. A tag
 * that can be retyped is not an identifier, and a purchase date that can be
 * moved is a book value that can be dialled to any figure you like.
 */
exports.updateAsset = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid asset id');

    const asset = await Asset.findById(id);
    if (!asset) return fail(res, 404, 'Asset not found');

    if (asset.isClosed()) {
      return fail(res, 409, `This asset is ${asset.status.replace(/-/g, ' ')} and can no longer be edited`);
    }

    const changed = [];
    for (const field of EDITABLE_FIELDS) {
      if (req.body[field] === undefined) continue;
      if (String(asset[field] ?? '') === String(req.body[field] ?? '')) continue;
      asset[field] = req.body[field];
      changed.push(field);
    }

    if (req.body.warrantyExpiresOn !== undefined) {
      const warranty = parseDate(req.body.warrantyExpiresOn, 'Warranty expiry');
      if (warranty.error) return fail(res, 400, warranty.error);
      asset.warrantyExpiresOn = warranty.value;
      changed.push('warrantyExpiresOn');
    }

    if (!changed.length) return fail(res, 400, 'Nothing to update');

    asset.recordHistory({
      action: 'updated',
      by: req.user._id,
      note: `Changed ${changed.join(', ')}`,
    });

    await asset.save();
    return ok(res, asset.toDetail(), { message: 'Asset updated' });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not update the asset');
  }
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * GET /api/assets
 */
exports.listAssets = async (req, res) => {
  try {
    const { category, status, condition, location, search, overdue, hasOpenFault } = req.query;
    const query = {};

    if (category && Asset.CATEGORIES.includes(category)) query.category = category;
    if (condition && Asset.CONDITIONS.includes(condition)) query.condition = condition;

    if (status === 'active') {
      query.status = { $in: Asset.ACTIVE_STATUSES };
    } else if (status && Asset.STATUSES.includes(status)) {
      query.status = status;
    }

    if (location) {
      query.homeLocation = { $regex: String(location).slice(0, 60), $options: 'i' };
    }

    if (search) {
      const term = String(search).slice(0, 60);
      query.$or = [
        { assetTag: { $regex: term, $options: 'i' } },
        { name: { $regex: term, $options: 'i' } },
        { serialNumber: { $regex: term, $options: 'i' } },
      ];
    }

    const assets = await Asset.find(query).sort({ updatedAt: -1 }).limit(400);
    const now = new Date();
    let rows = assets.map((asset) => asset.toRow(now));

    // Both of these are derived, so they filter after the query rather than in
    // it. That is the cost of not storing them, and it is the right trade at
    // this size — a stored `isOverdue` is wrong every midnight.
    if (String(overdue) === 'true') rows = rows.filter((row) => row.daysOverdue > 0);
    if (String(hasOpenFault) === 'true') rows = rows.filter((row) => row.openFaultCount > 0);

    return ok(res, rows, { count: rows.length });
  } catch (error) {
    return serverError(res, error, 'Could not load the asset register');
  }
};

/**
 * GET /api/assets/mine
 *
 * What the signed-in member of staff is holding right now. The query matches
 * the open row rather than any row, so returned items drop off it.
 */
exports.getMyAssets = async (req, res) => {
  try {
    const assets = await Asset.find({
      custody: {
        $elemMatch: {
          holder: req.user._id,
          returnedAt: { $exists: false },
        },
      },
    }).sort({ updatedAt: -1 });

    const now = new Date();
    const rows = assets
      .filter((asset) => asset.isHeldBy(req.user))
      .map((asset) => asset.toRow(now))
      .sort((a, b) => b.daysOverdue - a.daysOverdue);

    return ok(res, rows, {
      count: rows.length,
      overdueCount: rows.filter((row) => row.daysOverdue > 0).length,
    });
  } catch (error) {
    return serverError(res, error, 'Could not load your equipment');
  }
};

/**
 * GET /api/assets/overdue
 */
exports.getOverdue = async (req, res) => {
  try {
    const assets = await Asset.find({
      custody: {
        $elemMatch: {
          returnedAt: { $exists: false },
          dueBack: { $lt: new Date() },
        },
      },
    }).limit(300);

    const now = new Date();
    const rows = assets
      .map((asset) => asset.toRow(now))
      .filter((row) => row.daysOverdue > 0)
      .sort((a, b) => b.daysOverdue - a.daysOverdue);

    return ok(res, rows, { count: rows.length });
  } catch (error) {
    return serverError(res, error, 'Could not load overdue equipment');
  }
};

/**
 * GET /api/assets/maintenance
 *
 * Open faults, worst first, each carrying the repair count for that asset —
 * which is the number that says whether this is a repair or a retirement.
 */
exports.getMaintenanceQueue = async (req, res) => {
  try {
    const assets = await Asset.find({
      'maintenance.status': { $in: ['reported', 'triaged', 'with-vendor'] },
    }).limit(300);

    const severityRank = { critical: 0, major: 1, moderate: 2, minor: 3 };
    const rows = [];

    for (const asset of assets) {
      for (const fault of asset.openFaults()) {
        rows.push({
          assetId: asset._id,
          assetTag: asset.assetTag,
          assetName: asset.name,
          category: asset.category,
          repairCount: asset.repairCount(),
          totalRepairCost: asset.totalRepairCost(),
          netBookValue: asset.netBookValue(),
          faultId: fault._id,
          fault: fault.fault,
          severity: fault.severity,
          status: fault.status,
          vendor: fault.vendor,
          cost: fault.cost,
          reportedAt: fault.reportedAt,
          reportedBy: fault.reportedBy,
        });
      }
    }

    rows.sort((a, b) => {
      const bySeverity = (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9);
      if (bySeverity !== 0) return bySeverity;
      return new Date(a.reportedAt).getTime() - new Date(b.reportedAt).getTime();
    });

    return ok(res, rows, { count: rows.length });
  } catch (error) {
    return serverError(res, error, 'Could not load the maintenance queue');
  }
};

/**
 * GET /api/assets/:id
 *
 * An admin sees any asset. Anybody else sees only one they are currently
 * holding — the custody chain names other members of staff and where the
 * equipment sleeps, which is not a browsing surface.
 */
exports.getAsset = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return fail(res, 400, 'Invalid asset id');

    const asset = await Asset.findById(id)
      .populate('custody.holder', 'name email role')
      .populate('maintenance.reportedBy', 'name role');

    if (!asset) return fail(res, 404, 'Asset not found');

    if (!isAdmin(req.user) && !asset.isHeldBy(req.user)) {
      return fail(res, 403, 'You can only view equipment you are currently holding');
    }

    return ok(res, asset.toDetail());
  } catch (error) {
    return serverError(res, error, 'Could not load the asset');
  }
};

// ---------------------------------------------------------------------------
// Custody
// ---------------------------------------------------------------------------

/**
 * POST /api/assets/:id/issue
 *
 * The refusal this module exists for lives in `issueBlockedReason`, and it is
 * a 409 with the current holder's name rather than a generic failure — the
 * person at the desk needs to know who to go and ask.
 */
exports.issueAsset = async (req, res) => {
  try {
    const { id } = req.params;
    const { holderId, location, purpose, dueBack, conditionOut, note } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid asset id');
    if (!isValidId(holderId)) return fail(res, 400, 'Invalid holder id');

    const asset = await Asset.findById(id);
    if (!asset) return fail(res, 404, 'Asset not found');

    const blocked = asset.issueBlockedReason();
    if (blocked) return fail(res, 409, blocked);

    const holder = await User.findById(holderId).select('name role');
    if (!holder) return fail(res, 404, 'That person does not have an account');
    if (holder.role === 'student') {
      return fail(res, 400, 'Equipment is issued to staff, who remain responsible for it');
    }

    const due = parseDate(dueBack, 'Due-back date');
    if (due.error) return fail(res, 400, due.error);
    if (due.value && due.value.getTime() < Date.now()) {
      return fail(res, 400, 'The due-back date is already in the past');
    }

    asset.issueTo({
      holder: holder._id,
      holderName: holder.name,
      location,
      purpose,
      issuedBy: req.user._id,
      dueBack: due.value,
      conditionOut,
      note,
    });

    asset.recordHistory({
      action: 'issued',
      from: 'in-store',
      to: holder.name,
      by: req.user._id,
      note: purpose,
    });

    await asset.save();
    return ok(res, asset.toDetail(), { message: `Issued to ${holder.name}` });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not issue the asset');
  }
};

/**
 * POST /api/assets/:id/return
 */
exports.returnAsset = async (req, res) => {
  try {
    const { id } = req.params;
    const { conditionIn, note } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid asset id');

    const asset = await Asset.findById(id);
    if (!asset) return fail(res, 404, 'Asset not found');

    const open = asset.openCustody();
    if (!open) return fail(res, 409, 'This asset is not currently out');

    if (conditionIn && !Asset.CONDITIONS.includes(conditionIn)) {
      return fail(res, 400, 'Invalid condition');
    }

    const conditionBefore = open.conditionOut || asset.condition;
    asset.returnFrom({ returnedTo: req.user._id, conditionIn, note });

    asset.recordHistory({
      action: 'returned',
      from: open.holderName || 'holder',
      to: 'in-store',
      by: req.user._id,
      note:
        conditionIn && conditionIn !== conditionBefore
          ? `Condition ${conditionBefore} on issue, ${conditionIn} on return`
          : note,
    });

    await asset.save();
    return ok(res, asset.toDetail(), { message: 'Returned to store' });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not return the asset');
  }
};

/**
 * POST /api/assets/:id/transfer
 *
 * One request, one save, both rows. See `Asset.transferTo`.
 */
exports.transferAsset = async (req, res) => {
  try {
    const { id } = req.params;
    const { holderId, location, purpose, dueBack, conditionIn, note } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid asset id');
    if (!isValidId(holderId)) return fail(res, 400, 'Invalid holder id');

    const asset = await Asset.findById(id);
    if (!asset) return fail(res, 404, 'Asset not found');

    const open = asset.openCustody();
    if (!open) {
      return fail(res, 409, 'This asset is in store. Issue it rather than transferring it.');
    }

    const holder = await User.findById(holderId).select('name role');
    if (!holder) return fail(res, 404, 'That person does not have an account');
    if (holder.role === 'student') {
      return fail(res, 400, 'Equipment is issued to staff, who remain responsible for it');
    }

    const due = parseDate(dueBack, 'Due-back date');
    if (due.error) return fail(res, 400, due.error);

    const previousHolder = open.holderName;

    asset.transferTo({
      holder: holder._id,
      holderName: holder.name,
      location,
      purpose,
      transferredBy: req.user._id,
      dueBack: due.value,
      conditionIn,
      note,
    });

    asset.recordHistory({
      action: 'transferred',
      from: previousHolder || 'holder',
      to: holder.name,
      by: req.user._id,
      note,
    });

    await asset.save();
    return ok(res, asset.toDetail(), {
      message: `Transferred from ${previousHolder || 'the previous holder'} to ${holder.name}`,
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not transfer the asset');
  }
};

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/**
 * POST /api/assets/:id/maintenance
 *
 * Any member of staff may report a fault on anything, whether or not they hold
 * it — the alternative is the broken projector staying quietly in the cupboard
 * because the person who found it was not the person it was signed out to.
 */
exports.reportFault = async (req, res) => {
  try {
    const { id } = req.params;
    const { fault, severity } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid asset id');

    const asset = await Asset.findById(id);
    if (!asset) return fail(res, 404, 'Asset not found');

    if (asset.isClosed()) {
      return fail(res, 409, `This asset is ${asset.status.replace(/-/g, ' ')}`);
    }

    if (severity && !Asset.FAULT_SEVERITIES.includes(severity)) {
      return fail(res, 400, 'Invalid severity');
    }

    const open = asset.openCustody();

    asset.maintenance.push({
      reportedBy: req.user._id,
      reportedAt: new Date(),
      custodyRef: open ? open._id : undefined,
      fault,
      severity: severity || 'moderate',
      status: 'reported',
    });

    // A critical fault takes the asset out of circulation immediately. Anything
    // less is a note against a thing that still works.
    if (severity === 'critical') {
      if (open) {
        asset.returnFrom({ returnedTo: req.user._id, note: 'Withdrawn: critical fault' });
      }
      asset.status = 'in-maintenance';
      asset.condition = 'unserviceable';
    }

    asset.recordHistory({
      action: 'fault-reported',
      to: severity || 'moderate',
      by: req.user._id,
      note: String(fault || '').slice(0, 200),
    });

    await asset.save();

    return res.status(201).json({
      success: true,
      message:
        severity === 'critical'
          ? 'Fault recorded. The asset has been withdrawn from use.'
          : 'Fault recorded',
      data: asset.toDetail(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not record the fault');
  }
};

/**
 * PATCH /api/assets/:id/maintenance/:mid
 */
exports.updateFault = async (req, res) => {
  try {
    const { id, mid } = req.params;
    const { status, vendor, cost, resolution, severity } = req.body;

    if (!isValidId(id) || !isValidId(mid)) return fail(res, 400, 'Invalid id');

    const asset = await Asset.findById(id);
    if (!asset) return fail(res, 404, 'Asset not found');

    const fault = asset.maintenance.id(mid);
    if (!fault) return fail(res, 404, 'Fault not found on this asset');

    if (fault.status === 'resolved' || fault.status === 'unrepairable') {
      return fail(res, 409, 'This fault is already closed');
    }

    if (status && !Asset.FAULT_STATUSES.includes(status)) {
      return fail(res, 400, 'Invalid maintenance status');
    }
    if (severity && !Asset.FAULT_SEVERITIES.includes(severity)) {
      return fail(res, 400, 'Invalid severity');
    }

    if ((status === 'resolved' || status === 'unrepairable') && !resolution) {
      return fail(res, 400, 'Say what was done before closing the fault');
    }

    const previous = fault.status;
    if (severity) fault.severity = severity;
    if (vendor !== undefined) fault.vendor = vendor;
    if (cost !== undefined) {
      const parsed = Number(cost);
      if (!Number.isFinite(parsed) || parsed < 0) return fail(res, 400, 'Invalid repair cost');
      fault.cost = parsed;
    }
    if (resolution !== undefined) fault.resolution = resolution;

    if (status) {
      fault.status = status;
      if (status === 'resolved') {
        fault.resolvedAt = new Date();
        // Only back into store if this was the last open fault. Two faults, one
        // fixed, is still an asset that should not go out.
        if (!asset.openFaults().length && asset.status === 'in-maintenance') {
          asset.status = 'in-store';
          if (asset.condition === 'unserviceable') asset.condition = 'fair';
        }
      }
      if (status === 'unrepairable') {
        fault.resolvedAt = new Date();
        asset.condition = 'unserviceable';
        asset.status = 'in-maintenance';
      }
      if (status === 'with-vendor' || status === 'triaged') {
        asset.status = 'in-maintenance';
      }
    }

    asset.recordHistory({
      action: 'fault-updated',
      from: previous,
      to: fault.status,
      by: req.user._id,
      note: resolution ? String(resolution).slice(0, 200) : undefined,
    });

    await asset.save();
    return ok(res, asset.toDetail(), { message: 'Fault updated' });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not update the fault');
  }
};

// ---------------------------------------------------------------------------
// Leaving the register
// ---------------------------------------------------------------------------

/**
 * PATCH /api/assets/:id/retire
 *
 * An asset that is out cannot be retired. It has to come back, or be declared
 * lost — otherwise the register quietly forgets an item that is sitting in
 * somebody's classroom.
 */
exports.retireAsset = async (req, res) => {
  try {
    const { id } = req.params;
    const { method, proceeds, reason, date } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid asset id');

    const asset = await Asset.findById(id);
    if (!asset) return fail(res, 404, 'Asset not found');

    if (asset.isClosed()) {
      return fail(res, 409, `This asset is already ${asset.status.replace(/-/g, ' ')}`);
    }
    if (asset.isOut()) {
      const open = asset.openCustody();
      return fail(
        res,
        409,
        `This asset is out to ${open.holderName || 'a member of staff'}. Return it, or record it as lost, before retiring it.`
      );
    }

    if (!method || !Asset.DISPOSAL_METHODS.includes(method)) {
      return fail(res, 400, 'A disposal method is required');
    }
    if (!reason || String(reason).trim().length < 5) {
      return fail(res, 400, 'Say why the asset is being retired');
    }

    const disposedOn = parseDate(date, 'Disposal date');
    if (disposedOn.error) return fail(res, 400, disposedOn.error);

    const proceedsValue = proceeds === undefined || proceeds === '' ? 0 : Number(proceeds);
    if (!Number.isFinite(proceedsValue) || proceedsValue < 0) {
      return fail(res, 400, 'Invalid disposal proceeds');
    }

    const bookValue = asset.netBookValue();

    asset.disposal = {
      method,
      date: disposedOn.value || new Date(),
      proceeds: proceedsValue,
      // The authoriser is read off the session, never off the body. An
      // authorisation you can name somebody else in is not one.
      authorisedBy: req.user._id,
      reason,
    };
    asset.status = method === 'scrapped' ? 'written-off' : 'retired';

    asset.recordHistory({
      action: 'retired',
      from: 'in-store',
      to: asset.status,
      by: req.user._id,
      note: `${method}, book value ${bookValue}, proceeds ${proceedsValue}`,
    });

    await asset.save();
    return ok(res, asset.toDetail(), {
      message: `Asset ${asset.status.replace(/-/g, ' ')}`,
      bookValueAtDisposal: bookValue,
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not retire the asset');
  }
};

/**
 * PATCH /api/assets/:id/lost
 *
 * Closes the open custody row rather than abandoning it, so the chain still
 * ends with a name and a date. That name is the entire value of the record
 * once something has actually gone missing.
 */
exports.markLost = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!isValidId(id)) return fail(res, 400, 'Invalid asset id');
    if (!reason || String(reason).trim().length < 5) {
      return fail(res, 400, 'Say what is known about the loss');
    }

    const asset = await Asset.findById(id);
    if (!asset) return fail(res, 404, 'Asset not found');
    if (asset.isClosed()) {
      return fail(res, 409, `This asset is already ${asset.status.replace(/-/g, ' ')}`);
    }

    const open = asset.openCustody();
    const lastHolder = open ? open.holderName : null;

    if (open) {
      open.returnedAt = new Date();
      open.returnedTo = req.user._id;
      open.note = open.note ? `${open.note} | Reported lost` : 'Reported lost';
    }

    asset.status = 'lost';

    asset.recordHistory({
      action: 'lost',
      from: lastHolder || 'in-store',
      to: 'lost',
      by: req.user._id,
      note: reason,
    });

    await asset.save();
    return ok(res, asset.toDetail(), {
      message: lastHolder
        ? `Recorded as lost. Last held by ${lastHolder}.`
        : 'Recorded as lost.',
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Could not record the loss');
  }
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * GET /api/assets/stats
 *
 * Count and value by category. Value comes from `netBookValue()` per asset,
 * which is why this figure is right in March as well as in August and why it
 * cannot be dragged out of a spreadsheet column.
 */
exports.getStats = async (req, res) => {
  try {
    const assets = await Asset.find({}).select(
      'category status condition purchaseDate purchaseCost usefulLifeYears salvageValue custody maintenance'
    );

    const now = new Date();
    const byCategory = {};
    const byStatus = {};
    let totalCost = 0;
    let totalBookValue = 0;
    let outCount = 0;
    let overdueCount = 0;
    let openFaultCount = 0;

    for (const asset of assets) {
      const bookValue = asset.netBookValue(now);
      const cost = Number(asset.purchaseCost) || 0;

      if (!byCategory[asset.category]) {
        byCategory[asset.category] = { category: asset.category, count: 0, cost: 0, bookValue: 0 };
      }
      byCategory[asset.category].count += 1;
      byCategory[asset.category].cost += cost;
      byCategory[asset.category].bookValue += bookValue;

      byStatus[asset.status] = (byStatus[asset.status] || 0) + 1;

      totalCost += cost;
      totalBookValue += bookValue;

      if (asset.isOut()) outCount += 1;
      if (asset.daysOverdue(now) > 0) overdueCount += 1;
      openFaultCount += asset.openFaults().length;
    }

    const categories = Object.values(byCategory)
      .map((row) => ({
        ...row,
        cost: Math.round(row.cost * 100) / 100,
        bookValue: Math.round(row.bookValue * 100) / 100,
        depreciated: Math.round((row.cost - row.bookValue) * 100) / 100,
      }))
      .sort((a, b) => b.bookValue - a.bookValue);

    return ok(res, {
      total: assets.length,
      out: outCount,
      overdue: overdueCount,
      openFaults: openFaultCount,
      totalCost: Math.round(totalCost * 100) / 100,
      totalBookValue: Math.round(totalBookValue * 100) / 100,
      totalDepreciated: Math.round((totalCost - totalBookValue) * 100) / 100,
      byStatus,
      categories,
    });
  } catch (error) {
    return serverError(res, error, 'Could not compute asset statistics');
  }
};

/**
 * GET /api/assets/holders
 *
 * The people equipment may be issued to. Students are excluded because
 * responsibility for a £900 laptop is not something a fifteen-year-old can
 * hold, which is a policy decision the endpoint makes rather than the form.
 */
exports.getHolders = async (req, res) => {
  try {
    const holders = await User.find({ role: { $in: ['teacher', 'staff', 'admin'] } })
      .select('name email role')
      .sort({ name: 1 })
      .limit(500);

    return ok(res, holders);
  } catch (error) {
    return serverError(res, error, 'Could not load the staff list');
  }
};

exports.isStaff = isStaff;
