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
const asPeriods = x => (Array.isArray(x) ? x : []);           // guard: non-array/missing -> none
export const byPeriodStart = (a, b) =>
  a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
export const sortPeriods = list => list.sort(byPeriodStart);

// The period covering this day, or null.
// OVERLAPS: `off` WINS over `travel` — an off day pauses everything, so it is
// the stronger claim and the safer default when two periods collide (the family
// would rather see a day off they meant to keep than schoolwork they cancelled).
// Among periods of the SAME type the first in sort order wins; the list is kept
// sorted by start (sanitizePlan + every state.js mutation), so that is the
// earliest start. Nothing here mutates or re-sorts `periods`.
export const dayAway = (periods, dateStr) => {
  let hit = null;
  for (const p of asPeriods(periods)) {
    if (p.start > dateStr || dateStr > p.end) continue;
    if (!hit) { hit = p; }
    else if (hit.type !== 'off' && p.type === 'off') hit = p;
    if (hit.type === 'off') break;                            // nothing can outrank an off day
  }
  return hit;
};

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

// ── Concurrent-write merge (server side) ────────────────────
// Two writers share one blob: this browser and the Telegram bot. A save carries
// the `savedAt` of the blob it was edited on top of (`base`); when KV has moved
// on since, api/plan-save calls this instead of blind last-write-wins.
//
// It is an APPEND union, deliberately narrow: rows present in `current` but
// absent from `incoming` are carried over, because in practice both writers
// only ever ADD — a tap logs a row, the bot writes a one-off. Nothing else is
// reconciled: `incoming` wins outright on activities, periods, parentCycle and
// every other field, since those are edited in one place at a time.
//
// KNOWN LIMIT — deletion resurrection: an untick (log splice) or a deleted
// override that races another writer's save comes back, because "absent from
// incoming" cannot tell "they deleted it" from "they never saw it". The family
// re-taps; nothing is lost, something is restored. That trade is deliberate:
// losing a logged session is silent, an unexpected ✓ is visible. See AGENTS.md.
export function mergePlanWrites(current, incoming) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  if (!current || typeof current !== 'object') return incoming;

  // An override written by the bot has an id; one hand-written by a script may
  // not, so fall back to the shape of the row itself.
  const ovKey = o => (o && o.id != null && o.id !== ''
    ? `id:${o.id}`
    : `fp:${o?.date}|${o?.action}|${o?.start}|${o?.end}|${o?.name}`);
  // One status per thing per day is the log's own invariant (logTimed replaces
  // in place), so (date, owner) is the row's identity.
  const logKey = e => `${e?.date}|${e?.eventId || e?.activityId || ''}`;

  const inOv = Array.isArray(incoming.overrides) ? incoming.overrides : [];
  const curOv = Array.isArray(current.overrides) ? current.overrides : [];
  const inLog = Array.isArray(incoming.log) ? incoming.log : [];
  const curLog = Array.isArray(current.log) ? current.log : [];

  const haveOv = new Set(inOv.map(ovKey));
  const haveLog = new Set(inLog.map(logKey));
  const addOv = curOv.filter(o => !haveOv.has(ovKey(o)));
  const addLog = curLog.filter(e => !haveLog.has(logKey(e)));
  if (!addOv.length && !addLog.length) return incoming;    // nothing to carry over

  const out = { ...incoming, overrides: [...inOv, ...addOv], log: [...inLog, ...addLog] };

  // A paced check advances a curriculum's `done` in the same write that logs
  // it. Re-attaching the row alone would leave the chain one session behind, so
  // each carried-over row replays its own increment. Never mutates `incoming`.
  const bumps = addLog.filter(e => e && e.curriculum);
  if (bumps.length) {
    out.activities = (Array.isArray(incoming.activities) ? incoming.activities : []).map(a => ({ ...a }));
    for (const row of bumps) {
      const act = out.activities.find(a => (row.activityId
        ? a.id === row.activityId
        : Array.isArray(a.chain) && a.chain.some(c => c && c.id === row.curriculum)));
      if (!act || !Array.isArray(act.chain)) continue;
      if (!act.chain.some(c => c && c.id === row.curriculum)) continue;
      act.chain = act.chain.map(c =>
        (c && c.id === row.curriculum ? { ...c, done: (c.done || 0) + 1 } : c));
    }
  }
  return out;
}

// ── Weekly capacity: how many sessions this activity expects in a week ──
// `periods` is the day-precise time-away list — always an array (sanitizePlan
// guarantees it on both load paths); every caller in the app passes plan.periods.
export function weekCapacity(act, weekStart, periods, cycle) {
  const r = act.rhythm || {};
  let base = 0;
  if (r.kind === 'daily') base = 7;
  else if (r.kind === 'weekly') base = r.perWeek || 1;
  else if (r.kind === 'cycle') base = isOnWeek(cycle, weekStart) ? (r.perOnWeek ?? 1) : (r.perOffWeek ?? 2.5);
  if (!base) return 0;
  return base * effectiveDaysInWeek(act, weekStart, periods) / 7;
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

// ── "This week" helpers (the Today card) ────────────────────
// Teaching-week counter, 1-based from year.start. Same definition of a teaching
// week as targetStats: 4+ plain school days, i.e. awayDaysInWeek <= 3. A
// majority-away week is skipped and does NOT advance the count, so the number
// answers "how many real school weeks in", not "how many weeks on the calendar".
// null = the week of `dateStr` is itself majority-away, or sits before the year
// started (the card then omits the line rather than printing something false).
export function teachingWeekNumber(plan, dateStr) {
  const start = plan?.year?.start, end = plan?.year?.end;
  if (!isISO(start) || !isISO(dateStr)) return null;
  if (isISO(end) && dateStr > end) return null;   // past the school year: no number
  const target = mondayOf(dateStr);
  let w = mondayOf(start), n = 0, guard = 0;
  if (target < w) return null;
  while (w <= target) {
    if (guard++ >= WALK_CAP) return null;         // malformed year: no number at all
    const teaching = awayDaysInWeek(plan?.periods, w) <= 3;
    if (teaching) n++;
    if (w === target) return teaching ? n : null;
    w = addDays(w, 7);
  }
  return null;
}

// Consecutive-day run of `done` entries for one activity, ending at `today` —
// or at YESTERDAY when today isn't ticked yet, so a morning before the day's
// work never reads as a broken streak.
// An away day with no entry BRIDGES the run instead of ending it: on travel
// Singapore Math drops to every other day by design, and a rhythm the plan
// itself prescribes must not cost Aoife her streak. A plain (not-away) missed
// day ends it outright.
// The bridge is BOUNDED at MAX_BRIDGE consecutive missed away days — one
// every-other-day gap plus a day of slack. Unbounded, a 5-week Dhaka trip with
// nothing logged would still be advertising a streak earned before the flight,
// which is a lie the fire emoji makes worse. Any `done` day resets the count.
export const MAX_BRIDGE = 2;
export function dailyStreak(log, actId, periods, today) {
  const done = new Set();
  for (const e of Array.isArray(log) ? log : [])
    if (e && e.activityId === actId && e.status === 'done' && isISO(e.date)) done.add(e.date);
  if (!done.size || !isISO(today)) return 0;
  let d = today, n = 0, bridged = 0;
  for (let i = 0; i < WALK_CAP * 7; i++) {        // same belt-and-braces cap as the week walks
    if (done.has(d)) { n++; bridged = 0; }
    else if (dayAway(periods, d)) {
      if (bridged >= MAX_BRIDGE) break;           // the trip has swallowed the run
      bridged++;                                  // an away today spends bridge like any other
    }
    else if (d !== today) break;                  // a plain missed day ends the run
    // else: today itself, still unticked this morning — no cost, no credit
    d = addDays(d, -1);
  }
  return n;
}

// ── Core attendance: template sessions expected vs logged done ──
// The Year view's core rows answer "how much of this subject's regular week
// actually happened". Both halves are counted from primary data — the template
// and the log — never from a denormalized counter:
//   expected = the category's template events whose weekday falls on a day of
//              this week that is NOT away and NOT cancelled by a `skip`
//              override. A fully-away week therefore expects nothing, which is
//              what stops a trip from reading as a wall of missed sessions.
//   done     = log rows dated Mon..Sun with status 'done' whose eventId is one
//              of those template events. A dated one-off (`action:'add'`) logs
//              against its OWN id, so it can never inflate a template's count.
// `done` is deliberately NOT filtered by away day: work the family did anyway
// on a travel day is work, and the kinder failure mode is to credit it (same
// reasoning as dailyStreak's away-day bridge). The cost is that `done` can
// exceed `expected`, which the Year view reads as a full week — correct — and
// that a WHOLLY away week with sessions logged still shows expected 0. That
// last case is unreachable from the app (the Today view shows no timed blocks
// on an away day, so there is nothing to tap) and is accepted.
// `plan` is the whole blob rather than three arguments: periods, overrides and
// log are always read together here, and splitting them only invited a caller
// to forget one (an omitted `overrides` silently over-counts `expected`).
export function weekAttendance(events, plan, weekStart, cat) {
  // A null category must match NOTHING. `e.cat === cat` would otherwise let
  // `undefined === undefined` pair a category-less caller with the corrupt
  // {id:'e999'} record the live blob still carries — the same trap that made
  // today.js's statusOf tick unrelated blocks (see its `it.activityId != null`).
  if (cat == null) return { expected: 0, done: 0 };
  const evs = (Array.isArray(events) ? events : []).filter(e =>
    e && e.cat === cat && Number.isInteger(e.day) && e.day >= 0 && e.day <= 6);
  const overrides = Array.isArray(plan?.overrides) ? plan.overrides : [];
  const log = Array.isArray(plan?.log) ? plan.log : [];
  const ids = new Set(evs.map(e => e.id));
  let expected = 0;
  for (const e of evs) {
    const date = addDays(weekStart, e.day);
    if (dayAway(plan?.periods, date)) continue;
    if (overrides.some(o => o && o.action === 'skip' && o.date === date && o.eventId === e.id)) continue;
    expected++;
  }
  const end = addDays(weekStart, 6);
  const done = log.filter(x => x && x.status === 'done' && x.eventId != null &&
    ids.has(x.eventId) && x.date >= weekStart && x.date <= end).length;
  return { expected, done };
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
