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
// Every date that a week-walk loop compares against MUST be a real ISO date,
// or `while (w <= badDate)` never terminates. Guard them all here.
export const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isISO = s => typeof s === 'string' && ISO.test(s);

export function sanitizePlan(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = { ...r };
  out.version = typeof r.version === 'number' ? r.version : 1;
  out.year = r.year && isISO(r.year.start) && isISO(r.year.end)
    ? r.year : { label: '2026-27', start: '2026-08-17', end: '2027-08-31' };
  out.parentCycle = r.parentCycle && isISO(r.parentCycle.anchorMonday)
    ? r.parentCycle : { pattern: '7on7off', anchorMonday: '2026-08-17', confirmed: false };
  out.weeks = {};
  if (r.weeks && typeof r.weeks === 'object')
    for (const [k, v] of Object.entries(r.weeks))
      if (isISO(k) && v && WEEK_TYPES.includes(v.type))
        out.weeks[k] = { type: v.type, ...(v.label ? { label: String(v.label) } : {}) };
  out.activities = (Array.isArray(r.activities) ? r.activities : [])
    .filter(a => a && typeof a === 'object' && a.id && a.type)
    .map(a => {
      const o = { ...a, chain: Array.isArray(a.chain)
          ? a.chain.filter(c => c && c.pattern).map(c => ({ ...c, done: Math.max(0, c.done || 0) }))
          : [] };
      if (o.goal && !isISO(o.goal.finishBy)) delete o.goal;
      return o;
    });
  out.log = (Array.isArray(r.log) ? r.log : [])
    .filter(e => e && isISO(e.date) && e.status && (e.activityId || e.eventId));
  out.overrides = (Array.isArray(r.overrides) ? r.overrides : [])
    .filter(o => o && isISO(o.date) && o.action);
  return out;
}

export const serializePlan = p => JSON.stringify(p);

// ── Weekly capacity: how many sessions this activity expects in a week ──
export function weekCapacity(act, weekStart, weeks, cycle) {
  const wt = weekType(weeks, weekStart);
  if (wt === 'off') return 0;
  const r = act.rhythm || {};
  let base = 0;
  if (r.kind === 'daily') base = 7;
  else if (r.kind === 'weekly') base = r.perWeek || 1;
  else if (r.kind === 'cycle') base = isOnWeek(cycle, weekStart) ? (r.perOnWeek ?? 1) : (r.perOffWeek ?? 2.5);
  if (wt === 'light') return base * 0.5;
  if (wt === 'travel') {
    const t = act.travel || { mode: 'pause' };
    if (t.mode === 'continue') return base;
    if (t.mode === 'reduced') return base * (t.factor ?? 0.5);
    return 0;
  }
  return base;
}

// Walk weeks forward until remaining sessions are covered. null = can't project.
export function projectFinish(act, fromDate, plan, horizon = 300) {
  const remaining = actRemaining(act);
  if (actTotal(act) === 0) return null;              // unknown counts (waiting for books)
  if (remaining === 0) return { date: fromDate, weeks: 0, done: true };
  let acc = 0, w = mondayOf(fromDate);
  for (let i = 0; i < horizon; i++) {
    acc += weekCapacity(act, w, plan.weeks, plan.parentCycle);
    if (acc >= remaining) return { date: addDays(w, 6), weeks: i + 1 };
    w = addDays(w, 7);
  }
  return null;
}

// Hard stop for every week-walk loop (~11.5 years). Belt-and-braces alongside
// sanitizePlan's ISO guards: an unsanitized/hand-built plan must never hang the UI.
const WALK_CAP = 600;

// Minimum sessions per 2-week cycle to hit the goal (counting non-blocked weeks).
export function requiredPerCycle(act, fromDate, plan) {
  if (!act.goal?.finishBy) return null;
  const remaining = actRemaining(act);
  let usable = 0, w = mondayOf(fromDate), n = 0;
  while (w <= act.goal.finishBy) {
    if (n++ >= WALK_CAP) break;                      // behave as if the walk ended
    if (weekCapacity(act, w, plan.weeks, plan.parentCycle) > 0) usable++;
    w = addDays(w, 7);
  }
  if (!usable) return null;
  return remaining / (usable / 2);
}

// ── Cycle stats (7-on/7-off activities) ─────────────────────
export function cycleBounds(cycle, dateStr) {
  const k = Math.floor(weeksBetween(cycle.anchorMonday, dateStr) / 2);
  const start = addDays(cycle.anchorMonday, k * 14);
  return { start, end: addDays(start, 13) };
}

const countDone = (log, actId, from, to) =>
  log.filter(e => e.activityId === actId && e.status === 'done' && e.date >= from && e.date <= to).length;

export function cycleStats(act, dateStr, cycle, log) {
  const { start, end } = cycleBounds(cycle, dateStr);
  const r = act.rhythm || {};
  const targetMin = Number(r.perOnWeek ?? 1) + Math.floor(Number(r.perOffWeek ?? 2.5));
  const targetMax = Number(r.perOnWeek ?? 1) + Math.ceil(Number(r.perOffWeek ?? 2.5));
  const done = countDone(log, act.id, start, end);
  const prev = cycleBounds(cycle, addDays(start, -1));
  const prevDone = countDone(log, act.id, prev.start, prev.end);
  return {
    start, end, done, targetMin, targetMax,
    behind: dateStr >= end && done < targetMin,
    prevBehind: prevDone < targetMin && weeksBetween(cycle.anchorMonday, dateStr) >= 2,
  };
}

// ── Target-count stats (Jiu Jitsu) ──────────────────────────
export function targetStats(act, plan, log, dateStr) {
  const { start, end } = plan.year;
  let total = 0, elapsed = 0, w = mondayOf(start), n = 0;
  while (w <= end) {
    if (n++ >= WALK_CAP) break;                      // behave as if the walk ended
    if (weekType(plan.weeks, w) !== 'travel' && weekType(plan.weeks, w) !== 'off') {
      total++;
      if (w <= dateStr) elapsed++;
    }
    w = addDays(w, 7);
  }
  const done = log.filter(e => e.activityId === act.id && e.status === 'done').length;
  const expected = total ? Math.floor((act.target || 0) * (elapsed / total)) : 0;
  return { done, target: act.target || 0, expected, behind: Math.max(0, expected - done) };
}

// ── Clash detection over template events ────────────────────
export const findClashes = (events, slot) =>
  events.filter(e => e.day === slot.day && e.start < slot.end && e.end > slot.start);

export function freeSlots(events, day, dur, count = 3) {
  const out = [];
  for (let s = 9; s <= 17 - dur && out.length < count; s += 0.5)
    if (!findClashes(events, { day, start: s, end: s + dur }).length) out.push(s);
  return out;
}

export const doneOn = (log, actId, dateStr) =>
  log.some(e => e.activityId === actId && e.date === dateStr && e.status === 'done');
