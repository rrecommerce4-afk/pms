// Social Media Studio — mounted at /social-media. Server-rendered port of the standalone
// Studio's eleven screens, backed by db.socialStudio. Identity comes only from the PMS session.
const express = require('express');
const crypto = require('crypto');
const { load, save, logActivity } = require('../db');
const { requireLogin } = require('../middleware/auth');
const C = require('../lib/studio/config');
const W = require('../lib/studio/workflow');
const P = require('../lib/studio/permissions');
const S = require('../lib/studio/scoring');
const F = require('../lib/studio/followers');
const V = require('../lib/studio/view');
const A = require('../lib/studio/actions');
const Store = require('../lib/studio/store');
const Nav = require('../lib/studio/nav');
const IG = require('../lib/studio/instagram');
const Sched = require('../lib/studio/schedule');

const router = express.Router();
router.use(requireLogin);

const live = (studio) => studio.reels.filter((r) => !r.deletedAt);
const findReel = (studio, id) => studio.reels.find((r) => String(r.id) === String(id) && !r.deletedAt) || null;

// Only same-module relative paths are accepted as redirect targets.
function safeReturn(v, fallback) {
  return typeof v === 'string' && /^\/social-media(\/[A-Za-z0-9\-_/]*)?(\?[A-Za-z0-9\-_=&%.:+]*)?(#[A-Za-z0-9\-_]*)?$/.test(v) && !v.includes('//') ? v : fallback;
}
function flash(req, type, text) { req.session.studioFlash = { type, text }; }

function loadCtx(req) {
  const db = load();
  const studio = Store.getStudio(db);
  const user = db.users.find((u) => u.id === req.session.userId) || null;
  const actor = P.resolveActor(studio, user);
  return { db, studio, user, actor, users: db.users, now: new Date() };
}

// Sidebar locals the admin/employee routers normally provide, so the shell looks the same here.
function sidebarLocals(res, db, user) {
  if (user.role === 'admin') {
    res.locals.navCounts = {
      all: db.tasks.length,
      review: db.tasks.filter((t) => t.status === 'review').length,
      myTasks: db.tasks.filter((t) => t.assignedTo === user.id).length
    };
  } else if (user.role === 'employee') {
    res.locals.navCounts = { myTasks: db.tasks.filter((t) => t.assignedTo === user.id).length };
    if (user.isDeptHead && user.department) { res.locals.isDeptHead = true; res.locals.roleLabel = 'Department Head'; }
  }
}

function forbidden(res, message) {
  return res.status(403).render('social/forbidden', { message: message || "You don't have access to this part of the Social Media Studio." });
}

function currentRange(req, now) {
  const r = req.session.studioRange || { preset: 'this-month' };
  return V.rangeFromPreset(r.preset, now, r);
}

// Port of the Studio's useNotifications: personalised to the user's pages.
function notificationsFor(ctx) {
  const { studio, actor, now } = ctx;
  const st = studio.settings;
  const pages = P.pagesFor(actor, st);
  const people = V.peopleHelpers(ctx.users, studio);
  const list = [];
  for (const i of live(studio)) {
    if (!pages.includes(i.pageId)) continue;
    const pg = C.getPage(i.pageId).shortName;
    if (st.notifications.overdue && W.isItemOverdue(i, now, st)) {
      const owner = !W.isShootDone(i) ? i.shootOwner : !W.isEditingDone(i) ? i.editor : null;
      list.push({ id: `over:${i.id}:${i.publishing.status}:${i.editing.status}:${i.shoot.status}`, reelId: i.id, title: owner ? 'Overdue' : 'Overdue & unclaimed', body: `${i.title} · ${pg}${owner ? ` · ${people.nameOf(owner)}` : ''}`, kind: 'overdue', at: W.plannedDate(i) });
    }
    if (st.notifications.editing && i.editing.completion && i.publishing.status === 'Ready to Publish') {
      list.push({ id: `edit:${i.id}:${i.editing.completion.at}`, reelId: i.id, title: 'Editing completed', body: `${i.title} by ${people.nameOf(i.editing.completion.by)} is ready to publish`, kind: 'editing', at: i.editing.completion.at });
    }
    if (W.footageReady(i) && i.editing.status === 'Not Started' && i.shoot.completion && (actor.isManager || actor.canEditVideo)) {
      list.push({ id: `avail:${i.id}`, reelId: i.id, title: 'Editing available to claim', body: `${i.title} · ${pg}`, kind: 'available', at: i.shoot.rawSubmittedAt || i.shoot.completion.at });
    }
    const ps = W.getPublishStatus(i, now);
    if (st.notifications.publishing && (ps === 'Ready to Publish' || ps === 'Scheduled') && i.publishAt && new Date(i.publishAt).getTime() - now.getTime() < 24 * 3600000) {
      list.push({ id: `pub:${i.id}:${ps}`, reelId: i.id, title: ps === 'Scheduled' ? 'Post going live soon' : 'Ready to publish', body: `${i.title} is planned within 24 hours`, kind: 'publishing', at: i.publishAt });
    }
  }
  const read = new Set(studio.readNotifications[actor.userId] || []);
  return list.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40).map((n) => ({ ...n, unread: !read.has(n.id) }));
}

// ---------------------------------------------------------------- shared middleware
router.use((req, res, next) => {
  const ctx = loadCtx(req);
  if (!ctx.user || !ctx.user.active) return req.session.destroy(() => res.redirect('/login'));
  sidebarLocals(res, ctx.db, ctx.user);
  if (!ctx.actor || !ctx.actor.canView) return forbidden(res, 'The Social Media Studio is available to admins, viewers and the Studio team members linked by an admin.');

  if (!req.session.studioCsrf) req.session.studioCsrf = crypto.randomBytes(24).toString('hex');
  if (req.method === 'POST') {
    const sent = req.body && typeof req.body._csrf === 'string' ? req.body._csrf : '';
    const expected = req.session.studioCsrf;
    if (sent.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected))) {
      return forbidden(res, 'This form has expired or did not come from the PMS. Reload the page and try again.');
    }
    // Central guard: view-only users (Dhara, Ashmita, PMS viewers) can't change Studio data.
    // Only their own period selection and notification read-state are personal preferences.
    const personal = req.path === '/range' || req.path === '/notifications/read';
    if (ctx.actor.readOnly && !personal) return forbidden(res, "Your Studio access is view-only, so this action isn't available.");
  }

  req.sm = ctx;
  const range = currentRange(req, ctx.now);
  const notifications = notificationsFor(ctx);
  const linked = ctx.studio.members.filter((m) => m.userId).length;
  res.locals.V = V;
  res.locals.C = C;
  res.locals.W = W;
  res.locals.P = P;
  res.locals.S = S;
  res.locals.Sched = Sched;
  res.locals.sm = {
    actor: ctx.actor,
    studio: ctx.studio,
    settings: ctx.studio.settings,
    now: ctx.now,
    range,
    csrf: req.session.studioCsrf,
    people: V.peopleHelpers(ctx.users, ctx.studio),
    currentUrl: req.originalUrl,
    flash: req.session.studioFlash || null,
    notifications,
    unread: notifications.filter((n) => n.unread).length,
    nav: Nav.STUDIO_NAV,
    src: F.sources(ctx.studio),
    unlinkedCount: C.ROSTER.length - linked
  };
  delete req.session.studioFlash;
  next();
});

function render(res, view, crumb, data) {
  res.render(`social/${view}`, Object.assign({ crumb, smView: view }, data));
}

// ---------------------------------------------------------------- personal preferences
router.post('/range', (req, res) => {
  const preset = V.PRESETS.some((p) => p.value === req.body.preset) ? req.body.preset : 'this-month';
  req.session.studioRange = V.rangeFromPreset(preset, new Date(), { from: req.body.from, to: req.body.to });
  res.redirect(303, safeReturn(req.body.returnTo, '/social-media'));
});

router.post('/notifications/read', (req, res) => {
  const ctx = loadCtx(req);
  const ids = notificationsFor(ctx).map((n) => n.id);
  const only = typeof req.body.id === 'string' ? [req.body.id] : ids;
  const key = String(ctx.actor.userId);
  ctx.studio.readNotifications[key] = [...new Set([...(ctx.studio.readNotifications[key] || []), ...only.filter((x) => ids.includes(x))])].slice(-500);
  save(ctx.db);
  const target = typeof req.body.reel === 'string' && /^\d+$/.test(req.body.reel) ? `/social-media/reels/${req.body.reel}` : safeReturn(req.body.returnTo, '/social-media');
  res.redirect(303, target);
});

// ---------------------------------------------------------------- shared calculations
function monthBounds(now) {
  return { from: W.localDay(new Date(now.getFullYear(), now.getMonth(), 1)), to: W.localDay(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
}

function pageProgress(items, settings, now) {
  const { from, to } = monthBounds(now);
  const out = {};
  C.PAGES.forEach((p) => {
    const all = items.filter((i) => i.pageId === p.id);
    const month = all.filter((i) => W.inRange(W.plannedDate(i), from, to));
    const published = all.filter((i) => i.publishing.completion && W.inRange(i.publishing.completion.at, from, to)).length;
    const target = settings.targets[p.id];
    out[p.id] = {
      pageId: p.id, target, planned: month.length, published,
      remaining: Math.max(0, target - published),
      pct: target ? Math.min(100, (published / target) * 100) : 0,
      shootsAvailable: all.filter((i) => i.shoot.status === 'Unclaimed').length,
      editingAvailable: all.filter((i) => W.footageReady(i) && i.editing.status === 'Not Started').length,
      inProduction: month.filter((i) => !W.isEditingDone(i)).length,
      readyToPublish: all.filter((i) => W.isEditingDone(i) && i.publishing.status === 'Ready to Publish').length,
      scheduled: all.filter((i) => i.publishing.status === 'Scheduled').length
    };
  });
  return out;
}

// The follower period never extends past today.
function followerWindow(range, now) {
  const today = W.localDay(now);
  const to = range.to > today ? today : range.to;
  return { from: range.from > to ? to : range.from, to };
}

const PAGE_SERIES = C.PAGES.map((p) => ({ key: p.id, label: p.shortName, color: C.PAGE_CHART[p.id] }));

// ---------------------------------------------------------------- 1. Overview
router.get('/', (req, res) => {
  const { studio, actor, now, users } = req.sm;
  const settings = studio.settings;
  const items = live(studio);
  const range = res.locals.sm.range;
  const tasks = W.deriveTasks(items, now, settings);
  const progress = pageProgress(items, settings, now);
  const history = F.history(studio, now);
  const fw = followerWindow(range, now);
  const summaries = C.PAGES.map((p) => F.summarize(history, p.id, fw.from, fw.to));
  const days = F.dayDiff(fw.from, fw.to) + 1;
  const chartRows = F.chartSeries(history, fw.from, fw.to, 'total', days > 45 ? 'week' : 'day');
  const month = monthBounds(now);
  const inMonth = (iso) => !!iso && W.inRange(iso, month.from, month.to);
  const myPages = P.pagesFor(actor, settings);
  const overdue = tasks.filter((t) => t.overdue).sort((a, b) => (a.deadline || '').localeCompare(b.deadline || ''));
  const scoped = items.filter((i) => myPages.includes(i.pageId));
  const available = {
    shoot: scoped.filter((i) => i.shoot.status === 'Unclaimed').sort((a, b) => a.shootAt.localeCompare(b.shootAt)),
    editing: scoped.filter((i) => W.footageReady(i) && i.editing.status === 'Not Started' && !i.editor).sort((a, b) => (a.shoot.rawSubmittedAt || '').localeCompare(b.shoot.rawSubmittedAt || '')),
    publishing: scoped.filter((i) => W.isEditingDone(i) && !W.isPublished(i)).sort((a, b) => (a.publishAt || '9999').localeCompare(b.publishAt || '9999'))
  };
  const mine = { active: [], done: [] };
  if (actor.canWork) {
    for (const i of items) {
      if (i.shootOwner === actor.userId && (!W.isShootDone(i) || !i.shoot.rawSubmitted)) mine.active.push({ item: i, stage: 'Shoot' });
      if (i.editor === actor.userId && i.editing.status === 'Editing') mine.active.push({ item: i, stage: 'Editing' });
      [['Shoot', i.shoot.completion], ['Editing', i.editing.completion], ['Publishing', i.publishing.completion]].forEach(([stage, c]) => {
        if (c && c.by === actor.userId) mine.done.push({ item: i, stage, c });
      });
    }
    mine.done = mine.done.sort((a, b) => b.c.at.localeCompare(a.c.at)).slice(0, 8);
  }
  const prep = items
    .filter((i) => myPages.includes(i.pageId) && !W.isShootDone(i) && new Date(i.shootAt) >= W.startOfDay(now) && new Date(i.shootAt) < W.addDaysD(W.startOfDay(now), 14))
    .sort((a, b) => a.shootAt.localeCompare(b.shootAt));
  const next7 = Array.from({ length: 7 }, (_, k) => W.addDaysD(W.startOfDay(now), k)).map((d) => ({
    day: d, items: items.filter((i) => W.localDay(W.plannedDate(i)) === W.localDay(d)).sort((a, b) => W.plannedDate(a).localeCompare(W.plannedDate(b)))
  }));
  const activity = [];
  items.forEach((i) => (i.activity || []).forEach((a) => activity.push({ ...a, item: i })));
  activity.sort((a, b) => b.at.localeCompare(a.at));
  const pv = Object.values(progress);
  const totals = {
    planned: pv.reduce((s, p) => s + p.planned, 0),
    target: pv.reduce((s, p) => s + p.target, 0),
    published: items.filter((i) => inMonth(i.publishing.completion && i.publishing.completion.at)).length,
    followers: summaries.reduce((s, x) => s + x.current, 0),
    followersPrev: summaries.reduce((s, x) => s + x.previous, 0),
    shootsPending: items.filter((i) => !W.isShootDone(i)).length,
    shootsAvailable: items.filter((i) => i.shoot.status === 'Unclaimed').length,
    shootsInProgress: items.filter((i) => i.shoot.status === 'In Progress').length,
    shootsCompleted: items.filter((i) => inMonth(i.shoot.completion && i.shoot.completion.at)).length,
    editingAvailable: items.filter((i) => W.footageReady(i) && i.editing.status === 'Not Started').length,
    editingInProgress: items.filter((i) => i.editing.status === 'Editing').length,
    editingCompleted: items.filter((i) => inMonth(i.editing.completion && i.editing.completion.at)).length,
    ready: items.filter((i) => W.getPublishStatus(i, now) === 'Ready to Publish').length,
    scheduled: items.filter((i) => W.getPublishStatus(i, now) === 'Scheduled').length,
    overdueClaimed: overdue.filter((t) => t.assignee).length,
    overdueUnclaimed: overdue.filter((t) => !t.assignee).length,
    availableTotal: available.shoot.length + available.editing.length + available.publishing.length,
    myActive: mine.active.length
  };
  render(res, 'overview', 'Social Media Studio', {
    totals, progress, summaries, chartRows, fw, available, mine, prep, next7,
    overdue: overdue.slice(0, 7),
    general: S.computeGeneralScores(studio, users, items, now, range.from, range.to),
    editingScores: S.computeEditingScores(studio, users, items, now, range.from, range.to),
    activity: activity.slice(0, 10),
    availTab: ['shoot', 'editing', 'publishing'].includes(req.query.avail) ? req.query.avail : 'shoot',
    PAGE_SERIES
  });
});

// ---------------------------------------------------------------- 2. Instagram Pages
router.get('/pages', (req, res) => {
  const { studio, now } = req.sm;
  const items = live(studio);
  const history = F.history(studio, now);
  const fw = followerWindow(res.locals.sm.range, now);
  render(res, 'pages', 'Instagram Pages', {
    progress: pageProgress(items, studio.settings, now),
    summaries: Object.fromEntries(C.PAGES.map((p) => [p.id, F.summarize(history, p.id, fw.from, fw.to)])),
    fw
  });
});

router.get('/pages/:pageId', (req, res) => {
  const { studio, now, users } = req.sm;
  const page = C.getPage(req.params.pageId);
  if (!page) return res.status(404).render('social/not-found', { crumb: 'Instagram Pages', what: 'Instagram page', back: '/social-media/pages' });
  const settings = studio.settings;
  const items = live(studio);
  const mine = items.filter((i) => i.pageId === page.id);
  const today = W.localDay(now);
  const from30 = W.localDay(W.addDaysD(now, -29));
  const from90 = W.localDay(W.addDaysD(now, -89));
  const history = F.history(studio, now);
  const month = monthBounds(now);
  const byShoot = (a, b) => a.shootAt.localeCompare(b.shootAt);
  const lists = {
    shootsAvailable: mine.filter((i) => i.shoot.status === 'Unclaimed').sort(byShoot),
    shootsInProgress: mine.filter((i) => i.shoot.status === 'In Progress' || (W.isShootDone(i) && !i.shoot.rawSubmitted)).sort(byShoot),
    editingAvailable: mine.filter((i) => W.footageReady(i) && i.editing.status === 'Not Started' && !i.editor).sort(byShoot),
    editingInProgress: mine.filter((i) => i.editing.status === 'Editing').sort(byShoot),
    ready: mine.filter((i) => W.isEditingDone(i) && !W.isPublished(i)).sort((a, b) => (a.publishAt || '9999').localeCompare(b.publishAt || '9999')),
    published: mine.filter(W.isPublished).sort((a, b) => (b.publishing.completion.at || '').localeCompare(a.publishing.completion.at || ''))
  };
  const inEditing = mine.filter((i) => W.footageReady(i) && !W.isPublished(i));
  const timed = lists.published.filter((i) => i.publishing.completion.onTime !== undefined);
  const editDone = mine.filter((i) => i.editing.completion && !i.editing.completion.excused && i.editing.completion.onTime !== undefined);
  const editDue = editDone.length + mine.filter((i) => W.isEditOverdue(i, now, settings)).length;
  const ta = mine.map(W.editingTurnaroundHours).filter((h) => h !== null && h >= 0);
  const tabs = ['tasks', 'overview', 'calendar', 'shoots', 'editing', 'history'];
  render(res, 'page-detail', page.shortName, {
    page, lists, inEditing,
    activeEdits: inEditing.filter((i) => !W.isEditingDone(i)),
    upcomingShoots: mine.filter((i) => !W.isShootDone(i)).sort(byShoot),
    monthItems: mine.filter((i) => W.inRange(W.plannedDate(i), month.from, month.to)).sort((a, b) => W.plannedDate(a).localeCompare(W.plannedDate(b))),
    progress: pageProgress(items, settings, now)[page.id],
    s30: F.summarize(history, page.id, from30, today),
    s90: F.summarize(history, page.id, from90, today),
    chartRows: F.chartSeries(history, from90, today, 'total', 'week'),
    perf: {
      onTimeRate: timed.length ? (timed.filter((i) => i.publishing.completion.onTime).length / timed.length) * 100 : null,
      editOnTime: editDue ? (editDone.filter((i) => i.editing.completion.onTime).length / editDue) * 100 : null,
      turnaround: ta.length ? ta.reduce((a, b) => a + b, 0) / ta.length : null
    },
    team: P.teamFor(settings, page.id),
    editors: P.editorsForPage(settings, page.id),
    tab: tabs.includes(req.query.tab) ? req.query.tab : 'tasks',
    users
  });
});

// ---------------------------------------------------------------- 3. Followers Analytics (demo)
router.get('/followers', (req, res) => {
  const { studio, now } = req.sm;
  const history = F.history(studio, now);
  const minDate = history[0].date;
  const maxDate = history[history.length - 1].date;
  const preset = ['7', '30', '90', 'custom'].includes(req.query.period) ? req.query.period : '30';
  let from, to;
  if (preset === 'custom') {
    const okd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
    from = okd(req.query.from) ? req.query.from : F.shiftDay(maxDate, -44);
    to = okd(req.query.to) ? req.query.to : maxDate;
    if (from < minDate) from = minDate;
    if (to > maxDate) to = maxDate;
    if (from > to) from = to;
  } else {
    to = maxDate;
    from = F.shiftDay(maxDate, -(Number(preset) - 1));
  }
  const days = F.dayDiff(from, to) + 1;
  const page = C.PAGE_IDS.includes(req.query.page) ? req.query.page : 'all';
  const bucket = days < 14 ? 'day' : req.query.bucket === 'week' ? 'week' : 'day';
  const metric = req.query.metric === 'gain' ? 'gain' : 'total';
  const summaries = C.PAGES.map((p) => F.summarize(history, p.id, from, to));
  const sum = (k) => summaries.reduce((s, x) => s + x[k], 0);
  const combined = { current: sum('current'), previous: sum('previous'), net: sum('net'), prevNet: sum('prevNet') };
  combined.growthPct = combined.previous ? (combined.net / combined.previous) * 100 : 0;
  combined.vsPrevPct = combined.prevNet ? ((combined.net - combined.prevNet) / Math.abs(combined.prevNet)) * 100 : 0;
  combined.avgDaily = combined.net / days;
  render(res, 'followers', 'Followers Analytics', {
    q: { period: preset, from, to, page, bucket, metric }, minDate, maxDate, days, summaries, combined,
    series: F.chartSeries(history, from, to, metric, bucket),
    totalsSeries: F.chartSeries(history, from, to, 'total', bucket),
    PAGE_SERIES
  });
});

// ---------------------------------------------------------------- 4. Content Calendar
function startOfWeekD(d, ws) { const x = W.startOfDay(d); const back = (x.getDay() - ws + 7) % 7; return W.addDaysD(x, -back); }
function parseDay(s, fallback) {
  if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) { const [y, m, d] = s.split('-').map(Number); const dt = new Date(y, m - 1, d); if (!Number.isNaN(dt.getTime())) return dt; }
  return fallback;
}
function monthGrid(cursor, ws) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  const start = startOfWeekD(first, ws);
  const end = W.addDaysD(startOfWeekD(last, ws), 6);
  const days = [];
  for (let d = start; d <= end; d = W.addDaysD(d, 1)) days.push(d);
  return days;
}

router.get('/calendar', (req, res) => {
  const { studio, now, users } = req.sm;
  const settings = studio.settings;
  const ws = settings.display.weekStartsOn;
  const view = ['month', 'week', 'day'].includes(req.query.view) ? req.query.view : settings.display.defaultCalendarView;
  const cursor = parseDay(req.query.date, W.startOfDay(now));
  const f = {
    page: C.PAGE_IDS.includes(req.query.page) ? req.query.page : 'all',
    emp: /^\d+$/.test(req.query.emp || '') ? Number(req.query.emp) : 'all',
    stage: W.STAGES.includes(req.query.stage) ? req.query.stage : 'all',
    shoots: req.query.shoots === '1'
  };
  const events = [];
  live(studio).forEach((i) => {
    if (f.page !== 'all' && i.pageId !== f.page) return;
    if (f.emp !== 'all' && ![i.shootOwner, i.editor, i.publishingOwner].includes(f.emp)) return;
    if (f.stage !== 'all' && W.getStage(i) !== f.stage) return;
    const overdue = W.isItemOverdue(i, now, settings);
    const tbd = !i.publishAt;
    if (!(tbd && f.shoots)) events.push({ key: `${i.id}:p`, item: i, kind: 'publish', at: new Date(i.publishAt || i.shootAt), overdue, tbd });
    if (f.shoots) events.push({ key: `${i.id}:s`, item: i, kind: 'shoot', at: new Date(i.shootAt), overdue, tbd: false });
  });
  events.sort((a, b) => a.at - b.at);
  const eventsOn = (d) => events.filter((e) => W.localDay(e.at) === W.localDay(d));
  const step = view === 'month' ? null : view === 'week' ? 7 : 1;
  const prev = step ? W.addDaysD(cursor, -step) : new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1);
  const next = step ? W.addDaysD(cursor, step) : new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  const weekStart = startOfWeekD(cursor, ws);
  const weekDays = Array.from({ length: 7 }, (_, k) => W.addDaysD(weekStart, k));
  render(res, 'calendar', 'Content Calendar', {
    view, cursor, f, eventsOn, weekDays, prev, next,
    monthDays: view === 'month' ? monthGrid(cursor, ws) : [],
    title: view === 'month' ? V.fmtDate(cursor, 'month') : view === 'week' ? `${V.fmtDate(weekDays[0], 'short')} – ${V.fmtDate(weekDays[6])}` : V.fmtDate(cursor, 'long'),
    members: linkedMembers(studio, users)
  });
});

function linkedMembers(studio, users, onlyKeys) {
  return C.ROSTER.filter((r) => !onlyKeys || onlyKeys.includes(r.key)).map((r) => {
    const uid = P.userIdForKey(studio, r.key);
    const u = uid ? users.find((x) => x.id === uid) : null;
    return u ? { key: r.key, userId: uid, name: u.name } : null;
  }).filter(Boolean);
}

// ---------------------------------------------------------------- 5. Shoot Planner
router.get('/shoots', (req, res) => {
  const { studio, now, actor, users } = req.sm;
  const settings = studio.settings;
  const worker = actor.canWork ? actor.userId : null;
  const buckets = ['available', 'mine', 'progress', 'completed', 'overdue'];
  let tab = buckets.includes(req.query.tab) ? req.query.tab : worker ? 'mine' : 'available';
  if (tab === 'mine' && !worker) tab = 'available';
  const f = {
    page: C.PAGE_IDS.includes(req.query.page) ? req.query.page : 'all',
    owner: req.query.owner === 'unclaimed' ? 'unclaimed' : /^\d+$/.test(req.query.owner || '') ? Number(req.query.owner) : 'all',
    q: String(req.query.q || '').trim().slice(0, 80),
    view: req.query.view === 'calendar' ? 'calendar' : 'list'
  };
  const inBucket = (i, b) => b === 'available' ? i.shoot.status === 'Unclaimed' : b === 'mine' ? !!worker && i.shootOwner === worker
    : b === 'progress' ? i.shoot.status === 'In Progress' : b === 'completed' ? W.isShootDone(i) : W.isShootOverdue(i, now);
  const filtered = live(studio).filter((i) => (f.page === 'all' || i.pageId === f.page)
    && (f.owner === 'all' || (f.owner === 'unclaimed' ? !i.shootOwner : i.shootOwner === f.owner))
    && (!f.q || i.title.toLowerCase().includes(f.q.toLowerCase())));
  const counts = Object.fromEntries(buckets.map((b) => [b, filtered.filter((i) => inBucket(i, b)).length]));
  const myPages = actor.memberKey ? P.pagesFor(actor, settings) : null;
  let list = filtered.filter((i) => inBucket(i, tab));
  if (tab === 'completed') list.sort((a, b) => (b.shoot.completion.at || '').localeCompare(a.shoot.completion.at || ''));
  else if (tab === 'mine') list.sort((a, b) => Number(W.isShootDone(a)) - Number(W.isShootDone(b)) || a.shootAt.localeCompare(b.shootAt));
  else if (tab === 'available' && myPages) list.sort((a, b) => Number(!myPages.includes(a.pageId)) - Number(!myPages.includes(b.pageId)) || a.shootAt.localeCompare(b.shootAt));
  else list.sort((a, b) => a.shootAt.localeCompare(b.shootAt));
  const allOverdue = filtered.filter((i) => W.isShootOverdue(i, now));
  const monthCursor = parseDay(req.query.month ? `${req.query.month}-01` : '', new Date(now.getFullYear(), now.getMonth(), 1));
  render(res, 'shoots', 'Shoot Planner', {
    tab, f, counts, list, myPages,
    overdueClaimed: allOverdue.filter((i) => i.shootOwner).length,
    overdueUnclaimed: allOverdue.filter((i) => !i.shootOwner).length,
    members: linkedMembers(studio, users),
    monthCursor, monthDays: monthGrid(monthCursor, settings.display.weekStartsOn)
  });
});

// ---------------------------------------------------------------- 6. Editing Studio
router.get('/editing', (req, res) => {
  const { studio, now, actor, users } = req.sm;
  const settings = studio.settings;
  const range = res.locals.sm.range;
  const f = {
    view: req.query.view === 'list' ? 'list' : 'board',
    editor: /^\d+$/.test(req.query.editor || '') ? Number(req.query.editor) : 'all',
    page: C.PAGE_IDS.includes(req.query.page) ? req.query.page : 'all',
    q: String(req.query.q || '').trim().slice(0, 80)
  };
  const columnOf = (i) => W.isEditingDone(i) ? 'done' : i.editing.status === 'Editing' ? 'editing' : W.footageReady(i) ? 'available' : i.shootOwner ? 'waiting' : null;
  const cols = { waiting: [], available: [], editing: [], done: [] };
  live(studio).forEach((i) => {
    if (f.page !== 'all' && i.pageId !== f.page) return;
    if (f.q && !i.title.toLowerCase().includes(f.q.toLowerCase())) return;
    const col = columnOf(i);
    if (!col) return;
    if (col === 'done' && !W.inRange(i.editing.completion.at, range.from, range.to)) return;
    if (col === 'waiting' && new Date(i.shootAt).getTime() - now.getTime() > 7 * 86400000) return;
    if (f.editor !== 'all' && (col === 'editing' || col === 'done') && i.editor !== f.editor) return;
    cols[col].push(i);
  });
  cols.waiting.sort((a, b) => a.shootAt.localeCompare(b.shootAt));
  cols.available.sort((a, b) => (a.shoot.rawSubmittedAt || '').localeCompare(b.shoot.rawSubmittedAt || ''));
  const dl = (i) => { const d = W.editingDeadline(i, settings); return d ? d.getTime() : Infinity; };
  cols.editing.sort((a, b) => dl(a) - dl(b));
  cols.done.sort((a, b) => (b.editing.completion.at || '').localeCompare(a.editing.completion.at || ''));
  render(res, 'editing', 'Editing Studio', {
    f, cols,
    scores: S.computeEditingScores(studio, users, live(studio), now, range.from, range.to),
    myActive: actor.canEditVideo ? live(studio).filter((i) => i.editor === actor.userId && i.editing.status === 'Editing') : null,
    editors: linkedMembers(studio, users, C.EDITOR_KEYS)
  });
});

// ---------------------------------------------------------------- 7. Publishing Queue
router.get('/publishing', (req, res) => {
  const { studio, now, users } = req.sm;
  const tabs = ['all', ...W.PUBLISH_STATUSES];
  const f = {
    tab: tabs.includes(req.query.tab) ? req.query.tab : 'all',
    view: req.query.view === 'calendar' ? 'calendar' : 'list',
    q: String(req.query.q || '').trim().slice(0, 80).toLowerCase(),
    page: C.PAGE_IDS.includes(req.query.page) ? req.query.page : 'all',
    owner: /^\d+$/.test(req.query.owner || '') ? Number(req.query.owner) : 'all'
  };
  const sortKey = (i) => i.publishAt || (i.publishing.completion && i.publishing.completion.at) || (i.editing.completion && i.editing.completion.at) || i.shootAt;
  const filtered = live(studio)
    .filter((i) => W.isEditingDone(i) || W.isPublished(i) || i.publishing.status === 'Delayed')
    .map((i) => ({ item: i, status: W.getPublishStatus(i, now) }))
    .filter(({ item }) => (f.page === 'all' || item.pageId === f.page) && (f.owner === 'all' || item.publishingOwner === f.owner)
      && (!f.q || item.title.toLowerCase().includes(f.q) || (item.caption || '').toLowerCase().includes(f.q)))
    .sort((a, b) => {
      if (a.status === 'Published' && b.status === 'Published') return sortKey(b.item).localeCompare(sortKey(a.item));
      if (a.status === 'Published') return 1;
      if (b.status === 'Published') return -1;
      return sortKey(a.item).localeCompare(sortKey(b.item));
    });
  const counts = { all: filtered.length };
  W.PUBLISH_STATUSES.forEach((s) => { counts[s] = filtered.filter((r) => r.status === s).length; });
  const monthCursor = parseDay(req.query.month ? `${req.query.month}-01` : '', new Date(now.getFullYear(), now.getMonth(), 1));
  render(res, 'publishing', 'Publishing Queue', {
    f, counts, rows: f.tab === 'all' ? filtered : filtered.filter((r) => r.status === f.tab),
    members: linkedMembers(studio, users),
    monthCursor, monthDays: monthGrid(monthCursor, studio.settings.display.weekStartsOn)
  });
});

// ---------------------------------------------------------------- 8. Task Management
router.get('/tasks', (req, res) => {
  const { studio, now, users } = req.sm;
  const people = res.locals.sm.people;
  const tasks = W.deriveTasks(live(studio), now, studio.settings);
  const states = ['all', 'available', 'claimed', 'overdue-owned', 'overdue-unclaimed', 'done'];
  const f = {
    state: states.includes(req.query.state) ? req.query.state : req.query.overdue === '1' ? 'overdue-owned' : 'all',
    type: W.TASK_TYPES.includes(req.query.type) ? req.query.type : 'all',
    page: C.PAGE_IDS.includes(req.query.page) ? req.query.page : 'all',
    emp: req.query.emp === 'unclaimed' ? 'unclaimed' : /^\d+$/.test(req.query.emp || '') ? Number(req.query.emp) : 'all',
    priority: C.PRIORITIES.includes(req.query.priority) ? req.query.priority : 'all',
    q: String(req.query.q || '').trim().slice(0, 80),
    sort: ['deadline', 'priority', 'status', 'assignee', 'title'].includes(req.query.sort) ? req.query.sort : 'deadline',
    dir: req.query.dir === 'desc' ? -1 : 1,
    pg: Math.max(1, Number.parseInt(req.query.pg, 10) || 1)
  };
  const matches = (t, s) => s === 'all' ? true : s === 'available' ? t.claimable : s === 'claimed' ? !!t.assignee && !t.done
    : s === 'done' ? t.done : s === 'overdue-owned' ? t.overdue && !!t.assignee : t.overdue && !t.assignee;
  const ownerName = (t) => (t.assignee ? people.nameOf(t.assignee) : '');
  const term = f.q.toLowerCase();
  const base = tasks.filter((t) => (f.type === 'all' || t.type === f.type) && (f.page === 'all' || t.pageId === f.page)
    && (f.emp === 'all' || (f.emp === 'unclaimed' ? !t.assignee : t.assignee === f.emp))
    && (f.priority === 'all' || t.priority === f.priority)
    && (!term || t.title.toLowerCase().includes(term) || ownerName(t).toLowerCase().includes(term)));
  const cmp = {
    deadline: (a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'),
    priority: (a, b) => C.PRIORITY_ORDER[a.priority] - C.PRIORITY_ORDER[b.priority],
    status: (a, b) => a.status.localeCompare(b.status),
    assignee: (a, b) => (ownerName(a) || '~').localeCompare(ownerName(b) || '~'),
    title: (a, b) => a.title.localeCompare(b.title)
  }[f.sort];
  const filtered = base.filter((t) => matches(t, f.state)).sort((a, b) => cmp(a, b) * f.dir);
  const PAGE_SIZE = 15;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pg = Math.min(f.pg, pageCount);
  const reels = new Map(live(studio).map((i) => [i.id, i]));
  render(res, 'tasks', 'Task Management', {
    f, pg, pageCount, total: filtered.length,
    rows: filtered.slice((pg - 1) * PAGE_SIZE, pg * PAGE_SIZE).map((t) => ({ t, item: reels.get(t.contentId) })),
    counts: Object.fromEntries(states.map((s) => [s, base.filter((t) => matches(t, s)).length])),
    members: linkedMembers(studio, users, f.type === 'Editing' ? C.EDITOR_KEYS : null)
  });
});

// ---------------------------------------------------------------- 9. Employee Ranking
router.get('/ranking', (req, res) => {
  const { studio, now, users } = req.sm;
  const range = res.locals.sm.range;
  const items = live(studio);
  const general = S.computeGeneralScores(studio, users, items, now, range.from, range.to);
  const ws = studio.settings.display.weekStartsOn;
  // Rolling 4-week score at the end of each of the last 8 weeks. null = insufficient data.
  const trend = Array.from({ length: 8 }, (_, idx) => {
    const weekEnd = W.addDaysD(startOfWeekD(W.addDaysD(now, -7 * (7 - idx)), ws), 6);
    const from = W.localDay(startOfWeekD(W.addDaysD(weekEnd, -21), ws));
    const to = W.localDay(weekEnd > now ? now : weekEnd);
    const row = { label: `w/e ${V.fmtDate(weekEnd, 'short')}` };
    S.computeGeneralScores(studio, users, items, now, from, to).forEach((s) => { row[`u${s.userId}`] = s.score; });
    return row;
  });
  const breakdownId = /^\d+$/.test(req.query.breakdown || '') ? Number(req.query.breakdown) : null;
  render(res, 'ranking', 'Employee Ranking', {
    board: req.query.board === 'editing' ? 'editing' : 'general',
    general,
    editing: S.computeEditingScores(studio, users, items, now, range.from, range.to),
    trend,
    slots: S.rankedSlots(studio, users),
    breakdown: breakdownId ? general.find((g) => g.userId === breakdownId) || null : null
  });
});

// ---------------------------------------------------------------- 10. Performance Reports
function reportData(req) {
  const { studio, now, users } = req.sm;
  const settings = studio.settings;
  const range = currentRange(req, now);
  const slots = S.rankedSlots(studio, users).filter((s) => s.linked);
  const page = C.PAGE_IDS.includes(req.query.page) ? req.query.page : 'all';
  const emp = /^\d+$/.test(req.query.emp || '') && slots.some((s) => s.userId === Number(req.query.emp)) ? Number(req.query.emp) : 'all';
  const pages = page === 'all' ? C.PAGES : C.PAGES.filter((p) => p.id === page);
  const pageIds = pages.map((p) => p.id);
  const pageItems = live(studio).filter((i) => pageIds.includes(i.pageId));
  const involves = (i) => emp === 'all' || [i.shootOwner, i.editor, i.publishingOwner, i.shoot.completion && i.shoot.completion.by, i.editing.completion && i.editing.completion.by, i.publishing.completion && i.publishing.completion.by].includes(emp);
  const scoped = pageItems.filter((i) => W.inRange(W.plannedDate(i), range.from, range.to) && involves(i));
  const pageRows = pages.map((p) => {
    const mine = scoped.filter((i) => i.pageId === p.id);
    const published = mine.filter(W.isPublished);
    const timed = published.filter((i) => i.publishing.completion.onTime !== undefined);
    return { pageId: p.id, name: p.shortName, planned: mine.length, published: published.length, target: settings.targets[p.id], onTimeRate: timed.length ? timed.filter((i) => i.publishing.completion.onTime).length / timed.length : null };
  });
  const general = S.computeGeneralScores(studio, users, pageItems, now, range.from, range.to);
  const empRows = emp === 'all' ? general : general.filter((g) => g.userId === emp);
  const editing = S.computeEditingScores(studio, users, pageItems, now, range.from, range.to);
  const edRows = emp === 'all' ? editing : editing.filter((e) => e.userId === emp);
  const tasks = W.deriveTasks(pageItems, now, settings).filter((t) => !t.assignee && !t.done);
  const unattributed = W.TASK_TYPES.map((c) => ({ type: c, available: tasks.filter((t) => t.type === c && t.claimable && !t.overdue).length, overdue: tasks.filter((t) => t.type === c && t.overdue).length }));
  const months = Array.from({ length: 6 }, (_, k) => new Date(now.getFullYear(), now.getMonth() - 5 + k, 1));
  const monthly = months.map((m) => {
    const key = W.localDay(m).slice(0, 7);
    const row = { label: m.toLocaleDateString('en-GB', { month: 'short' }) };
    pages.forEach((p) => { row[p.id] = pageItems.filter((i) => i.pageId === p.id && involves(i) && i.publishing.completion && W.localDay(i.publishing.completion.at).startsWith(key)).length; });
    return row;
  });
  const publishCompliance = pages.map((p) => {
    const mine = scoped.filter((i) => i.pageId === p.id);
    const pub = mine.filter((i) => i.publishing.completion);
    return { label: p.shortName, onTime: pub.filter((i) => i.publishing.completion.onTime === true).length, late: pub.filter((i) => i.publishing.completion.onTime === false).length, missed: mine.filter((i) => W.isPublishOverdue(i, now)).length };
  });
  const history = F.history(studio, now);
  const fw = followerWindow(range, now);
  const followers = pages.map((p) => F.summarize(history, p.id, fw.from, fw.to));
  const closes = F.monthlyClosing(history).slice(-6);
  const mom = closes.map((c, k) => {
    // A month total only exists when every selected page has a reading that month.
    const sumOf = (pt) => (pageIds.every((id) => typeof pt[id] === 'number') ? pageIds.reduce((s, id) => s + pt[id], 0) : null);
    const total = sumOf(c.point);
    const prevTotal = k > 0 ? sumOf(closes[k - 1].point) : null;
    const reels = pageItems.filter((i) => involves(i) && i.publishing.completion && W.localDay(i.publishing.completion.at).startsWith(c.month)).length;
    const [y, m] = c.month.split('-').map(Number);
    return { month: c.month, label: new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }), total, net: prevTotal === null || total === null ? null : total - prevTotal, pct: prevTotal && total !== null ? ((total - prevTotal) / prevTotal) * 100 : null, reels };
  });
  const edTimes = edRows.filter((e) => e.stats.avgCompletionH !== null);
  return {
    range, page, emp, pages, slots, pageRows, empRows, edRows, unattributed, monthly, publishCompliance, followers, mom,
    followerLabel: V.followerLabel(F.sources(studio), pageIds),
    shootTimeliness: empRows.map((g) => ({ label: g.name, onTime: g.categories.Shoot.onTime, late: g.categories.Shoot.late, overdue: g.categories.Shoot.openOverdue })),
    editingTimeliness: edRows.map((e) => ({ label: e.name, onTime: e.stats.onTime, late: e.stats.late, overdue: e.stats.openOverdue })),
    avgEdit: edTimes.length ? edTimes.reduce((s, e) => s + e.stats.avgCompletionH, 0) / edTimes.length : null
  };
}

router.get('/reports', (req, res) => render(res, 'reports', 'Performance Reports', { r: reportData(req) }));

const csvCell = (c) => {
  let s = String(c === null || c === undefined ? '' : c);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // keep spreadsheet formulas from running
  return `"${s.replace(/"/g, '""')}"`;
};
router.get('/reports/export/:kind', (req, res) => {
  const r = reportData(req);
  const stamp = `${r.range.from}_to_${r.range.to}`;
  let name, rows;
  if (req.params.kind === 'page-performance.csv') {
    name = `page-performance_${stamp}.csv`;
    rows = [['Page', 'Planned', 'Published', 'Monthly target', 'On-schedule publishing %'],
      ...r.pageRows.map((x) => [C.getPage(x.pageId).name, x.planned, x.published, x.target, x.onTimeRate === null ? '' : Math.round(x.onTimeRate * 100)])];
  } else if (req.params.kind === 'employee-contribution.csv') {
    name = `employee-contribution_${stamp}.csv`;
    rows = [['Employee', 'Status', 'Score', ...W.TASK_TYPES.flatMap((c) => [`${c} claimed`, `${c} completed`, `${c} on time`, `${c} late`]), 'Overdue (owned, open)', 'On-time rate %'],
      ...r.empRows.map((x) => [x.name, x.status, x.score === null ? '' : x.score, ...W.TASK_TYPES.flatMap((c) => [x.categories[c].claimed, x.categories[c].completed, x.categories[c].onTime, x.categories[c].late]), x.totals.openOverdue, x.totals.onTimeRate === null ? '' : Math.round(x.totals.onTimeRate * 100)])];
  } else if (req.params.kind === 'month-over-month.csv') {
    name = `month-over-month_${W.localDay(new Date())}.csv`;
    rows = [['Month', `Closing followers (${r.followerLabel})`, 'Net change', 'Change %', 'Reels published'],
      ...r.mom.map((m) => [m.label, m.total === null ? '' : m.total, m.net === null ? '' : m.net, m.pct === null ? '' : m.pct.toFixed(2), m.reels])];
  } else return res.status(404).send('Unknown export');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send('﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n'));
});

// ---------------------------------------------------------------- 11. Settings & Targets
router.get('/settings', (req, res) => {
  const { studio, users, now } = req.sm;
  const takenBy = new Map(studio.members.filter((m) => m.userId).map((m) => [m.userId, m.key]));
  render(res, 'settings', 'Settings & Targets', {
    progress: pageProgress(live(studio), studio.settings, now),
    members: C.ROSTER.map((r) => {
      const m = studio.members.find((x) => x.key === r.key);
      const u = m.userId ? users.find((x) => x.id === m.userId) : null;
      return { ...r, userId: m.userId, user: u ? { id: u.id, name: u.name, email: u.email, role: u.role, active: u.active } : null, linkedAt: m.linkedAt };
    }),
    candidates: users.filter((u) => u.active && (u.role === 'employee' || u.role === 'admin')).map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, takenBy: takenBy.get(u.id) || null })),
    linkReport: req.session.studioLinkReport || null,
    instagram: (() => {
      const state = IG.igState(studio);
      const tokens = IG.readTokens();
      return C.PAGES.map((p) => {
        const snaps = state.snapshots[p.id];
        const latest = snaps.length ? snaps[snaps.length - 1] : null;
        return { page: p, status: state.status[p.id], hasToken: !!(tokens[p.id] && tokens[p.id].token), latest, days: snaps.length };
      });
    })(),
    igApiVersion: IG.API_VERSION,
    IGREMIND: IG.REMIND_DAYS,
    scheduleHistory: (studio.scheduleHistory || []).slice(-15).reverse()
  });
  delete req.session.studioLinkReport;
});

function requireManager(req, res, next) {
  if (!req.sm.actor.isManager) return forbidden(res, 'Only an admin can change Studio settings.');
  next();
}

// Weekly publishing schedule for ONE page (Settings → Publishing Schedule). Only that page's
// schedule changes. It only affects future slot suggestions: reels that already have a
// publishing time keep it (and their editing deadline) until someone edits the reel itself.
router.post('/settings/schedule/:pageId', requireManager, (req, res) => {
  const page = C.getPage(req.params.pageId);
  if (!page) return res.status(404).send('Unknown page');
  const parsed = Sched.parseWeekForm(req.body);
  if (parsed.error) {
    flash(req, 'error', `${page.name}: ${parsed.error} Nothing was saved.`);
    return res.redirect(303, `/social-media/settings#schedule-${page.id}`);
  }
  const ctx = loadCtx(req);
  const { studio, db, actor } = ctx;
  const before = studio.settings.publishingSchedule[page.id];
  const after = parsed.week;
  if (JSON.stringify(before) === JSON.stringify(after)) {
    flash(req, 'info', `${page.name}: no changes.`);
    return res.redirect(303, `/social-media/settings#schedule-${page.id}`);
  }
  const next = JSON.parse(JSON.stringify(studio.settings.publishingSchedule));
  next[page.id] = after;
  studio.settings = Store.sanitizeSettings({ ...studio.settings, publishingSchedule: next }, studio.settings);
  studio.scheduleHistory = studio.scheduleHistory || [];
  studio.scheduleHistory.push({ at: new Date().toISOString(), by: actor.userId, byName: actor.name, pageId: page.id, before, after: studio.settings.publishingSchedule[page.id] });
  if (studio.scheduleHistory.length > 300) studio.scheduleHistory.splice(0, studio.scheduleHistory.length - 300);
  logActivity(db, `<b>${escapeHtml(actor.name)}</b> updated the ${escapeHtml(page.name)} publishing schedule`);
  save(db);
  const empty = Sched.DAYS.filter((d) => after[d].enabled && !after[d].slots.length).map((d) => Sched.DAY_LABEL[d]);
  flash(req, empty.length ? 'info' : 'success', `${page.name} publishing schedule saved. Future suggestions use it; reels that are already scheduled keep their times.${empty.length ? ` Note: ${empty.join(', ')} ${empty.length === 1 ? 'is' : 'are'} enabled but has no time, so ${empty.length === 1 ? 'it is' : 'they are'} skipped.` : ''}${Sched.hasAnySlot(studio.settings.publishingSchedule, page.id) ? '' : ' No publishing day is active, so no time can be suggested for this page.'}`);
  res.redirect(303, `/social-media/settings#schedule-${page.id}`);
});

router.post('/settings/:section', requireManager, (req, res) => {
  const ctx = loadCtx(req);
  const { studio, actor, db } = ctx;
  const b = req.body;
  const st = JSON.parse(JSON.stringify(studio.settings));
  const sec = req.params.section;
  let msg = 'Settings saved.';
  if (sec === 'targets') C.PAGE_IDS.forEach((p) => { st.targets[p] = b[`target_${p}`]; });
  else if (sec === 'teams') {
    C.PAGE_IDS.forEach((p) => {
      const raw = b[`team_${p}`];
      const keys = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((k) => C.ROSTER_KEYS.includes(k));
      if (keys.length) st.pageTeams[p] = keys;
    });
    if (C.PAGE_IDS.some((p) => !(Array.isArray(b[`team_${p}`]) ? b[`team_${p}`].length : b[`team_${p}`]))) msg = 'Saved. Each page needs at least one team member, so empty teams were left unchanged.';
  } else if (sec === 'restore-teams') { st.pageTeams = JSON.parse(JSON.stringify(C.DEFAULT_PAGE_TEAMS)); msg = 'Page teams restored to the default assignments.'; }
  else if (sec === 'priorities') st.priorities = st.priorities.map((p, i) => ({ priority: p.priority, description: b[`desc_${i}`], slaHours: b[`sla_${i}`] }));
  else if (sec === 'weights') {
    Object.keys(st.weights).forEach((k) => { st.weights[k] = b[`w_${k}`]; });
    if (b.reset === '1') st.weights = C.defaultSettings().weights;
  } else if (sec === 'ranking') { st.ranking.minDueTasks = b.minDueTasks; st.ranking.provisionalBelow = b.provisionalBelow; }
  else if (sec === 'notifications') Object.keys(st.notifications).forEach((k) => { st.notifications[k] = b[`n_${k}`] === 'on'; });
  else if (sec === 'display') { st.display.weekStartsOn = Number(b.weekStartsOn); st.display.defaultCalendarView = b.defaultCalendarView; }
  else if (sec === 'followers') st.followerScenario = b.followerScenario;
  else if (sec === 'members') return saveMembers(req, res, ctx);
  else if (sec === 'autolink') {
    req.session.studioLinkReport = Store.autoLinkMembers(db, studio, actor.userId);
    const n = req.session.studioLinkReport.filter((r) => r.status === 'auto-linked').length;
    if (n) { logActivity(db, `<b>${escapeHtml(actor.name)}</b> linked ${n} Social Media Studio member(s) by name`); save(db); }
    flash(req, n ? 'success' : 'info', n ? `${n} Studio member(s) linked to existing PMS accounts.` : 'No new unambiguous matches. See the report below.');
    return res.redirect(303, '/social-media/settings#members');
  } else return res.status(404).send('Unknown settings section');
  studio.settings = Store.sanitizeSettings(st, studio.settings);
  if (sec === 'weights') {
    const total = Object.values(studio.settings.weights).reduce((a, x) => a + x, 0);
    if (total !== 100) msg = `Saved — scoring weights total ${total}; scores are normalised to 100.`;
  }
  save(db);
  flash(req, 'success', msg);
  res.redirect(303, `/social-media/settings#${sec === 'restore-teams' ? 'teams' : sec}`);
});

const escapeHtml = (s) => V.esc(s);

// ---------------------------------------------------------------- Instagram connection (admin)
// The token is sent once from the admin form, checked against the page's handle, and stored in
// the separate token file (never db.json). It is never rendered back to any page.
router.post('/instagram/connect', requireManager, async (req, res) => {
  const pageId = C.PAGE_IDS.includes(req.body.pageId) ? req.body.pageId : null;
  if (!pageId) return res.status(400).send('Unknown page');
  try {
    const result = await IG.connectPage(pageId, req.body.token);
    const db = load();
    IG.applyReading(Store.getStudio(db), result);
    logActivity(db, `<b>${escapeHtml(req.sm.actor.name)}</b> connected ${escapeHtml(C.getPage(pageId).handle)} to Instagram follower sync`);
    save(db);
    flash(req, 'success', `${C.getPage(pageId).handle} connected — ${V.fmtNum(result.followers)} followers.`);
  } catch (e) {
    const message = e instanceof IG.IgError ? e.message : 'Could not connect. Try again.';
    if (!(e instanceof IG.IgError)) console.error('[instagram] connect failed:', e.message);
    const db = load();
    IG.recordError(Store.getStudio(db), pageId, message);
    save(db);
    flash(req, 'error', message);
  }
  res.redirect(303, '/social-media/settings#instagram');
});

router.post('/instagram/disconnect', requireManager, (req, res) => {
  const pageId = C.PAGE_IDS.includes(req.body.pageId) ? req.body.pageId : null;
  if (!pageId) return res.status(400).send('Unknown page');
  const db = load();
  IG.disconnectPage(Store.getStudio(db), pageId);
  logActivity(db, `<b>${escapeHtml(req.sm.actor.name)}</b> disconnected ${escapeHtml(C.getPage(pageId).handle)} from Instagram follower sync`);
  save(db);
  flash(req, 'success', `${C.getPage(pageId).handle} disconnected. Its saved history is kept; it shows demo data until reconnected.`);
  res.redirect(303, '/social-media/settings#instagram');
});

// Reminder popup actions can be used from any admin page, so they may return to any internal page.
const safeInternal = (v) => (typeof v === 'string' && /^\/[A-Za-z0-9\-_/?=&%.:+#]*$/.test(v) && !v.startsWith('//') ? v : '/admin/dashboard');

router.post('/instagram/dismiss-reminder', requireManager, (req, res) => {
  req.session.igReminderDismissed = new Date().toDateString(); // popup again tomorrow; the banner stays
  res.redirect(303, safeInternal(req.body.returnTo));
});

// Asks Instagram for fresh 60-day tokens for every connected page (Instagram allows this once
// a token is at least 24 hours old) and fetches today's counts at the same time.
router.post('/instagram/renew', requireManager, async (req, res) => {
  try {
    const r = await IG.syncAll({ loadDb: load, saveDb: save, getStudio: Store.getStudio, force: true, forceRefresh: true });
    if (!r.synced.length && !r.failed.length) flash(req, 'info', 'No pages are connected yet.');
    else if (r.failed.length) flash(req, 'error', `Renewed ${r.synced.length} page(s). Could not renew: ${r.failed.map((f) => `${C.getPage(f.pageId).handle} — ${f.message}`).join('; ')}. For these, generate a new token in the Meta app and paste it below.`);
    else flash(req, 'success', `Access tokens renewed for ${r.synced.length} page(s).`);
  } catch (e) {
    console.error('[instagram] renew failed:', e.message);
    flash(req, 'error', 'Could not renew the tokens. Try again.');
  }
  res.redirect(303, '/social-media/settings#instagram');
});

router.post('/instagram/refresh', requireManager, async (req, res) => {
  try {
    const r = await IG.syncAll({ loadDb: load, saveDb: save, getStudio: Store.getStudio, force: true });
    if (!r.synced.length && !r.failed.length) flash(req, 'info', 'No pages are connected yet.');
    else if (r.failed.length) flash(req, 'error', `Updated ${r.synced.length} page(s). Failed: ${r.failed.map((f) => `${C.getPage(f.pageId).handle} — ${f.message}`).join('; ')}`);
    else flash(req, 'success', `Follower counts updated for ${r.synced.length} page(s).`);
  } catch (e) {
    console.error('[instagram] refresh failed:', e.message);
    flash(req, 'error', 'Could not refresh follower counts. Try again.');
  }
  res.redirect(303, '/social-media/settings#instagram');
});

// Links/unlinks roster slots to EXISTING PMS users. Never creates or edits user accounts.
function saveMembers(req, res, ctx) {
  const { studio, db, actor } = ctx;
  const wanted = {};
  for (const r of C.ROSTER) {
    const v = req.body[`member_${r.key}`];
    if (v === undefined) continue;
    if (v === '') { wanted[r.key] = null; continue; }
    const id = Number(v);
    const u = db.users.find((x) => x.id === id && x.active && (x.role === 'employee' || x.role === 'admin'));
    if (!Number.isInteger(id) || !u) { flash(req, 'error', `Choose an existing active PMS user for ${r.name}.`); return res.redirect(303, '/social-media/settings#members'); }
    wanted[r.key] = id;
  }
  const final = Object.fromEntries(studio.members.map((m) => [m.key, m.key in wanted ? wanted[m.key] : m.userId]));
  const ids = Object.values(final).filter(Boolean);
  if (new Set(ids).size !== ids.length) { flash(req, 'error', 'One PMS user can only be linked to one Studio slot.'); return res.redirect(303, '/social-media/settings#members'); }
  const changes = [];
  studio.members.forEach((m) => {
    if (final[m.key] !== m.userId) {
      changes.push(`${C.getRosterEntry(m.key).name} → ${final[m.key] ? db.users.find((u) => u.id === final[m.key]).name : 'unlinked'}`);
      m.userId = final[m.key];
      m.linkedAt = m.userId ? new Date().toISOString() : null;
      m.linkedBy = m.userId ? actor.userId : null;
    }
  });
  if (changes.length) {
    logActivity(db, `<b>${escapeHtml(actor.name)}</b> updated Social Media Studio member links (${escapeHtml(changes.join(', '))})`);
    save(db);
  }
  flash(req, 'success', changes.length ? `Studio member links saved: ${changes.join(', ')}.` : 'No changes.');
  res.redirect(303, '/social-media/settings#members');
}

// ---------------------------------------------------------------- reels
// Default publishing time for a new reel: the page's first configured slot that still leaves
// the full 24 hours for editing after the shoot (slot − 24h must be after both now and the
// shoot). null when the page has no such slot (the form then asks the user to choose/configure).
function suggestPublish(studio, pageId, shootAt, now) {
  const after = new Date((shootAt > now ? shootAt : now).getTime() + W.EDIT_HOURS_BEFORE_PUBLISH * 3600000);
  const slot = Sched.nextSlot(studio.settings.publishingSchedule, pageId, after);
  return slot ? slot.toISOString() : null;
}

router.get('/reels/new', requireManager, (req, res) => {
  const { now } = req.sm;
  const date = parseDay(req.query.date, W.addDaysD(W.startOfDay(now), 1));
  date.setHours(11, 0, 0, 0);
  render(res, 'reel-form', 'Create reel', {
    item: null,
    draft: { title: '', pageId: C.PAGE_IDS.includes(req.query.page) ? req.query.page : 'product', priority: 'Medium', idea: '', caption: '', prepNotes: '', shootAt: date.toISOString(), publishAt: suggestPublish(req.sm.studio, C.PAGE_IDS.includes(req.query.page) ? req.query.page : 'product', date, now) },
    error: null, back: safeReturn(req.query.returnTo, '/social-media')
  });
});

router.post('/reels', requireManager, (req, res) => {
  const ctx = loadCtx(req);
  const input = { ...req.body };
  if (!req.body.hasPublishAt) input.publishAt = '';
  const result = A.createReel({ ...ctx }, input);
  if (!result.ok) {
    res.status(result.status);
    return render(res, 'reel-form', 'Create reel', { item: null, draft: formDraft(req.body), error: result.error, back: safeReturn(req.body.returnTo, '/social-media') });
  }
  save(ctx.db);
  flash(req, 'success', result.message);
  res.redirect(303, `/social-media/reels/${result.reel.id}`);
});

// Keeps what the user typed when the form is re-shown with an error.
function formDraft(b) {
  const A2 = (v) => { const p = A.parseWhen(v); return p || null; };
  return { title: b.title || '', pageId: C.PAGE_IDS.includes(b.pageId) ? b.pageId : 'product', priority: C.PRIORITIES.includes(b.priority) ? b.priority : 'Medium', idea: b.idea || '', caption: b.caption || '', prepNotes: b.prepNotes || '', shootAt: A2(b.shootAt), publishAt: b.hasPublishAt ? A2(b.publishAt) : null, reason: b.reason || '' };
}

router.get('/reels/:id', (req, res) => {
  const { studio } = req.sm;
  const item = findReel(studio, req.params.id);
  if (!item) return res.status(404).render('social/not-found', { crumb: 'Reel', what: 'Reel', back: '/social-media/tasks' });
  render(res, 'reel', item.title, { item, tab: ['tasks', 'details', 'activity'].includes(req.query.tab) ? req.query.tab : 'tasks' });
});

router.get('/reels/:id/edit', requireManager, (req, res) => {
  const item = findReel(req.sm.studio, req.params.id);
  if (!item) return res.status(404).render('social/not-found', { crumb: 'Reel', what: 'Reel', back: '/social-media/tasks' });
  render(res, 'reel-form', 'Edit reel', { item, draft: { ...item, reason: '' }, error: null, back: `/social-media/reels/${item.id}` });
});

router.post('/reels/:id/:action', (req, res) => {
  const ctx = loadCtx(req);
  const item = findReel(ctx.studio, req.params.id);
  const fallback = item ? `/social-media/reels/${item.id}` : '/social-media/tasks';
  const back = safeReturn(req.body.returnTo, fallback);
  const input = { ...req.body };
  if (req.params.action === 'update') {
    if (!req.body.hasPublishAt) input.publishAt = '';
  }
  const result = A.runReelAction(req.params.action, { ...ctx, item }, input);
  if (!result.ok) {
    if (result.status === 403) return forbidden(res, result.error);
    if (result.status === 404) return res.status(404).render('social/not-found', { crumb: 'Reel', what: 'Reel', back: '/social-media/tasks' });
    if (req.params.action === 'update') {
      res.status(result.status);
      return render(res, 'reel-form', 'Edit reel', { item, draft: { ...formDraft(req.body), rev: item.rev }, error: result.error, back: fallback });
    }
    flash(req, 'error', result.error);
    return res.redirect(303, back);
  }
  save(ctx.db);
  flash(req, 'success', result.message);
  res.redirect(303, req.params.action === 'delete' ? '/social-media' : back);
});

module.exports = router;
