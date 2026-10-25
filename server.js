// One business time zone for every date the PMS reads, shows or compares (form times like
// "2026-10-25T18:00", "today", publishing slots, deadlines), whatever the host's own setting —
// e.g. a cloud server running in UTC. Set PMS_TIMEZONE to change it. Must run before any Date use.
process.env.TZ = process.env.PMS_TIMEZONE || 'Asia/Kolkata';

const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');

const { load, save, seedAdminIfNeeded } = require('./db');
const { topDateStr, dateBadge, dashboardPathForRole } = require('./utils');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const employeeRoutes = require('./routes/employee');
const viewerRoutes = require('./routes/viewer');
const socialRoutes = require('./routes/social');
const { getStudio } = require('./lib/studio/store');
const { resolveActor, canSeeSheet } = require('./lib/studio/permissions');
const { STUDIO_NAV } = require('./lib/studio/nav');
const instagram = require('./lib/studio/instagram');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Appends `task=<id>` to a page URL (path + querystring) so a list page reopens
// the task detail slide-over pointed at that task.
app.locals.taskUrl = (base, id) => base + (base.includes('?') ? '&' : '?') + 'task=' + id;
app.locals.studioNav = STUDIO_NAV;

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(
  session({
    secret: 'pms-secret-key-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 12 } // 12 hours
  })
);

// The session keeps the name from login time, so a profile rename wouldn't show until the
// user logged in again. Re-read it from the users list on each request instead.
// Also decides whether the sidebar shows the Social Media Studio link for this user, and gives
// admins the Instagram access-token reminders (popup once a day + banner until fixed).
app.use((req, res, next) => {
  res.locals.studioAccess = false;
  res.locals.sheetAccess = false;
  res.locals.igAlerts = [];
  if (req.session.userId) {
    const db = load();
    const user = db.users.find((u) => u.id === req.session.userId);
    if (user) req.session.name = user.name;
    const studio = getStudio(db);
    const actor = user ? resolveActor(studio, user) : null;
    res.locals.studioAccess = !!(actor && actor.canView && (actor.isManager || studio.settings.teamAccess));
    res.locals.sheetAccess = canSeeSheet(studio, user, actor);
    if (user && user.role === 'admin' && user.active) {
      res.locals.igAlerts = instagram.tokenAlerts(studio);
      if (res.locals.igAlerts.length) {
        if (!req.session.studioCsrf) req.session.studioCsrf = crypto.randomBytes(24).toString('hex');
        res.locals.igCsrf = req.session.studioCsrf;
        res.locals.igPopup = req.session.igReminderDismissed !== new Date().toDateString();
      }
    }
  }
  next();
});

app.use((req, res, next) => {
  res.locals.role = req.session.role;
  res.locals.name = req.session.name;
  res.locals.userId = req.session.userId;
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
app.use('/social-media', socialRoutes);
app.use('/content-sheet', socialRoutes.sheet);

seedAdminIfNeeded();

// Daily Instagram follower sync for connected Studio pages (no-op until a page is connected).
instagram.startScheduler({ loadDb: load, saveDb: save, getStudio });

app.listen(PORT, () => {
  console.log(`PMS running at http://localhost:${PORT}`);
});
