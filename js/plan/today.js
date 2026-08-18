// Today view: date header, away-day banner, timed blocks for the real date
// (template + planner slots + overrides), one-tap statuses, daily no-slot
// checklist, tomorrow strip.
import { DAYS, fmt, esc, CATS } from '../model.js';
import { store, catLabel, evLabel } from '../state.js';
import {
  todayStr, addDays, dayIdx, isWorkDay, dayStatus, dayAway, daysBetween, nextSession,
  currentCur, cycleStats, doneOn, actTotal, okCls, teachingWeekNumber, dailyStreak,
} from './model.js';
import { plan, togglePaced, logTimed } from './state.js';

const ST = [['done', '✓ Done'], ['partial', '◐ Didn’t finish'], ['missed', '✗ Missed']];
const AWAY_ICON = { travel: '✈', off: '⏸' };

// The icon is drawn from the period's TYPE, so strip any the family typed
// into the label themselves ("Dhaka ✈" renders as "✈ Dhaka", not doubled)
// — mirrors year.js's perName.
const awayLabel = st => {
  const l = String(st.label || '').replace(/[✈⏸]/g, '').trim();
  return l || (st.type === 'off' ? 'Off' : 'Time away');
};

// "in 5 days" under two weeks out, "in 3 wks" beyond. Pure so it's testable
// without a DOM.
export function fmtUntil(days) {
  if (days < 14) return `in ${days} day${days === 1 ? '' : 's'}`;
  const wks = Math.round(days / 7);
  return `in ${wks} wk${wks === 1 ? '' : 's'}`;
}

// A daily (no-time-slot) activity shows on a normal day; on a travel-type
// away day only if it doesn't pause for travel; never on an off-type day.
export function dailyVisible(act, status) {
  if (!status.away) return true;
  if (status.type === 'off') return false;
  return (act.travel?.mode || 'pause') !== 'pause';
}

function timedFor(dateStr) {
  const d = dayIdx(dateStr);
  const items = [];
  for (const ev of store.events.filter(e => e.day === d))
    items.push({ key: `ev:${ev.id}`, eventId: ev.id, cls: okCls(CATS[ev.cat]?.cls),
                 name: evLabel(ev) || catLabel(ev.cat), start: ev.start, end: ev.end, note: ev.note });
  for (const a of plan.data.activities.filter(a => a.status === 'active' && a.onGrid))
    for (const s of a.slots || [])
      if (s.day === d) {
        const cur = currentCur(a);
        items.push({ key: `act:${a.id}`, activityId: a.id, cls: okCls(a.cls),
                     name: a.name, start: s.start, end: s.end,
                     note: cur && nextSession(cur) ? nextSession(cur).label : '' });
      }
  for (const [i, o] of plan.data.overrides.entries())
    if (o.date === dateStr && o.action === 'add') {
      const a = plan.data.activities.find(x => x.id === o.activityId);
      items.push({ key: `ov:${i}`, activityId: o.activityId, cls: okCls(a?.cls),
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
  const c = [];
  if (p.activities.some(a => a.status === 'active' && a.rhythm?.kind === 'cycle'))
    c.push(`<span class="pchip">${isWorkDay(p.parentCycle, dateStr) ? 'Mama: work day' : 'Mama: home day'}</span>`);
  // periods are kept sorted by start, so the first future one is the nearest.
  // Skip any whose own start day resolves to a DIFFERENT period (dayAway lets
  // `off` outrank `travel`): a shadowed period never renders as itself on the
  // Today/Year pages, so advertising it here would name a trip that never arrives.
  const next = p.periods.find(pd =>
    pd.start > dateStr && dayAway(p.periods, pd.start)?.id === pd.id);
  if (next) c.push(`<span class="pchip">${AWAY_ICON[next.type] || '✈'} ${esc(awayLabel(next))} ${
    fmtUntil(daysBetween(dateStr, next.start))}</span>`);
  return c.join('');
}

// ── "This week" card ────────────────────────────────────────
// The weekly view of the same data the rest of the page shows day by day:
// which teaching week this is, where each cycle activity stands against its
// 2-week target, and any daily streak worth protecting. Deliberately NOT
// suppressed on away days — a streak matters most while travelling, which is
// exactly what dailyStreak's away-day bridging is for.
const MIN_STREAK = 3;              // below this a "streak" is just two good days
const LAST_DAYS = 3;               // warn only inside the cycle's last 3 days

// done >= targetMin -> "on pace"; otherwise stay neutral until the cycle is
// nearly over, because being 1 of 3 on day two says nothing yet.
function paceChip(cs, dateStr) {
  if (cs.done >= cs.targetMin) return `<span class="pchip ok">on pace</span>`;
  return dateStr >= addDays(cs.end, -(LAST_DAYS - 1)) ? `<span class="pchip warn">behind</span>` : '';
}

export function thisWeekHtml(dateStr) {
  const p = plan.data;
  const lines = [];
  const tw = teachingWeekNumber(p, dateStr);
  if (tw != null) lines.push(`<div class="twk">Teaching week ${tw}</div>`);

  for (const a of p.activities.filter(a => a.status === 'active' && a.rhythm?.kind === 'cycle')) {
    const cs = cycleStats(a, dateStr, p.parentCycle, p.log);
    const target = `${cs.targetMin}${cs.targetMax > cs.targetMin ? `–${cs.targetMax}` : ''}`;
    lines.push(`<div class="twline"><span><b>${esc(a.name || a.id)}</b> — ${cs.done} of ${
      target} this cycle</span>${paceChip(cs, dateStr)}</div>`);
  }

  for (const a of p.activities.filter(a => a.status === 'active' && a.rhythm?.kind === 'daily')) {
    const n = dailyStreak(p.log, a.id, p.periods, dateStr);
    if (n >= MIN_STREAK)
      lines.push(`<div class="twline"><span><b>${esc(a.name || a.id)}</b> — 🔥 ${n}-day streak</span></div>`);
  }

  if (!lines.length) return '';    // nothing to say -> no empty card
  return `<div class="psec">This week</div><div class="pcard">${lines.join('')}</div>`;
}

export function renderToday() {
  const el = document.getElementById('view-today');
  if (!el || !plan.data) return;
  const today = todayStr();
  const d = new Date();
  const status = dayStatus(plan.data.periods, today);

  let h = `<div class="pcard"><div class="phead">${DAYS[dayIdx(today)]}, ${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</div><div class="pmeta">${chips(today)}</div></div>`;
  h += thisWeekHtml(today);

  let items = [];
  if (status.away) {
    h += `<div class="pcard abanner"><div class="phead">${AWAY_ICON[status.type] || '✈'} ${
      esc(awayLabel(status))} · day ${status.dayN} of ${status.total}</div></div>`;
  } else {
    items = timedFor(today);
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
  }

  const dailies = plan.data.activities.filter(a =>
    a.status === 'active' && a.type === 'paced' && !a.onGrid && dailyVisible(a, status));
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

  const tomorrow = addDays(today, 1);
  const tst = dayStatus(plan.data.periods, tomorrow);
  if (tst.away) {
    h += `<div class="tmwrow">Tomorrow: ${AWAY_ICON[tst.type] || '✈'} ${esc(awayLabel(tst))}</div>`;
  } else {
    const tmw = timedFor(tomorrow);
    if (tmw.length) h += `<div class="tmwrow">Tomorrow: ${tmw.map(t => `${esc(t.name)} ${fmt(t.start)}`).join(' · ')}</div>`;
  }

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
