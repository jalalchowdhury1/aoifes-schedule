// Read-only decorations on the rendered schedule: status dots on logged blocks,
// dated one-off blocks, and a clash banner. Never mutates events; only appends
// elements into rendered DOM.
import { fmt, esc, DAYS, S, E } from '../model.js';
import { store, catLabel } from '../state.js';
import { isDragging } from '../grid.js';
import { todayStr, mondayOf, addDays, dayIdx, findClashes, gridSlots } from './model.js';
import { plan } from './state.js';

// Event ids are stored data; escape them before they enter a CSS selector.
const cssEsc = x =>
  (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(x) : x);

// TWO render paths carry the same `.evt[data-id]` blocks and both must be
// decorated: #grid (js/grid.js, the week grid) and #dayview (js/dayview.js, the
// mobile Day view — the family's default view on phones). The Day view only
// ever renders the selected day's column, so the same `[data-id]` query
// naturally hits just the blocks it happens to be showing: no per-day
// special-casing, and switching day tabs is handled by the observer below.
const CONTAINER_IDS = ['grid', 'dayview'];
const containers = () =>
  CONTAINER_IDS.map(id => document.getElementById(id)).filter(Boolean);

const DOT_CHAR = s => (s === 'done' ? '✓' : s === 'partial' ? '◐' : '✗');
function dotNode(status) {
  const d = document.createElement('span');
  d.className = `ov-dot ov-${status}`;
  d.textContent = DOT_CHAR(status);
  return d;
}

let observer = null;
// Reentrancy guard. With a real browser's ASYNCHRONOUS record delivery this is
// unreachable (measured: 0 hits) — the callback can never run while we are
// mid-apply, which is exactly why draining takeRecords() below is the load-
// bearing half. It stays for defense-in-depth and because the test stub
// delivers records synchronously, where it IS the thing that stops recursion.
let applying = false;
let pending = false;    // microtask coalescing: one re-apply per burst

// ── One-off (dated) blocks ───────────────────────────────────
// An override with action:'add' is a single dated block — a makeup lesson, or
// the "Arya art 3pm" the family typed at the Telegram bot. It is NOT part of
// the recurring template, so it must never be a real `.evt`: it renders as a
// read-only ghost (dashed, category-neutral, pointer-events:none) in the column
// for its date, on the week grid AND in the Day view. The app's drag/edit only
// ever moves the template; a one-off is managed from Today or from the bot.
export function oneOffsInWeek(mon, sun) {
  const out = [];
  for (const o of plan.data.overrides || []) {
    if (!o || o.action !== 'add' || o.date < mon || o.date > sun) continue;
    // Unpositionable rows are skipped rather than guessed at — an override with
    // no times is a Today-list item only, and sanitizePlan keeps it either way.
    if (typeof o.start !== 'number' || typeof o.end !== 'number') continue;
    if (o.end <= o.start || o.end <= S || o.start >= E) continue;   // outside 9–17
    const act = (plan.data.activities || []).find(a => a.id === o.activityId);
    out.push({
      id: o.id || null,
      date: o.date,
      day: dayIdx(o.date),
      // Drawn clamped to the visible band so an 8am/9pm one-off cannot paint
      // over the page chrome; the label still states its real times.
      top: Math.max(S, o.start),
      bottom: Math.min(E, o.end),
      start: o.start,
      end: o.end,
      // The bot's own label wins; otherwise the activity it makes up for.
      name: o.name || act?.name || 'Extra',
      // Same identity rule as Today: an override's `id` IS its eventId in the log.
      status: o.id
        ? (plan.data.log.find(e => e.eventId === o.id && e.date === o.date) || {}).status
        : undefined,
    });
  }
  return out;
}

function applyOneOffs(root, blocks) {
  if (!blocks.length) return;
  for (const ca of root.querySelectorAll('.ca')) {
    const day = Number(ca.getAttribute('data-day'));
    // Pixels-per-hour is read back off the column the renderer just drew
    // (height = (E - S) * ph). That is what makes ONE code path fit all three
    // metrics — #grid at 66px/hour, #dayview at 62, print at 72 — without this
    // module importing anything from the frozen render layer.
    const ph = parseFloat(ca.style && ca.style.height) / (E - S);
    if (!Number.isFinite(day) || !Number.isFinite(ph) || ph <= 0) continue;
    for (const b of blocks) {
      if (b.day !== day) continue;
      const el = document.createElement('div');
      el.className = 'evt ov-oneoff';
      // Deliberately NOT data-id: that attribute is the template's identity and
      // the dot sweep below queries it. A ghost is never a template event.
      if (b.id) el.setAttribute('data-oneoff', b.id);
      el.style.top = `${(b.top - S) * ph + 1}px`;
      el.style.height = `${(b.bottom - b.top) * ph - 2}px`;
      el.innerHTML = `<div class="et">${esc(b.name)}</div>` +
        `<div class="en">${fmt(b.start)}&ndash;${fmt(b.end)}</div>` +
        `<span class="ov-tag">one-off</span>`;
      if (b.status) el.appendChild(dotNode(b.status));   // after innerHTML, or it is wiped
      ca.appendChild(el);
    }
  }
}

// ── Planner slots in the Day view ────────────────────────────
// js/grid.js renders on-grid planner slots natively (draggable there). The
// Day view (frozen js/dayview.js) cannot, so the same blocks are drawn here —
// into #dayview ONLY; drawing them into #grid would duplicate. Read-only:
// `.ov-slot` is pointer-events:none in css/plan.css (the Day view has no drag;
// a slot's times are edited on the desktop grid). Metrics come off the column
// height exactly like the one-offs; identity is the same `data-slot`.
function applySlots(root, blocks) {
  if (!blocks.length) return;
  for (const ca of root.querySelectorAll('.ca')) {
    const day = Number(ca.getAttribute('data-day'));
    const ph = parseFloat(ca.style && ca.style.height) / (E - S);
    if (!Number.isFinite(day) || !Number.isFinite(ph) || ph <= 0) continue;
    for (const b of blocks) {
      if (b.day !== day) continue;
      const height = (b.bottom - b.top) * ph;
      const el = document.createElement('div');
      el.className = `evt ${b.cls} pslot ov-slot`;
      el.setAttribute('data-slot', `${b.actId}:${b.idx}`);
      el.style.top = `${(b.top - S) * ph + 1}px`;
      el.style.height = `${height - 2}px`;
      el.innerHTML = `<div class="et">${esc(b.name)}</div>` +
        `<div class="en">${fmt(b.start)}&ndash;${fmt(b.end)}</div>` +
        (b.note && height > 46 ? `<div class="en note">${esc(b.note)}</div>` : '');
      ca.appendChild(el);
    }
  }
}

export function applyOverlay() {
  // Mid-drag renderGrid() rebuilds fire the observer; re-rendering the clash
  // banner mid-drag shifts layout under the cursor and corrupts drop math
  // (drops recorded ±0.5h off — measured). Dots return at drag end via onUp→notify.
  if (isDragging()) return;
  if (applying) return;
  if (!plan.data) return;
  const roots = containers();
  if (!roots.length) return;
  applying = true;
  try {
    // Ghosts go first: their own dots leave the tree with them, so the dot
    // sweep that follows only ever sees template decorations.
    for (const root of roots) {
      root.querySelectorAll('.ov-oneoff').forEach(n => n.remove());
      root.querySelectorAll('.ov-slot').forEach(n => n.remove());
      root.querySelectorAll('.ov-dot').forEach(n => n.remove());
    }
    const mon = mondayOf(todayStr());
    const sun = addDays(mon, 6);
    const oneOffs = oneOffsInWeek(mon, sun);
    for (const root of roots) applyOneOffs(root, oneOffs);
    const slots = gridSlots(plan.data.activities);
    const dayview = document.getElementById('dayview');
    if (dayview) applySlots(dayview, slots);
    for (const e of plan.data.log) {
      if (!e.eventId || e.date < mon || e.date > sun) continue;
      const ev = store.events.find(x => x.id === e.eventId);
      // Weekday-agreement guard: if the block has since been dragged to a
      // different weekday, the entry's logged date no longer agrees with the
      // event's current column — drop the dot rather than stack it in the
      // wrong (or a stale) place; it simply goes undecorated until re-logged.
      // Deliberate asymmetry with the Yesterday receipt (today.js): the GRID
      // enforces this agreement because a column is itself a claim about which
      // weekday the block lives on, while the receipt is a plain text list
      // with no column to contradict, so it keeps moved-event entries.
      // The Day view inherits the same guard: its column is the same claim.
      if (!ev || dayIdx(e.date) !== ev.day) continue;
      for (const root of roots) {
        root.querySelectorAll(`.evt[data-id="${cssEsc(e.eventId)}"]`)
          .forEach(el => el.appendChild(dotNode(e.status)));
      }
    }
    // Slot dots: a timed log row for an on-grid activity carries activityId
    // and no eventId (logTimed's slot shape; a paced row on that day counts
    // too). Same weekday-agreement guard as template dots, and one dot per
    // (activity, date) — a Geography lesson logged twice on Wednesday is still
    // one Wednesday.
    const dotted = new Set();
    for (const e of plan.data.log) {
      if (e.eventId || !e.activityId || e.date < mon || e.date > sun) continue;
      const key = `${e.activityId}|${e.date}`;
      if (dotted.has(key)) continue;
      const d = dayIdx(e.date);
      for (const b of slots) {
        if (b.actId !== e.activityId || b.day !== d) continue;
        dotted.add(key);
        for (const root of roots) {
          root.querySelectorAll(`.evt[data-slot="${cssEsc(`${b.actId}:${b.idx}`)}"]`)
            .forEach(el => el.appendChild(dotNode(e.status)));
        }
      }
    }
    renderClashBanner();
  } finally {
    applying = false;
    // Drop the records our own appends/removals just queued. The `applying`
    // flag alone cannot stop that feedback loop, because a MutationObserver
    // delivers records asynchronously — by the time the callback runs, the
    // flag is already clear again, and each re-apply would queue more records
    // forever. Draining the queue here ends it after exactly one pass.
    if (observer) observer.takeRecords();
  }
}

// Both containers are re-rendered outside the onChange/planNotify hooks that
// call applyOverlay: main.js re-runs renderGrid()/renderDayView() on a 60s
// timer, and js/dayview.js re-renders on every day-tab tap. Those rebuilds
// replace innerHTML wholesale, so freshly-built blocks carry no dots until the
// next data mutation — the dots visibly vanished within a minute. Watching the
// DOM re-applies them whoever did the rebuilding, without touching the frozen
// render modules.
export function initOverlay() {
  if (observer || typeof MutationObserver === 'undefined') return;
  observer = new MutationObserver(() => {
    if (applying || pending) return;
    pending = true;
    // Coalesce: a full grid rebuild is dozens of records, and both containers
    // are rebuilt back to back — that must cost one re-apply, not dozens.
    queueMicrotask(() => { pending = false; applyOverlay(); });
  });
  for (const root of containers())
    observer.observe(root, { childList: true, subtree: true });
}

function renderClashBanner() {
  let bar = document.getElementById('ov-clash');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'ov-clash';
    bar.className = 'no-print';
    const outer = document.querySelector('.grid-outer');
    outer.parentNode.insertBefore(bar, outer);
  }
  const msgs = [];
  for (const a of plan.data.activities) {
    if (!['active', 'planned'].includes(a.status)) continue;
    for (const s of a.slots || []) {
      const hits = findClashes(store.events, s);
      for (const h of hits)
        msgs.push(`<b>⚠ ${esc(a.name)}</b> ${DAYS[s.day]} ${fmt(s.start)}–${fmt(s.end)} overlaps ${esc(h.name || catLabel(h.cat))} ${fmt(h.start)}–${fmt(h.end)}`);
    }
  }
  bar.innerHTML = msgs.length ? `<div class="ov-clash-in">${msgs.join('<br>')}</div>` : '';
}
