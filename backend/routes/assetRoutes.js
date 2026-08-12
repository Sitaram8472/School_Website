const express = require('express');
const router = express.Router();
const assetController = require('../controllers/assetController');
const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

// Nothing here is public. The register says which rooms hold what equipment,
// what it is worth and when it is unattended, which is a shopping list.
router.use(protect);

// --- Fixed paths first, so none of them is ever read as an :id --------------
router.get('/meta', assetController.getMeta);
router.get('/mine', verifyRole('teacher', 'staff', 'admin'), assetController.getMyAssets);
router.get('/overdue', verifyRole('admin'), assetController.getOverdue);
router.get('/maintenance', verifyRole('admin'), assetController.getMaintenanceQueue);
router.get('/holders', verifyRole('admin'), assetController.getHolders);
router.get('/stats', verifyRole('admin'), assetController.getStats);

// --- The register ------------------------------------------------------------
router.post('/', verifyRole('admin'), assetController.createAsset);
router.get('/', verifyRole('admin'), assetController.listAssets);

// The detail route is deliberately not admin-only: the handler lets a member of
// staff read an asset they are currently holding and refuses everything else,
// which the role alone cannot express.
router.get('/:id', assetController.getAsset);
router.patch('/:id', verifyRole('admin'), assetController.updateAsset);

// --- Custody -----------------------------------------------------------------
// Issue and transfer are the pair the single-custody invariant rests on.
router.post('/:id/issue', verifyRole('admin'), assetController.issueAsset);
router.post('/:id/return', verifyRole('admin'), assetController.returnAsset);
router.post('/:id/transfer', verifyRole('admin'), assetController.transferAsset);

// --- Maintenance -------------------------------------------------------------
// Reporting is open to all staff on purpose. The person who finds the broken
// projector is usually not the person it is signed out to.
router.post(
  '/:id/maintenance',
  verifyRole('teacher', 'staff', 'admin'),
  assetController.reportFault
);
router.patch('/:id/maintenance/:mid', verifyRole('admin'), assetController.updateFault);

// --- Leaving the register ----------------------------------------------------
router.patch('/:id/retire', verifyRole('admin'), assetController.retireAsset);
router.patch('/:id/lost', verifyRole('admin'), assetController.markLost);

module.exports = router;
