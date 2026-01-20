const db = require('../config/db');

// Function to get all notices for the home page Notice Board
exports.getNotices = (req, res) => {
  const sql = "SELECT * FROM notices ORDER BY date DESC";

  db.query(sql, (err, data) => {
    if (err) return res.status(500).json({ error: err.message });
    return res.json(data);
  });
};