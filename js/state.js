// App state + persistence. Storage contract is v1's: localStorage key
// 'aoife_v3' and KV via /api/get + /api/save. DO NOT change keys or shape.
import { CATS, defEvents, maxIdNum, serialize, applyAltSun } from './model.js';

const SK = 'aoife_v3';

export const store = {
  events: [],
  altSun: false,
  catLabels: {},
  locked: true,
  selId: null,
  addMode: false,
};

let _n = 0;
let dirty = false;
export const uid = () => `e${++_n}`;

export const catLabel = k => store.catLabels[k] || CATS[k]?.label || 'Event';
export const evLabel = ev => ev.name || catLabel(ev.cat);

const listeners = new Set();
export const onChange = fn => listeners.add(fn);
export const notify = () => listeners.forEach(fn => fn());

export function initState() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SK)); } catch (e) {}
  store.events = saved?.events || defEvents();
  store.altSun = saved?.altSun || false;
  store.catLabels = saved?.catLabels || {};
  _n = maxIdNum(store.events);
}

export async function fetchRemote() {
  try {
    const res = await fetch('/api/get');
    const data = await res.json();
    if (!dirty && data && !data.error && data !== 'empty') {
      if (data.events) store.events = data.events;
      if (typeof data.altSun !== 'undefined') store.altSun = data.altSun;
      if (data.catLabels) store.catLabels = data.catLabels;
      _n = maxIdNum(store.events);
      notify();
    }
  } catch (e) {}
}

async function saveRemote(str) {
  try {
    await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: str }),
    });
  } catch (e) {}
}

export function save() {
  dirty = true;
  const str = serialize(store);
  try { localStorage.setItem(SK, str); } catch (e) {}
  saveRemote(str);
  try { document.dispatchEvent(new CustomEvent('aoife:saved')); } catch (e) {}
}

// Every mutation below re-renders and persists.
const commit = () => { dirty = true; notify(); save(); };

export function updateEvent(id, patch) {
  store.events = store.events.map(x => (x.id === id ? { ...x, ...patch } : x));
  commit();
}

export function deleteEvent(id) {
  store.events = store.events.filter(x => x.id !== id);
  if (store.selId === id) store.selId = null;
  commit();
}

export function addEvent(ev) {
  store.events = [...store.events, { ...ev, id: uid() }];
  commit();
}

export function toggleAltSun() {
  store.altSun = !store.altSun;
  store.events = applyAltSun(store.events, store.altSun);
  commit();
}

export function renameCat(key, val) {
  const def = CATS[key]?.label || '';
  if (val && val !== def) store.catLabels[key] = val;
  else delete store.catLabels[key];
  commit();
}

export function resetToDefaults() {
  // v1 behavior: reset clears events + altSun but KEEPS catLabels renames.
  dirty = true;
  store.events = defEvents();
  store.altSun = false;
  store.selId = null;
  store.addMode = false;
  _n = maxIdNum(store.events);
  const str = serialize(store);
  try { localStorage.setItem(SK, str); } catch (e) {}
  saveRemote(str);
  notify();
}
