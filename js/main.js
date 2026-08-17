import { initTheme } from './theme.js';
import { store, initState, fetchRemote, onChange, toggleAltSun, resetToDefaults } from './state.js';
import { renderGrid, initGrid, isDragging, dragOK } from './grid.js';
import { renderEditor, renderLegend, initLegend, initEditor, openAdd } from './editor.js';
import { renderDayView, initDayView, getSelDay } from './dayview.js';
import { initPrint } from './print.js';
import { initPlanner } from './plan/tabs.js';

const LOCK_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9V6zm9 14H6V10h12v10zm-6-3c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"/></svg>';
const UNLOCK_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h2c0-1.66 1.34-3 3-3s3 1.34 3 3v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10zm-6-3c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"/></svg>';

function syncChrome() {
  const app = document.getElementById('app');
  app.classList.toggle('locked', store.locked);
  app.classList.toggle('can-drag', !store.locked && dragOK());
  const lb = document.getElementById('lock-btn');
  lb.innerHTML = store.locked ? `${LOCK_ICON} Unlock to Edit` : `${UNLOCK_ICON} Lock Schedule`;
  lb.classList.toggle('on', !store.locked);
  document.getElementById('sun-btn').textContent = store.altSun ? 'Alt Sunday' : 'Regular';
}

export function render() {
  syncChrome();
  renderLegend();
  renderGrid();
  renderDayView();
  renderEditor();
}

initState();
initTheme();
initGrid();
initLegend();
initEditor();
initDayView();
initPrint();
initPlanner();
onChange(render);

document.getElementById('lock-btn').addEventListener('click', () => {
  store.locked = !store.locked;
  if (store.locked) { store.selId = null; store.addMode = false; }
  render();
});
document.getElementById('sun-btn').addEventListener('click', toggleAltSun);
document.getElementById('add-btn').addEventListener('click', () => {
  const app = document.getElementById('app');
  const mobileDay = matchMedia('(max-width: 699px)').matches && app.classList.contains('view-day');
  openAdd(mobileDay ? getSelDay() : 0);
});
document.getElementById('reset-btn').addEventListener('click', () => {
  if (confirm('Reset to defaults? All changes will be cleared.')) resetToDefaults();
});

let ftimer = null;
document.addEventListener('aoife:saved', () => {
  const f = document.getElementById('flash');
  f.classList.add('show');
  clearTimeout(ftimer);
  ftimer = setTimeout(() => f.classList.remove('show'), 1400);
});

render();
fetchRemote();

setInterval(() => { if (!isDragging()) { renderGrid(); renderDayView(); } }, 60000);
