// Print modal + dark/light print themes. Printing always uses the week grid
// (print.css forces it visible) at the taller print row height.
import { SPH, PPH } from './model.js';
import { setPH, renderGrid } from './grid.js';
import { applyTheme } from './theme.js';

export function initPrint() {
  const modal = document.getElementById('pmodal');
  document.getElementById('print-btn').addEventListener('click', () => modal.classList.add('open'));
  document.getElementById('pm-cancel').addEventListener('click', () => modal.classList.remove('open'));
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
  modal.querySelectorAll('[data-ptheme]').forEach(b =>
    b.addEventListener('click', () => doPrint(b.dataset.ptheme)));

  // Also correct row height for direct Cmd/Ctrl+P prints.
  window.addEventListener('beforeprint', () => { setPH(PPH); renderGrid(); });
  window.addEventListener('afterprint', () => {
    setPH(SPH);
    renderGrid();
    applyTheme(); // restore the user's screen theme if doPrint changed it
  });
}

function doPrint(theme) {
  document.getElementById('pmodal').classList.remove('open');
  document.documentElement.dataset.theme = theme; // reuses screen tokens for print
  setTimeout(() => window.print(), 80);
}
