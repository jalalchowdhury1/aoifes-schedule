# Aoife's Planner — Design Spec

**Date:** 2026-08-16
**Status:** Approved through Section 3 verbally; final spec review pending (user asleep — proceeding on explicit "do what you have to do" authorization)
**Visual companion:** claude.ai artifact "Aoife's Planner — Design Preview" (illustrative mockup, not binding pixel spec)
**Predecessor spec:** `2026-07-20-schedule-v2-rebuild-design.md`

## 1. Summary

Grow the existing weekly-schedule app (aoifes-schedule.vercel.app) into a year-round
homeschool planner: yearly → weekly → daily curriculum pacing, per-activity progress
tracking, travel-aware projections, target-count activities, and one-tap catch-up —
while leaving the existing week grid, template editing, and print behavior untouched.

The family homeschools all 12 months. The only regular breaks: the January trip
(~4–6 weeks, Istanbul→Dhaka→Bangkok/Singapore in 2027) and occasional Eid weeks
(sometimes Toronto).

## 2. Invariants — NEVER break these

1. **Existing data contract frozen.** KV key `aoifes_schedule`, localStorage
   `aoife_v3`, `api/get.js`, `api/save.js`: not modified, not reshaped, not migrated.
2. **Print is sacred.** `css/print.css`, `js/print.js`, and the beforeprint/afterprint
   row-height machinery are not modified. Print output must remain byte-identical
   in behavior: always the full week grid, one letter-landscape page.
3. **Template editing untouched.** Drag/resize/edit of the recurring week works
   exactly as today. New code only *reads* the template.
4. **Same stack.** Vanilla JS, no frameworks, no build step, no new dependencies.
5. **Zero new cost.** Upstash free tier (one small extra key + one undo key),
   Vercel hobby plan, Google Drive (already mounted on the Mac mini) for backups.
6. **Additive rollout.** Every phase is revertible with `git revert` + push;
   deleting all planner code/keys leaves the current app exactly as it is now.

## 3. Domain model

### 3.1 Activity types

| Type | Behavior |
|---|---|
| `paced` | Ordered sequence of sessions generated from a curriculum definition. Each ✓ advances a `completedThrough` pointer. Projections = remaining sessions ÷ effective rhythm, laid over the year calendar. |
| `external` | Live class run by an outside teacher on fixed slots with **term dates** (semesters). App tracks attendance + which lesson/topic was covered. No pacing pressure — the teacher paces. |
| `target` | Yearly goal count (e.g., 20 classes). Tracks done vs. pro-rated pace, flags "behind," suggests makeup slots from free grid time. |
| `ongoing` | Steady weekly rhythm, no finish line (Math+English, Arabic, Quran, Art, Mama Classes). Optional attendance logging only. |
| `oneoff` | Dated single events (field trips). Logged for the record. |

Activity statuses: `active`, `planned` (visible, not started — e.g., Science before
enrollment, Jiu Jitsu before joining), `parked` (History — hidden from Today/Week,
kept in Subjects with a revisit note), `cancelled` (future removed, history kept),
`done` (curriculum chain exhausted).

### 3.2 Rhythms — how often a paced activity is expected

Each paced activity declares one rhythm:

- `daily` — every single day. Optional `travelFactor` (e.g. 0.5 = every other day
  during travel weeks instead of pausing).
- `weekly:N` — N sessions per teaching week (Geography: 1).
- `cycle` — tied to the **parent work cycle** (7-on/7-off). Declares
  `perOnWeek` and `perOffWeek` (LoE: 1 and 2–3). Pace is judged **per two-week
  cycle**, never per single week: one lesson in a work week is on pace.

Parent cycle: `{pattern: "7on7off", anchorMonday: <date>}`. **The anchor parity is
an assumption** (unknown which real week is "on") — the UI exposes a one-tap
"flip work/home weeks" control in Settings until confirmed.

Travel behavior per activity: `pause` (default) | `continue` | `reduced` (factor).
Singapore Math = reduced 0.5 during travel; LoE = pause; Geography = pause.

### 3.3 Curriculum chains

A paced activity holds an ordered list of curricula; finishing one auto-starts the
next, and projections run across the whole chain:

- Logic of English: Foundations C (lessons 81–120) → Foundations D (121–140).
- Singapore Math: Dimensions G2 (done) → G3 (3A+3B, pending books) → G4 (future).
- BFSU Vol 1 → 2 → 3 (covered by the Science teacher; reference only).

### 3.4 Session patterns (within a curriculum)

A curriculum definition generates a flat session sequence in the pure model:

- `simple` — one session per unit (LoE: one lesson each; Geography: one unit/week).
- `tb-wb` — each lesson = 2 sessions (textbook day, then workbook day), with a
  block of `tests` sessions appended after the last lesson (Singapore G3 plan).
  A `condensed` per-lesson override collapses TB+WB to one day (the G2 style),
  usable ad-hoc on easy chapters.

Unit titles are optional and editable (Geography ships as "Unit 1…36" placeholders
until the family provides the real curriculum; Claude loads titles in bulk later).

### 3.5 Year calendar

- Year record: label `2026–27`, running 2026-08-17 → 2027-08-31 (year-round).
- Weeks default to `teaching`; any week can be marked `travel` / `off` / `light`
  with a label ("Dhaka ✈", "Eid — Toronto"). Marking a week re-projects every
  paced activity instantly per its travel behavior.

### 3.6 Sessions, statuses, one-tap catch-up

Each dated expected session can be logged: `done` ✓, `partial` ◐ (unit stays
next-up), `missed` ✗ (unit stays next-up). Nothing is renumbered — the pointer
just doesn't advance, and downstream projections shift. Dated `overrides` add
one-off sessions (makeup Jiu Jitsu on a specific Saturday) or skip one occurrence,
never touching the template.

### 3.7 Clash detection

Pure function over template events + a proposed slot → overlap list + nearest free
slots on the same/adjacent days. Surfaced when adding/moving anything. Known case
it must catch: Science (Zoom, planned) Tue 2:30–3:30 vs Arabic — Miss Hala Tue 2–3.
Resolution (moving Hala) is a human decision; the app only warns and suggests.

### 3.8 Seed data (ships with Phase 1 — all statuses honest as of 2026-08-16)

| Activity | Type / rhythm | State at seed |
|---|---|---|
| Singapore Math | paced chain, `tb-wb`, daily, travel ×0.5, **not on grid** | G2 done; G3 `planned — waiting for books` (counts entered when books arrive) |
| Logic of English | paced chain, `simple`, cycle (1 on / 2–3 off), travel pause, **not on grid** | Foundations C at **lesson 101 done 2026-08-16**; D = 121–140 per the family's info (**verify against the book — publisher usually lists D as 121–160**; length is data, not code) |
| Geography | paced, `simple`, weekly:1 (2-hr block), on grid | `planned` — 36 placeholder units; block placement chosen when activated |
| Science | external, semesters Sep 2026–Jan 2027 / Feb–Jun 2027, Tue 14.5–15.5, BFSU Vol 1 | `planned` — not yet enrolled; clash with Hala flagged on activation |
| Math+English (Ruhamah) | ongoing, from template (7h/wk) | active |
| Arabic (Miss Hala) | ongoing, from template (3h/wk) | active |
| Quran | ongoing, from template (3h/wk) | active |
| Art (Arya) | ongoing | active |
| Mama Classes | ongoing | active |
| Jiu Jitsu | target 20/yr, alternate Saturdays | `planned` — not enrolled |
| History | — | `parked`, note "revisit ~Sept 2027" |

The **live weekly template is not modified** by seeding.

## 4. Views

| View | Content | Default on |
|---|---|---|
| **Today** | Date + week-type chips (teaching week N, work/home week, next trip); timed blocks for today from template+overrides with ✓◐✗; "Daily · no time slot" checklist (Singapore, LoE) where a check advances the sequence; nudge cards (behind-pace, makeup suggestions); tomorrow strip | phones |
| **Week** | The existing grid, unchanged, + status dots on the current real week + override badges + clash banner when relevant | desktop |
| **Year** | One 52-week track per paced/target activity + a core row; done/planned/travel-hatched segments; today line; projected finish + slack per track; tap week → set type | — |
| **Subjects** | Cards with progress bars and pace status; detail: unit list, rename, chain, goal, pause/park/cancel, travel behavior; add activity | — |
| **Print** | Unchanged | — |

Navigation: bottom tab bar (mobile) / top tabs (desktop): Today · Week · Year ·
Subjects · Print. Theme system (auto/dark/light) and category-color tokens reused;
new category tokens added for Geography (teal), Science (blue), Jiu Jitsu (steel)
in both themes.

## 5. Data design

- **localStorage:** `aoife_plan_v1` (mirror + offline, same load/save philosophy
  as the schedule).
- **KV:** new key `aoife_plan` via new `api/plan-get.js` / `api/plan-save.js`,
  reusing the existing endpoints' conventions (double-wrapped JSON string body,
  unwrap-loop on read, `KV_REST_API_*` env names with `UPSTASH_*` fallback).
- **One-step undo:** `plan-save.js` first copies the current `aoife_plan` value to
  `aoife_plan_prev`, then writes the new value. `plan-get.js?prev=1` returns the
  backup. Two small keys — comfortably inside the free tier.
- **Blob shape (v1):**

```json
{
  "version": 1,
  "savedAt": "2026-08-16T00:00:00Z",
  "year": {"label": "2026-27", "start": "2026-08-17", "end": "2027-08-31"},
  "parentCycle": {"pattern": "7on7off", "anchorMonday": "2026-08-17", "confirmed": false},
  "weeks": {"2027-01-04": {"type": "travel", "label": "Dhaka ✈"}},
  "activities": [{
    "id": "loe", "name": "Logic of English", "type": "paced", "status": "active",
    "cat": "b", "onGrid": false,
    "rhythm": {"kind": "cycle", "perOnWeek": 1, "perOffWeek": 2.5},
    "travel": {"mode": "pause"},
    "goal": {"finishBy": "2027-08-31"},
    "chain": [
      {"id": "loe-c", "name": "Foundations C", "pattern": "simple",
       "firstUnit": 81, "lastUnit": 120, "completedThrough": 101,
       "titles": {}},
      {"id": "loe-d", "name": "Foundations D", "pattern": "simple",
       "firstUnit": 121, "lastUnit": 140, "completedThrough": null, "titles": {}}
    ]
  }],
  "overrides": [{"date": "2026-11-14", "activityId": "jj", "action": "add",
                 "start": 10, "end": 11, "note": "makeup"}],
  "log": [{"date": "2026-08-16", "activityId": "loe", "unit": 101, "status": "done"}]
}
```

- `sanitizePlan()` runs on both load paths (localStorage + KV), drops malformed
  records, defaults missing fields — same philosophy as `sanitizeEvents`.
- Size budget: well under 100 KB even after years of daily log entries; log entries
  are one short object per lesson.

## 6. Code layout (all new files additive)

```
js/plan/model.js     PURE — no DOM. Session-sequence generation, cycle math,
                     projections, travel shifting, clash detection, target pace,
                     serialize/sanitize. Every number the UI shows comes from here.
js/plan/state.js     Store + persistence + mutations (log status, mark week,
                     override, pause/park/cancel, flip cycle anchor).
js/plan/today.js     Today view.
js/plan/year.js      Year view.
js/plan/subjects.js  Subjects view + detail.
js/plan/tabs.js      Tab-bar navigation; lazy-mounts views; Week/Print untouched.
js/grid-overlay.js   Thin read-only decoration of the existing grid (status dots,
                     override badges, clash banner). Guarded so template editing
                     and print see zero behavioral change.
api/plan-get.js      New endpoint (mirrors get.js conventions + ?prev=1).
api/plan-save.js     New endpoint (prev-copy then save).
css/plan.css         New styles; reuses tokens.css variables; adds geo/sci/jj
                     category tokens to tokens.css (additive).
tests/plan/*.test.js Pure-model tests (see §8).
```

`index.html` gains the tab bar + view containers and script tags — the only shared
file touched besides `tokens.css` (additive variables) and minimal `app.css`
additions. `grid.js`/`dayview.js`/`editor.js`/`print.js` are **not modified**;
the overlay reads the DOM/grid state from outside.

## 7. Backups & rollback (belt, suspenders, and a second belt)

1. **Git tag `v2-pre-planner`** on current `main` before any planner commit
   (mirrors the dhaka-flights `v1-pre-overhaul` convention). Each shipped phase
   also gets a tag (`planner-p1` … `planner-p4`). Rollback = revert/reset to tag,
   push; KV data unaffected.
2. **KV one-step undo** via `aoife_plan_prev` on every save (§5).
3. **Nightly Drive snapshot:** Mac mini launchd job at ~03:40 (overnight per house
   rule) curls `/api/get` and `/api/plan-get` into dated JSON files in Drive
   `My Drive/Aoife Planner Backups/` (tiny files, keep forever). Job prints a
   `PLANNER-BACKUP OK <date>` marker line to its log.
4. **Fleet registration:** per house convention, the backup job gets a CATALOG
   entry in `schedule_snapshot.py` and a fleet-health probe (data-level: today's
   snapshot file exists and parses; log_grep on the OK marker).
5. **Restore procedures** documented in AGENTS.md (KV restore = POST snapshot back).

## 8. Testing

`node --test` from repo root (bare form — Node 24 breaks on directory arg).
Existing tests must stay green. New pure-model tests pin the real family scenarios:

- **LoE projection:** 19 lessons left in C + 20 in D at 3–4/cycle from 2026-08-17
  with a 5-week January travel block → C finishes ~Nov 2026, chain finishes
  Feb–Mar 2027, comfortably before the 2027-08-31 goal; minimum required pace
  computes to ~2/cycle. Also the D=121–160 variant.
- **Singapore sequence:** tb-wb pattern generates TB→WB→…→tests order; daily
  rhythm with travel ×0.5 halves expected sessions in travel weeks; condensed
  override merges a lesson to one session; chain rollover G3→G4.
- **Cycle math:** 7-on/7-off parity from anchor; one lesson in a work week = on
  pace; cycle target missed → behind; anchor flip inverts week types.
- **Clash:** Science Tue 14.5–15.5 vs Hala Tue 14–15 → conflict + suggestions
  exclude occupied slots.
- **Target pace:** JJ 3 done at ~week 11 of 48 teaching weeks, target 20 →
  expected ≈ 4 (20 × 11/48), so behind by ≥ 1; makeup suggestion produced.
- **Sanitize:** malformed activities/log entries dropped; round-trip stability;
  unknown future fields preserved (forward compatibility).
- **Contract:** old `aoifes_schedule` shape untouched (existing fixture test);
  new `aoife_plan` fixture round-trips through the double-wrap convention.

## 9. Build phases (each shippable, tagged, tests green before push)

1. **P1 — Trackers:** plan model + state + API + Today view (timed blocks — not
   editable, but taggable ✓◐✗ — plus daily checklist and log) + seed data. LoE and
   Singapore tracking usable immediately.
2. **P2 — Subjects & projections:** Subjects view, chains, finish-date/slack
   projections, goal checks, activate/pause/park/cancel, unit titles editing.
3. **P3 — Year:** year view, week marking, travel-aware re-projection, cycle
   awareness + anchor flip, week-type chips on Today.
4. **P4 — Grid overlay & targets:** status dots/override badges/clash banner on
   Week, target-count machinery + makeup suggestions, Drive backup job + fleet
   registration, AGENTS.md data-contract + restore docs, memory/project notes.

**Delegation (user directive 2026-08-16):** top model plans and reviews in the main
loop; hard/risky tasks (plan model math, grid overlay) go to Opus-class subagents;
routine scaffolding/CSS/test-boilerplate to Sonnet subagents.

## 10. Open items (non-blocking, tracked in AGENTS.md after build)

1. LoE Foundations D true span — check the physical book (120→140 vs 160).
2. Geography curriculum name + 36 unit titles → bulk-load via Claude session.
3. Dimensions G3 contents (photo of contents page when books arrive) → real counts.
4. Science enrollment decision + teacher/class details; Hala Tuesday resolution.
5. Jiu Jitsu enrollment + real yearly target.
6. Parent-cycle anchor parity — confirm or one-tap flip.
7. Final spec sign-off by the family (this doc was committed while they slept).
