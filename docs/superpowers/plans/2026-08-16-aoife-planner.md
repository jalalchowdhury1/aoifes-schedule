# Aoife's Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow aoifes-schedule.vercel.app into a year-round homeschool planner (curriculum pacing, daily tracking, travel-aware projections) without touching the existing schedule/print behavior.

**Architecture:** All planner code is additive under `js/plan/` + two new Vercel functions + one new KV key (`aoife_plan`, with `aoife_plan_prev` undo). A pure model (`js/plan/model.js`) computes every number; views render from it. The existing template week is read, never written. Spec: `docs/superpowers/specs/2026-08-16-planner-design.md`.

**Tech Stack:** Vanilla ES modules, no build step, `node --test` (bare — Node 24 breaks on directory arg), Vercel functions + Upstash KV REST.

**Model assignment (user directive):** Tasks 2, 6, 8, 9 → Opus subagents (math/risky UI). All others → Sonnet subagents.

**Ground rules for every task:**
- NEVER modify: `api/get.js`, `api/save.js`, `js/grid.js`, `js/dayview.js`, `js/editor.js`, `js/print.js`, `css/print.css`, `aoife_schedule_3.html`.
- `js/main.js`, `index.html`, `css/tokens.css`, `css/app.css` may ONLY receive the exact additive edits shown below.
- After each task: `node --test` from repo root → all pass, then commit exactly as shown.
- Dates are local-time `'YYYY-MM-DD'` strings everywhere in plan code.

---

## File map (what gets created)

| File | Responsibility |
|---|---|
| `js/plan/model.js` | PURE: dates/weeks/cycle math, session sequences, capacities, projections, stats, clash, sanitize |
| `js/plan/seed.js` | PURE: the initial `aoife_plan` blob (honest as of 2026-08-16) |
| `js/plan/state.js` | plan store, localStorage `aoife_plan_v1`, `/api/plan-*` I/O, mutations |
| `js/plan/tabs.js` | Tab navigation + boot; lazy view mounting |
| `js/plan/today.js` | Today view |
| `js/plan/subjects.js` | Subjects view |
| `js/plan/year.js` | Year view |
| `js/plan/overlay.js` | Read-only week-grid decorations + clash banner |
| `api/plan-get.js` | GET `aoife_plan` (or `?prev=1` for undo copy) |
| `api/plan-save.js` | Copy current → `aoife_plan_prev`, then SET new |
| `css/plan.css` | All planner styles (tokens.css vars reused) |
| `tests/plan-model.test.mjs` | Pure-model tests incl. real family scenarios |
| `tests/plan-state.test.mjs` | Seed sanity + sanitize round-trips |
| `scripts/planner-backup.sh` | Nightly Drive snapshot (Task 10) |

---

### Task 1: Pure model — dates, weeks, cycle, sessions, sanitize [Sonnet]

**Files:**
- Create: `js/plan/model.js`
- Create: `tests/plan-model.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `tests/plan-model.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, dayIdx, mondayOf, weeksBetween, weekType, isOnWeek,
  sessionsCount, nextSession, actTotal, actDone, actRemaining,
  sanitizePlan,
} from '../js/plan/model.js';

test('date helpers: Mon-first indexing and week math', () => {
  assert.equal(dayIdx('2026-08-16'), 6);            // Sunday
  assert.equal(dayIdx('2026-08-17'), 0);            // Monday
  assert.equal(mondayOf('2026-08-16'), '2026-08-10');
  assert.equal(mondayOf('2026-08-17'), '2026-08-17');
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(weeksBetween('2026-08-17', '2026-08-31'), 2);
  assert.equal(weeksBetween('2026-08-17', '2026-08-23'), 0);
});

test('weekType defaults to teaching, reads marked weeks by any date in week', () => {
  const weeks = { '2027-01-04': { type: 'travel', label: 'Dhaka' } };
  assert.equal(weekType(weeks, '2027-01-07'), 'travel'); // Thu of that week
  assert.equal(weekType(weeks, '2026-12-30'), 'teaching');
});

test('isOnWeek: anchor week is a work week, alternating', () => {
  const cyc = { anchorMonday: '2026-08-17' };
  assert.equal(isOnWeek(cyc, '2026-08-20'), true);   // anchor week
  assert.equal(isOnWeek(cyc, '2026-08-24'), false);  // next week = home
  assert.equal(isOnWeek(cyc, '2026-08-31'), true);
});

test('session sequences: simple and tb-wb', () => {
  const c = { pattern: 'simple', firstUnit: 81, lastUnit: 120, done: 21, titles: {} };
  assert.equal(sessionsCount(c), 40);
  assert.equal(nextSession(c).label, 'Lesson 102');
  const s = { pattern: 'tb-wb', lessons: 3, tests: 2, done: 0 };
  assert.equal(sessionsCount(s), 8);                 // 3*2 + 2
  assert.equal(nextSession(s).label, 'Lesson 1 · textbook');
  s.done = 1;
  assert.equal(nextSession(s).label, 'Lesson 1 · workbook');
  s.done = 6;
  assert.equal(nextSession(s).label, 'Test 1');
  s.done = 8;
  assert.equal(nextSession(s), null);
});

test('chain totals: LoE C at lesson 101 done 2026-08-16', () => {
  const act = { chain: [
    { pattern: 'simple', firstUnit: 81, lastUnit: 120, done: 21 },
    { pattern: 'simple', firstUnit: 121, lastUnit: 140, done: 0 },
  ] };
  assert.equal(actTotal(act), 60);
  assert.equal(actDone(act), 21);
  assert.equal(actRemaining(act), 39);               // 19 left in C + 20 in D
});

test('sanitizePlan: drops junk, keeps unknown fields, defaults everything', () => {
  const raw = {
    version: 1, futureField: 'keep-me',
    year: { label: 'x', start: '2026-08-17', end: '2027-08-31' },
    weeks: { '2027-01-04': { type: 'travel' }, bad: { type: 'nope' } },
    activities: [
      { id: 'ok', type: 'ongoing' },
      { type: 'paced' },                              // no id -> dropped
      null,
    ],
    log: [
      { date: '2026-08-16', activityId: 'ok', status: 'done' },
      { status: 'done' },                             // no date -> dropped
    ],
    overrides: 'garbage',
  };
  const p = sanitizePlan(raw);
  assert.equal(p.futureField, 'keep-me');
  assert.equal(Object.keys(p.weeks).length, 1);
  assert.equal(p.activities.length, 1);
  assert.equal(p.log.length, 1);
  assert.deepEqual(p.overrides, []);
  const empty = sanitizePlan(null);
  assert.equal(empty.version, 1);
  assert.ok(Array.isArray(empty.activities));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test 2>&1 | tail -3`
Expected: failures (module not found), existing tests still pass.

- [ ] **Step 3: Implement `js/plan/model.js` (part 1)**

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test 2>&1 | tail -3`
Expected: all pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add js/plan/model.js tests/plan-model.test.mjs
git commit -m "feat(planner): pure model part 1 — dates, weeks, cycle, sessions, sanitize"
```

---

### Task 2: Pure model — capacities, projections, stats, clash [Opus]

**Files:**
- Modify: `js/plan/model.js` (append)
- Modify: `tests/plan-model.test.mjs` (append)

- [ ] **Step 1: Append the failing tests (the real family scenarios)**

Append to `tests/plan-model.test.mjs`:

```js
import {
  weekCapacity, projectFinish, requiredPerCycle, cycleBounds, cycleStats,
  targetStats, findClashes, freeSlots, doneOn,
} from '../js/plan/model.js';

const LOE = {
  id: 'loe', type: 'paced', status: 'active',
  rhythm: { kind: 'cycle', perOnWeek: 1, perOffWeek: 2.5 },
  travel: { mode: 'pause' },
  goal: { finishBy: '2027-08-31' },
  chain: [
    { id: 'loe-c', pattern: 'simple', firstUnit: 81, lastUnit: 120, done: 21 },
    { id: 'loe-d', pattern: 'simple', firstUnit: 121, lastUnit: 140, done: 0 },
  ],
};
const SM = {
  id: 'singapore', type: 'paced', status: 'active',
  rhythm: { kind: 'daily' }, travel: { mode: 'reduced', factor: 0.5 },
  chain: [{ id: 'dm3', pattern: 'tb-wb', lessons: 60, tests: 14, done: 0 }],
};
const CYC = { anchorMonday: '2026-08-17', confirmed: false };
const JAN_TRIP = {};
for (let i = 0; i < 5; i++) JAN_TRIP[addDays('2027-01-04', i * 7)] = { type: 'travel', label: 'Dhaka' };

test('weekCapacity: rhythms × week types', () => {
  assert.equal(weekCapacity(SM, '2026-08-17', {}, CYC), 7);              // daily teaching
  assert.equal(weekCapacity(SM, '2027-01-04', JAN_TRIP, CYC), 3.5);      // daily reduced travel
  assert.equal(weekCapacity(LOE, '2026-08-17', {}, CYC), 1);             // cycle, work week
  assert.equal(weekCapacity(LOE, '2026-08-24', {}, CYC), 2.5);           // cycle, home week
  assert.equal(weekCapacity(LOE, '2027-01-04', JAN_TRIP, CYC), 0);       // pause on travel
  const geo = { rhythm: { kind: 'weekly', perWeek: 1 }, travel: { mode: 'pause' } };
  assert.equal(weekCapacity(geo, '2026-08-17', {}, CYC), 1);
  assert.equal(weekCapacity(geo, '2026-08-17', { '2026-08-17': { type: 'light' } }, CYC), 0.5);
  assert.equal(weekCapacity(geo, '2026-08-17', { '2026-08-17': { type: 'off' } }, CYC), 0);
});

test('LoE projection: C ~Nov 2026, C+D Feb-Mar 2027 with Jan trip, before goal', () => {
  // 39 sessions left at 3.5/cycle from 2026-08-17 with a 5-week January travel pause.
  const fin = projectFinish(LOE, '2026-08-17', { weeks: JAN_TRIP, parentCycle: CYC });
  assert.ok(fin.date >= '2027-02-01' && fin.date <= '2027-03-31', fin.date);
  assert.ok(fin.date < LOE.goal.finishBy);
  // C alone (clone with D emptied) lands around Nov 2026.
  const cOnly = { ...LOE, chain: [LOE.chain[0]] };
  const finC = projectFinish(cOnly, '2026-08-17', { weeks: {}, parentCycle: CYC });
  assert.ok(finC.date >= '2026-10-15' && finC.date <= '2026-11-30', finC.date);
});

test('LoE minimum pace to hit the goal is about 2 per cycle', () => {
  const need = requiredPerCycle(LOE, '2026-08-17', { weeks: JAN_TRIP, parentCycle: CYC });
  assert.ok(need > 1 && need < 2.5, String(need));
});

test('unknown counts (waiting for books) -> no projection', () => {
  const waiting = { ...SM, chain: [{ pattern: 'tb-wb', lessons: 0, tests: 0, done: 0 }] };
  assert.equal(projectFinish(waiting, '2026-08-17', { weeks: {}, parentCycle: CYC }), null);
});

test('cycleStats: one work-week lesson is on pace; targets 3-4', () => {
  const log = [{ date: '2026-08-20', activityId: 'loe', status: 'done' }];
  const st = cycleStats(LOE, '2026-08-22', CYC, log);   // Sat of anchor (work) week
  assert.equal(st.done, 1);
  assert.equal(st.targetMin, 3);
  assert.equal(st.targetMax, 4);
  assert.equal(st.behind, false);                        // cycle not over
  const bounds = cycleBounds(CYC, '2026-08-30');         // Sunday of 2nd week
  assert.equal(bounds.start, '2026-08-17');
  const st2 = cycleStats(LOE, '2026-08-31', CYC, log);   // new cycle started, prev had 1<3
  assert.equal(st2.prevBehind, true);
});

test('targetStats: JJ 3 done at ~week 11 of 48 teaching weeks, target 20 -> behind', () => {
  const jj = { id: 'jj', type: 'target', status: 'active', target: 20 };
  const plan = { year: { start: '2026-09-01', end: '2027-08-31' }, weeks: JAN_TRIP, parentCycle: CYC };
  const log = Array.from({ length: 3 }, (_, i) =>
    ({ date: addDays('2026-09-05', i * 14), activityId: 'jj', status: 'done' }));
  const st = targetStats(jj, plan, log, '2026-11-10');
  assert.equal(st.done, 3);
  assert.ok(st.expected >= 4 && st.expected <= 5, String(st.expected)); // 20 * 11/48
  assert.ok(st.behind >= 1);
});

test('clash: Science Tue 2:30-3:30 overlaps Hala Tue 2-3; suggestions avoid busy slots', () => {
  const events = [
    { id: 'e1', cat: 'hala', day: 1, start: 14, end: 15 },
    { id: 'e2', cat: 'ruhamah', day: 1, start: 11, end: 12 },
  ];
  const hits = findClashes(events, { day: 1, start: 14.5, end: 15.5 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'e1');
  const free = freeSlots(events, 1, 1);
  assert.ok(free.length > 0);
  for (const s of free) assert.equal(findClashes(events, { day: 1, start: s, end: s + 1 }).length, 0);
});

test('doneOn finds a done log entry for a date', () => {
  const log = [{ date: '2026-08-16', activityId: 'loe', status: 'done' }];
  assert.equal(doneOn(log, 'loe', '2026-08-16'), true);
  assert.equal(doneOn(log, 'loe', '2026-08-15'), false);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test 2>&1 | tail -3`
Expected: new tests fail (missing exports); Task 1 tests still pass.

- [ ] **Step 3: Append the implementation to `js/plan/model.js`**

```js
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
```

- [ ] **Step 4: Run tests — all pass**

Run: `node --test 2>&1 | tail -3`
Expected: 0 fail. If the LoE window assertions fail, debug the walk (off-by-one on `mondayOf(fromDate)` inclusion) — do NOT widen the assertion windows.

- [ ] **Step 5: Commit**

```bash
git add js/plan/model.js tests/plan-model.test.mjs
git commit -m "feat(planner): pure model part 2 — capacity, projections, cycle/target stats, clash"
```

---

### Task 3: API endpoints with one-step undo [Sonnet]

**Files:**
- Create: `api/plan-get.js`
- Create: `api/plan-save.js`

No automated test (endpoints run only on Vercel; the KV double-wrap convention is
pinned by reading them side-by-side with the frozen originals). Manual check after
first deploy: `curl -s https://aoifes-schedule.vercel.app/api/plan-get` → `{"error":"empty"}`.

- [ ] **Step 1: Create `api/plan-get.js`**

```js
// Planner data endpoint. Mirrors api/get.js conventions (unwrap loop, env
// fallbacks). ?prev=1 returns the one-step-undo copy written by plan-save.
export default async function handler(request, response) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return response.status(200).json({ error: "no-kv" });
  }

  const key = request.query && request.query.prev ? 'aoife_plan_prev' : 'aoife_plan';
  try {
    const res = await fetch(`${url}/get/${key}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.result) {
      let parsed = data.result;
      while (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch (e) { break; }
      }
      return response.status(200).json(parsed);
    }
    return response.status(200).json({ error: "empty" });
  } catch (e) {
    return response.status(500).json({ error: e.message });
  }
}
```

- [ ] **Step 2: Create `api/plan-save.js`**

```js
// Save planner data. Before writing, copies the current value to
// aoife_plan_prev (one-step undo). Body is {data: "<json-string>"} —
// the same deliberate double-wrap convention as api/save.js.
export default async function handler(request, response) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return response.status(200).json({ error: "no-kv" });
  }

  try {
    const cur = await fetch(`${url}/get/aoife_plan`, {
      headers: { Authorization: `Bearer ${token}` }
    }).then(r => r.json()).catch(() => null);
    if (cur && cur.result) {
      await fetch(`${url}/set/aoife_plan_prev`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: cur.result
      });
    }
    const res = await fetch(`${url}/set/aoife_plan`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: request.body.data
    });
    const data = await res.json();
    return response.status(200).json(data);
  } catch (e) {
    return response.status(500).json({ error: e.message });
  }
}
```

- [ ] **Step 3: Verify no frozen file changed**

Run: `git status --short api/`
Expected: only `?? api/plan-get.js` and `?? api/plan-save.js` (get.js/save.js untouched).

- [ ] **Step 4: Commit**

```bash
git add api/plan-get.js api/plan-save.js
git commit -m "feat(planner): plan-get/plan-save endpoints with aoife_plan_prev undo copy"
```

---

### Task 4: Seed + plan state store [Sonnet]

**Files:**
- Create: `js/plan/seed.js`
- Create: `js/plan/state.js`
- Create: `tests/plan-state.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `tests/plan-state.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedPlan } from '../js/plan/seed.js';
import { sanitizePlan, serializePlan, actDone, nextSession, currentCur } from '../js/plan/model.js';

test('seed survives sanitize round-trip unchanged', () => {
  const p = seedPlan();
  const round = sanitizePlan(JSON.parse(serializePlan(p)));
  assert.deepEqual(round, p);
});

test('seed facts: LoE active at lesson 101 done; Singapore waiting; template untouched', () => {
  const p = seedPlan();
  const loe = p.activities.find(a => a.id === 'loe');
  assert.equal(loe.status, 'active');
  assert.equal(actDone(loe), 21);                          // lessons 81..101
  assert.equal(nextSession(currentCur(loe)).label, 'Lesson 102');
  assert.equal(loe.goal.finishBy, '2027-08-31');
  const sm = p.activities.find(a => a.id === 'singapore');
  assert.equal(sm.status, 'planned');                      // waiting for G3 books
  const sci = p.activities.find(a => a.id === 'science');
  assert.equal(sci.status, 'planned');
  assert.deepEqual(sci.slots, [{ day: 1, start: 14.5, end: 15.5 }]);
  const jj = p.activities.find(a => a.id === 'jj');
  assert.equal(jj.status, 'planned');
  assert.equal(jj.target, 20);
  const hist = p.activities.find(a => a.id === 'history');
  assert.equal(hist.status, 'parked');
  assert.equal(p.parentCycle.confirmed, false);            // anchor parity is a guess
  assert.deepEqual(p.weeks, {});                           // no invented trip dates
  assert.equal(p.log.length, 1);                           // the known 8/16 LoE lesson
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test 2>&1 | tail -3`

- [ ] **Step 3: Create `js/plan/seed.js`**

```js
// Initial aoife_plan blob — every status honest as of 2026-08-16.
// The weekly template (aoifes_schedule) is NOT touched by seeding.
export function seedPlan() {
  return {
    version: 1,
    year: { label: '2026-27', start: '2026-08-17', end: '2027-08-31' },
    parentCycle: { pattern: '7on7off', anchorMonday: '2026-08-17', confirmed: false },
    weeks: {},
    activities: [
      { id: 'core-ruhamah', type: 'ongoing', status: 'active', cat: 'ruhamah', cls: 'r', chain: [] },
      { id: 'core-hala',    type: 'ongoing', status: 'active', cat: 'hala',    cls: 'h', chain: [] },
      { id: 'core-quran',   type: 'ongoing', status: 'active', cat: 'quran',   cls: 'q', chain: [] },
      { id: 'core-art',     type: 'ongoing', status: 'active', cat: 'art',     cls: 'a', chain: [] },
      { id: 'core-mama',    type: 'ongoing', status: 'active', cat: 'barakot', cls: 'b', chain: [] },
      {
        id: 'singapore', name: 'Singapore Math', type: 'paced', status: 'planned',
        cls: 'b', onGrid: false,
        rhythm: { kind: 'daily' }, travel: { mode: 'reduced', factor: 0.5 },
        note: 'Waiting for Dimensions G3 books — activate with real lesson counts',
        chain: [{ id: 'dm3', name: 'Dimensions Math G3', pattern: 'tb-wb',
                  lessons: 0, tests: 0, done: 0 }],
      },
      {
        id: 'loe', name: 'Logic of English', type: 'paced', status: 'active',
        cls: 'b', onGrid: false,
        rhythm: { kind: 'cycle', perOnWeek: 1, perOffWeek: 2.5 },
        travel: { mode: 'pause' },
        goal: { finishBy: '2027-08-31' },
        note: 'D span per family info (121-140); publisher may list 121-160 — verify',
        chain: [
          { id: 'loe-c', name: 'Foundations C', pattern: 'simple',
            firstUnit: 81, lastUnit: 120, done: 21, titles: {} },
          { id: 'loe-d', name: 'Foundations D', pattern: 'simple',
            firstUnit: 121, lastUnit: 140, done: 0, titles: {} },
        ],
      },
      {
        id: 'geography', name: 'Geography', type: 'paced', status: 'planned',
        cls: 'g', onGrid: true, slots: [],
        rhythm: { kind: 'weekly', perWeek: 1 }, travel: { mode: 'pause' },
        note: '36-week curriculum — unit titles load when the family provides them',
        chain: [{ id: 'geo-1', name: 'Year 1', pattern: 'simple',
                  firstUnit: 1, lastUnit: 36, done: 0, unitWord: 'Week', titles: {} }],
      },
      {
        id: 'science', name: 'Science (Zoom)', type: 'external', status: 'planned',
        cls: 's', onGrid: true, slots: [{ day: 1, start: 14.5, end: 15.5 }],
        ref: 'BFSU Vol 1 — Building Foundations of Scientific Understanding',
        terms: [
          { name: 'Semester 1', start: '2026-09-01', end: '2027-01-31' },
          { name: 'Semester 2', start: '2027-02-08', end: '2027-06-30' },
        ],
        note: 'Not enrolled yet. Tue 2:30-3:30 clashes with Miss Hala Tue 2-3.',
        chain: [],
      },
      {
        id: 'jj', name: 'Jiu Jitsu', type: 'target', status: 'planned',
        cls: 'j', onGrid: true, slots: [], target: 20,
        note: 'Not enrolled yet — target 20/yr is a default, adjust on enrollment',
        chain: [],
      },
      { id: 'history', name: 'History', type: 'paced', status: 'parked',
        cls: 'j', onGrid: false, note: 'Revisit ~Sept 2027', chain: [] },
    ],
    overrides: [],
    log: [{ date: '2026-08-16', activityId: 'loe', curriculum: 'loe-c', session: 20, status: 'done' }],
  };
}
```

- [ ] **Step 4: Create `js/plan/state.js`**

```js
// Planner store + persistence. Mirrors ../state.js philosophy.
// localStorage 'aoife_plan_v1'; KV via /api/plan-get + /api/plan-save.
import { sanitizePlan, serializePlan, currentCur, todayStr, addDays, mondayOf } from './model.js';
import { seedPlan } from './seed.js';

const PK = 'aoife_plan_v1';

export const plan = { data: null };

let dirty = false;
const listeners = new Set();
export const onPlanChange = fn => listeners.add(fn);
export const planNotify = () => listeners.forEach(fn => fn());

export function initPlan() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PK)); } catch (e) {}
  plan.data = saved ? sanitizePlan(saved) : seedPlan();
}

export async function fetchPlanRemote() {
  try {
    const res = await fetch('/api/plan-get');
    const data = await res.json();
    if (!dirty && data && !data.error) {
      plan.data = sanitizePlan(data);
      planNotify();
    } else if (!dirty && data && data.error === 'empty') {
      savePlan();                    // first run: publish the seed to KV
    }
  } catch (e) {}
}

export function savePlan() {
  dirty = true;
  plan.data.savedAt = new Date().toISOString();
  const str = serializePlan(plan.data);
  try { localStorage.setItem(PK, str); } catch (e) {}
  fetch('/api/plan-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: str }),
  }).catch(() => {});
  try { document.dispatchEvent(new CustomEvent('aoife:saved')); } catch (e) {}
}

const commit = () => { planNotify(); savePlan(); };

export const getActivity = id => plan.data.activities.find(a => a.id === id);

// Toggle a paced activity's "did it today" check. Checking advances the chain;
// unchecking the same day rolls it back (mis-tap fix).
// INVARIANT: check → uncheck is the identity in every state, including an
// exhausted chain. That holds because the log entry records WHICH curriculum
// was advanced, and the uncheck decrements exactly that one — never "the last
// curriculum with progress". currentCur() only returns a curriculum that can
// still advance (done < sessionsCount, and sessionsCount > 0), so when it is
// null nothing advances and the entry is written without a `curriculum` field,
// making the uncheck a pure log splice.
export function togglePaced(actId, date = todayStr()) {
  const act = getActivity(actId);
  if (!act) return;
  const i = plan.data.log.findIndex(e =>
    e.activityId === actId && e.date === date && e.status === 'done' && !e.eventId);
  if (i >= 0) {
    const entry = plan.data.log[i];
    plan.data.log.splice(i, 1);
    if (entry.curriculum) {
      const cur = (act.chain || []).find(c => c.id === entry.curriculum);
      if (cur && (cur.done || 0) > 0) cur.done--;
    }
  } else {
    const cur = currentCur(act);
    plan.data.log.push({ date, activityId: actId, status: 'done',
      ...(cur ? { curriculum: cur.id, session: cur.done || 0 } : {}) });
    if (cur) cur.done = (cur.done || 0) + 1;
  }
  commit();
}

// Log a timed block (template event or planner slot) for a date: done|partial|missed.
// Tapping the same status again clears it.
export function logTimed(eventId, activityId, status, date = todayStr()) {
  const match = e => e.date === date &&
    (eventId ? e.eventId === eventId : e.activityId === activityId && e.timed);
  const i = plan.data.log.findIndex(match);
  if (i >= 0 && plan.data.log[i].status === status) plan.data.log.splice(i, 1);
  else if (i >= 0) plan.data.log[i].status = status;
  else plan.data.log.push({ date, status, timed: true,
    ...(eventId ? { eventId } : {}), ...(activityId ? { activityId } : {}) });
  commit();
}

export function setWeekType(monday, type, label) {
  const k = mondayOf(monday);
  if (!type || type === 'teaching') delete plan.data.weeks[k];
  else plan.data.weeks[k] = { type, ...(label ? { label } : {}) };
  commit();
}

export function setActivityStatus(id, status) {
  const act = getActivity(id);
  if (act) { act.status = status; commit(); }
}

export function setTravelMode(id, mode) {
  const act = getActivity(id);
  if (act) { act.travel = mode === 'reduced' ? { mode, factor: 0.5 } : { mode }; commit(); }
}

export function flipAnchor() {
  const pc = plan.data.parentCycle;
  pc.anchorMonday = addDays(pc.anchorMonday, 7);
  pc.confirmed = true;
  commit();
}

export function addOverride(o) { plan.data.overrides.push(o); commit(); }
export function removeOverride(idx) { plan.data.overrides.splice(idx, 1); commit(); }
```

- [ ] **Step 5: Run tests — all pass**

Run: `node --test 2>&1 | tail -3`
Expected: 0 fail.

- [ ] **Step 6: Commit**

```bash
git add js/plan/seed.js js/plan/state.js tests/plan-state.test.mjs
git commit -m "feat(planner): seed data (honest 2026-08-16 state) + plan store/mutations"
```

---

### Task 5: Tabs, tokens, plan.css shell, boot wiring [Sonnet]

**Files:**
- Create: `js/plan/tabs.js`
- Create: `css/plan.css`
- Modify: `css/tokens.css` (append only)
- Modify: `index.html` (three additive edits)
- Modify: `js/main.js` (two additive lines)

- [ ] **Step 1: Append planner category tokens to `css/tokens.css`**

Append at end of file:

```css
/* Planner-only category tokens (geography teal, science blue, jiu-jitsu steel).
   The six template categories above are the v1 contract — these are additive. */
html[data-theme='dark'] .g  { --eb: #0B3A34; --el: #2BB3A0; --et: #A8E6DC; }
html[data-theme='dark'] .s  { --eb: #051E38; --el: #378ADD; --et: #B5D4F4; }
html[data-theme='dark'] .j  { --eb: #23262F; --el: #8A93A8; --et: #D4D9E4; }
html[data-theme='light'] .g { --eb: #D2F0EC; --el: #0E7C6E; --et: #073F38; }
html[data-theme='light'] .s { --eb: #D8E8FA; --el: #1D66B0; --et: #093159; }
html[data-theme='light'] .j { --eb: #E5E7EE; --el: #5B6478; --et: #262C3A; }
html[data-theme='dark']  { --ok: #4ade80; --ok-bg: #0d3320; --warn: #fbbf24; --warn-bg: #38290a; }
html[data-theme='light'] { --ok: #16a34a; --ok-bg: #dcfce7; --warn: #b45309; --warn-bg: #fef3c7; }
```

- [ ] **Step 2: Edit `index.html` — stylesheet, tab bar, view containers, boot**

Edit A — after the `css/app.css` link line, add:

```html
<link rel="stylesheet" href="css/plan.css">
```

Edit B — immediately after the closing `</header>` tag, add:

```html
  <nav id="ptabs" class="no-print" aria-label="Planner views"></nav>
```

Edit C — immediately after the `<div class="grid-outer">...</div>` line, add:

```html
  <div id="view-today" class="pview no-print"></div>
  <div id="view-year" class="pview no-print"></div>
  <div id="view-subjects" class="pview no-print"></div>
```

- [ ] **Step 3: Create `js/plan/tabs.js`**

```js
// Planner tab navigation. The Week tab shows the untouched v2 app; other tabs
// hide the schedule chrome and show a planner view. Print safety is guaranteed
// by plan.css's own @media print block (hide planner UI, force .grid-outer
// visible), not by .no-print alone — so printing from any tab yields the week grid.
import { initPlan, fetchPlanRemote, onPlanChange } from './state.js';
import { onChange } from '../state.js';
import { renderToday } from './today.js';
import { renderYear } from './year.js';
import { renderSubjects } from './subjects.js';

const TK = 'aoife_ptab';
const TABS = [
  ['today', 'Today'], ['week', 'Week'], ['year', 'Year'], ['subjects', 'Subjects'],
];

let tab = 'week';

function setTab(t) {
  tab = t;
  try { localStorage.setItem(TK, t); } catch (e) {}
  document.getElementById('app').dataset.ptab = t;
  renderTabs();
  renderViews();
}

function renderTabs() {
  document.getElementById('ptabs').innerHTML = TABS.map(([k, label]) =>
    `<button type="button" class="ptab${k === tab ? ' on' : ''}" data-tab="${k}">${label}</button>`
  ).join('');
}

function renderViews() {
  if (tab === 'today') renderToday();
  else if (tab === 'year') renderYear();
  else if (tab === 'subjects') renderSubjects();
}

export function initPlanner() {
  initPlan();
  let t = null;
  try { t = localStorage.getItem(TK); } catch (e) {}
  if (!t) t = matchMedia('(max-width: 699px)').matches ? 'today' : 'week';
  document.getElementById('ptabs').addEventListener('click', e => {
    const b = e.target.closest('.ptab');
    if (b) setTab(b.dataset.tab);
  });
  onPlanChange(renderViews);
  onChange(renderViews);            // template changes re-render planner views too
  setTab(t);
  fetchPlanRemote();
}
```

- [ ] **Step 4: Create `css/plan.css`** (shell now; view styles arrive with their views)

```css
/* Planner styles. Reuses tokens.css variables; never overrides schedule rules.
   Print safety is guaranteed by this file's own @media print block (hide the
   planner UI, force .grid-outer visible), NOT by .no-print alone — print.css
   stays frozen and its low-specificity .grid-outer rule cannot beat the
   per-tab hide rules below. */

/* ── Tabs ── */
#ptabs { display: flex; gap: 4px; margin-bottom: 10px; background: var(--bg-panel);
         border: 1px solid var(--border); border-radius: 10px; padding: 3px; max-width: 420px; }
.ptab { flex: 1; border: none; background: transparent; color: var(--text-sub);
        font-size: 12px; padding: 7px 0; border-radius: 7px; }
.ptab.on { background: var(--bg-input); color: var(--text); font-weight: 600; box-shadow: var(--shadow); }

/* ── View switching: week tab shows the classic app; others hide it ── */
.pview { display: none; }
#app[data-ptab='today'] #view-today,
#app[data-ptab='year'] #view-year,
#app[data-ptab='subjects'] #view-subjects { display: block; max-width: 560px; }
/* Fail-OPEN: the hide rules are enumerated positively, one per planner tab.
   If the planner JS never runs, #app carries no data-ptab and NOTHING here
   matches — the classic schedule stays fully visible. Never use
   #app:not([data-ptab='week']) here: that fails closed (blank page). */
#app[data-ptab='today'] .grid-outer, #app[data-ptab='year'] .grid-outer, #app[data-ptab='subjects'] .grid-outer,
#app[data-ptab='today'] .mobilebar, #app[data-ptab='year'] .mobilebar, #app[data-ptab='subjects'] .mobilebar,
#app[data-ptab='today'] .dayview, #app[data-ptab='year'] .dayview, #app[data-ptab='subjects'] .dayview,
#app[data-ptab='today'] .legend, #app[data-ptab='year'] .legend, #app[data-ptab='subjects'] .legend,
#app[data-ptab='today'] .hint, #app[data-ptab='year'] .hint, #app[data-ptab='subjects'] .hint,
#app[data-ptab='today'] .controls .ctl-label, #app[data-ptab='year'] .controls .ctl-label, #app[data-ptab='subjects'] .controls .ctl-label,
#app[data-ptab='today'] #sun-btn, #app[data-ptab='year'] #sun-btn, #app[data-ptab='subjects'] #sun-btn,
#app[data-ptab='today'] #add-btn, #app[data-ptab='year'] #add-btn, #app[data-ptab='subjects'] #add-btn,
#app[data-ptab='today'] #reset-btn, #app[data-ptab='year'] #reset-btn, #app[data-ptab='subjects'] #reset-btn,
#app[data-ptab='today'] #editor, #app[data-ptab='year'] #editor, #app[data-ptab='subjects'] #editor { display: none !important; }

@media (max-width: 699px) {
  #ptabs { position: fixed; left: 10px; right: 10px; max-width: none;
           bottom: calc(8px + env(safe-area-inset-bottom)); z-index: 60; box-shadow: var(--shadow); }
  .ptab { padding: 10px 0; font-size: 12.5px; }
  body { padding-bottom: calc(64px + env(safe-area-inset-bottom)); }
}

/* Print safety lives HERE, not in print.css. The tab hide rules above carry
   #app + [data-ptab] specificity, so print.css's plain `.grid-outer` rule can
   never out-rank them (specificity beats source order among !important decls).
   These selectors match that specificity and come later in this file, so the
   week grid is forced back on whichever planner tab is open. */
@media print {
  #ptabs, .pview { display: none !important; }
  #app[data-ptab='today'] .grid-outer,
  #app[data-ptab='year'] .grid-outer,
  #app[data-ptab='subjects'] .grid-outer { display: block !important; }
}

/* ── Shared planner bits ── */
.pcard { background: var(--bg-panel); border: 1px solid var(--border);
         border-radius: var(--radius); box-shadow: var(--shadow); padding: 12px 14px; margin-bottom: 10px; }
.phead { font-size: 15px; font-weight: 700; letter-spacing: -.01em; }
.pmeta { font-size: 11.5px; color: var(--text-sub); margin-top: 2px;
         display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.pchip { font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 99px;
         background: var(--bg-input); color: var(--text-sub); }
.pchip.warn { background: var(--warn-bg); color: var(--warn); }
.pchip.ok { background: var(--ok-bg); color: var(--ok); }
.psec { font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase;
        color: var(--text-muted); font-weight: 700; margin: 12px 2px 6px; }
```

- [ ] **Step 5: Wire boot in `js/main.js`**

Add import after the `initPrint` import line:

```js
import { initPlanner } from './plan/tabs.js';
```

Add init call on its own line immediately after `initPrint();`:

```js
initPlanner();
```

- [ ] **Step 6: Stub the three views so the module graph resolves**

Views arrive in Tasks 6–8. Create minimal real files now:

`js/plan/today.js`: `export function renderToday() {}`
`js/plan/year.js`: `export function renderYear() {}`
`js/plan/subjects.js`: `export function renderSubjects() {}`

(Replaced wholesale by their tasks — no placeholders shipped to users because
tabs render empty containers until then; Week remains default on desktop.)

- [ ] **Step 7: Verify locally + run tests**

Run: `python3 -m http.server 8080` then open http://localhost:8080 —
tab bar renders; Week tab is pixel-identical to before; Today/Year/Subjects show
empty views. PRINT CHECK — do it the strict way: **switch to the Today tab, then
print — the full week grid must still appear** (printing from the Week tab
proves nothing; the C1 regression only shows on a planner tab). Repeat from Year
and Subjects. Also confirm fail-open: strip `data-ptab` off `#app` in devtools →
the classic schedule must still be visible on screen.
Run: `node --test 2>&1 | tail -3` → 0 fail.

- [ ] **Step 8: Commit**

```bash
git add js/plan/tabs.js js/plan/today.js js/plan/year.js js/plan/subjects.js css/plan.css css/tokens.css index.html js/main.js
git commit -m "feat(planner): tab navigation shell, planner tokens, boot wiring"
```

---

### Task 6: Today view [Opus]

**Files:**
- Replace: `js/plan/today.js`
- Modify: `css/plan.css` (append)

- [ ] **Step 1: Replace `js/plan/today.js`**

```js
// Today view: date header, timed blocks for the real date (template + planner
// slots + overrides), one-tap statuses, daily no-slot checklist, tomorrow strip.
import { DAYS, fmt, esc, CATS } from '../model.js';
import { store, catLabel, evLabel } from '../state.js';
import {
  todayStr, addDays, dayIdx, mondayOf, weekType, isOnWeek, nextSession,
  currentCur, cycleStats, doneOn, actTotal,
} from './model.js';
import { plan, togglePaced, logTimed } from './state.js';

const ST = [['done', '✓ Done'], ['partial', '◐ Didn’t finish'], ['missed', '✗ Missed']];

// `cls` lands unescaped in a class attribute, so it is whitelisted, not escaped.
const CLS = new Set(['q', 'r', 'h', 'b', 'a', 'ot', 'g', 's', 'j']);
const okCls = x => (CLS.has(x) ? x : 'ot');

function timedFor(dateStr) {
  const d = dayIdx(dateStr);
  const items = [];
  for (const ev of store.events.filter(e => e.day === d))
    items.push({ key: `ev:${ev.id}`, eventId: ev.id, cls: okCls(CATS[ev.cat]?.cls),
                 name: evLabel(ev) || catLabel(ev.cat), start: ev.start, end: ev.end, note: ev.note });
  for (const a of plan.data.activities.filter(a => a.status === 'active' && a.onGrid))
    for (const s of a.slots || [])
      if (s.day === d) {
        const cur = currentCur(a);
        items.push({ key: `act:${a.id}`, activityId: a.id, cls: okCls(a.cls),
                     name: a.name, start: s.start, end: s.end,
                     note: cur && nextSession(cur) ? nextSession(cur).label : '' });
      }
  for (const [i, o] of plan.data.overrides.entries())
    if (o.date === dateStr && o.action === 'add') {
      const a = plan.data.activities.find(x => x.id === o.activityId);
      items.push({ key: `ov:${i}`, activityId: o.activityId, cls: okCls(a?.cls),
                   name: (a?.name || 'Extra') + ' · makeup', start: o.start, end: o.end, note: o.note || '' });
    }
  const skips = new Set(plan.data.overrides
    .filter(o => o.date === dateStr && o.action === 'skip')
    .map(o => o.eventId || `act:${o.activityId}`));
  return items.filter(it => !skips.has(it.eventId) && !skips.has(it.key))
    .sort((a, b) => a.start - b.start);
}

const statusOf = (dateStr, it) => plan.data.log.find(e => e.date === dateStr &&
  (it.eventId ? e.eventId === it.eventId : e.activityId === it.activityId && e.timed))?.status;

function chips(dateStr) {
  const p = plan.data;
  const wt = weekType(p.weeks, dateStr);
  const wkLabel = p.weeks[mondayOf(dateStr)]?.label;
  const c = [];
  c.push(`<span class="pchip">${wt === 'teaching' ? 'Teaching week' : esc((wkLabel || wt) + ' week')}</span>`);
  if (p.activities.some(a => a.status === 'active' && a.rhythm?.kind === 'cycle'))
    c.push(`<span class="pchip">${isOnWeek(p.parentCycle, dateStr) ? 'Mama work week' : 'Mama home week'}${p.parentCycle.confirmed ? '' : ' ?'}</span>`);
  const next = Object.keys(p.weeks).filter(k => k > dateStr && p.weeks[k].type === 'travel').sort()[0];
  if (next) c.push(`<span class="pchip">✈ ${esc(p.weeks[next].label || 'travel')} in ${Math.max(1, Math.round((new Date(next) - new Date(dateStr)) / 604800000))} wks</span>`);
  return c.join('');
}

export function renderToday() {
  const el = document.getElementById('view-today');
  if (!el || !plan.data) return;
  const today = todayStr();
  const d = new Date();
  const items = timedFor(today);

  let h = `<div class="pcard"><div class="phead">${DAYS[dayIdx(today)]}, ${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</div><div class="pmeta">${chips(today)}</div></div>`;

  for (const it of items) {
    const st = statusOf(today, it);
    h += `<div class="tblock ${it.cls}${st ? ' st-' + st : ''}" data-key="${esc(it.key)}">
      <div class="trow"><span class="tnm">${esc(it.name)}</span><span class="ttm">${fmt(it.start)}–${fmt(it.end)}</span></div>
      ${it.note ? `<div class="tnote">${esc(it.note)}</div>` : ''}
      <div class="tbtns">${ST.map(([k, lbl]) =>
        `<button type="button" class="tbtn${st === k ? ' sel' : ''}" data-st="${k}">${lbl}</button>`).join('')}</div>
    </div>`;
  }
  if (!items.length) h += `<div class="pcard pmeta">No scheduled blocks today.</div>`;

  const dailies = plan.data.activities.filter(a => a.status === 'active' && a.type === 'paced' && !a.onGrid);
  if (dailies.length) {
    h += `<div class="psec">Daily · no time slot</div>`;
    for (const a of dailies) {
      const done = doneOn(plan.data.log, a.id, today);
      const cur = currentCur(a);
      const ns = cur ? nextSession(cur) : null;
      let sub = '';
      if (a.rhythm?.kind === 'cycle') {
        const cs = cycleStats(a, today, plan.data.parentCycle, plan.data.log);
        sub = `this cycle: ${cs.done} of ${cs.targetMin}–${cs.targetMax}${cs.prevBehind ? ' · last cycle short' : ''}`;
      } else if (a.rhythm?.kind === 'daily') sub = actTotal(a) === 0 ? esc(a.note || '') : 'every day';
      h += `<div class="drow${done ? ' ck' : ''}" data-act="${esc(a.id)}">
        <span class="dbx">${done ? '✓' : ''}</span>
        <span class="dtx">${esc(a.name)}${ns ? ` — ${esc(cur.name ? cur.name + ' · ' : '')}${esc(ns.label)}` : ''}
        ${sub ? `<small>${sub}</small>` : ''}</span></div>`;
    }
  }

  const tmw = timedFor(addDays(today, 1));
  if (tmw.length) h += `<div class="tmwrow">Tomorrow: ${tmw.map(t => `${esc(t.name)} ${fmt(t.start)}`).join(' · ')}</div>`;

  el.innerHTML = h;
  el.querySelectorAll('.tbtn').forEach(b => b.addEventListener('click', e => {
    const block = e.target.closest('.tblock');
    const key = block.dataset.key;
    const it = items.find(x => x.key === key);
    logTimed(it.eventId || null, it.activityId || null, b.dataset.st);
  }));
  el.querySelectorAll('.drow').forEach(r =>
    r.addEventListener('click', () => togglePaced(r.dataset.act)));
}
```

- [ ] **Step 2: Append Today styles to `css/plan.css`**

```css
/* ── Today ── */
.tblock { border: 1px solid var(--border); border-left: 3px solid var(--el, var(--border));
          background: var(--eb, var(--bg-panel)); color: var(--et, var(--text));
          border-radius: 10px; padding: 9px 12px; margin-bottom: 8px; }
.trow { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.tnm { font-weight: 700; font-size: 13.5px; }
.ttm { font-size: 11.5px; font-variant-numeric: tabular-nums; opacity: .8; white-space: nowrap; }
.tnote { font-size: 11.5px; opacity: .9; margin-top: 2px; }
.tbtns { display: flex; gap: 6px; margin-top: 9px; }
.tbtn { flex: 1; font-size: 11.5px; font-weight: 600; padding: 6px 2px; border-radius: 8px;
        border: 1px solid var(--border); background: var(--bg-panel); color: var(--text-sub); }
.tbtn.sel { border-color: var(--el); color: var(--et); background: transparent; font-weight: 700; }
.tblock.st-done .tbtns .tbtn:not(.sel) { opacity: .45; }
.drow { display: flex; align-items: center; gap: 10px; background: var(--bg-panel);
        border: 1px solid var(--border); border-radius: 10px; padding: 9px 12px;
        margin-bottom: 6px; cursor: pointer; user-select: none; }
.dbx { width: 18px; height: 18px; border: 1.5px solid var(--text-muted); border-radius: 5px;
       flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
       font-size: 12px; color: #fff; }
.drow.ck .dbx { background: var(--ok); border-color: var(--ok); }
.dtx { font-size: 12.5px; }
.dtx small { display: block; color: var(--text-muted); font-size: 10.5px; }
.tmwrow { border-top: 1px solid var(--line); margin-top: 10px; padding-top: 8px;
          font-size: 11px; color: var(--text-muted); }
```

- [ ] **Step 3: Verify locally**

`python3 -m http.server 8080` → Today tab shows the real current day's template
blocks, tapping ✓ marks + persists to localStorage (KV fetch fails locally by
design); LoE row shows "Lesson 102" with cycle line; tapping it checks/unchecks
and Lesson number advances/rolls back **to exactly where it started**. Week tab
unchanged. PRINT CHECK the strict way: **switch to the Today tab, then print —
the full week grid must still appear.**
Run: `node --test 2>&1 | tail -3` → 0 fail.

- [ ] **Step 4: Commit**

```bash
git add js/plan/today.js css/plan.css
git commit -m "feat(planner): Today view — timed statuses, daily checklist, tomorrow strip"
```

---

### Task 7: Subjects view [Sonnet]

**Files:**
- Replace: `js/plan/subjects.js`
- Modify: `css/plan.css` (append)

- [ ] **Step 1: Replace `js/plan/subjects.js`**

```js
// Subjects view: one card per activity — progress, pace, controls.
import { esc } from '../model.js';
import { catLabel } from '../state.js';
import {
  todayStr, actTotal, actDone, currentCur, nextSession,
  projectFinish, requiredPerCycle, targetStats,
} from './model.js';
import { plan, setActivityStatus, setTravelMode } from './state.js';

const fmtDate = s => new Date(s + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });

function paceLine(a) {
  const p = plan.data, today = todayStr();
  if (a.type === 'target') {
    const st = targetStats(a, p, p.log, today);
    return st.behind > 0
      ? `<span class="pchip warn">${st.done}/${st.target} · ${st.behind} behind</span>`
      : `<span class="pchip ok">${st.done}/${st.target} on pace</span>`;
  }
  if (a.type !== 'paced' || a.status !== 'active') return '';
  if (actTotal(a) === 0) return `<span class="pchip">counts pending</span>`;
  const fin = projectFinish(a, today, p);
  if (!fin) return '';
  if (fin.done) return `<span class="pchip ok">finished 🎉</span>`;
  let out = `<span class="pchip">→ ${fmtDate(fin.date)}</span>`;
  if (a.goal?.finishBy) {
    const slackW = Math.round((new Date(a.goal.finishBy) - new Date(fin.date)) / 604800000);
    out += slackW >= 0
      ? `<span class="pchip ok">${slackW} wks ahead of goal</span>`
      : `<span class="pchip warn">${-slackW} wks past goal</span>`;
    const need = requiredPerCycle(a, today, p);
    if (need != null) out += `<span class="pchip">need ${need.toFixed(1)}/cycle</span>`;
  }
  return out;
}

function card(a) {
  const name = a.name || catLabel(a.cat);
  const total = actTotal(a), done = actDone(a);
  const cur = currentCur(a), ns = cur ? nextSession(cur) : null;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const stChip = { planned: 'Planned', parked: 'Parked', cancelled: 'Cancelled', done: 'Done' }[a.status];
  let h = `<div class="pcard scard ${a.cls || ''}${a.status !== 'active' ? ' dim' : ''}" data-id="${esc(a.id)}">
    <div class="trow"><span class="tnm"><i class="sdot"></i>${esc(name)}</span>
      <span class="smeta">${stChip ? `<span class="pchip">${stChip}</span>` : paceLine(a)}</span></div>`;
  if (a.type === 'paced' && total > 0)
    h += `<div class="sline">${done}/${total}${ns ? ` · next: ${esc(ns.label)}` : ''}</div>
          <div class="sbar"><i style="width:${pct}%"></i></div>`;
  if (a.note) h += `<div class="sline">${esc(a.note)}</div>`;
  h += `<details class="sdet"><summary>Manage</summary><div class="sctl">`;
  if (a.status === 'planned') h += `<button data-do="activate">Activate</button>`;
  if (a.status === 'active') h += `<button data-do="park">Park</button>`;
  if (a.status === 'parked') h += `<button data-do="activate">Un-park</button>`;
  if (a.status !== 'cancelled') h += `<button data-do="cancel" class="danger-btn">Cancel</button>`;
  else h += `<button data-do="activate">Restore</button>`;
  if (a.type === 'paced')
    h += `<label class="sctl-l">Travel: <select data-do="travel">
      ${['pause', 'reduced', 'continue'].map(m =>
        `<option value="${m}"${(a.travel?.mode || 'pause') === m ? ' selected' : ''}>${m}</option>`).join('')}
      </select></label>`;
  h += `</div></details></div>`;
  return h;
}

export function renderSubjects() {
  const el = document.getElementById('view-subjects');
  if (!el || !plan.data) return;
  const order = { active: 0, planned: 1, parked: 2, done: 3, cancelled: 4 };
  const acts = [...plan.data.activities].sort((x, y) =>
    (order[x.status] ?? 9) - (order[y.status] ?? 9));
  el.innerHTML = acts.map(card).join('');
  el.querySelectorAll('[data-do]').forEach(b => {
    const id = b.closest('.scard').dataset.id;
    if (b.dataset.do === 'travel')
      b.addEventListener('change', () => setTravelMode(id, b.value));
    else b.addEventListener('click', () => {
      const map = { activate: 'active', park: 'parked', cancel: 'cancelled' };
      if (b.dataset.do === 'cancel' && !confirm('Cancel this activity? History is kept.')) return;
      setActivityStatus(id, map[b.dataset.do]);
    });
  });
}
```

- [ ] **Step 2: Append Subjects styles to `css/plan.css`**

```css
/* ── Subjects ── */
.scard.dim { opacity: .65; }
.sdot { display: inline-block; width: 9px; height: 9px; border-radius: 99px;
        background: var(--el, var(--border)); margin-right: 7px; }
.smeta { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.sline { font-size: 11.5px; color: var(--text-sub); margin-top: 4px; }
.sbar { height: 5px; border-radius: 4px; background: var(--eb, var(--bg-input));
        margin-top: 7px; position: relative; overflow: hidden; }
.sbar i { position: absolute; inset: 0 auto 0 0; background: var(--el, var(--accent-soft)); border-radius: 4px; }
.sdet { margin-top: 8px; }
.sdet summary { font-size: 11px; color: var(--text-muted); cursor: pointer; }
.sctl { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; align-items: center; }
.sctl-l { font-size: 11px; color: var(--text-sub); display: flex; gap: 5px; align-items: center; margin: 0; }
.sctl-l select { width: auto; font-size: 12px; padding: 4px 6px; }
```

- [ ] **Step 3: Verify locally + tests**

Subjects tab lists 11 activities in status order; LoE card shows `21/60 · next:
Lesson 102`, a finish-date chip, "wks ahead of goal," and `need N/cycle`; Manage
controls work and persist. Run: `node --test 2>&1 | tail -3` → 0 fail.

- [ ] **Step 4: Commit**

```bash
git add js/plan/subjects.js css/plan.css
git commit -m "feat(planner): Subjects view — progress, projections, manage controls"
```

---

### Task 8: Year view [Opus]

**Files:**
- Replace: `js/plan/year.js`
- Modify: `css/plan.css` (append)

- [ ] **Step 1: Replace `js/plan/year.js`**

```js
// Year view: per-activity 52-week tracks + week marking + cycle anchor flip.
import { esc } from '../model.js';
import {
  todayStr, addDays, mondayOf, weeksBetween, weekType, weekCapacity,
  actTotal, actDone, projectFinish,
} from './model.js';
import { plan, setWeekType, flipAnchor } from './state.js';

const fmtDate = s => new Date(s + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const CYCLE_NEXT = { teaching: 'travel', travel: 'off', off: 'light', light: 'teaching' };

function yearWeeks() {
  const { start, end } = plan.data.year;
  const out = [];
  let w = mondayOf(start);
  while (w <= end) { out.push(w); w = addDays(w, 7); }
  return out;
}

function trackFor(a, wks, today) {
  const p = plan.data;
  let remainingDone = actDone(a);
  const total = actTotal(a);
  let cells = '';
  for (const w of wks) {
    const wt = weekType(p.weeks, w);
    let cls = '';
    if (wt === 'travel') cls = 'trip';
    else if (wt === 'off') cls = 'offw';
    else if (a.type === 'paced' && a.status === 'active' && total > 0) {
      const cap = weekCapacity(a, w, p.weeks, p.parentCycle);
      if (w <= mondayOf(today) && remainingDone > 0) { cls = 'fill'; remainingDone -= cap; }
      else if (cap > 0) cls = 'plan';
    } else if (a.status === 'active' && wt !== 'off') cls = w <= mondayOf(today) ? 'fill' : 'plan';
    cells += `<i class="${cls}" data-w="${w}"></i>`;
  }
  const fin = a.type === 'paced' && a.status === 'active' && total > 0
    ? projectFinish(a, today, p) : null;
  const sub = fin && !fin.done ? `→ ${fmtDate(fin.date)}` : a.status !== 'active' ? a.status : '';
  return `<div class="track ${a.cls || ''}"><div class="tl"><b>${esc(a.name || a.id)}</b><small>${esc(sub)}</small></div>
    <div class="tgrid" style="--n:${wks.length}">${cells}</div></div>`;
}

export function renderYear() {
  const el = document.getElementById('view-year');
  if (!el || !plan.data) return;
  const p = plan.data, today = todayStr(), wks = yearWeeks();
  const todayPct = Math.min(100, Math.max(0,
    (weeksBetween(wks[0], today) + 0.5) / wks.length * 100));

  const rows = p.activities.filter(a =>
    ['paced', 'target', 'external'].includes(a.type) && !['cancelled'].includes(a.status));
  const core = { id: 'core', name: 'Core — ELA·Math·Arabic·Quran', cls: 'r', type: 'ongoing', status: 'active' };

  let h = `<div class="pcard"><div class="phead">${esc(p.year.label)} · year-round</div>
    <div class="pmeta"><span class="pchip">tap a week to cycle: teaching → travel → off → light</span></div></div>
    <div class="pcard ytracks" style="--tp:${todayPct}">`;   // UNITLESS — plan.css does the /100 and the % itself
  for (const a of [...rows, core]) h += trackFor(a, wks, today);
  h += `<div class="yaxis">${['S','O','N','D','J','F','M','A','M','J','J','A'].map(m => `<span>${m}</span>`).join('')}</div></div>`;

  const pc = p.parentCycle;
  h += `<div class="pcard"><div class="pmeta">7-on/7-off anchor: week of ${fmtDate(pc.anchorMonday)} = work week${pc.confirmed ? '' : ' (unconfirmed guess)'}
    <button type="button" id="yflip">Flip work/home</button></div></div>`;

  el.innerHTML = h;
  el.querySelectorAll('.tgrid i').forEach(cell => cell.addEventListener('click', () => {
    const w = cell.dataset.w;
    const cur = weekType(p.weeks, w);
    const next = CYCLE_NEXT[cur];
    let label;
    if (next === 'travel') label = prompt('Label for this travel week? (e.g. Dhaka ✈)', p.weeks[w]?.label || '') || undefined;
    setWeekType(w, next === 'teaching' ? null : next, label);
  }));
  document.getElementById('yflip').addEventListener('click', flipAnchor);
}
```

- [ ] **Step 2: Append Year styles to `css/plan.css`**

```css
/* ── Year ── */
.ytracks { position: relative; }
.track { margin-bottom: 12px; }
.track .tl { display: flex; justify-content: space-between; align-items: baseline;
             font-size: 11.5px; margin-bottom: 4px; }
.track .tl b { font-size: 12px; }
.track .tl small { color: var(--text-muted); font-size: 10px; }
.tgrid { display: grid; grid-template-columns: repeat(var(--n, 52), 1fr); gap: 1px; }
.tgrid i { height: 14px; border-radius: 2px; background: var(--bg-input); cursor: pointer; }
.tgrid i.plan { background: var(--eb, var(--bg-input)); }
.tgrid i.fill { background: var(--el, var(--accent-soft)); }
.tgrid i.trip { background: repeating-linear-gradient(135deg, var(--border) 0 2px, transparent 2px 4px); }
.tgrid i.offw { background: transparent; border: 1px dashed var(--border); }
.ytracks::after { content: ''; position: absolute; top: 44px; bottom: 34px; left: calc(14px + (100% - 28px) * var(--tp) / 100);
                  border-left: 1.5px dashed var(--now); pointer-events: none; }
.yaxis { display: grid; grid-template-columns: repeat(12, 1fr); font-size: 9px;
         color: var(--text-muted); letter-spacing: .05em; margin-top: 4px; }
#yflip { font-size: 11px; padding: 4px 10px; }
```

- [ ] **Step 3: Verify locally + tests**

Year tab: tracks render; tapping a January week cycles it to travel (prompt for
label) and the LoE/geography finish chips move later; today-line sits near the
left edge (August). Flip button toggles the work/home chips on Today.
Run: `node --test 2>&1 | tail -3` → 0 fail.

- [ ] **Step 4: Commit**

```bash
git add js/plan/year.js css/plan.css
git commit -m "feat(planner): Year view — week tracks, week marking, anchor flip"
```

---

### Task 9: Week-grid overlay + clash banner [Opus]

**Files:**
- Create: `js/plan/overlay.js`
- Modify: `js/plan/tabs.js` (two lines)
- Modify: `css/plan.css` (append)

**Constraint recap:** `js/grid.js` is frozen. The overlay decorates the DOM that
`renderGrid()` produced, re-applying after every render via the same
`onChange`/`onPlanChange` hooks (which fire after main.js's render listener —
registration order in a Set is insertion order, and `initPlanner()` runs after
`onChange(render)` in main.js).

- [ ] **Step 1: Create `js/plan/overlay.js`**

```js
// Read-only decorations on the classic week grid: today-status dots and a
// clash banner. Never mutates events; only appends elements into rendered DOM.
import { todayIndex, fmt, esc, DAYS } from '../model.js';
import { store, catLabel } from '../state.js';
import { todayStr, findClashes } from './model.js';
import { plan } from './state.js';

export function applyOverlay() {
  if (!plan.data) return;
  const grid = document.getElementById('grid');
  if (!grid) return;
  grid.querySelectorAll('.ov-dot').forEach(n => n.remove());
  const today = todayStr();
  const tIdx = todayIndex(new Date().getDay());
  for (const e of plan.data.log) {
    if (e.date !== today || !e.eventId) continue;
    const ev = store.events.find(x => x.id === e.eventId);
    if (!ev || ev.day !== tIdx) continue;
    grid.querySelectorAll(`.evt[data-id="${e.eventId}"]`).forEach(el => {
      const d = document.createElement('span');
      d.className = `ov-dot ov-${e.status}`;
      d.textContent = e.status === 'done' ? '✓' : e.status === 'partial' ? '◐' : '✗';
      el.appendChild(d);
    });
  }
  renderClashBanner();
}

function renderClashBanner() {
  let bar = document.getElementById('ov-clash');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'ov-clash';
    bar.className = 'no-print';
    const outer = document.querySelector('.grid-outer');
    outer.parentNode.insertBefore(bar, outer);
  }
  const msgs = [];
  for (const a of plan.data.activities) {
    if (!['active', 'planned'].includes(a.status)) continue;
    for (const s of a.slots || []) {
      const hits = findClashes(store.events, s);
      for (const h of hits)
        msgs.push(`<b>⚠ ${esc(a.name)}</b> ${DAYS[s.day]} ${fmt(s.start)}–${fmt(s.end)} overlaps ${esc(h.name || catLabel(h.cat))} ${fmt(h.start)}–${fmt(h.end)}`);
    }
  }
  bar.innerHTML = msgs.length ? `<div class="ov-clash-in">${msgs.join('<br>')}</div>` : '';
}
```

- [ ] **Step 2: Wire into `js/plan/tabs.js`**

Add import: `import { applyOverlay } from './overlay.js';`
In `renderViews()`, add as the last line: `applyOverlay();`

- [ ] **Step 3: Append overlay styles to `css/plan.css`**

```css
/* ── Week-grid overlay ── */
.ov-dot { position: absolute; top: 3px; right: 4px; font-size: 9px; font-weight: 700;
          z-index: 6; pointer-events: none; color: var(--et); }
.ov-dot.ov-done { color: var(--ok); }
.ov-dot.ov-partial { color: var(--warn); }
.ov-dot.ov-missed { color: var(--danger-text); }
#ov-clash:empty { display: none; }
.ov-clash-in { background: var(--danger-bg); border: 1px solid var(--danger-border);
               color: var(--danger-text); border-radius: 9px; padding: 7px 10px;
               font-size: 11px; line-height: 1.4; margin-bottom: 8px; }
@media print { #ov-clash, .ov-dot { display: none !important; } }
```

- [ ] **Step 4: Verify + commit**

Local: mark today's Quran ✓ on Today tab → dot appears on the Week grid block;
activate Science in Subjects → red clash banner appears above the grid naming
Miss Hala's Tuesday block; print preview shows neither dots nor banner.
Run: `node --test 2>&1 | tail -3` → 0 fail.

```bash
git add js/plan/overlay.js js/plan/tabs.js css/plan.css
git commit -m "feat(planner): week-grid status dots + clash banner (read-only overlay)"
```

---

### Task 10: Nightly Drive backup + fleet registration [Sonnet]

**Files:**
- Create: `scripts/planner-backup.sh` (this repo)
- Create: `~/Library/LaunchAgents/com.jalal.aoife-planner-backup.plist` (Mac, not committed)
- Modify: github-notion-sync repo per ITS OWN AGENTS.md (CATALOG entry + fleet probe)

- [ ] **Step 1: Create `scripts/planner-backup.sh`**

```bash
#!/bin/bash
# Nightly snapshot of both aoifes-schedule KV blobs into Google Drive.
# Runs from launchd at 03:40 (overnight window per house convention).
set -u
DRIVE="$HOME/Library/CloudStorage/GoogleDrive-jalal.chowdhury@gmail.com/My Drive"
DEST="$DRIVE/Aoife Planner Backups"
mkdir -p "$DEST"
D=$(date +%F)
ok=1
for pair in "get:schedule" "plan-get:plan"; do
  ep="${pair%%:*}"; name="${pair##*:}"
  out="$DEST/$D-$name.json"
  if curl -sf --max-time 60 "https://aoifes-schedule.vercel.app/api/$ep" -o "$out" \
     && python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$out"; then
    :
  else
    ok=0; echo "PLANNER-BACKUP FAIL $D $name"
  fi
done
[ "$ok" = 1 ] && echo "PLANNER-BACKUP OK $D"
```

`chmod +x scripts/planner-backup.sh`

- [ ] **Step 2: Install the launchd job (03:40 daily, log to ~/Library/Logs)**

Write `~/Library/LaunchAgents/com.jalal.aoife-planner-backup.plist` with
ProgramArguments `/bin/bash <repo>/scripts/planner-backup.sh`, StartCalendarInterval
Hour 3 Minute 40, StandardOutPath/StandardErrorPath
`~/Library/Logs/aoife-planner-backup.log`. Then:
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jalal.aoife-planner-backup.plist`
and kickstart once to verify the log shows `PLANNER-BACKUP OK`.

- [ ] **Step 3: Register in the fleet (github-notion-sync repo)**

Read that repo's AGENTS.md first and follow its conventions exactly:
add a CATALOG entry in `schedule_snapshot.py` for the new launchd job, and a
fleet-health probe that (a) checks today's (or yesterday's, given 3:40 vs 5:00
run order) snapshot files exist in the Drive folder and parse as JSON, and
(b) log_greps `PLANNER-BACKUP OK` in `~/Library/Logs/aoife-planner-backup.log`.
Commit in that repo per its own rules.

- [ ] **Step 4: Commit (this repo)**

```bash
git add scripts/planner-backup.sh
git commit -m "ops(planner): nightly Drive snapshot script for both KV blobs"
```

---

### Task 11: Docs, AGENTS.md contract, ship [Sonnet]

**Files:**
- Modify: `AGENTS.md` (add planner sections)
- Modify: `docs/superpowers/plans/2026-08-16-aoife-planner.md` (check boxes)

- [ ] **Step 1: Update `AGENTS.md`**

Add to the architecture list: the `js/plan/*` files, `api/plan-get.js`/`plan-save.js`,
`css/plan.css`, `scripts/planner-backup.sh` (one line each, matching existing style).

Add a new section after "Data contract":

```markdown
## Planner data contract (additive — the section above is still frozen)
- KV key `aoife_plan` (+ `aoife_plan_prev` one-step undo, written by plan-save);
  localStorage `aoife_plan_v1`; same double-wrap POST convention as /api/save.
- Shape: {version, year, parentCycle{anchorMonday,confirmed}, weeks{monday:{type,label}},
  activities[{id,type,status,cls,onGrid,slots,rhythm,travel,goal,target,note,chain[
  {id,name,pattern:'simple'|'tb-wb',firstUnit,lastUnit,lessons,tests,done,titles}]}],
  overrides[{date,action,...}], log[{date,activityId|eventId,status,...}]}
- `sanitizePlan` (js/plan/model.js) drops malformed records on both load paths and
  preserves unknown fields (forward-compatible).
- Claude sessions may edit this blob directly via the endpoints (bulk-load
  curricula, replan trips, generate progress reports). Restore procedure:
  GET /api/plan-get?prev=1 (undo) or a dated file from Drive
  "Aoife Planner Backups", then POST it back via /api/plan-save.
- Rollback tags: v2-pre-planner (before any planner code), planner-p1..p4.
```

- [ ] **Step 2: Full verification pass**

```bash
node --test                      # all pass
git status --short               # no unexpected modifications to frozen files
python3 -m http.server 8080      # manual smoke: all 4 tabs + print preview
```

- [ ] **Step 3: Commit, tag, push, verify live**

```bash
git add AGENTS.md docs/superpowers/plans/2026-08-16-aoife-planner.md
git commit -m "docs(planner): AGENTS.md planner contract + restore/rollback procedures"
git tag planner-p4
git push origin main --tags
```

Then verify production: `curl -s https://aoifes-schedule.vercel.app/api/plan-get`
returns the seeded plan (or `empty` before first browser save); load the site,
check all tabs, mark a test status and confirm it round-trips, then un-mark it.

---

## Self-review checklist (run after writing, fixed inline)

- Spec coverage: types/rhythms/chains (§3, Tasks 1-2-4), views (§4, Tasks 5-8),
  data+API+undo (§5, Tasks 3-4), code layout (§6, file map), backups/rollback
  (§7, Tasks 10-11 + tags in 11), testing (§8, Tasks 1-2-4), phases (§9 →
  P1=1-6, P2=7, P3=8, P4=9-11). Grid-slot deviation from spec §3.8: planner
  activities' slots live in `aoife_plan` (activity.slots), NOT as new template
  cats — the 6-cat template enum stays pristine; noted in AGENTS.md contract.
- Placeholders: none — every code step is complete file/append content.
- Type consistency: `plan.data` shape used identically across state/views;
  `cls` keys match tokens (`q r h b a ot g s j`); log entry shapes match
  between `togglePaced`/`logTimed` (writers) and `statusOf`/`doneOn`/`cycleStats`
  (readers).

## Execution addendum (2026-08-17)

Everything above is the plan as executed for Tasks 1–9. These are the deltas
between the plan text and the code that actually shipped. The code blocks above
have already been patched to match; this list records *why*.

**Fixed during execution**

- **`year.js` `--tp` is unitless.** The plan wrote `style="--tp:${todayPct}%"`,
  but `plan.css` computes `left: calc(14px + (100% - 28px) * var(--tp) / 100)`.
  A `%` in the variable makes that `% / 100`, which is invalid and drops the
  today-line entirely. Shipped as `style="--tp:${todayPct}"`.

**Phase-1 code review fixes (single commit, this date)**

- **C2 — fail-open CSS (`css/plan.css`).** The hide block used
  `#app:not([data-ptab='week'])`, which matches when `#app` has *no*
  `data-ptab` at all. If the planner JS ever fails to load, that state is the
  default — so a broken planner blanked the whole schedule. Replaced with 30
  enumerated positive selectors (3 planner tabs × 10 targets). Verified: with
  no `data-ptab`, computed `.grid-outer` display is `block` (was `none`).

- **C1 — blank print from a non-Week tab (`css/plan.css`).** Among `!important`
  declarations, specificity beats source order, so `print.css`'s frozen
  `.grid-outer { display:block !important }` (0,1,0) could never beat the hide
  rules (1,2,0) — printing from Today/Year/Subjects produced a page with no
  grid. Fixed inside `plan.css`'s own `@media print` block with equal-specificity
  `#app[data-ptab='…'] .grid-outer { display:block !important }` placed later in
  the file. `css/print.css` stayed frozen. The false "print.css handles it via
  .no-print" comments in `plan.css` and `js/plan/tabs.js` were corrected.

- **I1 — uncheck corrupted progress (`js/plan/state.js`, `js/plan/seed.js`).**
  The uncheck branch decremented "the last curriculum with any progress" rather
  than the one the log entry recorded, so unchecking after a chain rollover
  stole a session from the wrong book; and the check branch recorded a
  `curriculum` even when the chain was exhausted and nothing advanced, so
  unchecking then drove a counter negative. Now the entry records the curriculum
  only when `currentCur()` actually advances, and the uncheck decrements exactly
  that id. Invariant: **check → uncheck is the identity in every state.** The
  seeded log entry moved from the stale `unit: 101` to
  `curriculum: 'loe-c', session: 20` to match what the writer emits.

- **I2 — infinite loops on malformed dates (`js/plan/model.js`).**
  `while (w <= act.goal.finishBy)` never terminates when `finishBy` is not an
  ISO date (every `'YYYY-MM-DD'` string sorts below `'zzz'`). `sanitizePlan` now
  ISO-validates `year.start`/`year.end`, `parentCycle.anchorMonday`, each
  activity's `goal.finishBy` (deleting an invalid `goal`), and every log/override
  date (dropping bad rows). `requiredPerCycle` and `targetStats` also carry a
  hard 600-iteration cap so an unsanitized, hand-built plan cannot hang the UI.

- **I3 — unescaped class token (`js/plan/today.js`, `js/plan/model.js`).**
  `cls` is interpolated raw into a `class="…"` attribute. It is now whitelisted
  against the nine known tokens (`q r h b a ot g s j`) on all three paths
  (template events, planner slots, overrides), falling back to `ot`. Related:
  `cycleStats` coerces `perOnWeek`/`perOffWeek` with `Number()` so a
  string-typed rhythm value can't turn the cycle target into `"1" + 2` = `"12"`.

- **I4 — mutation tests (`tests/plan-state.test.mjs`).** `state.js` had no test
  coverage because it touches `localStorage`/`fetch`/`document` at import time.
  The test file now stubs those three globals and then `await import()`s
  `state.js`, adding five tests: `togglePaced` invertibility mid-chain,
  decrement-the-logged-curriculum after a chain rollover, exhausted-chain
  round-trip, `sanitizePlan` date guards, and loop-cap termination.
  **28 → 33 tests, all passing under bare `node --test`.**

- **Polish.** Removed two unused imports from `js/plan/subjects.js`
  (`actRemaining`, `cycleStats`); the clash banner now says "Quran" instead of
  the raw cat key via `catLabel(h.cat)`; added the missing
  `.ov-dot.ov-partial { color: var(--warn); }` rule.

**Residual, deliberately not changed**

- `js/plan/subjects.js` and `js/plan/year.js` also interpolate `a.cls` into a
  class attribute. They are fed only from `plan.data.activities`, which no UI
  path lets a user author, so this is not reachable today — but if activity
  creation ever ships, route those through the same `okCls()` whitelist.
- `js/plan/year.js`'s `yearWeeks()` walks `while (w <= end)` without a cap. It
  reads `plan.data.year`, which `sanitizePlan` now guarantees is ISO on both
  load paths, so the cap would be dead code.
