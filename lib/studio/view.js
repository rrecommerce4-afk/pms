// View helpers for the Social Media Studio EJS templates: formatting, badges, the reporting
// period, SVG charts and the per-stage action buttons. Every helper that returns HTML escapes
// the user-supplied text it embeds.
const C = require('./config');
const W = require('./workflow');
const P = require('./permissions');

function esc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------- formatting
const asDate = (v) => (v instanceof Date ? v : new Date(v));
function fmtDate(v, style) {
  if (!v) return '—';
  const d = typeof v === 'string' && v.length === 10 ? (() => { const [y, m, dd] = v.split('-').map(Number); return new Date(y, m - 1, dd); })() : asDate(v);
  if (Number.isNaN(d.getTime())) return '—';
  if (style === 'short') return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  if (style === 'weekday') return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  if (style === 'long') return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if (style === 'month') return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtTime(v) {
  if (!v) return '—';
  return asDate(v).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function fmtDateTime(v) {
  if (!v) return '—';
  const d = asDate(v);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${fmtTime(d)}`;
}
function fmtRelative(v, now) {
  if (!v) return '—';
  const diff = asDate(v).getTime() - (now || new Date()).getTime();
  const abs = Math.abs(diff);
  const unit = abs < 3600000 ? [Math.round(abs / 60000), 'minute'] : abs < 86400000 ? [Math.round(abs / 3600000), 'hour'] : [Math.round(abs / 86400000), 'day'];
  const txt = `${unit[0]} ${unit[1]}${unit[0] === 1 ? '' : 's'}`;
  return diff < 0 ? `${txt} ago` : `in ${txt}`;
}
const fmtNum = (n) => new Intl.NumberFormat('en-IN').format(Math.round(n || 0));
const fmtPct = (n, digits) => (Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(digits === undefined ? 1 : digits)}%` : '—');
const fmtHours = (h) => (h === null || h === undefined ? '—' : h >= 24 ? `${(h / 24).toFixed(1)} d` : `${h.toFixed(1)} h`);
// For <input type="datetime-local"> (server local time).
function toInput(v) {
  if (!v) return '';
  const d = asDate(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------- reporting period
const PRESETS = [
  { value: 'this-month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'last-7', label: 'Last 7 days' },
  { value: 'last-30', label: 'Last 30 days' },
  { value: 'last-90', label: 'Last 90 days' },
  { value: 'custom', label: 'Custom range' }
];
function rangeFromPreset(preset, now, custom) {
  const f = (d) => W.localDay(d);
  const y = now.getFullYear(), m = now.getMonth();
  switch (preset) {
    case 'last-month': return { preset, from: f(new Date(y, m - 1, 1)), to: f(new Date(y, m, 0)) };
    case 'last-7': return { preset, from: f(W.addDaysD(now, -6)), to: f(now) };
    case 'last-30': return { preset, from: f(W.addDaysD(now, -29)), to: f(now) };
    case 'last-90': return { preset, from: f(W.addDaysD(now, -89)), to: f(now) };
    case 'custom': {
      const ok = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
      let from = custom && ok(custom.from) ? custom.from : f(W.addDaysD(now, -29));
      let to = custom && ok(custom.to) ? custom.to : f(now);
      if (from > to) [from, to] = [to, from];
      return { preset, from, to };
    }
    default: return { preset: 'this-month', from: f(new Date(y, m, 1)), to: f(new Date(y, m + 1, 0)) };
  }
}

// ---------------------------------------------------------------- badges
const STATUS_TONE = {
  Unclaimed: 'slate', Available: 'sky', 'In Progress': 'blue', Completed: 'green', 'Waiting for footage': 'slate', Blocked: 'amber', Overdue: 'red',
  'Not Started': 'slate', Editing: 'blue', 'Editing Completed': 'green',
  'Not Ready': 'slate', 'Ready to Publish': 'brand', Scheduled: 'sky', Published: 'green', Delayed: 'amber', 'Missed Deadline': 'red',
  'Content Planning': 'slate', 'Shoot Scheduled': 'sky', 'Shoot Completed': 'violet',
  Ranked: 'green', Provisional: 'amber', 'Insufficient Data': 'slate'
};
const PRIORITY_TONE = { Urgent: 'red', High: 'orange', Medium: 'blue', Low: 'slate' };
const TYPE_TONE = { Shoot: 'sky', Editing: 'violet', Publishing: 'green' };

const badge = (text, tone, dot) => `<span class="sm-badge tone-${tone || 'slate'}${dot ? ' dot' : ''}">${esc(text)}</span>`;
const statusBadge = (s) => badge(s, STATUS_TONE[s] || 'slate', true);
const priorityBadge = (p) => badge(p, PRIORITY_TONE[p] || 'slate');
const typeBadge = (t) => badge(t, TYPE_TONE[t] || 'slate');
function pageBadge(pageId, long) {
  const p = C.getPage(pageId);
  if (!p) return '';
  return `<span class="sm-page-badge" style="--pc:${p.color};--pcs:${p.soft};"><i></i>${esc(long ? p.name : p.shortName)}</span>`;
}
function initials(name) {
  return String(name || '?').trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase()).slice(0, 2).join('');
}
function timingBadge(c) {
  if (!c) return '';
  if (c.excused) return badge('Blocker excused', 'slate');
  if (c.onTime === undefined) return badge('No deadline', 'slate');
  return c.onTime ? badge('On time', 'green') : badge('Late', 'amber');
}
const demoBadge = (label) => `<span class="sm-demo-badge">${esc(label || 'DEMO DATA — INSTAGRAM NOT CONNECTED')}</span>`;
const liveBadge = (label) => `<span class="sm-live-badge">${esc(label || 'LIVE — FROM INSTAGRAM')}</span>`;

// Follower data labels. `src` maps pageId → 'live' | 'demo' (followers.sources()).
function followerLabel(src, ids) {
  const list = ids || Object.keys(src);
  const live = list.filter((id) => src[id] === 'live').length;
  if (live === list.length) return 'LIVE — FROM INSTAGRAM';
  if (live === 0) return 'DEMO DATA — INSTAGRAM NOT CONNECTED';
  return `PARTLY DEMO DATA — ${live} of ${list.length} pages connected to Instagram`;
}
function followerBadge(src, ids) {
  const text = followerLabel(src, ids);
  return text.startsWith('LIVE') ? liveBadge(text) : demoBadge(text);
}

// Builds the people helpers bound to the current users list.
function peopleHelpers(users, studio) {
  const byId = new Map(users.map((u) => [u.id, u]));
  const nameOf = (id, fallback) => { const u = id ? byId.get(id) : null; return u ? u.name : fallback || (id ? `User #${id}` : '—'); };
  const keyName = (key) => { const uid = P.userIdForKey(studio, key); const r = C.getRosterEntry(key); return uid ? nameOf(uid, r && r.name) : (r ? r.name : key); };
  const ownerChip = (id, emptyLabel) => {
    if (!id) return `<span class="sm-owner empty">${esc(emptyLabel || 'Unclaimed')}</span>`;
    const n = nameOf(id);
    return `<span class="sm-owner"><span class="sm-av">${esc(initials(n))}</span>${esc(n)}</span>`;
  };
  const keyChip = (key, sub) => {
    const n = keyName(key);
    const linked = !!P.userIdForKey(studio, key);
    return `<span class="sm-person"><span class="sm-av${linked ? '' : ' unlinked'}">${esc(initials(n))}</span><span><b>${esc(n)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}${linked ? '' : '<small class="warn-txt">Not linked to a PMS account</small>'}</span></span>`;
  };
  return { nameOf, keyName, ownerChip, keyChip };
}

// ---------------------------------------------------------------- task actions
// Describes the controls one user gets for one stage of one reel (port of TaskActions.tsx).
// The server re-checks every one of these on POST; this only decides what to render.
function stageActions(actor, studio, item, stage, nameOf, extended) {
  if (!actor || actor.readOnly) return [];
  const s = studio.settings;
  const out = [];
  const hint = (text, icon) => out.push({ type: 'hint', text, icon: icon || 'lock' });
  const post = (action, label, variant, extra) => out.push({ type: 'post', action, label, variant: variant || 'primary', fields: extra || {} });
  const modal = (modalId, label, variant, data) => out.push({ type: 'modal', modal: modalId, label, variant: variant || 'primary', data: data || {} });
  const link = (href, label) => out.push({ type: 'link', href, label });
  const me = actor.userId;
  const reelUrl = `/social-media/reels/${item.id}`;

  const blockerControls = (st) => {
    if (!extended || !P.canBlock(actor, item, st)) return;
    const target = st === 'Shoot' ? item.shoot : item.editing;
    if (W.activeBlocker(target.blocker)) post('resolve-blocker', 'Resolve blocker', 'ghost', { stage: st });
    else modal('reason', 'Report blocker', 'ghost', { action: 'blocker', stage: st, title: `Report ${st.toLowerCase()} blocker`, label: 'Blocker', placeholder: 'e.g. Product sample not delivered', confirm: 'Record blocker' });
  };

  if (stage === 'Shoot') {
    const owner = item.shootOwner;
    if (W.isShootDone(item)) {
      if (item.shoot.rawSubmitted) hint(`Completed by ${nameOf(item.shoot.completion && item.shoot.completion.by)}`, 'check');
      else if (actor.canWork && owner === me) post('raw-ready', 'Mark raw footage ready');
      else hint('Raw footage pending');
      return out;
    }
    if (!owner) {
      if (actor.canWork) {
        if (P.canShoot(actor, s, item.pageId)) post('claim-shoot', 'Take Shoot Task');
        else hint('Not on this page team');
      }
      if (actor.isManager) link(`${reelUrl}#assign-Shoot`, 'Assign…');
    } else if (actor.canWork && owner === me) {
      modal('complete-shoot', 'Mark Shoot Completed', 'primary', { late: new Date() > W.effectiveShootDeadline(item) ? '1' : '' });
      if (extended) post('release-shoot', 'Release', 'ghost');
    } else {
      hint(`Claimed by ${nameOf(owner)}`);
      if (actor.isManager) link(`${reelUrl}#assign-Shoot`, 'Reassign…');
    }
    blockerControls('Shoot');
    return out;
  }

  if (stage === 'Editing') {
    const owner = item.editor;
    if (!W.footageReady(item)) { hint('Waiting for shoot & raw footage'); return out; }
    if (W.isEditingDone(item)) {
      hint(`Edited by ${nameOf(item.editing.completion && item.editing.completion.by)}`, 'check');
      const canReopen = !W.isPublished(item) && (actor.isManager || (actor.canEditVideo && owner === me));
      if (extended && canReopen) modal('reason', 'Reopen editing', 'ghost', { action: 'reopen-edit', title: 'Reopen editing', label: 'Reason', placeholder: 'e.g. Changes requested verbally', confirm: 'Reopen' });
      return out;
    }
    if (!owner) {
      if (actor.canEditVideo) {
        if (P.canEditReel(actor, s, item.pageId)) post('claim-edit', 'Take Editing Task');
        else hint('Not an editor for this page', 'ban');
      } else if (actor.canWork) hint('Editing team only', 'ban');
      if (actor.isManager) link(`${reelUrl}#assign-Editing`, 'Assign…');
    } else if (actor.canEditVideo && owner === me) {
      modal('complete-edit', 'Mark Editing Completed', 'primary', { notes: item.editing.notes || '' });
      if (extended) post('release-edit', 'Release', 'ghost');
    } else {
      hint(`Claimed by ${nameOf(owner)}`);
      if (actor.isManager) link(`${reelUrl}#assign-Editing`, 'Reassign…');
    }
    blockerControls('Editing');
    return out;
  }

  // Publishing
  if (!W.isEditingDone(item)) { hint('Opens after editing is completed'); return out; }
  if (W.isPublished(item)) { hint(`Published by ${nameOf(item.publishingOwner)}`, 'check'); return out; }
  const canConfirm = P.canPublish(actor, s, item.pageId);
  if (canConfirm) modal('publish', 'Mark as Published', 'primary', { planned: item.publishAt ? fmtDateTime(item.publishAt) : '' });
  if (actor.canWork && !canConfirm) hint('Not on this page team');
  if (item.publishing.status !== 'Scheduled' && (actor.isManager || canConfirm)) modal('schedule', 'Schedule', 'outline', { publishAt: toInput(item.publishAt) });
  if (extended && actor.isManager && item.publishing.status !== 'Delayed') modal('reason', 'Mark delayed', 'ghost', { action: 'delay', title: 'Mark publishing delayed', label: 'Delay reason', confirm: 'Mark delayed' });
  if (extended && actor.isManager) modal('reschedule', 'Reschedule', 'ghost', { publishAt: toInput(item.publishAt) });
  if (actor.isManager && !canConfirm && !extended) hint('Employees confirm uploads');
  return out;
}

// ---------------------------------------------------------------- SVG charts
const niceMax = (v) => { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };
const compact = (n) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

// Multi-series line chart. series: [{ key, label, color }]; rows: [{ label, [key]: number }]
function lineChart(rows, series, opts) {
  const o = Object.assign({ height: 260, width: 720, gain: false, area: false }, opts || {});
  if (!rows.length || !series.length) return '<div class="sm-chart-empty">No data for this period.</div>';
  const padL = 52, padR = 12, padT = 10, padB = 26;
  const has = (v) => typeof v === 'number' && Number.isFinite(v);
  const vals = rows.flatMap((r) => series.map((s) => r[s.key])).filter(has);
  if (!vals.length) return '<div class="sm-chart-empty">Not enough data for this period.</div>';
  let min = o.fixedMin !== undefined ? o.fixedMin : Math.min(...vals), max = o.fixedMax !== undefined ? o.fixedMax : Math.max(...vals);
  if (o.fixedMax === undefined) {
    if (!o.gain && !o.area) { const span = Math.max(1, max - min); min = Math.max(0, min - span * 0.08); max += span * 0.08; }
    if (o.gain || o.area) { min = Math.min(0, min); max = niceMax(max); }
  }
  if (max === min) max = min + 1;
  const iw = o.width - padL - padR, ih = o.height - padT - padB;
  const x = (i) => padL + (rows.length === 1 ? iw / 2 : (i / (rows.length - 1)) * iw);
  const y = (v) => padT + ih - ((v - min) / (max - min)) * ih;
  let svg = `<svg class="sm-chart" viewBox="0 0 ${o.width} ${o.height}" preserveAspectRatio="none" role="img" aria-label="${esc(o.label || 'Chart')}">`;
  for (let g = 0; g <= 4; g++) {
    const v = min + ((max - min) * g) / 4;
    svg += `<line x1="${padL}" x2="${o.width - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/><text x="${padL - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" class="axis">${esc(compact(v))}</text>`;
  }
  const step = Math.max(1, Math.ceil(rows.length / 8));
  rows.forEach((r, i) => { if (i % step === 0 || i === rows.length - 1) svg += `<text x="${x(i).toFixed(1)}" y="${o.height - 8}" text-anchor="middle" class="axis">${esc(r.label)}</text>`; });
  series.forEach((s) => {
    // Missing values (null) break the line instead of being drawn as zero.
    const segments = [[]];
    rows.forEach((r, i) => { if (has(r[s.key])) segments[segments.length - 1].push(`${x(i).toFixed(1)},${y(r[s.key]).toFixed(1)}`); else if (segments[segments.length - 1].length) segments.push([]); });
    if (o.area && segments.length === 1 && segments[0].length) svg += `<polygon points="${x(0).toFixed(1)},${y(min).toFixed(1)} ${segments[0].join(' ')} ${x(rows.length - 1).toFixed(1)},${y(min).toFixed(1)}" fill="${s.color}" opacity="0.12"/>`;
    segments.filter((g) => g.length > 1).forEach((g) => { svg += `<polyline points="${g.join(' ')}" fill="none" stroke="${s.color}" stroke-width="2.2" vector-effect="non-scaling-stroke"/>`; });
    if (rows.length <= 45) rows.forEach((r, i) => { if (has(r[s.key])) svg += `<circle cx="${x(i).toFixed(1)}" cy="${y(r[s.key]).toFixed(1)}" r="2.6" fill="${s.color}"><title>${esc(`${s.label} · ${r.label}: ${fmtNum(r[s.key])}`)}</title></circle>`; });
  });
  return svg + '</svg>';
}

// Grouped or stacked bar chart. series: [{ key, label, color }]; rows: [{ label, [key]: number }]
function barChart(rows, series, opts) {
  const o = Object.assign({ height: 240, width: 560, stacked: false }, opts || {});
  if (!rows.length) return '<div class="sm-chart-empty">No data.</div>';
  const padL = 36, padR = 8, padT = 10, padB = 26;
  const totals = rows.map((r) => (o.stacked ? series.reduce((s, x) => s + Math.max(0, r[x.key] || 0), 0) : Math.max(...series.map((x) => r[x.key] || 0))));
  const minVal = o.stacked ? 0 : Math.min(0, ...rows.flatMap((r) => series.map((x) => r[x.key] || 0)));
  const max = niceMax(Math.max(1, ...totals));
  const iw = o.width - padL - padR, ih = o.height - padT - padB;
  const y = (v) => padT + ih - ((v - minVal) / (max - minVal)) * ih;
  const band = iw / rows.length;
  let svg = `<svg class="sm-chart" viewBox="0 0 ${o.width} ${o.height}" role="img" aria-label="${esc(o.label || 'Chart')}">`;
  for (let g = 0; g <= 4; g++) {
    const v = minVal + ((max - minVal) * g) / 4;
    svg += `<line x1="${padL}" x2="${o.width - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/><text x="${padL - 5}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" class="axis">${esc(compact(Math.round(v)))}</text>`;
  }
  rows.forEach((r, i) => {
    const x0 = padL + i * band + band * 0.15;
    const bw = band * 0.7;
    if (o.stacked) {
      let acc = 0;
      series.forEach((s) => {
        const v = Math.max(0, r[s.key] || 0);
        if (!v) return;
        svg += `<rect x="${x0.toFixed(1)}" y="${y(acc + v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(y(acc) - y(acc + v)).toFixed(1)}" fill="${s.color}"><title>${esc(`${r.label} · ${s.label}: ${v}`)}</title></rect>`;
        acc += v;
      });
    } else {
      const w = bw / series.length;
      series.forEach((s, k) => {
        const v = r[s.key] || 0;
        const top = y(Math.max(0, v)), bottom = y(Math.min(0, v));
        svg += `<rect x="${(x0 + k * w).toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(1, w - 2).toFixed(1)}" height="${Math.max(0.5, bottom - top).toFixed(1)}" fill="${s.color}" rx="2"><title>${esc(`${r.label} · ${s.label}: ${fmtNum(v)}`)}</title></rect>`;
      });
    }
    svg += `<text x="${(padL + i * band + band / 2).toFixed(1)}" y="${o.height - 8}" text-anchor="middle" class="axis">${esc(r.label)}</text>`;
  });
  return svg + '</svg>';
}

const legend = (series) => `<div class="sm-legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>`;

module.exports = {
  esc, fmtDate, fmtTime, fmtDateTime, fmtRelative, fmtNum, fmtPct, fmtHours, toInput,
  PRESETS, rangeFromPreset, badge, statusBadge, priorityBadge, typeBadge, pageBadge, timingBadge, demoBadge, liveBadge, followerLabel, followerBadge, initials,
  STATUS_TONE, peopleHelpers, stageActions, lineChart, barChart, legend
};
