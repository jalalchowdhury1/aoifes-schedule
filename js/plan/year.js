// Year view (v2): VIEW-ONLY tracks + a day-precise time-away list.
// A tap on the grid never mutates anything — it opens an info card. Every
// change goes through the add/edit sheet, which previews its own impact live.
// NO browser dialogs anywhere (prompt/alert/confirm): this runs on the family's
// phones, where a native dialog is easy to mis-tap and impossible to style.
// Deleting is a two-tap button; validation errors render inline as .form-err.
import { esc } from '../model.js';
import {
  todayStr, addDays, mondayOf, weeksBetween, daysBetween, dayStatus,
  weekCapacity, actTotal, actDone, projectFinish, tripImpact, isWorkDay,
  okCls, WALK_CAP,
} from './model.js';
import { plan, addPeriod, updatePeriod, deletePeriod } from './state.js';

// ── Date formatting (view-only, deliberately locale-free) ───
// Intl's 'short' month renders "Sept" on CLDR 42+, which breaks the 3-letter
// axis, so the month names are a constant instead of toLocaleDateString.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const D = s => new Date(s + 'T12:00');            // noon: DST can never shift the date
const fmtDay = s => { const d = D(s); return `${MON[d.getMonth()]} ${d.getDate()}`; };
// "Jan 4 – 10" inside one month, "Jan 4 – Feb 6" across months.
const fmtRange = (a, b) => {
  const x = D(a), y = D(b);
  const same = x.getMonth() === y.getMonth() && x.getFullYear() === y.getFullYear();
  return `${fmtDay(a)} – ${same ? y.getDate() : fmtDay(b)}`;
};
const ICON = { travel: '✈', off: '⏸' };
// The icon is drawn from the period's TYPE, so strip any the family typed into
// the label themselves ("Dhaka ✈" renders as "✈ Dhaka", not "✈ Dhaka ✈").
const perName = p => {
  const l = String(p.label || '').replace(/[✈⏸]/g, '').trim();
  return l || (p.type === 'off' ? 'Off' : 'Time away');
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ── View-local UI state (survives re-render; never persisted) ──
let openWeek = null;      // Monday of the week whose info card is showing
let sheet = null;         // {mode:'add'|'edit', id, start, end, type, label, err}
let delArmed = false;     // two-tap delete: armed by the first tap

const periodsOf = () => plan.data.periods || [];
const findPeriod = id => periodsOf().find(p => p.id === id) || null;

function yearWeeks() {
  const { start, end } = plan.data.year;
  const out = [];
  let w = mondayOf(start);
  // Same rationale as model.js's walks: never let a malformed `end` hang the UI.
  while (w <= end && out.length < WALK_CAP) { out.push(w); w = addDays(w, 7); }
  return out;
}

// Away days in one week, split by type, plus the distinct periods involved.
// (model's awayDaysInWeek returns the same total; the tracks also need the
// travel/off split to pick a hatch, so one dayStatus pass produces both.)
function weekAway(periods, weekStart) {
  const seen = new Map();
  let travel = 0, off = 0;
  for (let i = 0; i < 7; i++) {
    const s = dayStatus(periods, addDays(weekStart, i));
    if (!s.away) continue;
    if (s.type === 'off') off++; else travel++;
    if (!seen.has(s.id)) seen.set(s.id, { id: s.id, type: s.type, label: s.label });
  }
  return { travel, off, total: travel + off, list: [...seen.values()] };
}

// 7 away days -> full hatch, 1-6 -> half-height hatch; `off` hatches darker.
// A week overlapped by both types takes whichever covers more days (travel wins ties).
const awayCls = aw =>
  !aw.total ? '' : (aw.off > aw.travel ? 'offw' : 'trip') + (aw.total === 7 ? '' : '-part');

// ── Tracks ──────────────────────────────────────────────────
function trackFor(a, wks, away, today) {
  const p = plan.data;
  const total = actTotal(a);
  const paced = a.type === 'paced' && a.status === 'active' && total > 0;
  let remainingDone = actDone(a);
  const mon = mondayOf(today);
  let cells = '';
  wks.forEach((w, i) => {
    const aw = away[i];
    const cls = [];
    if (paced) {
      const cap = weekCapacity(a, w, p.periods, p.parentCycle);
      if (w <= mon && remainingDone > 0) { cls.push('fill'); remainingDone -= cap; }
      else if (cap > 0) cls.push('plan');
    } else if (a.status === 'active' && aw.total < 7) {
      cls.push(w <= mon ? 'fill' : 'plan');
    }
    const ac = awayCls(aw);
    if (ac) cls.push(ac);
    if (w === openWeek) cls.push('sel');
    cells += `<i class="${cls.join(' ')}" data-w="${w}"></i>`;
  });
  const fin = paced ? projectFinish(a, today, p) : null;
  const sub = fin ? (fin.done ? 'finished 🎉' : `→ ${fmtDay(fin.date)}`)
    : a.type === 'paced' && total === 0 ? 'counts pending' : '';
  return `<div class="track ${a.cls ? okCls(a.cls) : ''}"><div class="tl"><b>${esc(a.name || a.id)}</b><small>${esc(sub)}</small></div>
    <div class="tgrid" style="--n:${wks.length}">${cells}</div></div>`;
}

// Month labels under the tracks, each spanning its own weeks so they line up.
function axisHtml(wks) {
  const groups = [];
  for (const w of wks) {
    const m = D(w).getMonth();
    const last = groups[groups.length - 1];
    if (last && last.m === m) last.n++;
    else groups.push({ m, n: 1 });
  }
  return `<div class="yaxis" style="--n:${wks.length}">${groups
    .map(g => `<span style="grid-column:span ${g.n}">${MON[g.m]}</span>`).join('')}</div>`;
}

const legendHtml = () =>
  `<div class="yleg"><span><i class="yl fill"></i>done</span><span><i class="yl plan"></i>planned</span>
    <span><i class="yl trip"></i>travel</span><span><i class="yl offw"></i>off</span></div>`;

// ── Week info card (read-only; the only way it changes data is by
//    opening the sheet, which the family still has to confirm with Save) ──
function cardHtml(wks, away) {
  if (openWeek == null) return '';
  const i = wks.indexOf(openWeek);
  if (i < 0) return '';
  const aw = away[i];
  let h = `<div class="pcard ycard"><div class="trow"><span class="tnm">Week of ${esc(fmtRange(openWeek, addDays(openWeek, 6)))}</span>
    <button type="button" class="ycls" id="ycard-x" aria-label="Close">✕</button></div>`;
  if (!aw.total) {
    h += `<div class="pmeta">School all week</div>
      <div class="sctl"><button type="button" data-yadd="${openWeek}">+ Time away this week</button></div>`;
  } else {
    const names = aw.list.map(x => `${ICON[x.type]} ${esc(perName(x))}`).join(' · ');
    h += `<div class="pmeta">${plural(aw.total, 'away day')} · ${names}</div>
      <div class="sctl">${aw.list.map(x => `<button type="button" data-yedit="${esc(x.id)}">${
        aw.list.length > 1 ? `Edit ${ICON[x.type]} ${esc(perName(x))}` : 'Edit trip'}</button>`).join('')}</div>`;
  }
  return `${h}</div>`;
}

// ── Time-away list ──────────────────────────────────────────
function listHtml() {
  const ps = periodsOf();
  let h = `<div class="psec">Time away</div><div class="pcard yaway">`;
  if (!ps.length) h += `<div class="pmeta">No time away planned yet.</div>`;
  for (const p of ps) {
    const days = daysBetween(p.start, p.end) + 1;
    h += `<div class="yrow" data-yedit="${esc(p.id)}" role="button" tabindex="0">
      <span class="yrow-t">${ICON[p.type]} ${esc(perName(p))}</span>
      <span class="yrow-d">${esc(fmtRange(p.start, p.end))} · ${plural(days, 'day')}</span></div>`;
  }
  return `${h}<button type="button" id="yadd" class="ybtn-add">+ Add time away</button></div>`;
}

// ── Sheet: live impact preview ──────────────────────────────
function impactHtml() {
  if (!sheet) return '';
  const { start, end, type, mode, id } = sheet;
  if (!start || !end || end < start)
    return `<div class="pmeta">Pick both dates to see what this moves.</div>`;
  const rows = tripImpact(plan.data, { ...(mode === 'edit' ? { id } : {}), start, end, type }, todayStr());
  if (!rows.length) return `<div class="pmeta">Nothing paced is running yet — no dates move.</div>`;
  return rows.map(r => {
    const a = plan.data.activities.find(x => x.id === r.id);
    let line = `<div class="yimp"><b>${esc(r.name)}</b> → ${r.after ? esc(fmtDay(r.after)) : 'not in this year'}`;
    if (r.after && r.before)
      line += r.after === r.before ? ` <small>(unchanged)</small>` : ` <small>(was ${esc(fmtDay(r.before))})</small>`;
    const goal = a && a.goal ? a.goal.finishBy : null;
    if (goal && r.after) {
      const wks = Math.round((D(goal) - D(r.after)) / 604800000);
      line += wks >= 0 ? ` <span class="pchip ok">${plural(wks, 'wk')} before goal ✓</span>`
                       : ` <span class="pchip warn">${plural(-wks, 'wk')} past goal</span>`;
    }
    return `${line}</div>`;
  }).join('');
}

function sheetHtml() {
  if (!sheet) return '';
  const edit = sheet.mode === 'edit';
  const title = edit ? 'Edit time away' : 'Add time away';
  return `<div class="ysh-bd" id="ysh-bd"></div>
  <div class="ysh" role="dialog" aria-label="${title}">
    <div class="ysh-h">${title}</div>
    <div class="ysh-dates">
      <div><label for="ysh-start">From</label><input type="date" id="ysh-start" value="${esc(sheet.start)}"></div>
      <div><label for="ysh-end">To</label><input type="date" id="ysh-end" value="${esc(sheet.end)}"></div>
    </div>
    <div class="ysh-row"><label for="ysh-label">Label</label>
      <input type="text" id="ysh-label" placeholder="Dhaka ✈" value="${esc(sheet.label)}"></div>
    <div class="ysh-row"><label>Type</label>
      <div class="ysh-radios">
        <label class="ysh-rad"><input type="radio" name="ysh-type" id="ysh-t-travel" value="travel"${sheet.type === 'off' ? '' : ' checked'}> Travel</label>
        <label class="ysh-rad"><input type="radio" name="ysh-type" id="ysh-t-off" value="off"${sheet.type === 'off' ? ' checked' : ''}> Off</label>
      </div>
      <div class="ysh-help">Travel = Singapore Math keeps going every other day · Off = everything pauses</div>
    </div>
    <div class="form-err${sheet.err ? ' show' : ''}" id="ysh-err">${esc(sheet.err || '')}</div>
    <div class="psec">What this moves</div>
    <div class="ysh-imp" id="ysh-imp">${impactHtml()}</div>
    <div class="ysh-btns">
      ${edit ? `<button type="button" class="danger-btn" id="ysh-del">Delete</button>` : ''}
      <button type="button" id="ysh-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="ysh-save">Save</button>
    </div>
  </div>`;
}

// ── Footer: the parent cycle, stated once, with no controls ──
// A work stretch runs Tue -> Mon; its first day is the one where isWorkDay
// flips false -> true. Scan a fortnight forward and stop at the first.
function nextWorkStart(cycle, from) {
  for (let i = 0; i < 15; i++) {
    const d = addDays(from, i);
    if (isWorkDay(cycle, d) && !isWorkDay(cycle, addDays(d, -1))) return d;
  }
  return null;
}

// ── Open/close helpers ──────────────────────────────────────
function openAdd(weekStart) {
  const t = todayStr();
  sheet = { mode: 'add', id: null, start: weekStart || t,
            end: weekStart ? addDays(weekStart, 6) : t, type: 'travel', label: '', err: '' };
  delArmed = false;
  renderYear();
}

function openEdit(id) {
  const p = findPeriod(id);
  if (!p) return;
  sheet = { mode: 'edit', id, start: p.start, end: p.end, type: p.type, label: p.label || '', err: '' };
  delArmed = false;
  renderYear();
}

function closeSheet() { sheet = null; delArmed = false; renderYear(); }

// ── Render ──────────────────────────────────────────────────
export function renderYear() {
  const el = document.getElementById('view-year');
  if (!el || !plan.data) return;
  const p = plan.data, today = todayStr(), wks = yearWeeks();
  // year.end before year.start walks zero weeks; everything below indexes wks[0].
  if (!wks.length) { el.innerHTML = `<div class="pcard pmeta">The school year's dates look wrong — check the plan's year range.</div>`; return; }
  if (openWeek && !wks.includes(openWeek)) openWeek = null;
  const away = wks.map(w => weekAway(p.periods, w));
  const todayPct = Math.min(100, Math.max(0,
    (weeksBetween(wks[0], today) + 0.5) / wks.length * 100));

  const rows = p.activities.filter(a =>
    ['paced', 'target', 'external'].includes(a.type) && a.status === 'active');
  const core = { id: 'core', name: 'Core — ELA·Math·Arabic·Quran', cls: 'r', type: 'ongoing', status: 'active' };

  let h = `<div class="pcard"><div class="phead">${esc(p.year.label)} · year-round</div>
    <div class="pmeta"><span class="pchip">tap a week for details</span></div></div>
    <div class="pcard ytracks"><div class="ytw" style="--tp:${todayPct.toFixed(2)}">
    <div class="ynow"><i>today</i></div>`;
  for (const a of [...rows, core]) h += trackFor(a, wks, away, today);
  h += `</div>${axisHtml(wks)}${legendHtml()}</div>`;

  // Everything that is not running yet collapses to one line — the Subjects
  // tab owns those decisions, the Year page just says they exist.
  const grouped = [['Not started', 'planned'], ['Parked', 'parked'], ['Done', 'done']]
    .map(([label, st]) => {
      const names = p.activities.filter(a => a.status === st).map(a => esc(a.name || a.id));
      return names.length ? `${label}: ${names.join(' · ')}` : '';
    }).filter(Boolean);
  if (grouped.length)
    h += `<div class="pcard pmeta ycoll">${grouped.join(' · ')} — manage in Subjects</div>`;

  h += cardHtml(wks, away);
  h += listHtml();

  const nw = nextWorkStart(p.parentCycle, today);
  h += `<div class="pcard pmeta yfoot">Mama works Tue–Mon, every other week${
    nw ? ` · next work week: ${esc(fmtDay(nw))}` : ''}</div>`;
  h += sheetHtml();

  el.innerHTML = h;
  wire(el);
}

// ── Wiring ──────────────────────────────────────────────────
function wire(el) {
  const $ = id => document.getElementById(id);

  el.querySelectorAll('.tgrid i').forEach(c => c.addEventListener('click', () => {
    openWeek = openWeek === c.dataset.w ? null : c.dataset.w;    // tapping the same cell closes
    renderYear();
  }));
  el.querySelectorAll('[data-yedit]').forEach(b =>
    b.addEventListener('click', () => openEdit(b.dataset.yedit)));
  el.querySelectorAll('[data-yadd]').forEach(b =>
    b.addEventListener('click', () => openAdd(b.dataset.yadd)));

  const x = $('ycard-x');
  if (x) x.addEventListener('click', () => { openWeek = null; renderYear(); });
  const add = $('yadd');
  if (add) add.addEventListener('click', () => openAdd(null));

  if (!sheet) return;
  const start = $('ysh-start'), end = $('ysh-end'), label = $('ysh-label');
  const travel = $('ysh-t-travel'), off = $('ysh-t-off');
  const err = $('ysh-err'), imp = $('ysh-imp'), del = $('ysh-del');

  const showErr = msg => {
    sheet.err = msg;
    err.textContent = msg;
    err.className = `form-err${msg ? ' show' : ''}`;
  };
  const disarm = () => { if (del && delArmed) { delArmed = false; del.textContent = 'Delete'; } };
  // Re-render ONLY the impact block on input: a full re-render would take the
  // keyboard focus off the field being typed into.
  const sync = () => {
    sheet.start = start.value; sheet.end = end.value; sheet.label = label.value;
    sheet.type = off.checked ? 'off' : 'travel';
    imp.innerHTML = impactHtml();
    if (sheet.err) showErr('');
    disarm();
  };
  [start, end, label].forEach(i => {
    i.addEventListener('input', sync);
    i.addEventListener('change', sync);
  });
  [travel, off].forEach(i => i.addEventListener('change', sync));

  $('ysh-cancel').addEventListener('click', closeSheet);
  $('ysh-bd').addEventListener('click', closeSheet);

  $('ysh-save').addEventListener('click', () => {
    const s = start.value, e = end.value;
    if (!s || !e) return showErr('Pick both a start and an end date.');
    if (e < s) return showErr('The end date has to be on or after the start date.');
    const patch = { start: s, end: e, type: off.checked ? 'off' : 'travel', label: label.value.trim() };
    const mode = sheet.mode, id = sheet.id;
    sheet = null; delArmed = false; openWeek = null;
    // commit() inside the mutation notifies, which re-renders this view.
    if (mode === 'edit') updatePeriod(id, patch); else addPeriod(patch);
  });

  if (del) del.addEventListener('click', () => {
    if (!delArmed) { delArmed = true; del.textContent = 'Tap again to delete'; return; }
    const id = sheet.id;
    sheet = null; delArmed = false; openWeek = null;
    deletePeriod(id);
  });
}
