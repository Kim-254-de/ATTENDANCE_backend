require('dotenv').config(); // must be first
const express = require('express');
const cors = require('cors');

if (!process.env.DATABASE_URL || !process.env.JWT_SECRET) {
  console.error('Missing DATABASE_URL or JWT_SECRET. Check that your .env file is in this folder and saved.');
  process.exit(1);
}

const pool = require('./db');
const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN }));
app.use(express.json());

app.use('/api/auth', require('./routes/authRoutes'));

const port = process.env.PORT || 4000;

pool
  .query('SELECT 1')
  .then(() => {
    console.log('PostgreSQL connected');
    app.listen(port, () => console.log(`Server running on port ${port}`));
  })
  .catch((err) => {
    console.error('PostgreSQL connection failed:', err.message);
    process.exit(1);
  });