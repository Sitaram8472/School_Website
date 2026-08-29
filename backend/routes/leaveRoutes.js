const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');
const leaveController = require('../controllers/leaveController');

// Supporting documents (a doctor's note, an event invitation) land in the same
// `/uploads` folder that server.js already serves statically.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});

const ALLOWED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx'];

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 3 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) return cb(null, true);
    return cb(new Error(`File type not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`));
  },
});

router.use(protect);

const reviewer = verifyRole('teacher', 'admin', 'staff');

// ---- Student-facing ----
// "/me", "/calendar" and "/summary/..." are declared before "/:id" so those
// literal paths are never captured as an id.
router.get('/me', leaveController.getMyLeaveRequests);
router.post('/', upload.array('files', 3), leaveController.createLeaveRequest);
router.patch('/:id/withdraw', leaveController.withdrawLeaveRequest);

// ---- Reviewer-facing ----
router.get('/calendar', reviewer, leaveController.getLeaveCalendar);
router.get('/summary/student/:studentId', reviewer, leaveController.getStudentLeaveSummary);

router.get('/', reviewer, leaveController.getLeaveRequests);
router.patch('/:id/decision', reviewer, leaveController.decideLeaveRequest);
router.patch('/:id/cancel', verifyRole('admin'), leaveController.cancelLeaveRequest);

// Ownership is checked inside the controller: a student sees their own request,
// a reviewer sees any.
router.get('/:id', leaveController.getLeaveRequest);

// Turn multer's throws into a readable 400 instead of an opaque 500.
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ success: false, message: `Upload failed: ${err.message}` });
  }
  if (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
  return next();
});

module.exports = router;
