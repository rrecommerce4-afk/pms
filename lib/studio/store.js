// Social Media Studio persistence helpers. All Studio data lives under db.socialStudio,
// separate from the general PMS tasks, and is read/written through db.js load()/save().
const C = require('./config');
const Sched = require('./schedule');

const STUDIO_VERSION = 1;

function emptyStudio() {
  return {
    version: STUDIO_VERSION,
    // Roster slot -> existing PMS user id (null until an admin links it). Never creates users.
    members: C.ROSTER.map((r) => ({ key: r.key, userId: null, linkedAt: null, linkedBy: null })),
    settings: sanitizeSettings(null),
    reels: [],
    nextReelId: 1,
    readNotifications: {},
    scheduleHistory: []
  };
}

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const clampInt = (v, min, max, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : dflt;
};

// Merge a possibly partial/invalid settings object onto `base` (the defaults unless given;
// ported from the Studio's sanitizeSettings). Unknown keys are dropped and invalid or
// out-of-range values keep the base value.
function sanitizeSettings(raw, base) {
  const s = isObj(raw) ? raw : {};
  const out = base ? sanitizeSettings(base) : C.defaultSettings();
  if (isObj(s.targets)) C.PAGE_IDS.forEach((p) => { out.targets[p] = clampInt(s.targets[p], 0, 200, out.targets[p]); });
  if (isObj(s.pageTeams)) {
    C.PAGE_IDS.forEach((p) => {
      const team = s.pageTeams[p];
      if (Array.isArray(team)) {
        const clean = [...new Set(team.filter((k) => C.ROSTER_KEYS.includes(k)))];
        if (clean.length) out.pageTeams[p] = clean;
      }
    });
  }
  if (isObj(s.deadlines)) Object.keys(out.deadlines).forEach((k) => { out.deadlines[k] = clampInt(s.deadlines[k], 0, 30, out.deadlines[k]); });
  if (Array.isArray(s.priorities) && s.priorities.length === 4) {
    out.priorities = out.priorities.map((def, i) => {
      const r = s.priorities[i];
      if (!isObj(r)) return def;
      return {
        priority: def.priority,
        description: typeof r.description === 'string' ? r.description.slice(0, 300) : def.description,
        slaHours: clampInt(r.slaHours, 1, 720, def.slaHours)
      };
    });
  }
  if (isObj(s.weights)) Object.keys(out.weights).forEach((k) => { out.weights[k] = clampInt(s.weights[k], 0, 100, out.weights[k]); });
  if (isObj(s.ranking)) {
    out.ranking.minDueTasks = clampInt(s.ranking.minDueTasks, 0, 50, out.ranking.minDueTasks);
    out.ranking.provisionalBelow = clampInt(s.ranking.provisionalBelow, 0, 100, out.ranking.provisionalBelow);
    if (out.ranking.provisionalBelow < out.ranking.minDueTasks) out.ranking.provisionalBelow = out.ranking.minDueTasks;
  }
  if (isObj(s.notifications)) Object.keys(out.notifications).forEach((k) => { if (typeof s.notifications[k] === 'boolean') out.notifications[k] = s.notifications[k]; });
  if (isObj(s.display)) {
    if (s.display.weekStartsOn === 0 || s.display.weekStartsOn === 1) out.display.weekStartsOn = s.display.weekStartsOn;
    if (['month', 'week', 'day'].includes(s.display.defaultCalendarView)) out.display.defaultCalendarView = s.display.defaultCalendarView;
  }
  if (['conservative', 'baseline', 'optimistic'].includes(s.followerScenario)) out.followerScenario = s.followerScenario;
  // Studio visible to team members/viewers? Off (admins only) until an admin turns it on.
  out.teamAccess = typeof s.teamAccess === 'boolean' ? s.teamAccess : out.teamAccess === true;
  // Weekly publishing slots per page (see schedule.js). Missing → keep the base (or empty) schedule.
  out.publishingSchedule = Sched.sanitizeSchedule(isObj(s.publishingSchedule) ? s.publishingSchedule : out.publishingSchedule);
  return out;
}

const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Finds the existing PMS user for a roster slot by name. Only an unambiguous match counts:
// exactly one active admin/employee whose full name, or first name, equals the slot name.
function findUserForSlot(users, rosterName, takenIds) {
  const want = normName(rosterName);
  const candidates = users.filter((u) =>
    u.active && (u.role === 'employee' || u.role === 'admin') &&
    (normName(u.name) === want || normName(u.name).split(' ')[0] === want));
  if (candidates.length === 1 && !takenIds.has(candidates[0].id)) return { user: candidates[0] };
  if (candidates.length === 1) return { reason: `${candidates[0].name} is already linked to another Studio slot` };
  if (candidates.length > 1) return { reason: `${candidates.length} PMS users match "${rosterName}" (${candidates.map((u) => `#${u.id} ${u.name}`).join(', ')})` };
  return { reason: `No active PMS user named "${rosterName}"` };
}

// Links every unlinked roster slot that has an unambiguous match. Returns a per-slot report.
// Already-linked slots are left untouched.
function autoLinkMembers(db, studio, byUserId) {
  const taken = new Set(studio.members.filter((m) => m.userId).map((m) => m.userId));
  return C.ROSTER.map((r) => {
    const m = studio.members.find((x) => x.key === r.key);
    if (m.userId) return { key: r.key, name: r.name, status: 'linked', userId: m.userId };
    const found = findUserForSlot(db.users, r.name, taken);
    if (!found.user) return { key: r.key, name: r.name, status: 'unresolved', reason: found.reason };
    m.userId = found.user.id;
    m.linkedAt = new Date().toISOString();
    m.linkedBy = byUserId || null;
    taken.add(found.user.id);
    return { key: r.key, name: r.name, status: 'auto-linked', userId: found.user.id };
  });
}

// Schema v4 migration step, called from db.js migrate(). Adds db.socialStudio only if it is
// missing — it never resets or overwrites existing Studio data, so it is safe to re-run.
function migrateStudio(db) {
  if (isObj(db.socialStudio)) return false;
  db.socialStudio = emptyStudio();
  autoLinkMembers(db, db.socialStudio, null);
  return true;
}

// Returns db.socialStudio with any missing structure filled in (in memory). Used by every
// Studio route so a hand-edited or partially written file can't crash the module.
function getStudio(db) {
  if (!isObj(db.socialStudio)) db.socialStudio = emptyStudio();
  const s = db.socialStudio;
  if (!Array.isArray(s.members)) s.members = [];
  C.ROSTER.forEach((r) => {
    if (!s.members.some((m) => m.key === r.key)) s.members.push({ key: r.key, userId: null, linkedAt: null, linkedBy: null });
  });
  s.members = s.members.filter((m) => C.ROSTER_KEYS.includes(m.key));
  // "Can create reels" is off unless an admin turned it on, and never on for view-only slots.
  s.members.forEach((m) => { const r = C.getRosterEntry(m.key); m.canCreate = !!(r && r.canWork && m.canCreate === true); });
  s.settings = sanitizeSettings(s.settings);
  if (!Array.isArray(s.reels)) s.reels = [];
  if (!Number.isInteger(s.nextReelId) || s.nextReelId < 1) {
    s.nextReelId = s.reels.reduce((mx, r) => Math.max(mx, Number(r.id) || 0), 0) + 1;
  }
  if (!isObj(s.readNotifications)) s.readNotifications = {};
  if (!Array.isArray(s.scheduleHistory)) s.scheduleHistory = [];
  if (!isObj(s.contentSheet) || !Array.isArray(s.contentSheet.rows)) s.contentSheet = { rows: [], nextId: 1 };
  if (!Array.isArray(s.contentSheet.viewers)) s.contentSheet.viewers = [];
  return s;
}

// Schema v5 step (called from db.js migrate()): the editing deadline becomes "24 hours before
// the reel's scheduled publishing time" and is saved on each reel. Existing reels get their
// deadline from their own publishAt; an old manually-entered editDeadline is kept as
// legacyEditDeadline (with a history note) instead of being silently discarded. Completion
// records are not touched. Safe to re-run.
function migrateEditingDeadlines(db) {
  if (!isObj(db.socialStudio) || !Array.isArray(db.socialStudio.reels)) return false;
  let changed = false;
  db.socialStudio.reels.forEach((r) => {
    if (!r || typeof r !== 'object') return;
    const want = r.publishAt && !Number.isNaN(Date.parse(r.publishAt)) ? new Date(Date.parse(r.publishAt) - 24 * 3600000).toISOString() : null;
    if (r.editingDeadline === undefined || r.editingDeadline !== want) { r.editingDeadline = want; changed = true; }
    if (r.editDeadline) {
      r.legacyEditDeadline = r.editDeadline;
      r.activity = Array.isArray(r.activity) ? r.activity : [];
      r.activity.push({ id: `mig5_${r.id}`, at: new Date().toISOString(), by: null, byName: 'System', kind: 'deadline', stage: 'Editing', text: `Editing deadline rule changed to "24 hours before scheduled publishing". The earlier manual editing deadline (${r.editDeadline}) is kept for reference only.` });
      delete r.editDeadline;
      changed = true;
    }
  });
  return changed;
}

module.exports = { STUDIO_VERSION, emptyStudio, sanitizeSettings, findUserForSlot, autoLinkMembers, migrateStudio, migrateEditingDeadlines, getStudio };
