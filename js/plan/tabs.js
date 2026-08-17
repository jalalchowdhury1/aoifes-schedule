// Planner tab navigation. The Week tab shows the untouched v2 app; other tabs
// hide the schedule chrome and show a planner view. Print always prints the
// week grid (print.css hides .pview/#ptabs via .no-print).
import { initPlan, fetchPlanRemote, onPlanChange } from './state.js';
import { onChange } from '../state.js';
import { renderToday } from './today.js';
import { renderYear } from './year.js';
import { renderSubjects } from './subjects.js';
import { applyOverlay } from './overlay.js';

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
  applyOverlay();
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
  setTab(t);
  fetchPlanRemote();
}
