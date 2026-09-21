const { Pool } = require('pg');

// Reads DATABASE_URL from .env (dotenv must be loaded first, see app.js)
module.exports = new Pool({ connectionString: process.env.DATABASE_URL });