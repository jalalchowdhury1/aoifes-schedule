// Edit panel (desktop) / bottom sheet (mobile), add-event form, legend pills.
import { CATS, DAYS, S, E, fmt, esc } from './model.js';
import { store, catLabel, evLabel, updateEvent, deleteEvent, addEvent, renameCat, notify } from './state.js';

let nw = null; // draft for the add form

const timeOpts = (sel, from, to) => {
  let o = '';
  for (let t = from; t <= to; t += 0.5) o += `<option value="${t}"${t === sel ? ' selected' : ''}>${fmt(t)}</option>`;
  return o;
};
const catOpts = sel => Object.keys(CATS).map(k =>
  `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(catLabel(k))}</option>`).join('');
const dayOpts = sel => DAYS.map((d, i) =>
  `<option value="${i}"${i === sel ? ' selected' : ''}>${d}</option>`).join('');

export function openAdd(day = 0) {
  store.selId = null;
  store.addMode = true;
  nw = { cat: 'other', day, start: 10, end: 11, note: '', name: '' };
  notify();
}

export function closeEditor() {
  store.selId = null;
  store.addMode = false;
  notify();
}

function formFields(v) {
  // Shared field markup for add + edit forms. `v` is the draft or the event.
  return `
    <div class="form-grid">
      <div><label>Custom name</label><input type="text" id="ed-name" placeholder="leave blank for default" value="${esc(v.name || '')}"></div>
      <div><label>Type</label><select id="ed-cat">${catOpts(v.cat)}</select></div>
      <div><label>Day</label><select id="ed-day">${dayOpts(v.day)}</select></div>
      <div class="time-pair">
        <div><label>Start</label><select id="ed-start">${timeOpts(v.start, S, E - 0.5)}</select></div>
        <div><label>End</label><select id="ed-end">${timeOpts(v.end, S + 0.5, E)}</select></div>
      </div>
    </div>
    <div class="form-row"><label>Note</label><input type="text" id="ed-note" placeholder="optional note, e.g. every other week" value="${esc(v.note || '')}"></div>
    <p class="form-err" id="ed-err">End must be after start.</p>`;
}

export function renderEditor() {
  const box = document.getElementById('editor');
  const backdrop = document.getElementById('editor-backdrop');
  const ev = store.selId ? store.events.find(x => x.id === store.selId) : null;
  const open = !store.locked && (store.addMode || ev);
  backdrop.classList.toggle('open', !!open);
  if (!open) { box.innerHTML = ''; return; }

  if (store.addMode) {
    box.innerHTML = `<div class="panel">
      <div class="panel-head"><span class="panel-title">Add event</span><button type="button" id="ed-close">&#x2715;</button></div>
      ${formFields(nw)}
      <div class="form-actions">
        <button type="button" class="primary-btn" id="ed-add" style="flex:1;">Add event</button>
        <button type="button" id="ed-cancel">Cancel</button>
      </div>
    </div>`;
    box.querySelector('#ed-close').onclick = closeEditor;
    box.querySelector('#ed-cancel').onclick = closeEditor;
    box.querySelector('#ed-name').oninput = e => { nw.name = e.target.value; };
    box.querySelector('#ed-note').oninput = e => { nw.note = e.target.value; };
    box.querySelector('#ed-cat').onchange = e => { nw.cat = e.target.value; };
    box.querySelector('#ed-day').onchange = e => { nw.day = +e.target.value; };
    box.querySelector('#ed-start').onchange = e => {
      nw.start = +e.target.value;
      if (nw.end <= nw.start) nw.end = Math.min(E, nw.start + 0.5);
      notify();
    };
    box.querySelector('#ed-end').onchange = e => {
      nw.end = +e.target.value;
      if (nw.end <= nw.start) nw.start = Math.max(S, nw.end - 0.5);
      notify();
    };
    box.querySelector('#ed-add').onclick = () => {
      if (nw.end <= nw.start) { box.querySelector('#ed-err').classList.add('show'); return; }
      store.addMode = false;
      addEvent({ ...nw, name: nw.name.trim() });
    };
    return;
  }

  box.innerHTML = `<div class="panel">
    <div class="panel-head"><span class="panel-title">${esc(evLabel(ev))}</span><button type="button" id="ed-close">&#x2715;</button></div>
    ${formFields({ ...ev, name: evLabel(ev) })}
    <div class="form-actions"><button type="button" class="danger-btn" id="ed-del">Delete event</button></div>
  </div>`;
  box.querySelector('#ed-close').onclick = closeEditor;
  box.querySelector('#ed-name').onchange = e => {
    // Blank or default-label input clears the custom name (v1 behavior).
    const def = CATS[ev.cat]?.label || '';
    const v = e.target.value.trim();
    updateEvent(ev.id, { name: v === '' || v === def ? '' : v });
  };
  box.querySelector('#ed-note').onchange = e => updateEvent(ev.id, { note: e.target.value });
  box.querySelector('#ed-cat').onchange = e => updateEvent(ev.id, { cat: e.target.value });
  box.querySelector('#ed-day').onchange = e => updateEvent(ev.id, { day: +e.target.value });
  box.querySelector('#ed-start').onchange = e => {
    const v = +e.target.value;
    updateEvent(ev.id, { start: v, end: v >= ev.end ? Math.min(E, v + 0.5) : ev.end });
  };
  box.querySelector('#ed-end').onchange = e => {
    const v = +e.target.value;
    updateEvent(ev.id, { end: v, start: v <= ev.start ? Math.max(S, v - 0.5) : ev.start });
  };
  box.querySelector('#ed-del').onclick = () => deleteEvent(ev.id);
}

export function renderLegend() {
  const leg = document.getElementById('legend');
  leg.innerHTML = Object.entries(CATS).map(([k, v]) =>
    `<span class="pill ${v.cls}" data-cat="${k}" title="Click to rename">${esc(catLabel(k))}</span>`).join('');
}

export function initLegend() {
  document.getElementById('legend').addEventListener('click', e => {
    let pill = e.target.closest('.pill');
    if (!pill) return;
    // A blur-commit may have re-rendered the legend between mousedown and click,
    // detaching the clicked node — re-resolve it in the live DOM by category.
    if (!pill.isConnected) pill = document.querySelector(`#legend .pill[data-cat="${pill.dataset.cat}"]`);
    if (!pill || pill.querySelector('input')) return;
    const key = pill.dataset.cat;
    const cur = catLabel(key);
    pill.innerHTML = '';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = cur;
    inp.style.width = Math.max(50, cur.length * 7.5) + 'px';
    pill.appendChild(inp);
    inp.focus();
    inp.select();
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      renameCat(key, inp.value.trim());
    };
    inp.addEventListener('blur', commit);
    inp.addEventListener('input', () => { inp.style.width = Math.max(50, inp.value.length * 7.5) + 'px'; });
    inp.addEventListener('keydown', ev2 => {
      if (ev2.key === 'Enter') { ev2.preventDefault(); inp.blur(); }
      if (ev2.key === 'Escape') { done = true; renderLegend(); }
    });
  });
}

export function initEditor() {
  document.getElementById('editor-backdrop').addEventListener('click', closeEditor);
}
