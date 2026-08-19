// App state + persistence. Storage contract is v1's: localStorage key
// 'aoife_v3' and KV via /api/get + /api/save. DO NOT change keys or shape.
import { CATS, defEvents, maxIdNum, serialize, applyAltSun, sanitizeEvents } from './model.js';
import { onHold, markSynced } from './sync.js';

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
export const uid = () => `e${++_n}`;

// ── Live re-sync bookkeeping (planner-v2.5) ──────────────────
// `dirty` used to latch true on the first local save and then blocked EVERY
// later remote application for the life of the tab: one drag and the tab was
// frozen on its own snapshot forever. It is replaced by two narrow signals plus
// the hold registry below — none of which latch.
let pendingSaves = 0;      // POSTs in flight; a blob fetched now may predate them
let saveFailed = false;    // the last POST did not land: local is ahead of KV

export const catLabel = k => store.catLabels[k] || CATS[k]?.label || 'Event';
export const evLabel = ev => ev.name || catLabel(ev.cat);

const listeners = new Set();
export const onChange = fn => listeners.add(fn);
export const notify = () => listeners.forEach(fn => fn());

export function initState() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SK)); } catch (e) {}
  store.events = saved?.events ? sanitizeEvents(saved.events) : defEvents();
  store.altSun = saved?.altSun || false;
  store.catLabels = saved?.catLabels || {};
  _n = maxIdNum(store.events);
}

// Pull the shared blob and apply it if it is safe to do so.
//
// STALENESS DECISION (planner-v2.5). The planner blob carries `savedAt`, so
// js/plan/state.js can order a fetched blob against our own last write. THIS
// blob has no timestamp and we deliberately did not add one: VERIFIED that the
// READ path already ignores unknown top-level keys (this function only reads
// events/altSun/catLabels; sanitizeEvents only filters the events array), but
// `serialize()` drops them, so a stamp would have to be added to serialize()
// itself — i.e. a change to the frozen v1 storage shape, not an additive read.
// The contract wins; the writes are ordered structurally instead:
//   * every mutation calls save() immediately, so whenever no POST is in flight
//     and none has failed, KV holds exactly what this tab holds. A fetched blob
//     that DIFFERS therefore came from somewhere else and is the newer one.
//   * pendingSaves > 0 -> our write is in flight and a read may legitimately
//     still return the pre-write blob. Never apply.
//   * saveFailed -> our write never landed (offline): local is ahead of KV, so
//     rather than going stale forever we RE-PUBLISH it and skip this round.
//     Every trigger is therefore a retry, which turns a dropped edit into a
//     120s self-heal instead of a silent loss.
//   * onHold() -> a drag/resize, an open add form or a focused input is an
//     uncommitted local edit; re-rendering under the cursor also corrupts drop
//     math (commit 49ba699).
// Identical blobs are dropped before notify(), so a poll never fights the
// family's scroll, selection or open panel. Errors are silent (offline is
// normal) and never clobber local state.
export async function syncSchedule() {
  if (pendingSaves || onHold()) return false;
  if (saveFailed) {
    // Retry first, apply later: KV must hold our edit before anything is
    // allowed to overwrite it on screen. The next round does the reading.
    await saveRemote(serialize(store));
    if (!saveFailed) markSynced('schedule');       // KV now matches this tab
    return false;
  }
  let data;
  try {
    const res = await fetch('/api/get');
    data = await res.json();
  } catch (e) { return false; }
  markSynced('schedule');                          // the server answered
  if (!data || data.error || data === 'empty') return false;
  // Re-check after the await: a save or a drag can begin while a fetch is out.
  if (pendingSaves || saveFailed || onHold()) return false;
  const next = {
    events: data.events ? sanitizeEvents(data.events) : store.events,
    altSun: typeof data.altSun !== 'undefined' ? data.altSun : store.altSun,
    catLabels: data.catLabels || store.catLabels,
  };
  if (serialize(next) === serialize(store)) return false;   // nothing new to show
  store.events = next.events;
  store.altSun = next.altSun;
  store.catLabels = next.catLabels;
  _n = maxIdNum(store.events);
  notify();
  return true;
}

// Boot load IS the first sync round: same guard, nothing local to protect yet.
export const fetchRemote = syncSchedule;

async function saveRemote(str) {
  pendingSaves++;
  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: str }),
    });
    // Only a real HTTP failure counts: a stubbed/opaque response without `ok`
    // must not permanently mark this tab as ahead of KV.
    saveFailed = !!res && res.ok === false;
  } catch (e) {
    saveFailed = true;                 // offline: local is ahead until one lands
  } finally {
    pendingSaves--;                    // NEVER latches, even on error
  }
}

export function save() {
  const str = serialize(store);
  try { localStorage.setItem(SK, str); } catch (e) {}
  saveRemote(str);
  try { document.dispatchEvent(new CustomEvent('aoife:saved')); } catch (e) {}
}

// Every mutation below re-renders and persists.
const commit = () => { notify(); save(); };

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
