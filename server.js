const express = require('express');
const session = require('express-session');
const path = require('path');

const { seedAdminIfNeeded } = require('./db');
const { topDateStr, dateBadge, dashboardPathForRole } = require('./utils');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const employeeRoutes = require('./routes/employee');
const viewerRoutes = require('./routes/viewer');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Appends `task=<id>` to a page URL (path + querystring) so a list page reopens
// the task detail slide-over pointed at that task.
app.locals.taskUrl = (base, id) => base + (base.includes('?') ? '&' : '?') + 'task=' + id;

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: 'pms-secret-key-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 12 } // 12 hours
  })
);

app.use((req, res, next) => {
  res.locals.role = req.session.role;
  res.locals.name = req.session.name;
  res.locals.roleLabel = req.session.role === 'admin' ? 'Admin' : req.session.role === 'viewer' ? 'Viewer' : 'Team Member';
  res.locals.path = req.path;
  res.locals.topDate = topDateStr();
  res.locals.dateBadge = dateBadge();
  next();
});

app.get('/', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  res.redirect(dashboardPathForRole(req.session.role));
});

app.use('/', authRoutes);
app.use('/admin', adminRoutes);
app.use('/employee', employeeRoutes);
app.use('/viewer', viewerRoutes);

seedAdminIfNeeded();

app.listen(PORT, () => {
  console.log(`PMS running at http://localhost:${PORT}`);
});
