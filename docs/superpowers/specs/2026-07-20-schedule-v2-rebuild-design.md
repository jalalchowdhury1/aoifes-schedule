# Aoife's Schedule v2 — Full Rebuild Design

**Date:** 2026-07-20
**Live site:** https://aoifes-schedule.vercel.app/
**Decision:** Full rebuild of the front end, chosen by Jalal ("let's take the risk"). Schedule data is preserved by keeping the storage contract untouched; a downloaded PDF exists as an extra backup.

## Goals

1. Dark / light mode with a user toggle (auto-follows system by default).
2. First-class mobile experience — kill the "rotate your device" wall.
3. Refined-minimal visual overhaul (evolution of current look: clean type, soft cards, calm colors).
4. **Zero feature loss** — everything the current app does still works.
5. **Zero data loss** — existing schedule loads unchanged.

## Non-goals

- No new framework, build step, or dependencies.
- No changes to the `/api` functions or KV setup.
- No new features beyond the small touches listed below (no recurring events, no multi-week views, etc.).

## Architecture

Same repo (`jalalchowdhury1/aoifes-schedule`), same Vercel project and URL, same env vars.

Replace the single-file `index.html` with:

```
index.html          — markup shell, meta tags, module script tag
css/tokens.css      — color/theme custom properties (light + dark)
css/app.css         — layout, components, day view, edit sheet
css/print.css       — @media print rules
js/main.js          — boot, wiring, render orchestration
js/state.js         — data model, defaults, localStorage + KV persistence
js/grid.js          — week grid render + drag/resize pointer logic
js/dayview.js       — mobile day view + day tabs + Day/Week toggle
js/editor.js        — edit panel (desktop) / bottom sheet (mobile), add form
js/theme.js         — auto/light/dark cycling + persistence
js/print.js         — print modal + dark/light print flow
api/get.js          — UNCHANGED
api/save.js         — UNCHANGED
```

Plain ES modules (`<script type="module">`), served statically by Vercel. Old `aoife_schedule_3.html` stays in the repo untouched (historical artifact).

### Data contract (MUST NOT CHANGE)

- KV key: `aoifes_schedule` via `/api/get` and `/api/save` (`{ data: <json string> }` POST body).
- localStorage key: `aoife_v3`.
- Shape: `{ events: [{id, cat, day, start, end, note, name}], altSun: bool, catLabels: {cat: label} }`.
- `id` format `e<number>`; `day` 0–6 Mon-first; hours are decimal (half-hour granularity), grid spans 9–17.
- Category keys: `quran, ruhamah, hala, barakot, art, other`.
- Load order: localStorage first for instant paint, then `/api/get` overwrites when it returns (same as today).

New, separate localStorage keys (additive, safe): `aoife_theme` (`auto|light|dark`), `aoife_mobile_view` (`day|week`).

## Theme system

- CSS custom properties in `css/tokens.css`; `:root` holds light values, `[data-theme="dark"]` holds dark values.
- Default state **auto**: JS applies dark/light from `prefers-color-scheme` and live-updates on system change.
- Header sun/moon button cycles auto → light → dark → auto; choice saved in `aoife_theme`.
- Six category colors re-tuned per theme for contrast (event fill, edge, text tokens per category, as today).
- `<meta name="theme-color">` updated per theme for mobile browser chrome.
- Print theme remains an independent choice in the print modal (dark or light), implemented by forcing a theme class during print regardless of screen theme.

## Responsive layout

Breakpoint: viewport width < 700px = "mobile"; otherwise "desktop".

**Desktop / tablet / landscape phones:** full Mon–Sun week grid, 9am–5pm, as today. Drag-to-move, drag-bottom-edge-to-resize, click-to-edit panel below the grid. Improved spacing/touch targets.

**Mobile portrait:**
- The portrait overlay ("please rotate") is deleted entirely.
- **Day view (default):** Mon–Sun tab strip with today preselected and visually marked; one day's 9–5 column with large readable event cards.
- **Day ⇄ Week toggle:** a control in the header switches to the full 7-day week grid on the phone (horizontally scrollable if needed); tapping an event opens the same detail/edit sheet. Preference remembered in `aoife_mobile_view`.
- **Editing on mobile:** when unlocked, tapping an event opens a bottom sheet (custom name, type, day, start, end, note, delete). A `+` button adds events via the same sheet. No drag/resize on touch — forms only.
- Add `<meta name="viewport" content="width=device-width, initial-scale=1">` (missing today — root cause of much of the current mobile pain), safe-area insets, apple-touch-icon + minimal web manifest so it installs nicely to a home screen.

## Features preserved (checklist)

- [ ] Print / Save PDF: modal with Dark/Light choice; letter landscape; prints the **full week grid** even when opened from mobile day view; taller print row height (as today's PPH mechanism).
- [ ] Lock / Unlock editing (default locked; locked hides controls/hints/panel).
- [ ] Alt Sunday toggle (moves the Sunday Ruhamah event 11–1 ↔ 10–12 with matching notes).
- [ ] Add / edit / delete events; custom names (blank reverts to category label); notes.
- [ ] Drag to move and resize on desktop; half-hour snapping; 9–17 clamping.
- [ ] Renameable legend pills (inline edit, persisted in `catLabels`).
- [ ] Reset to defaults with confirmation, synced to KV.
- [ ] Auto-save on every change to localStorage + KV, with "Saved" flash.
- [ ] Graceful degradation: works from localStorage if KV/API is unreachable.

## Small new touches (complete list — nothing else)

- Today's column subtly highlighted in week grid; today's tab marked in day view.
- "Now" indicator line across the current time, shown only 9am–5pm on today.
- Softer transitions (theme switch, sheet open/close, saved flash).

## Error handling

Same philosophy as today: all persistence calls wrapped in try/catch; API failures are silent and the app keeps running on localStorage; `/api/get` responses that error or return "empty" leave local state alone. Bad half-open states (end ≤ start) rejected in forms with a message.

## Testing

Manual verification matrix before pushing to `main` (Vercel deploys `main` straight to production):

1. Desktop width: week grid renders, drag/resize/edit/add/delete work, both themes.
2. ~390px width: day view default, tabs switch days, Day⇄Week toggle works, edit sheet CRUD works, both themes.
3. Print preview: dark and light, letter landscape, full week visible, no UI chrome.
4. Data round-trip: seed localStorage with a copy of the current production data shape, confirm it renders and re-saves byte-compatible JSON (same keys, same field names).
5. Theme persistence across reloads; system-change follows in auto mode.
6. Reset flow.

Local testing via a static server (`python3 -m http.server`) with API calls failing gracefully (offline mode), which exactly exercises the degradation path.

## Rollout

- Work committed to `main` per Jalal's convention, single deploy.
- Rollback plan: `git revert` restores the old single-file app instantly; KV data is untouched either way; PDF backup exists.
