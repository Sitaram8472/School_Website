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

router.use(protect, verifyRole('teacher', 'admin'));

router.get('/stats', getDashboardStats);

router.get('/notices', getMyNotices);
router.post('/notices', postNotice);
router.delete('/notices/:id', deleteNotice);

router.get('/resources', getMyResources);
router.post('/resources', upload.single('file'), uploadResource);
router.delete('/resources/:id', deleteResource);

router.get('/attendance', getMyAttendance);
router.post('/attendance', markAttendance);

// --- Credential register -----------------------------------------------------
// `router.use(protect, verifyRole('teacher', 'admin'))` above already fixes the
// audience, so nothing here is reachable by a student. The multer `upload`
// configured at the top of this file takes the scanned certificate, so no new
// upload plumbing is introduced.
//
// The controller is a separate file rather than an addition to
// teacherController.js, which has open changes against it.
const credentials = require('../controllers/teacherCredentialController');

// Static segments first, so none of them is ever read as a credential id.
router.get('/credentials/meta', credentials.getCredentialMeta);
router.get('/credentials/mine', credentials.getMyCredentials);
router.get('/credentials/expiring', verifyRole('admin'), credentials.getExpiring);
router.get('/credentials/endorsed', credentials.getEndorsedStaff);
router.get('/credentials/point-in-time', verifyRole('admin'), credentials.getPointInTime);

// The register itself carries rejection reasons across staff, so it is admin
// only; a teacher reads their own record through /credentials/mine.
router.get('/credentials', verifyRole('admin'), credentials.listCredentials);

router.post('/credentials', upload.single('document'), credentials.createCredential);

// A renewal writes a new document and supersedes the old one. It is not a PATCH
// of the old one, because overwriting the dates is the thing that makes an
// inspection unanswerable.
router.post('/credentials/:id/renew', upload.single('document'), credentials.renewCredential);

// Verification is admin only, and the model refuses it a second time if the
// verifier is the person the credential belongs to.
router.patch('/credentials/:id/verify', verifyRole('admin'), credentials.verifyCredential);
router.patch('/credentials/:id/reject', verifyRole('admin'), credentials.rejectCredential);

// Withdrawal is for something submitted in error, so the owner may do it.
router.patch('/credentials/:id/withdraw', credentials.withdrawCredential);

module.exports = router;
