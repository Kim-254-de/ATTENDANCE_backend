const pool = require('../db');

// Finds a lecturer by email or staff number. Returns the row, or null if not found.
exports.findByIdentifier = async (identifier) => {
  const value = identifier.trim();
  const isEmail = value.includes('@');

  const { rows } = await pool.query(
    `SELECT id, full_name, email, staff_number, password_hash
       FROM lecturers
      WHERE ${isEmail ? 'email' : 'staff_number'} = $1`,
    [isEmail ? value.toLowerCase() : value.toUpperCase()]
  );
  return rows[0] || null;
};