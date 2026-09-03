const express = require('express');
const bcrypt = require('bcryptjs');
const { load, save, todayStr, ensureTodayLogs, getMissedCount, getMissedTasks, clearMissedTasks } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { chipDateStr, formatIsoDate, yesterdayStr } = require('../utils');

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

  const needsAttention = [...perEmployee].sort((a, b) => b.pending - a.pending);

  const recentTasks = perEmployee
    .flatMap((e) => e.logsToday.map((x) => ({ task: x.task, log: x.log, employeeName: e.name })))
    .slice(0, 5);

  const adminCount = db.users.filter((u) => u.role === 'admin' && u.active).length;
  const totalDailyTasks = db.tasks.filter((t) => t.active).length;
  const missedYesterday = db.taskLogs.filter((l) => l.date === yesterdayStr(today) && l.status === 'pending').length;

  res.render('admin-dashboard', {
    crumb: 'Dashboard',
    heading: 'Dashboard',
    chipDate: chipDateStr(),
    today,
    perEmployee,
    needsAttention,
    total,
    completed,
    pending,
    donutPct,
    recentTasks,
    employeeCount: employees.length,
    adminCount,
    totalDailyTasks,
    missedYesterday
  });
});

// ---- Missed Tasks ----

router.get('/missed', (req, res) => {
  const db = load();
  const today = todayStr();
  const employeeId = req.query.employee ? Number(req.query.employee) : null;

  const rows = getMissedTasks(db, today, employeeId).map((r) => ({ ...r, dateLabel: formatIsoDate(r.log.date) }));
  const filteredEmployee = employeeId ? db.users.find((u) => u.id === employeeId) : null;

  // Group rows by employee, preserving the most-recent-first order already applied to `rows`.
  const groups = [];
  const groupByEmployeeId = new Map();
  rows.forEach((r) => {
    let group = groupByEmployeeId.get(r.employee.id);
    if (!group) {
      group = { employee: r.employee, tasks: [] };
      groupByEmployeeId.set(r.employee.id, group);
      groups.push(group);
    }
    group.tasks.push(r);
  });

  res.render('admin-missed', {
    crumb: 'Missed Tasks',
    heading: 'Missed Tasks',
    subheading: filteredEmployee
      ? `${filteredEmployee.name} ke incomplete tasks jo unke din khatam hone tak complete nahi hue.`
      : 'Sabhi employees ke incomplete tasks jo unke din khatam hone tak complete nahi hue.',
    rows,
    groups,
    filteredEmployee,
    asOfDate: chipDateStr()
  });
});

router.post('/missed/clear', (req, res) => {
  const db = load();
  const today = todayStr();
  const employeeId = req.body.employee ? Number(req.body.employee) : null;

  clearMissedTasks(db, today, employeeId);
  res.redirect(employeeId ? `/admin/missed?employee=${employeeId}` : '/admin/missed');
});

// ---- Employees / Users (admin can add more admins here too) ----

const employeesPageLocals = {
  crumb: 'Employees',
  heading: 'Team Members',
  subheading: 'Add employees or additional admins and manage their access.'
};

router.get('/employees', (req, res) => {
  const db = load();
  const users = db.users.filter((u) => u.active);
  res.render('admin-employees', {
    ...employeesPageLocals,
    users,
    userCount: users.length,
    error: req.query.error || null
  });
});

router.post('/employees', (req, res) => {
  const { name, email, password, department, role } = req.body;
  const db = load();
  const finalRole = role === 'admin' || role === 'viewer' ? role : 'employee';

  if (!name || !email || !password) {
    return res.redirect('/admin/employees?error=' + encodeURIComponent('Full name, email, and password are required.'));
  }

  const exists = db.users.some((u) => u.email.toLowerCase() === email.toLowerCase());
  if (exists) {
    return res.redirect('/admin/employees?error=' + encodeURIComponent('Email already in use.'));
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

router.post('/employees/:id/edit', (req, res) => {
  const { name, email, password, department, role } = req.body;
  const db = load();
  const targetId = Number(req.params.id);
  const user = db.users.find((u) => u.id === targetId);

  if (!user) return res.redirect('/admin/employees?error=' + encodeURIComponent('User not found.'));
  if (!name || !email) {
    return res.redirect('/admin/employees?error=' + encodeURIComponent('Full name and email are required.'));
  }

  const finalRole = role === 'admin' || role === 'viewer' ? role : 'employee';

  const emailTaken = db.users.some((u) => u.id !== targetId && u.email.toLowerCase() === email.toLowerCase());
  if (emailTaken) {
    return res.redirect('/admin/employees?error=' + encodeURIComponent('Email already in use.'));
  }

  if (user.role === 'admin' && finalRole !== 'admin') {
    const activeAdmins = db.users.filter((u) => u.role === 'admin' && u.active);
    if (activeAdmins.length <= 1) {
      return res.redirect('/admin/employees?error=' + encodeURIComponent('At least one admin must remain.'));
    }
  }

  user.name = name;
  user.email = email;
  user.role = finalRole;
  user.department = finalRole === 'employee' ? (department || 'Team Member') : undefined;
  if (password) user.passwordHash = bcrypt.hashSync(password, 10);

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

const taskPageLocals = { crumb: 'Tasks', heading: 'Tasks', subheading: 'Employees ko daily tasks assign karein.' };

function buildTasksViewData(db) {
  const employees = db.users.filter((u) => u.role === 'employee' && u.active);
  const tasks = db.tasks
    .filter((t) => t.active)
    .map((t) => ({ ...t, employeeName: (db.users.find((u) => u.id === t.assignedTo) || {}).name || 'Unknown' }));
  const groups = employees
    .map((emp) => ({ employee: emp, tasks: tasks.filter((t) => t.assignedTo === emp.id) }))
    .filter((g) => g.tasks.length > 0);
  return { employees, tasks, groups };
}

router.get('/tasks', (req, res) => {
  const db = load();
  const { employees, tasks, groups } = buildTasksViewData(db);
  res.render('admin-tasks', { ...taskPageLocals, tasks, employees, groups, taskCount: tasks.length, error: null });
});

router.post('/tasks', (req, res) => {
  const { title, description, assignedTo, detail } = req.body;
  const db = load();
  const assigneeIds = (Array.isArray(assignedTo) ? assignedTo : [assignedTo]).filter(Boolean).map(Number);

  if (!title || assigneeIds.length === 0) {
    const { employees, tasks, groups } = buildTasksViewData(db);
    return res.render('admin-tasks', { ...taskPageLocals, tasks, employees, groups, taskCount: tasks.length, error: 'Title and at least one assigned employee are required' });
  }

  const today = todayStr();
  assigneeIds.forEach((empId) => {
    const newTask = {
      id: db.nextId.tasks++,
      title,
      description: description || '',
      detail: detail || '',
      assignedTo: empId,
      source: 'admin',
      active: true,
      createdAt: new Date().toISOString()
    };
    db.tasks.push(newTask);

    // create today's pending log immediately so it shows up right away
    db.taskLogs.push({
      id: db.nextId.taskLogs++,
      taskId: newTask.id,
      date: today,
      status: 'pending',
      completedAt: null
    });
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
