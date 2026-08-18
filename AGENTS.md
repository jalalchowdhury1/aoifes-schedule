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
- js/state.js — store + persistence + all mutations; sanitizes events on both load paths
- js/grid.js — week grid render, drag/resize/select (fine pointers only)
- js/dayview.js — mobile tabs + day column + Day/Week toggle
- js/editor.js — edit panel (desktop) / bottom sheet (mobile), add form, legend
- js/theme.js — auto/light/dark cycling
- js/print.js — print modal; prints reuse screen theme tokens
- api/get.js, api/save.js — Vercel functions -> Upstash KV. DO NOT TOUCH.
- aoife_schedule_3.html — v1-era standalone snapshot (localStorage-only, no lock,
  no /api). Kept for history; it drifts from the live app by design. DO NOT TOUCH.
- js/plan/model.js — PURE planner model: dates/weeks/cycle math, session sequences, capacities, projections, stats, clash, sanitize
- js/plan/state.js — planner store, localStorage aoife_plan_v1, /api/plan-* I/O, mutations
- js/plan/seed.js — PURE: the initial aoife_plan blob (honest as of 2026-08-16)
- js/plan/tabs.js — tab navigation + boot; lazy view mounting
- js/plan/today.js — Today view
- js/plan/year.js — Year view
- js/plan/subjects.js — Subjects view
- js/plan/overlay.js — read-only status dots on BOTH #grid and #dayview + clash
  banner; a MutationObserver re-applies them after any re-render (see below)
- api/plan-get.js — GET aoife_plan (or ?prev=1 for undo copy)
- api/plan-save.js — copy current -> aoife_plan_prev, then SET new
- css/plan.css — all planner styles (tokens.css vars reused)
- scripts/planner-backup.sh — nightly Drive snapshot of both KV blobs

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
- The mobile Day view (#dayview, frozen js/dayview.js) is a parallel render path —
  any grid visual (dots, badges) must also cover #dayview; it re-renders outside
  onChange (60s timer in main.js + day-tab taps), which is why overlay.js re-applies
  via MutationObserver.
- `sanitizePlan` (js/plan/model.js) drops malformed records on both load paths and
  preserves unknown fields (forward-compatible).
- Claude sessions may edit this blob directly via the endpoints (bulk-load
  curricula, replan trips, generate progress reports). Restore procedure:
  GET /api/plan-get?prev=1 (undo) or a dated file from Drive
  "Aoife Planner Backups", then POST it back via /api/plan-save.
- Rollback tags: v2-pre-planner (before any planner code), planner-v1 (first planner
  release, week-marking model) and planner-v2 (day-precise time-away redesign).

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

## Print (most-loved feature — re-verify after any grid/sizing change)
Two row-height modes: SPH=66 screen, PPH=78 print, swapped on beforeprint/afterprint
(plus a matchMedia('print') fallback for iOS/WebView where afterprint may not fire).
Print CSS is tuned to fit ONE letter-landscape page; dark print needs the browser's
"Background graphics" enabled. Print always renders the full week grid, even when
the screen shows the mobile day view.
