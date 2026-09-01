# Week grid draws planner activity slots (draggable) — design

**Date:** 2026-09-01 · **Status:** approved by Jalal in conversation (option 1 + drag)

## Problem

Aoife's recurring week lives in two blobs:

- `aoifes_schedule.events` — the original template (Quran, Ruhama, Miss Hala, Jumu'ah).
- `aoife_plan.activities[].slots[]` — on-grid planner activities (`status:'active'`,
  `onGrid:true`): Jiu Jitsu (Mon 4–5), Geography (Wed 11–12), Foundations of
  Inquiry Science (Wed 2–3).

`mday.js buildTimed()` (phone Today/Week), `today.js` and the Google Calendar sync
all union the two. **`js/grid.js renderGrid()` reads only the first**, so the
desktop Week tab and the one-page print silently omit the three planner classes
(Jiu Jitsu has been missing since 2026-08-30). Confirmed 2026-09-01 by printing
the live site headless: five blocks came out, not eight.

Moving the three into `aoifes_schedule` is NOT a fix: `buildTimed` logs a grid
block as an `eventId` row and a slot as an `activityId` row; Jiu Jitsu's
`target:10` trial counter and Geography's paced progress depend on the
`activityId` shape, and the calendar would double up (`tpl:` + `act:`).

## Goal

The week grid shows every recurring block the phone and calendar show, in print
too, and — Jalal's ask — the planner blocks are **draggable/resizable** like the
template ones, writing back to the planner.

## Design

### 1. Rendering (js/grid.js — first-class blocks)

`renderGrid()` renders, per day column, the template events (unchanged) **and**
the on-grid planner slots. A pure helper supplies the slot list:

```js
// js/plan/model.js
export function gridSlots(activities) → [{ actId, idx, day, start, end, name, cls, note }]
```

- Only `status === 'active' && onGrid && Array.isArray(slots)`; a slot with a
  non-numeric `day/start/end` is skipped; one wholly outside 9–17 is skipped;
  one overhanging the edge is clamped for drawing while the label keeps its real
  times (same rules as the one-off ghosts). Note = the current chain's next
  session label when the activity is paced (e.g. "Introduction to Geography"),
  else `''`.
- Markup mirrors `evtHTML`: `class="evt <cls> pslot"`, **`data-slot="<actId>:<idx>"`**,
  never `data-id`. `.pslot` is a marker class only — no visual difference from
  a template block (Jalal chose "same look"). Resize handle `.rh` appears under
  the same `canDrag` condition as template blocks.
- `grid.js` imports `plan` from `./plan/state.js` (a store; stores never import
  the view layer, so no cycle — overlay.js already imports both stores).
- Print: `print.js` re-renders the grid at print pixel height through the same
  `renderGrid()`, so slots print with no extra work. The print-CSS block that
  hides `.ov-oneoff` and `.ov-dot` does not touch `.pslot`.

### 2. Drag / resize (js/grid.js)

`pointerdown` resolves the block's identity with a small pure helper:

```js
export function blockRef(dataset) → { kind:'event', id } | { kind:'slot', actId, idx } | null
```

- `kind:'event'` → the existing path, untouched.
- `kind:'slot'` → `ptr.kind='slot'`; move/resize math is identical, but the live
  preview patches `plan.data.activities[a].slots[idx]` in place (mirrors how the
  template drag patches `store.events` live) and `renderGrid()` redraws.
- On drop with `moved`: `setSlot(actId, idx, { day, start, end })` — a new
  mutation in `js/plan/state.js` that assigns and `commit()`s (planNotify +
  savePlan). On drop without movement: nothing (no selection for slots).
- `pointercancel` → `renderGrid()` restores the last committed values, since the
  in-place preview is discarded by re-reading `plan.data` (keep a `ptr.orig`
  snapshot and restore it on cancel).
- Lock: `store.locked` and `dragOK()` gate slot drags exactly as template drags.
- Live-sync hold: `isDragging` is already registered in `holdSync`; `ptr` is set
  for slot drags too, so a fetched plan cannot re-render under the cursor.
- Click/select: `toggleSelect` remains template-only. A click on a `.pslot`
  is ignored (the editor edits template fields). **Known limit (accepted):** on
  touch devices, planner block times are not editable — desktop drag only.

### 3. Day view parity (js/plan/overlay.js)

`js/dayview.js` stays frozen. `overlay.js` gains `applySlots(root, blocks)`
next to `applyOneOffs` and draws the selected day's slots into **#dayview
only** (#grid renders them natively — drawing both would duplicate). Read-only
(`pointer-events:none`), class `evt <cls> pslot`, `data-slot`, positioned by
the column's inline height like the one-offs. Not print-hidden.

### 4. Status dots (js/plan/overlay.js)

Today the dot sweep decorates `.evt[data-id]` from log rows with `eventId`.
Add a sibling pass: log rows in the visible week with `activityId` and no
`eventId` decorate `.evt[data-slot^="<actId>:"]` in both roots, with the same
weekday-agreement guard (drop the dot when `dayIdx(e.date)` ≠ the slot's
current `day`).

### 5. Calendar

`gcal_sync activity_slot_events` keys events `act:<actId>:<idx>`. A drag keeps
the index, so the reconciler **patches** the existing recurring event (new
BYDAY/time) rather than inserting a new one. The bot-tick job runs the sync
every 30 min with `--if-changed`, so a drop reaches Google Calendar in ≤30 min.

### 6. Release

- Bump the five `?v=` asset stamps in `index.html` to the next generation.
- Update AGENTS.md: architecture line for grid.js, the "One-off blocks" section
  sentence "the app's drag/edit only ever moves the recurring template" → now
  also moves planner slots; add a short "Planner slots on the grid" section.

## Testing

- `tests/plan-model.test.mjs`: `gridSlots()` — filtering, clamping, note label,
  stable `(actId, idx)` identity.
- `tests/grid.test.mjs` (new; grid.js is importable in node — overlay's test
  already loads it): `blockRef()` for `data-id`, `data-slot`, neither, malformed.
- `tests/plan-state.test.mjs`: `setSlot()` assigns, commits (planNotify fired,
  savePlan stamped), ignores unknown activity/index, does not touch other slots.
- `tests/plan-overlay.test.mjs` (fake DOM): `applySlots` draws into #dayview
  only; dot sweep decorates `data-slot` blocks and respects the weekday guard.
- **Print re-verify** (hard rule 2): headless Chrome print of the live site →
  1 page, `pdftotext` contains all eight recurring names.
- **Manual desktop check** via headless-Chrome DOM probe: after render, #grid
  holds 11 `.evt` blocks (8 template + 3 slots) with the right `data-slot`s.

## Non-goals

- Tap-to-edit / editor sheet for planner blocks on touch (separate job).
- Drawing slots into the frozen `js/dayview.js` render path itself.
- Any change to the phone `/m` app, the bot, or the sync.
