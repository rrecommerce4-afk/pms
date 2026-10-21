// DEMO DATA — INSTAGRAM NOT CONNECTED. Follower numbers are generated locally from a fixed
// seed (ported from the Studio's data/followers.ts + lib/followers.ts). Nothing is fetched
// from Instagram or Meta, and nothing here may be presented as real performance.
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

const slice = (h, from, to) => h.filter((p) => p.date >= from && p.date <= to);
function pointBefore(h, date) {
  let prev = h[0];
  for (const p of h) { if (p.date >= date) break; prev = p; }
  return prev;
}
const toUtc = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const dayDiff = (a, b) => Math.round((toUtc(b) - toUtc(a)) / 86400000);
function shiftDay(iso, n) { const [y, m, d] = iso.split('-').map(Number); return W.localDay(new Date(y, m - 1, d + n)); }
function weekStart(iso) { const [y, m, d] = iso.split('-').map(Number); const dt = new Date(y, m - 1, d); const back = (dt.getDay() + 6) % 7; return W.localDay(new Date(y, m - 1, d - back)); }

function summarize(h, pageId, from, to) {
  const s = slice(h, from, to);
  const days = Math.max(1, dayDiff(from, to) + 1);
  const startPoint = pointBefore(h, from);
  const endPoint = s[s.length - 1] || startPoint;
  const current = endPoint ? endPoint[pageId] : 0;
  const previous = startPoint ? startPoint[pageId] : 0;
  const net = current - previous;
  const prevStart = pointBefore(h, shiftDay(from, -days));
  const prevNet = previous - (prevStart ? prevStart[pageId] : previous);
  let bestDay = null;
  const weeks = new Map();
  let last = previous;
  for (const p of s) {
    const gain = p[pageId] - last;
    last = p[pageId];
    if (!bestDay || gain > bestDay.gain) bestDay = { date: p.date, gain };
    const wk = weekStart(p.date);
    weeks.set(wk, (weeks.get(wk) || 0) + gain);
  }
  let bestWeek = null;
  weeks.forEach((gain, week) => { if (!bestWeek || gain > bestWeek.gain) bestWeek = { week, gain }; });
  return {
    pageId, current, previous, net, prevNet,
    growthPct: previous ? (net / previous) * 100 : 0,
    vsPrevPct: prevNet ? ((net - prevNet) / Math.abs(prevNet)) * 100 : 0,
    avgDaily: net / days, bestDay, bestWeek
  };
}

// Daily or weekly rows of totals (or gains) per page, for charts.
function chartSeries(h, from, to, mode, bucket) {
  const s = slice(h, from, to);
  let prev = pointBefore(h, from);
  const rows = [];
  const push = (p, label) => {
    const row = { date: p.date, label };
    IDS.forEach((id) => { row[id] = mode === 'total' ? p[id] : p[id] - prev[id]; });
    row.all = IDS.reduce((sum, id) => sum + row[id], 0);
    rows.push(row);
    prev = p;
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

function monthlyClosing(h) {
  const map = new Map();
  h.forEach((p) => map.set(p.date.slice(0, 7), p));
  return [...map.entries()].map(([month, point]) => ({ month, point }));
}

module.exports = { DEMO_LABEL, generateHistory, summarize, chartSeries, monthlyClosing, dayDiff, shiftDay };
