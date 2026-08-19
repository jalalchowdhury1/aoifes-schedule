# Live sync + one-offs on the grid

> Approved by the family 2026-08-18 after the bot's first write appeared nowhere on
> screen (stale tab). House rules: frozen files per AGENTS.md, bare `node --test`,
> no dialogs, esc()/okCls, print safety re-verified if css/plan.css changes,
> **iPhone Day view parity is mandatory** (standing directive).

## Why

`fetchPlanRemote()` / `fetchRemote()` run ONCE at boot. The 60s interval in
main.js only re-renders from memory. With the Telegram bot now writing the same
KV blobs from outside the browser, an open tab silently shows a frozen snapshot:
the family saw neither the bot's "Arya art" one-off nor a status the bot had
logged. Trust in both surfaces depends on this being fixed.

## 1. Live re-sync (js/plan/state.js + js/plan/tabs.js)

- Track in-flight saves: `pendingSaves` counter, incremented before the POST and
  decremented in a `finally`. (`dirty` currently latches true forever after the
  first local save and permanently blocks remote application — replace that
  semantics, don't extend it.)
- `syncPlan()` — fetch `/api/plan-get`; apply when **both**: `pendingSaves === 0`
  AND (`!lastLocalSaveAt` OR `remote.savedAt >= lastLocalSaveAt`). Otherwise
  ignore this round (our own write is newer/in flight). Sanitize as today.
  Re-render only when the applied blob differs from the current one
  (`serializePlan` compare) so we never fight the user's scroll/typing.
- Triggers: `visibilitychange` → visible; `window.focus`; and a poll every 120s
  while `document.visibilityState === 'visible'` (no polling in background tabs).
- Same treatment for the schedule template (`js/state.js` `fetchRemote`) — export
  `syncSchedule()` with the identical guard and wire it to the same triggers.
  Template edits are the drag/resize path: `pendingSaves` guard is what protects
  an in-progress edit; additionally skip while `isDragging()`.
- Failures are silent (offline is normal); never clobber local state on error.

## 2. One-off events on the Week grid (js/plan/overlay.js + css/plan.css)

Dated one-offs (overrides `action:'add'`) for the **current week** render as
read-only ghost blocks on the week grid and in the Day view — same overlay
module, same MutationObserver re-apply, same drag guard:

- Position from `start`/`end` like a normal block, in the column for
  `dayIdx(o.date)`; class `.ov-oneoff` — dashed border, category-neutral tint,
  small "one-off" tag; carries its status dot when logged (reuse the existing
  dot logic keyed on `eventId === o.id`).
- Read-only: `pointer-events: none` (the app's own drag/edit only ever moves the
  recurring template — a one-off is managed from Today or the bot).
- Print-hidden like every other overlay decoration.
- Day view parity is not optional (standing directive): the same blocks must
  appear in `#dayview` for the selected day.

## 3. Today-view freshness affordance (js/plan/today.js)

Tiny "· synced HH:MM" caption under the date header, updated whenever a sync
applies, so a stale tab is visible at a glance rather than silently wrong.

## Tests

- state: pendingSaves blocks application; older-remote (savedAt <
  lastLocalSaveAt) ignored; newer-remote applied; identical blob → no re-render;
  fetch error → state untouched; visibility-hidden → no poll.
- overlay: current-week one-off renders in the right column in BOTH #grid and
  #dayview; wrong-week one-off doesn't; logged one-off gets its dot; repeated
  apply stays idempotent; drag guard still honored.
- today: synced caption renders and updates.

## Verify & ship

Bare `node --test`; `node --check`; print harness (plan.css changes) for
week/today/no-attr; browser check: two tabs — write in one (or via the bot's
endpoint), the other picks it up within 120s and on refocus; day-view parity
screenshot at 390px. Tag `planner-v2.5`, push, verify live.
