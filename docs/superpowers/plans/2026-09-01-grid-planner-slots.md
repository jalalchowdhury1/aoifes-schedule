# Week grid draws planner slots (draggable) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop week grid (and its one-page print) shows the on-grid planner activities — Jiu Jitsu, Geography, Foundations of Inquiry Science — as real blocks that can be dragged/resized when unlocked, writing back to the planner.

**Architecture:** `js/grid.js renderGrid()` renders planner slots as first-class `.evt.pslot[data-slot="<actId>:<idx>"]` blocks next to the template's `.evt[data-id]` blocks, from a new pure `gridSlots()` in `js/plan/model.js`. The existing drag/resize code learns a second identity via a pure `blockRef()`; a slot drop calls a new `setSlot()` mutation in `js/plan/state.js`. The frozen `js/dayview.js` is untouched — `js/plan/overlay.js` draws read-only slot blocks into `#dayview` only (it must NOT draw them into `#grid`, which now renders them natively) and its dot sweep learns `data-slot`.

**Tech Stack:** Vanilla ES modules, zero deps, no build. Tests: `node --test tests/*.test.mjs` (bare `node --test`; Node 24 breaks on a directory arg). Spec: `docs/superpowers/specs/2026-09-01-grid-planner-slots-design.md`. Read `AGENTS.md` first.

**Repo path has a space and an apostrophe — ALWAYS quote it:** `cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule"`.

**Baseline before Task 1:** 361 tests, 0 failing. Work on `main` directly (solo repo). Every commit message ends with:

```
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KP54gc9RG6WQccxBqECYCG
```

---

## File map

| File | Change |
|---|---|
| `js/plan/model.js` | + `gridSlots(activities)` (pure) |
| `js/plan/state.js` | + `setSlot(actId, idx, patch)` mutation |
| `js/grid.js` | + `blockRef(ds)`, `slotHTML()`, render slots, slot drag/resize |
| `js/plan/overlay.js` | + `applySlots(root, blocks)` for `#dayview`, dot sweep for `data-slot` |
| `js/plan/tabs.js` | re-render the grid on plan change (not mid-drag) |
| `css/plan.css` | `.evt.ov-slot` read-only rule |
| `index.html` | asset stamps `2026-08-31-8` → `2026-09-01-2` |
| `AGENTS.md` | document the new surface |
| `tests/plan-model.test.mjs`, `tests/plan-state.test.mjs`, `tests/grid.test.mjs` (new), `tests/plan-overlay.test.mjs` | tests |

---

### Task 1: `gridSlots()` — the pure slot list

**Files:**
- Modify: `js/plan/model.js` (append near `currentCur`, ~line 177)
- Test: `tests/plan-model.test.mjs` (append at end)

- [ ] **Step 1: Write the failing tests**

Append to `tests/plan-model.test.mjs`:

```js
import { gridSlots } from '../js/plan/model.js';

const geo = () => ({
  id: 'geography', name: 'Geography', type: 'paced', status: 'active', cls: 'g', onGrid: true,
  slots: [{ day: 2, start: 11, end: 12 }],
  chain: [{ id: 'geo-1', pattern: 'simple', firstUnit: 1, lastUnit: 30, done: 0, unitWord: 'Week',
            titles: { '1': 'Introduction to Geography' } }],
});

test('gridSlots: an active on-grid activity yields one block per slot with a stable (actId, idx) identity', () => {
  const sci = { id: 'science', name: 'Science', type: 'external', status: 'active', cls: 's', onGrid: true,
                slots: [{ day: 2, start: 14, end: 15 }, { day: 4, start: 9, end: 10 }] };
  const out = gridSlots([geo(), sci]);
  assert.deepEqual(out.map(b => [b.actId, b.idx, b.day, b.start, b.end, b.cls]), [
    ['geography', 0, 2, 11, 12, 'g'],
    ['science', 0, 2, 14, 15, 's'],
    ['science', 1, 4, 9, 10, 's'],
  ]);
  assert.equal(out[0].name, 'Geography');
  assert.equal(out[1].note, '');                         // not paced: no lesson label
});

test('gridSlots: a paced activity carries its next session label as the note', () => {
  assert.equal(gridSlots([geo()])[0].note, 'Introduction to Geography');
});

test('gridSlots: planned / off-grid / slot-less / malformed activities contribute nothing', () => {
  const planned = { ...geo(), status: 'planned' };
  const offGrid = { ...geo(), onGrid: false };
  const noSlots = { ...geo(), slots: undefined };
  const bad = { ...geo(), slots: [{ day: '2', start: 11, end: 12 }, { day: 7, start: 11, end: 12 },
                                   { day: 2, start: 12, end: 11 }, null] };
  assert.deepEqual(gridSlots([planned, offGrid, noSlots, bad]), []);
  assert.deepEqual(gridSlots(undefined), []);
});

test('gridSlots: outside 9–17 is dropped, overhanging is clamped for drawing but keeps its real times', () => {
  const a = { ...geo(), slots: [{ day: 0, start: 7, end: 8 }, { day: 1, start: 8, end: 10 }, { day: 3, start: 16, end: 18 }] };
  const out = gridSlots([a]);
  assert.deepEqual(out.map(b => [b.idx, b.top, b.bottom, b.start, b.end]), [
    [1, 9, 10, 8, 10],
    [2, 16, 17, 16, 18],
  ]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule" && node --test tests/plan-model.test.mjs 2>&1 | tail -8`
Expected: FAIL — `SyntaxError: The requested module '../js/plan/model.js' does not provide an export named 'gridSlots'`

- [ ] **Step 3: Implement**

`js/plan/model.js` has NO imports today (it is self-contained). Add at the very top, after the header comment (line 3):

```js
import { S, E } from '../model.js';
```

Then append after `actRemaining` (~line 180):

```js
// ── Planner slots on the week grid (2026-09-01) ─────────────
// An active on-grid activity's `slots[]` are recurring weekly blocks, the
// planner-side twin of `aoifes_schedule.events`. `(actId, idx)` IS a slot's
// identity everywhere — the grid's data-slot attribute, the gcal sync key
// `act:<id>:<idx>` — so the index must never be re-packed here: a malformed
// slot is skipped, not spliced. Same drawing rules as the one-off ghosts: a
// slot wholly outside 9–17 is dropped, an overhanging one is clamped to the
// band (`top`/`bottom`) while the label keeps its real `start`/`end`.
export function gridSlots(activities) {
  const out = [];
  for (const a of Array.isArray(activities) ? activities : []) {
    if (!a || a.status !== 'active' || !a.onGrid || !Array.isArray(a.slots)) continue;
    const cur = a.type === 'paced' ? currentCur(a) : null;
    const ns = cur ? nextSession(cur) : null;
    const note = ns ? ns.label : '';
    a.slots.forEach((s, idx) => {
      if (!s || !Number.isInteger(s.day) || s.day < 0 || s.day > 6) return;
      if (typeof s.start !== 'number' || typeof s.end !== 'number') return;
      if (s.end <= s.start || s.end <= S || s.start >= E) return;
      out.push({
        actId: a.id, idx, day: s.day, start: s.start, end: s.end,
        top: Math.max(S, s.start), bottom: Math.min(E, s.end),
        name: a.name || a.id, cls: okCls(a.cls), note,
      });
    });
  }
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/*.test.mjs 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `tests 365` / `pass 365` / `fail 0`

- [ ] **Step 5: Commit**

```bash
git add js/plan/model.js tests/plan-model.test.mjs
git commit -m "model: gridSlots() lists active on-grid planner slots as week-grid blocks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KP54gc9RG6WQccxBqECYCG"
```

---

### Task 2: `setSlot()` mutation

**Files:**
- Modify: `js/plan/state.js` (after `setTravelMode`, ~line 350)
- Test: `tests/plan-state.test.mjs` (append at end)

- [ ] **Step 1: Write the failing tests**

Append to `tests/plan-state.test.mjs` (the file already has `S = await import('../js/plan/state.js')`, `plan`, `initPlan`, `snap` in scope):

```js
const { setSlot, onPlanChange } = S;

test('setSlot: patches one slot in place, keeps (actId, idx) identity, and commits', () => {
  initPlan();
  const geo = plan.data.activities.find(a => a.id === 'geography');
  geo.status = 'active'; geo.onGrid = true;
  geo.slots = [{ day: 2, start: 11, end: 12 }, { day: 4, start: 9, end: 10 }];
  let fired = 0; onPlanChange(() => fired++);
  const before = plan.data.savedAt;
  assert.equal(setSlot('geography', 0, { day: 3, start: 13, end: 14 }), true);
  assert.deepEqual(geo.slots, [{ day: 3, start: 13, end: 14 }, { day: 4, start: 9, end: 10 }]);
  assert.equal(fired, 1);
  assert.notEqual(plan.data.savedAt, before);             // savePlan stamped it
});

test('setSlot: a partial patch only touches the given fields', () => {
  initPlan();
  const geo = plan.data.activities.find(a => a.id === 'geography');
  geo.slots = [{ day: 2, start: 11, end: 12 }];
  setSlot('geography', 0, { end: 12.5 });
  assert.deepEqual(geo.slots, [{ day: 2, start: 11, end: 12.5 }]);
});

test('setSlot: unknown activity / index / non-numeric values change nothing and do not commit', () => {
  initPlan();
  const geo = plan.data.activities.find(a => a.id === 'geography');
  geo.slots = [{ day: 2, start: 11, end: 12 }];
  const before = snap(plan.data);
  let fired = 0; onPlanChange(() => fired++);
  assert.equal(setSlot('nope', 0, { day: 1 }), false);
  assert.equal(setSlot('geography', 5, { day: 1 }), false);
  assert.equal(setSlot('geography', 0, { day: '1', start: null }), true);   // accepted, but nothing numeric to apply
  assert.deepEqual(snap(plan.data), before);
  assert.equal(fired, 1);                                   // the third call still commits (a no-op patch is not an error)
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/plan-state.test.mjs 2>&1 | grep -E "not ok|TypeError" | head -3`
Expected: `TypeError: setSlot is not a function`

- [ ] **Step 3: Implement**

In `js/plan/state.js`, after `setTravelMode` (~line 350):

```js
// Move/resize one on-grid slot (js/grid.js drag → drop). `idx` is the slot's
// identity (data-slot, gcal `act:<id>:<idx>`), so this assigns in place and
// never splices. Only numeric fields are applied; the drag guarantees them.
export function setSlot(actId, idx, { day, start, end } = {}) {
  const act = getActivity(actId);
  const s = act && Array.isArray(act.slots) ? act.slots[idx] : null;
  if (!s) return false;
  if (typeof day === 'number') s.day = day;
  if (typeof start === 'number') s.start = start;
  if (typeof end === 'number') s.end = end;
  commit();
  return true;
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/*.test.mjs 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `tests 368` / `pass 368` / `fail 0`

- [ ] **Step 5: Commit**

```bash
git add js/plan/state.js tests/plan-state.test.mjs
git commit -m "state: setSlot() moves one planner slot in place and commits

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KP54gc9RG6WQccxBqECYCG"
```

---

### Task 3: grid renders slots; `blockRef()` identity

**Files:**
- Modify: `js/grid.js` (imports lines 3–4, `evtHTML` ~line 15, `renderGrid` ~line 27–59)
- Create: `tests/grid.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `tests/grid.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// grid.js imports js/state.js and js/plan/state.js; neither touches the DOM at
// module scope, but stub the browser globals exactly like the other planner
// tests so the import graph stays safe regardless of order.
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.fetch = () => Promise.resolve({ json: async () => ({}) });
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
for (const k of ['alert', 'confirm', 'prompt'])
  globalThis[k] = () => { throw new Error(`${k}() must never be called by the planner`); };

const { blockRef, slotHTML } = await import('../js/grid.js');

test('blockRef: data-id is a template event, data-slot is a planner slot, neither is null', () => {
  assert.deepEqual(blockRef({ id: 'e1010' }), { kind: 'event', id: 'e1010' });
  assert.deepEqual(blockRef({ slot: 'geography:0' }), { kind: 'slot', actId: 'geography', idx: 0 });
  assert.deepEqual(blockRef({ slot: 'my:odd:id:12' }), { kind: 'slot', actId: 'my:odd:id', idx: 12 });
  assert.equal(blockRef({}), null);
  assert.equal(blockRef(undefined), null);
});

test('blockRef: data-id wins when both are present; malformed data-slot is null', () => {
  assert.deepEqual(blockRef({ id: 'e1', slot: 'geography:0' }), { kind: 'event', id: 'e1' });
  assert.equal(blockRef({ slot: 'geography' }), null);
  assert.equal(blockRef({ slot: ':0' }), null);
  assert.equal(blockRef({ slot: 'geography:x' }), null);
  assert.equal(blockRef({ slot: 'geography:-1' }), null);
});

test('slotHTML: positions by the clamped band, labels the real times, carries data-slot and no data-id', () => {
  const b = { actId: 'geography', idx: 0, day: 2, start: 8, end: 10, top: 9, bottom: 10,
              name: 'Geography', cls: 'g', note: 'Introduction to Geography' };
  const html = slotHTML(b, 66, { handle: true });
  assert.match(html, /class="evt g pslot"/);
  assert.match(html, /data-slot="geography:0"/);
  assert.doesNotMatch(html, /data-id/);
  assert.match(html, /top:1px;height:64px/);            // (9-9)*66+1, (10-9)*66-2
  assert.match(html, /8am&ndash;10am/);
  assert.match(html, /Introduction to Geography/);      // 64px > 46 → note shown
  assert.match(html, /class="rh"/);
  assert.doesNotMatch(slotHTML(b, 66, { handle: false }), /class="rh"/);
});

test('slotHTML: escapes the name and the actId', () => {
  const b = { actId: 'a<b', idx: 1, day: 0, start: 9, end: 10, top: 9, bottom: 10, name: '<Sci & Co>', cls: 's', note: '' };
  const html = slotHTML(b, 66);
  assert.match(html, /data-slot="a&lt;b:1"/);
  assert.match(html, /&lt;Sci &amp; Co&gt;/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/grid.test.mjs 2>&1 | grep -E "SyntaxError|not ok" | head -2`
Expected: `SyntaxError: The requested module '../js/grid.js' does not provide an export named 'blockRef'`

- [ ] **Step 3: Implement rendering + identity**

In `js/grid.js`, replace the two import lines (3–4) with:

```js
import { DAYS, S, E, SPH, CATS, fmt, snap, clampStart, clampEnd, todayIndex, esc } from './model.js';
import { store, evLabel, save, notify } from './state.js';
import { plan, setSlot } from './plan/state.js';
import { gridSlots } from './plan/model.js';
```

After `evtHTML` (after its closing `}`), add:

```js
// A planner slot block. Same shape and metrics as evtHTML so it prints and
// drags identically, but its identity is `data-slot="<actId>:<idx>"` — NEVER
// data-id, which is the template's identity (the editor, the dot sweep and the
// template drag all key off it). `.pslot` is a marker only: no visual change.
export function slotHTML(b, ph, { handle = false } = {}) {
  const top = (b.top - S) * ph;
  const height = (b.bottom - b.top) * ph;
  return `<div class="evt ${b.cls} pslot" data-slot="${esc(b.actId)}:${b.idx}"
    style="top:${top + 1}px;height:${height - 2}px;">
    <div class="et">${esc(b.name)}</div>
    <div class="en">${fmt(b.start)}&ndash;${fmt(b.end)}</div>
    ${b.note && height > 46 ? `<div class="en note">${esc(b.note)}</div>` : ''}
    ${handle && height > 22 ? '<div class="rh"></div>' : ''}
  </div>`;
}

// Which store owns a rendered block. `data-id` → template event (store.events);
// `data-slot` → planner slot (plan.data.activities[].slots[idx]). The actId may
// itself contain ':' — the index is everything after the LAST colon.
export function blockRef(ds) {
  if (!ds) return null;
  if (ds.id) return { kind: 'event', id: ds.id };
  if (typeof ds.slot === 'string') {
    const i = ds.slot.lastIndexOf(':');
    if (i <= 0) return null;
    const actId = ds.slot.slice(0, i);
    const idx = Number(ds.slot.slice(i + 1));
    if (!/^\d+$/.test(ds.slot.slice(i + 1)) || !Number.isInteger(idx)) return null;
    return { kind: 'slot', actId, idx };
  }
  return null;
}

// The live slot object behind a `blockRef` (or null): the drag preview patches
// it in place exactly as the template drag patches store.events.
const slotOf = ref => {
  const act = plan.data && (plan.data.activities || []).find(a => a.id === ref.actId);
  const s = act && Array.isArray(act.slots) ? act.slots[ref.idx] : null;
  return s || null;
};
```

In `renderGrid()`, after `const canDrag = !store.locked && dragOK();` add:

```js
  const slots = plan.data ? gridSlots(plan.data.activities) : [];
```

and after the line `store.events.filter(e => e.day === di).forEach(ev => { col += evtHTML(ev, PH, { handle: canDrag }); });` add:

```js
    slots.filter(b => b.day === di).forEach(b => { col += slotHTML(b, PH, { handle: canDrag }); });
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/*.test.mjs 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `tests 372` / `pass 372` / `fail 0`

- [ ] **Step 5: Commit**

```bash
git add js/grid.js tests/grid.test.mjs
git commit -m "grid: render planner slots as first-class blocks; blockRef() identity

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KP54gc9RG6WQccxBqECYCG"
```

---

### Task 4: drag / resize a slot

**Files:**
- Modify: `js/grid.js` — replace everything from `export function initGrid() {` to the end of `onCancel` (currently lines ~66–154)
- Modify: `js/plan/tabs.js` (~line 108, inside `initPlanner`)

No new unit test: the pointer math is DOM-bound and unchanged; identity (`blockRef`) and persistence (`setSlot`) are covered by Tasks 2–3, and Task 6 verifies the rendered DOM. Keep every existing template behaviour byte-for-byte.

- [ ] **Step 1: Replace the interaction block**

Replace from `export function initGrid() {` through the end of `function onCancel() { … }` with:

```js
export function initGrid() {
  const grid = document.getElementById('grid');

  grid.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (store.locked || !dragOK()) return;
    const evtEl = e.target.closest('.evt');
    if (!evtEl) return;
    const ref = blockRef(evtEl.dataset);
    if (!ref) return;                       // a one-off ghost, or nothing we own
    e.preventDefault();
    const base = { kind: ref.kind, ref, moved: false, startX: e.clientX, startY: e.clientY };
    if (ref.kind === 'event') {
      const ev = store.events.find(x => x.id === ref.id);
      if (!ev) return;
      base.id = ref.id;
      base.sel = `[data-id="${ref.id}"]`;
      if (e.target.closest('.rh')) {
        const col = grid.querySelector(`.ca[data-day="${ev.day}"]`);
        ptr = { ...base, type: 'resize', colRect: col.getBoundingClientRect() };
      } else {
        const rect = evtEl.getBoundingClientRect();
        ptr = {
          ...base, type: 'move',
          offsetH: (e.clientY - rect.top) / PH,
          duration: ev.end - ev.start,
          // Column rects are snapshotted at drag start; scrolling mid-drag makes them
          // stale (worst case: drop lands on the wrong day). Accepted for simplicity.
          rects: colRects(grid),
        };
      }
    } else {
      // Planner slot: same math, different store. The preview patches the live
      // slot object in place (as the template path patches store.events); the
      // drop commits it through setSlot, a cancel restores `orig`.
      const s = slotOf(ref);
      if (!s) return;
      base.orig = { day: s.day, start: s.start, end: s.end };
      base.sel = `[data-slot="${ref.actId}:${ref.idx}"]`;
      if (e.target.closest('.rh')) {
        const col = grid.querySelector(`.ca[data-day="${s.day}"]`);
        ptr = { ...base, type: 'resize', colRect: col.getBoundingClientRect() };
      } else {
        const rect = evtEl.getBoundingClientRect();
        ptr = {
          ...base, type: 'move',
          offsetH: (e.clientY - rect.top) / PH,
          duration: s.end - s.start,
          rects: colRects(grid),
        };
      }
    }
    evtEl.classList.add('ghost');
    document.addEventListener('pointermove', onMove, { passive: false });
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
  });

  // Tap/click select for coarse pointers and non-drag clicks. Selection (and
  // the editor it opens) is template-only: a planner slot's times are changed
  // by dragging, its everything-else in the planner.
  grid.addEventListener('click', e => {
    if (suppressClick) { suppressClick = false; return; }
    const evtEl = e.target.closest('.evt');
    if (!evtEl || store.locked) return;
    const ref = blockRef(evtEl.dataset);
    if (ref && ref.kind === 'event') toggleSelect(ref.id);
  });
}

function toggleSelect(id) {
  store.selId = store.selId === id ? null : id;
  store.addMode = false;
  notify();
}

function onMove(e) {
  if (!ptr) return;
  e.preventDefault();
  if (Math.abs(e.clientX - ptr.startX) > 3 || Math.abs(e.clientY - ptr.startY) > 3) ptr.moved = true;
  if (ptr.kind === 'slot') {
    const s = slotOf(ptr.ref);
    if (!s) return;
    if (ptr.type === 'move') {
      const di = dayAtX(e.clientX, ptr.rects);
      if (di < 0) return;
      const r = ptr.rects[di];
      const ns = clampStart(snap(S + (e.clientY - r.top) / PH - ptr.offsetH), ptr.duration);
      s.day = di; s.start = ns; s.end = ns + ptr.duration;
    } else {
      s.end = clampEnd(s.start, snap(S + (e.clientY - ptr.colRect.top) / PH));
    }
  } else if (ptr.type === 'move') {
    const di = dayAtX(e.clientX, ptr.rects);
    if (di < 0) return;
    const r = ptr.rects[di];
    const ns = clampStart(snap(S + (e.clientY - r.top) / PH - ptr.offsetH), ptr.duration);
    store.events = store.events.map(x => (x.id === ptr.id ? { ...x, day: di, start: ns, end: ns + ptr.duration } : x));
  } else {
    const ev = store.events.find(x => x.id === ptr.id);
    if (!ev) return;
    const ne = clampEnd(ev.start, snap(S + (e.clientY - ptr.colRect.top) / PH));
    store.events = store.events.map(x => (x.id === ptr.id ? { ...x, end: ne } : x));
  }
  renderGrid();
  document.querySelector(`#grid .evt${ptr.sel}`)?.classList.add('ghost');
}

function onUp() {
  if (!ptr) return;
  const { moved, kind, id, ref } = ptr;
  ptr = null;
  document.removeEventListener('pointermove', onMove);
  document.removeEventListener('pointerup', onUp);
  document.removeEventListener('pointercancel', onCancel);
  suppressClick = true; // the browser fires a click right after pointerup; we've handled it
  if (kind === 'slot') {
    const s = moved ? slotOf(ref) : null;
    // setSlot → commit → planNotify → tabs.js re-renders the grid (ghost gone).
    if (s) setSlot(ref.actId, ref.idx, { day: s.day, start: s.start, end: s.end });
    else renderGrid();                    // no move: just drop the ghost styling
  } else if (moved) { notify(); save(); }
  else toggleSelect(id);
}

function onCancel() {
  if (!ptr) return;
  const { kind, ref, orig } = ptr;
  ptr = null;
  document.removeEventListener('pointermove', onMove);
  document.removeEventListener('pointerup', onUp);
  document.removeEventListener('pointercancel', onCancel);
  if (kind === 'slot') { const s = slotOf(ref); if (s && orig) Object.assign(s, orig); }
  renderGrid(); // clears ghost styling (and, for a slot, restores the preview)
}
```

- [ ] **Step 2: Re-render the grid on plan changes**

`js/plan/tabs.js` already imports `isDragging` from `'../grid.js'` (line 8). Change that import to:

```js
import { isDragging, renderGrid } from '../grid.js';
```

Inside `initPlanner()`, directly after the line `onPlanChange(renderViews);` (~line 108), add:

```js
  // Planner slots are native grid blocks now (js/grid.js), so a plan change —
  // a slot drop, a bot write, a Claude session moving a slot — must rebuild the
  // grid too. Never under a drag: a rebuild shifts layout under the cursor and
  // corrupts drop math (the same reason applyOverlay bails on isDragging).
  onPlanChange(() => { if (!isDragging()) renderGrid(); });
```

- [ ] **Step 3: Run all tests (no regressions)**

Run: `node --test tests/*.test.mjs 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `tests 372` / `pass 372` / `fail 0`

- [ ] **Step 4: Syntax check the browser-only file**

Run: `node --check js/grid.js && node --check js/plan/tabs.js && echo OK`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add js/grid.js js/plan/tabs.js
git commit -m "grid: planner slots drag/resize when unlocked; drop commits via setSlot

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KP54gc9RG6WQccxBqECYCG"
```

---

### Task 5: Day view parity + status dots (overlay.js)

**Files:**
- Modify: `js/plan/overlay.js` (imports line 7; add `applySlots` after `applyOneOffs`; `applyOverlay` body ~lines 118–145)
- Modify: `css/plan.css` (after the `.ov-tag` rule, ~line 357)
- Test: `tests/plan-overlay.test.mjs` (append at end)

- [ ] **Step 1: Write the failing tests**

Append to `tests/plan-overlay.test.mjs` (uses the file's own `FakeNode`, `makeDom`, `loadPlan`, `dotsOf`, `applyOverlay`, `plan`, `store`, `mondayOf`, `addDays`, `todayStr`):

```js
const GEO = () => ({
  id: 'geography', name: 'Geography', type: 'external', status: 'active', cls: 'g', onGrid: true,
  slots: [{ day: 2, start: 11, end: 12 }], chain: [],
});

function slotNode(key, cls = 'g') {
  const el = new FakeNode('div');
  el.className = `evt ${cls} pslot`;
  el.attrs['data-slot'] = key;
  return el;
}
const ovSlots = root => root.querySelectorAll('.ov-slot');

test('slots: overlay draws a read-only slot block into #dayview only — the grid renders its own', () => {
  loadPlan([], [], [GEO()]);
  store.events = [];
  const { doc, grid, dayview, dayCol } = makeDom([], [], 2);      // Day view showing Wednesday
  globalThis.document = doc;
  applyOverlay();
  const drawn = ovSlots(dayview);
  assert.equal(drawn.length, 1);
  assert.equal(drawn[0].attrs['data-slot'], 'geography:0');
  assert.equal(drawn[0].className, 'evt g pslot ov-slot');
  assert.equal(drawn[0].style.top, `${(11 - 9) * 62 + 1}px`);
  assert.equal(drawn[0].style.height, `${62 - 2}px`);
  assert.match(drawn[0].innerHTML, /Geography/);
  assert.match(drawn[0].innerHTML, /11am&ndash;12pm/);
  assert.equal(drawn[0].parentNode, dayCol);
  assert.equal(ovSlots(grid).length, 0);
});

test('slots: a Day view showing another day draws nothing; re-apply never duplicates', () => {
  loadPlan([], [], [GEO()]);
  store.events = [];
  const { doc, dayview } = makeDom([], [], 3);                   // Thursday
  globalThis.document = doc;
  applyOverlay();
  assert.equal(ovSlots(dayview).length, 0);
  const wed = makeDom([], [], 2);
  globalThis.document = wed.doc;
  applyOverlay(); applyOverlay();
  assert.equal(ovSlots(wed.dayview).length, 1);
});

test('slots: a timed activityId log row dots the slot block in BOTH roots, one dot per (activity, date)', () => {
  const wed = addDays(mondayOf(todayStr()), 2);
  loadPlan([
    { date: wed, activityId: 'geography', status: 'done' },
    { date: wed, activityId: 'geography', status: 'done', curriculum: 'geo-1', session: 0 },  // same day again
  ], [], [GEO()]);
  store.events = [];
  const { doc, cols, dayview } = makeDom([], [], 2);
  globalThis.document = doc;
  const native = cols[2].appendChild(slotNode('geography:0'));   // what renderGrid() now draws
  applyOverlay();
  assert.deepEqual(dotsOf(native).map(d => d.className), ['ov-dot ov-done']);
  const drawn = ovSlots(dayview)[0];
  assert.deepEqual(dotsOf(drawn).map(d => d.className), ['ov-dot ov-done']);
});

test('slots: the weekday guard drops a dot whose logged date disagrees with the slot\'s current day', () => {
  const thu = addDays(mondayOf(todayStr()), 3);
  loadPlan([{ date: thu, activityId: 'geography', status: 'partial' }], [], [GEO()]);   // slot is Wednesday
  store.events = [];
  const { doc, cols } = makeDom([], [], 2);
  globalThis.document = doc;
  const native = cols[2].appendChild(slotNode('geography:0'));
  applyOverlay();
  assert.equal(dotsOf(native).length, 0);
});

test('slots: eventId rows never dot a slot block; template dots are unaffected', () => {
  const wed = addDays(mondayOf(todayStr()), 2);
  loadPlan([{ date: wed, eventId: 'e1003', status: 'done' }], [], [GEO()]);
  store.events = [{ id: 'e1003', cat: 'quran', day: 2, start: 10, end: 11 }];
  const { doc, cols, els } = makeDom([{ id: 'e1003', day: 2 }], [], 2);
  globalThis.document = doc;
  const native = cols[2].appendChild(slotNode('geography:0'));
  applyOverlay();
  assert.equal(dotsOf(native).length, 0);
  assert.equal(dotsOf(els.grid.e1003).length, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/plan-overlay.test.mjs 2>&1 | grep -E "^not ok" | head -5`
Expected: the five new tests `not ok` (no `.ov-slot` drawn, no dots on `data-slot` blocks).

- [ ] **Step 3: Implement**

`js/plan/overlay.js` line 7 — change the import to:

```js
import { todayStr, mondayOf, addDays, dayIdx, findClashes, gridSlots } from './model.js';
```

After `applyOneOffs` (after its closing `}`), add:

```js
// ── Planner slots in the Day view ────────────────────────────
// js/grid.js renders on-grid planner slots natively (draggable there). The
// Day view (frozen js/dayview.js) cannot, so the same blocks are drawn here —
// into #dayview ONLY; drawing them into #grid would duplicate. Read-only:
// `.ov-slot` is pointer-events:none in css/plan.css (the Day view has no drag;
// a slot's times are edited on the desktop grid). Metrics come off the column
// height exactly like the one-offs; identity is the same `data-slot`.
function applySlots(root, blocks) {
  if (!blocks.length) return;
  for (const ca of root.querySelectorAll('.ca')) {
    const day = Number(ca.getAttribute('data-day'));
    const ph = parseFloat(ca.style && ca.style.height) / (E - S);
    if (!Number.isFinite(day) || !Number.isFinite(ph) || ph <= 0) continue;
    for (const b of blocks) {
      if (b.day !== day) continue;
      const height = (b.bottom - b.top) * ph;
      const el = document.createElement('div');
      el.className = `evt ${b.cls} pslot ov-slot`;
      el.setAttribute('data-slot', `${b.actId}:${b.idx}`);
      el.style.top = `${(b.top - S) * ph + 1}px`;
      el.style.height = `${height - 2}px`;
      el.innerHTML = `<div class="et">${esc(b.name)}</div>` +
        `<div class="en">${fmt(b.start)}&ndash;${fmt(b.end)}</div>` +
        (b.note && height > 46 ? `<div class="en note">${esc(b.note)}</div>` : '');
      ca.appendChild(el);
    }
  }
}
```

In `applyOverlay()`, change the clearing loop to also drop overlay-drawn slots:

```js
    for (const root of roots) {
      root.querySelectorAll('.ov-oneoff').forEach(n => n.remove());
      root.querySelectorAll('.ov-slot').forEach(n => n.remove());
      root.querySelectorAll('.ov-dot').forEach(n => n.remove());
    }
```

Directly after `for (const root of roots) applyOneOffs(root, oneOffs);` add:

```js
    const slots = gridSlots(plan.data.activities);
    const dayview = document.getElementById('dayview');
    if (dayview) applySlots(dayview, slots);
```

Directly after the existing `for (const e of plan.data.log) { … }` dot loop (before `renderClashBanner();`), add:

```js
    // Slot dots: a timed log row for an on-grid activity carries activityId
    // and no eventId (logTimed's slot shape; a paced row on that day counts
    // too). Same weekday-agreement guard as template dots, and one dot per
    // (activity, date) — a Geography lesson logged twice on Wednesday is still
    // one Wednesday.
    const dotted = new Set();
    for (const e of plan.data.log) {
      if (e.eventId || !e.activityId || e.date < mon || e.date > sun) continue;
      const key = `${e.activityId}|${e.date}`;
      if (dotted.has(key)) continue;
      const d = dayIdx(e.date);
      for (const b of slots) {
        if (b.actId !== e.activityId || b.day !== d) continue;
        dotted.add(key);
        for (const root of roots) {
          root.querySelectorAll(`.evt[data-slot="${cssEsc(`${b.actId}:${b.idx}`)}"]`)
            .forEach(el => el.appendChild(dotNode(e.status)));
        }
      }
    }
```

`css/plan.css` — after the `.ov-tag { … }` rule (before the `@media print { .ov-oneoff … }` line), add:

```css
/* Planner slots drawn into the Day view by overlay.js. Read-only there: the
   Day view has no drag, and its tap handler keys off data-id (template only).
   The grid's own `.pslot` blocks are native, carry no `ov-slot`, and drag. */
.evt.ov-slot { pointer-events: none; cursor: default; }
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/*.test.mjs 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `tests 377` / `pass 377` / `fail 0`

- [ ] **Step 5: Commit**

```bash
git add js/plan/overlay.js css/plan.css tests/plan-overlay.test.mjs
git commit -m "overlay: planner slots in the Day view + status dots on data-slot blocks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KP54gc9RG6WQccxBqECYCG"
```

---

### Task 6: Headless-Chrome verification (DOM + print) against the real data

**Files:** throwaway only — `_seed.html`, `_sched.json`, `_plan.json` at the repo root, deleted at the end. Nothing committed.

Rationale: `/api/*` does not exist on a local static server, so the app falls back to localStorage. Seed localStorage with the LIVE blobs under a persistent Chrome profile, then dump the DOM and print.

- [ ] **Step 1: Fetch live blobs and write the seed page**

```bash
cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule"
curl -s https://aoifes-schedule.vercel.app/api/get > _sched.json
curl -s https://aoifes-schedule.vercel.app/api/plan-get > _plan.json
cat > _seed.html <<'EOF'
<!doctype html><meta charset="utf-8"><body><script type="module">
const s = await (await fetch('/_sched.json')).json();
const p = await (await fetch('/_plan.json')).json();
localStorage.setItem('aoife_v3', JSON.stringify({ events: s.events, altSun: s.altSun, catLabels: s.catLabels }));
localStorage.setItem('aoife_plan_v1', JSON.stringify(p));
document.body.textContent = 'SEEDED';
</script></body>
EOF
python3 -m http.server 8787 >/dev/null 2>&1 &
echo $! > /private/tmp/claude-501/-Users-jalalchowdhury-concierge/5b95cf9f-001b-4777-9969-8e134ac7550a/scratchpad/http.pid
```

- [ ] **Step 2: Seed, dump DOM, count blocks**

```bash
SP=/private/tmp/claude-501/-Users-jalalchowdhury-concierge/5b95cf9f-001b-4777-9969-8e134ac7550a/scratchpad
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
UD=$SP/chrome-probe; rm -rf "$UD"
"$CH" --headless=new --disable-gpu --user-data-dir="$UD" --virtual-time-budget=4000 --dump-dom http://localhost:8787/_seed.html 2>/dev/null | grep -c SEEDED
"$CH" --headless=new --disable-gpu --user-data-dir="$UD" --virtual-time-budget=8000 --dump-dom http://localhost:8787/ 2>/dev/null > $SP/dom.html
echo "native grid slot blocks:"; grep -o 'class="evt [a-z]* pslot"' $SP/dom.html | wc -l
echo "slot identities:";        grep -o 'data-slot="[^"]*"' $SP/dom.html | sort | uniq -c
echo "template blocks:";        grep -o 'class="evt [a-z]*" data-id' $SP/dom.html | wc -l
```

Expected: `1` (seeded); native grid slot blocks `3`; identities `geography:0`, `jj:0`, `science:0` (the `geography:0`/`science:0` lines may show `2` because the Day view — if it is showing Wednesday — carries an `ov-slot` twin; `jj:0` likewise on Monday); template blocks `8` or `9` (8 in #grid + up to 1 in #dayview).

- [ ] **Step 3: Print re-verify (hard rule 2: one page, everything on it)**

```bash
"$CH" --headless=new --disable-gpu --user-data-dir="$UD" --no-pdf-header-footer --virtual-time-budget=8000 --print-to-pdf=$SP/site-week.pdf http://localhost:8787/ 2>/dev/null
pdfinfo $SP/site-week.pdf | grep Pages
for n in "Quran" "Ruhama" "Miss Hala" "Jumu'ah" "Jiu Jitsu" "Geography" "Foundations of Inquiry"; do
  printf '%-24s %s\n' "$n" "$(pdftotext $SP/site-week.pdf - | grep -c "$n")"; done
```

Expected: `Pages: 1`; every count ≥ 1 (Quran 3, Ruhama 5, Miss Hala 2, Jumu'ah 1, Jiu Jitsu 1, Geography 1, Foundations of Inquiry 1). If a count is 0 or Pages is 2, STOP and report — do not bump stamps or deploy.

- [ ] **Step 4: Clean up**

```bash
kill "$(cat $SP/http.pid)"; rm -f _seed.html _sched.json _plan.json
git status --short   # must be empty
```

---

### Task 7: Release — stamps, AGENTS.md, push, deploy check

**Files:**
- Modify: `index.html` (the five `?v=2026-08-31-8` URLs — lines 20–23 and 79)
- Modify: `AGENTS.md` (architecture line 25; "One-off blocks" section; new section)

- [ ] **Step 1: Bump the asset stamps (hard rule 3)**

```bash
cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule"
sed -i '' 's/?v=2026-08-31-8/?v=2026-09-01-2/g' index.html
grep -c '?v=2026-09-01-2' index.html
```

Expected: `5`

- [ ] **Step 2: Update AGENTS.md**

Line 25, replace

```
- js/grid.js — week grid render, drag/resize/select (fine pointers only)
```

with

```
- js/grid.js — week grid render, drag/resize/select (fine pointers only); since
  2026-09-01 also renders on-grid planner slots as `.evt.pslot[data-slot]`
  blocks (see "Planner slots on the grid") and drags them through setSlot
```

In the "## One-off blocks on the grid (planner-v2.5)" section, replace the parenthetical

```
  `pointer-events: none` (the app's drag/edit only ever moves the recurring
  template; a one-off is managed from Today or the bot).
```

with

```
  `pointer-events: none` (the app's drag/edit moves the recurring template and,
  since 2026-09-01, planner slots — never a one-off, which is managed from
  Today or the bot).
```

Then add this section directly after the "One-off blocks" section:

```
## Planner slots on the grid (2026-09-01)
Spec: docs/superpowers/specs/2026-09-01-grid-planner-slots-design.md. Before
this, the desktop Week grid and the one-page print showed ONLY
`aoifes_schedule.events`; on-grid planner activities (`status:'active' &&
onGrid && slots[]` — Jiu Jitsu, Geography, Science) reached the phone views and
Google Calendar via `buildTimed`/`activity_slot_events` but never the grid.
- `gridSlots(activities)` (js/plan/model.js, pure) → one block per valid slot,
  `(actId, idx)` = identity, 9–17 clamp rules identical to the one-off ghosts,
  `note` = the paced chain's next-session label.
- `renderGrid()` draws them with `slotHTML()`: class `evt <cls> pslot`,
  **`data-slot="<actId>:<idx>"` and NEVER `data-id`** (that is the template's
  identity — editor, dot sweep and template drag all key off it). `.pslot` is
  a marker only; no visual difference. They print (they ARE the recurring week).
- Drag/resize: `blockRef(dataset)` resolves `{kind:'event'}` vs `{kind:'slot'}`;
  a slot drag previews by patching the live slot object in place and the drop
  calls `setSlot(actId, idx, {day,start,end})` (js/plan/state.js → commit).
  Same lock (`store.locked`), same fine-pointer gate, same `holdSync(isDragging)`
  guard. A pointercancel restores `ptr.orig`. Click/select stays template-only:
  tapping a slot on touch does nothing (known limit — desktop drag only).
- tabs.js re-renders the grid on every `onPlanChange` (never mid-drag) so a bot
  or Claude-session slot change reaches the grid without waiting for the 60s tick.
- Day view parity: js/dayview.js stays frozen; overlay.js `applySlots` draws the
  selected day's slots into #dayview ONLY (class adds `ov-slot`, pointer-events
  none). Never into #grid — it renders them natively; drawing both duplicates.
- Dots: log rows with `activityId` and no `eventId` decorate
  `.evt[data-slot="<actId>:<idx>"]` in both roots, weekday-agreement guarded,
  one dot per (activity, date).
- Calendar: the sync keys these `act:<actId>:<idx>`; a drag keeps the index, so
  the reconciler PATCHES the recurring event. Never re-pack `slots[]`.
```

- [ ] **Step 3: Run the full suite one last time**

Run: `node --test tests/*.test.mjs 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `tests 377` / `pass 377` / `fail 0`

- [ ] **Step 4: Commit and push**

```bash
git add index.html AGENTS.md
git commit -m "release: planner slots on the week grid (stamps 2026-09-01-2) + AGENTS.md

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KP54gc9RG6WQccxBqECYCG"
git push origin main
```

- [ ] **Step 5: Confirm the deploy reached production**

Vercel deploys from the push, but the GitHub integration has skipped a push before (AGENTS.md open item). Poll for up to ~3 minutes:

```bash
for i in $(seq 1 18); do
  n=$(curl -s https://aoifes-schedule.vercel.app/ | grep -c '?v=2026-09-01-2')
  [ "$n" = "5" ] && { echo "LIVE after ${i}0s"; break; }
  sleep 10
done
curl -s https://aoifes-schedule.vercel.app/ | grep -c '?v=2026-09-01-2'
```

Expected: `LIVE after …` and `5`. If still `0` after the loop, deploy by CLI from the repo root: `vercel --prod` (the fallback documented in AGENTS.md), then re-run the curl.

- [ ] **Step 6: Live smoke — the production DOM now carries the three slots**

```bash
SP=/private/tmp/claude-501/-Users-jalalchowdhury-concierge/5b95cf9f-001b-4777-9969-8e134ac7550a/scratchpad
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --virtual-time-budget=10000 --dump-dom https://aoifes-schedule.vercel.app/ 2>/dev/null | grep -o 'data-slot="[^"]*"' | sort -u
```

Expected: `data-slot="geography:0"`, `data-slot="jj:0"`, `data-slot="science:0"`.
