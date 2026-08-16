const express = require('express');
const router = express.Router();
const resourceController = require('../controllers/resourceController');
const { optionalProtect } = require('../middleware/Auth');
const multiLevelCache = require('../middleware/cacheMiddleware');

router.get('/', optionalProtect, multiLevelCache(60), resourceController.getResources);

module.exports = router;
