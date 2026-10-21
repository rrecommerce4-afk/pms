// Sidebar entries for the Social Media Studio (same screens as the standalone Studio's nav.ts).
// `icon` is the inner SVG markup for a 24x24 stroke icon, matching the existing sidebar icons.
const STUDIO_BASE = '/social-media';

const STUDIO_NAV = [
  { path: '', label: 'Overview', icon: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>' },
  { path: 'pages', label: 'Instagram Pages', icon: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17.5 6.5h.01"/>' },
  { path: 'followers', label: 'Followers Analytics', icon: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>' },
  { path: 'calendar', label: 'Content Calendar', icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>' },
  { path: 'shoots', label: 'Shoot Planner', icon: '<path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/>' },
  { path: 'editing', label: 'Editing Studio', icon: '<rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20M6 6l2-4M12 6l2-4M18 6l2-4"/>' },
  { path: 'publishing', label: 'Publishing Queue', icon: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>' },
  { path: 'tasks', label: 'Task Management', icon: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>' },
  { path: 'ranking', label: 'Employee Ranking', icon: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0V4z"/><path d="M17 5h3v2a3 3 0 01-3 3M7 5H4v2a3 3 0 003 3"/>' },
  { path: 'reports', label: 'Performance Reports', icon: '<path d="M3 3v18h18"/><path d="M18 17V9M13 17V5M8 17v-3"/>' },
  { path: 'settings', label: 'Settings & Targets', icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>' }
];

const studioPath = (p) => (p ? `${STUDIO_BASE}/${p}` : STUDIO_BASE);

module.exports = { STUDIO_BASE, STUDIO_NAV, studioPath };
