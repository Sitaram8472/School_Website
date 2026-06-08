const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { protect } = require('../middleware/Auth');
const verifyRole = require('../middleware/verifyRole');

const {
  getMyNotices, postNotice, deleteNotice,
  getMyResources, uploadResource, deleteResource,
  getMyAttendance, markAttendance,
  getDashboardStats,
} = require('../controllers/teacherController');

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

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.ppt', '.pptx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('File type not allowed.'));
  },
});

router.use(protect, verifyRole('teacher'));

router.get('/stats', getDashboardStats);

router.get('/notices', getMyNotices);
router.post('/notices', postNotice);
router.delete('/notices/:id', deleteNotice);

router.get('/resources', getMyResources);
router.post('/resources', upload.single('file'), uploadResource);
router.delete('/resources/:id', deleteResource);

router.get('/attendance', getMyAttendance);
router.post('/attendance', markAttendance);

module.exports = router;
