const express = require('express');
const { load, save, todayStr, ensureTodayLogs, getMissedCount } = require('../db');
const { requireEmployee } = require('../middleware/auth');
const { greetingWord, firstName, listDateStr } = require('../utils');

const router = express.Router();

function getMyRows(db, userId, today) {
  const myTasks = db.tasks.filter((t) => t.assignedTo === userId && t.active);
  return myTasks
    .map((task) => {
      const log = db.taskLogs.find((l) => l.taskId === task.id && l.date === today);
      return { task, log };
    })
    .filter((r) => r.log);
}

router.get('/dashboard', requireEmployee, (req, res) => {
  ensureTodayLogs();
  const db = load();
  const today = todayStr();
  const rows = getMyRows(db, req.session.userId, today);

  const total = rows.length;
  const completed = rows.filter((r) => r.log.status === 'completed').length;
  const pending = total - completed;
  const missedCount = getMissedCount(db, req.session.userId, today);
  const pct = total ? Math.round((completed / total) * 100) : 0;
  const quickRows = rows.slice(0, 5);

  res.render('employee-dashboard', {
    name: req.session.name,
    crumb: 'Dashboard',
    heading: `${greetingWord()}, ${firstName(req.session.name)}`,
    subheading: 'Yeh raha aapke tasks ka aaj ka overview.',
    today,
    total,
    completed,
    pending,
    missedCount,
    pct,
    quickRows,
    hasMore: rows.length > quickRows.length
  });
});

router.get('/tasks', requireEmployee, (req, res) => {
  ensureTodayLogs();
  const db = load();
  const today = todayStr();
  const rows = getMyRows(db, req.session.userId, today);

  const total = rows.length;
  const completed = rows.filter((r) => r.log.status === 'completed').length;
  const pending = total - completed;
  const missedCount = getMissedCount(db, req.session.userId, today);

  res.render('employee-tasks', {
    name: req.session.name,
    crumb: 'Tasks',
    heading: "Today's Tasks",
    subheading: 'Aaj ke assigned tasks aur unka current status.',
    listDate: listDateStr(),
    today,
    rows,
    total,
    completed,
    pending,
    missedCount
  });
});

router.post('/tasks/:logId/toggle', requireEmployee, (req, res) => {
  const db = load();
  const log = db.taskLogs.find((l) => l.id === Number(req.params.logId));

  if (log) {
    const task = db.tasks.find((t) => t.id === log.taskId);
    if (task && task.assignedTo === req.session.userId) {
      if (log.status === 'completed') {
        log.status = 'pending';
        log.completedAt = null;
      } else {
        log.status = 'completed';
        log.completedAt = new Date().toISOString();
      }
      save(db);
    }
  }

  res.redirect('/employee/tasks');
});

module.exports = router;
