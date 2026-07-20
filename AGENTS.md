# AGENTS.md — aoifes-schedule

Single LLM source of truth for this repo. Human-facing docs (README, jalal*) are off-limits per convention.

## What this is
Aoife's weekly schedule web app, live at https://aoifes-schedule.vercel.app/.
v2 (2026-07-20) rebuilt the front end: dark/light/auto theme, mobile day view
with Day⇄Week toggle, refined-minimal design. Spec: docs/superpowers/specs/2026-07-20-schedule-v2-rebuild-design.md.

## Architecture
Static vanilla app, no build step, no dependencies:
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
- aoife_schedule_3.html — v1-era artifact, kept for history. DO NOT TOUCH.

## Data contract (NEVER break)
- KV key `aoifes_schedule`; localStorage `aoife_v3`
- Shape: {events:[{id:"e<n>",cat,day:0-6 Mon-first,start,end,note,name}], altSun:bool, catLabels:{}}
- Hours are decimal (half-hour steps), grid spans 9–17
- Category keys: quran, ruhamah, hala, barakot, art, other
- Extra localStorage keys (additive, safe): aoife_theme, aoife_mobile_view
- Load-time sanitization: events missing id/cat or with non-numeric day/start/end
  are dropped by sanitizeEvents (the live KV blob once contained a corrupt stray
  {"id":"e999"} record; the next save after v2 loads permanently cleans it).

## Tests
`node --test` from the repo root (NOTE: `node --test tests/` breaks on Node 24 —
use the bare form). Pure model tests + a production-data contract test
(tests/fixtures/production.json is gitignored; fetch it via
`curl -s https://aoifes-schedule.vercel.app/api/get -o tests/fixtures/production.json` first —
the contract test skips gracefully when the fixture is absent).

## Deploy
Push to main -> Vercel auto-deploys. Local preview: `python3 -m http.server 8080`
(the /api fetch fails locally by design; app runs on localStorage/defaults).
Rollback: `git revert` the offending commits and push — KV data is unaffected.
