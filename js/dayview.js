// Mobile portrait day view: Mon-Sun tabs, one day's column, Day/Week toggle.
import { DAYS, S, E, fmt, todayIndex } from './model.js';
import { store, notify } from './state.js';
import { evtHTML } from './grid.js';

const VK = 'aoife_mobile_view';
const DPH = 62; // day-view pixels per hour

let selDay = todayIndex(new Date().getDay());

function syncViewBtn() {
  const app = document.getElementById('app');
  // Button shows the view you'd switch TO.
  document.getElementById('view-btn').textContent = app.classList.contains('view-day') ? 'Week' : 'Day';
}

export function initDayView() {
  const app = document.getElementById('app');
  let v = 'day';
  try { v = localStorage.getItem(VK) || 'day'; } catch (e) {}
  app.classList.remove('view-day', 'view-week');
  app.classList.add(v === 'week' ? 'view-week' : 'view-day');

  document.getElementById('view-btn').addEventListener('click', () => {
    const toWeek = app.classList.contains('view-day');
    app.classList.toggle('view-day', !toWeek);
    app.classList.toggle('view-week', toWeek);
    try { localStorage.setItem(VK, toWeek ? 'week' : 'day'); } catch (e) {}
    syncViewBtn();
  });

  document.getElementById('day-tabs').addEventListener('click', e => {
    const b = e.target.closest('.day-tab');
    if (!b) return;
    selDay = +b.dataset.day;
    renderDayView();
  });

  // Tap an event to open the edit sheet (when unlocked).
  document.getElementById('dayview').addEventListener('click', e => {
    const evtEl = e.target.closest('.evt');
    if (!evtEl || store.locked) return;
    const id = evtEl.dataset.id;
    store.selId = store.selId === id ? null : id;
    store.addMode = false;
    notify();
  });

  syncViewBtn();
}

export function renderDayView() {
  const tIdx = todayIndex(new Date().getDay());

  document.getElementById('day-tabs').innerHTML = DAYS.map((d, i) =>
    `<button type="button" class="day-tab${i === selDay ? ' active' : ''}${i === tIdx ? ' today' : ''}" data-day="${i}">${d}</button>`
  ).join('');

  const gh = (E - S) * DPH;
  let tc = `<div class="timecol" style="padding-top:12px;">`;
  for (let h = S; h <= E; h++) tc += `<div style="height:${DPH}px;"><span>${fmt(h)}</span></div>`;
  tc += '</div>';

  let col = `<div class="daycol"><div class="ca" data-day="${selDay}" style="height:${gh}px;margin-top:12px;">`;
  for (let i = 0; i <= E - S; i++) {
    col += `<div class="hl" style="top:${i * DPH}px;"></div>`;
    if (i < E - S) col += `<div class="hl hf" style="top:${i * DPH + DPH / 2}px;"></div>`;
  }
  if (selDay === tIdx) {
    const now = new Date(), h = now.getHours() + now.getMinutes() / 60;
    if (h >= S && h <= E) col += `<div class="nowline" style="top:${(h - S) * DPH}px;"></div>`;
  }
  store.events.filter(e => e.day === selDay).forEach(ev => { col += evtHTML(ev, DPH, { handle: false }); });
  col += '</div></div>';

  document.getElementById('dayview').innerHTML = `<div class="dv-flex">${tc}${col}</div>`;
}
