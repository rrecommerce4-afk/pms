const express = require('express');
const bcrypt = require('bcryptjs');
const { load, save, todayStr, ensureTodayLogs, getMissedCount, getMissedTasks } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { chipDateStr, formatIsoDate } = require('../utils');

const router = express.Router();
router.use(requireAdmin);

router.get('/dashboard', (req, res) => {
  ensureTodayLogs();
  const db = load();
  const today = todayStr();
  const employees = db.users.filter((u) => u.role === 'employee' && u.active);

  const perEmployee = employees.map((emp) => {
    const empTasks = db.tasks.filter((t) => t.assignedTo === emp.id && t.active);
    const logsToday = empTasks
      .map((t) => ({ log: db.taskLogs.find((l) => l.taskId === t.id && l.date === today), task: t }))
      .filter((x) => x.log);
    const total = logsToday.length;
    const completed = logsToday.filter((x) => x.log.status === 'completed').length;
    const missed = getMissedCount(db, emp.id, today);
    const pct = total ? Math.round((completed / total) * 100) : 0;
    return {
      id: emp.id,
      name: emp.name,
      department: emp.department || 'Team Member',
      total,
      completed,
      pending: total - completed,
      missed,
      pct,
      logsToday
    };
  });

  const total = perEmployee.reduce((s, e) => s + e.total, 0);
  const completed = perEmployee.reduce((s, e) => s + e.completed, 0);
  const pending = total - completed;
  const donutPct = total ? Math.round((completed / total) * 100) : 0;

  const recentTasks = perEmployee
    .flatMap((e) => e.logsToday.map((x) => ({ task: x.task, log: x.log, employeeName: e.name })))
    .slice(0, 5);

  res.render('admin-dashboard', {
    crumb: 'Dashboard',
    heading: 'Team Dashboard',
    subheading: 'Aaj ke sabhi team members ke tasks aur progress ka overview.',
    chipDate: chipDateStr(),
    today,
    perEmployee,
    total,
    completed,
    pending,
    donutPct,
    recentTasks,
    employeeCount: employees.length
  });
});

// ---- Missed Tasks ----

router.get('/missed', (req, res) => {
  const db = load();
  const today = todayStr();
  const employeeId = req.query.employee ? Number(req.query.employee) : null;

  const rows = getMissedTasks(db, today, employeeId).map((r) => ({ ...r, dateLabel: formatIsoDate(r.log.date) }));
  const filteredEmployee = employeeId ? db.users.find((u) => u.id === employeeId) : null;

  res.render('admin-missed', {
    crumb: 'Missed Tasks',
    heading: 'Missed Tasks',
    subheading: filteredEmployee
      ? `${filteredEmployee.name} ke incomplete tasks jo unke din khatam hone tak complete nahi hue.`
      : 'Sabhi employees ke incomplete tasks jo unke din khatam hone tak complete nahi hue.',
    rows,
    filteredEmployee
  });
});

// ---- Employees / Users (admin can add more admins here too) ----

const employeesPageLocals = {
  crumb: 'Employees',
  heading: 'Team Members',
  subheading: 'Add employees or additional admins and manage their access.'
};

router.get('/employees', (req, res) => {
  const db = load();
  const users = db.users;
  res.render('admin-employees', {
    ...employeesPageLocals,
    users,
    userCount: users.filter((u) => u.active).length,
    error: req.query.error || null
  });
});

router.post('/employees', (req, res) => {
  const { name, email, password, department, role } = req.body;
  const db = load();
  const finalRole = role === 'admin' || role === 'viewer' ? role : 'employee';

  if (!name || !email || !password) {
    const users = db.users;
    return res.render('admin-employees', { ...employeesPageLocals, users, userCount: users.filter((u) => u.active).length, error: 'All fields are required' });
  }

  const exists = db.users.some((u) => u.email.toLowerCase() === email.toLowerCase());
  if (exists) {
    const users = db.users;
    return res.render('admin-employees', { ...employeesPageLocals, users, userCount: users.filter((u) => u.active).length, error: 'Email already in use' });
  }

  db.users.push({
    id: db.nextId.users++,
    name,
    email,
    passwordHash: bcrypt.hashSync(password, 10),
    role: finalRole,
    department: finalRole === 'employee' ? (department || 'Team Member') : undefined,
    active: true
  });
  save(db);
  res.redirect('/admin/employees');
});

router.post('/employees/:id/delete', (req, res) => {
  const db = load();
  const targetId = Number(req.params.id);
  const user = db.users.find((u) => u.id === targetId);

  if (!user) return res.redirect('/admin/employees');

  if (targetId === req.session.userId) {
    return res.redirect('/admin/employees?error=' + encodeURIComponent('You cannot remove your own account.'));
  }

  if (user.role === 'admin') {
    const activeAdmins = db.users.filter((u) => u.role === 'admin' && u.active);
    if (activeAdmins.length <= 1) {
      return res.redirect('/admin/employees?error=' + encodeURIComponent('At least one admin must remain.'));
    }
  }

  user.active = false;
  // deactivate their tasks too so no new daily logs get created for them
  db.tasks.filter((t) => t.assignedTo === user.id).forEach((t) => (t.active = false));
  save(db);
  res.redirect('/admin/employees');
});

// ---- Tasks ----

const taskPageLocals = { crumb: 'Tasks', heading: 'Daily Tasks', subheading: 'Employees ko daily tasks assign karein.' };

router.get('/tasks', (req, res) => {
  const db = load();
  const employees = db.users.filter((u) => u.role === 'employee' && u.active);
  const tasks = db.tasks
    .filter((t) => t.active)
    .map((t) => ({ ...t, employeeName: (db.users.find((u) => u.id === t.assignedTo) || {}).name || 'Unknown' }));
  res.render('admin-tasks', { ...taskPageLocals, tasks, employees, taskCount: tasks.length, error: null });
});

router.post('/tasks', (req, res) => {
  const { title, description, assignedTo, detail } = req.body;
  const db = load();
  const employees = db.users.filter((u) => u.role === 'employee' && u.active);

  if (!title || !assignedTo) {
    const tasks = db.tasks
      .filter((t) => t.active)
      .map((t) => ({ ...t, employeeName: (db.users.find((u) => u.id === t.assignedTo) || {}).name || 'Unknown' }));
    return res.render('admin-tasks', { ...taskPageLocals, tasks, employees, taskCount: tasks.length, error: 'Title and assigned employee are required' });
  }

  const newTask = {
    id: db.nextId.tasks++,
    title,
    description: description || '',
    detail: detail || '',
    assignedTo: Number(assignedTo),
    active: true,
    createdAt: new Date().toISOString()
  };
  db.tasks.push(newTask);

  // create today's pending log immediately so it shows up right away
  const today = todayStr();
  db.taskLogs.push({
    id: db.nextId.taskLogs++,
    taskId: newTask.id,
    date: today,
    status: 'pending',
    completedAt: null
  });

  save(db);
  res.redirect('/admin/tasks');
});

router.post('/tasks/:id/delete', (req, res) => {
  const db = load();
  const task = db.tasks.find((t) => t.id === Number(req.params.id));
  if (task) {
    task.active = false;
    save(db);
  }
  res.redirect('/admin/tasks');
});

module.exports = router;
