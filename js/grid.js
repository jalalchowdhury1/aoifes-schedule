// Week grid: rendering, today highlight, now line, drag-to-move,
// drag-bottom-edge-to-resize, click/tap to select.
import { DAYS, S, E, SPH, CATS, fmt, snap, clampStart, clampEnd, todayIndex, esc } from './model.js';
import { store, evLabel, save, notify } from './state.js';
import { plan, setSlot } from './plan/state.js';
import { gridSlots, mondayOf, todayStr } from './plan/model.js';

let PH = SPH;
export const setPH = v => { PH = v; };

let ptr = null;
export const isDragging = () => !!ptr;

// Ids are stored data; escape them before they enter a CSS selector (same
// helper as overlay.js's cssEsc, copied rather than imported — grid.js has no
// other dependency on overlay.js and this is two lines).
const cssEsc = x =>
  (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(x) : x);

// Drag/resize only on fine pointers (mouse/trackpad); touch gets tap-to-edit.
export const dragOK = () => matchMedia('(hover:hover) and (pointer:fine)').matches;

export function evtHTML(ev, ph, { handle = false } = {}) {
  const top = (ev.start - S) * ph;
  const height = (ev.end - ev.start) * ph;
  const cls = CATS[ev.cat]?.cls || 'ot';
  return `<div class="evt ${cls}${ev.id === store.selId ? ' sel' : ''}" data-id="${ev.id}"
    style="top:${top + 1}px;height:${height - 2}px;">
    <div class="et">${esc(evLabel(ev))}</div>
    <div class="en">${fmt(ev.start)}&ndash;${fmt(ev.end)}</div>
    ${ev.note && height > 46 ? `<div class="en note">${esc(ev.note)}</div>` : ''}
    ${handle && height > 22 ? '<div class="rh"></div>' : ''}
  </div>`;
}

// A planner slot block. Same shape and metrics as evtHTML so it prints and
// drags identically, but its identity is `data-slot="<actId>:<idx>"` — NEVER
// data-id, which is the template's identity (the editor, the dot sweep and the
// template drag all key off it). `.pslot` is a marker only: no visual change.
export function slotHTML(b, ph, { handle = false } = {}) {
  const top = (b.top - S) * ph;
  const height = (b.bottom - b.top) * ph;
  // A slot skipped THIS week (b.skipped, from gridSlots) is greyed on screen —
  // print stays the recurring week (css/plan.css @media print resets it).
  return `<div class="evt ${b.cls} pslot${b.skipped ? ' pslot-skip' : ''}" data-slot="${esc(b.actId)}:${b.idx}"
    style="top:${top + 1}px;height:${height - 2}px;">
    <div class="et">${esc(b.name)}</div>
    <div class="en">${fmt(b.start)}&ndash;${fmt(b.end)}</div>
    ${b.note && height > 46 ? `<div class="en note">${esc(b.note)}</div>` : ''}
    ${b.skipped ? '<span class="ov-tag">skipped</span>' : ''}
    ${handle && height > 22 ? '<div class="rh"></div>' : ''}
  </div>`;
}

// Which store owns a rendered block. `data-id` → template event (store.events);
// `data-slot` → planner slot (plan.data.activities[].slots[idx]). The actId may
// itself contain ':' — the index is everything after the LAST colon.
export function blockRef(ds) {
  if (!ds) return null;
  if (ds.id) return { kind: 'event', id: ds.id };
  if (typeof ds.slot === 'string') {
    const i = ds.slot.lastIndexOf(':');
    if (i <= 0) return null;
    const actId = ds.slot.slice(0, i);
    const idx = Number(ds.slot.slice(i + 1));
    if (!/^\d+$/.test(ds.slot.slice(i + 1)) || !Number.isInteger(idx)) return null;
    return { kind: 'slot', actId, idx };
  }
  return null;
}

// The live slot object behind a `blockRef` (or null): the drag preview patches
// it in place exactly as the template drag patches store.events.
const slotOf = ref => {
  const act = plan.data && (plan.data.activities || []).find(a => a.id === ref.actId);
  const s = act && Array.isArray(act.slots) ? act.slots[ref.idx] : null;
  return s || null;
};

export function renderGrid() {
  const grid = document.getElementById('grid');
  const gh = (E - S) * PH;
  const tIdx = todayIndex(new Date().getDay());
  const canDrag = !store.locked && dragOK();
  const slots = plan.data ? gridSlots(plan.data.activities, plan.data.overrides, mondayOf(todayStr())) : [];

  let tc = `<div class="timecol" style="padding-top:30px;">`;
  // Last row (the 5pm label) gets label height only, not a full hour block —
  // a full row makes the time column outgrow the day columns and pushes
  // printing onto a blank second page.
  for (let h = S; h <= E; h++) tc += `<div style="height:${h < E ? PH : 16}px;"><span>${fmt(h)}</span></div>`;
  tc += '</div>';

  const cols = DAYS.map((day, di) => {
    const isWE = di >= 5, isToday = di === tIdx;
    let col = `<div class="daycol${isWE ? ' wkend' : ''}${isToday ? ' today' : ''}">`;
    col += `<div class="dayhead">${day}</div>`;
    col += `<div class="ca" data-day="${di}" style="height:${gh}px;">`;
    for (let i = 0; i <= E - S; i++) {
      col += `<div class="hl" style="top:${i * PH}px;"></div>`;
      if (i < E - S) col += `<div class="hl hf" style="top:${i * PH + PH / 2}px;"></div>`;
    }
    if (isToday) {
      const now = new Date(), h = now.getHours() + now.getMinutes() / 60;
      if (h >= S && h <= E) col += `<div class="nowline" style="top:${(h - S) * PH}px;"></div>`;
    }
    store.events.filter(e => e.day === di).forEach(ev => { col += evtHTML(ev, PH, { handle: canDrag }); });
    slots.filter(b => b.day === di).forEach(b => { col += slotHTML(b, PH, { handle: canDrag }); });
    col += `</div><div class="dayhead">${day}</div></div>`;
    return col;
  }).join('');

  grid.innerHTML = tc + cols;
}

const colRects = grid => [...grid.querySelectorAll('.ca')].map(el => el.getBoundingClientRect());
const dayAtX = (x, rs) => rs.findIndex(r => r && x >= r.left && x <= r.right);

let suppressClick = false;

export function initGrid() {
  const grid = document.getElementById('grid');

  grid.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (store.locked || !dragOK()) return;
    const evtEl = e.target.closest('.evt');
    if (!evtEl) return;
    const ref = blockRef(evtEl.dataset);
    if (!ref) return;                       // a one-off ghost, or nothing we own
    e.preventDefault();
    const base = { kind: ref.kind, ref, moved: false, startX: e.clientX, startY: e.clientY };
    if (ref.kind === 'event') {
      const ev = store.events.find(x => x.id === ref.id);
      if (!ev) return;
      base.id = ref.id;
      base.sel = `[data-id="${cssEsc(ref.id)}"]`;
      if (e.target.closest('.rh')) {
        const col = grid.querySelector(`.ca[data-day="${ev.day}"]`);
        ptr = { ...base, type: 'resize', colRect: col.getBoundingClientRect() };
      } else {
        const rect = evtEl.getBoundingClientRect();
        ptr = {
          ...base, type: 'move',
          offsetH: (e.clientY - rect.top) / PH,
          duration: ev.end - ev.start,
          // Column rects are snapshotted at drag start; scrolling mid-drag makes them
          // stale (worst case: drop lands on the wrong day). Accepted for simplicity.
          rects: colRects(grid),
        };
      }
    } else {
      // Planner slot: same math, different store. The preview patches the live
      // slot object in place (as the template path patches store.events); the
      // drop commits it through setSlot, a cancel restores `orig`.
      const s = slotOf(ref);
      if (!s) return;
      base.orig = { day: s.day, start: s.start, end: s.end };
      base.sel = `[data-slot="${cssEsc(`${ref.actId}:${ref.idx}`)}"]`;
      if (e.target.closest('.rh')) {
        const col = grid.querySelector(`.ca[data-day="${s.day}"]`);
        ptr = { ...base, type: 'resize', colRect: col.getBoundingClientRect() };
      } else {
        const rect = evtEl.getBoundingClientRect();
        ptr = {
          ...base, type: 'move',
          offsetH: (e.clientY - rect.top) / PH,
          duration: s.end - s.start,
          rects: colRects(grid),
        };
      }
    }
    evtEl.classList.add('ghost');
    document.addEventListener('pointermove', onMove, { passive: false });
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
  });

  // Tap/click select for coarse pointers and non-drag clicks. Selection (and
  // the editor it opens) is template-only: a planner slot's times are changed
  // by dragging, its everything-else in the planner.
  grid.addEventListener('click', e => {
    if (suppressClick) { suppressClick = false; return; }
    const evtEl = e.target.closest('.evt');
    if (!evtEl || store.locked) return;
    const ref = blockRef(evtEl.dataset);
    if (!ref) return;
    // A slot has no editor of its own (its times are changed by dragging), but
    // clicking one while a template block's editor is open must still close
    // it — otherwise the stale editor lingers over an unrelated tap (red-team
    // M5). toggleSelect(null) is a harmless no-op when nothing was selected.
    if (ref.kind === 'event') toggleSelect(ref.id);
    else toggleSelect(null);
  });
}

function toggleSelect(id) {
  store.selId = store.selId === id ? null : id;
  store.addMode = false;
  notify();
}

function onMove(e) {
  if (!ptr) return;
  e.preventDefault();
  if (Math.abs(e.clientX - ptr.startX) > 3 || Math.abs(e.clientY - ptr.startY) > 3) ptr.moved = true;
  if (ptr.kind === 'slot') {
    const s = slotOf(ptr.ref);
    if (!s) return;
    if (ptr.type === 'move') {
      const di = dayAtX(e.clientX, ptr.rects);
      if (di < 0) return;
      const r = ptr.rects[di];
      const ns = clampStart(snap(S + (e.clientY - r.top) / PH - ptr.offsetH), ptr.duration);
      s.day = di; s.start = ns; s.end = ns + ptr.duration;
    } else {
      s.end = clampEnd(s.start, snap(S + (e.clientY - ptr.colRect.top) / PH));
    }
  } else if (ptr.type === 'move') {
    const di = dayAtX(e.clientX, ptr.rects);
    if (di < 0) return;
    const r = ptr.rects[di];
    const ns = clampStart(snap(S + (e.clientY - r.top) / PH - ptr.offsetH), ptr.duration);
    store.events = store.events.map(x => (x.id === ptr.id ? { ...x, day: di, start: ns, end: ns + ptr.duration } : x));
  } else {
    const ev = store.events.find(x => x.id === ptr.id);
    if (!ev) return;
    const ne = clampEnd(ev.start, snap(S + (e.clientY - ptr.colRect.top) / PH));
    store.events = store.events.map(x => (x.id === ptr.id ? { ...x, end: ne } : x));
  }
  renderGrid();
  document.querySelector(`#grid .evt${ptr.sel}`)?.classList.add('ghost');
}

function onUp() {
  if (!ptr) return;
  const { moved, kind, id, ref, orig } = ptr;
  ptr = null;
  document.removeEventListener('pointermove', onMove);
  document.removeEventListener('pointerup', onUp);
  document.removeEventListener('pointercancel', onCancel);
  suppressClick = true; // the browser fires a click right after pointerup; we've handled it
  if (kind === 'slot') {
    const s = moved ? slotOf(ref) : null;
    // A real drag that nets out to the exact original {day,start,end} (picked
    // up and set back down) is still a no-op — commit() persists the WHOLE
    // blob, so calling setSlot here would be a pointless full-blob POST
    // (red-team L2).
    const changed = s && orig && (s.day !== orig.day || s.start !== orig.start || s.end !== orig.end);
    // setSlot → commit → planNotify → tabs.js re-renders the grid (ghost gone).
    if (changed) setSlot(ref.actId, ref.idx, { day: s.day, start: s.start, end: s.end });
    else {
      // No move, or a no-op net move: the preview may still have nudged the
      // live slot by a snap step under the 3px threshold, or sit exactly on
      // `orig` already — put it back either way, uncommitted.
      const live = s || slotOf(ref); if (live && orig) Object.assign(live, orig);
      renderGrid();                       // and drop the ghost styling
    }
  } else if (moved) { notify(); save(); }
  else toggleSelect(id);
}

function onCancel() {
  if (!ptr) return;
  const { kind, ref, orig } = ptr;
  ptr = null;
  document.removeEventListener('pointermove', onMove);
  document.removeEventListener('pointerup', onUp);
  document.removeEventListener('pointercancel', onCancel);
  if (kind === 'slot') { const s = slotOf(ref); if (s && orig) Object.assign(s, orig); }
  renderGrid(); // clears ghost styling (and, for a slot, restores the preview)
}
