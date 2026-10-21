// Social Media Studio — fixed configuration (pages, Studio roster, permission flags, defaults).
// Ported from the standalone Studio's data/team.ts and data/settings.ts.
//
// The roster is NOT a second user table. Each roster entry is a named Studio slot that an
// admin links to an existing PMS user id (see store.js / members). Permission flags live here
// in code, so they can't be changed through any form or request.

const PAGES = [
  { id: 'product', name: 'Rajarani Product', shortName: 'Product', handle: '@rajarani_product', color: 'var(--purple)', soft: 'var(--purple-soft)' },
  { id: 'farma', name: 'Rajarani Farma Pattern', shortName: 'Farma Pattern', handle: '@rajarani_farma_pattern', color: 'var(--success)', soft: 'var(--success-soft)' },
  { id: 'stencil', name: 'Rajarani Stencil', shortName: 'Stencil', handle: '@rajarani_stencil', color: 'var(--info)', soft: 'var(--info-soft)' },
  { id: 'butterpaper', name: 'Rajarani Butterpaper', shortName: 'Butterpaper', handle: '@rajarani_butterpaper', color: 'var(--warning)', soft: 'var(--warning-soft)' }
];
const PAGE_IDS = PAGES.map((p) => p.id);
// Hex versions of the page colours, for SVG charts (CSS variables don't work in every SVG attribute).
const PAGE_CHART = { product: '#6C4E96', farma: '#3F7A56', stencil: '#3A5F8A', butterpaper: '#B5862A' };

// canWork: may claim / complete / schedule / publish Studio work.
// canEdit: may claim video editing (the four-person editing team).
// ranked:  appears in Employee Ranking and performance scoring.
// Dhara and Ashmita are view-only: no task actions, never ranked or scored.
const ROSTER = [
  { key: 'bansi', name: 'Bansi', canWork: true, canEdit: true, ranked: true },
  { key: 'bhavin', name: 'Bhavin', canWork: true, canEdit: true, ranked: true },
  { key: 'vishnu', name: 'Vishnu', canWork: true, canEdit: true, ranked: true },
  { key: 'krutik', name: 'Krutik', canWork: true, canEdit: true, ranked: true },
  { key: 'dhara', name: 'Dhara', canWork: false, canEdit: false, ranked: false },
  { key: 'ashmita', name: 'Ashmita', canWork: false, canEdit: false, ranked: false }
];
const ROSTER_KEYS = ROSTER.map((r) => r.key);
const EDITOR_KEYS = ROSTER.filter((r) => r.canEdit).map((r) => r.key);
const RANKED_KEYS = ROSTER.filter((r) => r.ranked).map((r) => r.key);

// Page-team assignment (who works a page) is separate from editing eligibility.
const DEFAULT_PAGE_TEAMS = {
  product: ['bansi', 'krutik'],
  farma: ['bansi', 'vishnu'],
  stencil: ['dhara', 'bhavin'],
  butterpaper: ['ashmita', 'bhavin']
};

const PRIORITIES = ['Urgent', 'High', 'Medium', 'Low'];
const PRIORITY_ORDER = { Urgent: 0, High: 1, Medium: 2, Low: 3 };

function defaultSettings() {
  return {
    targets: { product: 20, farma: 20, stencil: 20, butterpaper: 20 },
    pageTeams: JSON.parse(JSON.stringify(DEFAULT_PAGE_TEAMS)),
    deadlines: { editDaysAfterShoot: 2, publishDaysAfterEdit: 2 },
    priorities: [
      { priority: 'Urgent', description: 'Campaign-critical or time-bound launch. Drop other work.', slaHours: 12 },
      { priority: 'High', description: 'Festive / promotional reel tied to a date.', slaHours: 24 },
      { priority: 'Medium', description: 'Regular planned content for the monthly target.', slaHours: 48 },
      { priority: 'Low', description: 'Evergreen content, can move if needed.', slaHours: 72 }
    ],
    weights: { onTime: 35, shootDelivery: 25, editing: 25, publishing: 15 },
    ranking: { minDueTasks: 3, provisionalBelow: 8 },
    notifications: { overdue: true, editing: true, publishing: true },
    display: { weekStartsOn: 1, defaultCalendarView: 'month' },
    followerScenario: 'baseline'
  };
}

const getPage = (id) => PAGES.find((p) => p.id === id) || null;
const getRosterEntry = (key) => ROSTER.find((r) => r.key === key) || null;

module.exports = {
  PAGES, PAGE_IDS, PAGE_CHART, ROSTER, ROSTER_KEYS, EDITOR_KEYS, RANKED_KEYS,
  DEFAULT_PAGE_TEAMS, PRIORITIES, PRIORITY_ORDER, defaultSettings, getPage, getRosterEntry
};
