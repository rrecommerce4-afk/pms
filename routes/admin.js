const express = require('express');
const bcrypt = require('bcryptjs');
const { load, save, todayStr, logActivity, uniqueSlug, BADGE_COLORS } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const T = require('../lib/tasks');
const upload = require('../lib/upload');

const router = express.Router();
router.use(requireAdmin);

function queryFilters(req) {
  return {
    q: (req.query.q || '').trim(),
    due: req.query.due || 'all',
    employee: req.query.employee || 'all',
    view: req.query.view === 'kanban' ? 'kanban' : 'list'
  };
}

// Current page's path + querystring (minus `task`) — used to reopen the detail panel
// on the right page/filter state after a form action redirects back.
function pageUrl(req) {
  const params = new URLSearchParams();
  ['q', 'due', 'employee', 'view'].forEach((k) => { if (req.query[k]) params.set(k, req.query[k]); });
  const qs = params.toString();
  return req.baseUrl + req.path + (qs ? '?' + qs : '');
}

function loadCommon() {
  const db = load();
  const today = todayStr();
  const employees = db.users.filter((u) => u.role === 'employee' && u.active);
  const decorated = T.decorateAll(db.tasks, db.users, today);
  return { db, today, employees, decorated };
}

function openTask(req, db, today) {
  const taskId = req.query.task ? Number(req.query.task) : null;
  if (!taskId) return null;
  const task = db.tasks.find((t) => t.id === taskId);
  return task ? T.decorate(task, db.users, today) : null;
}

// nav badge counts, needed on every admin page's sidebar
router.use((req, res, next) => {
  const db = load();
  res.locals.navCounts = {
    all: db.tasks.length,
    review: db.tasks.filter((t) => t.status === 'review').length
  };
  next();
});

router.get('/dashboard', (req, res) => {
  const { db, today, employees, decorated } = loadCommon();
  const filters = queryFilters(req);
  const filtered = T.filterTasks(decorated, filters, today);
  const summary = T.summaryCards(decorated, employees.length);
  const attention = decorated.filter((t) => t.overdue || t.status === 'blocked' || t.status === 'review');
  const workload = T.workloadData(decorated, employees).slice(0, 4);
  const activity = (db.activity || []).slice(0, 6).map((a) => ({ text: a.text, time: T.formatRelativeTime(a.time) }));

  res.render('admin-dashboard', {
    crumb: 'Dashboard', heading: 'Dashboard',
    filters, pageUrl: pageUrl(req), employees,
    summary, attention, filtered, workload, activity,
    detailTask: openTask(req, db, today),
    showSearch: true, showFilters: true, showCreateButton: true, searchPlaceholder: 'Search tasks...'
  });
});

router.get('/tasks', (req, res) => {
  const { db, today, employees, decorated } = loadCommon();
  const filters = queryFilters(req);
  const filtered = T.filterTasks(decorated, filters, today);

  res.render('admin-tasks', {
    crumb: 'All Tasks', heading: 'All Tasks',
    filters, pageUrl: pageUrl(req), employees, filtered,
    detailTask: openTask(req, db, today),
    showSearch: true, showFilters: true, showCreateButton: true, searchPlaceholder: 'Search tasks...'
  });
});

router.get('/review', (req, res) => {
  const { db, today, employees, decorated } = loadCommon();
  const filtered = decorated.filter((t) => t.status === 'review');

  res.render('admin-review', {
    crumb: 'Review & Approval', heading: 'Review & Approval',
    pageUrl: pageUrl(req), filtered, employees,
    detailTask: openTask(req, db, today),
    showCreateButton: true
  });
});

router.get('/workload', (req, res) => {
  const { employees, decorated } = loadCommon();
  res.render('admin-workload', {
    crumb: 'Team Workload', heading: 'Team Workload',
    workload: T.workloadData(decorated, employees), pageUrl: pageUrl(req), employees,
    showCreateButton: true
  });
});

router.get('/reports', (req, res) => {
  const { employees, decorated } = loadCommon();
  res.render('admin-reports', {
    crumb: 'Reports', heading: 'Reports',
    reports: T.reportsData(decorated, employees), pageUrl: pageUrl(req), employees,
    showCreateButton: true
  });
});

// ---- Task create / edit / delete ----

router.post('/tasks', (req, res) => {
  const { title, description, assignedTo, priority, recurrence, startDate, dueDate } = req.body;
  const db = load();
  const today = todayStr();

  if (!title || !title.trim() || !assignedTo || !dueDate) {
    return res.redirect('/admin/tasks');
  }

  const checklistRaw = req.body.checklist;
  const checklistItems = Array.isArray(checklistRaw) ? checklistRaw : (checklistRaw ? [checklistRaw] : []);

  const newTask = {
    id: db.nextId.tasks++,
    title: title.trim(),
    description: (description || '').trim(),
    assignedTo: Number(assignedTo),
    assignedByName: req.session.name,
    priority: ['high', 'medium', 'low'].includes(priority) ? priority : 'medium',
    status: 'todo',
    recurrence: T.RECUR_DAYS[recurrence] ? recurrence : 'none',
    startDate: startDate || today,
    dueDate,
    checklist: checklistItems.filter((c) => c && c.trim()).map((text) => ({ text: text.trim(), done: false })),
    files: [],
    comments: [],
    blocked: false,
    blockedReason: '',
    createdAt: new Date().toISOString(),
    completedAt: null
  };
  db.tasks.push(newTask);

  const assignee = db.users.find((u) => u.id === newTask.assignedTo);
  logActivity(db, `<b>${T.escapeHtml(req.session.name)}</b> created task "${T.escapeHtml(newTask.title)}" and assigned it to ${T.escapeHtml(assignee ? assignee.name : 'someone')}`);
  save(db);
  res.redirect('/admin/tasks?task=' + newTask.id);
});

router.post('/tasks/:id/update', (req, res) => {
  const db = load();
  const task = db.tasks.find((t) => t.id === Number(req.params.id));
  if (!task) return res.redirect(req.body.back || '/admin/tasks');
  const body = req.body;

  if (body.title !== undefined && body.title.trim()) task.title = body.title.trim();
  if (body.description !== undefined) task.description = body.description.trim();
  if (body.priority !== undefined && ['high', 'medium', 'low'].includes(body.priority)) task.priority = body.priority;
  if (body.startDate) task.startDate = body.startDate;
  if (body.dueDate) task.dueDate = body.dueDate;
  if (body.recurrence !== undefined && (body.recurrence === 'none' || T.RECUR_DAYS[body.recurrence])) task.recurrence = body.recurrence;

  if (body.assignedTo !== undefined && Number(body.assignedTo) !== task.assignedTo) {
    task.assignedTo = Number(body.assignedTo);
    const assignee = db.users.find((u) => u.id === task.assignedTo);
    logActivity(db, `<b>${T.escapeHtml(req.session.name)}</b> reassigned "${T.escapeHtml(task.title)}" to ${T.escapeHtml(assignee ? assignee.name : 'someone')}`);
  }

  save(db);
  res.redirect(T.reopenUrl(body.back, task.id));
});

router.post('/tasks/:id/delete', (req, res) => {
  const db = load();
  const task = db.tasks.find((t) => t.id === Number(req.params.id));
  if (task) {
    logActivity(db, `<b>${T.escapeHtml(req.session.name)}</b> deleted "${T.escapeHtml(task.title)}"`);
    db.tasks = db.tasks.filter((t) => t.id !== task.id);
    save(db);
  }
  res.redirect(req.body.back || '/admin/tasks');
});

// ---- Checklist / files / comments ----

router.post('/tasks/:id/checklist/add', (req, res) => {
  const db = load();
  const task = db.tasks.find((t) => t.id === Number(req.params.id));
  const text = (req.body.text || '').trim();
  if (task && text) { task.checklist.push({ text, done: false }); save(db); }
  res.redirect(T.reopenUrl(req.body.back, req.params.id));
});

router.post('/tasks/:id/checklist/:idx/toggle', (req, res) => {
  const db = load();
  const task = db.tasks.find((t) => t.id === Number(req.params.id));
  const item = task && task.checklist[Number(req.params.idx)];
  if (item) { item.done = !item.done; save(db); }
  res.redirect(T.reopenUrl(req.body.back, req.params.id));
});

router.post('/tasks/:id/checklist/:idx/remove', (req, res) => {
  const db = load();
  const task = db.tasks.find((t) => t.id === Number(req.params.id));
  if (task) { task.checklist.splice(Number(req.params.idx), 1); save(db); }
  res.redirect(T.reopenUrl(req.body.back, req.params.id));
});

router.post('/tasks/:id/files/add', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.redirect(T.reopenUrl(req.body.back, req.params.id));
    const db = load();
    const task = db.tasks.find((t) => t.id === Number(req.params.id));
    if (task && req.file) {
      task.files.push({ name: req.file.originalname, url: '/uploads/' + req.file.filename });
      save(db);
    }
    res.redirect(T.reopenUrl(req.body.back, req.params.id));
  });
});

router.post('/tasks/:id/comment', (req, res) => {
  const db = load();
  const task = db.tasks.find((t) => t.id === Number(req.params.id));
  const text = (req.body.text || '').trim();
  if (task && text) {
    task.comments.push({ name: req.session.name, time: new Date().toISOString(), text, feedback: false });
    save(db);
  }
  res.redirect(T.reopenUrl(req.body.back, req.params.id));
});

// ---- Review & approval ----

router.post('/tasks/:id/approve', (req, res) => {
  const db = load();
  const today = todayStr();
  const task = db.tasks.find((t) => t.id === Number(req.params.id));
  if (!task) return res.redirect(req.body.back || '/admin/review');

  task.status = 'completed';
  task.completedAt = new Date().toISOString();
  const spawned = T.spawnRecurrence(db, task, today);
  logActivity(db, `<b>${T.escapeHtml(req.session.name)}</b> approved "${T.escapeHtml(task.title)}"` + (spawned ? ' — next occurrence created' : ''));
  save(db);
  res.redirect(T.reopenUrl(req.body.back, task.id));
});

router.post('/tasks/:id/request-changes', (req, res) => {
  const db = load();
  const task = db.tasks.find((t) => t.id === Number(req.params.id));
  if (!task) return res.redirect(req.body.back || '/admin/review');

  const feedback = (req.body.feedback || '').trim();
  if (!feedback) return res.redirect(T.reopenUrl(req.body.back, task.id));

  task.status = 'changes';
  task.comments.push({ name: req.session.name, time: new Date().toISOString(), text: feedback, feedback: true });
  logActivity(db, `<b>${T.escapeHtml(req.session.name)}</b> requested changes on "${T.escapeHtml(task.title)}"`);
  save(db);
  res.redirect(T.reopenUrl(req.body.back, task.id));
});

// ---- Settings: Employee Management + Departments & Roles ----

function settingsRedirect(tab, error) {
  const params = new URLSearchParams();
  if (tab && tab !== 'employees') params.set('tab', tab);
  if (error) params.set('error', error);
  const qs = params.toString();
  return '/admin/settings' + (qs ? '?' + qs : '');
}

router.get('/settings', (req, res) => {
  const db = load();
  const tab = req.query.tab === 'departments' ? 'departments' : 'employees';
  const users = db.users.filter((u) => u.active);
  const departments = db.departments || [];

  res.render('admin-settings', {
    crumb: 'Settings', heading: 'Settings',
    tab, users, departments,
    userCount: users.length,
    deptCount: departments.length,
    badgeColors: BADGE_COLORS,
    error: req.query.error || null
  });
});

router.post('/settings/employees', (req, res) => {
  const { name, email, password, role, departmentId, roleTitle, color } = req.body;
  const db = load();
  const finalRole = role === 'admin' || role === 'viewer' ? role : 'employee';

  if (!name || !email || !password) {
    return res.redirect(settingsRedirect('employees', 'Full name, email, and password are required.'));
  }
  if (db.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
    return res.redirect(settingsRedirect('employees', 'Email already in use.'));
  }

  let department, finalRoleTitle, finalColor;
  if (finalRole === 'employee') {
    const dept = (db.departments || []).find((d) => d.id === departmentId);
    if (!dept) return res.redirect(settingsRedirect('employees', 'Please select a department.'));
    if (!roleTitle) return res.redirect(settingsRedirect('employees', 'Please select a role.'));
    department = dept.name;
    finalRoleTitle = roleTitle;
    finalColor = color || BADGE_COLORS[0];
  }

  db.users.push({
    id: db.nextId.users++,
    name, email,
    passwordHash: bcrypt.hashSync(password, 10),
    role: finalRole,
    department, roleTitle: finalRoleTitle, color: finalColor,
    active: true
  });
  logActivity(db, `<b>${T.escapeHtml(req.session.name)}</b> added ${T.escapeHtml(name)} to the team`);
  save(db);
  res.redirect('/admin/settings');
});

router.post('/settings/employees/:id/edit', (req, res) => {
  const { name, email, password, role, departmentId, roleTitle, color } = req.body;
  const db = load();
  const targetId = Number(req.params.id);
  const user = db.users.find((u) => u.id === targetId);

  if (!user) return res.redirect(settingsRedirect('employees', 'User not found.'));
  if (!name || !email) {
    return res.redirect(settingsRedirect('employees', 'Full name and email are required.'));
  }

  const finalRole = role === 'admin' || role === 'viewer' ? role : 'employee';
  if (db.users.some((u) => u.id !== targetId && u.email.toLowerCase() === email.toLowerCase())) {
    return res.redirect(settingsRedirect('employees', 'Email already in use.'));
  }
  if (user.role === 'admin' && finalRole !== 'admin') {
    const activeAdmins = db.users.filter((u) => u.role === 'admin' && u.active);
    if (activeAdmins.length <= 1) return res.redirect(settingsRedirect('employees', 'At least one admin must remain.'));
  }

  user.name = name;
  user.email = email;
  user.role = finalRole;
  if (finalRole === 'employee') {
    const dept = (db.departments || []).find((d) => d.id === departmentId);
    if (!dept) return res.redirect(settingsRedirect('employees', 'Please select a department.'));
    if (!roleTitle) return res.redirect(settingsRedirect('employees', 'Please select a role.'));
    user.department = dept.name;
    user.roleTitle = roleTitle;
    user.color = color || user.color || BADGE_COLORS[0];
  } else {
    user.department = undefined;
    user.roleTitle = undefined;
    user.color = undefined;
  }
  if (password) user.passwordHash = bcrypt.hashSync(password, 10);

  logActivity(db, `<b>${T.escapeHtml(req.session.name)}</b> updated ${T.escapeHtml(name)}'s profile`);
  save(db);
  res.redirect('/admin/settings');
});

router.post('/settings/employees/:id/delete', (req, res) => {
  const db = load();
  const targetId = Number(req.params.id);
  const user = db.users.find((u) => u.id === targetId);

  if (!user) return res.redirect('/admin/settings');
  if (targetId === req.session.userId) {
    return res.redirect(settingsRedirect('employees', 'You cannot remove your own account.'));
  }
  if (user.role === 'admin') {
    const activeAdmins = db.users.filter((u) => u.role === 'admin' && u.active);
    if (activeAdmins.length <= 1) return res.redirect(settingsRedirect('employees', 'At least one admin must remain.'));
  }
  const assignedCount = db.tasks.filter((t) => t.assignedTo === targetId).length;
  if (assignedCount > 0) {
    return res.redirect(settingsRedirect('employees', `Can't remove ${user.name} — they have ${assignedCount} task(s) assigned. Reassign those first.`));
  }

  user.active = false;
  logActivity(db, `<b>${T.escapeHtml(req.session.name)}</b> removed ${T.escapeHtml(user.name)} from the team`);
  save(db);
  res.redirect('/admin/settings');
});

router.post('/settings/departments', (req, res) => {
  const name = (req.body.name || '').trim();
  const db = load();
  db.departments = db.departments || [];

  if (!name) return res.redirect(settingsRedirect('departments', 'Department name is required.'));
  if (db.departments.some((d) => d.name.toLowerCase() === name.toLowerCase())) {
    return res.redirect(settingsRedirect('departments', 'That department already exists.'));
  }

  db.departments.push({ id: uniqueSlug(name, db.departments), name, roles: [] });
  logActivity(db, `<b>${T.escapeHtml(req.session.name)}</b> added department ${T.escapeHtml(name)}`);
  save(db);
  res.redirect(settingsRedirect('departments'));
});

router.post('/settings/departments/:id/delete', (req, res) => {
  const db = load();
  db.departments = db.departments || [];
  const dept = db.departments.find((d) => d.id === req.params.id);
  if (!dept) return res.redirect(settingsRedirect('departments'));

  const assignedCount = db.users.filter((u) => u.role === 'employee' && u.active && u.department === dept.name).length;
  if (assignedCount > 0) {
    return res.redirect(settingsRedirect('departments', `Can't remove ${dept.name} — ${assignedCount} employee(s) are in this department.`));
  }
  if (db.departments.length <= 1) {
    return res.redirect(settingsRedirect('departments', 'At least one department must remain.'));
  }

  db.departments = db.departments.filter((d) => d.id !== dept.id);
  logActivity(db, `<b>${T.escapeHtml(req.session.name)}</b> removed department ${T.escapeHtml(dept.name)}`);
  save(db);
  res.redirect(settingsRedirect('departments'));
});

router.post('/settings/departments/:id/roles/add', (req, res) => {
  const db = load();
  db.departments = db.departments || [];
  const dept = db.departments.find((d) => d.id === req.params.id);
  const value = (req.body.role || '').trim();
  if (!dept || !value) return res.redirect(settingsRedirect('departments'));

  if (dept.roles.some((r) => r.toLowerCase() === value.toLowerCase())) {
    return res.redirect(settingsRedirect('departments', `"${value}" already exists in ${dept.name}.`));
  }
  dept.roles.push(value);
  save(db);
  res.redirect(settingsRedirect('departments'));
});

router.post('/settings/departments/:id/roles/:idx/remove', (req, res) => {
  const db = load();
  db.departments = db.departments || [];
  const dept = db.departments.find((d) => d.id === req.params.id);
  if (!dept) return res.redirect(settingsRedirect('departments'));

  const roleName = dept.roles[Number(req.params.idx)];
  const inUse = db.users.some((u) => u.role === 'employee' && u.active && u.department === dept.name && u.roleTitle === roleName);
  if (inUse) {
    return res.redirect(settingsRedirect('departments', `Can't remove "${roleName}" — an employee has this role.`));
  }
  dept.roles.splice(Number(req.params.idx), 1);
  save(db);
  res.redirect(settingsRedirect('departments'));
});

module.exports = router;
