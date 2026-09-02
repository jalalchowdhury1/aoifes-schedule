# AGENTS.md — aoifes-schedule

Single LLM source of truth for this repo. Human-facing docs (README, jalal*) are off-limits per convention. If something here is wrong, fix *this* file.

## What this is
Aoife's weekly schedule web app, live at https://aoifes-schedule.vercel.app/.
A drag-and-droppable Mon–Sun, 9am–5pm timetable of recurring activities, editable
after unlocking, with print/save-PDF. v2 (2026-07-20) fully rebuilt the front end:
dark/light/auto theme, mobile day view with Day⇄Week toggle, refined-minimal design.
Spec: docs/superpowers/specs/2026-07-20-schedule-v2-rebuild-design.md.
Plan (with execution addendum): docs/superpowers/plans/2026-07-20-aoife-schedule-v2.md.

## Architecture
Static vanilla app, no build step, no dependencies, no framework:
- index.html — shell; inline script sets html[data-theme] pre-paint
- css/tokens.css — all theme + category color tokens (light/dark)
- css/app.css — layout/components incl. mobile day view + bottom sheet
- css/print.css — letter-landscape print, always the week grid
- js/model.js — PURE (no DOM); constants, fmt/snap/clamps, defaults, serialize, sanitizeEvents
- js/state.js — store + persistence + all mutations; sanitizes events on both load
  paths; `syncSchedule()` live re-sync (+ failed-save retry)
- js/sync.js — tiny shared spine for BOTH stores' live re-sync: the `holdSync()`
  predicate registry and the per-blob freshness stamps. No dependencies, so
  neither store has to import the other or the frozen view layer
- js/grid.js — week grid render, drag/resize/select (fine pointers only); since
  2026-09-01 also renders on-grid planner slots as `.evt.pslot[data-slot]`
  blocks (see "Planner slots on the grid") and drags them through setSlot
- js/dayview.js — mobile tabs + day column + Day/Week toggle
- js/editor.js — edit panel (desktop) / bottom sheet (mobile), add form, legend
- js/theme.js — auto/light/dark cycling
- js/print.js — print modal; prints reuse screen theme tokens
- api/get.js, api/save.js — Vercel functions -> Upstash KV. DO NOT TOUCH.
- aoife_schedule_3.html — v1-era standalone snapshot (localStorage-only, no lock,
  no /api). Kept for history; it drifts from the live app by design. DO NOT TOUCH.
- js/plan/model.js — PURE planner model: dates/weeks/cycle math, session sequences, capacities, projections, stats, clash, sanitize, `mergePlanWrites` (the endpoint's concurrent-write union)
- js/plan/state.js — planner store, localStorage aoife_plan_v1, /api/plan-* I/O,
  mutations, `syncPlan()` live re-sync with failed-save replay (freshness stamps
  live in js/sync.js)
- js/plan/seed.js — PURE: the initial aoife_plan blob (honest as of 2026-08-16)
- js/plan/tabs.js — tab navigation + boot; lazy view mounting; the live-sync
  scheduler (`initLiveSync`: visibilitychange/focus/120s poll, both blobs)
- js/plan/today.js — Today view
- js/plan/year.js — Year view
- js/plan/subjects.js — Subjects view
- js/plan/overlay.js — read-only status dots AND dated one-off ghost blocks on
  BOTH #grid and #dayview + clash banner; a MutationObserver re-applies them
  after any re-render (see below)
- api/plan-get.js — GET aoife_plan (or ?prev=1 for undo copy)
- api/plan-save.js — copy current -> aoife_plan_prev, merge concurrent writes when the body carries `base`, then SET new
- css/plan.css — all planner styles (tokens.css vars reused)
- scripts/planner-backup.sh — nightly Drive snapshot of both KV blobs

The mobile Day view (#dayview, frozen js/dayview.js) is a parallel render path —
any grid visual (dots, badges) must also cover #dayview; it re-renders outside
onChange (60s timer in main.js + day-tab taps), which is why overlay.js re-applies
via MutationObserver.

## Data contract (NEVER break)
- KV key `aoifes_schedule`; localStorage `aoife_v3`
- Shape: {events:[{id:"e<n>",cat,day:0-6 Mon-first,start,end,note,name}], altSun:bool, catLabels:{}}
- Hours are decimal (half-hour steps), grid spans 9–17
- Category keys: quran, ruhamah, hala, barakot, art, other
- Extra localStorage keys (additive, safe): aoife_theme, aoife_mobile_view
- Load-time sanitization: events missing id/cat or with non-numeric day/start/end
  are dropped by sanitizeEvents (the live KV blob once contained a corrupt stray
  {"id":"e999"} record; the next save after v2 loads permanently cleans it).
- **The /api/save body is double-wrapped on purpose.** The client POSTs
  {"data": "<json-string>"}; save.js forwards the inner string to Upstash SET, so
  KV stores a JSON *string*. get.js unwraps repeatedly (while-typeof-string loop)
  to handle historical double/triple-stringified values — deliberate defensive
  code (commit 434f884); don't simplify it away without re-testing stored data.
- **Single shared KV record, no auth.** Anyone who can reach /api/save overwrites
  the one shared blob; the lock toggle is a UI guard, not security. Fine for the
  intended private use — don't widen exposure without adding auth. v2 escapes all
  user strings via esc() before innerHTML, so the old stored-XSS vector is closed.

## Planner data contract (additive — the section above is still frozen)
- KV key `aoife_plan` (+ `aoife_plan_prev` one-step undo, written by plan-save);
  localStorage `aoife_plan_v1`; same double-wrap POST convention as /api/save.
- Shape: {version, year, parentCycle{anchorMonday,dutyStart,confirmed},
  periods[{id:"p<n>",start,end,type:'travel'|'off',label}],
  activities[{id,type,status,cls,onGrid,slots,rhythm,travel,goal,target,note,chain[
  {id,name,pattern:'simple'|'tb-wb',firstUnit,lastUnit,lessons,tests,done,titles}]}],
  overrides[{date,action,...}], log[{date,activityId|eventId,status,...}]}
- `rhythm.sessionsPerDay` (optional, default 1): sessions a teaching day
  covers. Singapore Math = 2 (textbook + workbook are done the SAME day, one
  lesson/day). weekCapacity multiplies its base by it; garbage values read as
  1. Added 2026-08-30 after the walk projected May 2027 by silently assuming
  one session a day; with it the book projects ~Dec 27 2026. Baseline
  re-frozen the same day as-of 2026-08-28 (the real start, `done`=0) at this
  pace — THAT is the target; extra lessons on a day move the live date up and
  read as "ahead", the pace itself never changes. Mirrored in
  aoife-school-bot/lib/compose.py `week_capacity` (parity tests both sides).
- Overrides may carry `{id, name, src}` written by the Telegram bot
  (aoife-school-bot); an override's id doubles as the eventId in log entries.
  `logTimed` refuses ownerless writes; `statusOf` requires a non-null key.
- **`weeks` is REMOVED (v2, 2026-08-17).** Time away is day-precise: a `periods`
  list of inclusive date ranges, kept sorted by start. `sanitizePlan` migrates any
  legacy `weeks{monday:{type,label}}` blob (each marked week → a 7-day Mon..Sun
  period; the old `light` type is DROPPED) and then deletes the `weeks` key, so a
  sanitized plan never carries one. `parentCycle.dutyStart` is the Tuesday a
  Charlton work stretch begins (Tue→Mon on, 7 days off); default `2026-08-11`.
- **Overlaps are legal and `off` WINS over `travel`** (`dayAway`): a pause is the
  stronger claim on a shared day, so a travel day inside an off block earns 0
  capacity even for a `reduced` activity. Same-type overlaps resolve to the first
  in sort order (earliest start). The add/edit sheet shows a non-blocking notice
  naming the overlap; Save stays enabled. A period whose own start day resolves
  to a *different* period is fully shadowed and is not advertised as the next trip.
- **No browser dialogs anywhere in the planner** — `prompt`/`alert`/`confirm` are
  banned (a native dialog is easy to mis-tap on a phone and impossible to style).
  Destructive actions are two-tap buttons ("Delete" → "Tap again to delete",
  "Cancel" → "Tap again to cancel", disarmed by any other interaction); validation
  errors render inline as `.form-err` (`.form-err.warn` for advisory notices).
  tests/plan-today.test.mjs and tests/plan-year.test.mjs poison all three globals.
- `sanitizePlan` (js/plan/model.js) drops malformed records on both load paths and
  preserves unknown fields (forward-compatible).
- Claude sessions may edit this blob directly via the endpoints (bulk-load
  curricula, replan trips, generate progress reports). Restore procedure:
  GET /api/plan-get?prev=1 (undo) or a dated file from Drive
  "Aoife Planner Backups", then POST it back via /api/plan-save.
- Rollback tags: v2-pre-planner (before any planner code), planner-v1 (first planner
  release, week-marking model), planner-v2 (day-precise time-away redesign),
  planner-v2.1 (year tap targets/This-Week card), planner-v2.2 (week dots +
  Yesterday receipt), planner-v2.3 (Day-view dots + observer), planner-v2.4
  (bot interop), planner-v2.5 (live re-sync + one-off ghosts + write merge),
  planner-v2.6 (per-subject attendance rows on the Year view), planner-v2.7
  (Subjects 📅 Timeline chapter breakdown + baseline), planner-v2.8 (Subjects
  order/dot grid/pace note, Today completed-label fix, Year history
  drill-down — tag cut by the coordinator at deploy).

## Year view: per-subject attendance rows (planner-v2.6, 2026-08-18)
The Year page used to end in one synthetic row, "Core — ELA·Math·Arabic·Quran",
filled solid for every past week no matter what actually happened — decoration,
not data. It is replaced by ONE ROW PER CORE SUBJECT, counted from the template
and the log by the pure `weekAttendance(events, plan, weekStart, cat)`
(js/plan/model.js): `expected` = that category's template events whose weekday
lands on a day of the week that is neither away nor cancelled by a `skip`
override; `done` = that week's `status:'done'` log rows whose eventId is one of
them. `done` is NOT away-filtered (work done on a travel day still counts, same
spirit as dailyStreak's bridge); a one-off logs against its own override id, so
it can never inflate a subject.
- **The rows are DERIVED, never listed** (`coreRows` in js/plan/year.js): every
  ACTIVE `ongoing` activity whose `cat` actually appears in the weekly template.
  Art and Mama Classes therefore stay off this page — no recurring blocks to
  attend — and putting a category on the grid grows its row with no code change
  and no second list to keep in sync. Titles use the app-wide rule
  `name || catLabels[cat] || CATS[cat].label`, so a legend rename reaches this
  page exactly like it reaches the calendar sync.
- **Cells**: `fill` when done ≥ expected, `plan` + `att-part` (half) when some
  landed, `plan` when none did or the week is still ahead, and nothing at all
  when expected is 0 — a wholly-away week draws hatch only, so a trip never
  reads as a wall of misses. Away hatching and the selection outline unchanged.
- **`att-part` is a ::after on the TOP half, not a background-image on the
  bottom.** A cell can be partly done AND partly away, and `background-image`
  holds one layer: a bottom-aligned colour would silently erase the
  bottom-aligned partial hatch, or be erased by it. Splitting the halves keeps
  both signals readable, and a FULL-week hatch can never collide because a
  wholly away week is never marked partial. VERIFIED in both themes.
- The week info card gains one line — `Ruhama 2/5 · Miss Hala 1/3 · Quran 1/3`
  (`shortName` = the part before the em dash) — for weeks that have begun only:
  `0/3` on a week that has not happened yet would read as three missed sessions.
- The tracks stay VIEW-ONLY: a tap opens the card and saves nothing (verified by
  watching for any /api/plan-save request during the headless run).

## Live re-sync (planner-v2.5, 2026-08-18)
Both blobs are written from OUTSIDE this browser (the Telegram bot writes
`aoife_plan`; another phone writes `aoifes_schedule`), so an open tab that only
fetched at boot silently shows a frozen snapshot — the family saw neither the
bot's "Arya art" one-off nor a status it had logged.

- **Triggers** (js/plan/tabs.js `initLiveSync`, one scheduler for both blobs):
  `visibilitychange` → visible, `window.focus`, and a 120s poll that runs ONLY
  while `document.visibilityState === 'visible'` (never in a background tab).
  Deps are injectable so the visibility rules are unit-tested without a browser.
- **`pendingSaves`, never `dirty`.** The old `dirty` flag latched true on the
  first local save and blocked every remote application for the life of the tab.
  It is gone from BOTH stores. Each store now counts POSTs in flight
  (incremented before the POST, decremented in a `finally`, so an error can
  never wedge it) and refuses to apply a fetched blob while one is out.
- **Planner blob** (`syncPlan`): applies only when `pendingSaves === 0` AND
  (no local save yet OR `remote.savedAt >= lastLocalSaveAt`, the ISO stamp we
  wrote). A missing/garbled remote `savedAt` counts as OLDER once we have
  written. `lastLocalSaveAt` is stamped at write time. A save that never landed
  sets `saveFailed`; the NEXT sync round re-posts the exact failed bytes
  (`lastAttempt` replay) BEFORE reading remote, so an offline tap is published,
  not discarded, once the tab is back online (~≤120s). savedAt values are
  compared as `Date.parse` epochs, never as strings (the Python bot writes a
  different fractional-digit width than the browser).
- **Schedule blob has NO `savedAt` — deliberate.** VERIFIED that the read path
  ignores unknown top-level keys (fetchRemote reads only events/altSun/
  catLabels; `sanitizeEvents` only filters the events array), but `serialize()`
  DROPS them, so stamping one would mean changing `serialize()` — a change to
  the frozen v1 storage shape, not an additive read. The contract wins. Writes
  are ordered structurally instead: every mutation saves immediately, so with no
  POST in flight and none failed, KV holds exactly what the tab holds and any
  DIFFERING fetched blob is by definition the newer one. Hence the extra
  `saveFailed` flag: a POST that rejected or returned non-2xx keeps local
  authoritative AND makes the next round re-publish it before reading, exactly
  like the planner's `lastAttempt` replay. (The planner gets the "local is
  authoritative" half free from `savedAt`; both need the retry half.)
- **`holdSync(fn)`** (js/sync.js — shared registry, consulted by BOTH stores):
  a view registers a predicate for an interaction a fetched blob must not
  interrupt; neither store imports the frozen view layer. Three are registered
  in tabs.js: `isDragging` (a re-render under the cursor corrupts drop math —
  commit 49ba699), `!locked && addMode` (half-filled add form), and
  document.activeElement being an INPUT/SELECT/TEXTAREA (protects the legend
  rename and the Year sheet mid-typing). A merely SELECTED block does not hold.
  None of these latch — each clears itself when the interaction ends.
- **Identical blobs are dropped before notify()** (`serializePlan` / `serialize`
  compare), so a poll never re-renders under the family's scroll, tab or typing.
- Fetch errors are silent and never clobber local state; offline is normal.
- **Freshness caption**: per-blob stamps in js/sync.js (`markSynced`); Today
  renders `· synced 3:42pm` from `syncedAt()` = the OLDER of the two blobs'
  last-reached-KV stamps, so a tab whose template sync is failing cannot hide
  behind a fresh planner round. A no-change round patches that one node
  (`paintSynced`) instead of re-rendering the view.

## Concurrent writes & merge (planner-v2.5)
Two writers share these blobs every evening: family phones (whole-blob POST from
a tab snapshot) and the Telegram bot (aoife-school-bot). Whole-blob writes mean
a stale snapshot can erase another writer's entry (measured pre-merge windows:
≤120s for a visible tab, ~0.3–0.7s on tab wake, unbounded for a hidden tab).

- `savePlan` sends `{data, base}` where `base` = the savedAt of the blob this
  tab last applied. api/plan-save.js (planner-owned, NOT the frozen api/save.js)
  compares the stored stamp verbatim: when `base` ≠ current.savedAt (the stamp
  is stored as written, so exact inequality is the honest test — epoch parsing
  belongs on the client, where two writers' precisions meet) it runs
  `mergePlanWrites`
  (pure, canonical in js/plan/model.js, imported by the endpoint) — unions into
  the incoming blob any of current's overrides rows (key: id, else
  date|action|start|end|name fingerprint) and log rows that the incoming
  snapshot is missing, and bumps the matching curriculum `done` counter for
  unioned log rows so the denormalized count stays consistent with the log.
- **Log row identity is two-tier (2026-08-31).** A marker or timed row keeps
  `date|eventId||activityId` — one STATUS per thing per day is the log's own
  invariant. A SESSION row (has `curriculum` + a numeric `session`) adds
  `|curriculum#session`, because a tb-wb lesson is two rows on one date and a
  double-lesson day is four; keyed on `date|owner` alone every row after the
  first collapsed into the first, so a phone logging the textbook half while
  the bot logged the workbook half kept one of them and left the chapter
  counter a session short. An incoming session row still contributes the
  plain `date|owner` key too, so it keeps suppressing a stale ✗ marker
  exactly as before.
- **Protected: appends** (the realistic collision — two ✓s, a bot add + a tab
  tap). **Not protected: concurrent deletions** — an un-tap racing another
  writer may be resurrected by the union. Accepted trade-off: a resurrected
  tick is visible and re-fixable; a silently deleted entry is neither.
- A body WITHOUT `base` (the bot's single fast writes, Claude sessions, old
  clients) keeps plain overwrite semantics — the bot reads-then-writes within
  ~1s, so its exposure is the sub-second window only.
- The endpoint IMPORTS the canonical `mergePlanWrites` rather than carrying a
  copy. VERIFIED on a real preview deployment (2026-08-18): the project runs
  Node 24.x, whose ESM syntax detection loads these extension-ful relative
  imports with no package.json — echo write, merge write and undo copy all
  behaved, and tests/plan-merge.test.mjs fails loudly if anyone inlines a copy.
- Restoring after a bad concurrent write: GET /api/plan-get?prev=1 is the copy
  taken immediately before the write that landed (the merge does not change
  that), then POST it back WITHOUT a `base` field so it is applied verbatim.

## One-off blocks on the grid (planner-v2.5)
A dated override (`action:'add'` with numeric `start`/`end`) for the CURRENT
week renders as a read-only ghost in the column for its date — on the week grid
AND in the Day view (standing directive), from the same overlay module, observer
and drag guard as the status dots.
- Class `evt ov-oneoff`: `.evt` supplies the absolute positioning, `.ov-oneoff`
  the dashed, category-neutral treatment, the "one-off" tag and
  `pointer-events: none` (the app's drag/edit moves the recurring template and,
  since 2026-09-01, planner slots — never a one-off, which is managed from
  Today or the bot). It is inset 10px from
  the left so an overlapping template block still shows its coloured rail.
- It carries `data-oneoff`, NEVER `data-id`: `data-id` is the template's
  identity and the dot sweep queries it. Its status dot comes from its own
  lookup (`eventId === o.id && date === o.date`, the bot's identity rule).
- Pixels-per-hour is read back off the `.ca` column's inline height
  (`(E-S) * ph`), so ONE code path fits #grid (66), #dayview (62) and print (72)
  without importing anything from the frozen render layer.
- Overrides with no times are skipped (Today-list only); one wholly outside
  9–17 is dropped, one overhanging the edge is clamped while its label keeps
  the real times. Print-hidden like every other overlay decoration.

## Planner slots on the grid (2026-09-01)
Spec: docs/superpowers/specs/2026-09-01-grid-planner-slots-design.md. Before
this, the desktop Week grid and the one-page print showed ONLY
`aoifes_schedule.events`; on-grid planner activities (`status:'active' &&
onGrid && slots[]` — Jiu Jitsu, Geography, Science) reached the phone views and
Google Calendar via `buildTimed`/`activity_slot_events` but never the grid.
- `gridSlots(activities)` (js/plan/model.js, pure) → one block per valid slot,
  `(actId, idx)` = identity, 9–17 clamp rules identical to the one-off ghosts,
  `note` = the paced chain's next-session label.
- `renderGrid()` draws them with `slotHTML()`: class `evt <cls> pslot`,
  **`data-slot="<actId>:<idx>"` and NEVER `data-id`** (that is the template's
  identity — editor, dot sweep and template drag all key off it). `.pslot` is
  a marker only; no visual difference. They print (they ARE the recurring week).
- Drag/resize: `blockRef(dataset)` resolves `{kind:'event'}` vs `{kind:'slot'}`;
  a slot drag previews by patching the live slot object in place and the drop
  calls `setSlot(actId, idx, {day,start,end})` (js/plan/state.js → commit).
  Same lock (`store.locked`), same fine-pointer gate, same `holdSync(isDragging)`
  guard. A pointercancel — and a no-move drop — restore `ptr.orig` (commit()
  persists the whole blob, so an uncommitted preview drift must never linger).
  Click/select stays template-only: tapping a slot on touch does nothing
  (known limit — desktop drag only).
- tabs.js re-renders the grid on every `onPlanChange` (never mid-drag) so a bot
  or Claude-session slot change reaches the grid without waiting for the 60s tick.
- Day view parity: js/dayview.js stays frozen; overlay.js `applySlots` draws the
  selected day's slots into #dayview ONLY (class adds `ov-slot`, pointer-events
  none). Never into #grid — it renders them natively; drawing both duplicates.
- Dots: log rows with `activityId` and no `eventId` decorate
  `.evt[data-slot="<actId>:<idx>"]` in both roots, weekday-agreement guarded,
  one dot per (activity, date).
- Calendar: the sync keys these `act:<actId>:<idx>`; a drag keeps the index, so
  the reconciler PATCHES the recurring event. Never re-pack `slots[]`.
- Verified 2026-09-01 headless against the live blobs (seed localStorage under
  a persistent `--user-data-dir`, then `--dump-dom` / `--print-to-pdf`; wrap
  every call in `timeout` — headless Chrome does not exit under a persistent
  profile): 3 native `.pslot` blocks, 1 printed page, all 8 names present.
- Follow-up (reviewer, not blocking): the event/slot drag branches in grid.js
  duplicate the move/resize formulas verbatim — a small helper would dedupe.
- **A ✓ on a paced on-grid class IS its next lesson (2026-09-01, user directive
  "attendance is the lesson — the parents aren't in the room").** `logTimed`
  keeps writing the attendance row `{date,status,timed:true,activityId}` and,
  for a `type:'paced'` activity logged by activityId (never eventId), ALSO
  appends a lesson row `{date,activityId,status:'done',curriculum,session}` at
  `nextIndex(cur)` on entering `done`, and removes THAT DAY's lesson rows
  (`unmarkSession` each) on leaving `done` (toggle-off, or → partial/missed).
  Exhausted chain ⇒ attendance only. **Two rows, two meanings** — every reader
  must split on `e.timed`/`e.eventId` (attendance) vs `e.curriculum` (lesson).
  Readers fixed to do so in the same release: `subjectCards.sessionsThisWeek`
  and `receipt()` (mday.js — the lesson label folds into the class's own line
  via `lessonDetail`), `historyRows()` (year.js — the attendance row is
  `shadowed` by its lesson sibling; a lone ✗ shows the slot's hours),
  `pacedNoteLine` (subjects.js), `countDone` (model.js) and `togglePaced`
  (state.js — `!e.timed`, or the phone's Oops would splice the ✓ instead of
  the lesson). Bot parity: aoife-school-bot `ops._apply_log_status` timed
  branch does the same with `src:'tg'`, appends `· <lesson label>` to its
  confirmation, and `compose.tally_summary` shadows the attendance row.
  Spec: docs/superpowers/specs/2026-09-01-class-tick-advances-lesson-design.md.

## Subjects/Today/Year: v2.8 family feedback batch (2026-08-19 night)
Spec: docs/superpowers/specs/2026-08-19-v2.8-family-feedback-batch.md — every
item was explicitly confirmed that evening. All additive on top of v2.7.
- **Subjects order.** `compareSubjects(a, b)` (js/plan/model.js) sorts by a
  fixed `SUBJECT_ORDER` array (singapore, loe, geography, then the core
  categories, then science/jj/history/core-mama); an id not in the list sorts
  after every known one, stable among themselves by the OLD status order
  (active/planned/parked/done/cancelled). Replaces the pure status sort.
- **lessonTotals(act)** → `{done, total}` in LESSON units, not session units:
  a tb-wb lesson is its 2 sessions together (half-done = .5), chapter Reviews
  (`tests`) are EXCLUDED entirely, a simple chain is 1:1. Feeds the Subjects
  header ("2/60 lessons · 3% · next: …"); `actTotal`/`actDone` (session units)
  are unchanged and still used everywhere else (projectFinish, tracks, etc).
- **Per-chain `bandSize`.** `timelineRows` reads `c.bandSize` (validated
  positive int, `sanitizePlan` drops an invalid one) instead of the fixed
  `BAND_SIZE`, so LoE ships 5-lesson bands (`loe-c:101-105`…) while other
  simple chains keep the 10-unit default. **Changing a chain's bandSize
  changes its row KEYS, which orphans any existing baseline** (the v2.8
  migration re-freezes LoE's baseline for exactly this reason — see below).
- **Dot grid / mini-bars** (subjects.js, replaces the single `.sbar` for
  paced-with-chain cards): one dot cluster per tb-wb chapter (a dot per
  lesson, half-fill via CSS gradient, a ◆ per chapter Review at the cluster's
  end), one mini-bar per display band for a simple chain (reuses
  `timelineRows`' own band split, so a bar always matches a 📅 Timeline row).
  Chain-colored via `--dgc` (set per cluster, inherited by children) from a
  rotating 15-color palette, `--dg0`…`--dg14` in css/plan.css with
  `html[data-theme='dark']` overrides. Untested at the unit level (subjects.js
  has no test rig); the pure math feeding it (lessonTotals, timelineRows) is
  covered in tests/plan-model.test.mjs.
- **Computed pace note.** For an ACTIVE paced-with-chain card, `a.note` is
  replaced by a computed line ("▲ 2 wks ahead of plan · 4 sessions this week
  · 5-day streak"): whole-book delta via the new pure `planDeltaChip
  (finishDate, baselineDate)` (model.js) against the LAST unfinished
  `chainTimeline` row with sessions>0 (the same row AGENTS.md's own
  chainTimeline invariant already pins to projectFinish's date) — `timelineHtml`'s
  own per-row chip now calls the SAME function, so the whole-book line and its
  own chapter breakdown can never disagree. Sessions-this-week and
  `dailyStreak` (streak omitted below 2 days) round it out. Static `a.note`
  keeps rendering for every other card (non-paced, not active, chain-less).
- **Today: a ticked lesson keeps its own name.** `pacedRowLabel` (today.js):
  when a `done` log row exists for TODAY, the paced daily row shows the label
  of the session that WAS completed (row's own `label` when present, else
  `sessionLabel(chain, row.session)`) instead of flipping to the next one the
  instant it's checked. Un-ticking (the row is spliced) naturally reverts.
- **Year history drill-down.** `historyRows(act, events, plan)` (year.js,
  pure) — log rows for one subject, newest first, grouped by month ("This
  month"/"Last month"/"June 2026"). A row is owned by activityId, by an
  eventId in the subject's category's template events, or by a Telegram
  one-off override's own id when that override carries the subject's
  activityId. UI is a NEW "History" section below Time away — one
  `<details>` per subject — deliberately NOT nested inside the tracks/`.yhit`
  tap-layer widget (that absolutely-positioned overlay owns the whole `.ytw`
  box for the week-picker gesture; interleaving new interactive content
  there would risk it). A subject with nothing logged drops off the list.
- **Migration** (scripts/migrate-v28.mjs, committed but not yet run against
  live data): loe-c/loe-d chain shape + bandSize, remaps loe-c's pre-v2.8 log
  rows (old numbering counted from 81, new from 101 — a row with old
  session<20 keeps its `curriculum` and gets an explicit `label` instead of
  being remapped out of range), appends the 2026-08-19 lesson-102 row,
  renames core-mama to "Miscellaneous", clears the singapore/loe notes,
  re-freezes ONLY loe's baseline, and (if the family's geography titles JSON
  was dropped in place) loads 30 unit titles and sets `geo-1.lastUnit = 30`
  — the book is a 30-week program, not the 36 first assumed below. Each
  edit re-derives itself from current fetched state (idempotent); the log
  remap additionally stamps a `v28Remap` marker per row plus a migration-date
  guard, since a remapped row's new session is otherwise indistinguishable
  from an original pre-tracking row's on a second run.

## Subjects 📅 Timeline (planner-v2.7, 2026-08-19)
Per-chapter "plan vs now" breakdown on every ACTIVE paced subject card, as a
second `<details>` under the progress bar. Spec:
docs/superpowers/specs/2026-08-19-subjects-chapter-timeline-design.md.
- **Model (js/plan/model.js, all additive):** `timelineRows(act)` — one row per
  tb-wb chain (Singapore chapter); `simple` chains split into `BAND_SIZE`(10)-unit
  DISPLAY bands (`loe-c:81-90` keys, band size can change with no migration);
  total rows capped at WALK_CAP. `chainTimeline(act, from, plan)` — same
  week-walk as projectFinish; **invariant: the last unfinished row WITH
  sessions>0 lands exactly on projectFinish's date** (0-session placeholder
  rows pass through `finish:null` — never scan with bare `!r.complete`).
  `actualFinishes(act, log)` — real dates replayed from the log; bulk `done`
  bumps without log rows show a bare ✓.
- **Baseline:** `activity.baseline = {setOn, rows:{rowKey:date}}`, guarded by
  sanitizePlan (malformed → dropped, activity kept). `setBaseline(actId, date?)`
  in state.js freezes only unfinished+dated rows (history lives in the log).
  UI: "Set baseline" (first set = one tap) / "Re-baseline" (two-tap — it
  overwrites the reference plan) inside Manage. `disarm()` restores the armed
  button's OWN captured label (`armedRest`) — do not hardcode reset text.
- **View rows:** complete → `✓ <actual date|nothing>`; else
  `plan <baseline|—>` + `now <live|—>` segments + chip (≈ on plan ≤7d / N wks
  early / late). Current row = first incomplete row with sessions>0. Layout is
  a DELIBERATE two-line stack (name, then dates line; `.tl-seg` no-wrap pairs;
  hairline separators) — never a side-by-side flex that depends on width; a
  320px phone must never scroll sideways (stamp 2026-08-19-2 redesign after a
  phone screenshot showed both a stale-CSS render AND a too-cramped layout —
  note: staleness happened even though THAT release had bumped the stamp; the
  remedy is bumping the generation again).
- Initial baselines set 2026-08-19 on live (singapore ×15 rows, loe ×4 unfinished
  bands) = the trip-aware honest schedule (SM → May 16 '27, LoE → Feb 28 '27).

## Planner open items (2026-08-17)
- LoE Foundations D true span — **DONE 2026-08-19** (family-verified: 121-160,
  40 lessons; applied via the v2.8 chain edit + migration, see above).
- Geography curriculum name + unit titles — **DONE 2026-08-19** (extracted from
  the family's own PDF: a 30-week program, NOT 36 as first guessed here —
  titles + `geo-1.lastUnit = 30` land via scripts/migrate-v28.mjs, not yet
  run against live data).
- Dimensions G3 lesson/test counts — **DONE 2026-08-19** (loaded straight into
  the KV blob from the 3A/3B contents-page photos; seed.js deliberately keeps
  its dated 2026-08-16 snapshot). Structure: 15 `tb-wb` chains, one per
  textbook chapter (`dm3-c1`…`dm3-c15`, named `3A Ch 1 · Numbers to 10,000`
  style so next-session labels match the book's per-chapter lesson numbers);
  each textbook Review rides as its chapter's `tests` count (Ch 4→R1, Ch 7→R2,
  Ch 11→R3, Ch 15→R4+R5). 123 lessons ×2 + 5 reviews = 251 sessions,
  projecting ~Apr 2027 at daily pace. `done` starts at 0 — nudge it if she's
  already mid-book.
- Science enrollment decision + Hala Tuesday overlap resolution.
- Jiu Jitsu enrollment + real target (20/yr is a placeholder).
- 7-on/7-off anchor parity — **CONFIRMED** from the family calendar (2026-08-17):
  work stretches run Tue→Mon with `parentCycle.dutyStart = '2026-08-11'`. The Flip
  button is GONE (so are `setWeekType`/`flipAnchor`); the Year footer just states
  the cycle and the next work week. Nothing left to decide here.
- Family sign-off of the spec (built overnight on explicit authorization).

## Google Calendar sync (2026-08-18)
Nightly ONE-WAY publish of Aoife's schedule into a Google Calendar the family
already sees on their phones. Code: `scripts/gcal-sync/` (uv-managed Python —
the Google client is not stdlib, so it gets its own pyproject + lock rather than
polluting system python; `scripts/planner-backup.sh` stays the shell example).
`gcal_sync/model.py` is PURE (no network, no clock — every entry point takes the
date); `gcal_sync/cli.py` is the only module that fetches, authenticates or prints.

- **Direction is one-way, forever.** The planner is the source of truth; the
  calendar is a rendering of it. **Do not edit these events in Google Calendar —
  the next 4:10 AM run overwrites them.** Every synced event says so in its
  description: *"Synced from aoifes-schedule.vercel.app — do not edit here;
  edits will be overwritten nightly."*
- **Sources**: `GET /api/get` (template) and `GET /api/plan-get` (overrides,
  periods, activities). Both go through the same while-typeof-string unwrap as
  api/get.js, and template events through a port of `isValidEvent` — the live
  blob still carries the corrupt `{"id":"e999"}` record and it must not become a
  calendar entry.
- **Mapping**
  | planner | calendar |
  |---|---|
  | template event | weekly recurring event, `RRULE:FREQ=WEEKLY;BYDAY=<MO..SU>`, DTSTART on this week's instance of that weekday, no UNTIL/COUNT |
  | activity slot (`status:'active'`, `onGrid`, non-empty `slots`) | same weekly-recurring shape as a template event, keyed `act:<activityId>:<slotIndex>` — title `name` (fallback: id). Added 2026-08-30 for Jiu Jitsu (Mon 4–5pm); a removed slot or a status flip off `active` just stops the key appearing, so the normal reconcile deletes it like a dropped template event. Slot INDEX is the identity, so reordering the array (not appending/removing at the end) is a delete+insert, not a no-op. |
  | override `action:'add'` with numeric start/end | one timed event, window today−7 … today+365 |
  | period `travel` / `off` | all-day event `start … end+1` (GCal's `end.date` is EXCLUSIVE), titled `✈️ <label>` / `⏸ <label>` |
  Times are `America/New_York` (`dateTime` + `timeZone`, no hardcoded offset, so
  DST is Google's problem). Titles use the SAME rule as the app:
  `name || catLabels[cat] || CATS[cat].label` — a legend rename in the app reaches
  the calendar on the next run. An override with no name falls back to its
  activity's name, then `Extra`; a period with no label falls back to
  `Travel`/`Time off`.
- **Reconciliation, and why the family's own events are safe.** Every event the
  sync creates carries `extendedProperties.private` = `{aoifeSync:"v1",
  syncKey:"<tpl|ov|pd>:<source id>", sig:"<content hash>"}`. Each run lists ONLY
  events matching `privateExtendedProperty=aoifeSync=v1` (with
  `singleEvents=false`, so a weekly series is one master row, which is the row we
  patch), diffs by syncKey, then inserts / patches / deletes. **An event without
  that property is never read, patched or deleted** — the family can add
  birthdays and doctor visits to the same calendar safely. The three key prefixes
  keep the id namespaces apart (a period `p1` and an override `p1` are different
  events); an id-less override keys off the same `date|start|end|name` fingerprint
  api/plan-save.js merges on. Change detection compares OUR `sig`, not the fields
  Google echoes back (it normalises offsets and expands RRULEs), so a patch fires
  only when we actually changed something — a no-change night writes nothing.
  Duplicates of one syncKey collapse to the lowest event id.
- **A weekly series' DTSTART is an ANCHOR, not content — do not re-derive it.**
  The builder always proposes *this week's* instance, so if the hash included
  that date, every Monday would look like a change and re-patch all 11 series,
  dragging each one's start forward a week forever and taking the family's past
  instances (and any per-instance edits) with it. So: `signature()` hashes a
  recurring event's **weekday + time of day**, never its date (a one-off keeps
  its real date — moving a makeup lesson IS a change), and `keep_anchor()`
  re-points a patch at the DTSTART the series already has. Only a genuine
  weekday change (Mon → Thu) re-anchors, to this week.
- **Markers** (greppable in `~/Library/Logs/aoife-gcal-sync.log`):
  `GCAL-SYNC OK <date> <n_events>` · `GCAL-SYNC FAIL <date> <reason>` (exit 1,
  one line, never a traceback wall) · and THREE exit-0 `WAITING` states, one per
  owner setup step, in the order they clear: `calendar-api-disabled` →
  `calendar-not-shared-yet` → `write-permission`. **WAITING is exit 0 on
  purpose**: these are steps only the Google account owner can perform, paging at
  5 AM for one is noise, and every one of them heals on the next nightly run with
  nothing to re-trigger by hand. It is not a way to hide forever — the fleet
  probe greps `GCAL-SYNC OK {date}`, so once its `live_since` grace date passes,
  a calendar still stuck in any WAITING state is reported.
- **Owner setup (three steps, all outside this repo).** 1) Enable **Google
  Calendar API** in cloud project `hoa-tracker-494016`; that project was only
  ever used for Sheets. VERIFIED 2026-08-18 that the service account CANNOT
  enable it itself (`serviceusage.services.enable` → 403 "Permission denied to
  enable service"), and Google's own error text warns the switch takes a few
  minutes to propagate — one 403 right after the click is expected, not a
  failure. 2) Create a calendar named exactly `Aoife's School`. 3) Share it with
  `claude-sheets@hoa-tracker-494016.iam.gserviceaccount.com` as **"Make changes
  to events"** — it then appears in the service account's calendarList, which is
  how the sync finds it (no calendar id is hardcoded).
  The key itself lives at `~/.config/mcp-google-sheets/service-account.json` and
  is only ever read by path — never copied into this repo (which is public).
- **Read-only shares are gated BEFORE any write.** "See all event details"
  (`accessRole: reader`) lists perfectly well and then 403s every single write,
  one at a time — a log wall of identical permission errors that names no cause.
  So the sync checks `accessRole` on the calendarList entry and stops at
  `GCAL-SYNC WAITING write-permission` unless it is `writer`/`owner`, before
  reading or writing anything. A 403 during the writes themselves (the share was
  downgraded after the list call — `accessRole` is a cached field) lands on the
  same marker. **Throttle and quota 403s are deliberately NOT caught**:
  `rateLimitExceeded`/`quotaExceeded` stay FAIL, because a sync that quietly
  stopped publishing must page someone.
- **VERIFIED live 2026-08-18 22:56** (all three setup steps done that evening,
  and the log shows the three WAITING states clearing in order): first real sync
  inserted 12 events (11 template + the "Arya art" one-off; the corrupt `e999`
  record was dropped as designed), `accessRole=writer`, every RRULE on the right
  weekday, Google applying `-04:00` itself. Re-running immediately reported
  `insert=0 patch=0 delete=0 unchanged=12` — **idempotent**. The
  never-touch-their-events rule was proved live, not just in tests: an event
  inserted WITHOUT the aoifeSync property (parked in 2020 so nobody saw it)
  survived a full sync run untouched and was then removed. No `periods` existed
  in the plan that night, so the all-day path has unit coverage only.
- **Daytime freshness (2026-08-23):** the bot-tick job (aoife-school-bot repo,
  `scripts/tick.sh`, every 30 min 07:00–21:30 ET — the ONE sanctioned daytime
  job) also runs `run.sh --if-changed` after each tick, so a bot-added one-off
  ("voice note → calendar") reaches Google within ≤30 min. `--if-changed`
  sha256-hashes the computed desired state and compares it to
  `~/.local/state/aoife-gcal-sync.hash` (`--state-file` to override): match →
  `GCAL-SYNC SKIP <date> unchanged`, exit 0, ZERO Google API calls. The hash is
  written only after a successful `OK` sync (never on DRY-RUN/WAITING/FAIL), so
  an unsynced change retries every tick. The hash sees PLAN changes only — a
  synced event hand-deleted from the calendar comes back on the next plan change
  or the nightly full run, which stays the reconciler of record and keeps the
  fleet probe; daytime `GCAL …` lines land in the TICK log and are informational.
- **launchd**: `com.jalal.aoife-gcal-sync` at 04:10 daily (overnight window per
  the house rule; after the 03:40 backup, before the 05:00 fleet check).
  `com.jalal.aoife-gcal-sync.plist` is committed at the repo root and installed
  to `~/Library/LaunchAgents`. Wrapper `scripts/gcal-sync/run.sh` runs
  `uv run --frozen` so 4 AM never re-resolves dependencies. Registered in the
  fleet (`github-notion-sync`: `log_marker` probe + `schedule_snapshot.py`
  CATALOG entry).
- **Known limitations (v1, deliberate)**
  - **`action:'skip'` overrides are NOT reflected** — for template events NOR
    activity slots. A cancelled session still shows on the calendar as its
    recurring instance. Doing it right means EXDATE on the master (or a
    cancelled-instance write on that occurrence), which is fiddly enough to be
    its own change; the planner's Today view remains the authority on what
    actually happened. **Do not "fix" this by deleting the master series** —
    that would drop every future occurrence too.
  - **`altSun` is ignored** — the regular-week shape is synced. (Same reason the
    print sheet always shows the week grid.)
  - Periods are NOT windowed (the list is short and curated); overrides are.
  - Overrides with no times are Today-list items and have no calendar shape.
  - No reverse sync and no reminders/attendees/colors are set.
- **Tests**: `cd scripts/gcal-sync && uv run pytest` (76, all offline — Google is
  a fake discovery client, the two blobs are patched). These are NOT part of the
  repo's `node --test` suite; run both before shipping a change here.
  `uv run gcal-sync --dry-run` prints the plan and writes nothing — use it before
  any behavior change reaches the family's phones.

## The iPhone app (/m) and the widget (2026-08-31, polish round 2 2026-08-31)
A phone-first PWA at `/m/` plus a Scriptable home-screen widget, both reading
the SAME two blobs (`/api/get` + `/api/plan-get`) the desktop site does.
Built from a one-shot brief (not a committed spec doc); the rules below are
the parts worth keeping.

- **One engine.** `js/plan/mday.js` (pure, ES module, Node-tested —
  tests/plan-mday.test.mjs) is the single source of "what does today look
  like": `dayItems`, `dayHeader`, `nowBlock`, `subjectCards`, `widgetModel`,
  and (polish round 2) `dayState`/`fieldClassFor`/`receipt`. today.js's
  `timedFor`/`statusOf`/`dailyVisible` are thin wrappers around mday.js's
  `buildTimed`/`statusOfTimed`/`dailyVisible` — ONE implementation behind
  the desktop Today view, `/m`, AND the widget. The desktop's existing
  behaviour is byte-identical (tests/plan-today.test.mjs unchanged, still
  green). `dailyStatus` mirrors aoife-school-bot/lib/compose.py's
  `item_status` (tb-wb needs BOTH halves of the SAME lesson logged today)
  plus one addition the bot doesn't have: a `half` status (only the
  textbook half logged) so the phone checkbox can show amber instead of
  collapsing that into "nothing logged".
  - `dayState(items, hourFloat)` is the SINGLE function behind both the
    Today hero and the field's state color, so they can never disagree
    (`fieldClassFor(dayState(...))` maps its phase to `body.day/.done/
    .late`). Phases: `now`/`next` (a timed block running/upcoming), `done`
    (every loggable item has SOME status — done/partial/missed all count as
    "answered", same as the bot's unlogged-items check), `left` (something
    has no status; carries `left`/`names`/`late`), `empty` (nothing
    loggable that day at all).
  - `receipt(dateStr, events, plan, nameForEvent)` → `[{emoji, name, mark,
    detail}]`, a COLLAPSED per-activity recap of a past date: a tb-wb
    daily's textbook+workbook taps for the same lesson become one row
    ("✓ Singapore L4 + L5" — every distinct lesson touched that day, not
    one row per tap), a simple daily's session becomes "✓ LoE Lesson 104",
    a timed block is its own row keyed off its own status. Feeds both the
    Today "Yesterday" line and a tapped past day on Week.
- **Write-path rule.** `/m` never writes to the log or KV directly — every
  mutation goes through `togglePaced`/`logTimed`/`logDailyStatus`/
  `logSession`/`unlogSessionsFrom` (js/plan/state.js), the exact same
  functions the desktop Subjects/Today views and the Telegram bot use
  (`logDailyStatus` is the one exception that is NEW, not shared with the
  desktop — see the long-press bullet below). `logSession` /
  `unlogSessionsFrom` (2026-08-31) are the append / append-inverse pair for
  MULTI-SESSION days: togglePaced is a toggle keyed on (activity, date), so
  a second call the same day undoes the first — right for a one-check daily,
  wrong for a tb-wb lesson (two sessions) or a double-lesson day (four).
  Row shape is unchanged — ONE LOG ROW = ONE SESSION, the same invariant the
  bot's `_apply_log_progress` keeps; never a `count` field on one row. The
  DESKTOP Today view's `.drow` still calls togglePaced only, so it remains
  one session a day — the phone is the multi-lesson surface. A tap shows a toast ("Logged L6 textbook ✓ · Undo"); Undo is two
  taps (tap → "Really undo?" for 3s → tap again → the exact inverse call).
- **Long-press status menu (polish round 2).** Every row's ONLY status
  control is the round check — the old lone "…" button (which made one row
  look singled out) is gone. A faint chevron (`.hintdot`, opacity .35,
  10px) at the far right of EVERY row hints that more exists, identically
  everywhere. A long-press (≥450ms, Pointer Events, `wireLongPress` in
  js/m.js, no context menu / no text-selection callout) on a row's check
  opens a tiny inline capsule menu right under it: a timed row offers ◐
  Didn't finish / ✗ Missed, a plain daily or the tb-wb daily (Singapore)
  offers ✗ Skipped. A short tap still means quick ✓ (or, on the tb-wb
  daily's status-only check, nothing — the dual textbook/workbook card
  below is what advances it). The desktop has no daily-missed control at
  all, so `logDailyStatus(actId, status, date)` (js/plan/state.js) is new:
  it writes the Telegram bot's own marker shape exactly —
  `{date, activityId, status}`, no `curriculum`/`session`/`timed`/
  `eventId` — and is idempotent/toggling like togglePaced/logTimed
  (tests/plan-state.test.mjs).
- **The Singapore-style lesson card** (any active daily whose current chain
  entry is `tb-wb`, not hardcoded to one id): the row's own check in "The
  day" list is NOT a toggle (status-only) — this card is what advances it.
  Rebuilt 2026-08-31 after a real phone report ("I press Textbook, half
  fills — then I press Workbook and the whole thing is gone again").
  - **The bug it replaced.** Both buttons carried the same `data-tbwb` and
    called the same `togglePaced(actId)`, and togglePaced is a TOGGLE keyed
    on (activity, date): the Workbook tap found the Textbook tap's row and
    removed it. The violet `pri` fill marked whichever half `nextSession`
    said was NEXT, which reads on a phone as "this one is selected". Same
    root cause made "➕ Add another lesson" an undo button, so more than one
    session a day was impossible from `/m` at all.
  - **The model is pure**: `tbWbCard(act, cur, log, dateStr, extraOpen)` in
    js/plan/mday.js → `{chapter, curId, lessons:[{lesson, halves:[…]}],
    tests:[…], addLesson, currentLabel, doneSessions, totalSessions}`. Each
    half/test item is `{session, label, fullLabel, done, loggedOn, undoable,
    next, needs}` — its OWN session index and its own state, so a button says
    what it is rather than what's next. js/m.js only renders it.
  - **What shows**: one `.lrow` per lesson touched today, plus the
    in-progress lesson; a "Review" row once a chapter reaches its trailing
    `tests` (was fabricating "Lesson 11" for a 10-lesson chapter); the next
    lesson gated behind a quiet dashed "+ Add lesson N" (`.addles`, transient
    `state.extraOpen`, not persisted) so a second lesson the same day is a
    deliberate tap; a `.smfoot` with the pace left and the plan delta right
    as the same `.cap` capsule the This-week card uses.
  - **Visual language (restyled 2026-08-31, second phone report: "now it just
    looks like HUGE buttons").** A lesson's two halves are ONE segmented
    capsule (`.segs` > two `.seg`), not two loose full-width pills — the
    user's own confirmed taste is Apple-style segmented controls over loose
    pills. Weight follows meaning: `.seg.on` = logged, a QUIET green tint
    (the solid green stays reserved for the 44px round `.chk`), `.seg.next` =
    the one to tap (violet), `.seg.wait` = its turn hasn't come (dimmed).
    `.lrow.done .segs` turns its border green so a finished lesson reads as
    one closed thing. Deliberately NOT added, both against house taste: a
    coloured status dot per row (decorative dots are a tell) and a filled
    progress track (the Subjects tab already owns chapter progress). Verified
    at the 390px design viewport before shipping — the probe harness is a
    throwaway `m/_probe.html` (seeds localStorage, stubs fetch, drives real
    clicks by button text) rendered inside a 390px iframe from `m/_shot.html`,
    because headless Chrome's `--window-size` does NOT set the layout
    viewport here and screenshots come back as a crop of an ~800px page.
  - **Writes** go through the new `logSession` / `unlogSessionsFrom`
    (js/plan/state.js), NOT togglePaced — see the write-path rule above.
    Order is still the chain's: `done` is a COUNT, so tapping Workbook over
    an unlogged Textbook half is refused by name ("Tap ✓ Textbook first")
    rather than fabricating the half. Unticking only ever removes rows dated
    TODAY (an earlier day's half says so and points at Subjects → Oops) and
    takes today's halves ABOVE it with it, because a session only comes off
    the top of the chain.
- **AHEAD/BEHIND IS PACE, NEVER A DIFFERENCE OF TWO PROJECTED DATES.**
  `projectFinish`/`chainTimeline` walk in WHOLE WEEKS anchored on
  `mondayOf(fromDate)` and return the SUNDAY of the finishing week, so any
  projected date carries up to 7 days of pure quantisation AND the walk credits
  the entire current week including days already gone. Differencing a live
  projection against a baseline frozen on a different weekday therefore moves
  in 7-day steps for no reason at all.
  - **What it cost (2026-08-31).** Singapore's baseline was frozen Fri
    2026-08-28: anchor Monday Aug 24, 251 sessions, 17.93 weeks charged as 18
    → Dec 27. Three days later the walk ran on Mon 2026-08-31: anchor Monday
    Aug 31, 239 sessions, 17.07 weeks ALSO charged as 18 → Jan 3. The finish
    moved a week LATER while she logged 12 sessions in 4 days against a planned
    8. Both /m surfaces reported "7 lessons behind" for a child who was **2
    lessons ahead**. The user caught it: "she's done more textbooks and
    workbooks already so there's no way she can be behind."
  - **The measure now**: `paceGap`/`paceGapLessons` (js/plan/model.js) count
    the curriculum-bearing `done` rows logged since `baseline.setOn` against
    `expectedSessions` over the same days — day-precise, no anchors, no
    rounding. A `daily` rhythm prices each day with `dayWeight` (so a trip day
    is worth its own travel factor, not a week average); weekly/cycle rhythms
    still spread their week's capacity evenly, since they are not pinned to a
    weekday. All three /m surfaces (Today lesson card, This-week card, Subjects
    cards + sheet) render the SAME `paceChipHtml`, and the sheet's sentence
    shows its working ("12 sessions logged since Aug 28, where the plan's own
    pace expected 8") plus a line explaining the 7-day date steps, but ONLY
    when the dates point the other way.
  - `planDeltaChip`/`planGapDays` still exist and are still correct (+ = ahead)
    — they are the coarse, ±7-day-tolerant week chip the Year rows use to
    compare a chapter's own plan and now. Do not use them for a precise claim.
  - **Still open**: the walk itself should be day-precise and should not credit
    the elapsed part of the current week. That is a `projectFinish`/
    `chainTimeline` change, so it needs a matching change in
    aoife-school-bot/lib/compose.py (whose parity tests pin exact dates) and a
    re-freeze of every baseline. Not done.
- **The top bar names the visible tab.** `#top-title` is set from
  `state.tab`; only Today gets the date + "Mama: work" caption beside it. It
  used to be the literal word "Today" in the markup, so Week/Subjects/Year all
  sat under a header naming a tab they were not on.
- **Range separator is the en dash** (`11am–1pm`, `Aug 31 – Sep 6`,
  `Lessons 101–105`), app-wide, desktop and `/m`, pinned by
  tests/plan-year.test.mjs. It is correct typography for a range; do not
  "fix" it to a hyphen in one place and split the convention.
- **The widget is GENERATED — never edit `m/widget.js` by hand.**
  `node scripts/build-widget.mjs` concatenates `js/model.js` + `js/plan/
  model.js` + `js/plan/mday.js` + `scripts/widget-ui.js` inside one async
  IIFE (Scriptable's engine has no ES module system and rejects top-level
  `await`), stripping `import`/`export` syntax with `stripModuleSyntax`
  (tests/plan-widget.test.mjs pins bundle hygiene + build determinism +
  the exact `widgetNext` strings the layout consumes). Edit the sources —
  `js/plan/mday.js` above all — and rebuild.
- **Widget layout (2026-08-31 redesign):** one live countdown, not the old
  two-column first/rest·done/total grid. `mday.js`'s `widgetNext(dateStr,
  events, plan, now, nameForEvent?)` returns `{mode, name, at, atLabel, rest,
  doneCount, total}`; widget-ui.js draws `at` via Scriptable's
  `addDate(...).applyRelativeStyle()`/`.applyTimerStyle()` (ticks live, no
  refresh) + the class name, then a dim "then …" line from `rest` (later
  timed blocks + unlogged dailies, omitted when empty). `widgetModel` stays
  exported for compatibility but is no longer used by the widget.
- **Loader** (paste into a new Scriptable script named "Aoife's Schedule", then add a
  medium Scriptable widget to the home screen pointed at it):
  ```js
  (async () => {
    const BASE = "https://aoifes-schedule.vercel.app";
    eval(await new Request(BASE + "/m/widget.js").loadString());
  })();
  ```
  **Tapping the widget opens `/m/` in SAFARI explicitly** via the
  undocumented `x-safari-https://` scheme (widget-ui.js `w.url`, 2026-08-31):
  a plain https URL opens the phone's DEFAULT browser, which for Nabila is
  Chrome, and only Safari's home-screen web app gives /m its full-screen look.
  On a failed fetch the widget falls back to its `FileManager` cache,
  visibly marked "cached" in red. `widget.refreshAfterDate` is 30 min. The
  day boundary is the PHONE's local date/hour — this is a family-at-home
  surface, not a market one (contrast nuts-radar, which is ET-anchored).
- **State colors** (`body.day`/`body.done`/`body.late` in css/m.css, ported
  from nuts-radar's assets/m.css field-drift mechanic): violet while the day
  is in progress OR something is still unlogged before 18:00, green once
  `dayState`'s `done` phase is reached (every loggable item has SOME status
  — a `'missed'` mark is a recorded outcome, not "still open", so it counts
  same as a `'done'`), amber once `dayState`'s `left` phase is past 18:00
  local with something still unanswered. (Corrected in polish round 2: an
  earlier version of this note said green required every status to be
  exactly `'done'` — that was never what the hero copy said, and `dayState`
  is now the one place this is decided, so hero and field can't drift
  apart again.)
- **Week tab navigation (polish round 2).** No longer locked to the current
  week: ‹ › glass buttons or a horizontal swipe (≥40px, touch-tracked so a
  vertical scroll is never mistaken for a swipe) move the whole week,
  unlimited both directions; a "This week" capsule appears whenever off the
  current week and snaps back to it. Each day chip carries a 5px dot below
  the date — green if every loggable item that day logged `'done'`, amber
  if something logged but not everything, red-ish if anything is
  `'missed'`, none for an empty or future day; an away day shows ✈/⏸ in
  that slot instead. Tapping a PAST day shows its `receipt()` (collapsed,
  same as Today's "Yesterday" line) instead of the plan list; today/future
  still show the plan list. The selected day and week are session-only
  (never written to localStorage) — same "remembered only this session"
  rule as everything else view-local in `state` (js/m.js).
- **Week tab = the week at a glance (2026-08-31, spec docs/superpowers/specs/
  2026-08-31-m-week-glance-design.md).** One pure model, `weekGlance(weekStart,
  events, plan, today, nameForEvent)` in js/plan/mday.js (tests pin it on the
  fixture's real Aug 24–30 week), drawn by `renderWeek` in js/m.js. Top to
  bottom: ‹ › nav with an HONEST Mama caption (`mamaRuns` — runs of `isWorkDay`
  across Mon..Sun, e.g. "Mama: work Mon · home Tue–Sun"; the old caption read
  Monday alone, and a Tue→Mon duty stretch makes Monday the odd one out six
  days in seven, so it was wrong for most of every week) · the week card
  (classes done of total · % · missed/to-go capsules; one capsule per paced
  daily "Singapore 5 of 7 lessons" = curriculum-bearing done rows ÷ per vs
  `expectedSessions(act, Mon, Sun)` ÷ per; an all-away week reads "✈ away all
  week") · the grid card (the 7 chips as column headers, an hour axis from the
  week's earliest start to latest end (min 6h, 22px/hour), blocks in the
  desktop's tokens.css dark `--el` category colours via `CLS_COLOR`, state =
  weight: plan soft / done solid ✓ / missed hollow red-edged ✗ / past-unanswered
  faded / one-off dashed; today's column tinted with a live `.wknow` line; a
  dailies rail under it with one cell per paced daily per day — filled done,
  half-filled half, red ring missed, faint ring nothing, blank away/paused) ·
  "Changes this week" (dated `add`s, `skip`s, away runs clipped to the week;
  hidden when empty) · the selected day's list under a `.psec` naming the day
  (Today/Tomorrow/Yesterday suffix); TODAY's rows now carry their ✓/◐/✗
  (`statusMark`, the exported `markFor`) and a tap on one calls `setTab('today')`
  — navigation, never a write. `dayDot` moved here from js/m.js so the chip dot
  and the rail agree. Tapping a chip, a column or a rail cell selects the day.
  Verified at 390px on live data (current, previous, next and the Jan trip
  week) via the throwaway iframe probe harness described above.
- **What `/m` deliberately does NOT do**: no Manage (activate/park/cancel a
  subject, edit the chain, set travel mode, freeze a baseline — Subjects'
  sheet only offers the "oops, remove last logged session" undo plus a
  "Full site ↗" link out to `/`), no print (no print CSS on this page at
  all — printing is a separate, frozen surface), no editing the week grid
  (Week tab is read-only — navigable and receipt-aware since polish round
  2, but a tap never writes anything, exactly like the desktop's Day view).
  Phones do NOT auto-redirect to `/m/` in v1 — Nabila uses the full site on
  her phone for Manage; the only link is the desktop header's "📱 App" and
  `/m`'s own footer "Full site ↗".

## Env vars (Vercel project settings — names only, never values; repo is public)
api/*.js read `KV_REST_API_URL`/`KV_REST_API_TOKEN` with fallback to
`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`. Secrets live only in Vercel.

## Tests
`node --test` from the repo root (NOTE: `node --test tests/` breaks on Node 24 —
use the bare form). Pure model tests + a production-data contract test
(tests/fixtures/production.json is gitignored; fetch it via
`curl -s https://aoifes-schedule.vercel.app/api/get -o tests/fixtures/production.json` first —
the contract test skips gracefully when the fixture is absent).

## Deploy
Push to main -> Vercel auto-deploys (no build command). Local preview:
`python3 -m http.server 8080` (the /api fetch fails locally by design; app runs on
localStorage/defaults). Rollback: `git revert` the offending commits and push —
KV data is unaffected either way.
- **Bump the `?v=` stamp on the five asset URLs in index.html with every
  release** (css/tokens.css, css/app.css, css/plan.css, css/print.css,
  js/main.js). iOS Safari caches CSS and the JS entry point independently, so a
  release that changes both can land with fresh JS reading a stale cached
  stylesheet (planner-v2.5.1 incident: a phone rendered v2.5's one-off ghost
  markup styled by pre-v2.5 CSS — unstyled background/border, oversized tag —
  while every other browser and a hard-refresh showed it correctly). Same
  literal string on all five so they always travel together as one cache
  generation; no build step, so this is a manual step of the ship checklist.

## Print (most-loved feature — re-verify after any grid/sizing change)
Two row-height modes: SPH=66 screen, PPH=78 print, swapped on beforeprint/afterprint
(plus a matchMedia('print') fallback for iOS/WebView where afterprint may not fire).
Print CSS is tuned to fit ONE letter-landscape page; dark print needs the browser's
"Background graphics" enabled. Print always renders the full week grid, even when
the screen shows the mobile day view.
