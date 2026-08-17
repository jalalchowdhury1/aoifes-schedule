# Time-Away Redesign (Year page v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Approved by the family 2026-08-17 ("do it and show me") after brainstorming; supersedes the week-marking model shipped in planner-v1.

**Goal:** Replace week-level marking (tap-to-cycle squares, Flip button, `weeks` map) with day-precise "time away" periods entered as date ranges, making the Year page view-only and mistake-proof.

**Decisions (approved):** trips-list model; `light` week type REMOVED; Flip button REMOVED (cycle comes from Charlton calendar: work stretches Tue→Mon, `dutyStart: 2026-08-11`, Monday-parity `anchorMonday: 2026-08-24` — both already live in KV); tap-a-week = info only.

**Ground rules:** same frozen files as planner-v1 (see AGENTS.md). Bare `node --test`. Commit per task, push only at the end after review.

---

## Data model (v1 → v2, additive + migration)

```
periods: [{ id:'p1', start:'2027-01-04', end:'2027-02-06',
            type:'travel'|'off', label:'Dhaka ✈' }]
```
- `sanitizePlan`: validate ISO dates, start ≤ end, type in set, non-empty id; sort by start.
  MIGRATE legacy `weeks` map: each entry → 7-day period (monday..monday+6), travel→travel,
  off→off, light→DROPPED; then delete `weeks` key. (Prod currently has `weeks:{}`.)
- `parentCycle.dutyStart` (Tuesday a work stretch starts) — already in prod KV; sanitize:
  ISO-validate, default `'2026-08-11'`.

## Pure model changes (js/plan/model.js) — Task A [Opus]

- `dayAway(periods, date)` → `null` or the covering period.
- `dayStatus(periods, date)` → `{away:false}` or `{away:true, type, label, dayN, total}`
  (dayN = 1-based day within the period, total = period length in days).
- `isWorkDay(cycle, date)` → `((daysBetween(cycle.dutyStart, date) % 14) + 14) % 14 < 7`.
- `effectiveDaysInWeek(act, weekStart, periods)` → sum over the 7 days:
  school day = 1; away travel-day = act.travel mode (continue 1, reduced factor±0.5, pause 0);
  away off-day = 0.
- `weekCapacity(act, weekStart, periods, cycle)` = rhythm base (daily 7 / weekly N /
  cycle per-parity as today) × effectiveDaysInWeek/7. Weeks-map parameter is GONE.
- `projectFinish`, `requiredPerCycle`, `targetStats` consume `plan.periods`
  (targetStats "teaching week" = week with ≥4 plain school days).
- `tripImpact(plan, draft)` → for each active paced activity with known counts:
  `{id, name, before, after}` finish dates (before = current periods; after = periods+draft,
  draft may carry an id to replace when editing). Used for the live preview in the sheet.
- KEEP: cycleStats (Monday-parity), everything else.
- Tests (rewrite the JAN_TRIP fixture as a period `2027-01-04..2027-02-07`):
  - isWorkDay: 2026-08-17 true, 2026-08-18 false, 2026-08-24 false, 2026-08-25 true.
  - 3-day trip inside a home week → LoE capacity ≈ 2.5×4/7 (±.01); Singapore daily+reduced
    with a Mon–Wed trip → 3×0.5 + 4 = 5.5; off-type period → those days 0 even for reduced.
  - projectFinish with the 34-day Jan trip lands in the same Feb–Mar window as before.
  - tripImpact: adding the Jan trip moves LoE finish later, leaves it before the goal.
  - sanitize: weeks→periods migration (travel kept, light dropped), bad periods dropped,
    `weeks` key gone after sanitize.

## State changes (js/plan/state.js) — Task A

- `addPeriod({start,end,type,label})` (id = `p<n>` from max), `updatePeriod(id, patch)`,
  `deletePeriod(id)`. REMOVE `setWeekType`, `flipAnchor`. Mutation tests for all three
  (add→edit→delete round-trip leaves plan equal to start, modulo savedAt).

## Year view rewrite (js/plan/year.js + css/plan.css) — Task B [Opus]

- Tracks: view-only. Cell away-classes from periods: all-7-days away → `trip` (full hatch);
  1–6 days → `trip-part` (half-height hatch, new CSS); off-type darker than travel-type.
- Collapse non-active subjects to one line: "Not started: Singapore Math · Geography ·
  Science · Jiu Jitsu — manage in Subjects · Parked: History".
- Tap a week cell → small info card (positioned under the tracks, not a browser popup):
  "Week of Jan 4–10 · 5 away days · Dhaka ✈" + [Edit trip] (opens sheet for that period)
  or "school all week" + [+ Time away this week] (opens sheet prefilled Mon..Sun). Tap
  elsewhere dismisses. NO mutation from the cell itself.
- TIME AWAY list under tracks: one row per period — "✈ Dhaka · Jan 4 – Feb 6 · 34 days"
  (✈ for travel, ⏸ for off) — tap row → edit sheet. `[+ Add time away]` button.
- Sheet (own markup in #view-year, styled like the app's bottom sheet on mobile):
  From/To `<input type=date>`, Label text input, Type radio Travel/Off (Travel default,
  helper text: "Travel = Singapore Math keeps going every other day · Off = everything pauses"),
  live impact block re-rendered on any change via tripImpact ("Geography → May 29 (was Apr 24) ·
  LoE → Mar 14 · still 24 wks before goal ✓"), buttons Delete (edit mode only, with confirm) /
  Cancel / Save. Validation: end ≥ start, both dates required; label optional (default
  "Time away"). esc() everything; dates rendered via a `fmtRange` helper ("Jan 4 – Feb 6").
- Footer line replaces anchor+Flip: "Mama works Tue–Mon, every other week · next work week:
  <computed from dutyStart>". No buttons.
- Legend row (done · planned · away · off) + 3-letter month labels + "today" tag on the line.

## Today view changes (js/plan/today.js) — Task C [Sonnet]

- Chips: `isWorkDay` → "Mama: work day"/"Mama: home day"; next-trip chip reads periods.
- Away-day banner card at top: "✈ Dhaka · day 3 of 34" (or "⏸ Off · day 1 of 2").
- On away days: timed template blocks hidden; planner-slot blocks hidden; dailies shown
  only if their travel mode ≠ pause on travel days (Singapore yes, LoE no); on off-type
  days hide all dailies. Tomorrow strip respects the same rules.
- LoE cycle sub-line unchanged otherwise.

## Reviews & ship

Spec review (Sonnet) on the full diff vs this plan; quality review (Opus code-reviewer) with
print-regression re-run (plan.css changes again!) and a live-data migration check (KV blob
still sanitizes clean; log/periods preserved). Fix loop as needed. Then: AGENTS.md planner
contract updated (periods replaces weeks; setWeekType/flipAnchor gone), plan addendum, single
push, live verify (site + a real trip round-trip via the sheet), screenshots to the family.

---

## Execution addendum (2026-08-17)

Built in one session under `superpowers:subagent-driven-development`, three task
commits then a single review round, then one push. Bare `node --test`
throughout (`node --test tests/` still breaks on Node 24).

### The three task commits

| SHA | Task | What landed |
|---|---|---|
| `6e7c14b` | A — model + state | `periods` replaces `weeks`: `dayAway`/`dayStatus`, day-precise `effectiveDaysInWeek`, `weekCapacity(act, weekStart, periods, cycle)`, `isWorkDay` off `parentCycle.dutyStart`, `tripImpact`, `sanitizePlan` migration (`weeks` → 7-day periods, `light` dropped, key deleted). `addPeriod`/`updatePeriod`/`deletePeriod` in; `setWeekType`/`flipAnchor` out. 5 files, +487/−68. |
| `a981e57` | B — Year page | View-only tracks (`trip`/`trip-part`/`offw`/`offw-part` hatches), collapsed non-active line, week info card, Time-away list, add/edit sheet with live impact preview, footer stating the cycle. 4 files, +399/−64. |
| `d963003` | C — Today page | Away-day banner (`day N of M`), `isWorkDay` Mama chip, next-trip chip from `periods`, travel/off rules for timed blocks + dailies + the tomorrow strip; the last `weeks` shims removed. 6 files, +211/−55. |

### Declared deviations from the plan above

1. **Delete has no `confirm()`.** The plan said "Delete (edit mode only, with
   confirm)". A native dialog is easy to mis-tap on a phone and impossible to
   style, so it shipped as a two-tap button ("Delete" → "Tap again to delete",
   disarmed by any other interaction). The review round extended the same
   pattern to Subjects' Cancel, making *no browser dialogs* a planner-wide
   invariant that the tests now enforce by poisoning `alert`/`confirm`/`prompt`.
2. **Legend reads "travel", not "away".** The plan's wording was
   "done · planned · away · off"; with two away *types* on screen, naming the
   travel hatch "travel" is what actually distinguishes it from "off".
3. **Off-type weeks get their own classes** (`offw`/`offw-part`) rather than the
   plan's "off-type darker than travel-type" restyle of `trip` — same visual
   result, but it keeps the majority rule (`awayCls`) expressible in one line.
4. **Tap-elsewhere-dismisses the info card was missed in Task B** and is Fix 1
   of the review round below — it was in the plan, so it is a gap, not a change.

### Review round (one commit: card dismissal, sheet fold, overlap semantics, year tests, a11y, no-dialog subjects)

Two verified reviews (spec + quality) produced six fixes and the doc updates:

1. **Spec gap — info card outside-tap dismissal.** One document-level `click`
   listener, bound only while a card is open (stable fn ref ⇒ idempotent
   add/remove); exempts week cells, the card itself, and the sheet outright so
   it can never tear down sheet inputs mid-interaction.
2. **I1 — desktop sheet below the fold.** On open only, `.ysh` is
   `scrollIntoView({block:'nearest'})`; guarded by a `justOpened` flag so the
   per-keystroke impact re-render and post-save `planNotify()` never steal the
   scroll position. Verified at 1280×680.
3. **I2 — overlapping-period semantics.** `dayAway` now resolves `off` OVER
   `travel` (same type → first in sort order); the sheet shows a non-blocking
   `.form-err.warn` notice naming the overlap ("Overlaps ✈ Dhaka (Jan 4 – Feb 6)
   — Off days win over Travel days.") with Save still enabled; the Today
   next-trip chip skips periods whose own start day resolves to a different
   period, so a fully shadowed trip is never advertised.
4. **I3 — Year pure helpers under test.** `fmtRange`, `perName`, `awayCls`,
   `weekAway`, `nextWorkStart` exported; new `tests/plan-year.test.mjs`.
5. **M1+M2 — cheap a11y.** Sheet focuses the first date input on open, `Escape`
   closes sheet + card, `aria-modal="true"`; the `role=button tabindex=0` list
   rows now activate on Enter/Space.
6. **M5+M8 — honesty + the dialog invariant.** One-line comments on the
   `state.js` early returns (the UI validates first; no `commit()` ⇒ no
   re-render); Subjects' `confirm()` replaced by the two-tap pattern.

Docs: this addendum plus the AGENTS.md planner contract (shape without `weeks`,
off-wins-over-travel, the no-dialogs invariant, `planner-v2` rollback tag) and
the stale anchor-parity open item, which is now CONFIRMED — work runs Tue→Mon
from `dutyStart 2026-08-11`, the Flip button is gone, and `parentCycle.confirmed`
is inert metadata (the seed says `true`).

Shipped as tag `planner-v2`.
