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
