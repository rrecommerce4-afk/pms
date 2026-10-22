// Weekly publishing schedule + mandatory 24-hour editing deadline (unit level).
// Times typed into forms are read in the PMS business time zone (server.js); the tests build
// their form values in the same zone so they behave the same on any machine.
process.env.TZ = 'Asia/Kolkata';
const test = require('node:test');
const assert = require('node:assert/strict');
const Sched = require('../lib/studio/schedule');
const Store = require('../lib/studio/store');
const W = require('../lib/studio/workflow');
const P = require('../lib/studio/permissions');
const A = require('../lib/studio/actions');
const S = require('../lib/studio/scoring');
const V = require('../lib/studio/view');

const HOUR = 3600000;
const local = (ms) => { const d = new Date(Date.now() + ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const minuteIso = (ms) => new Date(new Date(Date.now() + ms).setSeconds(0, 0)).toISOString();

function fixture() {
  const users = [{ id: 1, name: 'Admin', role: 'admin', active: true }, { id: 11, name: 'Bansi', role: 'employee', active: true }, { id: 12, name: 'Bhavin', role: 'employee', active: true },
    { id: 13, name: 'Vishnu', role: 'employee', active: true }, { id: 14, name: 'Krutik', role: 'employee', active: true }, { id: 15, name: 'Dhara', role: 'employee', active: true }, { id: 16, name: 'Ashmita', role: 'employee', active: true }];
  const studio = Store.emptyStudio();
  const ids = { bansi: 11, bhavin: 12, vishnu: 13, krutik: 14, dhara: 15, ashmita: 16 };
  studio.members.forEach((m) => { m.userId = ids[m.key]; });
  const ctx = (id, item) => ({ studio, users, actor: P.resolveActor(studio, users.find((u) => u.id === id)), item, now: new Date() });
  const act = (name, id, item, input) => A.runReelAction(name, ctx(id, item), input || {});
  // A reel on Product (Bansi + Krutik) with footage ready and editing claimed by Krutik.
  const editingReel = (publishMs) => {
    const r = A.createReel(ctx(1), { title: 'R', pageId: 'product', shootAt: local(-3 * HOUR), publishAt: publishMs === null ? '' : local(publishMs) }).reel;
    act('claim-shoot', 11, r); act('complete-shoot', 11, r, { rawSubmitted: 'on' }); act('claim-edit', 14, r);
    return r;
  };
  return { users, studio, ctx, act, editingReel };
}

// ---------------------------------------------------------------- weekly schedule
test('each page keeps its own weekly schedule; multiple slots per day are sorted and de-duplicated', () => {
  const week = Sched.parseWeekForm({ mon_enabled: 'on', mon_slots: ['18:30', '13:00', '13:00'], tue_enabled: 'on', tue_slots: '9:05', thu_slots: '17:00' });
  assert.equal(week.error, undefined);
  assert.deepEqual(week.week.mon, { enabled: true, slots: ['13:00', '18:30'] });
  assert.deepEqual(week.week.tue, { enabled: true, slots: ['09:05'] });
  assert.deepEqual(week.week.thu, { enabled: false, slots: ['17:00'] }, 'disabled day keeps its times but is off');
  const all = Store.sanitizeSettings({ publishingSchedule: { product: week.week, farma: { fri: { enabled: true, slots: ['17:00'] } } } }).publishingSchedule;
  assert.deepEqual(all.product.mon.slots, ['13:00', '18:30']);
  assert.deepEqual(all.farma.fri, { enabled: true, slots: ['17:00'] });
  assert.deepEqual(all.stencil.mon, { enabled: false, slots: [] }, 'pages without a schedule stay empty');
  assert.deepEqual(Object.keys(all), ['product', 'farma', 'stencil', 'butterpaper']);
});

test('invalid times are rejected, not silently dropped; nothing is hard-coded by default', () => {
  assert.match(Sched.parseWeekForm({ mon_enabled: 'on', mon_slots: '25:99' }).error, /Monday: "25:99" is not a valid time/);
  assert.match(Sched.parseWeekForm({ wed_slots: ['12:00', 'noon'] }).error, /Wednesday/);
  assert.equal(Sched.parseWeekForm({ fri_slots: Array.from({ length: 11 }, (_, i) => `1${i % 10}:0${i % 6}`) }).error !== undefined, true);
  const def = Store.emptyStudio().settings.publishingSchedule;
  assert.ok(Object.values(def).every((wk) => Sched.DAYS.every((d) => !wk[d].enabled && !wk[d].slots.length)), 'default schedule is empty');
  assert.equal(Sched.fmtSlot('13:00'), '1:00 PM');
  assert.equal(Sched.fmtSlot('00:15'), '12:15 AM');
});

test('next slot skips disabled and empty days and returns null when nothing is configured', () => {
  const wk = Sched.emptyWeek();
  wk.mon = { enabled: false, slots: ['10:00'] };
  wk.tue = { enabled: true, slots: [] };
  wk.wed = { enabled: true, slots: ['12:00', '15:00'] };
  const schedule = { ...Sched.emptySchedule(), product: wk };
  const monday = new Date(2026, 9, 26, 8, 0); // Mon 26 Oct 2026, 08:00 local
  assert.equal(monday.getDay(), 1);
  const next = Sched.nextSlot(schedule, 'product', monday);
  assert.deepEqual([next.getDay(), next.getHours(), next.getMinutes()], [3, 12, 0], 'Wednesday 12:00');
  assert.equal(Sched.nextSlot(schedule, 'product', new Date(2026, 9, 28, 12, 0)).getHours(), 15, 'strictly after: 12:00 → 15:00');
  assert.equal(Sched.nextSlot(schedule, 'product', new Date(2026, 9, 28, 16, 0)).getDate(), 4, 'rolls to next Wednesday (4 Nov)');
  assert.deepEqual(Sched.slotsForDate(schedule, 'product', '2026-10-26'), [], 'disabled Monday offers no slots');
  assert.equal(Sched.slotsForDate(schedule, 'product', '2026-10-28').length, 2);
  assert.equal(Sched.nextSlot(schedule, 'farma', monday), null, 'other page unaffected and unconfigured');
  assert.equal(Sched.hasAnySlot(schedule, 'farma'), false);
});

test('suggested slots leave 24 h for editing after the shoot until editing is done', () => {
  const studio = Store.emptyStudio();
  const wk = Sched.emptyWeek();
  Sched.DAYS.forEach((d) => { wk[d] = { enabled: true, slots: ['17:00'] }; }); // every day at 5 PM
  studio.settings.publishingSchedule = { ...Sched.emptySchedule(), product: wk };
  const now = new Date(2026, 9, 22, 9, 0);
  const item = { pageId: 'product', shootAt: new Date(2026, 9, 23, 11, 0).toISOString(), editing: { status: 'Not Started' } };
  const s = V.nextSlotFor(studio, item, now);
  assert.deepEqual([s.getDate(), s.getHours()], [24, 17], 'not 23 Oct 5 PM (deadline would be before the shoot) but 24 Oct 5 PM');
  assert.ok(s - new Date(item.shootAt) >= 24 * HOUR);
  const done = { ...item, editing: { status: 'Editing Completed' } };
  assert.deepEqual([V.nextSlotFor(studio, done, now).getDate(), V.nextSlotFor(studio, done, now).getHours()], [22, 17], 'edited reels can take the next slot');
  assert.match(V.slotHint(studio, { ...item, pageId: 'farma' }, now), /No publishing schedule is configured for Farma Pattern/);
});

// ---------------------------------------------------------------- 24-hour deadline
test('editing deadline is exactly 24 hours before the saved publishing time, and absent without one', () => {
  const { ctx } = fixture();
  const r = A.createReel(ctx(1), { title: 'x', pageId: 'stencil', shootAt: local(HOUR), publishAt: '2026-11-25T18:00' }).reel;
  assert.equal(r.editingDeadline, new Date(2026, 10, 24, 18, 0).toISOString(), '25 Nov 6:00 PM → 24 Nov 6:00 PM');
  assert.equal(Date.parse(r.publishAt) - Date.parse(r.editingDeadline), 24 * HOUR);
  const none = A.createReel(ctx(1), { title: 'y', pageId: 'stencil', shootAt: local(HOUR) }).reel;
  assert.equal(none.editingDeadline, null);
  assert.equal(W.editingDeadline(none), undefined);
  assert.equal(V.editDeadlineInfo(none).missing, true, 'no fabricated deadline (Case E)');
  assert.equal(W.isEditOverdue(none, new Date(Date.now() + 1000 * HOUR)), false);
});

test('changing a reel publishing time recalculates its deadline and keeps full history (Case B)', () => {
  const { act, ctx } = fixture();
  const r = A.createReel(ctx(1), { title: 'x', pageId: 'product', shootAt: local(HOUR), publishAt: local(72 * HOUR) }).reel;
  const oldPub = r.publishAt, oldDl = r.editingDeadline;
  assert.equal(act('reschedule', 1, r, { publishAt: local(96 * HOUR) }).status, 400, 'reason required to move an existing time');
  assert.equal(act('reschedule', 11, r, { publishAt: local(96 * HOUR), reason: 'x' }).status, 403, 'only the manager reschedules');
  assert.ok(act('reschedule', 1, r, { publishAt: local(96 * HOUR), reason: 'Moved to Friday slot' }).ok);
  assert.equal(r.publishAt, minuteIso(96 * HOUR));
  assert.equal(r.editingDeadline, new Date(Date.parse(r.publishAt) - 24 * HOUR).toISOString());
  const [p, e] = r.deadlineChanges.slice(-2);
  assert.deepEqual([p.field, p.from, p.to, p.reason, p.by], ['publishAt', oldPub, r.publishAt, 'Moved to Friday slot', 1]);
  assert.deepEqual([e.field, e.from, e.to, e.reason], ['editingDeadline', oldDl, r.editingDeadline, 'Moved to Friday slot']);
  assert.ok(r.activity.some((x) => x.kind === 'deadline' && /editing deadline/.test(x.text) && /Moved to Friday slot/.test(x.text)));
  // Through the reel form as well; removing the time removes the deadline (no invented one).
  const base = { title: r.title, pageId: r.pageId, priority: r.priority, shootAt: local(HOUR), rev: r.rev };
  assert.equal(act('update', 1, r, { ...base, shootAt: r.shootAt, publishAt: '' }).status, 400, 'reason required');
  assert.ok(act('update', 1, r, { ...base, shootAt: r.shootAt, publishAt: '', reason: 'On hold' }).ok);
  assert.equal(r.publishAt, null);
  assert.equal(r.editingDeadline, null);
});

test('on time = completed at or before the deadline; late after it — using server time only', () => {
  const dl = new Date('2026-10-24T12:30:00.000Z');
  assert.equal(W.makeCompletion(14, 'K', '2026-10-24T12:30:00.000Z', dl, false).onTime, true, 'exactly at the deadline counts as on time');
  assert.equal(W.makeCompletion(14, 'K', '2026-10-24T12:30:00.001Z', dl, false).onTime, false);
  const { act, editingReel } = fixture();
  const onTime = editingReel(72 * HOUR); // deadline in ~48 h
  assert.ok(act('complete-edit', 14, onTime, { notes: 'done', at: '2020-01-01T00:00:00Z', completedAt: '2020-01-01T00:00:00Z', onTime: 'false' }).ok);
  assert.equal(onTime.editing.completion.onTime, true);
  assert.ok(Math.abs(Date.parse(onTime.editing.completion.at) - Date.now()) < 5000, 'server clock, not the submitted time');
  assert.equal(onTime.editing.completion.by, 14);
  assert.equal(onTime.editing.completion.deadline, onTime.editingDeadline);
  const late = editingReel(20 * HOUR); // deadline was 4 h ago, but publishing is still 20 h away
  assert.equal(W.isEditOverdue(late, new Date()), true);
  assert.ok(act('complete-edit', 14, late, { onTime: 'true', completion: { onTime: true } }).ok);
  assert.equal(late.editing.completion.onTime, false, 'late even though completed before publication');
  assert.equal(late.publishing.status, 'Ready to Publish');
});

test('Editing Overdue is a separate warning; the workflow status is not overwritten', () => {
  const { editingReel } = fixture();
  const r = editingReel(10 * HOUR);
  const task = W.deriveTasks([r], new Date(), Store.emptyStudio().settings).find((t) => t.type === 'Editing');
  assert.equal(task.status, 'Editing', 'still Editing');
  assert.equal(task.overdue, true);
  assert.equal(r.editing.status, 'Editing');
  assert.equal(W.getStage(r), 'Editing');
  assert.match(V.editDeadlineHtml(r, new Date()), /Editing Overdue/);
});

test('scheduling inside 24 hours warns immediately and never moves the deadline (Case D)', () => {
  const { ctx } = fixture();
  const res = A.createReel(ctx(1), { title: 'x', pageId: 'farma', shootAt: local(-2 * HOUR), publishAt: local(6 * HOUR) });
  assert.match(res.message, /Warning: the editing deadline .* has already passed/);
  assert.equal(res.reel.editingDeadline, new Date(Date.parse(res.reel.publishAt) - 24 * HOUR).toISOString());
  assert.equal(W.isEditOverdue(res.reel, new Date()), true);
});

test('schedule change after editing keeps the original completion and result (Case C)', () => {
  const { act, editingReel, studio, users } = fixture();
  const r = editingReel(72 * HOUR);
  assert.ok(act('complete-edit', 14, r).ok);
  const original = { ...r.editing.completion };
  assert.equal(original.onTime, true);
  // Publishing pulled forward to 10 h from now: the new deadline is already in the past.
  assert.ok(act('schedule', 11, r, { publishAt: local(10 * HOUR), reason: 'Launch moved up' }).ok);
  assert.deepEqual(r.editing.completion, original, 'completion record untouched');
  assert.equal(r.editingDeadline, new Date(Date.parse(r.publishAt) - 24 * HOUR).toISOString());
  const info = V.editDeadlineInfo(r, new Date());
  assert.equal(info.meetsCurrent, false, 'exposes that it misses the current deadline');
  assert.equal(info.judgedAgainstOld, true);
  assert.ok(r.activity.some((x) => /original result \(on time\) is kept/.test(x.text)));
  // Scoring keeps the historical result: still one on-time edit, not rewritten to late.
  const now = new Date();
  const krutik = S.computeEditingScores(studio, users, [r], now, W.localDay(W.addDaysD(now, -1)), W.localDay(W.addDaysD(now, 1))).find((x) => x.userId === 14);
  assert.deepEqual([krutik.stats.onTime, krutik.stats.late], [1, 0]);
});

test('reopening preserves the earlier completion and its result; the next completion is a new event', () => {
  const { act, editingReel } = fixture();
  const r = editingReel(20 * HOUR); // late
  assert.ok(act('complete-edit', 14, r).ok);
  const first = { ...r.editing.completion };
  assert.equal(first.onTime, false);
  assert.ok(act('reopen-edit', 14, r, { reason: 'Wrong logo' }).ok);
  assert.ok(act('complete-edit', 14, r).ok);
  assert.equal(r.editing.previousCompletions.length, 1);
  assert.equal(r.editing.previousCompletions[0].at, first.at);
  assert.equal(r.editing.previousCompletions[0].onTime, false, 'original late result preserved');
  assert.equal(r.activity.filter((x) => x.kind === 'complete' && x.stage === 'Editing').length, 2);
});

test('editing timeliness in scoring uses the 24-hour deadline; only the four ranked employees count', () => {
  const { act, editingReel, studio, users } = fixture();
  const late = editingReel(20 * HOUR);
  act('complete-edit', 14, late);
  const onTime = editingReel(72 * HOUR);
  act('complete-edit', 14, onTime);
  const now = new Date();
  const from = W.localDay(W.addDaysD(now, -1)), to = W.localDay(W.addDaysD(now, 1));
  const krutik = S.computeEditingScores(studio, users, [late, onTime], now, from, to).find((s) => s.userId === 14);
  assert.deepEqual([krutik.stats.completed, krutik.stats.onTime, krutik.stats.late], [2, 1, 1]);
  const general = S.computeGeneralScores(studio, users, [late, onTime], now, from, to);
  assert.deepEqual(general.map((g) => g.userId).sort(), [11, 12, 13, 14]);
  assert.deepEqual(Object.values(studio.settings.weights), [35, 25, 25, 15], 'weights unchanged');
});

test('a post cannot stay "Scheduled" without a publishing time', () => {
  const { act, editingReel } = fixture();
  const r = editingReel(72 * HOUR);
  act('complete-edit', 14, r);
  assert.ok(act('schedule', 11, r).ok);
  assert.equal(r.publishing.status, 'Scheduled');
  const base = { title: r.title, pageId: r.pageId, priority: r.priority, shootAt: r.shootAt, rev: r.rev };
  assert.ok(act('update', 1, r, { ...base, publishAt: '', reason: 'Date not fixed yet' }).ok);
  assert.equal(r.publishAt, null);
  assert.equal(r.publishing.status, 'Ready to Publish');
  assert.ok(r.activity.some((x) => /no longer scheduled/.test(x.text)));
  // Older data stuck as Scheduled with no time is shown as Ready to Publish and can be scheduled again.
  r.publishing.status = 'Scheduled';
  assert.equal(W.getPublishStatus(r, new Date()), 'Ready to Publish');
  const actor = P.resolveActor(fixture().studio, { id: 11, name: 'Bansi', role: 'employee', active: true });
  assert.ok(V.stageActions(actor, fixture().studio, r, 'Publishing', () => '', false).some((x) => x.modal === 'schedule'));
});

test('view-only users cannot schedule or reschedule; invalid times are refused safely', () => {
  const { act, editingReel } = fixture();
  const r = editingReel(72 * HOUR);
  act('complete-edit', 14, r);
  for (const who of [15, 16]) {
    assert.equal(act('schedule', who, r, { publishAt: local(80 * HOUR), reason: 'x' }).status, 403);
    assert.equal(act('reschedule', who, r, { publishAt: local(80 * HOUR), reason: 'x' }).status, 403);
  }
  assert.equal(act('schedule', 11, r, { publishAt: 'tomorrow 5pm' }).status, 400);
  assert.equal(act('reschedule', 1, r, { publishAt: '', reason: 'x' }).status, 400);
  assert.equal(act('schedule', 11, r, { publishAt: local(90 * HOUR) }).status, 400, 'changing an existing time needs a reason');
});

test('schema v5 migration fills saved deadlines, keeps an old manual deadline for reference, and is repeatable', () => {
  const db = { socialStudio: Store.emptyStudio() };
  db.socialStudio.reels.push({ id: 1, publishAt: '2026-11-10T12:30:00.000Z', editDeadline: '2026-11-08T10:00:00.000Z', activity: [] }, { id: 2, publishAt: null, activity: [] });
  assert.equal(Store.migrateEditingDeadlines(db), true);
  const [a, b] = db.socialStudio.reels;
  assert.equal(a.editingDeadline, '2026-11-09T12:30:00.000Z');
  assert.equal(a.legacyEditDeadline, '2026-11-08T10:00:00.000Z');
  assert.equal(a.editDeadline, undefined);
  assert.equal(a.activity.length, 1);
  assert.equal(b.editingDeadline, null);
  assert.equal(Store.migrateEditingDeadlines(db), false, 'second run changes nothing');
  assert.equal(a.activity.length, 1);
});
