// Today view: date header, timed blocks for the real date (template + planner
// slots + overrides), one-tap statuses, daily no-slot checklist, tomorrow strip.
import { DAYS, fmt, esc, CATS } from '../model.js';
import { store, catLabel, evLabel } from '../state.js';
import {
  todayStr, addDays, dayIdx, mondayOf, weekType, isOnWeek, nextSession,
  currentCur, cycleStats, doneOn, actTotal,
} from './model.js';
import { plan, togglePaced, logTimed } from './state.js';

const ST = [['done', '✓ Done'], ['partial', '◐ Didn’t finish'], ['missed', '✗ Missed']];

function timedFor(dateStr) {
  const d = dayIdx(dateStr);
  const items = [];
  for (const ev of store.events.filter(e => e.day === d))
    items.push({ key: `ev:${ev.id}`, eventId: ev.id, cls: CATS[ev.cat]?.cls || 'ot',
                 name: evLabel(ev) || catLabel(ev.cat), start: ev.start, end: ev.end, note: ev.note });
  for (const a of plan.data.activities.filter(a => a.status === 'active' && a.onGrid))
    for (const s of a.slots || [])
      if (s.day === d) {
        const cur = currentCur(a);
        items.push({ key: `act:${a.id}`, activityId: a.id, cls: a.cls || 'ot',
                     name: a.name, start: s.start, end: s.end,
                     note: cur && nextSession(cur) ? nextSession(cur).label : '' });
      }
  for (const [i, o] of plan.data.overrides.entries())
    if (o.date === dateStr && o.action === 'add') {
      const a = plan.data.activities.find(x => x.id === o.activityId);
      items.push({ key: `ov:${i}`, activityId: o.activityId, cls: a?.cls || 'ot',
                   name: (a?.name || 'Extra') + ' · makeup', start: o.start, end: o.end, note: o.note || '' });
    }
  const skips = new Set(plan.data.overrides
    .filter(o => o.date === dateStr && o.action === 'skip')
    .map(o => o.eventId || `act:${o.activityId}`));
  return items.filter(it => !skips.has(it.eventId) && !skips.has(it.key))
    .sort((a, b) => a.start - b.start);
}

const statusOf = (dateStr, it) => plan.data.log.find(e => e.date === dateStr &&
  (it.eventId ? e.eventId === it.eventId : e.activityId === it.activityId && e.timed))?.status;

function chips(dateStr) {
  const p = plan.data;
  const wt = weekType(p.weeks, dateStr);
  const wkLabel = p.weeks[mondayOf(dateStr)]?.label;
  const c = [];
  c.push(`<span class="pchip">${wt === 'teaching' ? 'Teaching week' : esc((wkLabel || wt) + ' week')}</span>`);
  if (p.activities.some(a => a.status === 'active' && a.rhythm?.kind === 'cycle'))
    c.push(`<span class="pchip">${isOnWeek(p.parentCycle, dateStr) ? 'Mama work week' : 'Mama home week'}${p.parentCycle.confirmed ? '' : ' ?'}</span>`);
  const next = Object.keys(p.weeks).filter(k => k > dateStr && p.weeks[k].type === 'travel').sort()[0];
  if (next) c.push(`<span class="pchip">✈ ${esc(p.weeks[next].label || 'travel')} in ${Math.max(1, Math.round((new Date(next) - new Date(dateStr)) / 604800000))} wks</span>`);
  return c.join('');
}

export function renderToday() {
  const el = document.getElementById('view-today');
  if (!el || !plan.data) return;
  const today = todayStr();
  const d = new Date();
  const items = timedFor(today);

  let h = `<div class="pcard"><div class="phead">${DAYS[dayIdx(today)]}, ${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</div><div class="pmeta">${chips(today)}</div></div>`;

  for (const it of items) {
    const st = statusOf(today, it);
    h += `<div class="tblock ${it.cls}${st ? ' st-' + st : ''}" data-key="${esc(it.key)}">
      <div class="trow"><span class="tnm">${esc(it.name)}</span><span class="ttm">${fmt(it.start)}–${fmt(it.end)}</span></div>
      ${it.note ? `<div class="tnote">${esc(it.note)}</div>` : ''}
      <div class="tbtns">${ST.map(([k, lbl]) =>
        `<button type="button" class="tbtn${st === k ? ' sel' : ''}" data-st="${k}">${lbl}</button>`).join('')}</div>
    </div>`;
  }
  if (!items.length) h += `<div class="pcard pmeta">No scheduled blocks today.</div>`;

  const dailies = plan.data.activities.filter(a => a.status === 'active' && a.type === 'paced' && !a.onGrid);
  if (dailies.length) {
    h += `<div class="psec">Daily · no time slot</div>`;
    for (const a of dailies) {
      const done = doneOn(plan.data.log, a.id, today);
      const cur = currentCur(a);
      const ns = cur ? nextSession(cur) : null;
      let sub = '';
      if (a.rhythm?.kind === 'cycle') {
        const cs = cycleStats(a, today, plan.data.parentCycle, plan.data.log);
        sub = `this cycle: ${cs.done} of ${cs.targetMin}–${cs.targetMax}${cs.prevBehind ? ' · last cycle short' : ''}`;
      } else if (a.rhythm?.kind === 'daily') sub = actTotal(a) === 0 ? esc(a.note || '') : 'every day';
      h += `<div class="drow${done ? ' ck' : ''}" data-act="${esc(a.id)}">
        <span class="dbx">${done ? '✓' : ''}</span>
        <span class="dtx">${esc(a.name)}${ns ? ` — ${esc(cur.name ? cur.name + ' · ' : '')}${esc(ns.label)}` : ''}
        ${sub ? `<small>${sub}</small>` : ''}</span></div>`;
    }
  }

  const tmw = timedFor(addDays(today, 1));
  if (tmw.length) h += `<div class="tmwrow">Tomorrow: ${tmw.map(t => `${esc(t.name)} ${fmt(t.start)}`).join(' · ')}</div>`;

  el.innerHTML = h;
  el.querySelectorAll('.tbtn').forEach(b => b.addEventListener('click', e => {
    const block = e.target.closest('.tblock');
    const key = block.dataset.key;
    const it = items.find(x => x.key === key);
    logTimed(it.eventId || null, it.activityId || null, b.dataset.st);
  }));
  el.querySelectorAll('.drow').forEach(r =>
    r.addEventListener('click', () => togglePaced(r.dataset.act)));
}
