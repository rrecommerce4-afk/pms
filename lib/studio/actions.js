// Social Media Studio state transitions. Every change to a reel goes through one of these
// functions, so the workflow rules live in one place (ported from the Studio's
// StudioContext actions). Each returns { ok: true, message } or { ok: false, status, error }.
// status 403 = not permitted for this user, 409 = invalid for the reel's current state,
// 400 = invalid input. Callers save the db only when ok is true.
//
// Concurrency: routes load → validate → mutate → save synchronously inside one Node request
// handler, so two requests in the same process can't interleave (e.g. double claims are
// refused because the second request sees the first owner). The JSON file is not a
// transactional database; running several server processes against one file is not safe.
const C = require('./config');
const W = require('./workflow');
const P = require('./permissions');

const LIMITS = { title: 150, idea: 3000, caption: 2200, prepNotes: 2000, notes: 2000, reason: 500, url: 500 };

const ok = (message) => ({ ok: true, message });
const deny = (error) => ({ ok: false, status: 403, error: error || "This action isn't available for your account." });
const conflict = (error) => ({ ok: false, status: 409, error });
const invalid = (error) => ({ ok: false, status: 400, error });

const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim().slice(0, max);
const STAGE_LABEL = { shootAt: 'Shoot date', editDeadline: 'Editing deadline', editingDeadline: 'Editing deadline', publishAt: 'Planned publishing' };

// datetime-local value ("2026-10-21T11:00", server local time) or ISO → ISO string, or null.
function parseWhen(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return undefined;
  const d = new Date(s.length === 10 ? `${s}T00:00` : s.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function fmt(iso) {
  if (!iso) return 'not set';
  const d = new Date(iso);
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
}

function nameOf(ctx, userId) {
  if (!userId) return 'nobody';
  const u = ctx.users.find((x) => x.id === userId);
  return u ? u.name : `User #${userId}`;
}

function log(item, actor, text, kind, stage) {
  item.activity = item.activity || [];
  item.activity.push({
    id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    by: actor ? actor.userId : null,
    byName: actor ? actor.name : 'System',
    text, kind, stage: stage || null
  });
}

function recordOwner(item, stage, from, to, actor, reason) {
  item.ownershipHistory = item.ownershipHistory || [];
  item.ownershipHistory.push({ stage, from: from || null, to: to || null, at: new Date().toISOString(), by: actor.userId, byName: actor.name, reason: reason || null });
}

// Records a deadline change (the previous value is never lost).
function recordDeadline(ctx, item, field, to, reason) {
  const from = item[field] || null;
  if ((from || '') === (to || '')) return false;
  item.deadlineChanges = item.deadlineChanges || [];
  item.deadlineChanges.push({ field, from, to: to || null, at: new Date().toISOString(), by: ctx.actor.userId, byName: ctx.actor.name, reason: reason || null });
  log(item, ctx.actor, `${STAGE_LABEL[field]} changed from ${fmt(from)} to ${fmt(to)}${reason ? ` — ${reason}` : ''}`, 'deadline');
  return true;
}

// Sets a reel's scheduled publishing time and recalculates its saved editing deadline
// (publishAt − 24h; none without a publishing time). Every change keeps the previous and new
// publishing time and deadline, the user, the time and the reason. An existing editing
// completion is never altered: its original on-time/late result stays, and the history notes
// whether it also meets the new deadline. Returns true when something changed.
function setPublishAt(ctx, item, to, reason) {
  const from = item.publishAt || null;
  const next = to || null;
  if ((from || '') === (next || '')) return false;
  const oldDeadline = item.editingDeadline !== undefined && item.editingDeadline !== null ? item.editingDeadline : W.deadlineForPublish(from);
  const newDeadline = W.deadlineForPublish(next);
  const at = new Date().toISOString();
  item.deadlineChanges = item.deadlineChanges || [];
  item.deadlineChanges.push({ field: 'publishAt', from, to: next, at, by: ctx.actor.userId, byName: ctx.actor.name, reason: reason || null });
  item.deadlineChanges.push({ field: 'editingDeadline', from: oldDeadline || null, to: newDeadline, at, by: ctx.actor.userId, byName: ctx.actor.name, reason: reason || null });
  item.publishAt = next;
  item.editingDeadline = newDeadline;
  const c = item.editing.completion;
  const note = c && newDeadline
    ? ` Editing was already completed (${fmt(c.at)}), which is ${new Date(c.at) <= new Date(newDeadline) ? 'within' : 'after'} the new deadline; the original result (${c.onTime === false ? 'late' : c.onTime ? 'on time' : 'no deadline'}) is kept.`
    : '';
  log(item, ctx.actor, `Planned publishing changed from ${fmt(from)} to ${fmt(next)}; editing deadline ${fmt(oldDeadline)} → ${fmt(newDeadline)}${reason ? ` — ${reason}` : ''}.${note}`, 'deadline', 'Publishing');
  return true;
}

// Warning to show after saving when the editing deadline is already due (publishing < 24h away).
function deadlineWarning(item) {
  const d = W.editingDeadline(item);
  if (!d || W.isEditingDone(item) || d > new Date()) return '';
  return ` Warning: the editing deadline (${fmt(d.toISOString())}) has already passed because publishing is less than ${W.EDIT_HOURS_BEFORE_PUBLISH} hours away — editing is now overdue. The deadline is not moved automatically.`;
}

// ---------------------------------------------------------------- reel shape
function newReel(id, fields, actor) {
  return {
    id,
    title: fields.title,
    pageId: fields.pageId,
    idea: fields.idea,
    caption: fields.caption,
    prepNotes: fields.prepNotes,
    priority: fields.priority,
    shootAt: fields.shootAt,
    publishAt: fields.publishAt,
    // Saved, not just derived: always publishAt − 24h (null without a publishing time).
    editingDeadline: W.deadlineForPublish(fields.publishAt),
    shootOwner: null,
    editor: null,
    publishingOwner: null,
    shoot: { status: 'Unclaimed', claimedAt: null, scriptReady: false, rawSubmitted: false, rawSubmittedAt: null, completion: null, blocker: null, pastBlockers: [], notes: '' },
    editing: { status: 'Not Started', claimedAt: null, completion: null, previousCompletions: [], blocker: null, pastBlockers: [], notes: '' },
    publishing: { status: 'Not Ready', scheduledAt: null, scheduledBy: null, scheduledByName: null, completion: null, confirmedAt: null, postUrl: null, delayReason: null, notes: '' },
    ownershipHistory: [],
    deadlineChanges: [],
    activity: [],
    createdAt: new Date().toISOString(),
    createdBy: actor.userId,
    rev: 1,
    deletedAt: null
  };
}

// Validates the create/edit reel form. Returns { fields } or { error }.
function parseReelForm(input, existing) {
  const title = str(input.title, LIMITS.title);
  if (!title) return { error: 'Reel title is required.' };
  const pageId = str(input.pageId, 40);
  if (!C.PAGE_IDS.includes(pageId)) return { error: 'Choose one of the four Instagram pages.' };
  const priority = C.PRIORITIES.includes(input.priority) ? input.priority : 'Medium';
  const shootAt = parseWhen(input.shootAt);
  if (!shootAt) return { error: 'A valid planned shoot date is required.' };
  // The editing deadline is never entered by hand: it is always publishAt − 24h.
  const publishAt = parseWhen(input.publishAt);
  if (publishAt === undefined) return { error: 'The planned publishing date and time is not valid.' };
  if (publishAt && new Date(publishAt) < new Date(shootAt)) return { error: 'Publishing must be after the shoot.' };
  return {
    fields: {
      title, pageId, priority, shootAt, publishAt: publishAt || null,
      idea: str(input.idea, LIMITS.idea), caption: str(input.caption, LIMITS.caption), prepNotes: str(input.prepNotes, LIMITS.prepNotes)
    }
  };
}

// ---------------------------------------------------------------- management (manager only)
function createReel(ctx, input) {
  if (!ctx.actor.canCreate) return deny('Only an admin, or a team member an admin has allowed, can create reels.');
  const parsed = parseReelForm(input);
  if (parsed.error) return invalid(parsed.error);
  if (!P.canCreateFor(ctx.actor, ctx.studio.settings, parsed.fields.pageId)) return deny(`You can create reels only for your own pages (${P.creatablePages(ctx.actor, ctx.studio.settings).map((p) => C.getPage(p).shortName).join(', ') || 'none'}).`);
  const reel = newReel(ctx.studio.nextReelId++, parsed.fields, ctx.actor);
  log(reel, ctx.actor, `Reel created — shoot, editing and publishing are open to claim. ${reel.publishAt ? `Planned publishing ${fmt(reel.publishAt)}; editing deadline ${fmt(reel.editingDeadline)}.` : 'No publishing time yet, so no editing deadline.'}`, 'create');
  ctx.studio.reels.push(reel);
  return { ok: true, message: `Reel created — it is now in the shared task list for the page.${reel.publishAt ? '' : ' Set a publishing date and time to give editing its deadline.'}${deadlineWarning(reel)}`, reel };
}

function updateReel(ctx, input) {
  const { item } = ctx;
  if (!ctx.actor.isManager) return deny('Only an admin (Studio manager) can edit reels.');
  if (input.rev !== undefined && Number(input.rev) !== item.rev) return conflict('This reel was changed by someone else after you opened it. Reload and try again.');
  const parsed = parseReelForm(input, item);
  if (parsed.error) return invalid(parsed.error);
  const f = parsed.fields;
  const claimed = !!(item.shootOwner || item.editor);
  if (f.pageId !== item.pageId && claimed) return conflict('The page cannot change after work has been claimed.');
  const reason = str(input.reason, LIMITS.reason);
  const shootChanged = (item.shootAt || '') !== (f.shootAt || '');
  const publishChanged = (item.publishAt || '') !== (f.publishAt || '');
  if ((shootChanged || publishChanged) && claimed && !reason) return invalid('Record why the date changed (kept in the activity history).');
  if (publishChanged && item.publishAt && !reason) return invalid('Record why the publishing time changed — the editing deadline moves with it (kept in the activity history).');
  if (publishChanged && W.isPublished(item)) return conflict('This reel is already published; its publishing time is the actual posting time.');
  if (recordDeadline(ctx, item, 'shootAt', f.shootAt, reason)) item.shootAt = f.shootAt;
  setPublishAt(ctx, item, f.publishAt, reason);
  // A post can't stay "Scheduled" without a publishing time.
  if (!item.publishAt && item.publishing.status === 'Scheduled') {
    item.publishing.status = W.isEditingDone(item) ? 'Ready to Publish' : 'Not Ready';
    item.publishing.scheduledAt = null;
    item.publishing.scheduledBy = null;
    item.publishing.scheduledByName = null;
    log(item, ctx.actor, 'Publishing time removed — the post is no longer scheduled', 'schedule', 'Publishing');
  }
  const changed = ['title', 'pageId', 'idea', 'caption', 'prepNotes', 'priority'].filter((k) => item[k] !== f[k]);
  changed.forEach((k) => { item[k] = f[k]; });
  if (changed.length) log(item, ctx.actor, `Reel details updated (${changed.join(', ')})`, 'update');
  return ok(`Reel updated.${publishChanged && !f.publishAt ? ' The publishing time was removed, so editing has no deadline until a new time is set.' : ''}${deadlineWarning(item)}`);
}

// Soft delete: the record (and its history) is kept but hidden everywhere and excluded from scoring.
function deleteReel(ctx) {
  if (!ctx.actor.isManager) return deny('Only an admin (Studio manager) can delete reels.');
  ctx.item.deletedAt = new Date().toISOString();
  ctx.item.deletedBy = ctx.actor.userId;
  log(ctx.item, ctx.actor, 'Reel deleted (hidden; history kept)', 'delete');
  return ok('Reel deleted.');
}

// Undoes a (soft) delete: the reel and its history come back everywhere, including scoring.
function restoreReel(ctx) {
  if (!ctx.actor || !ctx.actor.isManager) return deny('Only an admin (Studio manager) can restore reels.');
  if (!ctx.item) return { ok: false, status: 404, error: 'Reel not found.' };
  if (!ctx.item.deletedAt) return conflict('This reel is not deleted.');
  ctx.item.deletedAt = null;
  ctx.item.deletedBy = null;
  ctx.item.rev = (ctx.item.rev || 0) + 1;
  log(ctx.item, ctx.actor, 'Reel restored', 'update');
  return ok('Reel restored.');
}

// Admin bulk delete / restore over many reel ids (Manage reels). Each reel goes through the same
// single-reel rules and history logging. Unknown ids are skipped. Returns counts.
function bulkReels(ctx, ids, mode) {
  if (!ctx.actor || !ctx.actor.isManager) return deny('Only an admin (Studio manager) can delete or restore reels in bulk.');
  const wanted = new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0));
  let done = 0, skipped = 0;
  ctx.studio.reels.filter((r) => wanted.has(Number(r.id))).forEach((item) => {
    const res = mode === 'restore' ? restoreReel({ ...ctx, item }) : runReelAction('delete', { ...ctx, item }, {});
    if (res.ok) done++; else skipped++;
  });
  skipped += wanted.size - ctx.studio.reels.filter((r) => wanted.has(Number(r.id))).length;
  return { ok: true, done, skipped };
}

function assignTask(ctx, input) {
  const { item, actor, studio } = ctx;
  if (!actor.isManager) return deny('Only an admin (Studio manager) can reassign tasks.');
  const stage = input.stage === 'Editing' ? 'Editing' : input.stage === 'Shoot' ? 'Shoot' : null;
  if (!stage) return invalid('Unknown task.');
  const reason = str(input.reason, LIMITS.reason);
  if (!reason) return invalid('Please record a reason for the reassignment.');
  const key = str(input.memberKey, 20);
  let toUser = null;
  if (key) {
    if (!C.ROSTER_KEYS.includes(key)) return invalid('Unknown Studio member.');
    toUser = P.userIdForKey(studio, key);
    if (!toUser) return conflict(`${C.getRosterEntry(key).name} is not linked to a PMS account yet (Settings → Studio members).`);
  }
  const now = new Date().toISOString();
  if (stage === 'Shoot') {
    if (W.isShootDone(item)) return conflict('Completed shoots cannot be reassigned.');
    if (key && !P.memberCanShoot(studio.settings, key, item.pageId)) return invalid(`${C.getRosterEntry(key).name} can't take shoot tasks on this page.`);
    const prev = item.shootOwner;
    if ((prev || null) === toUser) return conflict('That is already the current owner.');
    item.shootOwner = toUser;
    item.shoot.status = toUser ? 'In Progress' : 'Unclaimed';
    item.shoot.claimedAt = toUser ? now : null;
    recordOwner(item, 'Shoot', prev, toUser, actor, reason);
    log(item, actor, `${actor.name} ${toUser ? `assigned shooting to ${nameOf(ctx, toUser)}` : 'released shooting'}${prev ? ` (was ${nameOf(ctx, prev)})` : ''} — ${reason}`, 'assign', 'Shoot');
  } else {
    if (W.isEditingDone(item)) return conflict('Completed edits cannot be reassigned. Reopen first.');
    if (key && !P.memberCanEdit(studio.settings, key, item.pageId)) return invalid('Only Bansi, Bhavin, Vishnu or Krutik (eligible for this page) can take editing.');
    if (toUser && !W.footageReady(item)) return conflict('Raw footage has not been submitted yet.');
    const prev = item.editor;
    if ((prev || null) === toUser) return conflict('That is already the current editor.');
    item.editor = toUser;
    item.editing.status = toUser ? 'Editing' : 'Not Started';
    item.editing.claimedAt = toUser ? now : null;
    recordOwner(item, 'Editing', prev, toUser, actor, reason);
    log(item, actor, `${actor.name} ${toUser ? `assigned editing to ${nameOf(ctx, toUser)}` : 'released editing'}${prev ? ` (was ${nameOf(ctx, prev)})` : ''} — ${reason}`, 'assign', 'Editing');
  }
  return ok(toUser ? `${stage} assigned to ${nameOf(ctx, toUser)}.` : `${stage} released — open to claim.`);
}

function setBlocker(ctx, input) {
  const { item, actor } = ctx;
  const stage = input.stage === 'Editing' ? 'Editing' : input.stage === 'Shoot' ? 'Shoot' : null;
  if (!stage) return invalid('Unknown task.');
  if (!P.canBlock(actor, item, stage)) return deny('Only the task owner or an admin can record a blocker.');
  const target = stage === 'Shoot' ? item.shoot : item.editing;
  if (stage === 'Shoot' ? W.isShootDone(item) : W.isEditingDone(item)) return conflict(`The ${stage.toLowerCase()} is already completed.`);
  if (stage === 'Editing' && !W.footageReady(item)) return conflict('Editing has not opened yet.');
  if (W.activeBlocker(target.blocker)) return conflict('There is already an active blocker. Resolve it first.');
  const reason = str(input.reason, LIMITS.reason);
  if (!reason) return invalid('Describe the blocker.');
  if (target.blocker) { target.pastBlockers = target.pastBlockers || []; target.pastBlockers.push(target.blocker); }
  target.blocker = { reason, at: new Date().toISOString(), by: actor.userId, byName: actor.name, resolvedAt: null };
  log(item, actor, `${stage} blocker recorded: ${reason}`, 'blocker', stage);
  return ok('Blocker recorded — this task is excluded from timeliness scoring.');
}

function resolveBlocker(ctx, input) {
  const { item, actor } = ctx;
  const stage = input.stage === 'Editing' ? 'Editing' : input.stage === 'Shoot' ? 'Shoot' : null;
  if (!stage) return invalid('Unknown task.');
  if (!P.canBlock(actor, item, stage)) return deny('Only the task owner or an admin can resolve a blocker.');
  const target = stage === 'Shoot' ? item.shoot : item.editing;
  if (!W.activeBlocker(target.blocker)) return conflict('There is no active blocker.');
  target.blocker.resolvedAt = new Date().toISOString();
  target.blocker.resolvedBy = actor.userId;
  log(item, actor, `${stage} blocker resolved`, 'blocker', stage);
  return ok('Blocker resolved.');
}

function toggleScript(ctx) {
  const { item, actor, studio } = ctx;
  if (!P.canToggleScript(actor, studio.settings, item)) {
    return W.isShootDone(item) ? conflict('The shoot is already completed.') : deny('Only the page team or an admin can update script status.');
  }
  item.shoot.scriptReady = !item.shoot.scriptReady;
  log(item, actor, `${actor.name} marked the script ${item.shoot.scriptReady ? 'ready' : 'not ready'}`, 'update', 'Shoot');
  return ok(item.shoot.scriptReady ? 'Script marked ready.' : 'Script marked not ready.');
}

// ---------------------------------------------------------------- shooting
function claimShoot(ctx) {
  const { item, actor, studio } = ctx;
  if (!P.canShoot(actor, studio.settings, item.pageId)) return deny(`${actor.name} is not on the ${C.getPage(item.pageId).shortName} page team.`);
  if (W.isShootDone(item)) return conflict('This shoot is already completed.');
  if (item.shootOwner === actor.userId) return conflict('You already own this shoot.');
  if (item.shootOwner) return conflict(`Already claimed by ${nameOf(ctx, item.shootOwner)}.`);
  if (W.activeBlocker(item.shoot.blocker)) return conflict('This shoot is blocked.');
  item.shootOwner = actor.userId;
  item.shoot.status = 'In Progress';
  item.shoot.claimedAt = new Date().toISOString();
  recordOwner(item, 'Shoot', null, actor.userId, actor, 'claimed');
  log(item, actor, `${actor.name} claimed shooting`, 'claim', 'Shoot');
  return ok('Shoot claimed — it is now in your tasks.');
}

function releaseShoot(ctx) {
  const { item, actor } = ctx;
  if (!actor.canWork || item.shootOwner !== actor.userId) return deny('Only the current owner can release this shoot.');
  if (W.isShootDone(item)) return conflict('Completed shoots cannot be released.');
  item.shootOwner = null;
  item.shoot.status = 'Unclaimed';
  item.shoot.claimedAt = null;
  recordOwner(item, 'Shoot', actor.userId, null, actor, 'released');
  log(item, actor, `${actor.name} released shooting — open to claim`, 'release', 'Shoot');
  return ok('Shoot released — open to claim.');
}

function completeShoot(ctx, input) {
  const { item, actor } = ctx;
  if (!actor.canWork || item.shootOwner !== actor.userId) return deny('Only the shoot owner can mark it completed.');
  if (W.isShootDone(item)) return conflict('Already completed.');
  const at = new Date().toISOString();
  const raw = input.rawSubmitted === 'on' || input.rawSubmitted === '1' || input.rawSubmitted === true || input.rawSubmitted === 'true';
  const notes = str(input.notes, LIMITS.notes);
  item.shoot.status = 'Completed';
  item.shoot.rawSubmitted = raw;
  item.shoot.rawSubmittedAt = raw ? at : null;
  item.shoot.scriptReady = true;
  if (notes) item.shoot.notes = notes;
  item.shoot.completion = W.makeCompletion(actor.userId, actor.name, at, W.effectiveShootDeadline(item), !!item.shoot.blocker);
  const timing = item.shoot.completion.onTime ? 'on time' : 'late';
  log(item, actor, `${actor.name} marked shooting complete (${timing})${raw ? ' — raw footage ready' : ' — raw footage pending'}`, 'complete', 'Shoot');
  return ok(raw ? 'Shoot completed — editing is now open to claim.' : 'Shoot completed — mark the raw footage ready to open editing.');
}

function submitRaw(ctx) {
  const { item, actor } = ctx;
  if (!actor.canWork || item.shootOwner !== actor.userId) return deny('Only the shoot owner can mark the raw footage ready.');
  if (!W.isShootDone(item)) return conflict('Mark the shoot completed first.');
  if (item.shoot.rawSubmitted) return conflict('Raw footage is already marked ready.');
  item.shoot.rawSubmitted = true;
  item.shoot.rawSubmittedAt = new Date().toISOString();
  log(item, actor, `${actor.name} marked the raw footage ready — editing is open to claim`, 'complete', 'Shoot');
  return ok('Raw footage marked ready — editing is open to claim.');
}

// ---------------------------------------------------------------- editing
function claimEdit(ctx) {
  const { item, actor, studio } = ctx;
  if (!actor.canEditVideo) return deny('Only Bansi, Bhavin, Vishnu or Krutik can take editing tasks.');
  if (!P.canEditReel(actor, studio.settings, item.pageId)) return deny(`${actor.name} is not an eligible editor for this page.`);
  if (!W.footageReady(item)) return conflict('Editing opens once the shoot is completed and the raw footage is ready.');
  if (W.isEditingDone(item)) return conflict('Editing is already completed.');
  if (item.editor === actor.userId) return conflict('You already own this editing task.');
  if (item.editor) return conflict(`Already claimed by ${nameOf(ctx, item.editor)}.`);
  if (W.activeBlocker(item.editing.blocker)) return conflict('This editing task is blocked.');
  item.editor = actor.userId;
  item.editing.status = 'Editing';
  item.editing.claimedAt = new Date().toISOString();
  recordOwner(item, 'Editing', null, actor.userId, actor, 'claimed');
  log(item, actor, `${actor.name} claimed editing`, 'claim', 'Editing');
  return ok('Editing claimed — it is now in your active workload.');
}

function releaseEdit(ctx) {
  const { item, actor } = ctx;
  if (!actor.canEditVideo || item.editor !== actor.userId) return deny('Only the current editor can release this task.');
  if (W.isEditingDone(item)) return conflict('Completed edits cannot be released.');
  item.editor = null;
  item.editing.status = 'Not Started';
  item.editing.claimedAt = null;
  recordOwner(item, 'Editing', actor.userId, null, actor, 'released');
  log(item, actor, `${actor.name} released editing — open to claim`, 'release', 'Editing');
  return ok('Editing released — open to claim.');
}

function completeEdit(ctx, input) {
  const { item, actor } = ctx;
  if (!actor.canEditVideo || item.editor !== actor.userId) return deny('Only the assigned editor can mark editing completed.');
  if (W.isEditingDone(item)) return conflict('Already completed.');
  if (item.editing.status !== 'Editing') return conflict('Editing has not started.');
  const notes = str(input.notes, LIMITS.notes);
  // Completion time, editor and on-time result all come from the server; any time or result
  // fields in the request are ignored.
  const at = new Date().toISOString();
  item.editing.status = 'Editing Completed';
  if (notes) item.editing.notes = notes;
  const deadline = W.editingDeadline(item);
  item.editing.completion = W.makeCompletion(actor.userId, actor.name, at, deadline, !!item.editing.blocker);
  item.editing.completion.publishAt = item.publishAt || null; // the schedule this result was judged against
  if (item.publishing.status === 'Not Ready') item.publishing.status = 'Ready to Publish';
  const c = item.editing.completion;
  const result = c.onTime === undefined ? 'no deadline — no publishing time set' : c.onTime ? 'on time' : 'late';
  log(item, actor, `${actor.name} marked editing complete (${result}${deadline ? `; deadline ${fmt(deadline.toISOString())}` : ''}) — moved to Ready to Publish`, 'complete', 'Editing');
  return ok(`Editing completed (${result}) — moved to Ready to Publish.`);
}

function reopenEdit(ctx, input) {
  const { item, actor } = ctx;
  const isEditor = actor.canEditVideo && item.editor === actor.userId;
  if (!actor.isManager && !isEditor) return deny('Only the editor or an admin can reopen editing.');
  if (!W.isEditingDone(item) || !item.editing.completion) return conflict('Editing is not completed.');
  if (W.isPublished(item)) return conflict('This reel is already published.');
  const reason = str(input.reason, LIMITS.reason);
  if (!reason) return invalid('Please give a reason for reopening.');
  const prev = item.editing.completion;
  // Keep the earlier completion record; it is superseded, not deleted.
  item.editing.previousCompletions = item.editing.previousCompletions || [];
  item.editing.previousCompletions.push({ ...prev, supersededAt: new Date().toISOString(), supersededBy: actor.userId, reason });
  log(item, actor, `Editing reopened — ${reason}. Previous completion by ${prev.byName || nameOf(ctx, prev.by)} at ${fmt(prev.at)} (${prev.onTime === false ? 'late' : 'on time'}) superseded.`, 'reopen', 'Editing');
  item.editing.status = 'Editing';
  item.editing.completion = null;
  item.publishing.status = 'Not Ready';
  item.publishing.scheduledAt = null;
  item.publishing.scheduledBy = null;
  item.publishing.scheduledByName = null;
  item.publishing.delayReason = null;
  return ok('Editing reopened — removed from the publishing queue (previous completion kept in history).');
}

// ---------------------------------------------------------------- publishing
function schedulePost(ctx, input) {
  const { item, actor, studio } = ctx;
  if (!actor.isManager && !P.canPublish(actor, studio.settings, item.pageId)) return deny('Only the page team or an admin can schedule this post.');
  if (!W.isEditingDone(item)) return conflict('Editing must be completed before scheduling.');
  if (W.isPublished(item)) return conflict('Already published.');
  const when = parseWhen(input.publishAt);
  if (when === undefined) return invalid('The planned publishing time is not a valid date.');
  const reason = str(input.reason, LIMITS.reason);
  if (when && item.publishAt && when !== item.publishAt && !reason) return invalid('Give a reason for changing the publishing time — the editing deadline moves with it.');
  if (!when && !item.publishAt) return invalid('Set a planned publishing time to schedule the post.');
  if (when) setPublishAt(ctx, item, when, reason || null);
  item.publishing.status = 'Scheduled';
  item.publishing.scheduledAt = new Date().toISOString();
  item.publishing.scheduledBy = actor.userId;
  item.publishing.scheduledByName = actor.name;
  item.publishing.delayReason = null;
  log(item, actor, `${actor.name} scheduled the post for ${fmt(item.publishAt)} (not yet published)`, 'schedule', 'Publishing');
  return ok('Post scheduled (scheduling is not publishing — confirm the upload once it is live).');
}

const INSTAGRAM_URL = /^https:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.\-/?=&%#]+$/i;

function markPublished(ctx, input) {
  const { item, actor, studio } = ctx;
  if (!P.canPublish(actor, studio.settings, item.pageId)) return deny('Only a page team member who uploaded the post can confirm publication.');
  if (!W.isEditingDone(item)) return conflict('Editing must be completed before publishing.');
  if (W.isPublished(item)) return conflict(`Already marked as published by ${nameOf(ctx, item.publishingOwner)}.`);
  const url = str(input.postUrl, LIMITS.url);
  if (!INSTAGRAM_URL.test(url)) return invalid('Enter the actual Instagram post URL (https://www.instagram.com/…).');
  const when = parseWhen(input.publishedAt);
  if (!when) return invalid('Enter the actual publishing date and time.');
  const t = new Date(when).getTime();
  if (t > Date.now() + 5 * 60000) return invalid(`The actual publishing time you entered (${fmt(when)}) is later than the current time (${fmt(new Date().toISOString())}). Enter the time the post actually went live — mark it as published only after it is live on Instagram.`);
  const editedAt = item.editing.completion && item.editing.completion.at;
  if (editedAt && t < new Date(editedAt).getTime() - 5 * 60000) return invalid(`The publishing time cannot be before editing was completed (${fmt(editedAt)}).`);
  const notes = str(input.notes, LIMITS.notes);
  item.publishingOwner = actor.userId;
  item.publishing.status = 'Published';
  item.publishing.postUrl = url;
  item.publishing.confirmedAt = new Date().toISOString();
  if (notes) item.publishing.notes = notes;
  item.publishing.completion = W.makeCompletion(actor.userId, actor.name, when, W.publishDeadline(item), false);
  recordOwner(item, 'Publishing', null, actor.userId, actor, 'confirmed publication');
  log(item, actor, `${actor.name} confirmed the reel as published (posted ${fmt(when)}; URL entered manually, not verified with Instagram)`, 'publish', 'Publishing');
  return ok(`Marked as published — ${actor.name} recorded as the publishing owner.`);
}

function markDelayed(ctx, input) {
  const { item, actor } = ctx;
  if (!actor.isManager) return deny('Only an admin can mark publishing delayed.');
  if (W.isPublished(item)) return conflict('Already published.');
  if (!W.isEditingDone(item)) return conflict('Only reels in the publishing queue can be delayed.');
  const reason = str(input.reason, LIMITS.reason);
  if (!reason) return invalid('Please add a delay reason.');
  item.publishing.status = 'Delayed';
  item.publishing.delayReason = reason;
  log(item, actor, `Publishing delayed: ${reason}`, 'blocker', 'Publishing');
  return ok('Marked as delayed.');
}

function reschedule(ctx, input) {
  const { item, actor } = ctx;
  if (!actor.isManager) return deny('Only an admin can reschedule publishing.');
  if (W.isPublished(item)) return conflict('Already published.');
  const when = parseWhen(input.publishAt);
  if (!when) return invalid('Enter a valid new publishing time.');
  const reason = str(input.reason, LIMITS.reason);
  if (item.publishAt && when !== item.publishAt && !reason) return invalid('Give a reason for moving the publishing time — the editing deadline moves with it.');
  if (!setPublishAt(ctx, item, when, reason || null)) return conflict('That is already the planned publishing time.');
  if (item.publishing.status === 'Delayed') { item.publishing.status = W.isEditingDone(item) ? 'Ready to Publish' : 'Not Ready'; item.publishing.delayReason = null; }
  return ok(`Publishing rescheduled; editing deadline is now ${fmt(item.editingDeadline)}.${deadlineWarning(item)}`);
}

function updateNotes(ctx, input) {
  const { item, actor } = ctx;
  const stage = W.TASK_TYPES.includes(input.stage) ? input.stage : null;
  if (!stage) return invalid('Unknown task.');
  if (!P.canEditNotes(actor, item, stage)) return deny('Only the task owner or an admin can edit these notes.');
  const target = stage === 'Shoot' ? item.shoot : stage === 'Editing' ? item.editing : item.publishing;
  const notes = str(input.notes, LIMITS.notes);
  if (target.notes === notes) return ok('No changes.');
  target.notes = notes;
  log(item, actor, `${stage} notes updated`, 'note', stage);
  return ok('Notes saved.');
}

// Route name → action. Every POST /social-media/reels/:id/:action goes through this table.
const REEL_ACTIONS = {
  update: updateReel,
  delete: deleteReel,
  assign: assignTask,
  blocker: setBlocker,
  'resolve-blocker': resolveBlocker,
  'toggle-script': toggleScript,
  'claim-shoot': claimShoot,
  'release-shoot': releaseShoot,
  'complete-shoot': completeShoot,
  'raw-ready': submitRaw,
  'claim-edit': claimEdit,
  'release-edit': releaseEdit,
  'complete-edit': completeEdit,
  'reopen-edit': reopenEdit,
  schedule: schedulePost,
  publish: markPublished,
  delay: markDelayed,
  reschedule,
  notes: updateNotes
};

// Runs one reel action with the shared guards applied first.
function runReelAction(name, ctx, input) {
  const fn = REEL_ACTIONS[name];
  if (!fn) return { ok: false, status: 404, error: 'Unknown action.' };
  if (!ctx.actor || !ctx.actor.canView || ctx.actor.readOnly) return deny();
  if (!ctx.item || ctx.item.deletedAt) return { ok: false, status: 404, error: 'Reel not found.' };
  const editorBefore = ctx.item.editor;
  const res = fn(ctx, input || {});
  if (res.ok) {
    ctx.item.rev = (ctx.item.rev || 0) + 1;
    ctx.item.updatedAt = new Date().toISOString();
    // Invariant from the Studio: a newly set editor is always one of the four eligible editors.
    if (ctx.item.editor && ctx.item.editor !== editorBefore) {
      const key = P.keyForUserId(ctx.studio, ctx.item.editor);
      if (!key || !C.EDITOR_KEYS.includes(key)) return { ok: false, status: 500, error: 'Editing can only be owned by an eligible editor.' };
    }
  }
  return res;
}

module.exports = { LIMITS, parseWhen, parseReelForm, createReel, runReelAction, restoreReel, bulkReels, REEL_ACTIONS };
