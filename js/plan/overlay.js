// Read-only decorations on the rendered schedule: status dots on logged blocks
// and a clash banner. Never mutates events; only appends elements into rendered DOM.
import { fmt, esc, DAYS } from '../model.js';
import { store, catLabel } from '../state.js';
import { isDragging } from '../grid.js';
import { todayStr, mondayOf, addDays, dayIdx, findClashes } from './model.js';
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

let observer = null;
// Reentrancy guard. With a real browser's ASYNCHRONOUS record delivery this is
// unreachable (measured: 0 hits) — the callback can never run while we are
// mid-apply, which is exactly why draining takeRecords() below is the load-
// bearing half. It stays for defense-in-depth and because the test stub
// delivers records synchronously, where it IS the thing that stops recursion.
let applying = false;
let pending = false;    // microtask coalescing: one re-apply per burst

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
    for (const root of roots) root.querySelectorAll('.ov-dot').forEach(n => n.remove());
    const mon = mondayOf(todayStr());
    const sun = addDays(mon, 6);
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
        root.querySelectorAll(`.evt[data-id="${cssEsc(e.eventId)}"]`).forEach(el => {
          const d = document.createElement('span');
          d.className = `ov-dot ov-${e.status}`;
          d.textContent = e.status === 'done' ? '✓' : e.status === 'partial' ? '◐' : '✗';
          el.appendChild(d);
        });
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
