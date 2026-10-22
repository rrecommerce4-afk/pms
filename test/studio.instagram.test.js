// Instagram follower sync — runs against a mocked fetch, never the real API.
// Times typed into forms are read in the PMS business time zone (server.js); the tests build
// their form values in the same zone so they behave the same on any machine.
process.env.TZ = 'Asia/Kolkata';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-ig-test-'));
process.env.PMS_IG_TOKENS_FILE = path.join(TMP, 'tokens.json');
const IG = require('../lib/studio/instagram');
const F = require('../lib/studio/followers');
const W = require('../lib/studio/workflow');
const Store = require('../lib/studio/store');

const TOKEN = 'IGAA' + 'x'.repeat(60);
const calls = [];
// Fake graph.instagram.com: answers /me per token, insights with three days of gains, refresh.
function mockFetch(accounts) {
  IG.setFetch(async (url) => {
    const u = new URL(url);
    calls.push(u.pathname);
    const token = u.searchParams.get('access_token');
    const json = (status, body) => ({ ok: status === 200, status, json: async () => body });
    if (u.pathname === '/refresh_access_token') return json(200, { access_token: token + 'R', token_type: 'bearer', expires_in: 5184000 });
    const acct = accounts[token.replace(/R+$/, '')];
    if (!acct) return json(400, { error: { message: 'Invalid OAuth access token', code: 190 } });
    if (u.pathname.endsWith('/me')) return json(200, { user_id: acct.id, username: acct.username, followers_count: acct.followers });
    if (u.pathname.endsWith('/insights')) {
      const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
      return json(200, { data: [{ name: 'follower_count', period: 'day', values: [{ value: 10, end_time: day(1) }, { value: 20, end_time: day(2) }, { value: 5, end_time: day(3) }] }] });
    }
    return json(404, {});
  });
}

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('a token for the wrong account or a bad token is refused and nothing is stored', async () => {
  mockFetch({ [TOKEN]: { id: '1784', username: 'rajarani_stencil', followers: 900 } });
  await assert.rejects(IG.connectPage('product', TOKEN), /belongs to @rajarani_stencil, not @rajarani_product/);
  await assert.rejects(IG.connectPage('product', 'short'), /does not look like/);
  await assert.rejects(IG.connectPage('product', 'IGAA' + 'y'.repeat(60)), (e) => /invalid or expired/.test(e.message) && !e.message.includes('IGAA'));
  assert.deepEqual(IG.readTokens(), {});
});

test('connecting saves the token only in the token file and records a real reading plus estimated history', async () => {
  mockFetch({ [TOKEN]: { id: '1784', username: 'rajarani_product', followers: 15000 } });
  const result = await IG.connectPage('product', TOKEN);
  assert.equal(result.followers, 15000);
  assert.equal(IG.readTokens().product.token, TOKEN);
  const db = { users: [], socialStudio: Store.emptyStudio() };
  IG.applyReading(db.socialStudio, result);
  assert.ok(!JSON.stringify(db).includes(TOKEN), 'token never written to the database');
  const snaps = db.socialStudio.instagram.snapshots.product;
  const today = snaps.find((s) => s.source === 'api');
  assert.equal(today.followers, 15000);
  // Walk back: end of yesterday ≈ 15000, two days ago = 15000 - 10, three days ago = 14990 - 20.
  const back = snaps.filter((s) => s.source === 'backfill').sort((a, b) => b.date.localeCompare(a.date)).map((s) => s.followers);
  assert.deepEqual(back, [15000, 14990, 14970]);
  assert.equal(F.sources(db.socialStudio).product, 'live');
  assert.equal(F.sources(db.socialStudio).farma, 'demo');

  // History: live page uses its readings and has null before them; demo pages stay generated.
  const h = F.history(db.socialStudio, new Date());
  assert.equal(h[h.length - 1].product, 15000);
  assert.equal(h[0].product, null);
  assert.equal(typeof h[0].farma, 'number');
  const now = new Date();
  const s = F.summarize(h, 'product', W.localDay(W.addDaysD(now, -29)), W.localDay(now));
  assert.equal(s.current, 15000);
  assert.equal(s.previous, 14970);
  assert.equal(s.net, 30);
  assert.ok(s.since, 'flags that data starts inside the period');
  const rows = F.chartSeries(h, W.localDay(W.addDaysD(now, -29)), W.localDay(now), 'total', 'day');
  assert.equal(rows[0].product, null);
  assert.equal(rows[0].all, null, 'combined total is not invented when a page has no reading');
});

test('token reminders: expiring, expired, missing token and failed updates — never for unconnected pages', () => {
  const day = 86400000;
  const studio = Store.emptyStudio();
  const ig = IG.igState(studio);
  const saved = fs.readFileSync(process.env.PMS_IG_TOKENS_FILE, 'utf8');
  const tokenEntry = (ms) => ({ token: 'IGAA' + 'q'.repeat(60), savedAt: new Date().toISOString(), refreshedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ms).toISOString() });
  fs.writeFileSync(process.env.PMS_IG_TOKENS_FILE, JSON.stringify({ product: tokenEntry(40 * day), farma: tokenEntry(3 * day + 3600000), stencil: tokenEntry(-2 * day) }));
  ['product', 'farma', 'stencil', 'butterpaper'].forEach((p) => { ig.status[p] = { connected: true, lastFetchAt: new Date().toISOString() }; });
  let alerts = IG.tokenAlerts(studio);
  assert.deepEqual(alerts.map((a) => [a.pageId, a.kind]), [['farma', 'expiring'], ['stencil', 'expired'], ['butterpaper', 'missing']]);
  assert.equal(alerts[0].daysLeft, 4);
  assert.match(alerts[0].text, /@rajarani_farma_patterns: the access token expires in 4 days/);
  assert.ok(alerts.every((a) => !JSON.stringify(a).includes('IGAA')), 'reminders never contain the token');
  ig.status.product.lastError = 'Instagram API error 4: rate limit';
  ig.status.product.lastErrorAt = new Date(Date.now() + 1000).toISOString();
  assert.ok(IG.tokenAlerts(studio).some((a) => a.pageId === 'product' && a.kind === 'error'));
  ig.status.product.lastFetchAt = new Date(Date.now() + 5000).toISOString(); // a later success clears it
  assert.ok(!IG.tokenAlerts(studio).some((a) => a.pageId === 'product'));
  ['farma', 'stencil', 'butterpaper'].forEach((p) => { ig.status[p].connected = false; });
  assert.deepEqual(IG.tokenAlerts(studio), [], 'pages that are not connected never trigger reminders');
  fs.writeFileSync(process.env.PMS_IG_TOKENS_FILE, saved);
});

test('sync refreshes a token near expiry, keeps one reading per day, and records errors', async () => {
  mockFetch({ [TOKEN]: { id: '1784', username: 'rajarani_product', followers: 15100 } });
  const tokens = IG.readTokens();
  tokens.product.expiresAt = new Date(Date.now() + 3 * 86400000).toISOString();
  tokens.product.refreshedAt = new Date(Date.now() - 50 * 86400000).toISOString();
  tokens.farma = { token: 'IGAA' + 'z'.repeat(60), savedAt: new Date().toISOString(), refreshedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 50 * 86400000).toISOString() };
  fs.writeFileSync(process.env.PMS_IG_TOKENS_FILE, JSON.stringify(tokens));
  let db = { users: [], socialStudio: Store.emptyStudio() };
  const r = await IG.syncAll({ loadDb: () => db, saveDb: (d) => { db = d; }, getStudio: Store.getStudio, force: true });
  assert.deepEqual(r.synced, ['product']);
  assert.equal(r.failed[0].pageId, 'farma');
  assert.match(db.socialStudio.instagram.status.farma.lastError, /invalid or expired/);
  assert.equal(IG.readTokens().product.token, TOKEN + 'R', 'token refreshed');
  assert.ok(new Date(IG.readTokens().product.expiresAt) > new Date(Date.now() + 50 * 86400000));
  await IG.syncAll({ loadDb: () => db, saveDb: (d) => { db = d; }, getStudio: Store.getStudio, force: true });
  assert.equal(db.socialStudio.instagram.snapshots.product.filter((s) => s.date === W.localDay(new Date())).length, 1);
  IG.disconnectPage(db.socialStudio, 'product');
  assert.equal(IG.readTokens().product, undefined);
  assert.equal(F.sources(db.socialStudio).product, 'demo');
  assert.ok(calls.every((p) => !p.includes(TOKEN)), 'token never appears in a URL path');
});
