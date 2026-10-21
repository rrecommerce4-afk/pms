// Real Instagram follower counts for the four Studio pages, via the official Instagram API
// with Instagram Login (graph.instagram.com, permission instagram_business_basic).
//
// - Access tokens are NOT stored in db.json. They live in a separate git-ignored file
//   (instagram-tokens.json, or PMS_IG_TOKENS_FILE) that only the server reads/writes, and
//   they are never sent to the browser or written into error messages.
// - Each page's token must belong to that page's handle (e.g. @rajarani_stencil); a token
//   for a different account is refused, so numbers can't end up on the wrong page.
// - One follower snapshot per page per day is saved in db.socialStudio.instagram.
// - Network calls run first; the db is loaded, updated and saved synchronously afterwards,
//   so a slow Instagram response can't overwrite Studio changes made in the meantime.
const fs = require('fs');
const path = require('path');
const C = require('./config');
const W = require('./workflow');

const API_BASE = 'https://graph.instagram.com';
const API_VERSION = process.env.PMS_IG_API_VERSION || 'v26.0';
const TOKENS_FILE = process.env.PMS_IG_TOKENS_FILE ? path.resolve(process.env.PMS_IG_TOKENS_FILE) : path.join(__dirname, '..', '..', 'instagram-tokens.json');
const SYNC_EVERY_HOURS = 20;
const REFRESH_WHEN_DAYS_LEFT = 10;
const MAX_SNAPSHOTS = 800;

let fetchImpl = (...args) => fetch(...args);
const setFetch = (fn) => { fetchImpl = fn; }; // tests only

// ---------------------------------------------------------------- token file
function readTokens() {
  try {
    const parsed = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}
function writeTokens(tokens) {
  const tmp = `${TOKENS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, TOKENS_FILE);
}

// ---------------------------------------------------------------- API calls
class IgError extends Error {}

async function igGet(urlPath, params) {
  const url = new URL(`${API_BASE}${urlPath}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  let res, body;
  try {
    res = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(15000) });
    body = await res.json().catch(() => ({}));
  } catch (e) {
    throw new IgError(`Could not reach Instagram (${e.name === 'TimeoutError' ? 'timed out' : 'network error'}).`);
  }
  if (!res.ok || body.error) {
    const err = body.error || {};
    const expired = err.code === 190;
    // Only Meta's message text is kept, never the request URL (it contains the token).
    throw new IgError(expired ? 'The access token is invalid or expired. Generate a new token in the Meta app and connect again.' : `Instagram API error${err.code ? ` ${err.code}` : ''}: ${String(err.message || res.status).slice(0, 200)}`);
  }
  return body;
}

const fetchProfile = (token) => igGet(`/${API_VERSION}/me`, { fields: 'user_id,username,followers_count', access_token: token });
const refreshToken = (token) => igGet('/refresh_access_token', { grant_type: 'ig_refresh_token', access_token: token });

// Best-effort: daily net follower change for the last 30 days (needs 100+ followers and the
// instagram_business_manage_insights permission). Returns [] when Instagram doesn't provide it.
async function fetchDailyGains(token, igUserId) {
  try {
    const until = Math.floor(Date.now() / 1000);
    const since = until - 29 * 86400;
    const body = await igGet(`/${API_VERSION}/${encodeURIComponent(igUserId)}/insights`, { metric: 'follower_count', period: 'day', since: String(since), until: String(until), access_token: token });
    const metric = (body.data || []).find((d) => d.name === 'follower_count');
    return metric && Array.isArray(metric.values) ? metric.values.filter((v) => typeof v.value === 'number' && v.end_time).map((v) => ({ date: W.localDay(v.end_time), gain: v.value })) : [];
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------- db helpers
const expectedUsername = (pageId) => C.getPage(pageId).handle.replace(/^@/, '').toLowerCase();

function igState(studio) {
  if (!studio.instagram || typeof studio.instagram !== 'object') studio.instagram = {};
  const s = studio.instagram;
  if (!s.snapshots || typeof s.snapshots !== 'object') s.snapshots = {};
  if (!s.status || typeof s.status !== 'object') s.status = {};
  C.PAGE_IDS.forEach((p) => {
    if (!Array.isArray(s.snapshots[p])) s.snapshots[p] = [];
    if (!s.status[p] || typeof s.status[p] !== 'object') s.status[p] = { connected: false };
  });
  return s;
}

// One snapshot per page per day; a later reading on the same day replaces the earlier one,
// except that an estimated (backfilled) value never replaces a real reading.
function putSnapshot(state, pageId, snap) {
  const list = state.snapshots[pageId];
  const i = list.findIndex((x) => x.date === snap.date);
  if (i >= 0) {
    if (snap.source === 'backfill' && list[i].source !== 'backfill') return;
    list[i] = snap;
  } else list.push(snap);
  list.sort((a, b) => a.date.localeCompare(b.date));
  if (list.length > MAX_SNAPSHOTS) list.splice(0, list.length - MAX_SNAPSHOTS);
}

const isLive = (studio, pageId) => !!(studio.instagram && studio.instagram.status && studio.instagram.status[pageId] && studio.instagram.status[pageId].connected
  && studio.instagram.snapshots && (studio.instagram.snapshots[pageId] || []).length);

// ---------------------------------------------------------------- operations
// Validates a token against the page's handle, stores it, and returns the readings to save.
async function connectPage(pageId, rawToken) {
  if (!C.PAGE_IDS.includes(pageId)) throw new IgError('Unknown page.');
  const token = String(rawToken || '').trim();
  if (!/^[A-Za-z0-9_\-.|]{20,1024}$/.test(token)) throw new IgError('That does not look like an Instagram access token. Copy the whole token from "Generate token" in the Meta app.');
  const profile = await fetchProfile(token);
  const got = String(profile.username || '').toLowerCase();
  if (got !== expectedUsername(pageId)) {
    throw new IgError(`This token belongs to @${profile.username || 'unknown'}, not ${C.getPage(pageId).handle}. Generate the token while logged in as ${C.getPage(pageId).handle}.`);
  }
  if (typeof profile.followers_count !== 'number') throw new IgError('Instagram did not return a follower count. Check that the account is a Business/Creator account and the instagram_business_basic permission is added.');
  const gains = await fetchDailyGains(token, profile.user_id || profile.id);
  const tokens = readTokens();
  const now = new Date().toISOString();
  // Tokens from "Generate token" in the dashboard are long-lived (60 days).
  tokens[pageId] = { token, savedAt: now, refreshedAt: now, expiresAt: new Date(Date.now() + 60 * 86400000).toISOString(), igUserId: String(profile.user_id || profile.id || '') };
  writeTokens(tokens);
  return { pageId, username: profile.username, igUserId: tokens[pageId].igUserId, followers: profile.followers_count, gains, expiresAt: tokens[pageId].expiresAt };
}

// Applies a connect/sync result to the db (synchronous). Backfill turns daily gains into
// estimated past totals by walking back from today's real count.
function applyReading(studio, result) {
  const state = igState(studio);
  const today = W.localDay(new Date());
  const st = state.status[result.pageId];
  Object.assign(st, { connected: true, username: result.username, igUserId: result.igUserId, lastFetchAt: new Date().toISOString(), lastError: null, lastErrorAt: null, tokenExpiresAt: result.expiresAt });
  if (!st.connectedAt) st.connectedAt = st.lastFetchAt;
  putSnapshot(state, result.pageId, { date: today, followers: result.followers, at: st.lastFetchAt, source: 'api' });
  const seen = new Set();
  const gains = (result.gains || []).filter((g) => g.date < today && !seen.has(g.date) && seen.add(g.date)).sort((a, b) => b.date.localeCompare(a.date));
  if (gains.length) {
    // Walk back from today's real count: `total` is the estimated count at the end of g.date,
    // and subtracting that day's net change gives the end of the day before.
    let total = result.followers;
    for (const g of gains) {
      putSnapshot(state, result.pageId, { date: g.date, followers: total, at: st.lastFetchAt, source: 'backfill' });
      total -= g.gain;
    }
    st.historyNote = `The ${gains.length} day(s) before connection are estimated from Instagram's daily follower change.`;
  } else if (!st.historyNote) {
    st.historyNote = 'Instagram did not provide past daily history, so the chart starts from the connection date.';
  }
}

function recordError(studio, pageId, message) {
  const st = igState(studio).status[pageId];
  st.lastError = message;
  st.lastErrorAt = new Date().toISOString();
}

function disconnectPage(studio, pageId) {
  const tokens = readTokens();
  delete tokens[pageId];
  writeTokens(tokens);
  const st = igState(studio).status[pageId];
  st.connected = false;
  st.lastError = null;
  st.tokenExpiresAt = null;
  // Saved snapshots are kept as history; the page shows demo data again until reconnected.
}

// Fetches today's follower count for one connected page, refreshing the token when it is
// close to expiry (or whenever possible with forceRefresh — Instagram only allows refreshing
// tokens that are at least 24 hours old). Returns a reading for applyReading().
async function syncPage(pageId, forceRefresh) {
  const tokens = readTokens();
  const entry = tokens[pageId];
  if (!entry || !entry.token) throw new IgError('Not connected.');
  const left = new Date(entry.expiresAt).getTime() - Date.now();
  const age = Date.now() - new Date(entry.refreshedAt || entry.savedAt).getTime();
  if ((forceRefresh || left < REFRESH_WHEN_DAYS_LEFT * 86400000) && age > 24 * 3600000) {
    const r = await refreshToken(entry.token);
    entry.token = r.access_token;
    entry.refreshedAt = new Date().toISOString();
    entry.expiresAt = new Date(Date.now() + (Number(r.expires_in) || 60 * 86400) * 1000).toISOString();
    writeTokens(tokens);
  }
  const profile = await fetchProfile(entry.token);
  if (String(profile.username || '').toLowerCase() !== expectedUsername(pageId)) throw new IgError(`The saved token now belongs to @${profile.username}, not ${C.getPage(pageId).handle}. Reconnect this page.`);
  return { pageId, username: profile.username, igUserId: entry.igUserId, followers: profile.followers_count, gains: [], expiresAt: entry.expiresAt };
}

// Syncs every connected page whose last reading is older than SYNC_EVERY_HOURS (or all, if forced).
// `loadDb`/`saveDb` are db.js's load/save; `getStudio` normalises db.socialStudio.
async function syncAll({ loadDb, saveDb, getStudio, force, forceRefresh }) {
  const tokens = readTokens();
  const snapshot = getStudio(loadDb());
  const due = C.PAGE_IDS.filter((p) => {
    if (!tokens[p]) return false;
    const st = igState(snapshot).status[p];
    return force || !st.lastFetchAt || Date.now() - new Date(st.lastFetchAt).getTime() > SYNC_EVERY_HOURS * 3600000;
  });
  if (!due.length) return { synced: [], failed: [] };
  const results = await Promise.all(due.map((p) => syncPage(p, forceRefresh).then((r) => ({ ok: true, r }), (e) => ({ ok: false, pageId: p, message: e instanceof IgError ? e.message : 'Unexpected error while syncing.' }))));
  const db = loadDb();
  const studio = getStudio(db);
  results.forEach((x) => (x.ok ? applyReading(studio, x.r) : recordError(studio, x.pageId, x.message)));
  saveDb(db);
  return { synced: results.filter((x) => x.ok).map((x) => x.r.pageId), failed: results.filter((x) => !x.ok).map((x) => ({ pageId: x.pageId, message: x.message })) };
}

// Problems an admin should be reminded about, for each connected page: the token expires
// within REMIND_DAYS (automatic renewal normally happens before that), has expired, its token
// file entry is missing, or the latest sync failed. Pages that were never connected are not
// reminders. Returns [] when everything is fine.
const REMIND_DAYS = 10;
function tokenAlerts(studio, now) {
  const at = now || new Date();
  const ig = studio && studio.instagram;
  if (!ig || !ig.status) return [];
  const tokens = readTokens();
  const out = [];
  C.PAGE_IDS.forEach((pageId) => {
    const st = ig.status[pageId];
    if (!st || !st.connected) return;
    const handle = C.getPage(pageId).handle;
    const entry = tokens[pageId];
    if (!entry || !entry.token) {
      out.push({ pageId, handle, kind: 'missing', text: `${handle}: the saved access token is missing. Paste a new token to keep follower counts updating.` });
      return;
    }
    const exp = new Date(entry.expiresAt || st.tokenExpiresAt);
    const daysLeft = Math.ceil((exp.getTime() - at.getTime()) / 86400000);
    if (!Number.isNaN(daysLeft) && daysLeft <= 0) {
      out.push({ pageId, handle, kind: 'expired', expiresAt: exp.toISOString(), daysLeft, text: `${handle}: the access token expired on ${exp.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}. Generate a new token in the Meta app and paste it in Instagram connection.` });
      return;
    }
    if (!Number.isNaN(daysLeft) && daysLeft <= REMIND_DAYS) {
      out.push({ pageId, handle, kind: 'expiring', expiresAt: exp.toISOString(), daysLeft, text: `${handle}: the access token expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${exp.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}). Click “Renew tokens now”.` });
    }
    const failedLast = st.lastError && (!st.lastFetchAt || new Date(st.lastErrorAt) > new Date(st.lastFetchAt));
    if (failedLast) out.push({ pageId, handle, kind: 'error', text: `${handle}: the last follower update failed — ${st.lastError}` });
  });
  return out;
}

// Background sync while the server runs. Disabled with PMS_IG_SYNC=off (the tests do this).
function startScheduler(deps) {
  if (process.env.PMS_IG_SYNC === 'off') return null;
  const run = () => syncAll({ ...deps, force: false }).catch((e) => console.error('[instagram] sync failed:', e.message));
  setTimeout(run, 20000).unref();
  return setInterval(run, 3 * 3600000).unref();
}

module.exports = {
  API_VERSION, TOKENS_FILE, IgError, setFetch, readTokens, igState, isLive, expectedUsername,
  connectPage, applyReading, recordError, disconnectPage, syncPage, syncAll, startScheduler, putSnapshot,
  REMIND_DAYS, tokenAlerts
};
