# AGENTS.md — Aoife's Weekly Schedule

> **Single source of truth for anyone (human or AI) touching this repo.** Read it fully
> before changing code or "fixing" anything. This repo had **no prior LLM docs** — nothing
> was consolidated or deleted to create this file. If something here is wrong, fix *this* file.

This is a tiny, low-stakes personal tool: a one-page editable weekly schedule for the
owner's daughter (Aoife). There is no build step, no framework, no tests, and no CI. It is
a single static HTML page plus two small Vercel serverless functions for cloud persistence.

---

## 1. What this is

A **static single-page web app** (vanilla HTML/CSS/JS, no framework, no bundler) that
renders a drag-and-droppable Mon–Sun, 9am–5pm timetable of recurring activities
(Quran, Ruhama ELA/Math, Miss Hala Arabic/Islamic studies, Barrington trip, Art class,
Other). Users drag events to move, drag the bottom edge to resize, click to edit in a
side panel, add/delete events, rename category labels, toggle an alternate-Sunday Ruhama
time, and print/save to a one-page landscape PDF (dark or light theme).

- **Stack:** plain HTML + inline `<style>` + inline `<script>`. No `package.json`, no
  `vercel.json`, no dependencies. The `/api` functions are Vercel Node serverless
  functions (default ESM `export default handler`), no npm deps (they use global `fetch`).
- **Deploy target:** **Vercel** (inferred — there is no `vercel.json` in the repo, but the
  code uses Vercel KV / Upstash env vars and `/api/*` serverless-function routing, and the
  git history has commits like "deploy to inject KV environment variables"). Vercel serves
  `index.html` at `/` and exposes `api/get.js` → `/api/get`, `api/save.js` → `/api/save`.
  Deploy is push-to-deploy: pushing to the GitHub repo
  (`github.com/jalalchowdhury1/aoifes-schedule`, public) triggers a Vercel build.
- **The live URL is not recorded in the repo.** Don't guess it.

### Two HTML files — only one is live (important)

| File | Role | Has lock? | Persists to | Live? |
|---|---|---|---|---|
| `index.html` | **The deployed app.** | Yes (starts read-only) | localStorage **+** Vercel KV via `/api/*` | **YES — this is the entry point** |
| `aoife_schedule_3.html` | A standalone snapshot/backup of the same UI | No | localStorage **only** | No — not wired to anything |

`aoife_schedule_3.html` was added as a brand-new file in the most recent commit (`da0bb7a`)
and has no edit history of its own. It is the older single-file/offline variant: **no lock
toggle, no `/api/*` calls, no remote sync** — just `localStorage`. Its default events and
most styling are identical to `index.html`. **Edit `index.html` for any real change.** Only
touch `aoife_schedule_3.html` if the owner explicitly wants the standalone copy updated;
otherwise treat it as a static backup and leave it alone.

---

## 2. Architecture / data flow

```
Browser (index.html)
  │  on load: load() from localStorage  → render immediately
  │           fetchRemote() GET /api/get → if KV has data, overwrite + re-render
  │
  │  on every edit (move/resize/add/delete/rename/sun-toggle/reset):
  │     save():  localStorage.setItem('aoife_v3', json)   (key SK = 'aoife_v3')
  │             saveRemote(json) POST /api/save           (fire-and-forget)
  │             flashSaved()  ("Saved" toast)
  ▼
Vercel serverless functions (api/*.js)
  /api/get  → GET  {KV_URL}/get/aoifes_schedule   (Upstash/Vercel KV REST)
  /api/save → POST {KV_URL}/set/aoifes_schedule   body = the JSON string
  ▼
Vercel KV / Upstash Redis  (single fixed key: "aoifes_schedule")
```

- **Persisted blob shape** (both localStorage and KV): `{ events, altSun, catLabels }`.
  - `events`: `[{ id:"e3", cat:"quran", day:0(Mon)..6(Sun), start:9..17, end, note, name }]`
    (`start`/`end` are decimal hours, snapped to 0.5; `cat` ∈ quran/ruhamah/hala/barakot/art/other).
  - `altSun`: bool — swaps the Sunday Ruhama event between 11–13 ("Regular") and 10–12 ("Alt").
  - `catLabels`: `{ catKey: customLabel }` — only stores overrides that differ from defaults.
- **Single shared global record.** KV stores ONE key `aoifes_schedule` for everyone — there
  are no per-user records, no auth. Anyone who can reach `/api/save` overwrites the shared
  schedule. The lock toggle is a UI guard, not security.
- **localStorage is the fast/offline layer; KV is the cross-device source.** On load,
  `fetchRemote()` (if KV has data) **overwrites** the local copy and re-renders.

---

## 3. How to run / deploy

- **Run locally:** open `index.html` directly in a browser, OR `vercel dev` (or any static
  server) from the repo root. With no KV env vars set, `/api/get` and `/api/save` return
  `{ error: "no-kv" }` with HTTP 200, and the app silently falls back to localStorage-only —
  it stays fully functional. So plain `open index.html` works for everything except
  cross-device sync.
- **Deploy:** push to `main` on the GitHub repo → Vercel auto-builds and deploys. There is
  no build command (static + zero-dep functions).
- **Tests / lint / CI:** none. There is no `.github/` workflows directory, no test runner.

### Environment variables (Vercel project settings — names only, never values)

Both `api/get.js` and `api/save.js` read, with fallback:

```
const url   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
```

- `KV_REST_API_URL` / `KV_REST_API_TOKEN` — Vercel KV integration names.
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — Upstash Redis integration names
  (used as the fallback set; the project may be provisioned via either integration).

Secrets live **only** in Vercel env vars. **Never hardcode the token/URL** — this repo is
**public**. The functions auth to Upstash with `Authorization: Bearer <token>`.

---

## 4. Gotchas / hard rules

- **Edit `index.html`, not `aoife_schedule_3.html`.** See §1. The two can drift; only
  `index.html` is deployed and KV-backed.
- **Remote overwrites local on load.** `fetchRemote()` replaces in-memory state with KV's
  copy when KV has data. Local edits made before the fetch resolves can be clobbered — keep
  it that way (KV is the cross-device truth) but be aware when debugging "my change vanished".
- **`save()` is dual-write, fire-and-forget.** It writes localStorage synchronously and
  POSTs to `/api/save` without awaiting. `saveRemote`/`fetchRemote` swallow all errors
  (empty `catch`) so the UI never breaks when offline or KV-less. Don't make these throw.
- **The `/api/save` body is double-wrapped on purpose.** The client POSTs
  `{ "data": "<json-string>" }`; `save.js` forwards `request.body.data` (the inner string)
  straight to Upstash `SET`. So KV stores a **JSON string**, and Upstash `GET` returns
  `{ result: "<that string>" }`. `get.js` then **unwraps repeatedly** (`while typeof
  parsed === 'string' JSON.parse`) to handle historical double/triple-stringified values.
  This loop is deliberate defensive code (see commit `434f884` "resolve JSON string escape
  issues parsing KV") — don't simplify it away without re-testing existing stored data.
- **App is read-only until unlocked.** `index.html` boots with `isLocked = true` and
  `#app-content` class `locked`, which hides all edit controls (`.hide-locked`) and disables
  drag/resize (`.evt { pointer-events:none }`). The "Unlock to Edit" button is the only way
  in. Don't assume edit handlers are active on load.
- **Time grid is fixed 9–17.** `S=9, E=17`. Add/edit inputs clamp start/end to that range
  and snap to 0.5h (`snap = h => Math.round(h*2)/2`). Events outside 9–17 won't display
  correctly.
- **Two row-height modes for print.** `SPH=66` (screen px/hour) vs `PPH=78` (print px/hour);
  `window.onbeforeprint`/`onafterprint` swap `PH` and re-render. The print CSS is hand-tuned
  to fit **one** Letter-landscape page (`@page { size:letter landscape; margin:0.4in }`,
  grid clamped to `width:95%`). Many commits exist purely to stop print bleed onto a 2nd
  page — re-verify printing (both Dark and Light) after any grid/sizing change. Dark print
  requires Chrome "Background graphics" enabled (the print modal says so).
- **Mobile = landscape only.** A portrait overlay ("Please rotate your device") hides the
  app under `@media (orientation:portrait) and (max-width:900px)`.
- **`.DS_Store` is committed** and there is **no `.gitignore`**. Avoid committing more OS
  cruft; consider adding a `.gitignore` if you touch repo hygiene (owner's call).
- **No input sanitization / escaping.** Event names, notes, and custom category labels are
  injected into the DOM via template-literal `innerHTML`. Acceptable for a private personal
  tool, but it is a stored-XSS vector given the shared unauthenticated KV key — don't expand
  exposure (e.g. don't make the URL widely shareable) without adding escaping + auth.

---

## 5. Known issues / open items

- **No auth on the shared KV record.** Anyone hitting `/api/save` overwrites the single
  `aoifes_schedule` blob. Fine for the intended private use; revisit if the link is shared.
- **`aoife_schedule_3.html` will drift** from `index.html` over time since edits go to
  `index.html` only. It's a static backup, not kept in sync automatically.
- No live URL, no monitoring, no tests — by design for a tool this small.

---

## 6. File / module map

- `index.html` — **the live app.** Inline CSS (color tokens + light-print overrides + print
  `@media`) and inline JS: default events (`defEvents`), category config (`CATS`),
  persistence (`load`/`save`/`fetchRemote`/`saveRemote`/`doReset`), lock toggle
  (`toggleLock`), drag/resize pointer handlers (`onEvtDown`/`onRhDown`/`onMove`/`onUp`),
  alt-Sunday toggle (`toggleSun`), rendering (`render`/`renderLegend`/`renderGrid`/
  `renderPanel`), category-label inline rename (`editCatLabel`), and print (`openPM`/
  `doPrint`). KV key written under SK `'aoife_v3'` (localStorage).
- `aoife_schedule_3.html` — standalone snapshot of the same UI; **localStorage-only**, no
  lock, no `/api/*`. Backup copy; not deployed.
- `api/get.js` — Vercel function `/api/get`: reads `aoifes_schedule` from Vercel KV/Upstash,
  unwraps nested JSON strings, returns the object (or `{error:"no-kv"|"empty"}`, always 200
  on the no-kv/empty paths; 500 only on a thrown fetch error).
- `api/save.js` — Vercel function `/api/save`: POSTs `request.body.data` (a JSON string) to
  Upstash `SET aoifes_schedule`. Returns Upstash's response, or `{error:"no-kv"}`.
- `.DS_Store` — macOS cruft, accidentally tracked. Ignore.

There is **no** `README.md`, `package.json`, `vercel.json`, `.gitignore`,
`requirements.txt`, or `.github/` in this repo.
