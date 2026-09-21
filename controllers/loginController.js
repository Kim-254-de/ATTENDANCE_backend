const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Lecturer = require('../models/Lecturer');

exports.login = async (req, res) => {
  try {
    const { identifier, password } = req.body; // identifier = staff number or email

    if (!identifier || !password) {
      return res.status(400).json({ message: 'Enter your staff number or email, and your password.' });
    }

    // Find the lecturer in our database
    const lecturer = await Lecturer.findByIdentifier(String(identifier));

    // Not one of ours -> tell them to register
    if (!lecturer) {
      return res.status(404).json({ message: 'No account found. Please register first.' });
    }

    // Check the password
    const passwordOk = await bcrypt.compare(String(password), lecturer.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ message: 'Incorrect staff number/email or password.' });
    }

    // Let them in
    const token = jwt.sign(
      { id: lecturer.id, role: 'lecturer' },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );

    res.json({
      message: 'Signed in successfully.',
      token,
      lecturer: {
        id: lecturer.id,
        fullName: lecturer.full_name,
        email: lecturer.email,
        staffNumber: lecturer.staff_number,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Something went wrong. Please try again.' });
  }
};