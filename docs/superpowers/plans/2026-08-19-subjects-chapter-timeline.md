# Subjects Chapter Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-chapter "plan vs now" timeline inside each active paced subject card on the Subjects tab, with a frozen baseline snapshot for drift comparison.

**Architecture:** Three new pure functions in `js/plan/model.js` (row descriptors, per-row projected dates from the same week-walk as `projectFinish`, actual dates from the log); one small stored field `activity.baseline` guarded by `sanitizePlan` and written by a new `setBaseline` mutation in `js/plan/state.js`; one new `<details>` section per card in `js/plan/subjects.js` plus `.tl*` CSS.

**Tech Stack:** Vanilla ES modules, zero deps, `node --test` (bare — Node 24 breaks on a directory arg). Spec: `docs/superpowers/specs/2026-08-19-subjects-chapter-timeline-design.md`.

**Repo rules that bind every task** (AGENTS.md):
- No browser dialogs; destructive/overwriting actions are two-tap in-place (see `armedBtn` in subjects.js).
- All user text through `esc()`.
- No existing `js/plan/model.js` export may change semantics (bot parity, rule 4). Everything here is additive.
- Release requires bumping the `?v=` stamp on all five index.html asset URLs.
- Commit straight to `main` (solo repo, user preference).

---

### Task 1: `timelineRows` — row descriptors with band splitting

**Files:**
- Modify: `js/plan/model.js` (after `actRemaining`, ~line 115)
- Test: `tests/plan-model.test.mjs` (append at end)

- [ ] **Step 1: Write the failing tests**

Append to `tests/plan-model.test.mjs`:

```js
// ── Chapter timeline (Subjects 📅 Timeline) ─────────────────
import { timelineRows, chainTimeline, actualFinishes, BAND_SIZE } from '../js/plan/model.js';

const TL_CYC = { anchorMonday: '2026-08-24', dutyStart: '2026-08-11' };
const TL_SM = { id: 'sm', type: 'paced', status: 'active',
  rhythm: { kind: 'daily' }, travel: { mode: 'reduced', factor: 0.5 },
  chain: [
    { id: 'c1', name: 'Ch 1 · Numbers', pattern: 'tb-wb', lessons: 3, tests: 0, done: 0 },  // 6 sessions
    { id: 'c2', name: 'Ch 2 · Add/Sub', pattern: 'tb-wb', lessons: 2, tests: 1, done: 0 },  // 5 sessions
  ] };
const TL_LOE = { id: 'tloe', type: 'paced', status: 'active',
  rhythm: { kind: 'cycle', perOnWeek: 1, perOffWeek: 2.5 }, travel: { mode: 'pause' },
  chain: [
    { id: 'lc', name: 'C', pattern: 'simple', firstUnit: 81, lastUnit: 120, done: 21 },
    { id: 'ld', name: 'D', pattern: 'simple', firstUnit: 121, lastUnit: 140, done: 0 },
  ] };

test('timelineRows: tb-wb chains are one row per chapter, in order', () => {
  const rows = timelineRows(TL_SM);
  assert.deepEqual(rows.map(r => r.key), ['c1', 'c2']);
  assert.deepEqual(rows.map(r => r.chainId), ['c1', 'c2']);
  assert.deepEqual(rows.map(r => r.sessions), [6, 5]);
  assert.deepEqual(rows.map(r => r.done), [0, 0]);
  assert.equal(rows[0].label, 'Ch 1 · Numbers');
});

test('timelineRows: simple chains split into 10-unit bands, done flows through in order', () => {
  assert.equal(BAND_SIZE, 10);
  const rows = timelineRows(TL_LOE);
  assert.deepEqual(rows.map(r => r.key),
    ['lc:81-90', 'lc:91-100', 'lc:101-110', 'lc:111-120', 'ld:121-130', 'ld:131-140']);
  assert.equal(rows[0].label, 'Lessons 81–90');
  assert.deepEqual(rows.map(r => r.sessions), [10, 10, 10, 10, 10, 10]);
  assert.deepEqual(rows.map(r => r.done), [10, 10, 1, 0, 0, 0]);   // 21 done in C
  assert.deepEqual(rows.map(r => r.chainId), ['lc', 'lc', 'lc', 'lc', 'ld', 'ld']);
});

test('timelineRows: short tail band, unitWord, done clamp, junk chain skipped', () => {
  const act = { chain: [
    { id: 'g', pattern: 'simple', firstUnit: 1, lastUnit: 15, done: 99, unitWord: 'Week' },
    { id: 'bad', pattern: 'simple', done: 3 },                     // no units: skipped
  ] };
  const rows = timelineRows(act);
  assert.deepEqual(rows.map(r => r.key), ['g:1-10', 'g:11-15']);
  assert.equal(rows[1].label, 'Weeks 11–15');
  assert.deepEqual(rows.map(r => r.sessions), [10, 5]);
  assert.deepEqual(rows.map(r => r.done), [10, 5]);                // 99 clamped to 15
  assert.deepEqual(timelineRows({}), []);                          // no chain at all
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule" && node --test 2>&1 | tail -20`
Expected: FAIL — `timelineRows` is not exported (SyntaxError on the import line is the expected failure mode for ESM named imports).

- [ ] **Step 3: Implement `timelineRows` in `js/plan/model.js`**

Insert after the `actRemaining` line (`export const actRemaining = …`, ~line 115):

```js
// ── Chapter timeline (Subjects 📅 Timeline) ─────────────────
// Row descriptors for a paced activity's chain, in teaching order.
// tb-wb chains (Singapore chapters) are one row each; simple chains (LoE books)
// split into BAND_SIZE-unit display bands so a 40-lesson book reads as
// milestones. Bands are DISPLAY ONLY — nothing stored changes shape, so band
// size can change later without any data migration.
export const BAND_SIZE = 10;
export function timelineRows(act) {
  const rows = [];
  for (const c of act?.chain || []) {
    const total = sessionsCount(c);
    const done = Math.min(c.done || 0, total);
    if (c.pattern === 'tb-wb') {
      rows.push({ key: c.id, chainId: c.id, label: c.name || c.id, sessions: total, done });
    } else {
      if (c.firstUnit == null || c.lastUnit == null) continue;
      const word = c.unitWord || 'Lesson';
      let left = done;
      for (let a = c.firstUnit; a <= c.lastUnit; a += BAND_SIZE) {
        const b = Math.min(a + BAND_SIZE - 1, c.lastUnit);
        const n = b - a + 1;
        const d = Math.min(left, n);
        left -= d;
        rows.push({ key: `${c.id}:${a}-${b}`, chainId: c.id,
          label: `${word}s ${a}–${b}`, sessions: n, done: d });
      }
    }
  }
  return rows;
}
```

Note: `chainTimeline` and `actualFinishes` are Tasks 2–3; the import line in the test will still fail until Task 3. To keep this task green on its own, Step 1's import may be trimmed to `timelineRows, BAND_SIZE` and extended in later tasks — do that: import only what exists per task.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test 2>&1 | tail -5`
Expected: all pass (`# fail 0`).

- [ ] **Step 5: Commit**

```bash
git add js/plan/model.js tests/plan-model.test.mjs
git commit -m "feat(planner): timelineRows — per-chapter rows with 10-unit display bands"
```

---

### Task 2: `chainTimeline` — per-row projected finish dates

**Files:**
- Modify: `js/plan/model.js` (directly after `timelineRows`)
- Test: `tests/plan-model.test.mjs` (append; extend the Task-1 import with `chainTimeline`)

- [ ] **Step 1: Write the failing tests**

```js
test('chainTimeline: last unfinished row lands EXACTLY on projectFinish (the invariant)', () => {
  for (const periods of [[], [{ id: 'p1', start: '2027-01-04', end: '2027-02-07', type: 'travel' }]]) {
    const p = { periods, parentCycle: TL_CYC };
    for (const act of [TL_SM, TL_LOE]) {
      const rows = chainTimeline(act, '2026-08-19', p);
      const last = [...rows].reverse().find(r => !r.complete);
      assert.equal(last.finish, projectFinish(act, '2026-08-19', p).date,
        `${act.id} with ${periods.length} periods`);
    }
  }
});

test('chainTimeline: rows finish in order, complete rows have finish null', () => {
  const done1 = { ...TL_SM, chain: [
    { ...TL_SM.chain[0], done: 6 },            // Ch 1 fully done
    { ...TL_SM.chain[1], done: 0 },
  ] };
  const rows = chainTimeline(done1, '2026-08-19', { periods: [], parentCycle: TL_CYC });
  assert.equal(rows[0].complete, true);
  assert.equal(rows[0].finish, null);
  assert.equal(rows[1].complete, false);
  assert.match(rows[1].finish, /^\d{4}-\d{2}-\d{2}$/);
  // multi-row ordering on the LoE bands: dates never decrease
  const lrows = chainTimeline(TL_LOE, '2026-08-19', { periods: [], parentCycle: TL_CYC })
    .filter(r => !r.complete);
  for (let i = 1; i < lrows.length; i++)
    assert.ok(lrows[i].finish >= lrows[i - 1].finish, `row ${i} goes backwards`);
});

test('chainTimeline: horizon exhaustion leaves finish null (UI shows —)', () => {
  const rows = chainTimeline(TL_LOE, '2026-08-19', { periods: [], parentCycle: TL_CYC }, 1);
  assert.ok(rows.some(r => !r.complete && r.finish === null));
});

test('chainTimeline: everything done → all rows complete, no dates', () => {
  const allDone = { ...TL_SM, chain: TL_SM.chain.map(c => ({ ...c, done: 99 })) };
  const rows = chainTimeline(allDone, '2026-08-19', { periods: [], parentCycle: TL_CYC });
  assert.ok(rows.every(r => r.complete && r.finish === null));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test 2>&1 | tail -10`
Expected: FAIL — `chainTimeline` not exported.

- [ ] **Step 3: Implement `chainTimeline`**

Insert directly after `timelineRows`:

```js
// Per-row projected finish dates from the SAME week-walk as projectFinish, so
// the last unfinished row lands on exactly projectFinish's date (unit-pinned):
// the breakdown can never contradict the card's headline. A row's finish is
// the Sunday of the week its cumulative remaining sessions are covered.
export function chainTimeline(act, fromDate, plan, horizon = 300) {
  const rows = timelineRows(act).map(r =>
    ({ ...r, complete: r.sessions > 0 && r.done >= r.sessions, finish: null }));
  const targets = [];                 // cumulative remaining sessions per row
  let cum = 0;
  for (const r of rows) { cum += Math.max(0, r.sessions - r.done); targets.push(cum); }
  if (!cum) return rows;              // nothing left anywhere
  let acc = 0, w = mondayOf(fromDate), i = 0;
  for (let wk = 0; wk < horizon && i < rows.length; wk++) {
    acc += weekCapacity(act, w, plan.periods, plan.parentCycle);
    while (i < rows.length && (rows[i].complete || acc >= targets[i])) {
      if (!rows[i].complete) rows[i].finish = addDays(w, 6);
      i++;
    }
    w = addDays(w, 7);
  }
  return rows;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test 2>&1 | tail -5` — expect `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add js/plan/model.js tests/plan-model.test.mjs
git commit -m "feat(planner): chainTimeline — per-row dates pinned to the projectFinish walk"
```

---

### Task 3: `actualFinishes` — real dates from the log

**Files:**
- Modify: `js/plan/model.js` (after `chainTimeline`)
- Test: `tests/plan-model.test.mjs` (append; extend import with `actualFinishes`)

- [ ] **Step 1: Write the failing tests**

```js
test('actualFinishes: the log entry crossing a row boundary dates that row', () => {
  const log = [];
  for (let i = 1; i <= 11; i++)        // 11 sessions of c1/c2 logged on distinct days
    log.push({ date: `2026-09-${String(i).padStart(2, '0')}`, activityId: 'sm',
      status: 'done', curriculum: i <= 6 ? 'c1' : 'c2' });
  const out = actualFinishes(TL_SM, log);
  assert.equal(out['c1'], '2026-09-06');      // 6th c1 session
  assert.equal(out['c2'], '2026-09-11');      // 5th c2 session
});

test('actualFinishes: partial chapters and bulk done-bumps have no date', () => {
  const log = [
    { date: '2026-09-01', status: 'done', curriculum: 'c1' },
    { date: '2026-09-02', status: 'done', curriculum: 'c1' },
  ];
  const out = actualFinishes(TL_SM, log);      // only 2 of 6 c1 sessions attested
  assert.deepEqual(out, {});
  assert.deepEqual(actualFinishes(TL_SM, undefined), {});
});

test('actualFinishes: band boundaries inside one chain; date sort not array order', () => {
  const log = [];
  for (let i = 10; i >= 1; i--)                // deliberately reversed order
    log.push({ date: `2026-09-${String(i).padStart(2, '0')}`, status: 'done', curriculum: 'lc' });
  const out = actualFinishes(TL_LOE, log);
  assert.equal(out['lc:81-90'], '2026-09-10'); // 10th session by DATE
  assert.equal(out['lc:91-100'], undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test 2>&1 | tail -10` — expect FAIL, `actualFinishes` not exported.

- [ ] **Step 3: Implement `actualFinishes`**

```js
// Actual finish dates recovered from the log: dated 'done' entries per chain,
// replayed in date order — the entry that crosses a row's cumulative session
// boundary dates that row. Rows advanced without log rows (bulk `done` bumps
// from a Claude session) have no entry here; the view shows a bare ✓.
export function actualFinishes(act, log) {
  const out = {};
  const byChain = new Map();
  for (const r of timelineRows(act)) {
    if (!byChain.has(r.chainId)) byChain.set(r.chainId, []);
    byChain.get(r.chainId).push(r);
  }
  for (const [chainId, rows] of byChain) {
    const dates = (Array.isArray(log) ? log : [])
      .filter(e => e && e.status === 'done' && e.curriculum === chainId &&
        typeof e.date === 'string' && ISO.test(e.date))
      .map(e => e.date).sort();
    let upto = 0;
    for (const r of rows) {
      upto += r.sessions;
      if (dates.length >= upto) out[r.key] = dates[upto - 1];
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass** — `node --test 2>&1 | tail -5`, expect `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add js/plan/model.js tests/plan-model.test.mjs
git commit -m "feat(planner): actualFinishes — chapter completion dates recovered from the log"
```

---

### Task 4: `sanitizePlan` guards the stored baseline

**Files:**
- Modify: `js/plan/model.js` — inside `sanitizePlan`'s activities `.map`
- Test: `tests/plan-model.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
test('sanitizePlan: well-formed baseline round-trips, rebuilt to exactly {setOn, rows}', () => {
  const p = sanitizePlan({ activities: [{ id: 'a', type: 'paced', status: 'active',
    baseline: { setOn: '2026-08-19', rows: { 'c1': '2026-09-13' }, junk: 1 } }] });
  assert.deepEqual(p.activities[0].baseline,
    { setOn: '2026-08-19', rows: { 'c1': '2026-09-13' } });
});

test('sanitizePlan: malformed baseline is dropped without dropping the activity', () => {
  const bad = [
    'a-string',
    { rows: { c1: '2026-09-13' } },                        // no setOn
    { setOn: 'yesterday', rows: { c1: '2026-09-13' } },    // bad setOn
    { setOn: '2026-08-19', rows: ['2026-09-13'] },         // rows is an array
    { setOn: '2026-08-19', rows: { c1: 'soon' } },         // non-ISO row date
    { setOn: '2026-08-19' },                               // no rows
  ];
  for (const baseline of bad) {
    const p = sanitizePlan({ activities: [{ id: 'a', type: 'paced', status: 'active', baseline }] });
    assert.equal(p.activities.length, 1, JSON.stringify(baseline));
    assert.equal('baseline' in p.activities[0], false, JSON.stringify(baseline));
  }
});
```

- [ ] **Step 2: Run tests to verify they fail** — `node --test 2>&1 | tail -10`. The round-trip test FAILS (junk key survives via `...a` spread); the malformed test FAILS (nothing drops it).

- [ ] **Step 3: Implement the guard**

In `sanitizePlan`, the activities `.map` currently reads:

```js
    .map(a => {
      // `id` is required: togglePaced records it in the log and finds the
      // curriculum by it on uncheck. An id-less entry would break that identity.
      const o = { ...a, chain: Array.isArray(a.chain)
          ? a.chain.filter(c => c && c.pattern && c.id).map(c => ({ ...c, done: Math.max(0, c.done || 0) }))
          : [] };
      if (o.goal && !isISO(o.goal.finishBy)) delete o.goal;
      return o;
    });
```

Add the baseline guard after the `goal` line:

```js
      if (o.goal && !isISO(o.goal.finishBy)) delete o.goal;
      // Baseline (Subjects 📅 Timeline): rebuild to exactly {setOn, rows} or
      // drop it — a corrupt baseline must degrade to "no plan yet", never
      // corrupt the activity or crash a date compare.
      if ('baseline' in o) {
        const b = o.baseline, rows = b && typeof b === 'object' ? b.rows : null;
        const ok = b && isISO(b.setOn) && rows && typeof rows === 'object' &&
          !Array.isArray(rows) && Object.values(rows).every(isISO);
        if (ok) o.baseline = { setOn: b.setOn, rows: { ...rows } };
        else delete o.baseline;
      }
      return o;
```

- [ ] **Step 4: Run the FULL suite** — `node --test 2>&1 | tail -5`, expect `# fail 0` (the contract test against `tests/fixtures/production.json` must stay green — the production blob has no baseline, so the guard is a no-op there; refresh the fixture first if absent: `curl -s https://aoifes-schedule.vercel.app/api/get -o tests/fixtures/production.json`).

- [ ] **Step 5: Commit**

```bash
git add js/plan/model.js tests/plan-model.test.mjs
git commit -m "feat(planner): sanitizePlan guards the per-activity baseline snapshot"
```

---

### Task 5: `setBaseline` mutation

**Files:**
- Modify: `js/plan/state.js`
- Test: `tests/plan-state.test.mjs` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/plan-state.test.mjs` (globals are already stubbed at the top of the file; `S` is the imported module):

```js
test('setBaseline freezes unfinished row dates; complete rows excluded; overwrite works', () => {
  const { chainTimeline } = await import('../js/plan/model.js');
  plan.data = sanitizePlan({
    parentCycle: { anchorMonday: '2026-08-24', dutyStart: '2026-08-11' },
    activities: [{ id: 'sm', type: 'paced', status: 'active',
      rhythm: { kind: 'daily' }, travel: { mode: 'reduced', factor: 0.5 },
      chain: [
        { id: 'c1', pattern: 'tb-wb', lessons: 3, tests: 0, done: 6 },   // complete
        { id: 'c2', pattern: 'tb-wb', lessons: 2, tests: 1, done: 0 },
      ] }],
  });
  S.setBaseline('sm', '2026-09-01');
  const act = plan.data.activities[0];
  assert.equal(act.baseline.setOn, '2026-09-01');
  assert.equal('c1' in act.baseline.rows, false);            // complete: history, not plan
  const expected = chainTimeline(act, '2026-09-01', plan.data).find(r => r.key === 'c2').finish;
  assert.equal(act.baseline.rows.c2, expected);
  S.setBaseline('sm', '2026-09-08');                          // re-baseline overwrites
  assert.equal(act.baseline.setOn, '2026-09-08');
  assert.equal(S.setBaseline('nope'), undefined);             // unknown id: no throw
});
```

NOTE: `await import` inside a sync `test()` callback is invalid — make the callback async: `test('…', async () => { … })`. The existing file's top-level `await import` shows the module is already loaded; alternatively add `chainTimeline` to the static import list from `../js/plan/model.js` at the top of the file (preferred — do that instead of the inline dynamic import).

- [ ] **Step 2: Run tests to verify they fail** — `node --test 2>&1 | tail -10`, expect FAIL: `S.setBaseline is not a function`.

- [ ] **Step 3: Implement `setBaseline` in `js/plan/state.js`**

Extend the model import at the top:

```js
import { sanitizePlan, serializePlan, currentCur, todayStr, sortPeriods,
         PERIOD_TYPES, ISO, chainTimeline } from './model.js';
```

Add after `setTravelMode`:

```js
// Freeze today's projected per-row finish dates as "the plan" (Subjects 📅
// Timeline). Overwrites any previous baseline — the UI arms two-tap when one
// exists. Complete rows and horizon-exhausted rows store nothing: history
// lives in the log, and a dash is honest for the unprojectable.
export function setBaseline(actId, date = todayStr()) {
  const act = getActivity(actId);
  if (!act) return;
  const rows = {};
  for (const r of chainTimeline(act, date, plan.data))
    if (!r.complete && r.finish) rows[r.key] = r.finish;
  act.baseline = { setOn: date, rows };
  commit();
}
```

- [ ] **Step 4: Run the full suite** — `node --test 2>&1 | tail -5`, expect `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add js/plan/state.js tests/plan-state.test.mjs
git commit -m "feat(planner): setBaseline — freeze the projected chapter dates as the plan"
```

---

### Task 6: Subjects card UI — 📅 Timeline section + baseline button

**Files:**
- Modify: `js/plan/subjects.js`
- No unit test (no DOM test rig for subjects.js exists; behavior is covered by the adversarial review + live verification in Task 8). Run the suite anyway — imports must not break the pure tests.

- [ ] **Step 1: Extend imports**

```js
import {
  todayStr, actTotal, actDone, currentCur, nextSession,
  projectFinish, requiredPerCycle, targetStats, okCls,
  chainTimeline, actualFinishes, daysBetween,
} from './model.js';
import { plan, setActivityStatus, setTravelMode, setBaseline, getActivity } from './state.js';
```

- [ ] **Step 2: Add the timeline builder (after `paceLine`, before `card`)**

```js
// 📅 Timeline: per-chapter plan-vs-now. Active paced subjects with counts only —
// a parked/planned subject's projection would be fiction (the walk assumes she
// starts today). Complete rows show the log-attested date when one exists.
function timelineHtml(a) {
  if (a.type !== 'paced' || a.status !== 'active' || actTotal(a) === 0) return '';
  const p = plan.data;
  const rows = chainTimeline(a, todayStr(), p);
  if (!rows.length) return '';
  const actual = actualFinishes(a, p.log);
  const base = a.baseline?.rows;
  let curSeen = false;
  const items = rows.map(r => {
    let cls = 'tl-row', right;
    if (r.complete) {
      const ad = actual[r.key];
      right = `<span class="tl-ok">✓${ad ? ' ' + fmtDate(ad) : ''}</span>`;
    } else {
      if (!curSeen) { curSeen = true; cls += ' cur'; }
      const b = base ? base[r.key] : null;
      let chip = '';
      if (b && r.finish) {
        const dd = daysBetween(r.finish, b);            // + = ahead of plan
        const dw = Math.round(Math.abs(dd) / 7);
        if (Math.abs(dd) <= 7) chip = `<span class="pchip">≈ on plan</span>`;
        else if (dd > 0) chip = `<span class="pchip ok">${dw} wk${dw > 1 ? 's' : ''} early</span>`;
        else chip = `<span class="pchip warn">${dw} wk${dw > 1 ? 's' : ''} late</span>`;
      }
      right = `plan ${b ? fmtDate(b) : '—'} · now ${r.finish ? fmtDate(r.finish) : '—'}${chip ? ' ' + chip : ''}`;
    }
    return `<div class="${cls}"><span class="tl-nm">${esc(r.label)}</span><span class="tl-dt">${right}</span></div>`;
  }).join('');
  return `<details class="sdet"><summary>📅 Timeline</summary><div class="tl">${items}</div></details>`;
}
```

- [ ] **Step 3: Render it in `card()` and add the button**

In `card(a)`, insert the timeline between the note line and the Manage details:

```js
  if (a.note) h += `<div class="sline">${esc(a.note)}</div>`;
  h += timelineHtml(a);
  h += `<details class="sdet"><summary>Manage</summary><div class="sctl">`;
```

Inside the Manage controls, after the travel `<select>` block, add:

```js
  if (a.type === 'paced' && a.status === 'active' && actTotal(a) > 0)
    h += `<button data-do="baseline">${a.baseline ? 'Re-baseline' : 'Set baseline'}</button>`;
```

- [ ] **Step 4: Wire the two-tap**

The container disarm listener currently spares only the cancel button; spare baseline too:

```js
    el.addEventListener('click', e => {
      if (!e.target.closest('[data-do="cancel"],[data-do="baseline"]')) disarm();
    });
```

In the per-button click handler, add the baseline branch before the status map dispatch (first set is one-tap; only RE-baseline arms, because it overwrites the reference plan):

```js
    else b.addEventListener('click', () => {
      const map = { activate: 'active', park: 'parked', cancel: 'cancelled' };
      if (b.dataset.do === 'cancel' && armedBtn !== b) {
        disarm();                             // re-arm from some other card's button
        armedBtn = b;
        b.textContent = 'Tap again to cancel';
        return;
      }
      if (b.dataset.do === 'baseline') {
        if (getActivity(id)?.baseline && armedBtn !== b) {
          disarm();
          armedBtn = b;
          b.textContent = 'Tap again to re-baseline';
          return;
        }
        disarm();
        setBaseline(id);
        return;
      }
      disarm();
      setActivityStatus(id, map[b.dataset.do]);
    });
```

- [ ] **Step 5: Run the full suite** — `node --test 2>&1 | tail -5`, expect `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add js/plan/subjects.js
git commit -m "feat(planner): Subjects 📅 Timeline — per-chapter plan-vs-now + two-tap re-baseline"
```

---

### Task 7: CSS + version stamp

**Files:**
- Modify: `css/plan.css` (after the `.sctl-l select` rule, ~line 121)
- Modify: `index.html` (five `?v=` stamps)

- [ ] **Step 1: Add the timeline styles**

```css
/* 📅 Timeline (Subjects): per-chapter plan-vs-now rows */
.tl { margin-top: 8px; display: flex; flex-direction: column; gap: 2px; }
.tl-row { display: flex; justify-content: space-between; align-items: baseline;
  flex-wrap: wrap; gap: 2px 8px; font-size: 11px; color: var(--text-sub);
  padding: 3px 6px; border-radius: 6px; }
.tl-row.cur { background: var(--bg-input); font-weight: 600; }
.tl-nm { flex: 1 1 auto; min-width: 0; }
.tl-dt { flex: 0 0 auto; white-space: nowrap; display: inline-flex; gap: 5px; align-items: baseline; }
.tl-ok { color: var(--ok); font-weight: 700; }
```

(All four vars — `--text-sub`, `--bg-input`, `--ok` — are already used elsewhere in plan.css. These rules are OUTSIDE any `@media print` block; the Subjects view never prints, but do not touch plan.css's own `@media print` section.)

- [ ] **Step 2: Bump the version stamp**

In `index.html`, replace all five `?v=2026-08-18-3` with `?v=2026-08-19-1` (lines 20–23 and 78 — css/tokens.css, css/app.css, css/plan.css, css/print.css, js/main.js). Verify: `grep -c 'v=2026-08-19-1' index.html` → `5`, `grep -c 'v=2026-08-18-3' index.html` → `0`.

- [ ] **Step 3: Print harness check** (release rule 2 — plan.css changed)

```bash
python3 -m http.server 8080 &  SERVER=$!
sleep 1
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
  --print-to-pdf=/tmp/print-check.pdf --no-pdf-header-footer http://localhost:8080/ 2>/dev/null
kill $SERVER
python3 -c "import re;d=open('/tmp/print-check.pdf','rb').read();print('pages:',len(re.findall(rb'/Type\s*/Page[^s]',d)))"
```

Expected: `pages: 1` (the sacred one-page week grid). If ≠1, the new rules leaked into print — they must not; investigate before proceeding.

- [ ] **Step 4: Run the full suite once more** — `node --test 2>&1 | tail -5`, expect `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add css/plan.css index.html
git commit -m "feat(planner): timeline styles + ?v=2026-08-19-1 cache stamp (planner-v2.7)"
```

---

### Task 8: Review round, release, initial baselines

- [ ] **Step 1: Adversarial review** (hard rule 6). Dispatch a code-reviewer subagent over `git diff planner-v2.6..HEAD` against the spec (`docs/superpowers/specs/2026-08-19-subjects-chapter-timeline-design.md`). Fix anything real; re-run the suite after fixes.

- [ ] **Step 2: Tag and push**

```bash
git tag planner-v2.7
git push && git push --tags
```

- [ ] **Step 3: Deploy + verify.** Check whether the GitHub push auto-deployed (last release it didn't — open item in AGENTS.md): `vercel ls` or fetch the site and check for the new stamp: `curl -s https://aoifes-schedule.vercel.app/ | grep -c 'v=2026-08-19-1'` → `5`. If stale after ~2 min: `vercel --prod`.

- [ ] **Step 4: Set the initial baselines on the LIVE site** (main session does this in the browser — it exercises the real two-tap path): Subjects tab → Unlock to Edit → Singapore Math → Manage → Set baseline; same for Logic of English. Verify via `curl -s https://aoifes-schedule.vercel.app/api/plan-get | python3 -c "import json,sys; d=json.load(sys.stdin); print([{'id':a['id'],'baseline':a.get('baseline',{}).get('setOn')} for a in d['activities'] if a.get('baseline')])"` → both ids with today's date.

- [ ] **Step 5: Live verification on the phone-sized viewport**: 📅 Timeline expands on both cards; Singapore shows 15 chapter rows (Ch 15 `now` date = the headline date); LoE shows 6 band rows; plan column populated after Step 4; current row highlighted; Manage still works; Week/Today/Year unchanged; print preview still one page.

- [ ] **Step 6: Update AGENTS.md** — add a short "Subjects 📅 Timeline (planner-v2.7)" section documenting: the three pure functions, the baseline field shape, the sanitize guard, first-set-one-tap / re-baseline-two-tap, bands are display-only. Commit + push.

---

## Self-review (done at write time)

- **Spec coverage:** rows/bands ✓ (T1), invariant walk ✓ (T2), actual dates ✓ (T3), sanitize guard ✓ (T4), setBaseline + exclusions ✓ (T5), UI + two-tap + active-only gating ✓ (T6), CSS + stamp + print rule ✓ (T7), review/release/initial-baselines/AGENTS.md ✓ (T8).
- **Placeholder scan:** none; every code step carries the code.
- **Type consistency:** row shape `{key, chainId, label, sessions, done}` (+`complete`,`finish` from chainTimeline) used identically in T1–T6; `baseline = {setOn, rows}` identical in T4/T5/T6.
- **Known judgment calls encoded:** first-set one-tap vs re-baseline two-tap; complete rows excluded from baseline; `curriculum`-scoped log filter (ids unique across activities in the live data).
