// Theme cycling: auto (follows system) -> light -> dark -> auto.
const TK = 'aoife_theme';
const mq = matchMedia('(prefers-color-scheme: dark)');
let pref = 'auto';

const ICONS = {
  auto: '<svg width="15" height="15" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3a9 9 0 010 18z" fill="currentColor"/></svg>',
  light: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
  dark: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>',
};

export const resolved = () => (pref === 'auto' ? (mq.matches ? 'dark' : 'light') : pref);

export function applyTheme() {
  document.documentElement.dataset.theme = resolved();
  const btn = document.getElementById('theme-btn');
  if (btn) {
    btn.innerHTML = ICONS[pref];
    btn.title = `Theme: ${pref}`;
    btn.setAttribute('aria-label', `Theme: ${pref} — click to change`);
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.body).backgroundColor;
}

export function initTheme() {
  try {
    const saved = localStorage.getItem(TK);
    pref = ['auto', 'light', 'dark'].includes(saved) ? saved : 'auto';
  } catch (e) {}
  mq.addEventListener('change', () => { if (pref === 'auto') applyTheme(); });
  const btn = document.getElementById('theme-btn');
  if (btn) btn.addEventListener('click', () => {
    pref = { auto: 'light', light: 'dark', dark: 'auto' }[pref] || 'auto';
    try { localStorage.setItem(TK, pref); } catch (e) {}
    applyTheme();
  });
  applyTheme();
}
