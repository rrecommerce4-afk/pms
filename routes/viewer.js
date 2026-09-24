const express = require('express');
const { load, todayStr } = require('../db');
const { requireViewer } = require('../middleware/auth');
const T = require('../lib/tasks');

const router = express.Router();
router.use(requireViewer);

router.get('/dashboard', (req, res) => {
  const db = load();
  const today = todayStr();
  const employees = db.users.filter((u) => u.role === 'employee' && u.active);
  const decorated = T.decorateAll(db.tasks, db.users, today);

  const filters = {
    q: (req.query.q || '').trim(),
    due: req.query.due || 'all',
    employee: req.query.employee || 'all'
  };
  const filtered = T.filterTasks(decorated, filters, today);

  const params = new URLSearchParams();
  ['q', 'due', 'employee'].forEach((k) => { if (req.query[k]) params.set(k, req.query[k]); });
  const qs = params.toString();
  const pageUrl = req.baseUrl + req.path + (qs ? '?' + qs : '');

  const taskId = req.query.task ? Number(req.query.task) : null;
  const rawTask = taskId ? db.tasks.find((t) => t.id === taskId) : null;

  res.render('viewer-dashboard', {
    crumb: 'Dashboard',
    heading: 'Overview',
    subheading: 'Read-only view of every task across the team.',
    filters, pageUrl, employees,
    summary: T.summaryCards(decorated, employees.length),
    filtered,
    workload: T.workloadData(decorated, employees),
    detailTask: rawTask ? T.decorate(rawTask, db.users, today) : null,
    showSearch: true, showFilters: true, searchPlaceholder: 'Search tasks...'
  });
});

// Month grid of employees x days: red dot = missed a task that day, green = finished everything.
router.get('/tracker', (req, res) => {
  const db = load();
  const today = todayStr();
  const employees = db.users.filter((u) => u.role === 'employee' && u.active);

  res.render('viewer-tracker', {
    crumb: 'Task Tracker', heading: 'Task Tracker',
    tracker: T.buildTrackerGrid(db.tasks, employees, req.query.month, today, db.holidays || []),
    todayIsoMonth: today.slice(0, 7)
  });
});

module.exports = router;
