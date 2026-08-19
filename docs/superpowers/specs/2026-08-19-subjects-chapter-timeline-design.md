# Subjects chapter timeline — design (2026-08-19)

## What & why

The Subjects tab shows one finish date per paced subject (Singapore Math → May 16 '27,
LoE → Feb 28 '27). The family wants to see *inside* that number: when each chapter is
projected to finish, and — once reality diverges — when it was *supposed* to finish.
"If she's on Chapter 3, when was Chapter 3 supposed to be taking place, and when is it
taking place right now?"

User decisions (2026-08-19):
- **Baseline + live** comparison (frozen "plan" dates vs recomputed "now" dates), with a
  re-baseline action for when life genuinely changes.
- **LoE granularity**: auto-split each Foundations book into 10-lesson display bands
  (81–90 … 131–140). Stored chain structure untouched.
- **UI**: inline `<details>` toggle per subject card (same pattern as Manage), label
  `📅 Timeline`.
- **Flexibility directive**: family will report progress/changes conversationally later
  ("she's on Chapter 3 lesson 5"); everything must be adjustable as data — no
  hardcoded dates, counts, or band boundaries in the view.

## 1. Model layer (`js/plan/model.js` — additive, no semantic change to existing exports)

### `timelineRows(act)` → row descriptors
Pure. For each chain item of a paced activity:
- `tb-wb` pattern (Singapore chapters): one row per chain item.
  `key = chain.id`, label = chain name, `sessions = lessons*2 + tests`.
- `simple` pattern (LoE books): split into consecutive **10-unit bands** from
  `firstUnit` (last band may be short: 81–90 … 111–120; 121–130, 131–140).
  `key = `${chain.id}:${bandFirst}-${bandLast}``, label = `Lessons 81–90` (uses
  `unitWord` if set), `sessions = band size`.
- Each row carries `done` (sessions completed inside this row, derived from the
  chain's `done` counter flowing through rows in order).

### `chainTimeline(act, fromDate, plan)` → `[{key, label, sessions, done, finish}]`
Pure. Runs the **same week-walk as `projectFinish`** (same `weekCapacity`, same
periods/cycle inputs, same 300-week horizon), accumulating capacity and stamping each
row's `finish` (the Sunday of the week its cumulative remaining sessions are covered).

**Invariant (unit-tested):** the last unfinished row's `finish` === `projectFinish(...).date`.
The breakdown must never contradict the headline.

- Rows fully done at `fromDate` → `finish: null, complete: true`.
- Horizon exhausted → `finish: null` for remaining rows (UI shows "—").

### `actualFinishes(act, log)` → `{rowKey: 'YYYY-MM-DD'}`
Pure. Replays `log` rows for this activity's chain (`e.curriculum` + `status:'done'`,
sorted by date) counting sessions per chain item; the entry that crosses a row's
cumulative boundary dates that row's actual finish. Rows completed without log
attestation (bulk `done` bumps by Claude) simply have no entry — UI shows ✓ without
a date. Nothing is stored.

## 2. Baseline (stored on the activity, small)

```json
"baseline": { "setOn": "YYYY-MM-DD", "rows": { "<rowKey>": "YYYY-MM-DD", ... } }
```

- `setBaseline(actId)` in `js/plan/state.js`: computes `chainTimeline` as of today and
  freezes every unfinished row's date. Persists via the normal save path.
- UI: **Set baseline / Re-baseline** button inside Manage. Re-baseline is two-tap
  (same in-place arming pattern as Cancel — it overwrites the reference plan).
- `sanitizePlan`: preserve `baseline` when well-formed; drop it (not the activity) when
  malformed (non-object, bad `setOn`, non-ISO row dates). Unknown-key tolerance stays.
- Ship step: after deploy, set initial baselines for `singapore` and `loe` so "plan" =
  the honest trip-aware schedule established 2026-08-19.
- The bot/Claude can write it via the existing plan API — it's plain JSON.
- `mergePlanWrites` semantics unchanged: `incoming` wins on activities (documented
  existing trade-off; baseline edits happen one place at a time).

## 3. View (`js/plan/subjects.js` + `css/plan.css`)

For **active** paced activities with `actTotal > 0` (a parked/planned subject's
projection would be fiction — the walk assumes she starts today), between the
progress bar and Manage:

```
▼ 📅 Timeline
  Ch 1 · Numbers to 10,000      ✓ Sep 12
  Ch 2 · Add & Sub — Part 1     plan Oct 11 · now Oct 4   [1 wk early]
► Ch 3 · Add & Sub — Part 2     plan Oct 25 · now Oct 18  [1 wk early]   ← current
  …
  Ch 15 · Money                 plan May 16 · now May 9   [1 wk early]
```

- Completed row: `✓ <actual date>` (or bare ✓ if not log-attested).
- Future/current rows: `plan <baseline|—> · now <live|—>` + delta chip:
  `≈ on plan` when |Δ| ≤ 7 days; `N wk(s) early` (ok chip); `N wk(s) late` (warn chip);
  no chip when either side is "—".
- Current row (where `next:` points) gets a highlight class.
- All text through `esc()`; chips reuse `pchip ok/warn`; no new dialogs; details
  open-state resets on re-render exactly like Manage (accepted, consistent).
- Print: Subjects view is never printed (print = Week grid only); still run the print
  harness per release rule 2.

## 4. Explicitly out of scope / untouched

Week/Today/Year views, print CSS, `js/model.js`, the Telegram bot (parity rule 4:
no existing `js/plan/model.js` export changes semantics), gcal-sync, API endpoints,
seed.js (keeps its dated snapshot). Geography/Science/Jiu Jitsu/History cards: no
Timeline toggle (not active and/or `actTotal === 0`).

## 5. Edge cases

- No baseline → plan column "—", Manage shows "Set baseline" (first set is one-tap;
  only *re*-baseline arms two-tap).
- Re-baseline mid-book → already-completed rows drop out of `baseline.rows` (history
  lives in the log, not the baseline).
- Horizon exhausted (>300 wks) → "—" dates, no chip.
- `done` overshoot (counter > sessions) already clamped by `actDone`'s Math.min
  pattern; rows clamp the same way.
- Band math must survive chains whose span isn't a multiple of 10 (last band short)
  and single-band chains (D = exactly 2 bands of 10).
- Trip edits / travel-mode changes shift `now` automatically; baseline stays frozen.

## 6. Testing & release

- `node --test` (bare, per Node 24 gotcha) new units: last-row invariant vs
  `projectFinish`; band splitting (40→4 bands, 20→2, 15→2 with short tail); done
  flow-through across rows; `actualFinishes` from log incl. unattested bulk bumps;
  `sanitizePlan` baseline round-trip + malformed-drop; two-tap re-baseline arming.
- Existing suite + print harness + production.json contract test stay green.
- Subagent build + adversarial-review round (hard rule 6).
- Release: `?v=` stamp bump on all five index.html URLs → tag `planner-v2.7` →
  `vercel --prod` (verify GitHub auto-deploy — it failed last release) → set initial
  baselines → verify on phone.
