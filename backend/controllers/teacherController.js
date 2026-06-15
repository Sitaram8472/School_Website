const Notice = require('../models/Notice');
const Resource = require('../models/Resource');
const Attendance = require('../models/Attendance');
const path = require('path');
const fs = require('fs');

// ---- NOTICES ----

const getMyNotices = async (req, res) => {
  try {
    const notices = await Notice.find({ postedBy: req.user._id }).sort({ createdAt: -1 });
    res.json({ notices });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.', error: err.message });
  }
};

const postNotice = async (req, res) => {
  try {
    const { title, content, targetClass } = req.body;

    if (!title || !content) {
      return res.status(400).json({
        success: false,
        message: 'Title and content are required.'
      });
    }

    const notice = await Notice.create({
      title,
      category: 'Teacher',
      content,
      targetClass: targetClass || 'All',
      postedBy: req.user._id,
      teacherName: req.user.name,
    });

    res.status(201).json({ success: true, message: 'Notice posted successfully!', notice });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.', error: err.message });
  }
};

const deleteNotice = async (req, res) => {
  try {
    const notice = await Notice.findById(req.params.id);
    if (!notice) return res.status(404).json({ success: false, message: 'Notice not found.' });

    if (notice.postedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized to delete this notice.' });
    }

    await notice.deleteOne();
    res.json({ success: true, message: 'Notice deleted successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.', error: err.message });
  }
};

// ---- RESOURCES ----

const getMyResources = async (req, res) => {
  try {
    const resources = await Resource.find({ uploadedBy: req.user._id }).sort({ createdAt: -1 });
    res.json({ resources });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.', error: err.message });
  }
};

const uploadResource = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Please upload a file.' });
    }
    const { title, subject, targetClass } = req.body;
    if (!title || !subject) {
      return res.status(400).json({ success: false, message: 'Title and subject are required.' });
    }

    const resource = await Resource.create({
      title,
      subject,
      targetClass: targetClass || 'All Classes',
      fileUrl: `/uploads/${req.file.filename}`,
      fileName: req.file.originalname,
      fileType: path.extname(req.file.originalname).slice(1),
      uploadedBy: req.user._id,
      teacherName: req.user.name,
    });

    res.status(201).json({ success: true, message: 'Resource uploaded successfully!', resource });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.', error: err.message });
  }
};

const deleteResource = async (req, res) => {
  try {
    const resource = await Resource.findById(req.params.id);
    if (!resource) return res.status(404).json({ success: false, message: 'Resource not found.' });

    if (resource.uploadedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    const filePath = path.join(__dirname, '..', resource.fileUrl);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await resource.deleteOne();
    res.json({ success: true, message: 'Resource deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.', error: err.message });
  }
};

// ---- ATTENDANCE ----

const getMyAttendance = async (req, res) => {
  try {
    const records = await Attendance.find({ markedBy: req.user._id }).sort({ createdAt: -1 });
    res.json({ records });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.', error: err.message });
  }
};

const markAttendance = async (req, res) => {
  try {
    const { className, date, records } = req.body;
    if (!className || !date || !records || records.length === 0) {
      return res.status(400).json({ success: false, message: 'className, date, and records are required.' });
    }

    const attendance = await Attendance.create({
      className,
      date,
      records,
      markedBy: req.user._id,
      teacherName: req.user.name,
    });

    res.status(201).json({ success: true, message: 'Attendance marked successfully!', attendance });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.', error: err.message });
  }
};

// ---- STATS ----

const getDashboardStats = async (req, res) => {
  try {
    const [noticeCount, resourceCount, attendanceCount] = await Promise.all([
      Notice.countDocuments({ postedBy: req.user._id }),
      Resource.countDocuments({ uploadedBy: req.user._id }),
      Attendance.countDocuments({ markedBy: req.user._id }),
    ]);

    res.json({
      success: true,
      stats: {
        noticesPosted: noticeCount,
        resourcesUploaded: resourceCount,
        attendanceRecords: attendanceCount,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.', error: err.message });
  }
};

module.exports = {
  getMyNotices, postNotice, deleteNotice,
  getMyResources, uploadResource, deleteResource,
  getMyAttendance, markAttendance,
  getDashboardStats,
};
