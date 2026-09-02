# `ask:false` blocks · skip-aware capacity · red-team lows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (A) A template block can be marked `ask: false` — on the calendar and grid, but nobody is asked whether it happened (Jumu'ah, Fridays 12–3). (B) The pace/capacity math on both sides honours skip overrides, so a skipped week expects nothing from that class. (C) Close the three cosmetic lows from the 2026-09-01 red-team report and add the missing Day-view greying test.

**Architecture:** (A) is an additive optional field on `aoifes_schedule.events[]` (`ask: false`); `buildTimed`/`expected_timed` carry it as `item.ask`, and only the *asking* surfaces change — day-done counts, ✓/◐/✗ controls, the bot's check-in questions and `unlogged_items`. Everything else (grid, print, calendar, preview, "now/next" timer) is untouched. (B) `weekCapacity`/`week_capacity` take the plan's overrides and subtract one session per activity-keyed skip that lands on a teaching day of the week; `expectedSessions` does the same per day for daily rhythms. (C) small local fixes.

**Tech Stack:** Planner: `node --test tests/*.test.mjs` (baseline **408**). Bot: `uv run pytest -q` (baseline **595**). Same commit-trailer, same repo-path quoting rules as the previous plans. Planner tasks A1–A3 in one implementer, in order; bot tasks B1–B3 in a second implementer in parallel; release last (controller).

---

## Planner

### A1 · `ask: false` on the site (Jumu'ah is never a question)
**Files:** `js/plan/mday.js` (`buildTimed`, `dayState`, `weekGlance`, `receipt` untouched), `js/plan/today.js` (~line 264–275, the timed row with `.tbtn` buttons), `js/m.js` (~line 296–330, the Today row; and the Week tab's today rows ~823 if they carry controls), `js/model.js` (`isValidEvent` unchanged; document the field in the contract comment), `tests/plan-mday.test.mjs`, `tests/plan-today.test.mjs`, `tests/plan-m.test.mjs` (if the phone rows are tested there), `tests/model.test.mjs` (field survives `sanitizeEvents` and `updateEvent`).
- Contract: an event may carry `ask: false`. `isValidEvent` ignores it (already does — it only checks required keys); `sanitizeEvents` and `updateEvent` (`{...x, ...patch}`) must PRESERVE it — add a test for each.
- `buildTimed`: `ev:` items get `ask: ev.ask !== false`; `act:`/`ov:` items get `ask: true`.
- `dayState`: the `all`/`total`/`unlogged`/`left`/`names` computation excludes `ask === false` items. The `now`/`next` phases still see them (the block is real; the widget's countdown stays).
- `weekGlance`: the week card's classes done/total and the per-day dots exclude `ask === false` items. Read the function to find every place it counts timed items.
- Desktop Today (`today.js`) and phone Today (`m.js`): an `ask === false` timed row renders time + name with NO ✓/◐/✗ controls (and no long-press menu on the phone). Keep it visually a normal row minus the controls; do not hide it.
- Tests: `buildTimed` carries `ask`; `dayState` with one `ask:false` block + one normal block → `total 1`; a day whose only block is `ask:false` → `phase 'empty'`... unless a daily exists; `weekGlance` totals exclude it; the desktop/phone row renders no `data-st` buttons for it (string assertion on the rendered HTML, using the existing render-test pattern in those files if any — else test the pure pieces and note it).
- Expect **≈ 415**. Commit `ask:false: a template block nobody is asked about (day-done counts, buttons, week glance)`.

### A2 · Skip-aware capacity (site half)
**Files:** `js/plan/model.js` (`weekCapacity`, `expectedSessions`, callers at ~315, 399, 665, 683), `js/plan/today.js` (~110–111), `js/plan/year.js` (~99), `tests/plan-model.test.mjs`.
- `weekCapacity(act, weekStart, periods, cycle, overrides = [])`: compute `cap` exactly as today, then subtract `mult` (the `sessionsPerDay` multiplier) for every `o` in `overrides` with `o.action === 'skip' && o.activityId === act.id && weekStart <= o.date <= addDays(weekStart, 6) && dayWeight(act, o.date, periods) > 0`; return `Math.max(0, cap - skips * mult)`. Template `eventId` skips never match (they belong to core categories).
- `expectedSessions`: the weekly/cycle branch passes `plan?.overrides` into `weekCapacity`; the daily branch prices a date at 0 when a matching skip for that activity exists on that date.
- Every caller passes the plan's overrides (`plan.overrides` / `p.overrides`). `requiredPerCycle` (~683) too.
- Tests: weekly on-grid activity, one skip in the week → capacity 0; skip on an away (paused) day → unchanged (no double subtraction); skip in another week → unchanged; template `eventId` skip → unchanged; `expectedSessions` across a 2-week span with one skip → one less; existing projection date pins (LoE/Singapore) unchanged.
- Expect **≈ 421**. Commit `capacity: a skipped class costs the week one session (site half of the parity change)`.

### A3 · Lows + missing test
**Files:** `js/grid.js` (L6), `js/plan/mday.js` (`receipt`, L8), `tests/plan-overlay.test.mjs`, `tests/plan-mday.test.mjs`, `tests/grid.test.mjs` (if the drag harness from P4 can exercise L6).
- **L6:** `onUp` sets `suppressClick = true` then `setTimeout(() => { suppressClick = false; }, 0)` (the browser's synthesized click is dispatched synchronously after pointerup, before any timer) and `pointerdown` resets `suppressClick = false` — a pointerup that lands outside `#grid` can no longer swallow the next genuine click.
- **L8:** in `receipt()`, when several timed items share an `activityId` (the `act:` slot plus a same-day `ov:` makeup), only the `act:` item takes the lesson detail and consumes the `byAct` entry; the `ov:` item stays a bare line. Test with both items present.
- **Missing test:** `tests/plan-overlay.test.mjs` — a skip override dated this week's slot day → the Day-view twin carries class `pslot-skip` and the `ov-tag`; a skip in another week → not greyed.
- Expect **≈ 425**. Commit `grid/receipt: click latch cleared; lesson detail goes to the slot item; Day-view greying test`.

---

## Bot

### B1 · `ask: false` (the check-in never asks about Jumu'ah)
**Files:** `lib/compose.py` (`Item` gets `ask: bool = True`; `expected_timed` sets `ask=False` when the template event carries `ask is False`; `unlogged_items` excludes `not it.ask`; `checkin_message` renders no question/buttons for it — read how it builds rows; `preview`/morning message still lists it; `last_class_end` unchanged), `tests/test_compose.py` (+ `tests/conftest.py` may add an `ask: False` event to the schedule fixture ONLY if that doesn't disturb existing expectations — otherwise build the schedule inline in the new tests).
- Also confirm the bot's `sanitize_events`-equivalent keeps the field (it only checks required keys).
- Tests: `expected_timed` carries `ask=False`; `unlogged_items` omits it; `checkin_message` text has no line/button for it while other blocks keep theirs; preview still names it; `last_class_end` still uses its end (Friday check-in timing unchanged).
- Expect **≈ 600**. Commit `check-in: an ask:false template block is never a question (Jumu'ah)`.

### B2 · Skip-aware capacity (bot half, parity)
**Files:** `lib/compose.py` (`week_capacity` ~526 gains `overrides=None`; callers ~588, ~614 pass `overrides(plan)`; `expected_sessions` if present mirrors the daily-branch rule), `tests/test_compose.py`.
- Same rule as the site: subtract `mult` per `action == 'skip'` override with `activityId == act['id']`, dated inside the week, whose `day_weight`/travel weighting is > 0; clamp at 0. Template `eventId` skips never match.
- Tests mirroring the site's (one skip → 0; skip on an away day → unchanged; other week → unchanged; existing parity date pins for LoE/Singapore byte-identical).
- Expect **≈ 604**. Commit `capacity: a skipped class costs the week one session (bot half, parity)`.

### B3 · L7 — repeat ✓ keeps its `· Lesson N` suffix
**Files:** `lib/ops.py` (`_apply_log_status` timed branch), `tests/test_ops.py`.
- When `was_done and now_done` (a second ✓ on the same class the same day), set `lesson_label` from the existing `viaTimed` lesson row for that `(activityId, date_str)` (`compose.session_label(cur_by_id(row['curriculum']), row['session'])`), so the confirmation reads the same as the first tap.
- Test: two consecutive `done` taps → both messages end with the same label; `done` still 1.
- Expect **≈ 605**. Commit `log_status: a repeat ✓ confirms the same lesson it logged`.

---

## Release (controller)
1. Planner: stamps `?v=2026-09-02-1` → `?v=2026-09-02-2`, AGENTS.md bullets (the `ask` field in the data-contract section + the three items), suite green, commit, push, poll prod.
2. Data: `aoifes_schedule.events` → `e1013.ask = false` via a Node script (read `/api/get` → set → `/api/save`), then verify `/api/get` shows it.
3. Bot: AGENTS.md tail entry, `uv run pytest -q`, commit, push, `vercel --prod --yes`, READY.
4. Verify with the LIVE blobs: bot `expected_items('2026-09-04')` shows Jumu'ah with `ask=False`, `unlogged_items` omits it, `checkin_message` has no Jumu'ah button, preview still lists it; site prod DOM still 3 `.pslot` + Science greyed; `node --test` and `uv run pytest` green.
