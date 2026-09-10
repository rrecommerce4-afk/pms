const { addDays, daysBetween, formatIsoDate } = require('../utils');

const STATUSES = ['todo', 'progress', 'review', 'changes', 'blocked', 'completed'];
const STEP_STATUSES = ['todo', 'progress', 'review', 'completed'];

const STATUS_META = {
  todo: { label: 'To Do', pill: 's-todo' },
  progress: { label: 'In Progress', pill: 's-progress' },
  review: { label: 'In Review', pill: 's-review' },
  changes: { label: 'Changes Requested', pill: 's-changes' },
  blocked: { label: 'Blocked', pill: 's-blocked' },
  completed: { label: 'Completed', pill: 's-completed' }
};

const RECUR_META = { none: null, daily: 'Daily', weekly: 'Weekly', biweekly: 'Every 15 days', monthly: 'Monthly' };
const RECUR_DAYS = { daily: 1, weekly: 7, biweekly: 15, monthly: 30 };
const RECUR_GROUPS = [
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'biweekly', label: 'Every 15 Days' },
  { key: 'monthly', label: 'Monthly' },
  { key: 'none', label: 'One-time Tasks' }
];

function statusLabel(s) { return (STATUS_META[s] || {}).label || s; }
function statusPillClass(s) { return (STATUS_META[s] || {}).pill || ''; }
function priorityLabel(p) { return p ? p.charAt(0).toUpperCase() + p.slice(1) : ''; }
function recurLabel(r) { return RECUR_META[r] || null; }
function isReviewFreeRecurring(t) { return t.recurrence === 'daily'; }

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return parts.map((w) => w[0].toUpperCase()).slice(0, 2).join('') || '??';
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function isOverdue(t, today) {
  return t.status !== 'completed' && !!t.dueDate && t.dueDate < today;
}
function overdueDays(t, today) {
  if (!isOverdue(t, today)) return 0;
  return daysBetween(t.dueDate, today);
}

function employeeById(users, id) {
  return users.find((u) => u.id === id) || null;
}

// Attaches derived, render-ready fields (assignee info, status/priority text, overdue state) to a task.
function decorate(task, users, today) {
  const assignee = employeeById(users, task.assignedTo);
  return Object.assign({}, task, {
    comments: (task.comments || []).map((c) => Object.assign({}, c, { timeLabel: formatRelativeTime(c.time) })),
    assigneeName: assignee ? assignee.name : 'Unassigned',
    assigneeDept: assignee ? (assignee.department || 'Team Member') : '',
    assigneeInitials: assignee ? initials(assignee.name) : '??',
    overdue: isOverdue(task, today),
    overdueDaysCount: overdueDays(task, today),
    statusLabel: statusLabel(task.status),
    statusPill: statusPillClass(task.status),
    priorityText: priorityLabel(task.priority),
    recurText: recurLabel(task.recurrence),
    dueLabel: task.dueDate ? formatIsoDate(task.dueDate) : '—',
    startLabel: task.startDate ? formatIsoDate(task.startDate) : '—'
  });
}

function decorateAll(tasks, users, today) {
  return tasks.map((t) => decorate(t, users, today));
}

function matchesSearch(t, term) {
  if (!term) return true;
  const q = term.toLowerCase();
  return t.title.toLowerCase().indexOf(q) !== -1 ||
    String(t.id).indexOf(q) !== -1 ||
    (t.assigneeName || '').toLowerCase().indexOf(q) !== -1;
}

function matchesDueFilter(t, filter, today) {
  if (filter === 'overdue') return t.overdue;
  if (filter === 'today') return t.dueDate === today;
  if (filter === 'week') return !!t.dueDate && t.dueDate >= today && t.dueDate <= addDays(today, 7);
  return true;
}

// Filters an already-decorated task list by free-text search, a due-date bucket, and/or assignee.
function filterTasks(decoratedTasks, opts, today) {
  const o = opts || {};
  return decoratedTasks.filter((t) => {
    if (!matchesSearch(t, o.q)) return false;
    if (o.due && o.due !== 'all' && !matchesDueFilter(t, o.due, today)) return false;
    if (o.employee && o.employee !== 'all' && String(t.assignedTo) !== String(o.employee)) return false;
    return true;
  });
}

// Buckets decorated tasks into Daily / Weekly / Every 15 Days / Monthly / One-time groups (non-empty only).
function groupByRecurrence(decoratedTasks) {
  const buckets = {};
  decoratedTasks.forEach((t) => {
    const key = RECUR_META[t.recurrence] ? t.recurrence : 'none';
    (buckets[key] = buckets[key] || []).push(t);
  });
  return RECUR_GROUPS.map((g) => Object.assign({}, g, { tasks: buckets[g.key] || [] })).filter((g) => g.tasks.length);
}

function groupByStatus(decoratedTasks) {
  const buckets = {};
  STATUSES.forEach((s) => { buckets[s] = []; });
  decoratedTasks.forEach((t) => { (buckets[t.status] = buckets[t.status] || []).push(t); });
  return STATUSES.map((s) => ({ key: s, label: statusLabel(s), tasks: buckets[s] || [] }));
}

function summaryCards(decoratedTasks, employeeCount) {
  return {
    total: decoratedTasks.length,
    inProgress: decoratedTasks.filter((t) => t.status === 'progress').length,
    pendingReview: decoratedTasks.filter((t) => t.status === 'review').length,
    overdue: decoratedTasks.filter((t) => t.overdue).length,
    completed: decoratedTasks.filter((t) => t.status === 'completed').length,
    employeeCount: employeeCount
  };
}

function employeeSummaryCards(decoratedTasks) {
  return {
    total: decoratedTasks.length,
    inProgress: decoratedTasks.filter((t) => t.status === 'progress').length,
    changes: decoratedTasks.filter((t) => t.status === 'changes').length,
    overdue: decoratedTasks.filter((t) => t.overdue).length,
    completed: decoratedTasks.filter((t) => t.status === 'completed').length
  };
}

function workloadData(decoratedTasks, employees) {
  const rows = employees.map((e) => {
    const mine = decoratedTasks.filter((t) => t.assignedTo === e.id);
    return {
      employee: e,
      active: mine.filter((t) => t.status !== 'completed').length,
      overdue: mine.filter((t) => t.overdue).length,
      completed: mine.filter((t) => t.status === 'completed').length
    };
  });
  const maxActive = Math.max(1, ...rows.map((r) => r.active));
  rows.forEach((r) => { r.pct = Math.round((r.active / maxActive) * 100); });
  return rows;
}

function reportsData(decoratedTasks, employees) {
  const total = decoratedTasks.length || 1;
  const byStatus = groupByStatus(decoratedTasks).map((g) => ({
    label: g.label, key: g.key, count: g.tasks.length, pct: Math.round((g.tasks.length / total) * 100)
  }));

  const wl = workloadData(decoratedTasks, employees);
  const maxCompleted = Math.max(1, ...wl.map((r) => r.completed));
  const completedByEmployee = wl.map((r) => ({
    label: r.employee.name, count: r.completed, pct: Math.round((r.completed / maxCompleted) * 100)
  }));
  const activeByEmployee = wl.map((r) => ({
    label: r.employee.name, count: r.active, pct: Math.min(100, Math.round((r.active / total) * 200))
  }));

  const completedCount = decoratedTasks.filter((t) => t.status === 'completed').length;
  const overdueCount = decoratedTasks.filter((t) => t.overdue).length;

  return {
    byStatus,
    completedByEmployee,
    activeByEmployee,
    completedCount,
    completedPct: Math.round((completedCount / total) * 100),
    overdueCount,
    overduePct: Math.round((overdueCount / total) * 100)
  };
}

function computeNextDueDate(dueDate, recurrence) {
  const days = RECUR_DAYS[recurrence] || 1;
  return addDays(dueDate, days);
}

// Marks a task completed; if it recurs, immediately creates the next occurrence
// (fresh To Do, unchecked checklist, no comments/blocked state). Returns the new task, or null.
function spawnRecurrence(db, task, today) {
  if (!task.recurrence || task.recurrence === 'none') return null;
  const newTask = {
    id: db.nextId.tasks++,
    title: task.title,
    description: task.description,
    assignedTo: task.assignedTo,
    assignedByName: task.assignedByName,
    priority: task.priority,
    status: 'todo',
    recurrence: task.recurrence,
    startDate: today,
    dueDate: computeNextDueDate(task.dueDate, task.recurrence),
    checklist: task.checklist.map((c) => ({ text: c.text, done: false })),
    files: task.files.slice(),
    comments: [],
    blocked: false,
    blockedReason: '',
    createdAt: new Date().toISOString(),
    completedAt: null
  };
  db.tasks.push(newTask);
  return newTask;
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  const diffMs = Date.now() - then.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return mins + ' minute' + (mins === 1 ? '' : 's') + ' ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + ' hour' + (hours === 1 ? '' : 's') + ' ago';
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday, ' + then.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (days < 7) return days + ' days ago';
  return then.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Adds (or replaces) the `task=<id>` query param on a "back" URL (path + querystring, no task param).
function reopenUrl(backUrl, taskId) {
  const base = backUrl || '';
  return base + (base.indexOf('?') !== -1 ? '&' : '?') + 'task=' + taskId;
}

module.exports = {
  STATUSES, STEP_STATUSES, STATUS_META, RECUR_META, RECUR_DAYS, RECUR_GROUPS,
  statusLabel, statusPillClass, priorityLabel, recurLabel, isReviewFreeRecurring,
  initials, escapeHtml, isOverdue, overdueDays, employeeById,
  decorate, decorateAll, filterTasks, groupByRecurrence, groupByStatus,
  summaryCards, employeeSummaryCards, workloadData, reportsData,
  computeNextDueDate, spawnRecurrence, formatRelativeTime, reopenUrl
};
