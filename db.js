const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_FILE = path.join(__dirname, 'db.json');

function emptyDb() {
  return {
    users: [],
    tasks: [],
    taskLogs: [],
    nextId: { users: 1, tasks: 1, taskLogs: 1 }
  };
}

function load() {
  if (!fs.existsSync(DB_FILE)) {
    const fresh = emptyDb();
    save(fresh);
    return fresh;
  }
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  if (!raw.trim()) return emptyDb();
  return JSON.parse(raw);
}

function save(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Today's date as YYYY-MM-DD in server local time
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Create a pending log for today for every active task that doesn't have one yet.
// Called on server start, at midnight via cron, and lazily on dashboard loads
// so tasks are always "reset" to pending for the current day.
function ensureTodayLogs() {
  const db = load();
  const today = todayStr();
  const activeTasks = db.tasks.filter((t) => t.active);
  let changed = false;

  for (const task of activeTasks) {
    const hasLogToday = db.taskLogs.some((l) => l.taskId === task.id && l.date === today);
    if (!hasLogToday) {
      db.taskLogs.push({
        id: db.nextId.taskLogs++,
        taskId: task.id,
        date: today,
        status: 'pending',
        completedAt: null
      });
      changed = true;
    }
  }

  if (changed) save(db);
  return db;
}

// Lifetime count of tasks a user left "pending" once their day rolled over
// (i.e. never marked complete before the midnight reset). Past days' logs are
// never modified after the day ends, so this is a permanent running total.
function getMissedCount(db, userId, today) {
  return db.taskLogs.filter((l) => {
    if (l.date >= today || l.status !== 'pending') return false;
    const task = db.tasks.find((t) => t.id === l.taskId);
    return task && task.assignedTo === userId;
  }).length;
}

// The actual list behind getMissedCount: every past-day task log still stuck at
// "pending" once its day ended. Pass userId to filter to one employee, or leave
// it null for every employee. Sorted most-recently-missed first.
function getMissedTasks(db, today, userId) {
  return db.taskLogs
    .filter((l) => l.date < today && l.status === 'pending')
    .map((l) => {
      const task = db.tasks.find((t) => t.id === l.taskId);
      if (!task) return null;
      if (userId && task.assignedTo !== userId) return null;
      const employee = db.users.find((u) => u.id === task.assignedTo);
      if (!employee) return null;
      return { log: l, task, employee };
    })
    .filter(Boolean)
    .sort((a, b) => (a.log.date < b.log.date ? 1 : -1));
}

// Wipes out the missed-task backlog: deletes every past-day "pending" log so it
// stops counting toward getMissedCount/getMissedTasks and the calendar dot for
// that day goes back to "none" instead of red. Pass userId to clear just one
// employee's backlog, or leave it null to clear everyone's. Returns how many
// logs were removed.
function clearMissedTasks(db, today, userId) {
  const before = db.taskLogs.length;
  db.taskLogs = db.taskLogs.filter((l) => {
    if (l.date >= today || l.status !== 'pending') return true;
    if (!userId) return false;
    const task = db.tasks.find((t) => t.id === l.taskId);
    return !(task && task.assignedTo === userId);
  });
  save(db);
  return before - db.taskLogs.length;
}

function seedAdminIfNeeded() {
  const db = load();
  if (db.users.length === 0) {
    db.users.push({
      id: db.nextId.users++,
      name: 'Admin',
      email: 'admin@pms.com',
      passwordHash: bcrypt.hashSync('admin123', 10),
      role: 'admin',
      active: true
    });
    save(db);
    console.log('Created default admin account -> email: admin@pms.com  password: admin123');
    console.log('Please log in and change this password setup as needed.');
  }
}

module.exports = { load, save, todayStr, ensureTodayLogs, getMissedCount, getMissedTasks, clearMissedTasks, seedAdminIfNeeded };
