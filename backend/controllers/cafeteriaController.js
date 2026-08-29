const mongoose = require('mongoose');
const MealPlan = require('../models/MealPlan');
const CanteenAccount = require('../models/CanteenAccount');
const User = require('../models/User');

/**
 * Cafeteria: meal plans and prepaid canteen accounts.
 *
 * Two functions in this file are worth reading closely — `chargeAccount` and
 * `topUpAccount`. Both move money, and both do it with a single conditional
 * update rather than a read followed by a write. Everything else is CRUD.
 */

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

/**
 * Surface every failed validation path, not just the first — otherwise a user
 * fixes their form one field per submission.
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
  return null;
}

/**
 * Validate a detached array subdocument without letting it throw.
 *
 * A subdocument built with `.create()` has no parent to record failures
 * against, so Mongoose throws the `ValidatorError` out of `validateSync()`
 * instead of returning a `ValidationError`. Uncaught, that turns "description
 * is required" into a 500.
 */
function validateSubdocument(doc) {
  try {
    return doc.validateSync() || null;
  } catch (error) {
    return error;
  }
}

function isStaff(user) {
  return user.role === 'admin' || user.role === 'staff';
}

/**
 * A positive integer amount in the smallest currency unit the school uses.
 * Fractional currency at a school canteen is a data-entry error, not a price.
 */
function parseAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount);
}

// ---------------------------------------------------------------------------
// Meal plans
// ---------------------------------------------------------------------------

/**
 * GET /api/cafeteria/plans
 *
 * Students see published plans only; staff see drafts and retired plans too,
 * because they are the ones who have to find a draft in order to publish it.
 */
exports.getMealPlans = async (req, res) => {
  try {
    const { status, mealType, vegetarian } = req.query;

    const filter = {};
    if (isStaff(req.user)) {
      if (status) filter.status = status;
    } else {
      filter.status = 'active';
    }
    if (mealType) filter.mealTypes = mealType;
    if (vegetarian === 'true') filter.vegetarian = true;

    const plans = await MealPlan.find(filter).sort({ validFrom: -1, name: 1 }).limit(200);

    return res.status(200).json({
      success: true,
      count: plans.length,
      data: plans.map((plan) => ({
        ...plan.toObject(),
        unavailableReason: plan.subscriptionError(),
      })),
      vocabulary: {
        allergens: MealPlan.ALLERGENS,
        mealTypes: MealPlan.MEAL_TYPES,
        servingDays: MealPlan.SERVING_DAYS,
        cycles: MealPlan.PLAN_CYCLES,
      },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch meal plans');
  }
};

/**
 * POST /api/cafeteria/plans
 */
exports.createMealPlan = async (req, res) => {
  try {
    const {
      name,
      description,
      mealTypes,
      servingDays,
      allergens,
      vegetarian,
      calories,
      price,
      currency,
      cycle,
      validFrom,
      validTo,
      capacity,
      status,
    } = req.body;

    const plan = await MealPlan.create({
      name,
      description,
      mealTypes,
      servingDays,
      allergens,
      vegetarian,
      calories,
      price,
      currency,
      cycle,
      validFrom,
      validTo,
      capacity,
      // A plan starts as a draft unless it is explicitly published. Publishing
      // by accident puts food on sale that the kitchen has not agreed to cook.
      status: status === 'active' ? 'active' : 'draft',
      createdBy: req.user._id,
      // `subscriberCount` is server-owned; a client-supplied value is dropped.
    });

    return res.status(201).json({
      success: true,
      message: `Meal plan "${plan.name}" created.`,
      data: plan,
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    if (error.code === 11000) {
      return fail(res, 409, 'A plan with that name already starts on that date.');
    }
    return serverError(res, error, 'Failed to create the meal plan');
  }
};

/**
 * PUT /api/cafeteria/plans/:id
 *
 * Price and allergens are editable only while nobody has subscribed. Changing
 * the allergen list under existing subscribers silently re-labels food people
 * are already eating, which is the one edit this module must not allow.
 */
exports.updateMealPlan = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid plan id.');

    const plan = await MealPlan.findById(req.params.id);
    if (!plan) return fail(res, 404, 'Meal plan not found.');

    const locked = plan.subscriberCount > 0;
    const { name, description, allergens, price, capacity, status, servingDays, validTo } = req.body;

    if (locked && (allergens !== undefined || price !== undefined)) {
      return fail(
        res,
        409,
        `This plan has ${plan.subscriberCount} subscriber(s); its price and allergen list can no longer be changed. Retire it and publish a replacement.`
      );
    }

    if (name !== undefined) plan.name = name;
    if (description !== undefined) plan.description = description;
    if (servingDays !== undefined) plan.servingDays = servingDays;
    if (validTo !== undefined) plan.validTo = validTo;
    if (!locked && allergens !== undefined) plan.allergens = allergens;
    if (!locked && price !== undefined) plan.price = price;

    if (capacity !== undefined) {
      if (capacity !== 0 && capacity < plan.subscriberCount) {
        return fail(
          res,
          409,
          `There are already ${plan.subscriberCount} subscribers; capacity cannot be reduced below that.`
        );
      }
      plan.capacity = capacity;
    }

    if (status !== undefined) {
      if (!MealPlan.PLAN_STATUSES.includes(status)) {
        return fail(res, 400, `Status must be one of: ${MealPlan.PLAN_STATUSES.join(', ')}`);
      }
      plan.status = status;
    }

    await plan.save();

    return res.status(200).json({
      success: true,
      message: 'Meal plan updated.',
      data: plan,
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update the meal plan');
  }
};

/**
 * DELETE /api/cafeteria/plans/:id
 *
 * Only plans nobody ever subscribed to. A plan with subscribers is retired
 * instead, so the ledger entries that reference it keep resolving to something.
 */
exports.deleteMealPlan = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid plan id.');

    const plan = await MealPlan.findById(req.params.id);
    if (!plan) return fail(res, 404, 'Meal plan not found.');

    if (plan.subscriberCount > 0) {
      return fail(
        res,
        409,
        'This plan has subscribers. Set its status to "retired" instead of deleting it.'
      );
    }

    await plan.deleteOne();

    return res.status(200).json({ success: true, message: 'Meal plan deleted.' });
  } catch (error) {
    return serverError(res, error, 'Failed to delete the meal plan');
  }
};

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/**
 * Fetch a student's account, creating an empty one on first access.
 *
 * Lazy creation keeps the module free of a migration that has to walk the whole
 * user table, and an account with a zero balance is indistinguishable from no
 * account at all as far as the counter is concerned.
 */
async function ensureAccount(student) {
  const existing = await CanteenAccount.findOne({ student: student._id });
  if (existing) return existing;

  try {
    return await CanteenAccount.create({
      student: student._id,
      studentName: student.name || '',
      className: student.className || '',
    });
  } catch (error) {
    // Two first-time requests raced; the unique index on `student` rejected the
    // loser. The winner's document is the answer either way.
    if (error.code === 11000) {
      return CanteenAccount.findOne({ student: student._id });
    }
    throw error;
  }
}

/**
 * GET /api/cafeteria/account/me
 */
exports.getMyAccount = async (req, res) => {
  try {
    const account = await ensureAccount(req.user);

    return res.status(200).json({
      success: true,
      data: account.summaryFor(),
      vocabulary: { allergens: MealPlan.ALLERGENS },
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch your canteen account');
  }
};

/**
 * GET /api/cafeteria/accounts
 * The counter's search. Ledgers are stripped — the list view does not need
 * three years of transactions per student to render a row.
 */
exports.getAccounts = async (req, res) => {
  try {
    const { search, className, status, lowOnly } = req.query;

    const filter = {};
    if (className) filter.className = className;
    if (status) filter.status = status;
    if (search) filter.studentName = { $regex: String(search).trim(), $options: 'i' };

    let accounts = await CanteenAccount.find(filter)
      .select('-ledger')
      .sort({ studentName: 1 })
      .limit(300);

    if (lowOnly === 'true') {
      accounts = accounts.filter((account) => account.balance <= account.lowBalanceThreshold);
    }

    return res.status(200).json({
      success: true,
      count: accounts.length,
      data: accounts,
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch canteen accounts');
  }
};

/**
 * GET /api/cafeteria/accounts/:id
 * Ownership is checked here rather than in the router so a student can open
 * their own account through the same URL staff use for anyone's.
 */
exports.getAccount = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid account id.');

    const account = await CanteenAccount.findById(req.params.id);
    if (!account) return fail(res, 404, 'Canteen account not found.');

    if (!isStaff(req.user) && String(account.student) !== String(req.user._id)) {
      return fail(res, 403, 'You can only view your own canteen account.');
    }

    return res.status(200).json({
      success: true,
      data: account.summaryFor(200),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to fetch the canteen account');
  }
};

/**
 * Build a ledger entry, validate it, and return either the error or the plain
 * object ready to be pushed by an update pipeline.
 *
 * The `_id` is generated here rather than left to Mongoose because an update
 * pipeline pushes a raw document — there is no schema casting step to fill it
 * in, and a ledger entry with no id cannot be referenced by a later refund.
 */
function buildLedgerEntry(account, fields) {
  const entry = account.ledger.create({
    _id: new mongoose.Types.ObjectId(),
    // A placeholder: the real value is computed by the pipeline stage below,
    // which is the only place that knows the post-update balance.
    balanceAfter: 0,
    ...fields,
  });

  const invalid = validateSubdocument(entry);
  if (invalid) return { error: invalid, entry: null };

  return { error: null, entry: entry.toObject() };
}

/**
 * The update pipeline that moves the balance and appends the entry.
 *
 * Pipeline stages run in order, so by the time the second `$set` builds the
 * ledger entry, `$balance` already holds the post-movement value. That is what
 * makes `balanceAfter` correct under concurrency — computing it from a balance
 * read before the update would record whatever the account held a moment ago,
 * which is precisely the number an audit cannot rely on.
 */
function balanceMovementPipeline(entry, delta, counterField) {
  return [
    {
      $set: {
        balance: { $add: ['$balance', delta] },
        [counterField]: { $add: [`$${counterField}`, Math.abs(delta)] },
      },
    },
    {
      $set: {
        ledger: {
          $concatArrays: ['$ledger', [{ ...entry, balanceAfter: '$balance' }]],
        },
      },
    },
  ];
}

/**
 * POST /api/cafeteria/accounts/:id/topup
 */
exports.topUpAccount = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid account id.');

    const { amount, method, reference, idempotencyKey, note } = req.body;

    const value = parseAmount(amount);
    if (value === null) return fail(res, 400, 'Top-up amount must be a positive number.');
    if (!CanteenAccount.TOPUP_METHODS.includes(method)) {
      return fail(res, 400, `Method must be one of: ${CanteenAccount.TOPUP_METHODS.join(', ')}`);
    }

    const account = await CanteenAccount.findById(req.params.id);
    if (!account) return fail(res, 404, 'Canteen account not found.');
    if (account.status === 'closed') return fail(res, 409, 'This account is closed.');

    const replay = account.findEntryByKey(idempotencyKey);
    if (replay) {
      return res.status(200).json({
        success: true,
        message: 'This top-up was already recorded.',
        idempotentReplay: true,
        data: account.summaryFor(),
        entry: replay,
      });
    }

    const { error: invalid, entry } = buildLedgerEntry(account, {
      type: 'topup',
      amount: value,
      description: note || `Top-up by ${method}`,
      method,
      reference: reference || '',
      idempotencyKey: idempotencyKey || null,
      recordedBy: req.user._id,
      recordedByName: req.user.name || '',
      occurredAt: new Date(),
    });
    if (invalid) return fail(res, 400, validationMessage(invalid) || 'That top-up is not valid.');

    const updated = await CanteenAccount.findOneAndUpdate(
      {
        _id: account._id,
        status: { $ne: 'closed' },
        // Guards the replay window between the read above and this write.
        ...(idempotencyKey ? { 'ledger.idempotencyKey': { $ne: idempotencyKey } } : {}),
      },
      balanceMovementPipeline(entry, value, 'lifetimeTopUp'),
      { new: true }
    );

    if (!updated) {
      const current = await CanteenAccount.findById(account._id);
      const duplicate = current && current.findEntryByKey(idempotencyKey);
      if (duplicate) {
        return res.status(200).json({
          success: true,
          message: 'This top-up was already recorded.',
          idempotentReplay: true,
          data: current.summaryFor(),
          entry: duplicate,
        });
      }
      return fail(res, 409, 'The account changed while the top-up was being recorded.');
    }

    return res.status(201).json({
      success: true,
      message: `Topped up ${value}. New balance is ${updated.balance}.`,
      data: updated.summaryFor(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record the top-up');
  }
};

/**
 * POST /api/cafeteria/accounts/:id/charge
 *
 * The one that matters. Three separate protections, in the order they apply:
 *
 *  1. **Allergen conflict** — refused outright, naming the allergen. A student
 *     with a declared nut allergy cannot be sold a nut dish, and this is a
 *     block rather than a warning because a warning is the paper register with
 *     extra steps.
 *
 *  2. **Idempotency** — a replayed key returns the original entry instead of
 *     charging twice. Checked before the write and again in the filter, because
 *     the gap between those two is exactly where a double-tap lands.
 *
 *  3. **Sufficient funds, atomically** — the balance test lives in the filter
 *     of the conditional update (`$expr: { $gte: ['$balance', value] }`), not
 *     in a branch above it. Two tills serving the same student at the same
 *     moment would both pass a read-then-write check and both commit, and the
 *     account would go negative. Here the loser matches no document and gets a
 *     clean 409.
 */
exports.chargeAccount = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid account id.');

    const { amount, mealPlanId, description, idempotencyKey, reference } = req.body;

    const value = parseAmount(amount);
    if (value === null) return fail(res, 400, 'Charge amount must be a positive number.');

    const account = await CanteenAccount.findById(req.params.id);
    if (!account) return fail(res, 404, 'Canteen account not found.');

    // 1. Allergen safety.
    let plan = null;
    if (mealPlanId) {
      if (!isValidId(mealPlanId)) return fail(res, 400, 'Invalid meal plan id.');

      plan = await MealPlan.findById(mealPlanId);
      if (!plan) return fail(res, 404, 'Meal plan not found.');

      const conflicts = plan.allergenConflicts(account.dietaryFlags);
      if (conflicts.length > 0) {
        return fail(
          res,
          409,
          `Refused: "${plan.name}" contains ${conflicts.join(', ')}, which ${
            account.studentName || 'this student'
          } is flagged for.`,
          { allergenConflicts: conflicts }
        );
      }
    }

    // 2. Idempotency.
    const replay = account.findEntryByKey(idempotencyKey);
    if (replay) {
      return res.status(200).json({
        success: true,
        message: 'This charge was already recorded.',
        idempotentReplay: true,
        data: account.summaryFor(),
        entry: replay,
      });
    }

    // Read up front so the counter gets the real reason rather than a bare
    // "could not charge" from the atomic guard. The guard below is still the
    // authority — this is the error message, not the check.
    const blocked = account.chargeError(value);
    if (blocked) return fail(res, 409, blocked, { balance: account.balance });

    // The daily cap spans the ledger's own history, so unlike the balance test
    // it cannot be folded into the filter. Two simultaneous charges could
    // therefore both pass it and take the student a little over the cap. That is
    // a soft budgeting control rather than an invariant, and the balance — which
    // is an invariant — is still enforced atomically below.
    const remaining = account.remainingToday();
    if (remaining !== null && value > remaining) {
      return fail(
        res,
        409,
        `That would exceed today's spend limit. ${remaining} of ${account.dailySpendLimit} is left today.`,
        { remainingToday: remaining }
      );
    }

    const { error: invalid, entry } = buildLedgerEntry(account, {
      type: 'charge',
      amount: value,
      description: description || (plan ? `Canteen: ${plan.name}` : 'Canteen purchase'),
      mealPlan: plan ? plan._id : null,
      mealPlanName: plan ? plan.name : '',
      idempotencyKey: idempotencyKey || null,
      reference: reference || '',
      recordedBy: req.user._id,
      recordedByName: req.user.name || '',
      occurredAt: new Date(),
    });
    if (invalid) return fail(res, 400, validationMessage(invalid) || 'That charge is not valid.');

    // 3. The atomic debit.
    const updated = await CanteenAccount.findOneAndUpdate(
      {
        _id: account._id,
        status: 'active',
        $expr: { $gte: ['$balance', value] },
        ...(idempotencyKey ? { 'ledger.idempotencyKey': { $ne: idempotencyKey } } : {}),
      },
      balanceMovementPipeline(entry, -value, 'lifetimeSpend'),
      { new: true }
    );

    if (!updated) {
      const current = await CanteenAccount.findById(account._id);
      if (!current) return fail(res, 404, 'Canteen account not found.');

      const duplicate = current.findEntryByKey(idempotencyKey);
      if (duplicate) {
        return res.status(200).json({
          success: true,
          message: 'This charge was already recorded.',
          idempotentReplay: true,
          data: current.summaryFor(),
          entry: duplicate,
        });
      }

      return fail(
        res,
        409,
        current.chargeError(value) || 'The balance changed while the charge was being recorded.',
        { balance: current.balance }
      );
    }

    return res.status(201).json({
      success: true,
      message: `Charged ${value}. Balance is now ${updated.balance}.`,
      data: updated.summaryFor(),
      lowBalance: updated.balance <= updated.lowBalanceThreshold,
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record the charge');
  }
};

/**
 * POST /api/cafeteria/accounts/:id/refund
 *
 * Refunds reference the charge they undo and cannot exceed it. An unbounded
 * refund endpoint is a way to move money out of the ledger with no trace of
 * where it came from.
 */
exports.refundCharge = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid account id.');

    const { entryId, amount, reason, idempotencyKey } = req.body;

    if (!isValidId(entryId)) return fail(res, 400, 'A valid entryId of the original charge is required.');
    if (!reason || !String(reason).trim()) {
      return fail(res, 400, 'A reason is required so the ledger explains itself.');
    }

    const account = await CanteenAccount.findById(req.params.id);
    if (!account) return fail(res, 404, 'Canteen account not found.');

    const original = account.ledger.id(entryId);
    if (!original) return fail(res, 404, 'That ledger entry does not exist on this account.');
    if (original.type !== 'charge') return fail(res, 409, 'Only a charge can be refunded.');

    const alreadyRefunded = account.ledger
      .filter((item) => item.type === 'refund' && String(item.relatedEntry) === String(entryId))
      .reduce((total, item) => total + item.amount, 0);

    const refundable = original.amount - alreadyRefunded;
    if (refundable <= 0) return fail(res, 409, 'That charge has already been refunded in full.');

    const value = amount === undefined ? refundable : parseAmount(amount);
    if (value === null) return fail(res, 400, 'Refund amount must be a positive number.');
    if (value > refundable) {
      return fail(res, 409, `Only ${refundable} of that charge is still refundable.`);
    }

    const replay = account.findEntryByKey(idempotencyKey);
    if (replay) {
      return res.status(200).json({
        success: true,
        message: 'This refund was already recorded.',
        idempotentReplay: true,
        data: account.summaryFor(),
        entry: replay,
      });
    }

    const { error: invalid, entry } = buildLedgerEntry(account, {
      type: 'refund',
      amount: value,
      description: `Refund: ${String(reason).trim()}`,
      mealPlan: original.mealPlan,
      mealPlanName: original.mealPlanName,
      relatedEntry: original._id,
      idempotencyKey: idempotencyKey || null,
      recordedBy: req.user._id,
      recordedByName: req.user.name || '',
      occurredAt: new Date(),
    });
    if (invalid) return fail(res, 400, validationMessage(invalid) || 'That refund is not valid.');

    // `lifetimeSpend` is decremented rather than a separate counter kept: the
    // student did not spend money that came back to them.
    const updated = await CanteenAccount.findOneAndUpdate(
      {
        _id: account._id,
        status: { $ne: 'closed' },
        ...(idempotencyKey ? { 'ledger.idempotencyKey': { $ne: idempotencyKey } } : {}),
      },
      [
        {
          $set: {
            balance: { $add: ['$balance', value] },
            lifetimeSpend: { $max: [0, { $subtract: ['$lifetimeSpend', value] }] },
          },
        },
        {
          $set: {
            ledger: { $concatArrays: ['$ledger', [{ ...entry, balanceAfter: '$balance' }]] },
          },
        },
      ],
      { new: true }
    );

    if (!updated) return fail(res, 409, 'The account changed while the refund was being recorded.');

    return res.status(201).json({
      success: true,
      message: `Refunded ${value}. Balance is now ${updated.balance}.`,
      data: updated.summaryFor(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to record the refund');
  }
};

/**
 * PATCH /api/cafeteria/accounts/:id/dietary
 *
 * A student may declare their own allergens; staff may set them for anyone.
 * Nobody should need a support ticket to record a food allergy.
 */
exports.updateDietary = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid account id.');

    const account = await CanteenAccount.findById(req.params.id);
    if (!account) return fail(res, 404, 'Canteen account not found.');

    if (!isStaff(req.user) && String(account.student) !== String(req.user._id)) {
      return fail(res, 403, 'You can only change your own dietary flags.');
    }

    const { dietaryFlags, dietaryNotes, dailySpendLimit, lowBalanceThreshold } = req.body;

    if (dietaryFlags !== undefined) {
      if (!Array.isArray(dietaryFlags)) return fail(res, 400, 'dietaryFlags must be an array.');

      const unknown = dietaryFlags.filter((flag) => !MealPlan.ALLERGENS.includes(flag));
      if (unknown.length > 0) {
        return fail(
          res,
          400,
          `Unrecognised allergen(s): ${unknown.join(', ')}. Allowed: ${MealPlan.ALLERGENS.join(', ')}`
        );
      }
      account.dietaryFlags = dietaryFlags;
    }

    if (dietaryNotes !== undefined) account.dietaryNotes = dietaryNotes;

    // Spend caps are a parent/office control, not something a student sets for
    // themselves.
    if (dailySpendLimit !== undefined) {
      if (!isStaff(req.user)) return fail(res, 403, 'Only the office can change the spend limit.');
      account.dailySpendLimit = dailySpendLimit;
    }
    if (lowBalanceThreshold !== undefined) account.lowBalanceThreshold = lowBalanceThreshold;

    await account.save();

    return res.status(200).json({
      success: true,
      message: 'Account preferences updated.',
      data: account.summaryFor(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to update the account');
  }
};

/**
 * POST /api/cafeteria/accounts/:id/subscribe
 *
 * Subscribing charges the plan price against the balance and reserves a seat on
 * the plan. The seat reservation is its own atomic guard on the plan's
 * `subscriberCount`, taken *before* the money moves: a failed reservation that
 * has already debited the account would have to be refunded, and the version of
 * this that forgets to do so overcharges families.
 */
exports.subscribe = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 400, 'Invalid account id.');

    const { mealPlanId, idempotencyKey } = req.body;
    if (!isValidId(mealPlanId)) return fail(res, 400, 'A valid mealPlanId is required.');

    const account = await CanteenAccount.findById(req.params.id);
    if (!account) return fail(res, 404, 'Canteen account not found.');

    const plan = await MealPlan.findById(mealPlanId);
    if (!plan) return fail(res, 404, 'Meal plan not found.');

    const unavailable = plan.subscriptionError();
    if (unavailable) return fail(res, 409, unavailable);

    if (account.activeSubscriptionFor(plan._id)) {
      return fail(res, 409, 'This student is already subscribed to that plan.');
    }

    const conflicts = plan.allergenConflicts(account.dietaryFlags);
    if (conflicts.length > 0) {
      return fail(res, 409, `Refused: "${plan.name}" contains ${conflicts.join(', ')}.`, {
        allergenConflicts: conflicts,
      });
    }

    const price = Math.round(plan.price);
    if (account.balance < price) {
      return fail(
        res,
        409,
        `Insufficient balance. The plan costs ${price} and the account holds ${account.balance}.`
      );
    }

    // Reserve the seat first.
    const reserved = await MealPlan.findOneAndUpdate(
      {
        _id: plan._id,
        status: 'active',
        $or: [{ capacity: 0 }, { $expr: { $lt: ['$subscriberCount', '$capacity'] } }],
      },
      { $inc: { subscriberCount: 1 } },
      { new: true }
    );

    if (!reserved) return fail(res, 409, 'That plan filled up while you were subscribing.');

    const { error: invalid, entry } = buildLedgerEntry(account, {
      type: 'charge',
      amount: price,
      description: `Subscription: ${plan.name}`,
      mealPlan: plan._id,
      mealPlanName: plan.name,
      idempotencyKey: idempotencyKey || null,
      recordedBy: req.user._id,
      recordedByName: req.user.name || '',
      occurredAt: new Date(),
    });

    if (invalid) {
      await MealPlan.updateOne({ _id: plan._id }, { $inc: { subscriberCount: -1 } });
      return fail(res, 400, validationMessage(invalid) || 'That subscription is not valid.');
    }

    const subscription = {
      _id: new mongoose.Types.ObjectId(),
      mealPlan: plan._id,
      planName: plan.name,
      startsOn: new Date(),
      endsOn: plan.validTo,
      pricePaid: price,
      status: 'active',
      subscribedAt: new Date(),
    };

    const updated = await CanteenAccount.findOneAndUpdate(
      {
        _id: account._id,
        status: 'active',
        $expr: { $gte: ['$balance', price] },
      },
      [
        {
          $set: {
            balance: { $subtract: ['$balance', price] },
            lifetimeSpend: { $add: ['$lifetimeSpend', price] },
          },
        },
        {
          $set: {
            ledger: { $concatArrays: ['$ledger', [{ ...entry, balanceAfter: '$balance' }]] },
            subscriptions: { $concatArrays: ['$subscriptions', [subscription]] },
          },
        },
      ],
      { new: true }
    );

    if (!updated) {
      // The debit failed, so the seat we reserved is not being used. Release it
      // rather than leaving the plan permanently one seat smaller.
      await MealPlan.updateOne({ _id: plan._id }, { $inc: { subscriberCount: -1 } });
      const current = await CanteenAccount.findById(account._id);
      return fail(
        res,
        409,
        current ? current.chargeError(price) || 'The balance changed while subscribing.' : 'Account not found.'
      );
    }

    return res.status(201).json({
      success: true,
      message: `Subscribed to ${plan.name}. Balance is now ${updated.balance}.`,
      data: updated.summaryFor(),
    });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return fail(res, 400, message);
    return serverError(res, error, 'Failed to subscribe to the meal plan');
  }
};

/**
 * POST /api/cafeteria/accounts
 * Opens an account for a named student. Only needed when the office wants to
 * top an account up before the student has ever signed in.
 */
exports.openAccount = async (req, res) => {
  try {
    const { studentId } = req.body;
    if (!isValidId(studentId)) return fail(res, 400, 'A valid studentId is required.');

    const student = await User.findById(studentId).select('name role className');
    if (!student) return fail(res, 404, 'Student not found.');
    if (student.role !== 'student') return fail(res, 400, 'Canteen accounts are for students.');

    const account = await ensureAccount(student);

    return res.status(201).json({
      success: true,
      message: `Canteen account ready for ${student.name}.`,
      data: account.summaryFor(),
    });
  } catch (error) {
    return serverError(res, error, 'Failed to open the canteen account');
  }
};

/**
 * GET /api/cafeteria/summary
 */
exports.getSummary = async (req, res) => {
  try {
    const [accounts, plans] = await Promise.all([
      CanteenAccount.find({}).select('balance lifetimeTopUp lifetimeSpend status dietaryFlags lowBalanceThreshold'),
      MealPlan.find({}).select('status subscriberCount capacity price'),
    ]);

    const summary = {
      accounts: accounts.length,
      activeAccounts: 0,
      suspendedAccounts: 0,
      floatHeld: 0,
      lifetimeTopUp: 0,
      lifetimeSpend: 0,
      lowBalanceAccounts: 0,
      accountsWithAllergens: 0,
      plans: plans.length,
      activePlans: 0,
      totalSubscriptions: 0,
    };

    accounts.forEach((account) => {
      if (account.status === 'active') summary.activeAccounts += 1;
      if (account.status === 'suspended') summary.suspendedAccounts += 1;
      summary.floatHeld += account.balance;
      summary.lifetimeTopUp += account.lifetimeTopUp;
      summary.lifetimeSpend += account.lifetimeSpend;
      if (account.balance <= account.lowBalanceThreshold) summary.lowBalanceAccounts += 1;
      if (account.dietaryFlags.length > 0) summary.accountsWithAllergens += 1;
    });

    plans.forEach((plan) => {
      if (plan.status === 'active') summary.activePlans += 1;
      summary.totalSubscriptions += plan.subscriberCount;
    });

    // The money the school is holding on behalf of families. Worth surfacing —
    // it is a liability, not revenue, and the two get confused.
    summary.averageBalance =
      summary.accounts > 0 ? Math.round(summary.floatHeld / summary.accounts) : 0;

    return res.status(200).json({ success: true, summary });
  } catch (error) {
    return serverError(res, error, 'Failed to compute the cafeteria summary');
  }
};
