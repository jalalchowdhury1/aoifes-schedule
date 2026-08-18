// Read-only decorations on the classic week grid: today-status dots and a
// clash banner. Never mutates events; only appends elements into rendered DOM.
import { fmt, esc, DAYS } from '../model.js';
import { store, catLabel } from '../state.js';
import { todayStr, mondayOf, addDays, dayIdx, findClashes } from './model.js';
import { plan } from './state.js';

// Event ids are stored data; escape them before they enter a CSS selector.
const cssEsc = x =>
  (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(x) : x);

export function applyOverlay() {
  if (!plan.data) return;
  const grid = document.getElementById('grid');
  if (!grid) return;
  grid.querySelectorAll('.ov-dot').forEach(n => n.remove());
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
    if (!ev || dayIdx(e.date) !== ev.day) continue;
    grid.querySelectorAll(`.evt[data-id="${cssEsc(e.eventId)}"]`).forEach(el => {
      const d = document.createElement('span');
      d.className = `ov-dot ov-${e.status}`;
      d.textContent = e.status === 'done' ? '✓' : e.status === 'partial' ? '◐' : '✗';
      el.appendChild(d);
    });
  }
  renderClashBanner();
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
