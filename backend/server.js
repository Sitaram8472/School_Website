const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors()); 
app.use(express.json()); 

// Link your routes
const noticeRoutes = require('./routes/noticeRoutes');
app.use('/api/notices', noticeRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

const db = require('./config/db');

// db.getConnection((err, connection) => {
//   if (err) {
//     console.error(' Database connection failed:', err.message);
//   } else {
//     console.log(' SQL Database connected successfully!');
//     connection.release();
//   }
// });