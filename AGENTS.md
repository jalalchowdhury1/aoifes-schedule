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
- js/grid.js — week grid render, drag/resize/select (fine pointers only)
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
  (bot interop), planner-v2.5 (live re-sync + one-off ghosts + write merge).

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
  date|action|start|end|name fingerprint) and log rows (key: date +
  eventId||activityId) that the incoming snapshot is missing, and bumps the
  matching curriculum `done` counter for unioned log rows so the denormalized
  count stays consistent with the log.
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
  `pointer-events: none` (the app's drag/edit only ever moves the recurring
  template; a one-off is managed from Today or the bot). It is inset 10px from
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

## Planner open items (2026-08-17)
- LoE Foundations D true span (121-140 vs 121-160) — check the physical book.
- Geography curriculum name + 36 unit titles — Claude bulk-loads once provided.
- Dimensions G3 lesson/test counts when the books arrive.
- Science enrollment decision + Hala Tuesday overlap resolution.
- Jiu Jitsu enrollment + real target (20/yr is a placeholder).
- 7-on/7-off anchor parity — **CONFIRMED** from the family calendar (2026-08-17):
  work stretches run Tue→Mon with `parentCycle.dutyStart = '2026-08-11'`. The Flip
  button is GONE (so are `setWeekType`/`flipAnchor`); the Year footer just states
  the cycle and the next work week. Nothing left to decide here.
- Family sign-off of the spec (built overnight on explicit authorization).

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
