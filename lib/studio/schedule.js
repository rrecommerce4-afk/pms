// Weekly publishing schedule per Instagram page (Settings → Publishing Schedule).
//
// Stored in studio.settings.publishingSchedule as
//   { product: { mon: { enabled: true, slots: ['13:00', '18:30'] }, tue: {...}, ... }, farma: {...}, ... }
// Times are 24-hour "HH:mm" in the server's local time zone — the same convention every other
// Studio date uses (datetime-local inputs are parsed on the server in its local time).
//
// The schedule only drives SUGGESTIONS. A reel's own publishAt is what counts; changing the
// recurring schedule never changes reels that already have a publishing time.
const C = require('./config');

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABEL = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const JS_DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // Date#getDay() → key
const MAX_SLOTS_PER_DAY = 10;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const emptyWeek = () => Object.fromEntries(DAYS.map((d) => [d, { enabled: false, slots: [] }]));
const emptySchedule = () => Object.fromEntries(C.PAGE_IDS.map((p) => [p, emptyWeek()]));

// "9:5" / "09:05:00" style input → "09:05", or null when it isn't a valid time.
function normTime(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const t = `${m[1].padStart(2, '0')}:${m[2]}`;
  return TIME_RE.test(t) ? t : null;
}

// Cleans a stored or submitted schedule: known pages and days only, valid unique sorted times.
function sanitizeSchedule(raw) {
  const out = emptySchedule();
  if (!raw || typeof raw !== 'object') return out;
  C.PAGE_IDS.forEach((p) => {
    const week = raw[p];
    if (!week || typeof week !== 'object') return;
    DAYS.forEach((d) => {
      const day = week[d];
      if (!day || typeof day !== 'object') return;
      const slots = [...new Set((Array.isArray(day.slots) ? day.slots : []).map(normTime).filter(Boolean))].sort().slice(0, MAX_SLOTS_PER_DAY);
      out[p][d] = { enabled: day.enabled === true, slots };
    });
  });
  return out;
}

// Parses the Settings form for ONE page. Returns { week } or { error } — invalid times are
// rejected rather than silently dropped.
function parseWeekForm(body) {
  const week = emptyWeek();
  for (const d of DAYS) {
    const raw = body[`${d}_slots`];
    const values = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map((v) => String(v).trim()).filter((v) => v !== '');
    const slots = [];
    for (const v of values) {
      const t = normTime(v);
      if (!t) return { error: `${DAY_LABEL[d]}: "${v.slice(0, 20)}" is not a valid time. Use the time picker (HH:mm).` };
      if (!slots.includes(t)) slots.push(t);
    }
    if (slots.length > MAX_SLOTS_PER_DAY) return { error: `${DAY_LABEL[d]}: at most ${MAX_SLOTS_PER_DAY} publishing slots per day.` };
    week[d] = { enabled: body[`${d}_enabled`] === 'on' || body[`${d}_enabled`] === '1', slots: slots.sort() };
  }
  return { week };
}

const dayKey = (date) => JS_DAY[date.getDay()];
const ymd = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

// Slots that apply on a given calendar date (server local), as Date objects. Disabled days → [].
function slotsForDate(schedule, pageId, dateStr) {
  const m = typeof dateStr === 'string' && dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return [];
  const base = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const day = schedule && schedule[pageId] && schedule[pageId][dayKey(base)];
  if (!day || !day.enabled) return [];
  return day.slots.map((t) => { const [h, mi] = t.split(':').map(Number); return new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, mi); });
}

// Upcoming slots strictly after `after`, scanning up to two weeks ahead.
function nextSlots(schedule, pageId, after, limit) {
  const out = [];
  const start = new Date(after.getFullYear(), after.getMonth(), after.getDate());
  for (let i = 0; i <= 14 && out.length < (limit || 1); i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    slotsForDate(schedule, pageId, ymd(day)).forEach((s) => { if (s > after && out.length < (limit || 1)) out.push(s); });
  }
  return out;
}
const nextSlot = (schedule, pageId, after) => nextSlots(schedule, pageId, after, 1)[0] || null;

const hasAnySlot = (schedule, pageId) => !!(schedule && schedule[pageId] && DAYS.some((d) => schedule[pageId][d].enabled && schedule[pageId][d].slots.length));

// "13:00" → "1:00 PM"
function fmtSlot(t) {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

module.exports = { DAYS, DAY_LABEL, MAX_SLOTS_PER_DAY, emptyWeek, emptySchedule, normTime, sanitizeSchedule, parseWeekForm, slotsForDate, nextSlots, nextSlot, hasAnySlot, fmtSlot, dayKey, ymd };
