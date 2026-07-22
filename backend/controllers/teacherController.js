// backend/controllers/teacherController.js
const Notice = require('../models/Notice');
const Resource = require('../models/Resource');
const Attendance = require('../models/Attendance');
const path = require('path');
const fs = require('fs');

// Reusable error handler
const handleError = (res, err, message = 'Server error') => {
  console.error(err);
  return res.status(500).json({ success: false, message, error: err.message });
};

// Get pagination params
const getPagination = (req) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

// Get search filter
const getSearchFilter = (req, fields) => {
  const search = req.query.search;
  if (!search) return {};
  return {
    $or: fields.map(field => ({
      [field]: { $regex: search, $options: 'i' }
    }))
  };
};

// ---- NOTICES ----

const getMyNotices = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const searchFilter = getSearchFilter(req, ['title', 'content']);

    const filter = {
      postedBy: req.user._id,
      deletedAt: null,
      ...searchFilter
    };

    const [notices, total] = await Promise.all([
      Notice.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Notice.countDocuments(filter)
    ]);

    res.json({
      success: true,
      notices,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (err) {
    handleError(res, err);
  }
};

const postNotice = async (req, res) => {
  try {
    const { title, content, targetClass, status, publishAt, expiresAt } = req.body;

    if (!title || !title.trim() || !content) {
      return res.status(400).json({
        success: false,
        message: 'Title and content are required.'
      });
    }

    if (targetClass && !['All', 'Class 10', 'Class 12'].includes(targetClass)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid target class'
      });
    }

    const now = new Date();

    if (publishAt) {
      const pubDate = new Date(publishAt);
      if (pubDate < now) {
        return res.status(400).json({
          success: false,
          message: 'Publication date cannot be in the past.'
        });
      }
    }

    if (expiresAt) {
      const expDate = new Date(expiresAt);
      const compareDate = publishAt ? new Date(publishAt) : now;
      if (expDate < compareDate) {
        return res.status(400).json({
          success: false,
          message: 'Expiration must be after publication.'
        });
      }
    }

    let noticeStatus = 'published';
    let finalPublishedAt = null;

    if (status === 'draft') {
      noticeStatus = 'draft';
    } else if (publishAt && new Date(publishAt) > now) {
      noticeStatus = 'scheduled';
    } else {
      noticeStatus = 'published';
      finalPublishedAt = now;
    }

    const notice = await Notice.create({
      title,
      category: 'Teacher',
      content,
      targetClass: targetClass || 'All',
      postedBy: req.user._id,
      teacherName: req.user.name,
      status: noticeStatus,
      publishAt: publishAt ? new Date(publishAt) : null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      publishedAt: finalPublishedAt,
      date: finalPublishedAt || now,
    });

    if (noticeStatus === 'published') {
      const io = req.app.get('io');
      if (io) {
        io.emit('newNotice', notice);
      }
    }

    res.status(201).json({ success: true, message: 'Notice posted successfully!', notice });
  } catch (err) {
    handleError(res, err);
  }
};

const deleteNotice = async (req, res) => {
  try {
    const notice = await Notice.findById(req.params.id);
    if (!notice) {
      return res.status(404).json({ success: false, message: 'Notice not found.' });
    }

    if (notice.postedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    notice.deletedAt = new Date();
    await notice.save();

    res.json({ success: true, message: 'Notice deleted successfully.' });
  } catch (err) {
    handleError(res, err);
  }
};

const restoreNotice = async (req, res) => {
  try {
    const notice = await Notice.findOne({ _id: req.params.id, deletedAt: { $ne: null } });
    if (!notice) {
      return res.status(404).json({ success: false, message: 'Notice not found or not deleted.' });
    }

    if (notice.postedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    notice.deletedAt = null;
    await notice.save();

    res.json({ success: true, message: 'Notice restored successfully.' });
  } catch (err) {
    handleError(res, err);
  }
};

const bulkDeleteNotices = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: 'Notice IDs required.' });
    }

    await Notice.updateMany(
      { _id: { $in: ids }, postedBy: req.user._id },
      { deletedAt: new Date() }
    );

    res.json({ success: true, message: `${ids.length} notices deleted.` });
  } catch (err) {
    handleError(res, err);
  }
};

// ---- RESOURCES ----

const getMyResources = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const searchFilter = getSearchFilter(req, ['title', 'subject']);

    const filter = {
      uploadedBy: req.user._id,
      deletedAt: null,
      ...searchFilter
    };

    const [resources, total] = await Promise.all([
      Resource.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Resource.countDocuments(filter)
    ]);

    res.json({
      success: true,
      resources,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (err) {
    handleError(res, err);
  }
};

const uploadResource = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Please upload a file.' });
    }

    // File validation
    const allowedTypes = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'txt'];
    const fileExt = path.extname(req.file.originalname).slice(1).toLowerCase();

    if (!allowedTypes.includes(fileExt)) {
      return res.status(400).json({
        success: false,
        message: `File type not allowed. Allowed: ${allowedTypes.join(', ')}`
      });
    }

    if (req.file.size > 5 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        message: 'File size exceeds 5MB limit.'
      });
    }

    const { title, subject, targetClass } = req.body;
    if (!title || !subject) {
      return res.status(400).json({
        success: false,
        message: 'Title and subject are required.'
      });
    }

    const resource = await Resource.create({
      title,
      subject,
      targetClass: targetClass || 'All Classes',
      fileUrl: `/uploads/${req.file.filename}`,
      fileName: req.file.originalname,
      fileType: fileExt,
      fileSize: req.file.size,
      uploadedBy: req.user._id,
      teacherName: req.user.name,
    });

    res.status(201).json({ success: true, message: 'Resource uploaded successfully!', resource });
  } catch (err) {
    handleError(res, err);
  }
};

const deleteResource = async (req, res) => {
  try {
    const resource = await Resource.findById(req.params.id);
    if (!resource) {
      return res.status(404).json({ success: false, message: 'Resource not found.' });
    }

    if (resource.uploadedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    resource.deletedAt = new Date();
    await resource.save();

    res.json({ success: true, message: 'Resource deleted.' });
  } catch (err) {
    handleError(res, err);
  }
};

const restoreResource = async (req, res) => {
  try {
    const resource = await Resource.findOne({ _id: req.params.id, deletedAt: { $ne: null } });
    if (!resource) {
      return res.status(404).json({ success: false, message: 'Resource not found or not deleted.' });
    }

    if (resource.uploadedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    resource.deletedAt = null;
    await resource.save();

    res.json({ success: true, message: 'Resource restored.' });
  } catch (err) {
    handleError(res, err);
  }
};

// ---- ATTENDANCE ----

const getMyAttendance = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = { markedBy: req.user._id, deletedAt: null };

    const [records, total] = await Promise.all([
      Attendance.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Attendance.countDocuments(filter)
    ]);

    res.json({
      success: true,
      records,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (err) {
    handleError(res, err);
  }
};

const markAttendance = async (req, res) => {
  try {
    const { className, date, records } = req.body;

    if (!className || !date || !records || records.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'className, date, and records are required.'
      });
    }

    // Check if attendance already exists
    const existing = await Attendance.findOne({ className, date, markedBy: req.user._id });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Attendance already marked for this class on this date.'
      });
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
    handleError(res, err);
  }
};

// ---- STATS ----

const getDashboardStats = async (req, res) => {
  try {
    const [noticeCount, resourceCount, attendanceCount] = await Promise.all([
      Notice.countDocuments({ postedBy: req.user._id, deletedAt: null }),
      Resource.countDocuments({ uploadedBy: req.user._id, deletedAt: null }),
      Attendance.countDocuments({ markedBy: req.user._id, deletedAt: null }),
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
    handleError(res, err);
  }
};

module.exports = {
  getMyNotices, postNotice, deleteNotice, restoreNotice, bulkDeleteNotices,
  getMyResources, uploadResource, deleteResource, restoreResource,
  getMyAttendance, markAttendance,
  getDashboardStats,
};