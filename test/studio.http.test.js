// End-to-end HTTP tests: boots the real server.js against a throwaway COPY of db.json (via
// PMS_DB_FILE) with extra test logins, then drives it like a browser. The real db.json is only
// read, never written. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'db.json');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-studio-test-'));
const DB = path.join(TMP, 'db.json');
const PORT = 4100 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'test-pass-123';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------- fixture DB
const sourceText = fs.existsSync(SOURCE) ? fs.readFileSync(SOURCE, 'utf8') : '';
const sourceHash = sha(sourceText);
const seed = sourceText.trim() ? JSON.parse(sourceText) : { users: [], tasks: [], nextId: { users: 1, tasks: 1, todos: 1 } };
// The tests start every page as "not connected to Instagram", whatever the real db.json has.
if (seed.socialStudio) delete seed.socialStudio.instagram;
const hash = bcrypt.hashSync(PW, 4);
seed.nextId = seed.nextId || { users: 1, tasks: 1, todos: 1 };
seed.users = seed.users || [];
const U = {};
function addUser(key, name, role, extra) {
  const u = { id: seed.nextId.users++, name, email: `${key}@studio-test.local`, passwordHash: hash, role, active: true, ...(extra || {}) };
  seed.users.push(u);
  U[key] = u;
}
addUser('admin', 'Test Admin', 'admin');
['Bansi', 'Bhavin', 'Vishnu', 'Krutik', 'Dhara', 'Ashmita'].forEach((n) => addUser(n.toLowerCase(), n, 'employee', { department: 'Team Member', roleTitle: '', color: 'var(--info)' }));
addUser('viewer', 'Test Viewer', 'viewer');
addUser('other', 'Other Employee', 'employee', { department: 'Team Member', roleTitle: '', color: 'var(--info)' });
addUser('head', 'Dept Head', 'employee', { department: 'Team Member', roleTitle: '', color: 'var(--info)', isDeptHead: true });
fs.writeFileSync(DB, JSON.stringify(seed, null, 2));
const preBoot = JSON.parse(fs.readFileSync(DB, 'utf8'));
const readDb = () => JSON.parse(fs.readFileSync(DB, 'utf8'));

// ---------------------------------------------------------------- tiny browser
class Client {
  constructor() { this.cookies = new Map(); }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  store(res) {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    set.forEach((c) => { const [kv] = c.split(';'); const i = kv.indexOf('='); this.cookies.set(kv.slice(0, i), kv.slice(i + 1)); });
  }
  async get(p) {
    const res = await fetch(BASE + p, { headers: { cookie: this.header() }, redirect: 'manual' });
    this.store(res);
    return { status: res.status, location: res.headers.get('location'), text: await res.text(), type: res.headers.get('content-type') };
  }
  async post(p, form) {
    // Arrays become repeated fields (mon_slots=13:00&mon_slots=18:30), as a browser sends them.
    const body = new URLSearchParams();
    Object.entries(form).forEach(([k, v]) => (Array.isArray(v) ? v : [v]).forEach((x) => body.append(k, x)));
    const res = await fetch(BASE + p, { method: 'POST', headers: { cookie: this.header(), 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), redirect: 'manual' });
    this.store(res);
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }
  async login(user) { const r = await this.post('/login', { email: user.email, password: PW }); assert.equal(r.status, 302, `login ${user.email}`); return r; }
  async csrf() { const r = await this.get('/social-media'); const m = r.text.match(/name="_csrf" value="([a-f0-9]+)"/); assert.ok(m, 'csrf token on page'); return m[1]; }
}
async function as(user) { const c = new Client(); await c.login(user); c.token = await c.csrf().catch(() => null); return c; }
const studio = () => readDb().socialStudio;
const reel = (id) => studio().reels.find((r) => r.id === id);
const flashOf = async (c, url) => { const r = await c.get(url); const m = r.text.match(/class="sm-flash (success|error|info)"[^>]*>([^<]*)/); return m ? { type: m[1], text: m[2] } : null; };
const localInput = (ms) => { const d = new Date(Date.now() + ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const HOUR = 3600000;

// ---------------------------------------------------------------- server lifecycle
let server;
test.before(async () => {
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), PMS_DB_FILE: DB, PMS_IG_SYNC: 'off', PMS_IG_TOKENS_FILE: path.join(TMP, 'ig-tokens.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderrText = '';
  server.stderr.on('data', (d) => { server.stderrText += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    server.stdout.on('data', (d) => { if (String(d).includes('PMS running')) { clearTimeout(t); resolve(); } });
    server.on('exit', (code) => reject(new Error(`server exited ${code}: ${server.stderrText}`)));
  });
});
test.after(() => {
  if (server) server.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------- tests
test('migration preserved every existing record and linked the six Studio members without new users', async () => {
  await new Client().get('/login'); // first request after boot already loaded/migrated
  const db = readDb();
  assert.equal(db.schemaVersion, 5);
  for (const k of ['users', 'departments', 'todos', 'holidays']) assert.deepEqual(db[k] || [], preBoot[k] || [], `${k} preserved`);
  assert.deepEqual(db.tasks.map((t) => [t.id, t.title, t.assignedTo]), (preBoot.tasks || []).map((t) => [t.id, t.title, t.assignedTo]), 'tasks preserved');
  if ((preBoot.schemaVersion || 1) >= 4) {
    // The source db was already migrated (the migration only auto-links once), so link the
    // test users the way an admin would: Settings → Studio members → Auto-link by name.
    assert.deepEqual(db.socialStudio, preBoot.socialStudio, 'existing Studio data untouched on boot');
    const admin = await as(U.admin);
    assert.equal((await admin.post('/social-media/settings/autolink', { _csrf: admin.token })).status, 303);
  }
  const links = Object.fromEntries(readDb().socialStudio.members.map((m) => [m.key, m.userId]));
  assert.deepEqual(links, { bansi: U.bansi.id, bhavin: U.bhavin.id, vishnu: U.vishnu.id, krutik: U.krutik.id, dhara: U.dhara.id, ashmita: U.ashmita.id });
  assert.equal(db.users.length, preBoot.users.length);
  assert.equal(sha(fs.readFileSync(SOURCE, 'utf8')), sourceHash, 'real db.json untouched');
});

test('existing login, logout and role dashboards still work', async () => {
  const bad = await new Client().post('/login', { email: U.admin.email, password: 'wrong' });
  assert.equal(bad.status, 200);
  assert.match(bad.text, /Invalid email or password/);
  const routes = {
    admin: ['/admin/dashboard', '/admin/tasks', '/admin/my-tasks', '/admin/todos', '/admin/review', '/admin/calendar', '/admin/missed', '/admin/workload', '/admin/reports', '/admin/settings', '/admin/settings?tab=departments'],
    bansi: ['/employee/dashboard', '/employee/tasks', '/employee/todos', '/employee/calendar', '/employee/submitted', '/employee/completed'],
    head: ['/employee/dashboard', '/employee/department'],
    viewer: ['/viewer/dashboard', '/viewer/tracker']
  };
  for (const [who, list] of Object.entries(routes)) {
    const c = new Client();
    const login = await c.login(U[who]);
    assert.ok(login.location.endsWith(who === 'admin' ? '/admin/dashboard' : who === 'viewer' ? '/viewer/dashboard' : '/employee/dashboard'));
    for (const p of list) assert.equal((await c.get(p)).status, 200, `${who} ${p}`);
    assert.equal((await c.get('/admin/dashboard')).status, who === 'admin' ? 200 : 403);
    const out = await c.post('/logout', {});
    assert.equal(out.status, 302);
    assert.equal((await c.get(list[0])).location, '/login', 'session ended on logout');
  }
});

test('general PMS task workflow, review and to-do list are unaffected', async () => {
  const admin = await as(U.admin);
  const emp = await as(U.bansi);
  const before = readDb().tasks.length;
  const today = new Date().toISOString().slice(0, 10);
  const r = await admin.post('/admin/tasks', { title: 'Regression task', description: 'x', assignedTo: String(U.bansi.id), priority: 'medium', recurrence: 'none', startDate: today, dueDate: today });
  assert.equal(r.status, 302);
  const task = readDb().tasks.find((t) => t.title === 'Regression task');
  assert.ok(task && readDb().tasks.length === before + 1);
  await emp.post(`/employee/tasks/${task.id}/start`, {});
  await emp.post(`/employee/tasks/${task.id}/submit-review`, {});
  assert.equal(readDb().tasks.find((t) => t.id === task.id).status, 'review');
  await admin.post(`/admin/tasks/${task.id}/approve`, {});
  assert.equal(readDb().tasks.find((t) => t.id === task.id).status, 'completed');
  await emp.post('/employee/todos', { text: 'Regression todo' });
  const todo = readDb().todos.find((t) => t.text === 'Regression todo' && t.userId === U.bansi.id);
  assert.ok(todo);
  await emp.post(`/employee/todos/${todo.id}/toggle`, {});
  assert.equal(readDb().todos.find((t) => t.id === todo.id).done, true);
  assert.equal(readDb().socialStudio.reels.length, 0, 'general tasks never create Studio records');
});

test('Studio appears in the sidebar only for users who can open it', async () => {
  for (const who of ['admin', 'bansi', 'dhara', 'viewer']) {
    const c = await as(U[who]);
    const home = await c.get(who === 'admin' ? '/admin/dashboard' : who === 'viewer' ? '/viewer/dashboard' : '/employee/dashboard');
    assert.match(home.text, /href="\/social-media"/, `${who} sees the Studio link`);
    const page = await c.get('/social-media');
    assert.equal(page.status, 200);
    assert.match(page.text, /DEMO DATA — INSTAGRAM NOT CONNECTED/);
    assert.equal((page.text.match(/nav-sub-link/g) || []).length, 11, 'all 11 Studio screens in the sidebar');
  }
  const other = new Client();
  await other.login(U.other);
  assert.doesNotMatch((await other.get('/employee/dashboard')).text, /href="\/social-media"/);
  assert.equal((await other.get('/social-media')).status, 403);
  assert.equal((await new Client().get('/social-media')).location, '/login');
});

let reelId;
test('end-to-end reel workflow over HTTP persists server-side', async () => {
  const admin = await as(U.admin);
  const bansi = await as(U.bansi);
  const krutik = await as(U.krutik);
  const created = await admin.post('/social-media/reels', { _csrf: admin.token, title: 'Navratri <script>alert(1)</script> blouse reel', pageId: 'product', priority: 'High', idea: 'Hook + 3 shots', prepNotes: 'Bring red fabric', caption: 'cap', shootAt: localInput(3 * HOUR), hasPublishAt: '1', publishAt: localInput(72 * HOUR) });
  assert.equal(created.status, 303);
  reelId = Number(created.location.split('/').pop());
  let r = reel(reelId);
  assert.equal(r.shootOwner, null);
  assert.equal(r.editingDeadline, new Date(Date.parse(r.publishAt) - 24 * HOUR).toISOString(), 'editing deadline saved as publish − 24h');
  assert.ok(r.publishAt);

  const page = await bansi.get(`/social-media/reels/${reelId}`);
  assert.match(page.text, /Navratri &lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'user content is escaped');
  assert.doesNotMatch(page.text, /<script>alert\(1\)<\/script>/);

  assert.equal((await bansi.post(`/social-media/reels/${reelId}/claim-shoot`, { _csrf: bansi.token })).status, 303);
  assert.equal(reel(reelId).shootOwner, U.bansi.id);
  await krutik.post(`/social-media/reels/${reelId}/claim-shoot`, { _csrf: krutik.token, returnTo: '/social-media/shoots' });
  assert.equal(reel(reelId).shootOwner, U.bansi.id, 'duplicate claim refused');
  assert.match((await flashOf(krutik, '/social-media/shoots')).text, /Already claimed by Bansi/);

  await bansi.post(`/social-media/reels/${reelId}/complete-shoot`, { _csrf: bansi.token, notes: 'All shots done' });
  r = reel(reelId);
  assert.equal(r.shoot.status, 'Completed');
  assert.equal(r.shoot.rawSubmitted, false);
  await krutik.post(`/social-media/reels/${reelId}/claim-edit`, { _csrf: krutik.token });
  assert.equal(reel(reelId).editor, null, 'editing blocked until raw footage is ready');
  await bansi.post(`/social-media/reels/${reelId}/raw-ready`, { _csrf: bansi.token });
  await krutik.post(`/social-media/reels/${reelId}/claim-edit`, { _csrf: krutik.token });
  assert.equal(reel(reelId).editor, U.krutik.id);
  await krutik.post(`/social-media/reels/${reelId}/complete-edit`, { _csrf: krutik.token, notes: 'Final cut' });
  assert.equal(reel(reelId).publishing.status, 'Ready to Publish');
  await bansi.post(`/social-media/reels/${reelId}/schedule`, { _csrf: bansi.token, publishAt: localInput(72 * HOUR) });
  assert.equal(reel(reelId).publishing.status, 'Scheduled');
  assert.equal(reel(reelId).publishingOwner, null, 'scheduling does not set a publisher');

  // Publishing needs the real URL and time.
  await bansi.post(`/social-media/reels/${reelId}/publish`, { _csrf: bansi.token, postUrl: '', publishedAt: localInput(0) });
  assert.equal(reel(reelId).publishing.status, 'Scheduled');
  await bansi.post(`/social-media/reels/${reelId}/publish`, { _csrf: bansi.token, postUrl: 'https://www.instagram.com/reel/C0ffee123/', publishedAt: localInput(0), notes: 'Posted from phone' });
  r = reel(reelId);
  assert.equal(r.publishing.status, 'Published');
  assert.equal(r.publishingOwner, U.bansi.id);
  assert.equal(r.publishing.postUrl, 'https://www.instagram.com/reel/C0ffee123/');

  // Persisted across logout/login.
  await bansi.post('/logout', {});
  const again = await as(U.bansi);
  const detail = await again.get(`/social-media/reels/${reelId}?tab=activity`);
  assert.match(detail.text, /confirmed the reel as published/);
  assert.match(detail.text, /claimed shooting/);
  assert.match((await again.get('/social-media/publishing?tab=Published')).text, /C0ffee123/);
  assert.match((await again.get('/social-media/ranking')).text, /Bansi/);
});

test('Dhara and Ashmita can view preparation info but every direct POST is rejected', async () => {
  const admin = await as(U.admin);
  const made = await admin.post('/social-media/reels', { _csrf: admin.token, title: 'Stencil prep reel', pageId: 'stencil', priority: 'Medium', idea: 'Rangoli stencil close-ups', prepNotes: 'White chalk powder, black board', shootAt: localInput(26 * HOUR) });
  const id = Number(made.location.split('/').pop());
  for (const who of ['dhara', 'ashmita']) {
    const c = await as(U[who]);
    const ov = await c.get('/social-media');
    assert.match(ov.text, /Upcoming shoots/);
    if (who === 'dhara') {
      assert.match(ov.text, /Stencil prep reel/, 'Dhara sees Stencil preparation');
      assert.match(ov.text, /White chalk powder/);
    }
    const detail = await c.get(`/social-media/reels/${id}?tab=details`);
    assert.match(detail.text, /White chalk powder, black board/);
    assert.doesNotMatch(detail.text, /data-sm-modal=|Take Shoot Task/, 'no task controls rendered');
    const snapshot = JSON.stringify(studio());
    const usersBefore = JSON.stringify(readDb().users);
    const attempts = [
      ['/social-media/reels', { title: 'x', pageId: 'stencil', shootAt: localInput(HOUR) }],
      [`/social-media/reels/${id}/claim-shoot`, {}],
      [`/social-media/reels/${id}/complete-shoot`, { rawSubmitted: 'on' }],
      [`/social-media/reels/${id}/raw-ready`, {}],
      [`/social-media/reels/${id}/claim-edit`, {}],
      [`/social-media/reels/${id}/update`, { title: 'hacked', pageId: 'stencil', shootAt: localInput(HOUR) }],
      [`/social-media/reels/${id}/delete`, {}],
      [`/social-media/reels/${id}/assign`, { stage: 'Shoot', memberKey: who, reason: 'x' }],
      [`/social-media/reels/${id}/blocker`, { stage: 'Shoot', reason: 'x' }],
      [`/social-media/reels/${id}/toggle-script`, {}],
      [`/social-media/reels/${reelId}/reopen-edit`, { reason: 'x' }],
      [`/social-media/reels/${reelId}/publish`, { postUrl: 'https://www.instagram.com/reel/x', publishedAt: localInput(0) }],
      [`/social-media/reels/${id}/schedule`, { publishAt: localInput(HOUR) }],
      [`/social-media/reels/${id}/notes`, { stage: 'Shoot', notes: 'x' }],
      ['/social-media/settings/targets', { target_product: '1' }],
      ['/social-media/settings/teams', { team_stencil: who }],
      ['/social-media/settings/members', { [`member_${who}`]: String(U.admin.id) }],
      ['/social-media/settings/autolink', {}]
    ];
    for (const [url, body] of attempts) {
      const res = await c.post(url, { _csrf: c.token, ...body });
      assert.equal(res.status, 403, `${who} POST ${url}`);
    }
    assert.equal(JSON.stringify(studio()), snapshot, `${who}: Studio data unchanged`);
    assert.equal(JSON.stringify(readDb().users), usersBefore, `${who}: users unchanged`);
    // Personal preferences are still allowed.
    assert.equal((await c.post('/social-media/range', { _csrf: c.token, preset: 'last-30', returnTo: '/social-media' })).status, 303);
  }
  const viewer = await as(U.viewer);
  assert.equal((await viewer.post(`/social-media/reels/${id}/claim-shoot`, { _csrf: viewer.token })).status, 403);
});

test('Dhara and Ashmita never appear in rankings, scores or ranking charts', async () => {
  const admin = await as(U.admin);
  for (const p of ['/social-media/ranking', '/social-media/ranking?board=editing', '/social-media/reports']) {
    const html = (await admin.get(p)).text;
    const board = html.slice(html.indexOf('<div class="container'));
    for (const name of ['Bansi', 'Bhavin', 'Vishnu', 'Krutik']) assert.match(board, new RegExp(name), `${name} on ${p}`);
    assert.doesNotMatch(board.replace(/<nav class="sm-crumbs[\s\S]*?<\/nav>/, ''), /Dhara|Ashmita/, `${p} has no Dhara/Ashmita`);
  }
  const csv = await admin.get('/social-media/reports/export/employee-contribution.csv');
  assert.match(csv.type, /text\/csv/);
  assert.doesNotMatch(csv.text, /Dhara|Ashmita/);
  assert.match(csv.text, /Bansi/);
});

test('CSRF, invalid transitions, invalid input and open redirects are rejected safely', async () => {
  const bansi = await as(U.bansi);
  const admin = await as(U.admin);
  const before = JSON.stringify(studio());
  assert.equal((await bansi.post(`/social-media/reels/${reelId}/claim-shoot`, {})).status, 403, 'missing CSRF token');
  assert.equal((await bansi.post(`/social-media/reels/${reelId}/claim-shoot`, { _csrf: 'f'.repeat(48) })).status, 403, 'wrong CSRF token');
  assert.equal(JSON.stringify(studio()), before);
  // Published reel: further transitions are refused (409 → flash error, no change).
  const res = await bansi.post(`/social-media/reels/${reelId}/claim-shoot`, { _csrf: bansi.token, returnTo: 'https://evil.example.com/' });
  assert.equal(res.status, 303);
  assert.equal(res.location, `/social-media/reels/${reelId}`, 'external returnTo ignored');
  assert.equal((await flashOf(bansi, `/social-media/reels/${reelId}`)).type, 'error');
  await admin.post(`/social-media/reels/${reelId}/reopen-edit`, { _csrf: admin.token, reason: 'x' });
  assert.equal(reel(reelId).publishing.status, 'Published', 'cannot reopen a published reel');
  assert.equal((await bansi.post('/social-media/reels/99999/claim-shoot', { _csrf: bansi.token })).status, 404);
  assert.equal((await bansi.post(`/social-media/reels/${reelId}/not-an-action`, { _csrf: bansi.token })).status, 404);
  const bad = await admin.post('/social-media/reels', { _csrf: admin.token, title: '', pageId: 'product', shootAt: localInput(HOUR) });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Reel title is required/);
  const bad2 = await admin.post('/social-media/reels', { _csrf: admin.token, title: 'x', pageId: 'instagram-hack', shootAt: localInput(HOUR) });
  assert.equal(bad2.status, 400);
  assert.equal(JSON.stringify(studio()), before, 'nothing saved by rejected requests');
});

test('editing eligibility over HTTP follows page teams', async () => {
  const admin = await as(U.admin);
  const bhavin = await as(U.bhavin);
  const krutik = await as(U.krutik);
  const made = await admin.post('/social-media/reels', { _csrf: admin.token, title: 'Butterpaper tutorial', pageId: 'butterpaper', priority: 'Low', shootAt: localInput(5 * HOUR) });
  const id = Number(made.location.split('/').pop());
  await bhavin.post(`/social-media/reels/${id}/claim-shoot`, { _csrf: bhavin.token });
  await bhavin.post(`/social-media/reels/${id}/complete-shoot`, { _csrf: bhavin.token, rawSubmitted: 'on' });
  assert.equal((await krutik.post(`/social-media/reels/${id}/claim-edit`, { _csrf: krutik.token })).status, 403, 'Krutik is not an editor for Butterpaper');
  await bhavin.post(`/social-media/reels/${id}/claim-edit`, { _csrf: bhavin.token });
  assert.equal(reel(id).editor, U.bhavin.id);
  // Reassignment by the admin needs a reason and an eligible editor; release goes back to the pool.
  await admin.post(`/social-media/reels/${id}/assign`, { _csrf: admin.token, stage: 'Editing', memberKey: 'krutik', reason: 'try' });
  assert.equal(reel(id).editor, U.bhavin.id, 'ineligible reassignment refused');
  await bhavin.post(`/social-media/reels/${id}/release-edit`, { _csrf: bhavin.token });
  assert.equal(reel(id).editor, null);
  const hist = reel(id).ownershipHistory.map((o) => [o.stage, o.from, o.to]);
  assert.deepEqual(hist.slice(-2), [['Editing', null, U.bhavin.id], ['Editing', U.bhavin.id, null]]);
});

test('admin settings and member links are validated and never create users', async () => {
  const admin = await as(U.admin);
  const bansi = await as(U.bansi);
  const usersBefore = JSON.stringify(readDb().users);
  assert.equal((await bansi.post('/social-media/settings/targets', { _csrf: bansi.token, target_product: '5' })).status, 403, 'members cannot change targets');
  await admin.post('/social-media/settings/targets', { _csrf: admin.token, target_product: '25', target_farma: '18', target_stencil: '300', target_butterpaper: 'abc' });
  assert.deepEqual(studio().settings.targets, { product: 25, farma: 18, stencil: 20, butterpaper: 20 });
  await admin.post('/social-media/settings/members', { _csrf: admin.token, member_dhara: String(U.bansi.id) });
  assert.equal(studio().members.find((m) => m.key === 'dhara').userId, U.dhara.id, 'one user cannot fill two slots');
  await admin.post('/social-media/settings/members', { _csrf: admin.token, member_dhara: '999999' });
  assert.equal(studio().members.find((m) => m.key === 'dhara').userId, U.dhara.id, 'unknown user refused');
  await admin.post('/social-media/settings/weights', { _csrf: admin.token, reset: '1' });
  assert.deepEqual(studio().settings.weights, { onTime: 35, shootDelivery: 25, editing: 25, publishing: 15 });
  await admin.post('/social-media/settings/restore-teams', { _csrf: admin.token });
  assert.deepEqual(studio().settings.pageTeams, { product: ['bansi', 'krutik'], farma: ['bansi', 'vishnu'], stencil: ['dhara', 'bhavin'], butterpaper: ['ashmita', 'bhavin'] });
  assert.equal(JSON.stringify(readDb().users), usersBefore, 'no user record changed');
  const emails = readDb().users.map((u) => u.email.toLowerCase());
  assert.equal(new Set(emails).size, emails.length, 'no duplicate accounts');
  assert.equal(readDb().users.filter((u) => /^bansi$/i.test(u.name)).length, 1);
});

test('Instagram connection is admin-only and starts as demo data', async () => {
  const admin = await as(U.admin);
  const settings = await admin.get('/social-media/settings');
  assert.match(settings.text, /Instagram connection/);
  assert.match(settings.text, /@rajarani_farma_patterns/);
  assert.equal((settings.text.match(/action="\/social-media\/instagram\/connect"/g) || []).length, 4);
  for (const who of ['bansi', 'dhara', 'viewer']) {
    const c = await as(U[who]);
    assert.doesNotMatch((await c.get('/social-media/settings')).text, /instagram\/connect/, `${who} sees no token form`);
    assert.equal((await c.post('/social-media/instagram/connect', { _csrf: c.token, pageId: 'product', token: 'x'.repeat(40) })).status, 403);
    assert.equal((await c.post('/social-media/instagram/refresh', { _csrf: c.token })).status, 403);
  }
  // A malformed token is refused before any network call; the error is shown, nothing stored.
  await admin.post('/social-media/instagram/connect', { _csrf: admin.token, pageId: 'product', token: 'short' });
  assert.match((await flashOf(admin, '/social-media/settings')).text, /does not look like an Instagram access token/);
  assert.equal(fs.existsSync(path.join(TMP, 'ig-tokens.json')), false);
  assert.equal(studio().instagram.status.product.connected, false);
});

test('admins get a token-expiry popup and banner on every page; others never do', async () => {
  // Simulate a connected page whose token expires in 3 days (no network involved).
  fs.writeFileSync(path.join(TMP, 'ig-tokens.json'), JSON.stringify({ product: { token: 'IGAA' + 'k'.repeat(60), savedAt: new Date().toISOString(), refreshedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3 * 86400000 - 3600000).toISOString() } }));
  const db = readDb();
  db.socialStudio.instagram.status.product = { connected: true, username: 'rajarani_product', lastFetchAt: new Date().toISOString() };
  db.socialStudio.instagram.snapshots.product = [{ date: new Date().toISOString().slice(0, 10), followers: 1000, at: new Date().toISOString(), source: 'api' }];
  fs.writeFileSync(DB, JSON.stringify(db, null, 2));

  const admin = await as(U.admin);
  for (const p of ['/admin/dashboard', '/admin/tasks', '/social-media']) {
    const html = (await admin.get(p)).text;
    assert.match(html, /id="igReminderModal"/, `popup on ${p}`);
    assert.match(html, /@rajarani_product: the access token expires in 3 days/);
    assert.match(html, /class="ig-bell-count">1</);
    assert.doesNotMatch(html, /IGAA/, 'token never rendered');
  }
  assert.match((await admin.get('/admin/dashboard')).text, /Renew tokens now/);
  // "Remind me tomorrow" hides the popup for today but keeps the banner.
  const dismissed = await admin.post('/social-media/instagram/dismiss-reminder', { _csrf: admin.token, returnTo: '/admin/tasks' });
  assert.equal(dismissed.location, '/admin/tasks');
  const after = (await admin.get('/admin/dashboard')).text;
  assert.doesNotMatch(after, /id="igReminderModal"/);
  assert.match(after, /Instagram access token reminder:/);
  assert.equal((await admin.post('/social-media/instagram/dismiss-reminder', { _csrf: admin.token, returnTo: 'https://evil.example.com' })).location, '/admin/dashboard');

  for (const who of ['bansi', 'dhara', 'viewer']) {
    const c = await as(U[who]);
    const home = (await c.get(who === 'viewer' ? '/viewer/dashboard' : '/employee/dashboard')).text;
    assert.doesNotMatch(home, /igReminderModal|Instagram access token reminder/, `${who} sees no reminder`);
    assert.equal((await c.post('/social-media/instagram/renew', { _csrf: c.token })).status, 403);
    assert.equal((await c.post('/social-media/instagram/dismiss-reminder', { _csrf: c.token })).status, 403);
  }
  // Fixed (token renewed far ahead) → reminder disappears everywhere.
  fs.writeFileSync(path.join(TMP, 'ig-tokens.json'), JSON.stringify({ product: { token: 'IGAA' + 'k'.repeat(60), savedAt: new Date().toISOString(), refreshedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 55 * 86400000).toISOString() } }));
  const fine = (await admin.get('/admin/dashboard')).text;
  assert.doesNotMatch(fine, /Instagram access token reminder|ig-bell-count/);
});

test('weekly publishing schedules: per page, persisted, history kept, admin-only, existing reels untouched', async () => {
  const admin = await as(U.admin);
  // A reel scheduled BEFORE the recurring schedule changes.
  const made = await admin.post('/social-media/reels', { _csrf: admin.token, title: 'Pre-scheduled reel', pageId: 'product', priority: 'Medium', shootAt: localInput(2 * HOUR), hasPublishAt: '1', publishAt: localInput(100 * HOUR) });
  const preId = Number(made.location.split('/').pop());
  const pre = JSON.parse(JSON.stringify(reel(preId)));

  const productForm = { _csrf: admin.token, mon_enabled: 'on', mon_slots: ['13:00', '18:30'], tue_enabled: 'on', tue_slots: '14:00', wed_enabled: 'on', wed_slots: '12:00', fri_enabled: 'on', fri_slots: '17:00', sat_enabled: 'on', sat_slots: '11:00', thu_slots: '' };
  assert.equal((await admin.post('/social-media/settings/schedule/product', productForm)).status, 303);
  await admin.post('/social-media/settings/schedule/stencil', { _csrf: admin.token, sun_enabled: 'on', sun_slots: '10:15' });
  let sch = studio().settings.publishingSchedule;
  assert.deepEqual(sch.product.mon, { enabled: true, slots: ['13:00', '18:30'] });
  assert.deepEqual(sch.product.thu, { enabled: false, slots: [] });
  assert.deepEqual(sch.stencil.sun, { enabled: true, slots: ['10:15'] });
  assert.deepEqual(sch.farma.mon, { enabled: false, slots: [] }, 'other pages untouched');

  // Changing Product's Monday slot does not touch Stencil or any scheduled reel.
  await admin.post('/social-media/settings/schedule/product', { ...productForm, mon_slots: ['15:00'] });
  sch = studio().settings.publishingSchedule;
  assert.deepEqual(sch.product.mon.slots, ['15:00']);
  assert.deepEqual(sch.stencil.sun, { enabled: true, slots: ['10:15'] });
  const after = reel(preId);
  assert.equal(after.publishAt, pre.publishAt, 'already-scheduled reel keeps its time');
  assert.equal(after.editingDeadline, pre.editingDeadline);
  assert.equal(after.deadlineChanges.length, pre.deadlineChanges.length);
  const hist = studio().scheduleHistory.filter((h) => h.pageId === 'product');
  assert.equal(hist.length, 2);
  assert.deepEqual([hist[1].before.mon.slots, hist[1].after.mon.slots, hist[1].byName], [['13:00', '18:30'], ['15:00'], 'Test Admin']);

  // Invalid input is refused and nothing changes.
  const snapshot = JSON.stringify(studio().settings.publishingSchedule);
  await admin.post('/social-media/settings/schedule/product', { _csrf: admin.token, mon_enabled: 'on', mon_slots: '25:61' });
  assert.match((await flashOf(admin, '/social-media/settings')).text, /not a valid time\. Use the time picker \(HH:mm\)\. Nothing was saved/);
  assert.equal(JSON.stringify(studio().settings.publishingSchedule), snapshot);
  assert.equal((await admin.post('/social-media/settings/schedule/instagram', { _csrf: admin.token })).status, 404);

  // Persisted across logout/login, shown in friendly format.
  await admin.post('/logout', {});
  const again = await as(U.admin);
  const settings = (await again.get('/social-media/settings')).text;
  assert.match(settings, /3:00 PM/);
  assert.match(settings, /10:15 AM/);
  assert.match(settings, /id="schedule-butterpaper"/);

  // Suggestions use the saved schedule; a page without one asks for configuration.
  const form = (await again.get('/social-media/reels/new?page=stencil')).text;
  assert.match(form, /Suggested from the Stencil weekly schedule \(first slot that leaves 24 h for editing after the shoot\): <b>Sun \d+ \w+, 10:15 AM<\/b>/);
  const shootVal = form.match(/name="shootAt" required value="([^"]+)"/)[1];
  const pubVal = form.match(/name="publishAt" value="([^"]+)"/)[1];
  assert.ok(new Date(pubVal) - new Date(shootVal) >= 24 * HOUR, 'suggested slot leaves 24 h for editing after the shoot');
  assert.match(form, /name="hasPublishAt" value="1" data-toggle-field="pub-wrap" checked/);
  assert.match((await again.get('/social-media/reels/new?page=butterpaper')).text, /No publishing schedule is configured for Butterpaper/);

  // Nobody but the admin can change schedules.
  for (const who of ['bansi', 'krutik', 'dhara', 'ashmita', 'viewer']) {
    const c = await as(U[who]);
    assert.equal((await c.post('/social-media/settings/schedule/product', { _csrf: c.token, mon_enabled: 'on', mon_slots: '09:00' })).status, 403, who);
    assert.doesNotMatch((await c.get('/social-media/settings')).text, /data-add-slot/, `${who} has no schedule editor`);
  }
  assert.equal(JSON.stringify(studio().settings.publishingSchedule), snapshot);
});

test('24-hour editing deadline over HTTP: saved, shown, recalculated with history, completion time not forgeable', async () => {
  const admin = await as(U.admin);
  const bansi = await as(U.bansi);
  const krutik = await as(U.krutik);
  const made = await admin.post('/social-media/reels', { _csrf: admin.token, title: 'Deadline reel', pageId: 'product', priority: 'High', shootAt: localInput(-3 * HOUR), hasPublishAt: '1', publishAt: localInput(72 * HOUR) });
  const id = Number(made.location.split('/').pop());
  let r = reel(id);
  assert.equal(Date.parse(r.publishAt) - Date.parse(r.editingDeadline), 24 * HOUR);
  await bansi.post(`/social-media/reels/${id}/claim-shoot`, { _csrf: bansi.token });
  await bansi.post(`/social-media/reels/${id}/complete-shoot`, { _csrf: bansi.token, rawSubmitted: 'on' });
  await krutik.post(`/social-media/reels/${id}/claim-edit`, { _csrf: krutik.token });

  // Moved to 10 h from now → deadline already passed: warning, status stays "Editing".
  const moved = await admin.post(`/social-media/reels/${id}/reschedule`, { _csrf: admin.token, publishAt: localInput(10 * HOUR), reason: 'Launch moved up' });
  assert.equal(moved.status, 303);
  assert.match((await flashOf(admin, `/social-media/reels/${id}`)).text, /Warning: the editing deadline .* has already passed/);
  r = reel(id);
  assert.equal(Date.parse(r.publishAt) - Date.parse(r.editingDeadline), 24 * HOUR);
  assert.equal(r.editing.status, 'Editing');
  assert.deepEqual(r.deadlineChanges.slice(-2).map((c) => [c.field, c.reason]), [['publishAt', 'Launch moved up'], ['editingDeadline', 'Launch moved up']]);
  for (const p of [`/social-media/reels/${id}`, '/social-media/editing', '/social-media/editing?view=list', '/social-media/tasks?type=Editing']) {
    const html = (await admin.get(p)).text;
    assert.match(html, /Editing Overdue/, `overdue warning on ${p}`);
  }
  assert.match((await admin.get(`/social-media/calendar?view=day&date=${localInput(10 * HOUR).slice(0, 10)}`)).text, /Editing Overdue/);

  // Forged completion fields are ignored: server time, server user, server on-time result.
  await krutik.post(`/social-media/reels/${id}/complete-edit`, { _csrf: krutik.token, notes: 'done', at: '2020-01-01T00:00', completedAt: '2020-01-01T00:00', onTime: 'true', by: String(U.bansi.id) });
  r = reel(id);
  assert.equal(r.editing.completion.by, U.krutik.id);
  assert.equal(r.editing.completion.onTime, false, 'late: completed after the 24-hour deadline');
  assert.ok(Math.abs(Date.parse(r.editing.completion.at) - Date.now()) < 10000);
  assert.equal(r.publishing.status, 'Ready to Publish');
  // Bansi (view of Publishing Queue) sees the publishing time with the deadline result.
  assert.match((await bansi.get('/social-media/publishing')).text, /Deadline reel/);
  // Dhara cannot reschedule even directly.
  const dhara = await as(U.dhara);
  assert.equal((await dhara.post(`/social-media/reels/${id}/reschedule`, { _csrf: dhara.token, publishAt: localInput(90 * HOUR), reason: 'x' })).status, 403);
});

test('every Studio screen renders for each role without server errors', async () => {
  const pages = ['/social-media', '/social-media/pages', '/social-media/pages/product?tab=history', '/social-media/pages/stencil?tab=editing', '/social-media/followers?period=90&bucket=week', '/social-media/calendar?view=month&shoots=1', '/social-media/calendar?view=week', '/social-media/calendar?view=day', '/social-media/shoots?tab=completed', '/social-media/shoots?view=calendar', '/social-media/editing', '/social-media/editing?view=list', '/social-media/publishing', '/social-media/publishing?view=calendar', '/social-media/tasks?state=done', '/social-media/tasks?sort=priority&dir=desc', '/social-media/ranking', `/social-media/ranking?breakdown=${U.bansi.id}`, '/social-media/reports?page=product', '/social-media/settings', `/social-media/reels/${reelId}`, `/social-media/reels/${reelId}?tab=details`];
  for (const who of ['admin', 'krutik', 'ashmita', 'viewer']) {
    const c = await as(U[who]);
    for (const p of pages) {
      const r = await c.get(p);
      assert.equal(r.status, 200, `${who} ${p}`);
      assert.doesNotMatch(r.text, /ReferenceError|TypeError|is not defined/, `${who} ${p}`);
    }
  }
  assert.equal(server.stderrText, '', 'no server errors logged');
});
