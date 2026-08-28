const express = require('express');
const router = express.Router();
const { submitContact } = require('../controllers/contactController');

router.post('/', submitContact);

// Requests for a printed prospectus. A `Contact` document has no field for a
// postal address and no state, so the printed-copy request is a sibling
// resource rather than another subject line on the general form. Required
// inline to keep this to a single line; the sub-router attaches `protect`
// itself, since a blanket guard here would take the public form down.
router.use('/prospectus', require('./prospectusRoutes'));

module.exports = router;
