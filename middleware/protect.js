const jwt = require('jsonwebtoken');

// Put this on any route that needs a signed-in lecturer:
//   router.get('/my-classes', protect, handler)
// Then req.lecturer.id is available inside the handler.
module.exports = (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'Please sign in.' });

  try {
    req.lecturer = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Session expired. Please sign in again.' });
  }
};
