const db = require('../config/db');

exports.getNotices = async (req, res) => {
  try {
    const sql = "SELECT * FROM notices ORDER BY date DESC";

    db.query(sql, (err, data) => {
      if (err) {
        console.error("Database Error:", err);

        return res.status(500).json({
          success: false,
          message: "Failed to fetch notices",
          error: err.message,
        });
      }

      return res.status(200).json({
        success: true,
        message: "Notices fetched successfully",
        data,
      });
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