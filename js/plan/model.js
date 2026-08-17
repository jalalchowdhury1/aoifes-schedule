// Planner pure model — no DOM, no storage. Companion to ../model.js.
// All dates are local 'YYYY-MM-DD' strings. Weeks are keyed by their Monday.

export const d2s = d =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const s2d = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const todayStr = () => d2s(new Date());
export const addDays = (s, n) => { const d = s2d(s); d.setDate(d.getDate() + n); return d2s(d); };
export const dayIdx = s => (s2d(s).getDay() + 6) % 7;           // Mon=0 … Sun=6
export const mondayOf = s => addDays(s, -dayIdx(s));
export const weeksBetween = (a, b) =>
  Math.round((s2d(mondayOf(b)) - s2d(mondayOf(a))) / 604800000);

export const WEEK_TYPES = ['teaching', 'travel', 'light', 'off'];
export const weekType = (weeks, dateStr) => weeks?.[mondayOf(dateStr)]?.type || 'teaching';
export const isOnWeek = (cycle, dateStr) =>
  ((weeksBetween(cycle.anchorMonday, dateStr) % 2) + 2) % 2 === 0;

// ── Curricula & sessions ────────────────────────────────────
export function sessionsCount(cur) {
  if (cur.pattern === 'tb-wb') return (cur.lessons || 0) * 2 + (cur.tests || 0);
  if (cur.lastUnit == null || cur.firstUnit == null) return 0;
  return Math.max(0, cur.lastUnit - cur.firstUnit + 1);
}

export function sessionLabel(cur, i) {              // i = 0-based session index
  if (cur.pattern === 'tb-wb') {
    const L = (cur.lessons || 0) * 2;
    if (i < L) return `Lesson ${Math.floor(i / 2) + 1} · ${i % 2 ? 'workbook' : 'textbook'}`;
    return `Test ${i - L + 1}`;
  }
  const u = cur.firstUnit + i;
  return (cur.titles || {})[u] || `${cur.unitWord || 'Lesson'} ${u}`;
}

export const nextSession = cur => {
  const n = sessionsCount(cur), d = cur.done || 0;
  return d >= n ? null : { index: d, label: sessionLabel(cur, d) };
};

export const currentCur = act => (act.chain || []).find(c => (c.done || 0) < sessionsCount(c)) || null;
export const actTotal = act => (act.chain || []).reduce((s, c) => s + sessionsCount(c), 0);
export const actDone = act => (act.chain || []).reduce((s, c) => s + Math.min(c.done || 0, sessionsCount(c)), 0);
export const actRemaining = act => Math.max(0, actTotal(act) - actDone(act));

// ── Sanitize (mirror of sanitizeEvents philosophy) ──────────
export function sanitizePlan(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = { ...r };
  out.version = typeof r.version === 'number' ? r.version : 1;
  out.year = r.year && r.year.start && r.year.end
    ? r.year : { label: '2026-27', start: '2026-08-17', end: '2027-08-31' };
  out.parentCycle = r.parentCycle && r.parentCycle.anchorMonday
    ? r.parentCycle : { pattern: '7on7off', anchorMonday: '2026-08-17', confirmed: false };
  out.weeks = {};
  if (r.weeks && typeof r.weeks === 'object')
    for (const [k, v] of Object.entries(r.weeks))
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && v && WEEK_TYPES.includes(v.type))
        out.weeks[k] = { type: v.type, ...(v.label ? { label: String(v.label) } : {}) };
  out.activities = (Array.isArray(r.activities) ? r.activities : [])
    .filter(a => a && typeof a === 'object' && a.id && a.type)
    .map(a => ({ ...a, chain: Array.isArray(a.chain)
        ? a.chain.filter(c => c && c.pattern).map(c => ({ ...c, done: Math.max(0, c.done || 0) }))
        : [] }));
  out.log = (Array.isArray(r.log) ? r.log : [])
    .filter(e => e && e.date && e.status && (e.activityId || e.eventId));
  out.overrides = (Array.isArray(r.overrides) ? r.overrides : [])
    .filter(o => o && o.date && o.action);
  return out;
}

export const serializePlan = p => JSON.stringify(p);
