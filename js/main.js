import { initTheme } from './theme.js';
import { store, initState, fetchRemote, onChange, toggleAltSun, resetToDefaults } from './state.js';

function syncChrome() {
  const app = document.getElementById('app');
  app.classList.toggle('locked', store.locked);
  document.getElementById('sun-btn').textContent = store.altSun ? 'Alt Sunday' : 'Regular';
}

export function render() {
  syncChrome();
}

initState();
initTheme();
onChange(render);

document.getElementById('sun-btn').addEventListener('click', toggleAltSun);
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
