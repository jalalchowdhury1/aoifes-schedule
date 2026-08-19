// Planner tab navigation. The Week tab shows the untouched v2 app; other tabs
// hide the schedule chrome and show a planner view. Print safety is guaranteed
// by plan.css's own @media print block (hide planner UI, force .grid-outer
// visible), not by .no-print alone — so printing from any tab yields the week grid.
import { initPlan, syncPlan, onPlanChange } from './state.js';
import { onChange, store, syncSchedule, holdSync } from '../state.js';
import { isDragging } from '../grid.js';
import { renderToday, paintSynced } from './today.js';
import { renderYear } from './year.js';
import { renderSubjects } from './subjects.js';
import { applyOverlay, initOverlay } from './overlay.js';

const TK = 'aoife_ptab';
const TABS = [
  ['today', 'Today'], ['week', 'Week'], ['year', 'Year'], ['subjects', 'Subjects'],
];

let tab = 'week';

function setTab(t) {
  tab = t;
  try { localStorage.setItem(TK, t); } catch (e) {}
  document.getElementById('app').dataset.ptab = t;
  renderTabs();
  renderViews();
}

function renderTabs() {
  document.getElementById('ptabs').innerHTML = TABS.map(([k, label]) =>
    `<button type="button" class="ptab${k === tab ? ' on' : ''}" data-tab="${k}">${label}</button>`
  ).join('');
}

function renderViews() {
  if (tab === 'today') renderToday();
  else if (tab === 'year') renderYear();
  else if (tab === 'subjects') renderSubjects();
  // Deferred one microtask: on a shared notify (onChange), main.js's render()
  // — and therefore renderGrid(), which replaces the grid's innerHTML — may run
  // AFTER this listener. Overlaying synchronously would decorate DOM that is
  // about to be thrown away, so the dots vanish on first paint.
  // The overlay's MutationObserver would also catch that rebuild; this explicit
  // call is kept so first paint never depends on observer timing (and the
  // overlay's own reentrancy flag makes the duplicate apply cheap).
  queueMicrotask(applyOverlay);
}

// ── Live re-sync scheduler ───────────────────────────────────
// Both blobs are written from outside this browser (the Telegram bot writes the
// planner blob; another phone writes the template), so an open tab must re-read
// them or it silently shows a frozen snapshot. One scheduler drives both: the
// data-safety guards live in the two stores, the ENVIRONMENT rules live here.
// Nothing polls in a background tab — a phone left on the fridge would otherwise
// burn battery all day for a page nobody is looking at.
export const SYNC_MS = 120000;

export const runSync = () =>
  Promise.all([syncPlan(), syncSchedule()]).then(paintSynced, () => {});

// Deps are injectable so the visibility rules are testable without a browser.
export function initLiveSync(run = runSync,
  { doc = document, win = window, every = setInterval } = {}) {
  const visible = () => doc.visibilityState === 'visible';
  // A phone returning from the lock screen or the app switcher fires
  // visibilitychange; a desktop tab regaining focus fires window.focus. Both
  // are the moment a stale tab is about to be read, so both re-sync at once.
  doc.addEventListener('visibilitychange', () => { if (visible()) run(); });
  win.addEventListener('focus', () => run());
  every(() => { if (visible()) run(); }, SYNC_MS);
}

export function initPlanner() {
  initPlan();
  let t = null;
  try { t = localStorage.getItem(TK); } catch (e) {}
  if (!t) t = matchMedia('(max-width: 699px)').matches ? 'today' : 'week';
  document.getElementById('ptabs').addEventListener('click', e => {
    const b = e.target.closest('.ptab');
    if (b) setTab(b.dataset.tab);
  });
  onPlanChange(renderViews);
  onChange(renderViews);            // template changes re-render planner views too
  // Watch #grid/#dayview so the dots survive re-renders that bypass these two
  // hooks entirely (main.js's 60s timer, day-tab taps in js/dayview.js).
  initOverlay();
  // Two uncommitted-edit states on the template that a fetched blob must not
  // walk over: a drag/resize in progress (the store is ahead of KV with no save
  // yet, and re-rendering mid-drag corrupts drop math), and an open editor
  // (its <input>s are read on change/blur, so a rebuild would drop what is
  // being typed). Both clear themselves; neither latches.
  holdSync(isDragging);
  holdSync(() => !store.locked && (store.addMode || !!store.selId));
  setTab(t);
  syncPlan().then(paintSynced, () => {});   // boot load; main.js boots the template
  initLiveSync();
}
