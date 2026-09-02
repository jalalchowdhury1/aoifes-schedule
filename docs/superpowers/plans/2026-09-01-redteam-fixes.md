# Red-team fixes (2026-09-01 night) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every High/Medium finding from the 2026-09-01 red-team review of "planner slots on the grid" + "a ✓ on a class block is that lesson done", across the planner site, its Google-Calendar sync, and the Telegram bot — with tests that would have caught each.

**Architecture:** (1) Lesson rows written by a ✓ get provenance (`viaTimed: true`) so the ✓ ↔ lesson loop is closed and never touches lessons it didn't write; the merge gives attendance rows their own identity tier. (2) Every remaining reader that lists log rows folds attendance + lesson into one line. (3) The grid greys a slot skipped this week; the calendar gets `EXDATE`s for skips. (4) A fixed-calendar class carries `finishOn` which both projectors return verbatim. (5) The bot's `skip_occurrence` accepts an activity target. (6) The generated widget is rebuilt and a test makes staleness impossible.

**Tech Stack:** Planner: vanilla ES modules, `node --test tests/*.test.mjs` (baseline **388**). gcal sync: Python in `scripts/gcal-sync` (`cd scripts/gcal-sync && uv run --frozen pytest -q`). Bot: Python, `uv run pytest -q` (baseline **588**), deploy `vercel --prod --yes`.

Repo paths — ALWAYS quote the first: `"/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule"` (planner, `main`, HEAD `802c61a`) and `~/PycharmProjects/aoife-school-bot` (bot, `main`, HEAD `9659b66`). Commit messages end with:

```
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KP54gc9RG6WQccxBqECYCG
```

Planner tasks P1–P5 are one implementer, in order (same working tree). Bot tasks B1–B3 are a second implementer, in parallel (different repo). G1 (gcal sync, lives in the planner repo) runs AFTER P5. Release R1 last.

---

## Planner

### P1 · Provenance on ✓-written lesson rows; closed loop; merge tier (red-team H1 + M1)

**Files:** `js/plan/state.js` (`logTimed`), `js/plan/model.js` (`mergePlanWrites` → `logKey`), `tests/plan-state.test.mjs`, `tests/plan-merge.test.mjs`.

Behaviour to implement:
- The lesson row `logTimed` appends gains `viaTimed: true`: `{ date, activityId, status:'done', curriculum, session, viaTimed: true }`.
- **Append guard:** on entering `done`, append ONLY if no lesson row for `(activityId, date)` already exists (`!timed && !eventId && curriculum && typeof session === 'number'`, any provenance). If one exists, write the attendance row only (the class is already counted).
- **Rollback guard:** on leaving `done`, remove ONLY rows with `viaTimed === true` for `(activityId, date)`; a lesson logged by `logSession`/`togglePaced`/the API/the bot's `log_progress` is never touched by an untick.
- `mergePlanWrites`: `logKey` gives timed rows their own tier so an incoming blob holding only the lesson half can never suppress the other writer's attendance row:
  ```js
  const logKey = e => `${e?.date}|${e?.eventId || e?.activityId || ''}${e?.timed ? '|t' : ''}`;
  ```
  Everything else in the merge unchanged (session rows still key on `curriculum#session`; the ✗-marker suppression still works because a marker and a session row share the untagged key).

Tests (add; keep the existing ones passing — adjust ONLY the assertion in the existing "writes attendance AND its next lesson" test to expect `viaTimed: true` on the lesson row):
- ✓ when a lesson row for that day already exists (write one via `logSession('geography', D)` first) → attendance row added, NO second lesson row, `done` unchanged (1).
- ✓ then `logSession` (a second lesson the same day) then untick → only the `viaTimed` row is removed; the `logSession` row stays; `done` goes 2 → 1.
- untick when the only lesson row that day is NOT viaTimed → nothing removed, `done` unchanged.
- merge: `current = {log: [attendance(tg), lesson#1]}`, `incoming = {log: [lesson#1]}` → merged log contains the attendance row (was dropped before). And the inverse (`incoming` has only the attendance row) carries the lesson row + bumps `done` exactly once (existing bump-replay).

Run `node --test tests/*.test.mjs` → expect **388 + 4 + 2 = 394**, 0 fail. Commit: `logTimed: viaTimed provenance closes the ✓ loop; merge gives attendance rows their own tier`.

### P2 · Desktop "Yesterday" line folds attendance + lesson (red-team H3)

**Files:** `js/plan/today.js` (`yesterdayHtml`, ~line 148), `tests/plan-today.test.mjs`.

In the loop over `p.log.filter(x => x.date === dateStr)`: skip an attendance row (`e.timed && e.activityId && !e.eventId`) when a lesson row for the same `(activityId, date)` exists (`!timed && !eventId && curriculum`); then dedupe entries by `key = e.eventId ?? `${e.activityId}|${e.timed ? 't' : 'l'}`` so a tb-wb day (two Singapore rows) also reads once. Keep schedule order. Tests: one ✓ on an on-grid class (two rows) → exactly one "✓ <name>"; two Singapore session rows → one "✓ Singapore Math"; a `missed` attendance with no lesson row still shows "✗ <name>". Look at the existing `yesterdayHtml` tests in that file for the fixture/stub pattern. Expect **397**. Commit: `today: Yesterday line lists an on-grid class (and a tb-wb day) once`.

### P3 · Grid greys a slot skipped this week (red-team M2)

**Files:** `js/plan/model.js` (`gridSlots`), `js/grid.js` (`renderGrid`, `slotHTML`), `js/plan/overlay.js` (`applyOverlay`/`applySlots`), `css/plan.css`, `tests/plan-model.test.mjs`, `tests/grid.test.mjs`.

- `gridSlots(activities, overrides = [], weekStart = null)`: when `weekStart` (a Monday ISO) is given, each block gains `skipped: <ISO date> | null` — the date `addDays(weekStart, slot.day)` if `overrides` contains `{action:'skip', activityId === actId, date === that date}`. Without `weekStart`, `skipped` is `null` (pure callers like the gcal sync are unaffected — it is Python anyway).
- `renderGrid()` passes `plan.data.overrides` and `mondayOf(todayStr())` (import `mondayOf, todayStr` from `./plan/model.js`); `slotHTML` adds class `pslot-skip` and a `<span class="ov-tag">skipped</span>` when `b.skipped`. `applyOverlay` passes the same two args so the Day-view twin greys too.
- `css/plan.css`: `.evt.pslot-skip { opacity: .55; border-style: dashed; }` on screen; `@media print { .evt.pslot-skip { opacity: 1; border-style: solid; } .evt.pslot-skip .ov-tag { display: none !important; } }` — **print stays the recurring week** (hard rule 2), unchanged.
- Drag still works on a skipped block (it is still the recurring slot).
- Tests: `gridSlots` with/without `weekStart`; a skip on another week does not grey; `slotHTML` emits the class + tag only when `skipped`. Expect **400**. Commit: `grid: a slot skipped this week is greyed on screen (print unchanged)`.

### P4 · Small fixes bundle (red-team M3-site, M5, L1, L2, L3, L5)

**Files:** `js/plan/model.js`, `js/grid.js`, `js/plan/state.js`, `js/plan/year.js`, tests.

- **M3 (site half):** `projectFinish(act, …)` returns `{ date: act.finishOn, weeks: null, fixed: true }` when `isISO(act.finishOn)` (a fixed-calendar class — its end is the teacher's, not a pace). Check every caller uses `.date` (subjects.js header, mday.js subjectCards, year.js, today.js) and tolerates `weeks: null`. Test: an activity with `finishOn` projects exactly that date regardless of chain/rhythm.
- **M5:** grid click on a `.pslot` when unlocked → `toggleSelect(null)` (deselects the previously selected template block and closes the editor) instead of a no-op. Test in `tests/grid.test.mjs` only if `toggleSelect` is reachable without DOM; otherwise document in the commit.
- **L1:** `historyRows` `shadowed` requires `e.status === 'done'` (a `missed` attendance is never hidden by a lesson row). Test.
- **L2:** slot `onUp`: commit only if `{day,start,end}` differs from `ptr.orig`; else restore + `renderGrid()` (no pointless full-blob POST).
- **L3:** build `ptr.sel` with the same `cssEsc` helper the overlay uses (copy the 2-line helper into grid.js: `typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(x) : x`).
- **L5:** `targetStats` done-row filter adds `&& !e.curriculum && !e.timed`.
Expect **≥ 402**. Commit: `grid/model/year: finishOn projections, deselect on slot click, shadow only done, no-op drop, cssEsc, targetStats guard`.

### P5 · Rebuild the widget bundle; make staleness a red test (red-team H2)

**Files:** `m/widget.js` (GENERATED — never hand-edit), `tests/plan-widget.test.mjs`.

```bash
node scripts/build-widget.mjs && git diff --stat m/widget.js
```
Add to `tests/plan-widget.test.mjs`:
```js
import { readFileSync } from 'node:fs';
test('m/widget.js is the current build of scripts/build-widget.mjs (never ship it stale)', () => {
  const { bundle } = buildBundle();
  assert.equal(readFileSync(new URL('../m/widget.js', import.meta.url), 'utf8'), bundle,
    'm/widget.js is stale — run: node scripts/build-widget.mjs');
});
```
(Use the same import of `buildBundle` the file already has.) Run the suite → green, **+1**. Commit: `widget: rebuild bundle (7 commits stale) + test that fails when it is`.

---

## Bot

### B1 · Provenance + guards (red-team H1 parity)

**Files:** `lib/ops.py` (`_apply_log_status` timed branch), `tests/test_ops.py`.
- Lesson row gains `"via_timed": True`. Append ONLY if no lesson row for `(activityId, date_str)` exists (`not timed`, no `eventId`, has `curriculum`, int `session`, any provenance) — then attendance only, no suffix. Rollback removes ONLY rows with `via_timed` true.
- Tests: ✓ when a lesson row already exists (seed one in `ctx.plan["log"]`, with `done` bumped to match) → no second lesson row, `done` unchanged; ✓ then a foreign lesson row appended (simulate `log_progress` by inserting a row without `via_timed`) then `missed` → only the via_timed row removed, `done` 2 → 1. Adjust the existing exact-shape assertion to include `"via_timed": True`. Expect **590**. Commit: `log_status: via_timed provenance closes the ✓ loop (site parity)`.

### B2 · `finishOn` in `project_finish` (red-team M3 parity)

**Files:** `lib/compose.py` (`project_finish`, ~line 561), `tests/test_compose.py`.
`project_finish` returns the activity's `finishOn` verbatim (same return shape the callers expect — read `projections_summary` to see what it consumes; if it expects a date string, return that; if a tuple/obj, mirror the site's `{date, weeks: None, fixed: True}`). Test: an activity with `finishOn: "2027-01-13"` → `projections_summary` says `finishes ~Jan 13, 2027`. Expect **591**. Commit: `projections: a fixed-calendar class ends on finishOn (site parity)`.

### B3 · `skip_occurrence` accepts a planner activity (red-team M4)

**Files:** `lib/ops.py` (`_validate_skip_occurrence`, `_apply_skip_occurrence`), `tests/test_ops.py`, and the `SYSTEM_PROMPT` example list in `lib/brain.py` ONLY if it enumerates valid targets.
- Validation: the target is valid if it is a template event id (as today) OR the `target` of a timed on-grid activity item in `compose.expected_timed(date, …)` for that date.
- Apply: write `{"date", "action": "skip", "activityId": target, "id": _next_override_id(plan), "src": "tg"}` for an activity; unchanged `eventId` shape for events. Both readers (`compose.py` ~721, site `mday.js` ~89) already honour `activityId` skips.
- Confirmation message names the class and the date like the event path does. `undo` unchanged (whole-blob revert).
- Tests: "Science is cancelled next Wednesday" → op accepted, override written with the next free `x<n>` id; the same date's `expected_items` no longer lists Science; an activity NOT on the grid that date is refused with the existing error text. Expect **594**. Commit: `skip_occurrence: a planner class can be skipped, not only template events`.

---

## gcal sync (planner repo, after P5)

### G1 · `EXDATE` for skip overrides

**Files:** `scripts/gcal-sync/gcal_sync/model.py` (`template_events`, `activity_slot_events`, `desired_state`), `scripts/gcal-sync/tests/test_model.py`, `AGENTS.md` (the "skip-overrides NOT reflected (documented v1 limit)" sentences).

- Both builders take the plan's skip overrides (`desired_state` already has `plan`; pass `plan.get("overrides")` into `template_events(schedule, today, overrides)` and `activity_slot_events(plan, today)`).
- For each recurring event, collect the skip dates: template → `o.action == 'skip' and o.eventId == ev.id`; slot → `o.action == 'skip' and o.activityId == a.id` (a slot skip applies to every slot of that activity on that weekday). Keep only dates whose weekday equals the event's weekday and that are `>=` the series DTSTART date. Emit, after the RRULE line, one line per date, sorted: `EXDATE;TZID=<the same tz string _timed() puts in start.timeZone>:<YYYYMMDD>T<HHMMSS>` where the time is the event's start (`_timed` → read its exact format; hours may be half-past).
- Because `signature(body)` covers `recurrence`, the reconciler will PATCH the five science exceptions on the next run; the `--if-changed` hash changes once.
- Tests: a skip on the right weekday → EXDATE line present in the exact format; a skip on a different weekday → ignored; a skip before DTSTART → ignored; template `eventId` skip → on the `tpl:` event; no skips → recurrence unchanged (byte-identical to today, so existing tests hold).
- Run `cd scripts/gcal-sync && uv run --frozen pytest -q` → green. Then `uv run --frozen gcal-sync --dry-run` from that directory → expect `patch=1` (act:science:0) or 2 if a template skip exists, `delete=0`. Do NOT run the real sync (the controller does).
- AGENTS.md: replace the two "NOT reflected" sentences with "skip overrides are reflected as EXDATEs since 2026-09-01 (weekday-matched, on/after DTSTART)". Commit: `gcal-sync: skip overrides become EXDATEs`.

---

## Release (controller)

### R1
1. Planner: stamps `?v=2026-09-01-3` → `?v=2026-09-01-4` (5 in index.html); AGENTS.md "Planner slots on the grid" section gains one bullet per P-task (viaTimed loop, merge tier, Yesterday fold, skipped slot greying, finishOn, deselect-on-slot-click, widget test); suite green; commit; push; poll prod for the stamp (cache-busted).
2. Data: `science.finishOn = '2027-01-13'` via a Node script (read → set → save), then verify the bot's `projections_summary` locally says Jan 13.
3. gcal: `scripts/gcal-sync/run.sh` → expect `patch=1`; verify on the live calendar that Sep 2 has NO Science event.
4. Bot: AGENTS.md tail entry; `uv run pytest -q`; commit; push; `vercel --prod --yes`; `vercel ls` READY.
5. Headless DOM check on prod: 3 `.pslot` blocks and `pslot-skip` on Science this week.
