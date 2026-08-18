# Quick Wins — Year tap targets, month labels, This-Week card

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Approved verbatim by the family 2026-08-17 ("lets get it done"). One implementer task, then spec+quality review, then ship.

**Ground rules:** frozen files per AGENTS.md; bare `node --test`; no browser dialogs; esc() everything; print safety re-verified because css/plan.css changes.

## 1. Fatter tap targets on Year tracks (js/plan/year.js + css/plan.css)

- Replace per-cell `<i>` click handlers with ONE invisible **hit layer** over the whole
  tracks block: an absolutely-positioned grid of N=weekCount full-height columns on top of
  `.ytracks` (below the info card z-order). One delegated click listener (also fixes review
  item M4). Track cells get `pointer-events: none`.
- Tapping a column selects that week: render a translucent **vertical highlight band**
  across all tracks (`.yband`, accent tint at low opacity) + the info card as today.
- **Fine adjustment for fat fingers:** the info card gains `‹` and `›` buttons that step
  the selection one week back/forward (updates band + card content; keyboard arrows too
  while the card is open). Card keeps ✕, outside-tap dismiss, Escape — all unchanged.
- No mutation from taps, exactly as before.

## 2. Month-label crowding (js/plan/year.js)

- When a month's span within the year is **< 3 week-columns** (the partial Aug at the start,
  partial month at the end), skip its label. Alignment grid unchanged. Desktop + mobile same
  rule (harmless on desktop, fixes the Aug/Sep collision on phones).

## 3. "This week" card on Today (js/plan/model.js + js/plan/today.js + tests)

New pure helpers in model.js (both tested):
- `teachingWeekNumber(plan, date)` → 1-based count of weeks from `year.start` through the
  week of `date` whose `awayDaysInWeek ≤ 3`; returns null if the week of `date` itself is
  majority-away (card then omits the line).
- `dailyStreak(log, actId, periods, today)` → consecutive-day count of `done` entries for
  the activity ending at `today` (or `yesterday` if today is unchecked — a morning must not
  read as a broken streak). A missing day does NOT break the streak when that day was an
  away day (`dayAway ≠ null`) — travel's every-other-day rhythm keeps streaks alive — but
  the bridge is **BOUNDED**: at most `MAX_BRIDGE = 2` *consecutive* missed away days keep a
  streak alive (one every-other-day gap plus one day of slack), and any `done` day resets
  the counter. A plain (non-away) missed day still breaks the run immediately. Both away
  types (`travel` and `off`) bridge identically. The bound is what stops a 34-day trip with
  zero entries from preserving a stale streak — the old run is gone by day 3 of the trip —
  and it stops the unchecked-morning grace from stacking on top of a trip.

Render in today.js, after the date-header card, a `.pcard` "THIS WEEK" section (on an away
day the `.abanner` is the headline, so the card renders AFTER the banner):
- "Teaching week N" (omit if null — including when `date` is past `year.end`)
- One line per active cycle-rhythm activity: "Logic of English — 2 of 3–4 this cycle"
  with a **capacity-aware** ok/warn chip. The cycle's real capacity is
  `cycleCap = weekCapacity(act, cs.start, periods, cycle) + weekCapacity(act, cs.start + 7d, …)`
  and `fullCap` is the same sum computed against `periods = []`:
  - `cycleCap <= 0` → neutral chip "paused" (a paused cycle can NEVER warn);
  - else `target = max(1, round(cs.targetMin × cycleCap / fullCap))`, ok "on pace" when
    `done ≥ target`, otherwise neutral until the cycle's last 3 days, warn only then.
- One line per active daily-rhythm activity with streak ≥ 3: "Singapore Math — 🔥 12-day
  streak". (Singapore is still `planned`, so this line appears the day it's activated —
  state that in the report, it is NOT a bug that it's absent now.)
- Card renders only if it has at least one line.

## Tests

- teachingWeekNumber: week 1 at year.start; away-week skipped (majority-away week returns
  null and doesn't increment the count for later weeks); resumes after a trip; null past
  `year.end`.
- dailyStreak: plain run; today-unchecked-morning keeps yesterday's streak; single away-day
  gap bridged; non-away gap breaks; empty log → 0; **bounded bridge** — a 34-day trip with
  no entries drops to 0 by day 3, an every-other-day pattern DURING a trip keeps counting,
  a plain missed day after a trip breaks, a 20-day `off` block with nothing → 0.
- Existing 70 stay green.

## Review corrections (2026-08-17, quality review of d4ab903)

Applied after the first implementation and re-reviewed against this spec: month-label
threshold `MIN_LABEL_SPAN` 3 → **4** (a 3-column month still collides at 390px); the
capacity-aware pace chip above (a cycle spent entirely on an off block must read "paused",
never "behind"); the bounded `MAX_BRIDGE = 2` streak bridge above; `teachingWeekNumber`
returns null past `year.end`; `.track .tl` is layered above the hit layer so subject names
stay selectable; the hit layer drops `aria-hidden` and exposes ONE keyboard-reachable
column (the current week, else the first) as `role="button" tabindex="0"` with
Enter/Space opening its card.

## Verify & ship

`node --test`; `node --check`; headless smoke: hit-layer column tap selects correct week at
390px and 1440px, ‹/› step, band renders, no listener growth over 5 cycles; print harness
(year + today + no-attr states) unchanged output; spec review + quality review; push with tag
`planner-v2.1`; live screenshots to the family.
