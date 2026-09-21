const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { login } = require('../controllers/loginController');

// Max 10 login attempts per 15 minutes per IP (slows down password guessing)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: { message: 'Too many attempts. Please try again in a few minutes.' },
});

router.post('/login', loginLimiter, login);

module.exports = router;
