const express = require('express');
const router = express.Router();
const noticeController = require('../controllers/noticeController');

/**
 * @swagger
 * tags:
 *   name: Notices
 *   description: Notice board management
 */

/**
 * @swagger
 * /api/notices:
 *   get:
 *     summary: Get all notices
 *     tags: [Notices]
 *     responses:
 *       200:
 *         description: List of notices retrieved successfully
 *       500:
 *         description: Server error
 */
router.get('/', noticeController.getNotices);

/**
 * @swagger
 * /api/notices:
 *   post:
 *     summary: Create a new notice
 *     tags: [Notices]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       201:
 *         description: Notice created successfully
 *       400:
 *         description: Invalid request
 *       500:
 *         description: Server error
 */
router.post('/', noticeController.createNotice);

module.exports = router;