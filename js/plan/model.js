// Planner pure model — no DOM, no storage. Companion to ../model.js.
// All dates are local 'YYYY-MM-DD' strings. Week walks are keyed by their
// Monday; time away is day-precise and lives in `plan.periods` (v2).

export const d2s = d =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const s2d = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const todayStr = () => d2s(new Date());
export const addDays = (s, n) => { const d = s2d(s); d.setDate(d.getDate() + n); return d2s(d); };
export const dayIdx = s => (s2d(s).getDay() + 6) % 7;           // Mon=0 … Sun=6
export const mondayOf = s => addDays(s, -dayIdx(s));
export const weeksBetween = (a, b) =>
  Math.round((s2d(mondayOf(b)) - s2d(mondayOf(a))) / 604800000);
// Round, don't floor: a DST boundary makes a "day" 23 or 25 hours long.
export const daysBetween = (a, b) => Math.round((s2d(b) - s2d(a)) / 86400000);

// DEPRECATED — removed in Task B. The `weeks` map is gone from the data model
// (see `periods` below); year.js/today.js still call this until they are rewritten.
export const WEEK_TYPES = ['teaching', 'travel', 'light', 'off'];
export const weekType = (weeks, dateStr) => weeks?.[mondayOf(dateStr)]?.type || 'teaching';

// Monday parity of the 2-week parent cycle (which weeks are "work weeks").
export const isOnWeek = (cycle, dateStr) =>
  ((weeksBetween(cycle.anchorMonday, dateStr) % 2) + 2) % 2 === 0;

// Day-precise duty: a Charlton work stretch runs Tue → Mon (7 days on, 7 off)
// from `dutyStart`. Dates before dutyStart must keep the same parity, hence the
// double modulo.
export const DEFAULT_DUTY_START = '2026-08-11';
export const isWorkDay = (cycle, dateStr) =>
  ((daysBetween(cycle?.dutyStart || DEFAULT_DUTY_START, dateStr) % 14) + 14) % 14 < 7;

// ── Time-away periods (day-precise; replaces the week map) ──
export const PERIOD_TYPES = ['travel', 'off'];
const asPeriods = x => (Array.isArray(x) ? x : []);           // legacy weeks map -> none
export const byPeriodStart = (a, b) =>
  a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
export const sortPeriods = list => list.sort(byPeriodStart);

// The period covering this day, or null. Overlaps resolve to the earliest start.
export const dayAway = (periods, dateStr) =>
  asPeriods(periods).find(p => p.start <= dateStr && dateStr <= p.end) || null;

export function dayStatus(periods, dateStr) {
  const p = dayAway(periods, dateStr);
  if (!p) return { away: false };
  return {
    away: true, id: p.id, type: p.type, label: p.label || '',
    dayN: daysBetween(p.start, dateStr) + 1,
    total: daysBetween(p.start, p.end) + 1,
  };
}

export const awayDaysInWeek = (periods, weekStart) => {
  let n = 0;
  for (let i = 0; i < 7; i++) if (dayAway(periods, addDays(weekStart, i))) n++;
  return n;
};

// School-days-worth of this week for one activity: a plain day is 1, an `off`
// day is 0, a travel day is worth whatever the activity's travel mode says.
export function effectiveDaysInWeek(act, weekStart, periods) {
  const t = act?.travel || { mode: 'pause' };
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const away = dayAway(periods, addDays(weekStart, i));
    if (!away) { n += 1; continue; }
    if (away.type === 'off') continue;                        // everything pauses
    if (t.mode === 'continue') n += 1;
    else if (t.mode === 'reduced') n += (t.factor ?? 0.5);
  }
  return n;
}

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

// ── Category class tokens ───────────────────────────────────
// `cls` is interpolated RAW into class="…" attributes by every view, so it is
// whitelisted rather than escaped. Lives here (pure) so no view imports another.
const CLS = new Set(['q', 'r', 'h', 'b', 'a', 'ot', 'g', 's', 'j']);
export const okCls = x => (CLS.has(x) ? x : 'ot');

export const currentCur = act => (act.chain || []).find(c => (c.done || 0) < sessionsCount(c)) || null;
export const actTotal = act => (act.chain || []).reduce((s, c) => s + sessionsCount(c), 0);
export const actDone = act => (act.chain || []).reduce((s, c) => s + Math.min(c.done || 0, sessionsCount(c)), 0);
export const actRemaining = act => Math.max(0, actTotal(act) - actDone(act));

// ── Sanitize (mirror of sanitizeEvents philosophy) ──────────
// Every date that a week-walk loop compares against MUST be a real ISO date,
// or `while (w <= badDate)` never terminates. Guard them all here.
export const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isISO = s => typeof s === 'string' && ISO.test(s);

// One period, or null if it can't be trusted. `id` is identity: updatePeriod /
// deletePeriod find rows by it, so an id-less row would be uneditable.
const cleanPeriod = p => {
  if (!p || typeof p !== 'object') return null;
  const id = p.id == null ? '' : String(p.id);
  if (!id || !isISO(p.start) || !isISO(p.end) || p.start > p.end) return null;
  if (!PERIOD_TYPES.includes(p.type)) return null;
  return { id, start: p.start, end: p.end, type: p.type,
    ...(p.label ? { label: String(p.label) } : {}) };
};

// v1 → v2: every marked week becomes a 7-day period (Mon..Sun). `light` is gone
// from the model, so those weeks are dropped; `teaching` was never a marking.
const migrateWeeks = weeks => {
  const out = [];
  if (weeks && typeof weeks === 'object')
    for (const [k, v] of Object.entries(weeks))
      if (isISO(k) && v && PERIOD_TYPES.includes(v.type))
        out.push({ id: `w-${k}`, start: k, end: addDays(k, 6), type: v.type,
          ...(v.label ? { label: String(v.label) } : {}) });
  return out;
};

export function sanitizePlan(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = { ...r };
  out.version = typeof r.version === 'number' ? r.version : 1;
  out.year = r.year && isISO(r.year.start) && isISO(r.year.end)
    ? r.year : { label: '2026-27', start: '2026-08-17', end: '2027-08-31' };
  const pc = r.parentCycle && isISO(r.parentCycle.anchorMonday)
    ? { ...r.parentCycle } : { pattern: '7on7off', anchorMonday: '2026-08-17', confirmed: false };
  if (!isISO(pc.dutyStart)) pc.dutyStart = DEFAULT_DUTY_START;
  out.parentCycle = pc;
  const seen = new Set();
  const periods = [];
  for (const p of [...(Array.isArray(r.periods) ? r.periods : []).map(cleanPeriod).filter(Boolean),
                   ...migrateWeeks(r.weeks)])
    if (!seen.has(p.id)) { seen.add(p.id); periods.push(p); }   // id is identity: no duplicates
  out.periods = sortPeriods(periods);
  delete out.weeks;
  // DEPRECATED SHIM — delete in Task B/C. `weeks` is no longer part of the data
  // (not an own enumerable key, never serialized), but year.js/today.js still
  // read `plan.weeks[…]` / Object.keys(plan.weeks) directly and would throw on
  // every render against `undefined`. Hand them an inert empty map until then.
  Object.defineProperty(out, 'weeks',
    { value: {}, enumerable: false, writable: true, configurable: true });
  out.activities = (Array.isArray(r.activities) ? r.activities : [])
    .filter(a => a && typeof a === 'object' && a.id && a.type)
    .map(a => {
      // `id` is required: togglePaced records it in the log and finds the
      // curriculum by it on uncheck. An id-less entry would break that identity.
      const o = { ...a, chain: Array.isArray(a.chain)
          ? a.chain.filter(c => c && c.pattern && c.id).map(c => ({ ...c, done: Math.max(0, c.done || 0) }))
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
// `periods` is the day-precise time-away list. DEPRECATED SHIM (removed in
// Task B): a legacy weeks map (plain object) is accepted and read as "no time
// away", so year.js keeps rendering until it is rewritten.
export function weekCapacity(act, weekStart, periods, cycle) {
  const r = act.rhythm || {};
  let base = 0;
  if (r.kind === 'daily') base = 7;
  else if (r.kind === 'weekly') base = r.perWeek || 1;
  else if (r.kind === 'cycle') base = isOnWeek(cycle, weekStart) ? (r.perOnWeek ?? 1) : (r.perOffWeek ?? 2.5);
  if (!base) return 0;
  return base * effectiveDaysInWeek(act, weekStart, asPeriods(periods)) / 7;
}

// Walk weeks forward until remaining sessions are covered. null = can't project.
export function projectFinish(act, fromDate, plan, horizon = 300) {
  const remaining = actRemaining(act);
  if (actTotal(act) === 0) return null;              // unknown counts (waiting for books)
  if (remaining === 0) return { date: fromDate, weeks: 0, done: true };
  let acc = 0, w = mondayOf(fromDate);
  for (let i = 0; i < horizon; i++) {
    acc += weekCapacity(act, w, plan.periods, plan.parentCycle);
    if (acc >= remaining) return { date: addDays(w, 6), weeks: i + 1 };
    w = addDays(w, 7);
  }
  return null;
}

// Hard stop for every week-walk loop (~11.5 years). Belt-and-braces alongside
// sanitizePlan's ISO guards: an unsanitized/hand-built plan must never hang the UI.
export const WALK_CAP = 600;

// Minimum sessions per 2-week cycle to hit the goal (counting non-blocked weeks).
export function requiredPerCycle(act, fromDate, plan) {
  if (!act.goal?.finishBy) return null;
  const remaining = actRemaining(act);
  let usable = 0, w = mondayOf(fromDate), n = 0;
  while (w <= act.goal.finishBy) {
    if (n++ >= WALK_CAP) break;                      // behave as if the walk ended
    if (weekCapacity(act, w, plan.periods, plan.parentCycle) > 0) usable++;
    w = addDays(w, 7);
  }
  if (!usable) return null;
  return remaining / (usable / 2);
}

// ── Trip impact: finish dates before vs after a drafted period ──
// `draft` may carry the id of the period being edited, in which case it
// REPLACES that period instead of stacking on top of it. Never mutates `plan`.
export function tripImpact(plan, draft, fromDate = todayStr()) {
  const base = asPeriods(plan.periods);
  const raw = { ...draft };                          // a new trip has no id yet
  const d = cleanPeriod({ ...raw, id: raw.id || '__draft__',
    type: PERIOD_TYPES.includes(raw.type) ? raw.type : 'travel' });
  const after = d ? sortPeriods([...base.filter(p => p.id !== d.id), d]) : base;
  const fin = (act, periods) => projectFinish(act, fromDate, { ...plan, periods })?.date ?? null;
  return (Array.isArray(plan.activities) ? plan.activities : [])
    .filter(a => a.type === 'paced' && a.status === 'active' && actTotal(a) > 0)
    .map(a => ({ id: a.id, name: a.name || a.id, before: fin(a, base), after: fin(a, after) }));
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
    if (awayDaysInWeek(plan.periods, w) <= 3) {      // a teaching week = 4+ plain school days
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
