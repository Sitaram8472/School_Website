const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');
const assignmentController = require('../controllers/assignmentController');

// Same disk-storage strategy as teacherRoutes.js so uploads land in the single
// `/uploads` folder that is already served statically by server.js.
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

const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.txt', '.jpg', '.jpeg', '.png', '.ppt', '.pptx', '.zip'];

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) return cb(null, true);
    return cb(new Error(`File type not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`));
  },
});

// Every assignment endpoint requires a logged-in user.
router.use(protect);

// ---- Student-facing ----
router.get('/', assignmentController.getAssignmentsForStudent);
router.get('/my-submissions', assignmentController.getMySubmissions);
router.post('/:id/submit', upload.array('files', 5), assignmentController.submitAssignment);

// ---- Teacher-facing ----
router.get('/mine', verifyRole('teacher', 'admin'), assignmentController.getMyAssignments);

router.post(
  '/',
  verifyRole('teacher', 'admin'),
  upload.array('files', 5),
  assignmentController.createAssignment
);

router.put(
  '/:id',
  verifyRole('teacher', 'admin'),
  upload.array('files', 5),
  assignmentController.updateAssignment
);

router.patch('/:id/status', verifyRole('teacher', 'admin'), assignmentController.changeStatus);
router.delete('/:id', verifyRole('teacher', 'admin'), assignmentController.deleteAssignment);

router.get('/:id/stats', verifyRole('teacher', 'admin'), assignmentController.getAssignmentStats);
router.get(
  '/:id/submissions',
  verifyRole('teacher', 'admin'),
  assignmentController.getSubmissionsForAssignment
);

router.patch(
  '/submissions/:submissionId/grade',
  verifyRole('teacher', 'admin'),
  assignmentController.gradeSubmission
);

// Multer rejects oversized or disallowed files by throwing, which would
// otherwise surface as an opaque 500.
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
