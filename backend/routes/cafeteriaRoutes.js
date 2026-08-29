const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');
const cafeteriaController = require('../controllers/cafeteriaController');

// Everything under /api/cafeteria needs a session.
router.use(protect);

// The counter and the office. Teachers are deliberately not included — a
// teacher has no reason to move money on a student's account.
const counter = verifyRole('admin', 'staff');

// ---- Meal plans ----
router.get('/plans', cafeteriaController.getMealPlans);
router.post('/plans', counter, cafeteriaController.createMealPlan);
router.put('/plans/:id', counter, cafeteriaController.updateMealPlan);
router.delete('/plans/:id', counter, cafeteriaController.deleteMealPlan);

// ---- Accounts ----
// Declared before "/accounts/:id" so the literal path is never swallowed by the
// parameterised one.
router.get('/account/me', cafeteriaController.getMyAccount);

router.get('/accounts', counter, cafeteriaController.getAccounts);
router.post('/accounts', counter, cafeteriaController.openAccount);

// Ownership is checked inside the controller so a student can open their own
// account while staff can open anyone's.
router.get('/accounts/:id', cafeteriaController.getAccount);
router.patch('/accounts/:id/dietary', cafeteriaController.updateDietary);

// ---- Money movement ----
router.post('/accounts/:id/topup', counter, cafeteriaController.topUpAccount);
router.post('/accounts/:id/charge', counter, cafeteriaController.chargeAccount);
router.post('/accounts/:id/refund', counter, cafeteriaController.refundCharge);
router.post('/accounts/:id/subscribe', counter, cafeteriaController.subscribe);

// ---- Reporting ----
router.get('/summary', counter, cafeteriaController.getSummary);

module.exports = router;
