# Aoife's Schedule v2 Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Aoife's Schedule front end (dark/light/auto theme, mobile day view with Day⇄Week toggle, refined-minimal design) with zero feature loss and zero data loss.

**Architecture:** Replace the single-file `index.html` with a static multi-file app: `index.html` shell + `css/` (tokens, app, print) + `js/` ES modules (pure model, state/persistence, week grid, mobile day view, editor, theme, print). No build step, no dependencies. The `/api/get` + `/api/save` functions and the data contract (localStorage `aoife_v3`, KV key `aoifes_schedule`, shape `{events, altSun, catLabels}`) are **untouched**.

**Tech Stack:** Vanilla HTML/CSS/JS (ES modules), Node's built-in `node --test` for pure-logic tests, Vercel static hosting + existing serverless functions.

**Spec:** `docs/superpowers/specs/2026-07-20-schedule-v2-rebuild-design.md`

**Critical rules for the executor:**
- Repo root: `/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule` (note the space and apostrophe — always quote paths).
- Commit to `main` after every task, but **DO NOT `git push` until the final task**. Pushing deploys to production via Vercel.
- Never modify `api/get.js`, `api/save.js`, or `aoife_schedule_3.html`.
- The old `index.html` is fully replaced in Task 2 — that is intentional and approved (data lives in KV/localStorage, not the HTML; user also has a PDF backup).
- Manual browser checks use: `cd "<repo root>" && python3 -m http.server 8080` then open `http://localhost:8080`. The `/api/get` fetch will 501/404 under http.server — that is the offline degradation path and is expected; the app must still work from defaults/localStorage.

---

### Task 1: Pure data model (`js/model.js`) with node tests

**Files:**
- Create: `js/model.js`
- Test: `tests/model.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/model.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAYS, S, E, SPH, PPH, CATS, fmt, snap, clampStart, clampEnd,
  todayIndex, defEvents, maxIdNum, serialize, applyAltSun, esc,
} from '../js/model.js';

test('constants match the v1 contract', () => {
  assert.deepEqual(DAYS, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.equal(S, 9);
  assert.equal(E, 17);
  assert.equal(SPH, 66);
  assert.equal(PPH, 78);
  assert.deepEqual(Object.keys(CATS), ['quran', 'ruhamah', 'hala', 'barakot', 'art', 'other']);
});

test('fmt renders 12-hour times', () => {
  assert.equal(fmt(9), '9am');
  assert.equal(fmt(10.5), '10:30am');
  assert.equal(fmt(12), '12pm');
  assert.equal(fmt(13), '1pm');
  assert.equal(fmt(16.5), '4:30pm');
});

test('snap rounds to half hours', () => {
  assert.equal(snap(10.2), 10);
  assert.equal(snap(10.3), 10.5);
  assert.equal(snap(10.76), 11);
});

test('clamps keep events inside 9-17', () => {
  assert.equal(clampStart(8, 1), 9);          // too early -> 9
  assert.equal(clampStart(16.5, 1), 16);      // 1h event can start at 16 latest
  assert.equal(clampEnd(10, 9), 10.5);        // end can never be <= start
  assert.equal(clampEnd(10, 20), 17);         // end capped at 17
});

test('todayIndex maps JS getDay (Sun=0) to Mon-first index', () => {
  assert.equal(todayIndex(0), 6); // Sunday
  assert.equal(todayIndex(1), 0); // Monday
  assert.equal(todayIndex(6), 5); // Saturday
});

test('defEvents matches the v1 default schedule', () => {
  const evs = defEvents();
  assert.equal(evs.length, 12);
  for (const e of evs) {
    assert.deepEqual(Object.keys(e).sort(), ['cat', 'day', 'end', 'id', 'name', 'note', 'start']);
    assert.match(e.id, /^e\d+$/);
  }
  assert.equal(evs.filter(e => e.cat === 'quran').length, 3);
  assert.equal(evs.filter(e => e.cat === 'ruhamah').length, 5);
  assert.equal(evs.filter(e => e.cat === 'hala').length, 3);
  assert.equal(evs.filter(e => e.cat === 'barakot').length, 1);
});

test('maxIdNum finds the highest numeric id', () => {
  assert.equal(maxIdNum([{ id: 'e3' }, { id: 'e11' }, { id: 'e7' }]), 11);
  assert.equal(maxIdNum([]), 0);
});

test('serialize produces the exact v1 storage shape', () => {
  const state = { events: defEvents(), altSun: true, catLabels: { quran: 'Q' }, junk: 'ignored' };
  const parsed = JSON.parse(serialize(state));
  assert.deepEqual(Object.keys(parsed), ['events', 'altSun', 'catLabels']);
  assert.equal(parsed.altSun, true);
  assert.deepEqual(parsed.catLabels, { quran: 'Q' });
  assert.equal(parsed.events.length, 12);
});

test('applyAltSun toggles the Sunday Ruhamah slot both ways', () => {
  const alt = applyAltSun(defEvents(), true);
  const sun = alt.find(e => e.cat === 'ruhamah' && e.day === 6);
  assert.equal(sun.start, 10);
  assert.equal(sun.end, 12);
  assert.equal(sun.note, 'Alt Sunday — Ruhamah at 10am');
  const back = applyAltSun(alt, false).find(e => e.cat === 'ruhamah' && e.day === 6);
  assert.equal(back.start, 11);
  assert.equal(back.end, 13);
  assert.equal(back.note, 'Regular Sun — every other week at 10am');
});

test('esc neutralizes HTML metacharacters', () => {
  assert.equal(esc('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule" && node --test tests/`
Expected: FAIL — `Cannot find module ... js/model.js`

- [ ] **Step 3: Write the implementation**

Create `js/model.js`:

```js
// Pure data model — no DOM, no storage. Imported by the app and by Node tests.
// The event shape and category keys are the v1 storage contract: DO NOT CHANGE.

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const S = 9;      // grid start hour (9am)
export const E = 17;     // grid end hour (5pm)
export const SPH = 66;   // screen pixels per hour
export const PPH = 78;   // print pixels per hour

export const CATS = {
  quran:   { label: 'Quran',                                  cls: 'q'  },
  ruhamah: { label: 'Ruhama — ELA/Math',                 cls: 'r'  },
  hala:    { label: 'Miss Hala — Arabic/Islamic Studies', cls: 'h' },
  barakot: { label: 'Barrington trip',                        cls: 'b'  },
  art:     { label: 'Art Class with Ayra',                    cls: 'a'  },
  other:   { label: 'Other',                                  cls: 'ot' },
};

export function fmt(h) {
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60), ap = hh >= 12 ? 'pm' : 'am';
  const h12 = hh > 12 ? hh - 12 : hh === 0 ? 12 : hh;
  return mm ? `${h12}:${String(mm).padStart(2, '0')}${ap}` : `${h12}${ap}`;
}

export const snap = h => Math.round(h * 2) / 2;
export const clampStart = (start, dur) => Math.max(S, Math.min(E - dur, start));
export const clampEnd = (start, end) => Math.max(start + 0.5, Math.min(E, end));

// JS Date.getDay() (Sun=0) -> Mon-first index (Mon=0 ... Sun=6)
export const todayIndex = jsDay => (jsDay + 6) % 7;

export const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function defEvents() {
  let n = 0;
  const uid = () => `e${++n}`;
  return [
    ...[0, 2, 4].map(d => ({ id: uid(), cat: 'quran', day: d, start: 10, end: 11, note: '', name: '' })),
    { id: uid(), cat: 'ruhamah', day: 0, start: 11, end: 13, note: '2-hr session', name: '' },
    { id: uid(), cat: 'ruhamah', day: 1, start: 11, end: 12, note: '', name: '' },
    { id: uid(), cat: 'ruhamah', day: 3, start: 11, end: 12, note: '', name: '' },
    { id: uid(), cat: 'ruhamah', day: 5, start: 11, end: 13, note: '2-hr session', name: '' },
    { id: uid(), cat: 'ruhamah', day: 6, start: 11, end: 13, note: 'Regular Sun — every other week at 10am', name: '' },
    ...[1, 2, 3].map(d => ({ id: uid(), cat: 'hala', day: d, start: 14, end: 16, note: '', name: '' })),
    { id: uid(), cat: 'barakot', day: 6, start: 9, end: 10, note: 'Mostly Sundays', name: 'Barrington trip' },
  ];
}

export const maxIdNum = events =>
  events.reduce((mx, e) => Math.max(mx, parseInt(String(e.id).replace('e', ''), 10) || 0), 0);

export const serialize = ({ events, altSun, catLabels }) =>
  JSON.stringify({ events, altSun, catLabels });

export const applyAltSun = (events, altSun) =>
  events.map(ev =>
    ev.cat === 'ruhamah' && ev.day === 6
      ? altSun
        ? { ...ev, start: 10, end: 12, note: 'Alt Sunday — Ruhamah at 10am' }
        : { ...ev, start: 11, end: 13, note: 'Regular Sun — every other week at 10am' }
      : ev
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule" && node --test tests/`
Expected: all tests PASS (10 pass, 0 fail)

- [ ] **Step 5: Commit**

```bash
cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule"
git add js/model.js tests/model.test.mjs
git commit -m "feat: add pure data model with node tests (v1 contract preserved)"
```

---

### Task 2: Static shell — `index.html`, theme tokens, full app CSS, SVG icon

This task replaces the old single-file app with the new shell. The page will render header + empty containers only; JS modules arrive in later tasks. Screenshot-level design decisions (spacing, radius, palette) are final here.

**Files:**
- Replace: `index.html`
- Create: `css/tokens.css`, `css/app.css`, `icon.svg`

- [ ] **Step 1: Create `css/tokens.css`**

```css
/* Theme tokens. html[data-theme] is set before first paint by an inline
   script in index.html and toggled by js/theme.js. */
:root {
  --accent: #4f46e5;
  --now: #ef4444;
  --radius: 12px;
}

html[data-theme='light'] {
  --bg: #f7f7f5;
  --bg-grid: #ffffff;
  --bg-panel: #ffffff;
  --bg-input: #ffffff;
  --line: #ececea;
  --border: #e0dfdb;
  --text: #1b1b20;
  --text-sub: #5f5f6b;
  --text-muted: #a0a0aa;
  --text-week: #71717d;
  --text-wkend: #2563eb;
  --today-col: #f4f4fb;
  --accent-soft: #6366f1;
  --shadow: 0 1px 3px rgba(20, 20, 25, .06), 0 4px 16px rgba(20, 20, 25, .05);
  --backdrop: rgba(0, 0, 0, .25);
  --danger-bg: #fee2e2;
  --danger-border: #fecaca;
  --danger-text: #b91c1c;
}

html[data-theme='dark'] {
  --bg: #0e0e11;
  --bg-grid: #131316;
  --bg-panel: #1a1a1e;
  --bg-input: #222226;
  --line: #222226;
  --border: #2e2e34;
  --text: #f0f0f5;
  --text-sub: #8f8fa0;
  --text-muted: #55555f;
  --text-week: #6b6b7f;
  --text-wkend: #60a5fa;
  --today-col: #16161c;
  --accent-soft: #818cf8;
  --shadow: none;
  --backdrop: rgba(0, 0, 0, .55);
  --danger-bg: #3f1010;
  --danger-border: #7f1d1d;
  --danger-text: #f87171;
}

/* Category tokens: --eb block fill, --el edge/accent, --et text.
   Same six categories as v1; values tuned per theme for contrast. */
html[data-theme='dark'] .q  { --eb: #0D3D2A; --el: #1D9E75; --et: #9FE1CB; }
html[data-theme='dark'] .r  { --eb: #1E1849; --el: #7F77DD; --et: #CECBF6; }
html[data-theme='dark'] .h  { --eb: #3D1208; --el: #D85A30; --et: #F5C4B3; }
html[data-theme='dark'] .b  { --eb: #351D02; --el: #EF9F27; --et: #FAC775; }
html[data-theme='dark'] .a  { --eb: #3D1020; --el: #D4537E; --et: #F4C0D1; }
html[data-theme='dark'] .ot { --eb: #051E38; --el: #378ADD; --et: #B5D4F4; }

html[data-theme='light'] .q  { --eb: #DEF4E8; --el: #12805F; --et: #0A4536; }
html[data-theme='light'] .r  { --eb: #E4E1FB; --el: #5A50C4; --et: #2B2566; }
html[data-theme='light'] .h  { --eb: #FBDCCE; --el: #B0431F; --et: #571F0D; }
html[data-theme='light'] .b  { --eb: #FCE8C2; --el: #96590A; --et: #4A2902; }
html[data-theme='light'] .a  { --eb: #FAD9E5; --el: #AB3A60; --et: #571830; }
html[data-theme='light'] .ot { --eb: #D8E8FA; --el: #1D66B0; --et: #093159; }
```

- [ ] **Step 2: Create `css/app.css`**

```css
* { box-sizing: border-box; margin: 0; padding: 0; }
html { -webkit-text-size-adjust: 100%; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  padding: 14px clamp(12px, 3vw, 24px) calc(20px + env(safe-area-inset-bottom));
  transition: background .25s, color .25s;
}

/* ── Header ─────────────────────────────────────────────── */
.top { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.brand { display: flex; align-items: center; gap: 8px; }
.title { font-size: 16px; font-weight: 600; letter-spacing: -.01em; }
.controls { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ctl-label { font-size: 11px; color: var(--text-muted); }

button {
  font-family: inherit; font-size: 12px; padding: 6px 12px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-input); color: var(--text); cursor: pointer;
  transition: opacity .15s, background .2s, border-color .2s, color .2s;
}
button:hover { opacity: .8; }
.primary-btn { background: var(--text); color: var(--bg); border-color: transparent; font-weight: 500; }
.danger-btn { background: var(--danger-bg); color: var(--danger-text); border-color: var(--danger-border); }
.ghost-btn { background: transparent; color: var(--text-muted); display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 5px 9px; }
.ghost-btn.on { background: var(--bg-input); color: var(--text); }
.icon-btn { padding: 6px 7px; }
.icon-btn svg { display: block; }

input, select {
  font-family: inherit; font-size: 14px; padding: 7px 9px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-input); color: var(--text); width: 100%;
  transition: background .2s, border-color .2s, color .2s;
}
label { font-size: 11px; color: var(--text-sub); display: block; margin-bottom: 3px; }

.locked .hide-locked { display: none !important; }

/* ── Legend ─────────────────────────────────────────────── */
.legend { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 8px; }
.pill {
  display: inline-block; border-radius: 20px; padding: 3px 11px;
  font-size: 11px; font-weight: 500;
  background: var(--eb); color: var(--et); border: 1px solid var(--el);
  cursor: pointer; user-select: none; transition: opacity .15s;
}
.pill:hover { opacity: .75; }
.pill input { all: unset; font-size: 11px; font-weight: 500; min-width: 40px; }

.hint { font-size: 11px; color: var(--text-muted); margin-bottom: 8px; }

/* ── Week grid ──────────────────────────────────────────── */
.grid-outer {
  overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg-grid); box-shadow: var(--shadow);
  transition: background .25s, border-color .25s;
}
#grid { display: flex; min-width: 560px; }
.timecol { flex-shrink: 0; width: 42px; }
.timecol span { font-size: 9px; color: var(--text-muted); display: block; padding-left: 8px; }
.daycol { flex: 1; min-width: 76px; }
.dayhead { height: 30px; display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--text-week); }
.daycol.wkend .dayhead { color: var(--text-wkend); font-weight: 500; }
.daycol.today .dayhead { color: var(--accent-soft); font-weight: 600; }
.daycol.today .ca { background: var(--today-col); }
.ca { position: relative; border-left: 1px solid var(--line); }
.hl { position: absolute; left: 0; right: 0; pointer-events: none; border-top: 1px solid var(--line); }
.hl.hf { opacity: .4; border-top-style: dashed; }
.nowline { position: absolute; left: 0; right: 0; height: 0; border-top: 2px solid var(--now); z-index: 8; pointer-events: none; }
.nowline::before { content: ''; position: absolute; left: -1px; top: -4px; width: 6px; height: 6px; border-radius: 50%; background: var(--now); }

/* ── Event blocks ───────────────────────────────────────── */
.evt {
  position: absolute; left: 2px; right: 2px;
  border-radius: 7px; padding: 4px 6px 8px; overflow: hidden; z-index: 5;
  border-left: 3px solid var(--el); background: var(--eb);
  user-select: none; -webkit-user-select: none; cursor: pointer;
}
.can-drag .evt { touch-action: none; cursor: grab; }
.can-drag .evt:active { cursor: grabbing; }
.locked .evt { cursor: default; pointer-events: none; }
.evt.sel { outline: 2px solid var(--el); outline-offset: 1px; }
.evt.ghost { opacity: .35; }
.et { font-size: 11px; font-weight: 500; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; pointer-events: none; color: var(--et); }
.en { font-size: 9px; opacity: .8; margin-top: 1px; pointer-events: none; color: var(--et); }
.en.note { font-style: italic; white-space: normal; }
.rh { position: absolute; bottom: 0; left: 0; right: 0; height: 8px; cursor: ns-resize; display: flex; align-items: center; justify-content: center; }
.rh::after { content: ''; width: 18px; height: 2px; border-radius: 1px; background: var(--et); opacity: .3; }

/* ── Mobile bar (day tabs + view toggle) & day view ─────── */
.mobilebar { display: none; }
.dayview { display: none; }

@media (max-width: 699px) {
  .hint { display: none; }
  .title { font-size: 15px; }

  .mobilebar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .day-tabs { display: flex; flex: 1; gap: 2px; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 10px; padding: 3px; }
  .day-tab { flex: 1; text-align: center; font-size: 12px; padding: 6px 0; border: none; background: transparent; border-radius: 7px; color: var(--text-sub); position: relative; }
  .day-tab.active { background: var(--bg-input); color: var(--text); font-weight: 600; box-shadow: var(--shadow); }
  .day-tab.today::after { content: ''; position: absolute; bottom: 2px; left: 50%; transform: translateX(-50%); width: 4px; height: 4px; border-radius: 50%; background: var(--accent-soft); }

  .view-day .grid-outer { display: none; }
  .view-day .dayview { display: block; }
  .view-week .dayview { display: none; }
  .view-week .day-tabs { visibility: hidden; }

  .dayview {
    border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--bg-grid); box-shadow: var(--shadow); overflow: hidden;
  }
  .dv-flex { display: flex; padding-bottom: 12px; }
  .dv-flex .daycol { min-width: 0; margin-right: 10px; }
  .dayview .et { font-size: 13px; }
  .dayview .en { font-size: 11px; }
  .dayview .evt { border-radius: 8px; padding: 6px 9px 10px; }
}

/* ── Editor (panel on desktop, bottom sheet on mobile) ──── */
#editor .panel {
  margin-top: 10px; padding: 14px;
  background: var(--bg-panel); border-radius: var(--radius);
  border: 1px solid var(--border); box-shadow: var(--shadow);
}
.panel-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.panel-title { font-size: 13px; font-weight: 600; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.time-pair { display: flex; gap: 8px; }
.time-pair > div { flex: 1; }
.form-row { margin-top: 10px; }
.form-err { color: var(--danger-text); font-size: 11px; margin-top: 6px; display: none; }
.form-err.show { display: block; }
.form-actions { display: flex; gap: 8px; margin-top: 12px; }
.editor-backdrop { display: none; }

@media (max-width: 699px) {
  .editor-backdrop.open { display: block; position: fixed; inset: 0; background: var(--backdrop); z-index: 80; }
  #editor .panel {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 90; margin: 0;
    border-radius: 16px 16px 0 0; border-bottom: none;
    padding: 16px 16px calc(16px + env(safe-area-inset-bottom));
    max-height: 80vh; overflow-y: auto;
    animation: sheet-up .22s ease;
  }
  @keyframes sheet-up { from { transform: translateY(30%); opacity: .5; } to { transform: none; opacity: 1; } }
  .form-grid { grid-template-columns: 1fr; }
}

/* ── Print modal ────────────────────────────────────────── */
.pmb { display: none; position: fixed; inset: 0; background: var(--backdrop); z-index: 900; align-items: center; justify-content: center; }
.pmb.open { display: flex; }
.pmd { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 14px; padding: 24px; width: 300px; text-align: center; box-shadow: var(--shadow); }
.pmd p { font-size: 14px; font-weight: 600; margin-bottom: 5px; }
.pmd small { color: var(--text-sub); font-size: 11px; display: block; margin-bottom: 18px; line-height: 1.5; }
.pmd .opts { display: flex; gap: 8px; margin-bottom: 8px; }
.pmd .opts button { flex: 1; padding: 9px; font-size: 13px; }
.pmd .opt-dark { background: #111; color: #fff; border-color: #333; }
.pmd .opt-light { background: #fff; color: #111; border-color: #ccc; }
.pmd .cancel { color: var(--text-muted); border-color: transparent; background: transparent; width: 100%; font-size: 12px; }

/* ── Saved flash ────────────────────────────────────────── */
.saved-flash {
  position: fixed; bottom: calc(16px + env(safe-area-inset-bottom)); right: 16px;
  background: var(--text); color: var(--bg); font-size: 11px; padding: 6px 14px;
  border-radius: 20px; opacity: 0; transition: opacity .3s; pointer-events: none; z-index: 500;
}
.saved-flash.show { opacity: 1; }
```

- [ ] **Step 3: Create `icon.svg`**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#4f46e5"/><text x="50" y="68" font-family="-apple-system,Helvetica,Arial,sans-serif" font-size="52" font-weight="700" text-anchor="middle" fill="#ffffff">A</text></svg>
```

- [ ] **Step 4: Replace `index.html`**

Overwrite `index.html` entirely with:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Aoife's Weekly Schedule</title>
<meta name="theme-color" content="#f7f7f5">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<link rel="manifest" href="manifest.webmanifest">
<script>
  // Set theme before first paint to avoid a flash of the wrong theme.
  (function () {
    var pref = 'auto';
    try { pref = localStorage.getItem('aoife_theme') || 'auto'; } catch (e) {}
    var dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  })();
</script>
<link rel="stylesheet" href="css/tokens.css">
<link rel="stylesheet" href="css/app.css">
<link rel="stylesheet" href="css/print.css">
</head>
<body>
<div id="app" class="locked view-day">

  <header class="top">
    <div class="brand">
      <h1 class="title">Aoife's weekly schedule</h1>
      <button id="lock-btn" class="ghost-btn" type="button"></button>
      <button id="theme-btn" class="ghost-btn icon-btn no-print" type="button" title="Theme"></button>
    </div>
    <div class="controls no-print">
      <span class="ctl-label hide-locked">Sunday:</span>
      <button id="sun-btn" class="hide-locked" type="button">Regular</button>
      <button id="add-btn" class="hide-locked" type="button">+ Add event</button>
      <button id="reset-btn" class="danger-btn hide-locked" type="button">Reset</button>
      <button id="print-btn" class="primary-btn" type="button">Print / Save PDF</button>
    </div>
  </header>

  <div id="legend" class="legend hide-locked"></div>
  <p class="hint no-print hide-locked">Drag to move &middot; Drag bottom edge to resize &middot; Click to edit &mdash; saves automatically</p>

  <div class="mobilebar no-print">
    <div id="day-tabs" class="day-tabs"></div>
    <button id="view-btn" class="ghost-btn on" type="button">Week</button>
  </div>

  <div id="dayview" class="dayview"></div>

  <div class="grid-outer"><div id="grid"></div></div>

  <div id="editor-backdrop" class="editor-backdrop no-print"></div>
  <div id="editor" class="hide-locked no-print"></div>

  <div class="pmb no-print" id="pmodal">
    <div class="pmd">
      <p>Choose print theme</p>
      <small>Dark print requires &quot;Background graphics&quot;<br>enabled in the browser's print settings</small>
      <div class="opts">
        <button type="button" class="opt-dark" data-ptheme="dark">Dark</button>
        <button type="button" class="opt-light" data-ptheme="light">Light</button>
      </div>
      <button type="button" class="cancel" id="pm-cancel">Cancel</button>
    </div>
  </div>

  <div class="saved-flash" id="flash">Saved</div>
</div>
<script type="module" src="js/main.js"></script>
</body>
</html>
```

Note two deliberate changes from v1, both approved in the spec/design conversation:
- The **Print button is visible even when locked** (it's a read-only action; v1 hid it behind Unlock).
- The portrait "rotate your device" overlay is **gone**.

- [ ] **Step 5: Create a placeholder `css/print.css`** (fully written in Task 9; must exist so the `<link>` doesn't 404)

```css
/* Print styles arrive in the print task. */
```

- [ ] **Step 6: Manual verification**

Run: `cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule" && python3 -m http.server 8080`
Open `http://localhost:8080`. Expected: styled header with title and empty buttons, empty rounded grid card. Console shows a 404 for `js/main.js` (arrives Task 3) and `manifest.webmanifest`/`apple-touch-icon.png` (arrive Task 10) — both acceptable at this stage. Toggle OS dark mode: page follows (inline script sets theme at load; live switching arrives with theme.js).

- [ ] **Step 7: Commit**

```bash
cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule"
git add index.html css/tokens.css css/app.css css/print.css icon.svg
git commit -m "feat: v2 shell — new index.html, theme tokens, full app CSS, icon"
```

---

### Task 3: Theme module + minimal boot (`js/theme.js`, `js/main.js` v1)

**Files:**
- Create: `js/theme.js`
- Create: `js/main.js` (minimal version; extended in later tasks)

- [ ] **Step 1: Create `js/theme.js`**

```js
// Theme cycling: auto (follows system) -> light -> dark -> auto.
const TK = 'aoife_theme';
const mq = matchMedia('(prefers-color-scheme: dark)');
let pref = 'auto';

const ICONS = {
  auto: '<svg width="15" height="15" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3a9 9 0 010 18z" fill="currentColor"/></svg>',
  light: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
  dark: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>',
};

export const resolved = () => (pref === 'auto' ? (mq.matches ? 'dark' : 'light') : pref);

export function applyTheme() {
  document.documentElement.dataset.theme = resolved();
  const btn = document.getElementById('theme-btn');
  if (btn) {
    btn.innerHTML = ICONS[pref];
    btn.title = `Theme: ${pref}`;
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.body).backgroundColor;
}

export function initTheme() {
  try { pref = localStorage.getItem(TK) || 'auto'; } catch (e) {}
  mq.addEventListener('change', () => { if (pref === 'auto') applyTheme(); });
  document.getElementById('theme-btn').addEventListener('click', () => {
    pref = { auto: 'light', light: 'dark', dark: 'auto' }[pref];
    try { localStorage.setItem(TK, pref); } catch (e) {}
    applyTheme();
  });
  applyTheme();
}
```

- [ ] **Step 2: Create `js/main.js` (minimal)**

```js
import { initTheme } from './theme.js';

initTheme();
```

- [ ] **Step 3: Manual verification**

With the http.server running, reload `http://localhost:8080`. Expected: theme button shows the auto icon (half-filled circle). Clicking cycles icon auto→sun→moon→auto and the page flips light/dark accordingly. Reload mid-cycle: choice persists (localStorage `aoife_theme`). With pref on auto, flipping the OS appearance flips the page live.

- [ ] **Step 4: Commit**

```bash
cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule"
git add js/theme.js js/main.js
git commit -m "feat: auto/light/dark theme module with persistence"
```

---

### Task 4: State store and persistence (`js/state.js`)

**Files:**
- Create: `js/state.js`
- Modify: `js/main.js` (replace entirely with the version below)

- [ ] **Step 1: Create `js/state.js`**

```js
// App state + persistence. Storage contract is v1's: localStorage key
// 'aoife_v3' and KV via /api/get + /api/save. DO NOT change keys or shape.
import { CATS, defEvents, maxIdNum, serialize, applyAltSun } from './model.js';

const SK = 'aoife_v3';

export const store = {
  events: [],
  altSun: false,
  catLabels: {},
  locked: true,
  selId: null,
  addMode: false,
};

let _n = 0;
export const uid = () => `e${++_n}`;

export const catLabel = k => store.catLabels[k] || CATS[k]?.label || 'Event';
export const evLabel = ev => ev.name || catLabel(ev.cat);

const listeners = new Set();
export const onChange = fn => listeners.add(fn);
export const notify = () => listeners.forEach(fn => fn());

export function initState() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SK)); } catch (e) {}
  store.events = saved?.events || defEvents();
  store.altSun = saved?.altSun || false;
  store.catLabels = saved?.catLabels || {};
  _n = maxIdNum(store.events);
}

export async function fetchRemote() {
  try {
    const res = await fetch('/api/get');
    const data = await res.json();
    if (data && !data.error && data !== 'empty') {
      if (data.events) store.events = data.events;
      if (typeof data.altSun !== 'undefined') store.altSun = data.altSun;
      if (data.catLabels) store.catLabels = data.catLabels;
      _n = maxIdNum(store.events);
      notify();
    }
  } catch (e) {}
}

async function saveRemote(str) {
  try {
    await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: str }),
    });
  } catch (e) {}
}

export function save() {
  try {
    const str = serialize(store);
    localStorage.setItem(SK, str);
    saveRemote(str);
    document.dispatchEvent(new CustomEvent('aoife:saved'));
  } catch (e) {}
}

// Every mutation below re-renders and persists.
const commit = () => { notify(); save(); };

export function updateEvent(id, patch) {
  store.events = store.events.map(x => (x.id === id ? { ...x, ...patch } : x));
  commit();
}

export function deleteEvent(id) {
  store.events = store.events.filter(x => x.id !== id);
  if (store.selId === id) store.selId = null;
  commit();
}

export function addEvent(ev) {
  store.events = [...store.events, { ...ev, id: uid() }];
  commit();
}

export function toggleAltSun() {
  store.altSun = !store.altSun;
  store.events = applyAltSun(store.events, store.altSun);
  commit();
}

export function renameCat(key, val) {
  const def = CATS[key]?.label || '';
  if (val && val !== def) store.catLabels[key] = val;
  else delete store.catLabels[key];
  commit();
}

export function resetToDefaults() {
  // v1 behavior: reset clears events + altSun but KEEPS catLabels renames.
  try { localStorage.removeItem(SK); } catch (e) {}
  store.events = defEvents();
  store.altSun = false;
  store.selId = null;
  store.addMode = false;
  _n = maxIdNum(store.events);
  saveRemote(serialize(store));
  notify();
}
```

- [ ] **Step 2: Replace `js/main.js`**

```js
import { initTheme } from './theme.js';
import { store, initState, fetchRemote, onChange, toggleAltSun, resetToDefaults } from './state.js';

function syncChrome() {
  const app = document.getElementById('app');
  app.classList.toggle('locked', store.locked);
  document.getElementById('sun-btn').textContent = store.altSun ? 'Alt Sunday' : 'Regular';
}

export function render() {
  syncChrome();
}

initState();
initTheme();
onChange(render);

document.getElementById('sun-btn').addEventListener('click', toggleAltSun);
document.getElementById('reset-btn').addEventListener('click', () => {
  if (confirm('Reset to defaults? All changes will be cleared.')) resetToDefaults();
});

let ftimer = null;
document.addEventListener('aoife:saved', () => {
  const f = document.getElementById('flash');
  f.classList.add('show');
  clearTimeout(ftimer);
  ftimer = setTimeout(() => f.classList.remove('show'), 1400);
});

render();
fetchRemote();
```

- [ ] **Step 3: Manual verification**

Reload `http://localhost:8080`, open DevTools console:
- `localStorage.getItem('aoife_v3')` → null (nothing saved yet).
- The Sunday/Add/Reset buttons are hidden (locked). That's correct — full unlock wiring lands with the lock button in Task 5's main.js update... temporarily unlock via console: `document.getElementById('app').classList.remove('locked')`, click **Regular** → button text flips to **Alt Sunday**, the "Saved" pill flashes bottom-right, and `JSON.parse(localStorage.getItem('aoife_v3')).altSun` → `true`. The `/api/save` request 501s under http.server — expected offline path.

- [ ] **Step 4: Commit**

```bash
cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule"
git add js/state.js js/main.js
git commit -m "feat: state store with v1-compatible persistence (localStorage + KV)"
```

---

### Task 5: Week grid rendering + drag/resize/select (`js/grid.js`)

**Files:**
- Create: `js/grid.js`
- Modify: `js/main.js` (replace entirely with the version below)

- [ ] **Step 1: Create `js/grid.js`**

```js
// Week grid: rendering, today highlight, now line, drag-to-move,
// drag-bottom-edge-to-resize, click/tap to select.
import { DAYS, S, E, SPH, CATS, fmt, snap, clampStart, clampEnd, todayIndex, esc } from './model.js';
import { store, evLabel, save, notify } from './state.js';

let PH = SPH;
export const setPH = v => { PH = v; };

let ptr = null;
export const isDragging = () => !!ptr;

// Drag/resize only on fine pointers (mouse/trackpad); touch gets tap-to-edit.
export const dragOK = () => matchMedia('(hover:hover) and (pointer:fine)').matches;

export function evtHTML(ev, ph, { handle = false } = {}) {
  const top = (ev.start - S) * ph;
  const height = (ev.end - ev.start) * ph;
  const cls = CATS[ev.cat]?.cls || 'ot';
  return `<div class="evt ${cls}${ev.id === store.selId ? ' sel' : ''}" data-id="${ev.id}"
    style="top:${top + 1}px;height:${height - 2}px;">
    <div class="et">${esc(evLabel(ev))}</div>
    <div class="en">${fmt(ev.start)}&ndash;${fmt(ev.end)}</div>
    ${ev.note && height > 46 ? `<div class="en note">${esc(ev.note)}</div>` : ''}
    ${handle && height > 22 ? '<div class="rh"></div>' : ''}
  </div>`;
}

export function renderGrid() {
  const grid = document.getElementById('grid');
  const gh = (E - S) * PH;
  const tIdx = todayIndex(new Date().getDay());
  const canDrag = !store.locked && dragOK();

  let tc = `<div class="timecol" style="padding-top:30px;">`;
  for (let h = S; h <= E; h++) tc += `<div style="height:${PH}px;"><span>${fmt(h)}</span></div>`;
  tc += '</div>';

  const cols = DAYS.map((day, di) => {
    const isWE = di >= 5, isToday = di === tIdx;
    let col = `<div class="daycol${isWE ? ' wkend' : ''}${isToday ? ' today' : ''}">`;
    col += `<div class="dayhead">${day}</div>`;
    col += `<div class="ca" data-day="${di}" style="height:${gh}px;">`;
    for (let i = 0; i <= E - S; i++) {
      col += `<div class="hl" style="top:${i * PH}px;"></div>`;
      if (i < E - S) col += `<div class="hl hf" style="top:${i * PH + PH / 2}px;"></div>`;
    }
    if (isToday) {
      const now = new Date(), h = now.getHours() + now.getMinutes() / 60;
      if (h >= S && h <= E) col += `<div class="nowline" style="top:${(h - S) * PH}px;"></div>`;
    }
    store.events.filter(e => e.day === di).forEach(ev => { col += evtHTML(ev, PH, { handle: canDrag }); });
    col += `</div><div class="dayhead">${day}</div></div>`;
    return col;
  }).join('');

  grid.innerHTML = tc + cols;
}

const colRects = grid => [...grid.querySelectorAll('.ca')].map(el => el.getBoundingClientRect());
const dayAtX = (x, rs) => rs.findIndex(r => r && x >= r.left && x <= r.right);

let suppressClick = false;

export function initGrid() {
  const grid = document.getElementById('grid');

  grid.addEventListener('pointerdown', e => {
    if (store.locked || !dragOK()) return;
    const evtEl = e.target.closest('.evt');
    if (!evtEl) return;
    e.preventDefault();
    const id = evtEl.dataset.id;
    const ev = store.events.find(x => x.id === id);
    if (!ev) return;
    if (e.target.closest('.rh')) {
      const col = grid.querySelector(`.ca[data-day="${ev.day}"]`);
      ptr = { type: 'resize', id, colRect: col.getBoundingClientRect(), moved: false, startX: e.clientX, startY: e.clientY };
    } else {
      const rect = evtEl.getBoundingClientRect();
      ptr = {
        type: 'move', id,
        offsetH: (e.clientY - rect.top) / PH,
        duration: ev.end - ev.start,
        moved: false, startX: e.clientX, startY: e.clientY,
        rects: colRects(grid),
      };
    }
    evtEl.classList.add('ghost');
    document.addEventListener('pointermove', onMove, { passive: false });
    document.addEventListener('pointerup', onUp);
  });

  // Tap/click select for coarse pointers and non-drag clicks.
  grid.addEventListener('click', e => {
    if (suppressClick) { suppressClick = false; return; }
    const evtEl = e.target.closest('.evt');
    if (!evtEl || store.locked) return;
    toggleSelect(evtEl.dataset.id);
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
  if (ptr.type === 'move') {
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
  document.querySelector(`#grid .evt[data-id="${ptr.id}"]`)?.classList.add('ghost');
}

function onUp() {
  if (!ptr) return;
  const { moved, id } = ptr;
  ptr = null;
  document.removeEventListener('pointermove', onMove);
  document.removeEventListener('pointerup', onUp);
  suppressClick = true; // the browser fires a click right after pointerup; we've handled it
  if (moved) { notify(); save(); }
  else toggleSelect(id);
}
```

- [ ] **Step 2: Replace `js/main.js`**

```js
import { initTheme } from './theme.js';
import { store, initState, fetchRemote, onChange, toggleAltSun, resetToDefaults } from './state.js';
import { renderGrid, initGrid, isDragging, dragOK } from './grid.js';

const LOCK_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9V6zm9 14H6V10h12v10zm-6-3c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"/></svg>';
const UNLOCK_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h2c0-1.66 1.34-3 3-3s3 1.34 3 3v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10zm-6-3c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"/></svg>';

function syncChrome() {
  const app = document.getElementById('app');
  app.classList.toggle('locked', store.locked);
  app.classList.toggle('can-drag', !store.locked && dragOK());
  const lb = document.getElementById('lock-btn');
  lb.innerHTML = store.locked ? `${LOCK_ICON} Unlock to Edit` : `${UNLOCK_ICON} Lock Schedule`;
  lb.classList.toggle('on', !store.locked);
  document.getElementById('sun-btn').textContent = store.altSun ? 'Alt Sunday' : 'Regular';
}

export function render() {
  syncChrome();
  renderGrid();
}

initState();
initTheme();
initGrid();
onChange(render);

document.getElementById('lock-btn').addEventListener('click', () => {
  store.locked = !store.locked;
  if (store.locked) { store.selId = null; store.addMode = false; }
  render();
});
document.getElementById('sun-btn').addEventListener('click', toggleAltSun);
document.getElementById('reset-btn').addEventListener('click', () => {
  if (confirm('Reset to defaults? All changes will be cleared.')) resetToDefaults();
});

let ftimer = null;
document.addEventListener('aoife:saved', () => {
  const f = document.getElementById('flash');
  f.classList.add('show');
  clearTimeout(ftimer);
  ftimer = setTimeout(() => f.classList.remove('show'), 1400);
});

render();
fetchRemote();

// Keep the "now" line fresh; never re-render mid-drag.
setInterval(() => { if (!isDragging()) renderGrid(); }, 60000);
```

- [ ] **Step 3: Manual verification**

Reload `http://localhost:8080` at desktop width. Expected:
- Full Mon–Sun grid with the 12 default events, weekend headers blue, **today's column tinted with its header in accent color**, red now-line across today (if between 9am–5pm).
- Click **Unlock to Edit** → controls appear; drag an event to another day/time (snaps to half hours, can't leave 9–5); drag its bottom edge to resize; click it (no drag) → it gets a selection outline; click again → deselects. "Saved" flash appears after drag. Reload → changes persisted.
- Click **Lock Schedule** → events no longer draggable/clickable.
- Sunday toggle relocates the Sunday Ruhamah block 11–1 ↔ 10–12. Reset restores defaults after confirm.

- [ ] **Step 4: Commit**

```bash
cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule"
git add js/grid.js js/main.js
git commit -m "feat: week grid with drag/resize/select, today highlight, now line"
```

---

### Task 6: Editor panel/sheet, add form, legend (`js/editor.js`)

**Files:**
- Create: `js/editor.js`
- Modify: `js/main.js` (replace entirely with the version below)

- [ ] **Step 1: Create `js/editor.js`**

```js
// Edit panel (desktop) / bottom sheet (mobile), add-event form, legend pills.
import { CATS, DAYS, S, E, fmt, esc } from './model.js';
import { store, catLabel, evLabel, updateEvent, deleteEvent, addEvent, renameCat, notify } from './state.js';

let nw = null; // draft for the add form

const timeOpts = (sel, from, to) => {
  let o = '';
  for (let t = from; t <= to; t += 0.5) o += `<option value="${t}"${t === sel ? ' selected' : ''}>${fmt(t)}</option>`;
  return o;
};
const catOpts = sel => Object.keys(CATS).map(k =>
  `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(catLabel(k))}</option>`).join('');
const dayOpts = sel => DAYS.map((d, i) =>
  `<option value="${i}"${i === sel ? ' selected' : ''}>${d}</option>`).join('');

export function openAdd() {
  store.selId = null;
  store.addMode = true;
  nw = { cat: 'other', day: 0, start: 10, end: 11, note: '', name: '' };
  notify();
}

export function closeEditor() {
  store.selId = null;
  store.addMode = false;
  notify();
}

function formFields(v) {
  // Shared field markup for add + edit forms. `v` is the draft or the event.
  return `
    <div class="form-grid">
      <div><label>Custom name</label><input type="text" id="ed-name" placeholder="leave blank for default" value="${esc(v.name || '')}"></div>
      <div><label>Type</label><select id="ed-cat">${catOpts(v.cat)}</select></div>
      <div><label>Day</label><select id="ed-day">${dayOpts(v.day)}</select></div>
      <div class="time-pair">
        <div><label>Start</label><select id="ed-start">${timeOpts(v.start, S, E - 0.5)}</select></div>
        <div><label>End</label><select id="ed-end">${timeOpts(v.end, S + 0.5, E)}</select></div>
      </div>
    </div>
    <div class="form-row"><label>Note</label><input type="text" id="ed-note" placeholder="optional note, e.g. every other week" value="${esc(v.note || '')}"></div>
    <p class="form-err" id="ed-err">End must be after start.</p>`;
}

export function renderEditor() {
  const box = document.getElementById('editor');
  const backdrop = document.getElementById('editor-backdrop');
  const ev = store.selId ? store.events.find(x => x.id === store.selId) : null;
  const open = !store.locked && (store.addMode || ev);
  backdrop.classList.toggle('open', !!open);
  if (!open) { box.innerHTML = ''; return; }

  if (store.addMode) {
    box.innerHTML = `<div class="panel">
      <div class="panel-head"><span class="panel-title">Add event</span><button type="button" id="ed-close">&#x2715;</button></div>
      ${formFields(nw)}
      <div class="form-actions">
        <button type="button" class="primary-btn" id="ed-add" style="flex:1;">Add event</button>
        <button type="button" id="ed-cancel">Cancel</button>
      </div>
    </div>`;
    box.querySelector('#ed-close').onclick = closeEditor;
    box.querySelector('#ed-cancel').onclick = closeEditor;
    box.querySelector('#ed-name').oninput = e => { nw.name = e.target.value; };
    box.querySelector('#ed-note').oninput = e => { nw.note = e.target.value; };
    box.querySelector('#ed-cat').onchange = e => { nw.cat = e.target.value; };
    box.querySelector('#ed-day').onchange = e => { nw.day = +e.target.value; };
    box.querySelector('#ed-start').onchange = e => {
      nw.start = +e.target.value;
      if (nw.end <= nw.start) nw.end = Math.min(E, nw.start + 0.5);
      notify();
    };
    box.querySelector('#ed-end').onchange = e => { nw.end = +e.target.value; };
    box.querySelector('#ed-add').onclick = () => {
      if (nw.end <= nw.start) { box.querySelector('#ed-err').classList.add('show'); return; }
      store.addMode = false;
      addEvent({ ...nw, name: nw.name.trim() });
    };
    return;
  }

  box.innerHTML = `<div class="panel">
    <div class="panel-head"><span class="panel-title">${esc(evLabel(ev))}</span><button type="button" id="ed-close">&#x2715;</button></div>
    ${formFields({ ...ev, name: evLabel(ev) })}
    <div class="form-actions"><button type="button" class="danger-btn" id="ed-del">Delete event</button></div>
  </div>`;
  box.querySelector('#ed-close').onclick = closeEditor;
  box.querySelector('#ed-name').onchange = e => {
    // Blank or default-label input clears the custom name (v1 behavior).
    const def = CATS[ev.cat]?.label || '';
    const v = e.target.value.trim();
    updateEvent(ev.id, { name: v === '' || v === def ? '' : v });
  };
  box.querySelector('#ed-note').onchange = e => updateEvent(ev.id, { note: e.target.value });
  box.querySelector('#ed-cat').onchange = e => updateEvent(ev.id, { cat: e.target.value });
  box.querySelector('#ed-day').onchange = e => updateEvent(ev.id, { day: +e.target.value });
  box.querySelector('#ed-start').onchange = e => {
    const v = +e.target.value;
    updateEvent(ev.id, { start: v, end: v >= ev.end ? Math.min(E, v + 0.5) : ev.end });
  };
  box.querySelector('#ed-end').onchange = e => {
    const v = +e.target.value;
    updateEvent(ev.id, { end: v, start: v <= ev.start ? Math.max(S, v - 0.5) : ev.start });
  };
  box.querySelector('#ed-del').onclick = () => deleteEvent(ev.id);
}

export function renderLegend() {
  const leg = document.getElementById('legend');
  leg.innerHTML = Object.entries(CATS).map(([k, v]) =>
    `<span class="pill ${v.cls}" data-cat="${k}" title="Click to rename">${esc(catLabel(k))}</span>`).join('');
}

export function initLegend() {
  document.getElementById('legend').addEventListener('click', e => {
    const pill = e.target.closest('.pill');
    if (!pill || pill.querySelector('input')) return;
    const key = pill.dataset.cat;
    const cur = catLabel(key);
    pill.innerHTML = '';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = cur;
    inp.style.width = Math.max(50, cur.length * 7.5) + 'px';
    pill.appendChild(inp);
    inp.focus();
    inp.select();
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      renameCat(key, inp.value.trim());
    };
    inp.addEventListener('blur', commit);
    inp.addEventListener('input', () => { inp.style.width = Math.max(50, inp.value.length * 7.5) + 'px'; });
    inp.addEventListener('keydown', ev2 => {
      if (ev2.key === 'Enter') { ev2.preventDefault(); inp.blur(); }
      if (ev2.key === 'Escape') { done = true; renderLegend(); }
    });
  });
}

export function initEditor() {
  document.getElementById('editor-backdrop').addEventListener('click', closeEditor);
}
```

- [ ] **Step 2: Replace `js/main.js`**

Same as Task 5's version, with these exact changes — new imports and an extended `render()`, plus the add-button handler:

```js
import { initTheme } from './theme.js';
import { store, initState, fetchRemote, onChange, toggleAltSun, resetToDefaults } from './state.js';
import { renderGrid, initGrid, isDragging, dragOK } from './grid.js';
import { renderEditor, renderLegend, initLegend, initEditor, openAdd } from './editor.js';

const LOCK_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9V6zm9 14H6V10h12v10zm-6-3c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"/></svg>';
const UNLOCK_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h2c0-1.66 1.34-3 3-3s3 1.34 3 3v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10zm-6-3c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"/></svg>';

function syncChrome() {
  const app = document.getElementById('app');
  app.classList.toggle('locked', store.locked);
  app.classList.toggle('can-drag', !store.locked && dragOK());
  const lb = document.getElementById('lock-btn');
  lb.innerHTML = store.locked ? `${LOCK_ICON} Unlock to Edit` : `${UNLOCK_ICON} Lock Schedule`;
  lb.classList.toggle('on', !store.locked);
  document.getElementById('sun-btn').textContent = store.altSun ? 'Alt Sunday' : 'Regular';
}

export function render() {
  syncChrome();
  renderLegend();
  renderGrid();
  renderEditor();
}

initState();
initTheme();
initGrid();
initLegend();
initEditor();
onChange(render);

document.getElementById('lock-btn').addEventListener('click', () => {
  store.locked = !store.locked;
  if (store.locked) { store.selId = null; store.addMode = false; }
  render();
});
document.getElementById('sun-btn').addEventListener('click', toggleAltSun);
document.getElementById('add-btn').addEventListener('click', openAdd);
document.getElementById('reset-btn').addEventListener('click', () => {
  if (confirm('Reset to defaults? All changes will be cleared.')) resetToDefaults();
});

let ftimer = null;
document.addEventListener('aoife:saved', () => {
  const f = document.getElementById('flash');
  f.classList.add('show');
  clearTimeout(ftimer);
  ftimer = setTimeout(() => f.classList.remove('show'), 1400);
});

render();
fetchRemote();

setInterval(() => { if (!isDragging()) renderGrid(); }, 60000);
```

- [ ] **Step 3: Manual verification**

At desktop width, unlock, then:
- Legend pills appear in category colors; click one, rename it, press Enter → pill text updates everywhere (legend + matching events), Saved flash fires. Escape cancels.
- Click an event → panel below grid shows its fields; change day/start/end via dropdowns → block moves; set start ≥ end → end auto-bumps to start+30min; type a custom name → block label updates; clear the name → reverts to category label; Delete removes it.
- **+ Add event** → form appears; add one; it shows on the grid and persists across reload.
- Lock → panel closes, legend hides.

- [ ] **Step 4: Commit**

```bash
cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule"
git add js/editor.js js/main.js
git commit -m "feat: editor panel, add form, renameable legend"
```

---

### Task 7: Mobile day view + Day⇄Week toggle (`js/dayview.js`)

**Files:**
- Create: `js/dayview.js`
- Modify: `js/main.js` (three small insertions listed below)

- [ ] **Step 1: Create `js/dayview.js`**

```js
// Mobile portrait day view: Mon-Sun tabs, one day's column, Day/Week toggle.
import { DAYS, S, E, fmt, todayIndex } from './model.js';
import { store, notify } from './state.js';
import { evtHTML } from './grid.js';

const VK = 'aoife_mobile_view';
const DPH = 62; // day-view pixels per hour

let selDay = todayIndex(new Date().getDay());

function syncViewBtn() {
  const app = document.getElementById('app');
  // Button shows the view you'd switch TO.
  document.getElementById('view-btn').textContent = app.classList.contains('view-day') ? 'Week' : 'Day';
}

export function initDayView() {
  const app = document.getElementById('app');
  let v = 'day';
  try { v = localStorage.getItem(VK) || 'day'; } catch (e) {}
  app.classList.remove('view-day', 'view-week');
  app.classList.add(v === 'week' ? 'view-week' : 'view-day');

  document.getElementById('view-btn').addEventListener('click', () => {
    const toWeek = app.classList.contains('view-day');
    app.classList.toggle('view-day', !toWeek);
    app.classList.toggle('view-week', toWeek);
    try { localStorage.setItem(VK, toWeek ? 'week' : 'day'); } catch (e) {}
    syncViewBtn();
  });

  document.getElementById('day-tabs').addEventListener('click', e => {
    const b = e.target.closest('.day-tab');
    if (!b) return;
    selDay = +b.dataset.day;
    renderDayView();
  });

  // Tap an event to open the edit sheet (when unlocked).
  document.getElementById('dayview').addEventListener('click', e => {
    const evtEl = e.target.closest('.evt');
    if (!evtEl || store.locked) return;
    const id = evtEl.dataset.id;
    store.selId = store.selId === id ? null : id;
    store.addMode = false;
    notify();
  });

  syncViewBtn();
}

export function renderDayView() {
  const tIdx = todayIndex(new Date().getDay());

  document.getElementById('day-tabs').innerHTML = DAYS.map((d, i) =>
    `<button type="button" class="day-tab${i === selDay ? ' active' : ''}${i === tIdx ? ' today' : ''}" data-day="${i}">${d}</button>`
  ).join('');

  const gh = (E - S) * DPH;
  let tc = `<div class="timecol" style="padding-top:12px;">`;
  for (let h = S; h <= E; h++) tc += `<div style="height:${DPH}px;"><span>${fmt(h)}</span></div>`;
  tc += '</div>';

  let col = `<div class="daycol"><div class="ca" data-day="${selDay}" style="height:${gh}px;margin-top:12px;">`;
  for (let i = 0; i <= E - S; i++) {
    col += `<div class="hl" style="top:${i * DPH}px;"></div>`;
    if (i < E - S) col += `<div class="hl hf" style="top:${i * DPH + DPH / 2}px;"></div>`;
  }
  if (selDay === tIdx) {
    const now = new Date(), h = now.getHours() + now.getMinutes() / 60;
    if (h >= S && h <= E) col += `<div class="nowline" style="top:${(h - S) * DPH}px;"></div>`;
  }
  store.events.filter(e => e.day === selDay).forEach(ev => { col += evtHTML(ev, DPH, { handle: false }); });
  col += '</div></div>';

  document.getElementById('dayview').innerHTML = `<div class="dv-flex">${tc}${col}</div>`;
}
```

- [ ] **Step 2: Wire into `js/main.js`**

Three insertions:

1. Add to the imports:
```js
import { renderDayView, initDayView } from './dayview.js';
```
2. In `render()`, add `renderDayView();` immediately after `renderGrid();`.
3. Add `initDayView();` after `initEditor();`, and change the interval line at the bottom to:
```js
setInterval(() => { if (!isDragging()) { renderGrid(); renderDayView(); } }, 60000);
```

- [ ] **Step 3: Manual verification**

In DevTools responsive mode at 390×844 (iPhone-ish):
- Day tabs appear with today active + dotted; week grid hidden; one-day column with that day's events, readable large labels, now-line on today.
- Tab through days; events match the week grid's columns.
- **Week** button → full week grid (scrollable sideways), tabs hidden, button now says **Day**. Preference survives reload.
- Unlock (tap the lock button) → tap an event → edit sheet slides up from the bottom over a dimmed backdrop; edit day/time → day view updates; backdrop tap closes. **+ Add event** works from the sheet too.
- Back at desktop width: tabs/day view gone, everything as in Task 6.

- [ ] **Step 4: Commit**

```bash
cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule"
git add js/dayview.js js/main.js
git commit -m "feat: mobile day view with tabs and Day/Week toggle"
```

---

### Task 8: Print flow (`js/print.js` + real `css/print.css`)

**Files:**
- Create: `js/print.js`
- Replace: `css/print.css` (placeholder from Task 2)
- Modify: `js/main.js` (two small insertions)

- [ ] **Step 1: Create `js/print.js`**

```js
// Print modal + dark/light print themes. Printing always uses the week grid
// (print.css forces it visible) at the taller print row height.
import { SPH, PPH } from './model.js';
import { setPH, renderGrid } from './grid.js';
import { applyTheme } from './theme.js';

export function initPrint() {
  const modal = document.getElementById('pmodal');
  document.getElementById('print-btn').addEventListener('click', () => modal.classList.add('open'));
  document.getElementById('pm-cancel').addEventListener('click', () => modal.classList.remove('open'));
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
  modal.querySelectorAll('[data-ptheme]').forEach(b =>
    b.addEventListener('click', () => doPrint(b.dataset.ptheme)));

  // Also correct row height for direct Cmd/Ctrl+P prints.
  window.addEventListener('beforeprint', () => { setPH(PPH); renderGrid(); });
  window.addEventListener('afterprint', () => {
    setPH(SPH);
    renderGrid();
    applyTheme(); // restore the user's screen theme if doPrint changed it
  });
}

function doPrint(theme) {
  document.getElementById('pmodal').classList.remove('open');
  document.documentElement.dataset.theme = theme; // reuses screen tokens for print
  setTimeout(() => window.print(), 80);
}
```

- [ ] **Step 2: Replace `css/print.css`**

```css
@media print {
  @page { size: letter landscape; margin: 0.4in; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  .top, .legend, .hint, .mobilebar, .dayview, #editor, .editor-backdrop,
  .pmb, .saved-flash, .no-print { display: none !important; }

  body { padding: 28px 0 0; margin: 0; background: var(--bg) !important; }

  /* Always print the full week grid, even if the screen shows mobile day view. */
  .grid-outer {
    display: block !important;
    border: none; box-shadow: none;
    width: 95% !important; margin: 0 auto; overflow: visible;
  }
  #grid { min-width: unset !important; width: 100% !important; }
}
```

- [ ] **Step 3: Wire into `js/main.js`**

1. Add to the imports:
```js
import { initPrint } from './print.js';
```
2. Add `initPrint();` after `initDayView();`.

- [ ] **Step 4: Manual verification**

- Desktop: **Print / Save PDF** (visible even locked) → modal; **Light** → print preview shows the light week grid, landscape, no header/controls; cancel preview → screen returns to the user's chosen theme. **Dark** → dark preview (with "Background graphics" checked). Row height is taller in print (78px vs 66px per hour).
- Mobile emulation, day view active: print preview still shows the **full week grid**.
- Direct Cmd+P (no modal): prints in the current screen theme, correct row height.

- [ ] **Step 5: Commit**

```bash
cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule"
git add js/print.js css/print.css js/main.js
git commit -m "feat: print/save-PDF flow with dark and light print themes"
```

---

### Task 9: PWA polish — manifest, apple-touch-icon

**Files:**
- Create: `manifest.webmanifest`
- Create: `apple-touch-icon.png` (generated by script)

- [ ] **Step 1: Create `manifest.webmanifest`**

```json
{
  "name": "Aoife's Schedule",
  "short_name": "Aoife",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0e0e11",
  "theme_color": "#4f46e5",
  "icons": [
    { "src": "icon.svg", "sizes": "any", "type": "image/svg+xml" },
    { "src": "apple-touch-icon.png", "sizes": "180x180", "type": "image/png" }
  ]
}
```

- [ ] **Step 2: Generate `apple-touch-icon.png`** (180×180 solid indigo; iOS rounds it automatically)

Run from the repo root:

```bash
python3 - <<'EOF'
import struct, zlib
W = H = 180
color = (79, 70, 229)  # #4f46e5
raw = b''.join(b'\x00' + bytes(color) * W for _ in range(H))
def chunk(t, d):
    c = t + d
    return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(raw))
       + chunk(b'IEND', b''))
open('apple-touch-icon.png', 'wb').write(png)
print('wrote apple-touch-icon.png', len(png), 'bytes')
EOF
```

Expected output: `wrote apple-touch-icon.png <n> bytes`

- [ ] **Step 3: Manual verification**

Reload `http://localhost:8080` — no more 404s in the console for manifest or icons. `file apple-touch-icon.png` reports `PNG image data, 180 x 180`.

- [ ] **Step 4: Commit**

```bash
cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule"
git add manifest.webmanifest apple-touch-icon.png
git commit -m "feat: web manifest and touch icon for home-screen install"
```

---

### Task 10: Data-contract test against production data

**Files:**
- Create: `tests/contract.test.mjs`
- Create (local only, NOT committed): `tests/fixtures/production.json`
- Create: `tests/fixtures/.gitignore`

- [ ] **Step 1: Write the contract test**

Create `tests/contract.test.mjs`:

```js
// Verifies the app's serializer round-trips REAL production data unchanged.
// The fixture is fetched from the live API before running (see plan Task 10)
// and is gitignored; the test skips gracefully when it's absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serialize, maxIdNum } from '../js/model.js';

let prod = null;
try {
  prod = JSON.parse(readFileSync(new URL('./fixtures/production.json', import.meta.url), 'utf8'));
} catch (e) {}

test('production data round-trips through serialize unchanged', { skip: !prod }, () => {
  assert.ok(Array.isArray(prod.events), 'production data has an events array');
  for (const ev of prod.events) {
    for (const k of ['id', 'cat', 'day', 'start', 'end']) assert.ok(k in ev, `event has ${k}`);
  }
  const roundTripped = JSON.parse(serialize({
    events: prod.events,
    altSun: prod.altSun ?? false,
    catLabels: prod.catLabels ?? {},
  }));
  assert.deepEqual(roundTripped.events, prod.events);
  assert.equal(roundTripped.altSun, prod.altSun ?? false);
  assert.deepEqual(roundTripped.catLabels, prod.catLabels ?? {});
  assert.ok(maxIdNum(prod.events) >= 0);
});
```

Create `tests/fixtures/.gitignore` containing:

```
production.json
```

- [ ] **Step 2: Fetch the real production data and run**

```bash
cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule"
mkdir -p tests/fixtures
curl -s https://aoifes-schedule.vercel.app/api/get -o tests/fixtures/production.json
head -c 300 tests/fixtures/production.json   # sanity: should show {"events":[{"id":"e1",...
node --test tests/
```

Expected: all model tests pass AND the contract test passes (not skipped). If the curl output shows `{"error":...}` instead of events, STOP and investigate before proceeding — do not push anything while the API looks unhealthy.

- [ ] **Step 3: Seed the browser with production data and eyeball it**

With http.server running, open `http://localhost:8080`, and in the DevTools console:

```js
fetch('https://aoifes-schedule.vercel.app/api/get').then(r => r.json()).then(d => {
  localStorage.setItem('aoife_v3', JSON.stringify(d));
  location.reload();
});
```

Expected: the page now shows the REAL current schedule (not defaults) — verify it matches https://aoifes-schedule.vercel.app side by side. Check both themes and the mobile day view. Then clean up: `localStorage.removeItem('aoife_v3')`.

- [ ] **Step 4: Commit**

```bash
cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule"
git add tests/contract.test.mjs tests/fixtures/.gitignore
git commit -m "test: production data-contract round-trip"
```

---

### Task 11: AGENTS.md, final verification matrix, deploy

**Files:**
- Create: `AGENTS.md`

- [ ] **Step 1: Create `AGENTS.md`**

```markdown
# AGENTS.md — aoifes-schedule

Single LLM source of truth for this repo. Human-facing docs (README, jalal*) are off-limits per convention.

## What this is
Aoife's weekly schedule web app, live at https://aoifes-schedule.vercel.app/.
v2 (2026-07-20) rebuilt the front end: dark/light/auto theme, mobile day view
with Day⇄Week toggle, refined-minimal design. Spec: docs/superpowers/specs/2026-07-20-schedule-v2-rebuild-design.md.

## Architecture
Static vanilla app, no build step, no dependencies:
- index.html — shell; inline script sets html[data-theme] pre-paint
- css/tokens.css — all theme + category color tokens (light/dark)
- css/app.css — layout/components incl. mobile day view + bottom sheet
- css/print.css — letter-landscape print, always the week grid
- js/model.js — PURE (no DOM); constants, fmt/snap/clamps, defaults, serialize
- js/state.js — store + persistence + all mutations
- js/grid.js — week grid render, drag/resize/select (fine pointers only)
- js/dayview.js — mobile tabs + day column + Day/Week toggle
- js/editor.js — edit panel (desktop) / bottom sheet (mobile), add form, legend
- js/theme.js — auto/light/dark cycling
- js/print.js — print modal; prints reuse screen theme tokens
- api/get.js, api/save.js — Vercel functions -> Upstash KV. DO NOT TOUCH.
- aoife_schedule_3.html — v1-era artifact, kept for history. DO NOT TOUCH.

## Data contract (NEVER break)
- KV key `aoifes_schedule`; localStorage `aoife_v3`
- Shape: {events:[{id:"e<n>",cat,day:0-6 Mon-first,start,end,note,name}], altSun:bool, catLabels:{}}
- Hours are decimal (half-hour steps), grid spans 9–17
- Category keys: quran, ruhamah, hala, barakot, art, other
- Extra localStorage keys (additive, safe): aoife_theme, aoife_mobile_view

## Tests
`node --test tests/` — pure model tests + a production-data contract test
(tests/fixtures/production.json is gitignored; fetch it from /api/get first).

## Deploy
Push to main -> Vercel auto-deploys. Local preview: `python3 -m http.server 8080`
(the /api fetch fails locally by design; app runs on localStorage/defaults).
```

- [ ] **Step 2: Run the full verification matrix**

All checks from the spec, in one pass (http.server running):

1. `node --test tests/` → all pass.
2. Desktop width, dark + light: grid, drag, resize, select/edit, add, delete, legend rename, Sunday toggle, reset, lock/unlock.
3. 390px width, dark + light: day view default, today tab dotted, tab switching, Day⇄Week toggle + persistence, edit sheet CRUD, + Add event.
4. Print preview from both desktop and mobile emulation: dark and light, landscape week grid only.
5. Theme: cycle auto→light→dark→auto, persists across reload; auto follows OS switch.
6. Production-data seed check (Task 10 Step 3) if not already done.

Fix anything that fails before proceeding. Then stop the http.server.

- [ ] **Step 3: Commit and deploy**

```bash
cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule"
git add AGENTS.md
git commit -m "docs: AGENTS.md for v2 architecture and data contract"
git push origin main
```

- [ ] **Step 4: Verify production**

Wait ~60s for Vercel, then:

```bash
curl -s https://aoifes-schedule.vercel.app/ | head -20        # new HTML shell (viewport meta, css/tokens.css)
curl -s https://aoifes-schedule.vercel.app/api/get | head -c 200   # schedule data still intact
```

Open https://aoifes-schedule.vercel.app/ in a real browser: schedule shows the live KV data, theme toggle works, and on a phone the day view appears. If anything is broken: `git revert` the offending commits and push (restores v1 instantly; data is untouched either way).

---

## Addendum (added during execution)

- **Task 10 scope expansion (approved):** the contract test discovered a corrupt
  stray record `{"id":"e999"}` (no cat/day/start/end) in the live KV blob.
  Resolution: `js/model.js` gained `isValidEvent`/`sanitizeEvents`, `js/state.js`
  sanitizes events on both load paths (initState + fetchRemote), and
  `tests/contract.test.mjs` round-trips production data after sanitization.
  The stray record renders nowhere in v1 or v2 and is permanently dropped from
  KV on the first v2 save.
- **Environment note:** `node --test tests/` (directory arg) fails on Node 24;
  all test steps use bare `node --test` instead.
- **Post-plan review fixes applied during execution:** clampEnd upper-bound
  hardening; WCAG contrast fixes to muted/week text tokens; theme-pref
  sanitization + button guard; state save/fetch race guards + reset local
  persistence; grid non-primary-button + pointercancel handling; legend rename
  click race fix; symmetric add-form time auto-fix; add-event defaults to the
  active mobile day tab; print restore via matchMedia fallback.
