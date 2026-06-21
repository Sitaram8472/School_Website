const Notice = require("../models/Notice");

// Get all notices (with auto-seeding if empty)
exports.getNotices = async (req, res) => {
  try {
    // Auto-seed if notices collection is empty
    const count = await Notice.countDocuments();
    if (count === 0) {
      await Notice.create([
        {
          title: "SSOC Contribution Active",
          category: "Events",
          content: "EduStream Academy has officially joined the Social Summer of Code (SSOC). Get ready to contribute!",
          date: new Date("2026-05-26"),
        },
        {
          title: "Summer Vacation Announcement",
          category: "Academic",
          content: "The academy will remain closed for summer break starting June 1st, 2026. Online remedial sessions start June 15th.",
          date: new Date("2026-05-20"),
        },
        {
          title: "Annual STEM Excellence Program",
          category: "Excellence",
          content: "Registrations are open for the annual STEM project showcase. Submit your synopsis by next Friday.",
          date: new Date("2026-05-15"),
        },
      ]);
    }

    const data = await Notice.find().sort({ date: -1 });

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

// Create a new notice (for teachers/staff)
exports.createNotice = async (req, res) => {
  try {
    const { title, category, content } = req.body;

    if (!title || !category || !content) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    const newNotice = await Notice.create({
      title,
      category,
      content,
      date: new Date(),
    });

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