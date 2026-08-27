const express = require('express');
const { load } = require('../db');
const { requireViewer } = require('../middleware/auth');

const router = express.Router();
router.use(requireViewer);

function pad2(n) {
  return String(n).padStart(2, '0');
}

router.get('/dashboard', (req, res) => {
  const db = load();
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const lastElapsedDay = now.getDate() - 1; // exclude today - its day isn't over yet

  const days = [];
  for (let d = 1; d <= lastElapsedDay; d++) days.push(d);

  const employees = db.users.filter((u) => u.role === 'employee' && u.active);

  const rows = employees.map((emp) => {
    const empTasks = db.tasks.filter((t) => t.assignedTo === emp.id);
    const cells = days.map((d) => {
      const dateStr = `${year}-${pad2(month + 1)}-${pad2(d)}`;
      const logsForDay = empTasks
        .map((t) => db.taskLogs.find((l) => l.taskId === t.id && l.date === dateStr))
        .filter(Boolean);
      let status = 'none';
      if (logsForDay.length > 0) {
        status = logsForDay.every((l) => l.status === 'completed') ? 'green' : 'red';
      }
      return { day: d, status };
    });
    return { id: emp.id, name: emp.name, department: emp.department || 'Team Member', cells };
  });

  const monthLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  res.render('viewer-dashboard', {
    crumb: 'Dashboard',
    heading: 'Monthly Overview',
    subheading: `Daily task completion for every employee, ${monthLabel} (through yesterday).`,
    monthLabel,
    days,
    rows
  });
});

module.exports = router;
