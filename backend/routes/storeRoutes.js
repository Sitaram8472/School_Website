const express = require('express');
const router = express.Router();
const storeController = require('../controllers/storeController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// The catalogue carries prices and stock for a specific school's families, and
// ordering needs an account to attach the order to, so nothing here is public.
router.use(protect);

// --- Fixed paths first, so none of them is ever read as an :id --------------
router.get('/my-orders', storeController.getMyOrders);
router.get('/low-stock', verifyRole('admin'), storeController.getLowStock);
router.get('/stats', verifyRole('admin'), storeController.getStats);

// --- Catalogue --------------------------------------------------------------
router.get('/items', storeController.listItems);
router.get('/items/:id', storeController.getItem);
router.post('/items', verifyRole('admin'), storeController.createItem);
router.patch('/items/:id', verifyRole('admin'), storeController.updateItem);
router.post('/items/:id/variants', verifyRole('admin'), storeController.addVariant);

// Stock only ever moves through here, or through a collection. Both write a
// movement record.
router.patch(
  '/items/:id/variants/:variantSku/stock',
  verifyRole('admin'),
  storeController.adjustStock
);

// --- Orders -----------------------------------------------------------------
router.post('/orders', storeController.placeOrder);
router.get('/orders', verifyRole('admin'), storeController.listOrders);

// The sweep is declared before `/orders/:id` so "expire" is never treated as an
// order id.
router.post('/orders/expire', verifyRole('admin'), storeController.expireStaleOrders);

router.get('/orders/:id', storeController.getOrder);
router.patch('/orders/:id/cancel', storeController.cancelOrder);

// --- The counter (admin) ----------------------------------------------------
router.patch('/orders/:id/ready', verifyRole('admin'), storeController.markReady);
router.patch('/orders/:id/collect', verifyRole('admin'), storeController.collectOrder);

module.exports = router;
