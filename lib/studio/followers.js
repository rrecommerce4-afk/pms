// Follower history for the four pages.
//
// Pages connected to Instagram (see instagram.js) use their saved daily snapshots: real
// readings, plus any days estimated from Instagram's daily follower change. Days before a
// page was connected have no value (null) rather than invented numbers.
//
// Pages that are NOT connected use DEMO DATA — INSTAGRAM NOT CONNECTED: numbers generated
// locally from a fixed seed (ported from the Studio's data/followers.ts). Every screen labels
// which pages are live and which are demo.
const W = require('./workflow');

const DEMO_LABEL = 'DEMO DATA — INSTAGRAM NOT CONNECTED';
const HISTORY_DAYS = 365;
const PROFILE = {
  product: { start: 15200, dailyGain: 27, noise: 22, seed: 11 },
  farma: { start: 6100, dailyGain: 14, noise: 12, seed: 23 },
  stencil: { start: 9300, dailyGain: 18, noise: 16, seed: 37 },
  butterpaper: { start: 4700, dailyGain: 11, noise: 10, seed: 41 }
};
const IDS = Object.keys(PROFILE);
const SCENARIO_FACTOR = { conservative: 0.6, baseline: 1, optimistic: 1.45 };
const has = (v) => typeof v === 'number' && Number.isFinite(v);

// Deterministic PRNG (mulberry32) so mock data is stable between requests.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cache = new Map();
function generateHistory(scenario, today) {
  const end = W.startOfDay(today);
  const key = `${scenario}:${W.localDay(end)}`;
  if (cache.has(key)) return cache.get(key);
  const factor = SCENARIO_FACTOR[scenario] || 1;
  const start = W.addDaysD(end, -(HISTORY_DAYS - 1));
  const rngs = Object.fromEntries(IDS.map((id) => [id, seeded(PROFILE[id].seed)]));
  const current = Object.fromEntries(IDS.map((id) => [id, PROFILE[id].start]));
  const points = [];
  for (let i = 0; i < HISTORY_DAYS; i++) {
    const day = W.addDaysD(start, i);
    const point = { date: W.localDay(day) };
    IDS.forEach((id) => {
      const p = PROFILE[id];
      const r = rngs[id];
      const weekend = day.getDay() === 0 || day.getDay() === 6 ? 1.25 : 1;
      const trend = 0.75 + (i / HISTORY_DAYS) * 0.6;
      let gain = p.dailyGain * trend * weekend + (r() - 0.45) * p.noise;
      if (r() < 0.025) gain += p.dailyGain * (4 + r() * 8);
      if (r() < 0.04) gain = -Math.abs(gain) * 0.6;
      current[id] = Math.max(0, current[id] + Math.round(gain * factor));
      point[id] = current[id];
    });
    points.push(point);
  }
  cache.clear();
  cache.set(key, points);
  return points;
}

// Which pages show live Instagram data (connected and with at least one saved reading).
function sources(studio) {
  const ig = studio.instagram || {};
  return Object.fromEntries(IDS.map((id) => {
    const st = ig.status && ig.status[id];
    const snaps = ig.snapshots && ig.snapshots[id];
    return [id, st && st.connected && Array.isArray(snaps) && snaps.length ? 'live' : 'demo'];
  }));
}

// History used by every screen: demo series for unconnected pages, saved snapshots for
// connected ones (null on days without a reading).
function history(studio, today) {
  const src = sources(studio);
  const demo = generateHistory(studio.settings.followerScenario, today);
  if (!IDS.some((id) => src[id] === 'live')) return demo;
  const byPage = Object.fromEntries(IDS.filter((id) => src[id] === 'live').map((id) => [id, new Map(studio.instagram.snapshots[id].map((s) => [s.date, s.followers]))]));
  return demo.map((p) => {
    const row = { ...p };
    Object.keys(byPage).forEach((id) => { const v = byPage[id].get(p.date); row[id] = has(v) ? v : null; });
    return row;
  });
}

const toUtc = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const dayDiff = (a, b) => Math.round((toUtc(b) - toUtc(a)) / 86400000);
function shiftDay(iso, n) { const [y, m, d] = iso.split('-').map(Number); return W.localDay(new Date(y, m - 1, d + n)); }
function weekStart(iso) { const [y, m, d] = iso.split('-').map(Number); const dt = new Date(y, m - 1, d); const back = (dt.getDay() + 6) % 7; return W.localDay(new Date(y, m - 1, d - back)); }

// Last known value on or before `date` (exclusive when strict), else null.
function valueAt(points, date, strict) {
  let v = null;
  for (const p of points) {
    if (strict ? p.date >= date : p.date > date) break;
    v = p;
  }
  return v;
}

function summarize(h, pageId, from, to) {
  const days = Math.max(1, dayDiff(from, to) + 1);
  const pts = h.filter((p) => has(p[pageId])).map((p) => ({ date: p.date, v: p[pageId] }));
  const inRange = pts.filter((p) => p.date >= from && p.date <= to);
  const end = valueAt(pts, to, false);
  // Baseline: the last reading before the period, or (for a page connected mid-period) its first reading in it.
  const start = valueAt(pts, from, true) || inRange[0] || null;
  if (!end || !start) {
    return { pageId, noData: true, current: end ? end.v : 0, previous: 0, net: 0, prevNet: 0, growthPct: 0, vsPrevPct: 0, avgDaily: 0, bestDay: null, bestWeek: null, since: null };
  }
  const current = end.v;
  const previous = start.v;
  const net = current - previous;
  const prevStart = valueAt(pts, shiftDay(from, -days), true);
  const prevNet = prevStart ? previous - prevStart.v : 0;
  let bestDay = null;
  const weeks = new Map();
  let last = start;
  for (const p of inRange) {
    if (p === start) continue;
    const gain = p.v - last.v;
    last = p;
    if (!bestDay || gain > bestDay.gain) bestDay = { date: p.date, gain };
    const wk = weekStart(p.date);
    weeks.set(wk, (weeks.get(wk) || 0) + gain);
  }
  let bestWeek = null;
  weeks.forEach((gain, week) => { if (!bestWeek || gain > bestWeek.gain) bestWeek = { week, gain }; });
  const coveredDays = Math.max(1, dayDiff(start.date < from ? from : start.date, end.date) + (start.date < from ? 1 : 0));
  return {
    pageId, current, previous, net, prevNet,
    growthPct: previous ? (net / previous) * 100 : 0,
    vsPrevPct: prevStart && prevNet ? ((net - prevNet) / Math.abs(prevNet)) * 100 : 0,
    avgDaily: net / coveredDays, bestDay, bestWeek,
    // Set when the data starts inside the period (page connected recently).
    since: start.date >= from ? start.date : null
  };
}

// Daily or weekly rows of totals (or gains) per page, for charts. Missing readings are null.
function chartSeries(h, from, to, mode, bucket) {
  const s = h.filter((p) => p.date >= from && p.date <= to);
  const prev = {};
  IDS.forEach((id) => { const b = valueAt(h.filter((p) => has(p[id])), from, true); prev[id] = b ? b[id] : null; });
  const rows = [];
  const push = (p, label) => {
    const row = { date: p.date, label };
    IDS.forEach((id) => {
      const v = p[id];
      row[id] = !has(v) ? null : mode === 'total' ? v : has(prev[id]) ? v - prev[id] : null;
      if (has(v)) prev[id] = v;
    });
    row.all = IDS.every((id) => has(row[id])) ? IDS.reduce((sum, id) => sum + row[id], 0) : null;
    rows.push(row);
  };
  const lbl = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };
  if (bucket === 'day') s.forEach((p) => push(p, lbl(p.date)));
  else {
    let cur = '';
    let lastOfWeek = null;
    s.forEach((p, i) => {
      const wk = weekStart(p.date);
      if (cur && wk !== cur && lastOfWeek) push(lastOfWeek, `Wk ${lbl(cur)}`);
      cur = wk;
      lastOfWeek = p;
      if (i === s.length - 1) push(p, `Wk ${lbl(wk)}`);
    });
  }
  return rows;
}

// Closing value per month (last reading in the month; null if a page has none that month).
function monthlyClosing(h) {
  const map = new Map();
  h.forEach((p) => {
    const m = p.date.slice(0, 7);
    const prev = map.get(m) || {};
    const next = { ...prev, date: p.date };
    IDS.forEach((id) => { if (has(p[id])) next[id] = p[id]; else if (!(id in next)) next[id] = null; });
    map.set(m, next);
  });
  return [...map.entries()].map(([month, point]) => ({ month, point }));
}

module.exports = { DEMO_LABEL, generateHistory, history, sources, summarize, chartSeries, monthlyClosing, dayDiff, shiftDay };
