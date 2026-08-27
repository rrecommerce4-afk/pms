function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  if (req.session.role !== 'admin') return res.status(403).send('Forbidden: admin only');
  next();
}

function requireViewer(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  if (req.session.role !== 'viewer') return res.status(403).send('Forbidden: viewer only');
  next();
}

function requireEmployee(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  if (req.session.role !== 'employee') return res.status(403).send('Forbidden: employee only');
  next();
}

module.exports = { requireLogin, requireAdmin, requireViewer, requireEmployee };
