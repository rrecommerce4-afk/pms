function greetingWord() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function topDateStr() {
  const d = new Date();
  const weekday = d.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
  const day = d.getDate();
  const month = d.toLocaleDateString('en-US', { month: 'long' }).toUpperCase();
  return `${weekday}, ${day} ${month}`;
}

function firstName(fullName) {
  return String(fullName || '').trim().split(/\s+/)[0] || '';
}

function listDateStr() {
  const d = new Date();
  const day = d.getDate();
  const month = d.toLocaleDateString('en-US', { month: 'long' }).toUpperCase();
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}

function chipDateStr() {
  const d = new Date();
  const day = d.getDate();
  const month = d.toLocaleDateString('en-US', { month: 'short' });
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}

function dateBadge() {
  const d = new Date();
  return {
    day: String(d.getDate()).padStart(2, '0'),
    month: d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()
  };
}

function dashboardPathForRole(role) {
  if (role === 'admin') return '/admin/dashboard';
  if (role === 'viewer') return '/viewer/dashboard';
  return '/employee/dashboard';
}

function formatIsoDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const day = dt.getDate();
  const month = dt.toLocaleDateString('en-US', { month: 'short' });
  return `${day} ${month} ${y}`;
}

// Given a YYYY-MM-DD string, returns the day before it in the same format.
function yesterdayStr(todayIso) {
  return addDays(todayIso, -1);
}

// Given a YYYY-MM-DD string, returns the date `days` after it (negative to go back), same format.
function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// Whole-day difference between two YYYY-MM-DD strings (b - a), in days.
function daysBetween(aIso, bIso) {
  const [ay, am, ad] = aIso.split('-').map(Number);
  const [by, bm, bd] = bIso.split('-').map(Number);
  const a = Date.UTC(ay, am - 1, ad);
  const b = Date.UTC(by, bm - 1, bd);
  return Math.round((b - a) / 86400000);
}

module.exports = { greetingWord, topDateStr, firstName, dateBadge, listDateStr, chipDateStr, formatIsoDate, yesterdayStr, addDays, daysBetween, dashboardPathForRole };
