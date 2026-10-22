// Social Media Studio workflow rules — stages, deadlines, overdue checks and derived tasks.
// Ported from the standalone Studio's lib/workflow.ts. All dates are ISO strings; "day"
// boundaries use the server's local time zone (same as the rest of the PMS).
//
// Content Planning → Shoot Scheduled → Shoot Completed → Editing → Ready to Publish → Scheduled → Published
// (no review or approval step)

const STAGES = ['Content Planning', 'Shoot Scheduled', 'Shoot Completed', 'Editing', 'Ready to Publish', 'Scheduled', 'Published'];
const PUBLISH_STATUSES = ['Ready to Publish', 'Scheduled', 'Published', 'Delayed', 'Missed Deadline'];
const TASK_TYPES = ['Shoot', 'Editing', 'Publishing'];

const PUBLISH_GRACE_HOURS = 1;
// Editing must be completed this many hours before the reel's scheduled publishing time.
const EDIT_HOURS_BEFORE_PUBLISH = 24;
const LATE_CLAIM_GRACE_HOURS = 24;
const PUBLISH_MIN_HOURS_AFTER_EDIT = 12;

const DEADLINE_RULES = [
  'Shoot: due by the end of the planned shoot day.',
  `Editing: due exactly ${EDIT_HOURS_BEFORE_PUBLISH} hours before the reel's scheduled publishing date and time (completed at or before that moment = on time). A reel without a publishing time has no editing deadline and is left out of editing timeliness until one is set. The deadline is never extended automatically.`,
  `Publishing: due ${PUBLISH_GRACE_HOURS}h after the planned publishing time, but never earlier than ${PUBLISH_MIN_HOURS_AFTER_EDIT}h after editing is completed (a publisher is not marked late because editing finished late). Reels without a planned time are excluded from timeliness.`,
  `Late shoot claims: if a shoot is claimed only after its deadline had already passed while nobody owned it, the person who takes it gets ${LATE_CLAIM_GRACE_HOURS}h from the claim time — nobody is penalised for time the task sat unclaimed.`,
  'On-time status is fixed when the task is completed, using the deadline in effect at that moment and the server time of completion. Later schedule changes never rewrite it; every change is kept in the activity history.',
  'If a documented blocker was recorded on a task, its timeliness is excluded from scoring (the completion still counts).'
];

// ---------------------------------------------------------------- date helpers
const HOUR = 3600000;
const toDate = (v) => (v instanceof Date ? v : new Date(v));
const addHours = (d, h) => new Date(toDate(d).getTime() + h * HOUR);
const addDaysD = (d, n) => { const x = new Date(toDate(d)); x.setDate(x.getDate() + n); return x; };
const endOfDay = (d) => { const x = new Date(toDate(d)); x.setHours(23, 59, 59, 999); return x; };
const startOfDay = (d) => { const x = new Date(toDate(d)); x.setHours(0, 0, 0, 0); return x; };
function localDay(v) {
  const d = toDate(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const validIso = (v) => typeof v === 'string' && v.length > 0 && !Number.isNaN(Date.parse(v));

// ---------------------------------------------------------------- stage helpers
const isShootDone = (i) => i.shoot.status === 'Completed';
const footageReady = (i) => isShootDone(i) && !!i.shoot.rawSubmitted;
const isEditingDone = (i) => i.editing.status === 'Editing Completed';
const isPublished = (i) => i.publishing.status === 'Published';
const activeBlocker = (b) => !!b && !b.resolvedAt;

function getStage(item) {
  const p = item.publishing.status;
  if (p === 'Published') return 'Published';
  if (p === 'Scheduled') return 'Scheduled';
  if (isEditingDone(item)) return 'Ready to Publish';
  if (item.editing.status === 'Editing') return 'Editing';
  if (isShootDone(item)) return 'Shoot Completed';
  if (item.shoot.status === 'In Progress') return 'Shoot Scheduled';
  return 'Content Planning';
}

function getPublishStatus(item, now) {
  const s = item.publishing.status;
  if (s === 'Published' || s === 'Delayed') return s;
  if (!isEditingDone(item)) return 'Not Ready';
  if (item.publishAt && now > addHours(item.publishAt, PUBLISH_GRACE_HOURS)) return 'Missed Deadline';
  return s === 'Scheduled' ? 'Scheduled' : 'Ready to Publish';
}

// ---------------------------------------------------------------- deadlines
const shootDeadline = (item) => endOfDay(item.shootAt);

function withLateClaimGrace(deadline, claimedAt) {
  if (!claimedAt) return deadline;
  const claimed = new Date(claimedAt);
  return claimed > deadline ? addHours(claimed, LATE_CLAIM_GRACE_HOURS) : deadline;
}

const effectiveShootDeadline = (item) => withLateClaimGrace(shootDeadline(item), item.shoot.claimedAt);

// Editing deadline for a publishing time: exactly EDIT_HOURS_BEFORE_PUBLISH earlier, or null.
function deadlineForPublish(publishAt) {
  return validIso(publishAt) ? new Date(Date.parse(publishAt) - EDIT_HOURS_BEFORE_PUBLISH * HOUR).toISOString() : null;
}

// The reel's editing deadline: the value saved on the reel (kept in step with publishAt by the
// actions), falling back to computing it from publishAt. No publishing time → undefined; no
// deadline is invented. The second argument is accepted for older callers and not used.
function editingDeadline(item) {
  const saved = item.editingDeadline;
  const iso = saved !== undefined && saved !== null ? saved : deadlineForPublish(item.publishAt);
  return validIso(iso) ? new Date(iso) : undefined;
}

function publishDeadline(item) {
  if (!item.publishAt) return undefined;
  const planned = addHours(item.publishAt, PUBLISH_GRACE_HOURS);
  const edited = item.editing.completion && item.editing.completion.at;
  return edited ? new Date(Math.max(planned.getTime(), addHours(edited, PUBLISH_MIN_HOURS_AFTER_EDIT).getTime())) : planned;
}

// Completion snapshot. On-time status is fixed here and never recomputed later.
function makeCompletion(byUserId, byName, at, deadline, hadBlocker) {
  const c = { by: byUserId, byName, at, deadline: deadline ? deadline.toISOString() : null };
  if (deadline) c.onTime = new Date(at) <= deadline;
  if (hadBlocker) c.excused = true;
  return c;
}

// ---------------------------------------------------------------- overdue
function isShootOverdue(item, now) {
  return !isShootDone(item) && !activeBlocker(item.shoot.blocker) && now > effectiveShootDeadline(item);
}

// Derived warning only ("Editing Overdue"): the deadline has passed and editing is not
// complete. It never changes the reel's workflow status.
function isEditOverdue(item, now) {
  if (isEditingDone(item) || activeBlocker(item.editing.blocker)) return false;
  const d = editingDeadline(item);
  return !!d && now > d;
}

function isPublishOverdue(item, now) {
  const s = getPublishStatus(item, now);
  return s === 'Missed Deadline' || s === 'Delayed';
}

const isItemOverdue = (item, now, settings) => isShootOverdue(item, now) || isEditOverdue(item, now, settings) || isPublishOverdue(item, now);

// ---------------------------------------------------------------- tasks
// Each reel expands into three tasks. `assignee` is the CURRENT owner (a PMS user id) and is
// null for unclaimed work, which is never attributed to (or counted against) anyone.
function deriveTasks(items, now, settings) {
  const tasks = [];
  for (const item of items) {
    const base = { contentId: item.id, title: item.title, pageId: item.pageId, priority: item.priority };

    const sOver = isShootOverdue(item, now);
    const sBlocked = activeBlocker(item.shoot.blocker);
    tasks.push({
      ...base,
      id: `${item.id}:Shoot`,
      type: 'Shoot',
      assignee: item.shootOwner || null,
      claimable: item.shoot.status === 'Unclaimed' && !sBlocked,
      deadline: effectiveShootDeadline(item).toISOString(),
      status: sBlocked ? 'Blocked' : sOver ? 'Overdue' : item.shoot.status === 'Unclaimed' ? 'Available' : item.shoot.status,
      done: isShootDone(item),
      completedAt: item.shoot.completion ? item.shoot.completion.at : null,
      overdue: sOver,
      blocked: sBlocked,
      onTime: item.shoot.completion ? item.shoot.completion.onTime : undefined,
      excused: item.shoot.completion ? !!item.shoot.completion.excused : false,
      claimedAt: item.shoot.claimedAt || null
    });

    // The editing deadline warning is a separate flag (`overdue`); the status stays the real
    // workflow status (e.g. "Editing"), it is never replaced by "Overdue".
    const eOver = isEditOverdue(item, now);
    const eBlocked = activeBlocker(item.editing.blocker);
    const eDl = editingDeadline(item);
    const eDeadline = eDl ? eDl.toISOString() : null;
    const eStatus = eBlocked ? 'Blocked' : !footageReady(item) ? 'Waiting for footage'
      : item.editing.status === 'Not Started' ? 'Available' : item.editing.status;
    tasks.push({
      ...base,
      id: `${item.id}:Editing`,
      type: 'Editing',
      assignee: item.editor || null,
      claimable: footageReady(item) && item.editing.status === 'Not Started' && !item.editor && !eBlocked,
      deadline: eDeadline,
      status: eStatus,
      done: isEditingDone(item),
      completedAt: item.editing.completion ? item.editing.completion.at : null,
      overdue: eOver,
      blocked: eBlocked,
      onTime: item.editing.completion ? item.editing.completion.onTime : undefined,
      excused: item.editing.completion ? !!item.editing.completion.excused : false,
      claimedAt: item.editing.claimedAt || null
    });

    // Publishing is never claimed in advance; the confirming employee becomes the owner.
    const pStatus = getPublishStatus(item, now);
    tasks.push({
      ...base,
      id: `${item.id}:Publishing`,
      type: 'Publishing',
      assignee: item.publishingOwner || null,
      claimable: isEditingDone(item) && pStatus !== 'Published',
      deadline: item.publishAt || null,
      status: pStatus,
      done: pStatus === 'Published',
      completedAt: item.publishing.completion ? item.publishing.completion.at : null,
      overdue: isPublishOverdue(item, now),
      blocked: false,
      onTime: item.publishing.completion ? item.publishing.completion.onTime : undefined,
      excused: item.publishing.completion ? !!item.publishing.completion.excused : false,
      claimedAt: null
    });
  }
  return tasks;
}

function hoursBetween(a, b) {
  if (!a || !b) return null;
  return (new Date(b).getTime() - new Date(a).getTime()) / HOUR;
}

const editingTurnaroundHours = (item) => hoursBetween(item.editing.claimedAt, item.editing.completion && item.editing.completion.at);

// The date a reel is planned for: planned publishing time, or the shoot date if not set yet.
const plannedDate = (i) => i.publishAt || i.shootAt;
const inRange = (iso, from, to) => { if (!iso) return false; const d = iso.length <= 10 ? iso : localDay(iso); return d >= from && d <= to; };

module.exports = {
  STAGES, PUBLISH_STATUSES, TASK_TYPES, DEADLINE_RULES,
  PUBLISH_GRACE_HOURS, EDIT_HOURS_BEFORE_PUBLISH, LATE_CLAIM_GRACE_HOURS, PUBLISH_MIN_HOURS_AFTER_EDIT,
  addHours, addDaysD, endOfDay, startOfDay, localDay, validIso,
  isShootDone, footageReady, isEditingDone, isPublished, activeBlocker, getStage, getPublishStatus,
  shootDeadline, effectiveShootDeadline, deadlineForPublish, editingDeadline, publishDeadline, makeCompletion,
  isShootOverdue, isEditOverdue, isPublishOverdue, isItemOverdue, deriveTasks,
  hoursBetween, editingTurnaroundHours, plannedDate, inRange
};
