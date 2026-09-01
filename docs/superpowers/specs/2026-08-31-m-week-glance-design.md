# /m Week tab — "the week at a glance" (2026-08-31)

User ask: "make the Week tab more useful for us … being able to see the week at
a glance is always great. Anything YOU think of." Decisions taken autonomously
(he delegated and was not watching); everything below is reversible by revert.

## What the tab does today
‹ › week nav · 7 day chips with a status dot · the SELECTED day's list (plan,
or a receipt for a past day). You have to tap each day to learn anything; the
Mama caption reads the state of MONDAY only, although a Charlton duty stretch
runs Tue→Mon so Mon and Tue–Sun are usually opposite; today's plan shows no
✓ marks after logging (open item b).

## What it becomes (top to bottom)
1. **Nav** as before, but the caption is honest: `Mama: work Mon · home Tue–Sun`
   (runs of `isWorkDay`, collapsed).
2. **Week card** — numbers in pairs: `9 of 14 classes · 64%` with a thin bar,
   then one capsule per active paced daily: `Singapore 6 of 7 lessons`,
   `LoE 0 of 1`. `expected` = `expectedSessions(act, Mon, Sun)` (tb-wb ÷2 →
   lessons). Past week: same numbers, final. Future week: `14 classes` only.
3. **The grid** (one glass card): the 7 day chips as column headers (same
   chip/dot/✈ semantics as now), under them a 7-column hour grid spanning the
   week's earliest start → latest end (min 6h), category-coloured blocks
   (desktop tokens.css dark `--el` colours), one-offs dashed, today's column
   tinted with a live "now" line, past-day blocks: done = solid, unlogged =
   dim, missed = red edge. Under it a **dailies rail**: one row per paced
   daily (Singapore, LoE), a 10px cell per day: filled = done, half = half,
   red ring = missed, faint ring = nothing, blank = away/paused. Tapping a
   column selects the day (same as tapping a chip).
4. **Changes this week** — only when non-empty: one-off `add`s (`Tue · 12–1pm ·
   + Science trial`), `skip`s (`− Quran · Wed`), away runs (`✈ Winter trip ·
   Mon–Sun · day 3 of 35`). These are the things a recurring template makes
   you forget.
5. **Selected day** — a `.psec` header naming the day; today's rows now carry
   their ✓/◐/✗ mark (closes item b) and a tap on a today row switches to the
   Today tab to log it (navigation, not a write — Week stays read-only).

## Architecture
- `weekGlance(weekStart, events, plan, today, nameForEvent)` in
  js/plan/mday.js — PURE, returns `{weekStart, weekEnd, hourMin, hourMax,
  days[7]{date,idx,dow,dNum,isToday,isPast,away,mama,timed[],dailies[],dot},
  mamaRuns, mamaLabel, timed{done,missed,total,elapsed}, paced[{id,name,
  short,color,sessions,expected,per,unit}], changes[]}`. `dayDot(items,
  dateStr, today)` also moves here (was `dotClassFor` in js/m.js) so the chip
  dot and the rail share one definition. `statusMark` is exported (was the
  private `markFor`).
- js/m.js `renderWeek` lays the model out; css/m.css gets `.wkcard/.wkgrid/
  .wkcol/.wkblk/.wknow/.rail*` rules. No new write paths.
- Tests: tests/plan-mday.test.mjs pins weekGlance on the fixture week
  2026-08-24 → 30 (real logged data) and the Mama runs for Aug 31's week.
- Widget bundle is rebuilt (it concatenates mday.js); stamps bumped on
  m/index.html; index.html's five stamps untouched (mday.js is imported
  without a stamp and the change is additive).

## Not doing (YAGNI / redundancy)
No per-block names in the grid at 44px columns (the list below names them);
no streak/pace chips here (Today's This-week card owns them); no editing.
