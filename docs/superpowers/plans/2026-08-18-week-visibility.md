# Week Visibility — dots for the whole week + Yesterday receipt

> Approved by the family 2026-08-18 ("yes please"). Small, two changes, one implementer.
> House rules apply: frozen files per AGENTS.md, bare `node --test`, no dialogs, esc() everything,
> print safety re-verified if css/plan.css changes.

## 1. Week-grid dots for the whole current week (js/plan/overlay.js)

Currently `applyOverlay` decorates only today's column (`e.date === today && ev.day === tIdx`).
Change: decorate the whole **current week** — for each log entry with an `eventId` whose
`date` falls within `[mondayOf(today), mondayOf(today)+6]`, find the template event and append
the dot to its block (the entry's own date determines nothing further — template events are
unique per weekday, so entry date and column agree by construction). Keep: idempotent
`.ov-dot` sweep, statuses ✓/◐/✗ with existing classes, `pointer-events:none`, print-hidden.
Log entries without `eventId` (dailies, planner slots) stay undecorated — the grid only
renders template blocks.

## 2. "Yesterday" receipt line on Today (js/plan/today.js)

Below the tomorrow strip, same styling family (`.tmwrow`), render a receipt for
`yesterday = addDays(today, -1)`:
- If yesterday was away (`dayStatus`): "Yesterday: ✈ <label>" (or ⏸) — nothing else.
- Else collect yesterday's log entries: timed ones joined to `timedFor(yesterday)` items for
  names (fall back to the raw event's `evLabel` if an event no longer exists → skip silently),
  plus daily/paced entries (`activityId`, no `eventId`, no `timed`) joined to activity names.
  Render "Yesterday: ✓ Quran · ✓ Ruhama — ELA/Math · ✓ Logic of English" with per-entry
  icon by status (✓ done, ◐ partial, ✗ missed).
- No log entries yesterday and not away → render nothing (no guilt-tripping empty line).

## Tests

- Overlay: extend/adjust existing coverage if present; add a DOM-stub check — entries dated
  Mon and Tue of the current week both produce dots in their columns during one apply; an
  entry from last week produces none; repeated apply stays at one dot per block.
- Today: receipt renders with mixed statuses and a daily entry; away-yesterday variant;
  silent when empty. (Stub-DOM pattern from tests/plan-today.test.mjs.)

## Verify & ship

Bare `node --test` green; `node --check`; print states unchanged (only if plan.css touched);
combined spec+quality review; push tag `planner-v2.2`; confirm live.

## Review addendum: weekday-agreement guard (grid vs. receipt asymmetry)

Review round found a gap in §1: if a template block is dragged to a different weekday
mid-week after a log entry was made against it, the original filter (`eventId` + date-in-
week) would still dot the block — in its *new* column, on a day the entry never happened,
and potentially stacked against a newer entry for the same event. Fixed by adding a
weekday-agreement guard: an entry only decorates the block when `dayIdx(e.date) === ev.day`
(the entry's logged date and the event's current weekday must agree). A moved block simply
loses its stale dot until re-logged. This is a deliberate asymmetry with §2's Yesterday
receipt, which does **not** re-check weekday agreement: the grid enforces it because a
column is itself a claim about which day a block lives on, and a stale/wrong-column dot
would misrepresent that claim — but a receipt is a plain text list with no column to
contradict, so it keeps naming the (possibly since-moved) activity by whatever name resolves
today, exactly as designed in §2's fallback.

## Addendum: Day-view parity fix (2026-08-18, follow-up round)

Shipped §1 decorated `#grid` only. The family uses phones, where the **mobile Day
view is the default** — so the feature was invisible exactly where it mattered. A
second, latent bug rode along: main.js's 60-second `renderGrid(); renderDayView();`
timer (and every day-tab tap in js/dayview.js) replaces those containers' innerHTML
wholesale, and neither path goes through the onChange/planNotify hooks that call
`applyOverlay` — so on the *week* grid too, the dots silently disappeared within a
minute of any log entry and only came back on the next data mutation. A pre-fix
browser run reproduced both: no Day-view dot at all, and the two week-grid dots gone
after 65 seconds.

Fix, all inside js/plan/overlay.js (every render module stays frozen):

1. **Both containers.** `applyOverlay` now decorates `#grid` *and* `#dayview` in one
   pass — same current-week log window, same weekday-agreement guard, and the
   idempotent `.ov-dot` sweep runs over both. The Day view renders only the selected
   day's column, so the plain `.evt[data-id]` query naturally hits just the blocks it
   is showing; no per-selected-day special-casing.
2. **A MutationObserver re-applies.** One observer (registered by the new exported
   `initOverlay()`, called from `initPlanner()`) watches `childList`+`subtree` on both
   containers, so whoever rebuilds them — timer, day tab, or future code — the dots
   come back. Bursts coalesce through a `queueMicrotask` so a full grid rebuild costs
   one re-apply, not dozens.
3. **Loop prevention, two layers.** `applyOverlay` mutates the very containers being
   observed. An `applying` boolean guards re-entry, but note that the flag *alone* is
   not sufficient in a real browser: observer records are delivered asynchronously, so
   by the time the callback runs the flag is already clear and each re-apply would
   queue fresh records forever. The observer's own `takeRecords()` is therefore drained
   at the end of every apply, ending the cycle after exactly one pass.

`renderViews()` keeps its explicit `queueMicrotask(applyOverlay)`: the observer would
also catch that rebuild, but first paint should not depend on observer timing, and the
duplicate apply is cheap.

**Verification.** Bare `node --test`: 115/115 (7 new overlay tests — both containers in
one apply, sweep clears both, the weekday guard applies in the Day view too, observer
registered on both containers, rebuild-triggered re-apply, burst coalescing, and a
hostile synchronous-delivery stub proving the reentrancy guard stops recursion).
Headless Chromium at 390px, seeded with a `done` entry for today: dot visible and
painted on the Day-view block; day-tab away and back re-dots; **after a real 65-second
wait both the Day-view dot and the two week-grid dots are still there**, with exactly
3 dot writes during that window (one re-apply for the one timer tick) — no observer
feedback loop. Print re-checked for `ptab=week`, `ptab=today` and no-attr: `#dayview`
and `.ov-dot` are `display:none`, `.grid-outer` is visible, one letter-landscape page,
byte-identical across all three. No CSS was touched.
