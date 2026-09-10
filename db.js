const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { addDays } = require('./utils');

const DB_FILE = path.join(__dirname, 'db.json');
const SCHEMA_VERSION = 3;
const BADGE_COLORS = ['var(--info)', 'var(--purple)', 'var(--success)', 'var(--warning)', 'var(--primary)', 'var(--danger)'];

function emptyDb() {
  return {
    schemaVersion: SCHEMA_VERSION,
    users: [],
    tasks: [],
    departments: [],
    activity: [],
    nextId: { users: 1, tasks: 1 }
  };
}

function slugify(name) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'dept';
  return base;
}

function uniqueSlug(name, departments) {
  const base = slugify(name);
  let slug = base;
  let n = 1;
  while (departments.some((d) => d.id === slug)) {
    n++;
    slug = `${base}-${n}`;
  }
  return slug;
}

// Today's date as YYYY-MM-DD in server local time
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Upgrades tasks created under the old daily-checklist model (no `status` field)
// into the new workflow-task shape, and drops the retired taskLogs table.
// Runs once, guarded by schemaVersion, so it's safe to call on every load().
function migrate(db) {
  if (db.schemaVersion >= SCHEMA_VERSION) return false;

  const today = todayStr();
  const defaultDue = addDays(today, 7);

  db.tasks = (db.tasks || [])
    // old model soft-deleted tasks via active:false — drop those, they were already "removed"
    .filter((t) => t.status || t.active !== false)
    .map((t) => {
      if (t.status) return t;
      const description = t.detail
        ? `${t.description || ''}${t.description ? '\n\n' : ''}${t.detail}`.trim()
        : (t.description || '');
      return {
        id: t.id,
        title: t.title,
        description,
        assignedTo: t.assignedTo,
        assignedByName: 'Admin',
        priority: 'medium',
        status: 'todo',
        recurrence: 'none',
        startDate: today,
        dueDate: defaultDue,
        checklist: [],
        files: [],
        comments: [],
        blocked: false,
        blockedReason: '',
        createdAt: t.createdAt || new Date().toISOString(),
        completedAt: null
      };
    });

  delete db.taskLogs;
  if (db.nextId) delete db.nextId.taskLogs;
  db.activity = db.activity || [];

  // v3: introduce a structured Departments & Roles list, seeded from whatever free-text
  // `department` strings employees already had, plus per-employee roleTitle/color fields.
  if (!db.departments) {
    db.departments = [];
    const seen = new Map();
    db.users.forEach((u) => {
      if (u.role !== 'employee' || !u.department) return;
      if (!seen.has(u.department)) {
        seen.set(u.department, { id: uniqueSlug(u.department, db.departments), name: u.department, roles: [] });
        db.departments.push(seen.get(u.department));
      }
    });
  }
  let colorIdx = 0;
  db.users.forEach((u) => {
    if (u.role !== 'employee') return;
    if (u.roleTitle === undefined) u.roleTitle = '';
    if (!u.color) u.color = BADGE_COLORS[colorIdx % BADGE_COLORS.length];
    colorIdx++;
  });

  db.schemaVersion = SCHEMA_VERSION;
  return true;
}

function load() {
  if (!fs.existsSync(DB_FILE)) {
    const fresh = emptyDb();
    save(fresh);
    return fresh;
  }
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  const db = raw.trim() ? JSON.parse(raw) : emptyDb();
  if (!db.schemaVersion) db.schemaVersion = 1;
  if (migrate(db)) save(db);
  return db;
}

function save(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Adds an activity-feed entry (newest first), capped to the most recent 50.
function logActivity(db, text) {
  db.activity = db.activity || [];
  db.activity.unshift({ text, time: new Date().toISOString() });
  if (db.activity.length > 50) db.activity.length = 50;
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

module.exports = { load, save, todayStr, logActivity, seedAdminIfNeeded, uniqueSlug, BADGE_COLORS };
