// Social Media Studio authorization. Identity always comes from the authenticated PMS
// session (req.session.userId → db.users); nothing the client sends is trusted for identity.
//
// Who can do what:
//   PMS admin            → Studio manager: create/edit/delete reels, (re)assign with a reason,
//                          blockers, reopen, delay/reschedule, schedule, settings & member links.
//                          Claims/completes work only if the admin is also linked to a roster slot.
//   Linked Bansi/Bhavin/Vishnu/Krutik → claim, release, complete, schedule, publish on their pages;
//                          editing only where they're eligible editors for the page.
//   Linked Dhara/Ashmita → view only (preparation info). Every Studio POST is refused.
//   PMS viewer           → view only.
//   Anyone else          → no Studio access.
const C = require('./config');
const W = require('./workflow');

// Builds the Studio actor for a request. `user` is the active PMS user record.
function resolveActor(studio, user) {
  if (!user || !user.active) return null;
  const link = studio.members.find((m) => m.userId === user.id) || null;
  const roster = link ? C.getRosterEntry(link.key) : null;
  const isManager = user.role === 'admin';
  const canView = isManager || !!roster || user.role === 'viewer';
  return {
    userId: user.id,
    name: user.name,
    pmsRole: user.role,
    memberKey: roster ? roster.key : null,
    roster,
    isManager,
    canView,
    canWork: !!roster && roster.canWork,
    canEditVideo: !!roster && roster.canEdit,
    // True for anyone who may open the Studio but can't change anything in it.
    readOnly: canView && !isManager && !(roster && roster.canWork)
  };
}

const teamFor = (settings, pageId) => settings.pageTeams[pageId] || C.DEFAULT_PAGE_TEAMS[pageId] || [];

// Editors who may claim edits on a page: the editing team intersected with the page team.
// If the page team has no editor, all four eligible editors are offered (Studio rule).
function editorsForPage(settings, pageId) {
  const team = teamFor(settings, pageId);
  const onTeam = C.EDITOR_KEYS.filter((k) => team.includes(k));
  return onTeam.length ? onTeam : [...C.EDITOR_KEYS];
}

const workingTeam = (settings, pageId) => teamFor(settings, pageId).filter((k) => { const r = C.getRosterEntry(k); return r && r.canWork; });

function canShoot(actor, settings, pageId) {
  return !!actor && actor.canWork && teamFor(settings, pageId).includes(actor.memberKey);
}
function canEditReel(actor, settings, pageId) {
  return !!actor && actor.canEditVideo && editorsForPage(settings, pageId).includes(actor.memberKey);
}
const canPublish = canShoot;

// Roster key → linked PMS user id helpers.
const userIdForKey = (studio, key) => { const m = studio.members.find((x) => x.key === key); return m ? m.userId : null; };
const keyForUserId = (studio, userId) => { const m = studio.members.find((x) => x.userId === userId); return m ? m.key : null; };

// Can the user currently linked to `key` take shoot / edit work on this page? Used for manager assignment.
function memberCanShoot(settings, key, pageId) {
  const r = C.getRosterEntry(key);
  return !!r && r.canWork && teamFor(settings, pageId).includes(key);
}
function memberCanEdit(settings, key, pageId) {
  const r = C.getRosterEntry(key);
  return !!r && r.canEdit && editorsForPage(settings, pageId).includes(key);
}

// Ranked (scored) PMS user ids — only the four ranked roster slots that are linked.
function rankedUserIds(studio) {
  return studio.members.filter((m) => m.userId && C.RANKED_KEYS.includes(m.key)).map((m) => m.userId);
}

// Pages an actor works on (manager / viewer: all four).
function pagesFor(actor, settings) {
  if (!actor.memberKey) return C.PAGE_IDS.slice();
  return C.PAGE_IDS.filter((p) => teamFor(settings, p).includes(actor.memberKey));
}

// May the actor record/resolve a blocker on this stage? (task owner or manager)
function canBlock(actor, item, stage) {
  if (!actor) return false;
  if (actor.isManager) return true;
  const owner = stage === 'Shoot' ? item.shootOwner : item.editor;
  return actor.canWork && !!owner && owner === actor.userId;
}

function canEditNotes(actor, item, stage) {
  if (!actor) return false;
  if (actor.isManager) return true;
  const owner = stage === 'Shoot' ? item.shootOwner : stage === 'Editing' ? item.editor : item.publishingOwner;
  return actor.canWork && !!owner && owner === actor.userId;
}

function canToggleScript(actor, settings, item) {
  return !!actor && (actor.isManager || canShoot(actor, settings, item.pageId)) && !W.isShootDone(item);
}

module.exports = {
  resolveActor, teamFor, editorsForPage, workingTeam, canShoot, canEditReel, canPublish,
  userIdForKey, keyForUserId, memberCanShoot, memberCanEdit, rankedUserIds, pagesFor,
  canBlock, canEditNotes, canToggleScript
};
