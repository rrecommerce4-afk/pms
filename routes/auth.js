const express = require('express');
const bcrypt = require('bcryptjs');
const { load } = require('../db');
const { dashboardPathForRole } = require('../utils');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.userId) {
    return res.redirect(dashboardPathForRole(req.session.role));
  }
  res.render('login', { error: null });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const db = load();
  const user = db.users.find((u) => u.email.toLowerCase() === String(email || '').toLowerCase() && u.active);

  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.render('login', { error: 'Invalid email or password' });
  }

  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.name = user.name;

  res.redirect(dashboardPathForRole(user.role));
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
