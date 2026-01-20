const mysql = require('mysql');
require('dotenv').config();

// Create a connection pool for better performance
const pool = mysql.createPool({
  connectionLimit: 10,
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'school_db'
});

// Export the pool so it can be used in your controllers
module.exports = pool;