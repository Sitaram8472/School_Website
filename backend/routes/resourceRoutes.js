const express = require('express');
const router = express.Router();
const resourceController = require('../controllers/resourceController');

// Define the GET request path
router.get('/', resourceController.getResources);
// Define the POST request path (with multer upload)
router.post('/', resourceController.upload.single('file'), resourceController.createResource);

module.exports = router;
