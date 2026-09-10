const express = require('express');
const { load, save, todayStr, logActivity } = require('../db');
const { requireEmployee } = require('../middleware/auth');
const { greetingWord, firstName } = require('../utils');
const T = require('../lib/tasks');

const router = express.Router();
router.use(requireEmployee);

function pageUrl(req) {
  const params = new URLSearchParams();
  ['q', 'view'].forEach((k) => { if (req.query[k]) params.set(k, req.query[k]); });
  const qs = params.toString();
  return req.baseUrl + req.path + (qs ? '?' + qs : '');
}

function loadCommon(req) {
  const db = load();
  const today = todayStr();
  const mine = db.tasks.filter((t) => t.assignedTo === req.session.userId);
  const decorated = T.decorateAll(mine, db.users, today);
  return { db, today, decorated };
}

function openTask(req, db, today) {
  const id = req.query.task ? Number(req.query.task) : null;
  if (!id) return null;
  const t = db.tasks.find((x) => x.id === id && x.assignedTo === req.session.userId);
  return t ? T.decorate(t, db.users, today) : null;
}

function myTask(db, id, userId) {
  const t = db.tasks.find((x) => x.id === Number(id));
  return t && t.assignedTo === userId ? t : null;
}

router.use((req, res, next) => {
  const db = load();
  res.locals.navCounts = { myTasks: db.tasks.filter((t) => t.assignedTo === req.session.userId).length };
  next();
});

router.get('/dashboard', (req, res) => {
  const { db, today, decorated } = loadCommon(req);
  const q = (req.query.q || '').trim();
  const filters = { q, view: req.query.view === 'kanban' ? 'kanban' : 'list' };
  const taskListTasks = T.filterTasks(decorated, { q }, today);

  res.render('employee-dashboard', {
    crumb: 'Dashboard',
    heading: `${greetingWord()}, ${firstName(req.session.name)}`,
    filters, pageUrl: pageUrl(req),
    summary: T.employeeSummaryCards(decorated),
    focus: decorated.filter((t) => t.status === 'todo' || t.status === 'changes' || t.priority === 'high').slice(0, 4),
    groups: T.groupByRecurrence(taskListTasks),
    taskListTasks,
    reviewUpdates: decorated.filter((t) => t.status === 'changes' || t.status === 'completed').slice(0, 4),
    upcoming: decorated.filter((t) => t.status === 'todo').slice(0, 4),
    detailTask: openTask(req, db, today),
    showSearch: true, searchPlaceholder: 'Search my tasks...'
  });
});

router.get('/tasks', (req, res) => {
  const { db, today, decorated } = loadCommon(req);
  const filters = { q: (req.query.q || '').trim(), view: req.query.view === 'kanban' ? 'kanban' : 'list' };
  const filtered = T.filterTasks(decorated, { q: filters.q }, today);

  res.render('employee-tasks', {
    crumb: 'My Tasks', heading: 'My Tasks',
    filters, pageUrl: pageUrl(req), filtered,
    groups: T.groupByRecurrence(filtered),
    detailTask: openTask(req, db, today),
    showSearch: true, searchPlaceholder: 'Search my tasks...'
  });
});

router.get('/submitted', (req, res) => {
  const { db, today, decorated } = loadCommon(req);
  res.render('employee-submitted', {
    crumb: 'Submitted for Review', heading: 'Submitted for Review',
    filtered: decorated.filter((t) => t.status === 'review'),
    pageUrl: pageUrl(req), detailTask: openTask(req, db, today)
  });
});

router.get('/completed', (req, res) => {
  const { db, today, decorated } = loadCommon(req);
  res.render('employee-completed', {
    crumb: 'Completed Tasks', heading: 'Completed Tasks',
    filtered: decorated.filter((t) => t.status === 'completed'),
    pageUrl: pageUrl(req), detailTask: openTask(req, db, today)
  });
});

// ---- Task status actions ----

router.post('/tasks/:id/start', (req, res) => {
  const db = load();
  const task = myTask(db, req.params.id, req.session.userId);
  if (task && task.status === 'todo') {
    task.status = 'progress';
    logActivity(db, `<b>${T.escapeHtml(req.session.name)}</b> started "${T.escapeHtml(task.title)}"`);
    save(db);
  }
  res.redirect(T.reopenUrl(req.body.back, req.params.id));
});

router.post('/tasks/:id/submit-review', (req, res) => {
  const db = load();
  const task = myTask(db, req.params.id, req.session.userId);
  if (task && (task.status === 'progress' || task.status === 'changes')) {
    task.status = 'review';
    logActivity(db, `<b>${T.escapeHtml(req.session.name)}</b> submitted "${T.escapeHtml(task.title)}" for review`);
    save(db);
  }
  res.redirect(T.reopenUrl(req.body.back, req.params.id));
});

router.post('/tasks/:id/complete-direct', (req, res) => {
  const db = load();
  const today = todayStr();
  const task = myTask(db, req.params.id, req.session.userId);
  if (task && task.status === 'progress' && T.isReviewFreeRecurring(task)) {
    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    const spawned = T.spawnRecurrence(db, task, today);
    logActivity(db, `<b>${T.escapeHtml(req.session.name)}</b> completed "${T.escapeHtml(task.title)}" (no review needed)` + (spawned ? ' — next occurrence created' : ''));
    save(db);
  }
  res.redirect(T.reopenUrl(req.body.back, req.params.id));
});

router.post('/tasks/:id/block', (req, res) => {
  const db = load();
  const task = myTask(db, req.params.id, req.session.userId);
  const reason = (req.body.reason || '').trim();
  if (task && reason && ['todo', 'progress', 'changes'].indexOf(task.status) !== -1) {
    task.status = 'blocked';
    task.blocked = true;
    task.blockedReason = reason;
    logActivity(db, `<b>${T.escapeHtml(req.session.name)}</b> marked "${T.escapeHtml(task.title)}" as Blocked`);
    save(db);
  }
  res.redirect(T.reopenUrl(req.body.back, req.params.id));
});

router.post('/tasks/:id/unblock', (req, res) => {
  const db = load();
  const task = myTask(db, req.params.id, req.session.userId);
  if (task && task.status === 'blocked') {
    task.status = 'progress';
    task.blocked = false;
    save(db);
  }
  res.redirect(T.reopenUrl(req.body.back, req.params.id));
});

// ---- Checklist / comments (employee can't remove checklist items — admin only) ----

router.post('/tasks/:id/checklist/add', (req, res) => {
  const db = load();
  const task = myTask(db, req.params.id, req.session.userId);
  const text = (req.body.text || '').trim();
  if (task && text) { task.checklist.push({ text, done: false }); save(db); }
  res.redirect(T.reopenUrl(req.body.back, req.params.id));
});

router.post('/tasks/:id/checklist/:idx/toggle', (req, res) => {
  const db = load();
  const task = myTask(db, req.params.id, req.session.userId);
  const item = task && task.checklist[Number(req.params.idx)];
  if (item) { item.done = !item.done; save(db); }
  res.redirect(T.reopenUrl(req.body.back, req.params.id));
});

router.post('/tasks/:id/comment', (req, res) => {
  const db = load();
  const task = myTask(db, req.params.id, req.session.userId);
  const text = (req.body.text || '').trim();
  if (task && text) {
    task.comments.push({ name: req.session.name, time: new Date().toISOString(), text, feedback: false });
    save(db);
  }
  res.redirect(T.reopenUrl(req.body.back, req.params.id));
});

module.exports = router;
