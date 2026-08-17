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
  away day (`dayAway ≠ null`) — travel's every-other-day rhythm keeps streaks alive.

Render in today.js, after the date-header card, a `.pcard` "THIS WEEK" section:
- "Teaching week N" (omit if null)
- One line per active cycle-rhythm activity: "Logic of English — 2 of 3–4 this cycle"
  with an ok/warn chip (done ≥ targetMin → ok "on pace"; else neutral until the cycle's
  last 3 days, warn only then).
- One line per active daily-rhythm activity with streak ≥ 3: "Singapore Math — 🔥 12-day
  streak". (Singapore is still `planned`, so this line appears the day it's activated —
  state that in the report, it is NOT a bug that it's absent now.)
- Card renders only if it has at least one line.

## Tests

- teachingWeekNumber: week 1 at year.start; away-week skipped (majority-away week returns
  null and doesn't increment the count for later weeks); resumes after a trip.
- dailyStreak: plain run; today-unchecked-morning keeps yesterday's streak; single away-day
  gap bridged; non-away gap breaks; empty log → 0.
- Existing 70 stay green.

## Verify & ship

`node --test`; `node --check`; headless smoke: hit-layer column tap selects correct week at
390px and 1440px, ‹/› step, band renders, no listener growth over 5 cycles; print harness
(year + today + no-attr states) unchanged output; spec review + quality review; push with tag
`planner-v2.1`; live screenshots to the family.
