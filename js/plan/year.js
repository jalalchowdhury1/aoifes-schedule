// Year view: per-activity 52-week tracks + week marking + cycle anchor flip.
import { esc } from '../model.js';
import {
  todayStr, addDays, mondayOf, weeksBetween, weekType, weekCapacity,
  actTotal, actDone, projectFinish,
} from './model.js';
import { plan, setWeekType, flipAnchor } from './state.js';

const fmtDate = s => new Date(s + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const CYCLE_NEXT = { teaching: 'travel', travel: 'off', off: 'light', light: 'teaching' };

function yearWeeks() {
  const { start, end } = plan.data.year;
  const out = [];
  let w = mondayOf(start);
  while (w <= end) { out.push(w); w = addDays(w, 7); }
  return out;
}

function trackFor(a, wks, today) {
  const p = plan.data;
  let remainingDone = actDone(a);
  const total = actTotal(a);
  let cells = '';
  for (const w of wks) {
    const wt = weekType(p.weeks, w);
    let cls = '';
    if (wt === 'travel') cls = 'trip';
    else if (wt === 'off') cls = 'offw';
    else if (a.type === 'paced' && a.status === 'active' && total > 0) {
      const cap = weekCapacity(a, w, p.weeks, p.parentCycle);
      if (w <= mondayOf(today) && remainingDone > 0) { cls = 'fill'; remainingDone -= cap; }
      else if (cap > 0) cls = 'plan';
    } else if (a.status === 'active' && wt !== 'off') cls = w <= mondayOf(today) ? 'fill' : 'plan';
    cells += `<i class="${cls}" data-w="${w}"></i>`;
  }
  const fin = a.type === 'paced' && a.status === 'active' && total > 0
    ? projectFinish(a, today, p) : null;
  const sub = fin && !fin.done ? `→ ${fmtDate(fin.date)}` : a.status !== 'active' ? a.status : '';
  return `<div class="track ${a.cls || ''}"><div class="tl"><b>${esc(a.name || a.id)}</b><small>${esc(sub)}</small></div>
    <div class="tgrid" style="--n:${wks.length}">${cells}</div></div>`;
}

export function renderYear() {
  const el = document.getElementById('view-year');
  if (!el || !plan.data) return;
  const p = plan.data, today = todayStr(), wks = yearWeeks();
  const todayPct = Math.min(100, Math.max(0,
    (weeksBetween(wks[0], today) + 0.5) / wks.length * 100));

  const rows = p.activities.filter(a =>
    ['paced', 'target', 'external'].includes(a.type) && !['cancelled'].includes(a.status));
  const core = { id: 'core', name: 'Core — ELA·Math·Arabic·Quran', cls: 'r', type: 'ongoing', status: 'active' };

  let h = `<div class="pcard"><div class="phead">${esc(p.year.label)} · year-round</div>
    <div class="pmeta"><span class="pchip">tap a week to cycle: teaching → travel → off → light</span></div></div>
    <div class="pcard ytracks" style="--tp:${todayPct}">`;
  for (const a of [...rows, core]) h += trackFor(a, wks, today);
  h += `<div class="yaxis">${['S','O','N','D','J','F','M','A','M','J','J','A'].map(m => `<span>${m}</span>`).join('')}</div></div>`;

  const pc = p.parentCycle;
  h += `<div class="pcard"><div class="pmeta">7-on/7-off anchor: week of ${fmtDate(pc.anchorMonday)} = work week${pc.confirmed ? '' : ' (unconfirmed guess)'}
    <button type="button" id="yflip">Flip work/home</button></div></div>`;

  el.innerHTML = h;
  el.querySelectorAll('.tgrid i').forEach(cell => cell.addEventListener('click', () => {
    const w = cell.dataset.w;
    const cur = weekType(p.weeks, w);
    const next = CYCLE_NEXT[cur];
    let label;
    if (next === 'travel') label = prompt('Label for this travel week? (e.g. Dhaka ✈)', p.weeks[w]?.label || '') || undefined;
    setWeekType(w, next === 'teaching' ? null : next, label);
  }));
  document.getElementById('yflip').addEventListener('click', flipAnchor);
}
