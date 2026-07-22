const Notice = require("../models/Notice");
const User = require("../models/User");
const mongoose = require("mongoose");

// Helper to validate publication and expiration dates
const validateNoticeDates = (publishAt, expiresAt, now = new Date()) => {
  if (publishAt) {
    const pubDate = new Date(publishAt);
    if (pubDate < now) {
      return "Publication date/time cannot be in the past.";
    }
  }
  if (expiresAt) {
    const expDate = new Date(expiresAt);
    if (expDate < now) {
      return "Expiration date/time cannot be in the past.";
    }
    const compareDate = publishAt ? new Date(publishAt) : now;
    if (expDate < compareDate) {
      return "Expiration date must be after publication date.";
    }
  }
  return null;
};

// Get all notices
exports.getNotices = async (req, res) => {
  try {
    // Auto-seed if notices collection is empty
    const count = await Notice.countDocuments();
    if (count === 0) {
      // Find a user to associate with the seed notices since postedBy is required
      let seedUser = await User.findOne({ role: "admin" });
      if (!seedUser) {
        seedUser = await User.findOne({ role: "teacher" });
      }
      const seedUserId = seedUser ? seedUser._id : new mongoose.Types.ObjectId();

      await Notice.create([
        {
          title: "SSOC Contribution Active",
          category: "Events",
          content: "EduStream Academy has officially joined the Social Summer of Code (SSOC). Get ready to contribute!",
          date: new Date("2026-05-26"),
          status: "published",
          publishedAt: new Date("2026-05-26"),
          postedBy: seedUserId,
        },
        {
          title: "Summer Vacation Announcement",
          category: "Academic",
          content: "The academy will remain closed for summer break starting June 1st, 2026. Online remedial sessions start June 15th.",
          date: new Date("2026-05-20"),
          status: "published",
          publishedAt: new Date("2026-05-20"),
          postedBy: seedUserId,
        },
        {
          title: "Annual STEM Excellence Program",
          category: "Excellence",
          content: "Registrations are open for the annual STEM project showcase. Submit your synopsis by next Friday.",
          date: new Date("2026-05-15"),
          status: "published",
          publishedAt: new Date("2026-05-15"),
          postedBy: seedUserId,
        },
      ]);
    }

    // Use req.user set by optionalProtect middleware
    const canViewAll = req.user && ["admin", "teacher", "staff"].includes(req.user.role);
    const filter = canViewAll ? {} : { status: "published" };
    const data = await Notice.find(filter).sort({ date: -1 });

    return res.status(200).json({
      success: true,
      message: "Notices fetched successfully",
      data,
    });
  } catch (error) {
    console.error("Server Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  }
};

// Create a new notice (for teachers/staff/admins)
exports.createNotice = async (req, res) => {
  try {
    const { title, category, content, status, publishAt, expiresAt } = req.body;

    if (!title || !title.trim() || !category || !content) {
      return res.status(400).json({
        success: false,
        message: "Title, category, and content are required",
      });
    }

    const now = new Date();

    // Date validations
    const dateValidationError = validateNoticeDates(publishAt, expiresAt, now);
    if (dateValidationError) {
      return res.status(400).json({
        success: false,
        message: dateValidationError,
      });
    }

    let noticeStatus = "published";
    let finalPublishedAt = null;
    let finalPublishAt = publishAt ? new Date(publishAt) : null;

    if (status === "draft") {
      noticeStatus = "draft";
      finalPublishAt = null; // Ensure publishAt is null for drafts to prevent cron from publishing it
    } else if (finalPublishAt && finalPublishAt > now) {
      noticeStatus = "scheduled";
    } else {
      noticeStatus = "published";
      finalPublishedAt = now;
    }

    const postedBy = req.user ? req.user._id : null;
    if (!postedBy) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized. postedBy is required.",
      });
    }

    const newNotice = await Notice.create({
      title,
      category,
      content,
      status: noticeStatus,
      publishAt: finalPublishAt,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      publishedAt: finalPublishedAt,
      postedBy,
      teacherName: req.user ? req.user.name : undefined,
      date: finalPublishedAt || now,
    });

    if (noticeStatus === "published") {
      const io = req.app.get('io');
      if (io) {
        io.emit('newNotice', newNotice);
      }
    }

    return res.status(201).json({
      success: true,
      message: "Notice created successfully",
      data: newNotice,
    });
  } catch (error) {
    console.error("Create Notice Error:", error);

    return res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// Schedule a notice
exports.scheduleNotice = async (req, res) => {
  try {
    const { publishAt } = req.body;

    if (!publishAt) {
      return res.status(400).json({
        success: false,
        message: "publishAt date/time is required",
      });
    }

    const pubDate = new Date(publishAt);
    const now = new Date();

    if (pubDate < now) {
      return res.status(400).json({
        success: false,
        message: "Publication date/time cannot be in the past.",
      });
    }

    const notice = await Notice.findById(req.params.id);
    if (!notice) {
      return res.status(404).json({
        success: false,
        message: "Notice not found",
      });
    }

    if (req.permissionType === 'own' && notice.postedBy.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Forbidden: You do not have permission to perform this action.' });
    }

    // Verify constraints if expiresAt is set
    if (notice.expiresAt && notice.expiresAt < pubDate) {
      return res.status(400).json({
        success: false,
        message: "Expiration date must be after publication date.",
      });
    }

    notice.publishAt = pubDate;
    notice.status = "scheduled";
    notice.publishedAt = null;
    await notice.save();

    return res.status(200).json({
      success: true,
      message: "Notice scheduled successfully",
      data: notice,
    });
  } catch (error) {
    console.error("Schedule Notice Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// Cancel a scheduled notice
exports.cancelSchedule = async (req, res) => {
  try {
    const notice = await Notice.findById(req.params.id);
    if (!notice) {
      return res.status(404).json({
        success: false,
        message: "Notice not found",
      });
    }

    if (req.permissionType === 'own' && notice.postedBy.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Forbidden: You do not have permission to perform this action.' });
    }

    notice.status = "draft";
    notice.publishAt = null;
    await notice.save();

    return res.status(200).json({
      success: true,
      message: "Scheduled notice cancelled and saved as draft",
      data: notice,
    });
  } catch (error) {
    console.error("Cancel Schedule Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// Archive a notice manually
exports.archiveNotice = async (req, res) => {
  try {
    const notice = await Notice.findById(req.params.id);
    if (!notice) {
      return res.status(404).json({
        success: false,
        message: "Notice not found",
      });
    }

    if (req.permissionType === 'own' && notice.postedBy.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Forbidden: You do not have permission to perform this action.' });
    }

    notice.status = "archived";
    await notice.save();

    return res.status(200).json({
      success: true,
      message: "Notice archived successfully",
      data: notice,
    });
  } catch (error) {
    console.error("Archive Notice Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// Update an existing notice
exports.updateNotice = async (req, res) => {
  try {
    const { title, category, content, status, publishAt, expiresAt } = req.body;
    const notice = await Notice.findById(req.params.id);

    if (!notice) {
      return res.status(404).json({
        success: false,
        message: "Notice not found",
      });
    }

    if (req.permissionType === 'own' && notice.postedBy.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Forbidden: You do not have permission to perform this action.' });
    }

    if (req.permissionType === 'own' && notice.postedBy.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Forbidden: You do not have permission to perform this action.' });
    }

    if (title !== undefined) {
      if (!title || !title.trim()) {
        return res.status(400).json({
          success: false,
          message: "Title cannot be empty",
        });
      }
      notice.title = title;
    }

    if (category !== undefined) notice.category = category;
    if (content !== undefined) notice.content = content;

    const now = new Date();

    const finalPublishAt = publishAt !== undefined ? (publishAt ? new Date(publishAt) : null) : notice.publishAt;
    const finalExpiresAt = expiresAt !== undefined ? (expiresAt ? new Date(expiresAt) : null) : notice.expiresAt;

    // Run date validation helper
    const dateValidationError = validateNoticeDates(finalPublishAt, finalExpiresAt, now);
    if (dateValidationError) {
      return res.status(400).json({
        success: false,
        message: dateValidationError,
      });
    }

    if (publishAt !== undefined) notice.publishAt = finalPublishAt;
    if (expiresAt !== undefined) notice.expiresAt = finalExpiresAt;

    if (status !== undefined) {
      notice.status = status;
      if (status === "published") {
        notice.publishedAt = now;
        notice.date = now;
      } else if (status === "scheduled") {
        notice.publishedAt = null;
      } else if (status === "draft") {
        notice.publishAt = null; // Clear publishAt on draft transition
      }
    } else {
      if (publishAt !== undefined) {
        if (finalPublishAt && finalPublishAt > now) {
          notice.status = "scheduled";
          notice.publishedAt = null;
        } else {
          notice.status = "published";
          notice.publishedAt = now;
          notice.date = now;
        }
      }
    }

    await notice.save();

    return res.status(200).json({
      success: true,
      message: "Notice updated successfully",
      data: notice,
    });
  } catch (error) {
    console.error("Update Notice Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};