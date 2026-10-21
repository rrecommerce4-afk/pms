// Fair, explainable employee scoring (ported from the Studio's lib/scoring.ts).
//
// 1. Only work an employee actually owns counts. Unclaimed tasks are never attributed to anyone.
// 2. Credit goes to the employee recorded on the completion — one completion per task, so no
//    duplicate credit is possible.
// 3. A task is "due" once it is completed, or once it is claimed and past its deadline.
//    Claimed work that is not yet due is workload only.
// 4. Rates, not raw counts, drive the score. Volume is shown separately as contribution.
// 5. Categories with no due work are excluded and the remaining weights re-normalised.
// 6. Documented blockers and tasks without a deadline are excluded from timeliness.
// 7. The same minimum-data rule (configurable) marks scores Provisional / Insufficient Data.
// 8. Equal scores share the same rank. No bonuses or hidden adjustments.
//
// Only the four ranked roster slots (Bansi, Bhavin, Vishnu, Krutik) that are linked to PMS
// users are ever scored; records owned by anyone else are skipped entirely.
const C = require('./config');
const W = require('./workflow');
const P = require('./permissions');

const ratio = (num, den) => (den > 0 ? num / den : null);
const pct = (r) => (r === null ? '—' : `${Math.round(r * 100)}%`);

const COMPONENT_LABELS = {
  onTime: 'On-time task completion',
  shootDelivery: 'Shooting & raw footage delivery',
  editing: 'Editing completion & timeliness',
  publishing: 'Publishing schedule compliance'
};

const SCORING_PRINCIPLES = [
  'Only work you own counts: unclaimed tasks are never attributed to anyone.',
  'Credit goes to the employee recorded on the completion. Each task can be completed (and credited) once.',
  'A task becomes due for scoring when it is completed, or when it is claimed and past its deadline. Claimed work that is not yet due is shown as workload only.',
  'Scores use rates, not counts: claiming or touching many reels does not raise a score by itself. Volume is shown separately as contribution.',
  'Categories with no due work for you are excluded and the remaining weights are re-normalised, so you are never penalised for work you were not assigned or eligible for.',
  'Tasks with a documented blocker, or without any deadline, are excluded from timeliness.',
  'The same minimum-data rule applies to everyone. Equal scores share the same rank. No bonuses or hidden adjustments.'
];

const emptyPages = () => Object.fromEntries(C.PAGE_IDS.map((p) => [p, 0]));
function emptyCategory(category) {
  return { category, claimed: 0, completed: 0, onTime: 0, late: 0, excused: 0, noDeadline: 0, openNotDue: 0, openOverdue: 0, blocked: 0, due: 0, completionRate: null, onTimeRate: null, avgCompletionH: null, rawDelivered: 0, pages: emptyPages() };
}

// Per-employee, per-category stats for a period. A completed task belongs to the period of its
// completion date; an unfinished claimed task belongs to the period of its deadline (or the
// current period if it is overdue now).
function collectStats(items, now, settings, from, to, rankedIds) {
  const ranked = new Set(rankedIds);
  const stats = new Map();
  const get = (id) => {
    let s = stats.get(id);
    if (!s) {
      s = { Shoot: emptyCategory('Shoot'), Editing: emptyCategory('Editing'), Publishing: emptyCategory('Publishing'), _d: { Shoot: [], Editing: [], Publishing: [] } };
      stats.set(id, s);
    }
    return s;
  };
  const nowDay = W.localDay(now);
  const currentPeriod = nowDay >= from && nowDay <= to;

  const addCompleted = (id, cat, pageId, c, claimedAt) => {
    if (!ranked.has(id)) return;
    const s = get(id);
    const k = s[cat];
    k.claimed++;
    k.completed++;
    k.pages[pageId] = (k.pages[pageId] || 0) + 1;
    if (c.excused) k.excused++;
    else if (c.onTime === undefined) k.noDeadline++;
    else if (c.onTime) k.onTime++;
    else k.late++;
    const h = W.hoursBetween(claimedAt, c.at);
    if (h !== null && h >= 0) s._d[cat].push(h);
  };
  const addOpen = (id, cat, deadline, overdue, blocked) => {
    if (!ranked.has(id)) return;
    const belongs = deadline ? W.inRange(deadline.toISOString(), from, to) || (overdue && currentPeriod) : currentPeriod;
    if (!belongs) return;
    const k = get(id)[cat];
    k.claimed++;
    if (blocked) k.blocked++;
    else if (overdue) k.openOverdue++;
    else k.openNotDue++;
  };

  for (const i of items) {
    if (i.deletedAt) continue;
    if (i.shoot.completion) {
      if (W.inRange(i.shoot.completion.at, from, to)) {
        addCompleted(i.shoot.completion.by, 'Shoot', i.pageId, i.shoot.completion, i.shoot.claimedAt);
        if (i.shoot.rawSubmitted && ranked.has(i.shoot.completion.by)) get(i.shoot.completion.by).Shoot.rawDelivered++;
      }
    } else if (i.shootOwner) {
      addOpen(i.shootOwner, 'Shoot', new Date(i.shootAt), W.isShootOverdue(i, now), W.activeBlocker(i.shoot.blocker));
    }
    const ec = i.editing.completion;
    if (ec) {
      if (W.inRange(ec.at, from, to)) addCompleted(ec.by, 'Editing', i.pageId, ec, i.editing.claimedAt);
    } else if (i.editor && W.footageReady(i)) {
      addOpen(i.editor, 'Editing', W.editingDeadline(i, settings), W.isEditOverdue(i, now, settings), W.activeBlocker(i.editing.blocker));
    }
    const pc = i.publishing.completion;
    if (pc && W.inRange(pc.at, from, to)) addCompleted(pc.by, 'Publishing', i.pageId, pc, null);
  }

  for (const s of stats.values()) {
    W.TASK_TYPES.forEach((cat) => {
      const k = s[cat];
      k.due = k.completed + k.openOverdue;
      k.completionRate = ratio(k.completed, k.due);
      k.onTimeRate = ratio(k.onTime, k.onTime + k.late + k.openOverdue);
      const d = s._d[cat];
      k.avgCompletionH = d.length >= 3 ? d.reduce((a, b) => a + b, 0) / d.length : null;
    });
  }
  return (id) => { const s = get(id); return { Shoot: s.Shoot, Editing: s.Editing, Publishing: s.Publishing }; };
}

function rankStatus(due, settings) {
  return due < settings.ranking.minDueTasks ? 'Insufficient Data' : due < settings.ranking.provisionalBelow ? 'Provisional' : 'Ranked';
}

function scoreEmployee(id, name, isEditorEligible, cats, settings) {
  const all = [cats.Shoot, cats.Editing, cats.Publishing];
  const sh = cats.Shoot, ed = cats.Editing, pu = cats.Publishing;
  const sum = (f) => all.reduce((s, c) => s + f(c), 0);
  const onTime = sum((c) => c.onTime);
  const late = sum((c) => c.late);
  const openOverdue = sum((c) => c.openOverdue);
  const completed = sum((c) => c.completed);
  const due = sum((c) => c.due);
  const durations = all.filter((c) => c.avgCompletionH !== null);
  const totals = {
    claimed: sum((c) => c.claimed), completed, onTime, late, due, openOverdue,
    openNotDue: sum((c) => c.openNotDue),
    completionRate: ratio(completed, due),
    onTimeRate: ratio(onTime, onTime + late + openOverdue),
    avgCompletionH: durations.length ? durations.reduce((s, c) => s + c.avgCompletionH, 0) / durations.length : null
  };

  const editingRatio = ed.due > 0 ? 0.5 * (ed.completionRate || 0) + 0.5 * (ed.onTimeRate !== null ? ed.onTimeRate : (ed.completionRate || 0)) : null;
  const pubTimed = pu.onTime + pu.late;
  const raw = [
    {
      key: 'onTime', label: COMPONENT_LABELS.onTime, ratio: totals.onTimeRate, weight: settings.weights.onTime,
      formula: `${onTime} on time ÷ (${onTime} on time + ${late} late + ${openOverdue} overdue & unfinished) = ${pct(totals.onTimeRate)}`,
      excludedReason: totals.onTimeRate === null ? 'No completed or overdue tasks with a deadline in this period.' : null
    },
    {
      key: 'shootDelivery', label: COMPONENT_LABELS.shootDelivery, ratio: ratio(sh.rawDelivered, sh.due), weight: settings.weights.shootDelivery,
      formula: `${sh.rawDelivered} shoots completed with raw footage ÷ ${sh.due} due shoot tasks = ${pct(ratio(sh.rawDelivered, sh.due))}`,
      excludedReason: sh.due === 0 ? 'No shoot tasks owned and due in this period.' : null
    },
    {
      key: 'editing', label: COMPONENT_LABELS.editing, ratio: isEditorEligible ? editingRatio : null, weight: settings.weights.editing,
      formula: `50% × completion ${pct(ed.completionRate)} (${ed.completed}/${ed.due}) + 50% × on-time ${pct(ed.onTimeRate)} = ${pct(editingRatio)}`,
      excludedReason: !isEditorEligible ? `${name} is not on the editing team, so editing is not part of this score.` : ed.due === 0 ? 'No editing tasks owned and due in this period.' : null
    },
    {
      key: 'publishing', label: COMPONENT_LABELS.publishing, ratio: ratio(pu.onTime, pubTimed), weight: settings.weights.publishing,
      formula: `${pu.onTime} posts published on schedule ÷ ${pubTimed} confirmed posts with a planned time = ${pct(ratio(pu.onTime, pubTimed))}`,
      excludedReason: pubTimed === 0 ? 'No confirmed publishes with a planned time in this period.' : null
    }
  ];
  const activeWeight = raw.reduce((s, c) => (c.ratio === null || c.weight <= 0 ? s : s + c.weight), 0);
  const components = raw.map((c) => {
    const effectiveWeight = c.ratio === null || activeWeight === 0 ? 0 : (c.weight / activeWeight) * 100;
    return { ...c, effectiveWeight, points: c.ratio === null ? 0 : c.ratio * effectiveWeight };
  });
  const rawScore = activeWeight ? Math.round(components.reduce((s, c) => s + c.points, 0)) : null;

  const exclusions = [];
  const excusedCount = sum((c) => c.excused);
  const noDeadline = sum((c) => c.noDeadline);
  const blocked = sum((c) => c.blocked);
  if (excusedCount) exclusions.push(`${excusedCount} completed task(s) had a documented blocker — counted as completed, excluded from timeliness.`);
  if (noDeadline) exclusions.push(`${noDeadline} completed task(s) had no deadline — counted as completed, excluded from timeliness.`);
  if (totals.openNotDue) exclusions.push(`${totals.openNotDue} claimed task(s) are not due yet — shown as workload, not scored.`);
  if (blocked) exclusions.push(`${blocked} claimed task(s) are currently blocked — not scored until unblocked.`);
  exclusions.push('Unclaimed tasks are never attributed to any employee.');

  const status = rankStatus(due, settings);
  return { userId: id, name, categories: cats, totals, components, rawScore, score: status === 'Insufficient Data' ? null : rawScore, status, exclusions, tied: false, rank: null };
}

// Competition ranking (1, 1, 3): equal scores share a rank. Insufficient-data employees are unranked.
function assignRanks(list) {
  const scored = list.filter((s) => s.score !== null).sort((a, b) => b.score - a.score);
  scored.forEach((s) => {
    s.rank = scored.findIndex((x) => x.score === s.score) + 1;
    s.tied = scored.filter((x) => x.score === s.score).length > 1;
  });
  return list;
}

const byScoreThenName = (a, b) => ((b.score === null ? -1 : b.score) - (a.score === null ? -1 : a.score)) || a.name.localeCompare(b.name);

// The four ranked roster slots, in roster order, with the linked user (if any).
function rankedSlots(studio, users) {
  return C.ROSTER.filter((r) => r.ranked).map((r) => {
    const userId = P.userIdForKey(studio, r.key);
    const u = userId ? users.find((x) => x.id === userId) : null;
    return { key: r.key, rosterName: r.name, userId, name: u ? u.name : r.name, linked: !!userId, canEdit: r.canEdit };
  });
}

// General leaderboard — only Bansi, Bhavin, Vishnu and Krutik (when linked).
function computeGeneralScores(studio, users, items, now, from, to) {
  const settings = studio.settings;
  const slots = rankedSlots(studio, users).filter((s) => s.linked);
  const lookup = collectStats(items, now, settings, from, to, slots.map((s) => s.userId));
  const list = slots.map((s) => ({ ...scoreEmployee(s.userId, s.name, s.canEdit, lookup(s.userId), settings), key: s.key }));
  return assignRanks(list).sort(byScoreThenName);
}

// Editing leaderboard — the four-person editing team only, editing tasks only.
function computeEditingScores(studio, users, items, now, from, to) {
  const settings = studio.settings;
  const slots = rankedSlots(studio, users).filter((s) => s.linked && s.canEdit);
  const lookup = collectStats(items, now, settings, from, to, slots.map((s) => s.userId));
  const list = slots.map((s) => {
    const st = lookup(s.userId).Editing;
    const r = st.due > 0 ? 0.5 * (st.completionRate || 0) + 0.5 * (st.onTimeRate !== null ? st.onTimeRate : (st.completionRate || 0)) : null;
    const rawScore = r === null ? null : Math.round(r * 100);
    const status = rankStatus(st.due, settings);
    return { userId: s.userId, key: s.key, name: s.name, stats: st, rawScore, score: status === 'Insufficient Data' ? null : rawScore, status, tied: false, rank: null, formula: `50% × completion ${pct(st.completionRate)} + 50% × on-time ${pct(st.onTimeRate)}` };
  });
  return assignRanks(list).sort(byScoreThenName);
}

module.exports = { COMPONENT_LABELS, SCORING_PRINCIPLES, fmtRatio: pct, collectStats, computeGeneralScores, computeEditingScores, rankedSlots, assignRanks };
