// Social Media Studio — unit tests for permissions, workflow transitions, migration and scoring.
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/studio/config');
const W = require('../lib/studio/workflow');
const P = require('../lib/studio/permissions');
const A = require('../lib/studio/actions');
const S = require('../lib/studio/scoring');
const Store = require('../lib/studio/store');

const HOUR = 3600000;
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const local = (msFromNow) => { const d = new Date(Date.now() + msFromNow); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

// Fixture: admin #1, the six Studio people #11-#16, a PMS viewer #20, an unlinked employee #21.
function fixture() {
  const users = [
    { id: 1, name: 'Admin', role: 'admin', active: true },
    { id: 11, name: 'Bansi', role: 'employee', active: true },
    { id: 12, name: 'Bhavin', role: 'employee', active: true },
    { id: 13, name: 'Vishnu', role: 'employee', active: true },
    { id: 14, name: 'Krutik', role: 'employee', active: true },
    { id: 15, name: 'Dhara', role: 'employee', active: true },
    { id: 16, name: 'Ashmita', role: 'employee', active: true },
    { id: 20, name: 'Viewer', role: 'viewer', active: true },
    { id: 21, name: 'Other Person', role: 'employee', active: true }
  ];
  const studio = Store.emptyStudio();
  const ids = { bansi: 11, bhavin: 12, vishnu: 13, krutik: 14, dhara: 15, ashmita: 16 };
  studio.members.forEach((m) => { m.userId = ids[m.key]; });
  const actor = (id) => P.resolveActor(studio, users.find((u) => u.id === id));
  const ctx = (id, item) => ({ studio, users, actor: actor(id), item, now: new Date() });
  const act = (name, id, item, input) => A.runReelAction(name, ctx(id, item), input || {});
  const create = (fields) => {
    const r = A.createReel(ctx(1), { title: 'Reel', pageId: 'product', priority: 'Medium', shootAt: local(2 * HOUR), ...fields });
    assert.ok(r.ok, r.error);
    return r.reel;
  };
  return { users, studio, actor, ctx, act, create };
}

test('page teams and editor eligibility match the specification exactly', () => {
  assert.deepEqual(C.DEFAULT_PAGE_TEAMS, { product: ['bansi', 'krutik'], farma: ['bansi', 'vishnu'], stencil: ['dhara', 'bhavin'], butterpaper: ['ashmita', 'bhavin'] });
  assert.deepEqual(C.EDITOR_KEYS, ['bansi', 'bhavin', 'vishnu', 'krutik']);
  assert.deepEqual(C.RANKED_KEYS, ['bansi', 'bhavin', 'vishnu', 'krutik']);
  const s = C.defaultSettings();
  assert.deepEqual(P.editorsForPage(s, 'product'), ['bansi', 'krutik']);
  assert.deepEqual(P.editorsForPage(s, 'farma'), ['bansi', 'vishnu']);
  assert.deepEqual(P.editorsForPage(s, 'stencil'), ['bhavin']);
  assert.deepEqual(P.editorsForPage(s, 'butterpaper'), ['bhavin']);
  assert.deepEqual(C.PAGES.map((p) => p.handle), ['@rajarani_product', '@rajarani_farma_patterns', '@rajarani_stencil', '@rajarani_butterpaper']);
});

test('actor resolution comes from the PMS user, not client input', () => {
  const { actor } = fixture();
  assert.equal(actor(1).isManager, true);
  assert.equal(actor(1).canWork, false);
  assert.equal(actor(11).canEditVideo, true);
  assert.equal(actor(15).readOnly, true);
  assert.equal(actor(16).readOnly, true);
  assert.equal(actor(15).canView, true);
  assert.equal(actor(20).readOnly, true);
  assert.equal(actor(21).canView, false);
  assert.equal(P.resolveActor(fixture().studio, { id: 11, name: 'Bansi', role: 'employee', active: false }), null);
});

test('only the admin can create reels; owners are never set at creation', () => {
  const { ctx, create } = fixture();
  assert.equal(A.createReel(ctx(11), { title: 'x', pageId: 'product', shootAt: local(HOUR) }).status, 403);
  assert.equal(A.createReel(ctx(15), { title: 'x', pageId: 'product', shootAt: local(HOUR) }).status, 403);
  assert.equal(A.createReel(ctx(1), { title: '', pageId: 'product', shootAt: local(HOUR) }).status, 400);
  assert.equal(A.createReel(ctx(1), { title: 'x', pageId: 'nope', shootAt: local(HOUR) }).status, 400);
  assert.equal(A.createReel(ctx(1), { title: 'x', pageId: 'product', shootAt: 'not a date' }).status, 400);
  assert.equal(A.createReel(ctx(1), { title: 'x', pageId: 'product', shootAt: local(5 * HOUR), editDeadline: local(HOUR) }).status, 400);
  const r = create({ caption: 'cap', idea: 'idea', prepNotes: 'bring props', editDeadline: local(30 * HOUR), publishAt: local(60 * HOUR) });
  assert.equal(r.shootOwner, null);
  assert.equal(r.editor, null);
  assert.equal(r.publishingOwner, null);
  assert.equal(r.prepNotes, 'bring props');
  assert.equal(W.getStage(r), 'Content Planning');
  assert.equal(r.activity[0].kind, 'create');
});

test('view-only members and viewers are refused every state-changing action', () => {
  const { act, create } = fixture();
  const r = create({ pageId: 'stencil' }); // Dhara IS on the Stencil page team
  for (const name of Object.keys(A.REEL_ACTIONS)) {
    for (const who of [15, 16, 20]) {
      const res = act(name, who, r, { stage: 'Shoot', reason: 'x', notes: 'x', postUrl: 'https://www.instagram.com/reel/x', publishedAt: local(0), publishAt: local(HOUR) });
      assert.equal(res.ok, false, `${name} by ${who} must fail`);
      assert.equal(res.status, 403, `${name} by ${who} must be 403`);
    }
  }
  assert.equal(r.shootOwner, null);
  assert.equal(r.activity.length, 1);
});

test('full workflow: claim → complete shoot → raw footage → edit → publish, with history', () => {
  const { act, create } = fixture();
  const r = create({ pageId: 'product', publishAt: local(48 * HOUR) });
  assert.equal(act('claim-shoot', 13, r).status, 403, 'Vishnu is not on Product');
  assert.ok(act('claim-shoot', 11, r).ok);
  assert.equal(act('claim-shoot', 14, r).status, 409, 'second claim is refused');
  assert.equal(r.shootOwner, 11);
  assert.equal(W.getStage(r), 'Shoot Scheduled');
  assert.equal(act('complete-shoot', 14, r).status, 403, 'only the owner completes');
  assert.ok(act('complete-shoot', 11, r, { notes: 'done', rawSubmitted: '' }).ok);
  assert.equal(r.shoot.completion.by, 11);
  assert.equal(r.shoot.rawSubmitted, false);
  assert.equal(act('claim-edit', 14, r).status, 409, 'editing waits for raw footage');
  assert.equal(act('raw-ready', 14, r).status, 403);
  assert.ok(act('raw-ready', 11, r).ok);
  assert.ok(W.footageReady(r));
  assert.equal(act('claim-edit', 12, r).status, 403, 'Bhavin is not an editor for Product');
  assert.ok(act('claim-edit', 14, r).ok);
  assert.equal(act('claim-edit', 11, r).status, 409);
  assert.equal(W.getStage(r), 'Editing');
  assert.equal(act('publish', 11, r, { postUrl: 'https://www.instagram.com/reel/a', publishedAt: local(0) }).status, 409, 'cannot publish before editing completes');
  assert.ok(act('complete-edit', 14, r, { notes: 'cut' }).ok);
  assert.equal(r.publishing.status, 'Ready to Publish');
  assert.equal(W.getStage(r), 'Ready to Publish');
  assert.ok(act('schedule', 11, r, { publishAt: local(48 * HOUR) }).ok);
  assert.equal(r.publishing.status, 'Scheduled');
  assert.equal(W.isPublished(r), false, 'scheduling is not publishing');
  assert.equal(act('publish', 12, r, { postUrl: 'https://www.instagram.com/reel/a', publishedAt: local(0) }).status, 403, 'Bhavin is not on Product');
  assert.equal(act('publish', 14, r, { postUrl: 'not-a-url', publishedAt: local(0) }).status, 400);
  assert.equal(act('publish', 14, r, { postUrl: 'https://example.com/reel/a', publishedAt: local(0) }).status, 400);
  assert.equal(act('publish', 14, r, { postUrl: 'https://www.instagram.com/reel/a', publishedAt: '' }).status, 400);
  assert.equal(act('publish', 14, r, { postUrl: 'https://www.instagram.com/reel/a', publishedAt: local(3 * HOUR) }).status, 400, 'future time refused');
  assert.ok(act('publish', 14, r, { postUrl: 'https://www.instagram.com/reel/abc123/', publishedAt: local(0), notes: 'posted' }).ok);
  assert.equal(r.publishingOwner, 14, 'the confirming user is the publishing owner');
  assert.equal(r.publishing.completion.by, 14);
  assert.equal(W.getStage(r), 'Published');
  assert.equal(act('publish', 11, r, { postUrl: 'https://www.instagram.com/reel/b', publishedAt: local(0) }).status, 409, 'cannot publish twice');
  const kinds = r.activity.map((e) => e.kind);
  for (const k of ['create', 'claim', 'complete', 'schedule', 'publish']) assert.ok(kinds.includes(k), `activity has ${k}`);
  assert.deepEqual(r.ownershipHistory.map((o) => [o.stage, o.to]), [['Shoot', 11], ['Editing', 14], ['Publishing', 14]]);
});

test('editing eligibility respects page teams; Ashmita/Dhara can never edit', () => {
  const { act, create } = fixture();
  const r = create({ pageId: 'butterpaper' });
  assert.equal(act('claim-shoot', 16, r).status, 403, 'Ashmita is view-only');
  assert.ok(act('claim-shoot', 12, r).ok);
  assert.ok(act('complete-shoot', 12, r, { rawSubmitted: 'on' }).ok);
  for (const who of [11, 13, 14]) assert.equal(act('claim-edit', who, r).status, 403, `user ${who} not an editor for Butterpaper`);
  assert.equal(act('claim-edit', 16, r).status, 403);
  assert.ok(act('claim-edit', 12, r).ok);
});

test('release, reassignment with reason, blockers and reopen keep history', () => {
  const { act, create } = fixture();
  const r = create({ pageId: 'farma' });
  assert.ok(act('claim-shoot', 13, r).ok);
  assert.equal(act('release-shoot', 11, r).status, 403);
  assert.ok(act('release-shoot', 13, r).ok);
  assert.equal(r.shootOwner, null);
  assert.equal(act('assign', 11, r, { stage: 'Shoot', memberKey: 'bansi', reason: 'x' }).status, 403, 'only manager assigns');
  assert.equal(act('assign', 1, r, { stage: 'Shoot', memberKey: 'bansi', reason: '' }).status, 400, 'reason required');
  assert.equal(act('assign', 1, r, { stage: 'Shoot', memberKey: 'krutik', reason: 'x' }).status, 400, 'Krutik not on Farma');
  assert.equal(act('assign', 1, r, { stage: 'Shoot', memberKey: 'dhara', reason: 'x' }).status, 400, 'view-only cannot be assigned');
  assert.ok(act('assign', 1, r, { stage: 'Shoot', memberKey: 'bansi', reason: 'Vishnu on leave' }).ok);
  assert.equal(r.shootOwner, 11);
  assert.ok(act('assign', 1, r, { stage: 'Shoot', memberKey: 'vishnu', reason: 'back from leave' }).ok);
  const last = r.ownershipHistory[r.ownershipHistory.length - 1];
  assert.deepEqual([last.from, last.to, last.reason], [11, 13, 'back from leave']);
  assert.equal(act('blocker', 11, r, { stage: 'Shoot', reason: 'x' }).status, 403, 'non-owner cannot block');
  assert.ok(act('blocker', 13, r, { stage: 'Shoot', reason: 'Sample not delivered' }).ok);
  assert.equal(W.activeBlocker(r.shoot.blocker), true);
  assert.ok(act('resolve-blocker', 13, r, { stage: 'Shoot' }).ok);
  assert.ok(act('complete-shoot', 13, r, { rawSubmitted: 'on' }).ok);
  assert.equal(r.shoot.completion.excused, true, 'documented blocker excuses timeliness');
  assert.ok(act('claim-edit', 13, r).ok);
  assert.ok(act('complete-edit', 13, r).ok);
  const firstCompletion = r.editing.completion;
  assert.equal(act('reopen-edit', 13, r, { reason: '' }).status, 400, 'reason required to reopen');
  assert.equal(act('reopen-edit', 11, r, { reason: 'x' }).status, 403, 'other editor cannot reopen');
  assert.ok(act('reopen-edit', 13, r, { reason: 'Logo missing' }).ok);
  assert.equal(r.editing.status, 'Editing');
  assert.equal(r.editing.completion, null);
  assert.equal(r.publishing.status, 'Not Ready');
  assert.equal(r.editing.previousCompletions.length, 1);
  assert.equal(r.editing.previousCompletions[0].at, firstCompletion.at);
  assert.equal(r.editing.previousCompletions[0].reason, 'Logo missing');
  assert.ok(r.activity.some((e) => e.kind === 'reopen' && e.text.includes('Logo missing')));
});

test('deadline changes record the previous value and need a reason once claimed', () => {
  const { act, create } = fixture();
  const r = create({ pageId: 'product' });
  const before = r.shootAt;
  assert.ok(act('claim-shoot', 11, r).ok);
  const base = { title: r.title, pageId: r.pageId, priority: r.priority, shootAt: local(30 * HOUR), rev: r.rev };
  assert.equal(act('update', 1, r, base).status, 400, 'reason required');
  assert.equal(act('update', 1, r, { ...base, rev: 0, reason: 'x' }).status, 409, 'stale form refused');
  assert.equal(act('update', 1, r, { ...base, pageId: 'farma', reason: 'x' }).status, 409, 'page locked after claim');
  assert.ok(act('update', 1, r, { ...base, reason: 'Stock delayed' }).ok);
  const ch = r.deadlineChanges[0];
  assert.deepEqual([ch.field, ch.from, ch.reason], ['shootAt', before, 'Stock delayed']);
  assert.ok(r.activity.some((e) => e.kind === 'deadline'));
});

test('soft delete hides the reel and keeps its record', () => {
  const { act, create, studio } = fixture();
  const r = create({});
  assert.equal(act('delete', 11, r).status, 403);
  assert.ok(act('delete', 1, r).ok);
  assert.ok(r.deletedAt);
  assert.equal(studio.reels.length, 1);
  assert.equal(act('claim-shoot', 11, r).status, 404);
});

test('migration adds Studio data once, never overwrites, and only links unambiguous names', () => {
  const db = { users: [
    { id: 1, name: 'Admin', role: 'admin', active: true },
    { id: 2, name: 'Bansi Patel', role: 'employee', active: true },
    { id: 3, name: 'Bhavin', role: 'employee', active: true },
    { id: 4, name: 'Bhavin Shah', role: 'employee', active: true },
    { id: 5, name: 'Dhara', role: 'employee', active: false },
    { id: 6, name: 'Krutik', role: 'viewer', active: true }
  ], tasks: [{ id: 1 }] };
  assert.equal(Store.migrateStudio(db), true);
  const links = Object.fromEntries(db.socialStudio.members.map((m) => [m.key, m.userId]));
  assert.deepEqual(links, { bansi: 2, bhavin: null, vishnu: null, krutik: null, dhara: null, ashmita: null });
  db.socialStudio.reels.push({ id: 1 });
  assert.equal(Store.migrateStudio(db), false, 're-running is a no-op');
  assert.equal(db.socialStudio.reels.length, 1);
  assert.equal(db.users.length, 6, 'no users created');
  const report = Store.autoLinkMembers(db, db.socialStudio, 1);
  assert.match(report.find((x) => x.key === 'bhavin').reason, /2 PMS users match/);
  assert.match(report.find((x) => x.key === 'dhara').reason, /No active PMS user/);
});

test('settings are sanitised server-side', () => {
  const s = Store.sanitizeSettings({ targets: { product: 999, farma: '12' }, weights: { onTime: -5, editing: 30 }, ranking: { minDueTasks: 5, provisionalBelow: 2 }, pageTeams: { product: ['bansi', 'hacker'], farma: [] } });
  assert.equal(s.targets.product, 20);
  assert.equal(s.targets.farma, 12);
  assert.equal(s.weights.onTime, 35);
  assert.equal(s.weights.editing, 30);
  assert.equal(s.ranking.provisionalBelow, 5);
  assert.deepEqual(s.pageTeams.product, ['bansi']);
  assert.deepEqual(s.pageTeams.farma, ['bansi', 'vishnu']);
});

// ---------------------------------------------------------------- scoring
// Builds a completed reel directly (bypassing claim timing) for deterministic scoring tests.
function doneReel(id, pageId, { shootBy, editBy, pubBy, onTime = true, raw = true, at = iso(-2 * HOUR), publishAt }) {
  const c = (by) => (by ? { by, byName: '', at, deadline: iso(onTime ? HOUR : -10 * HOUR), onTime } : null);
  return {
    id, title: `R${id}`, pageId, priority: 'Medium', shootAt: iso(-48 * HOUR), editDeadline: null, publishAt: publishAt || null,
    shootOwner: shootBy || null, editor: editBy || null, publishingOwner: pubBy || null,
    shoot: { status: shootBy ? 'Completed' : 'Unclaimed', claimedAt: iso(-50 * HOUR), rawSubmitted: !!shootBy && raw, rawSubmittedAt: at, completion: c(shootBy), blocker: null, notes: '' },
    editing: { status: editBy ? 'Editing Completed' : 'Not Started', claimedAt: iso(-20 * HOUR), completion: c(editBy), blocker: null, notes: '' },
    publishing: { status: pubBy ? 'Published' : editBy ? 'Ready to Publish' : 'Not Ready', completion: pubBy ? c(pubBy) : null, notes: '' },
    activity: [], deadlineChanges: [], ownershipHistory: []
  };
}

test('ranking includes only Bansi, Bhavin, Vishnu and Krutik; Dhara/Ashmita work is never scored', () => {
  const { studio, users } = fixture();
  const now = new Date();
  const today = W.localDay(now);
  const from = W.localDay(W.addDaysD(now, -30));
  const items = [doneReel(1, 'stencil', { shootBy: 15, editBy: 12 }), doneReel(2, 'butterpaper', { shootBy: 16, editBy: 12, pubBy: 16 })];
  const general = S.computeGeneralScores(studio, users, items, now, from, today);
  assert.deepEqual(general.map((g) => g.userId).sort(), [11, 12, 13, 14]);
  assert.ok(!general.some((g) => [15, 16].includes(g.userId)));
  const editing = S.computeEditingScores(studio, users, items, now, from, today);
  assert.deepEqual(editing.map((g) => g.userId).sort(), [11, 12, 13, 14]);
  assert.equal(general.find((g) => g.userId === 12).categories.Editing.completed, 2);
  assert.equal(general.find((g) => g.userId === 12).categories.Shoot.completed, 0, 'no credit for shoots done by Dhara/Ashmita');
});

test('scoring: thresholds, normalised weights, shared ranks, exclusions', () => {
  const { studio, users } = fixture();
  studio.settings.ranking = { minDueTasks: 3, provisionalBelow: 8 };
  const now = new Date();
  const today = W.localDay(now);
  const from = W.localDay(W.addDaysD(now, -30));
  const items = [];
  let id = 1;
  // Bansi and Krutik: identical records (4 on-time shoots each) → tie.
  for (let k = 0; k < 4; k++) { items.push(doneReel(id++, 'product', { shootBy: 11 })); items.push(doneReel(id++, 'product', { shootBy: 14 })); }
  // Vishnu: one late shoot only → insufficient data.
  items.push(doneReel(id++, 'farma', { shootBy: 13, onTime: false }));
  // Unclaimed overdue reel: attributed to nobody.
  items.push({ ...doneReel(id++, 'farma', {}), shoot: { status: 'Unclaimed', claimedAt: null, rawSubmitted: false, completion: null, blocker: null, notes: '' } });
  // Bhavin: claimed but not yet due → workload only.
  const open = doneReel(id++, 'stencil', {});
  open.shootOwner = 12; open.shoot.status = 'In Progress'; open.shootAt = iso(72 * HOUR); open.shoot.claimedAt = iso(-HOUR);
  items.push(open);

  // The period runs a week ahead so Bhavin's claimed-but-not-due shoot falls inside it.
  const g = Object.fromEntries(S.computeGeneralScores(studio, users, items, now, from, W.localDay(W.addDaysD(now, 7))).map((x) => [x.userId, x]));
  assert.ok(today);
  assert.equal(g[11].status, 'Provisional');
  assert.equal(g[11].score, 100);
  assert.equal(g[11].score, g[14].score);
  assert.equal(g[11].rank, 1);
  assert.equal(g[14].rank, 1, 'equal scores share a rank');
  assert.equal(g[11].tied, true);
  assert.equal(g[13].status, 'Insufficient Data');
  assert.equal(g[13].score, null);
  assert.equal(g[13].rank, null);
  assert.equal(g[12].totals.due, 0);
  assert.equal(g[12].totals.openNotDue, 1, 'not-yet-due work is workload only');
  assert.ok(g[12].exclusions.some((x) => /not due yet/.test(x)));
  // Only on-time + shoot delivery apply to Bansi → editing/publishing excluded and weights re-normalised.
  const comps = Object.fromEntries(g[11].components.map((c) => [c.key, c]));
  assert.equal(comps.editing.ratio, null);
  assert.equal(comps.publishing.ratio, null);
  assert.ok(Math.abs(comps.onTime.effectiveWeight - (35 / 60) * 100) < 1e-9);
  assert.ok(Math.abs(comps.onTime.effectiveWeight + comps.shootDelivery.effectiveWeight - 100) < 1e-9);
  const totalCompleted = Object.values(g).reduce((s, x) => s + x.totals.completed, 0);
  assert.equal(totalCompleted, 9, 'each completion credited exactly once; unclaimed work credited to nobody');
});

test('scoring weights 35/25/25/15 combine as documented', () => {
  const { studio, users } = fixture();
  studio.settings.ranking = { minDueTasks: 1, provisionalBelow: 1 };
  const now = new Date();
  const items = [
    doneReel(1, 'product', { shootBy: 11, editBy: 11, pubBy: 11, publishAt: iso(-3 * HOUR) }),
    doneReel(2, 'product', { shootBy: 11, editBy: 11, pubBy: 11, onTime: false, raw: true, publishAt: iso(-3 * HOUR) })
  ];
  const b = S.computeGeneralScores(studio, users, items, now, W.localDay(W.addDaysD(now, -30)), W.localDay(now)).find((x) => x.userId === 11);
  const comps = Object.fromEntries(b.components.map((c) => [c.key, c]));
  assert.deepEqual(Object.values(comps).map((c) => c.weight), [35, 25, 25, 15]);
  // onTime 3/6, shoot delivery 2/2, editing 0.5*1 + 0.5*0.5, publishing 1/2
  assert.equal(comps.onTime.ratio, 0.5);
  assert.equal(comps.shootDelivery.ratio, 1);
  assert.equal(comps.editing.ratio, 0.75);
  assert.equal(comps.publishing.ratio, 0.5);
  assert.equal(b.score, Math.round(35 * 0.5 + 25 * 1 + 25 * 0.75 + 15 * 0.5));
});

test('overdue rules: unclaimed overdue tasks are reported but not attributed', () => {
  const { create } = fixture();
  const r = create({ shootAt: local(-72 * HOUR) });
  const tasks = W.deriveTasks([r], new Date(), C.defaultSettings());
  const shoot = tasks.find((t) => t.type === 'Shoot');
  assert.equal(shoot.overdue, true);
  assert.equal(shoot.assignee, null);
  assert.equal(shoot.claimable, true);
});

test('late claim gets a grace window from the claim time', () => {
  const { act, create } = fixture();
  const r = create({ shootAt: local(-72 * HOUR) });
  assert.ok(act('claim-shoot', 11, r).ok);
  assert.equal(W.isShootOverdue(r, new Date()), false);
  assert.ok(act('complete-shoot', 11, r, { rawSubmitted: 'on' }).ok);
  assert.equal(r.shoot.completion.onTime, true);
});
